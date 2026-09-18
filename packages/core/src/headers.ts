import { Buffer } from "node:buffer";
import { SignatureError } from "./errors.js";
import { checkLimit } from "./limits.js";
import type { CoreLimitName } from "./limits.js";
import type { HeaderFields, Limits, RequestParts } from "./types.js";

const FIELD_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export function isFieldName(value: string): boolean {
    return value.length > 0 && FIELD_NAME.test(value);
}

/**
 * Validate sizes before normalizing, decoding, or collecting values.
 * Strings have an explicit ASCII contract; bytes preserve obs-text for `bs`.
 * Header names and ": " / CRLF overhead count toward the local header budget.
 * This is a descriptor budget, not a claim to measure compressed HTTP/2 bytes.
 */
export function validateHeaders(headers: HeaderFields, limits: Readonly<Limits>): void {
    if (!Array.isArray(headers)) throw new SignatureError("malformed");
    let total = 0;
    for (const entry of headers) {
        if (!Array.isArray(entry) || entry.length !== 2) {
            throw new SignatureError("malformed");
        }
        const [name, value] = entry;
        if (
            typeof name !== "string" ||
            (typeof value !== "string" && !(value instanceof Uint8Array))
        ) {
            throw new SignatureError("malformed");
        }
        total += name.length + value.length + 4;
        checkLimit(limits, "maxMessageHeaderBytes", total);
        if (!isFieldName(name)) throw new SignatureError("malformed");
        if (typeof value === "string") {
            for (let index = 0; index < value.length; index++) {
                if (value.charCodeAt(index) > 127) {
                    // Never guess whether a JavaScript string represents UTF-8 or Latin-1.
                    throw new SignatureError("malformed");
                }
            }
        }
    }
}

/** RFC 9421 §2.1 / §2.1.3: OWS and HTTP/1.1 obs-fold, not Unicode trim. */
function normalizeValue(
    value: string | Uint8Array,
    httpVersion: RequestParts["httpVersion"],
): string {
    let text = typeof value === "string" ? value : Buffer.from(value).toString("latin1");
    if (httpVersion === "1.1") {
        text = text.replace(/\r\n[ \t]+/g, " ");
    }
    // Remaining line breaks are never legal field-value content. Reject rather
    // than removing them, which could hide header injection or change the message.
    for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);
        if ((code < 32 && code !== 9) || code === 127) {
            throw new SignatureError("malformed");
        }
    }
    return text.replace(/^[ \t]+|[ \t]+$/g, "");
}

/**
 * Internal helper: caller must first validateHeaders for the complete section.
 * Keep occurrences separate until the component chooses ordinary/SF/bs handling.
 */
export function fieldValues(
    headers: HeaderFields,
    name: string,
    httpVersion?: RequestParts["httpVersion"],
): readonly string[] {
    const values: string[] = [];
    for (const [fieldName, value] of headers) {
        if (fieldName.toLowerCase() === name) {
            values.push(normalizeValue(value, httpVersion));
        }
    }
    return values;
}

/** ASCII check is explicit; decoding with Buffer's "ascii" would mask high bits. */
export function requireAscii(value: string): string {
    for (let index = 0; index < value.length; index++) {
        if (value.charCodeAt(index) > 127) throw new SignatureError("malformed");
    }
    return value;
}

/** Bound the combined size BEFORE join allocates the resulting field value. */
export function combineValues(
    values: readonly string[],
    limits: Readonly<Limits>,
    limit: CoreLimitName = "maxMessageHeaderBytes",
): string {
    let length = 0;
    for (let index = 0; index < values.length; index++) {
        length += values[index]!.length + (index === 0 ? 0 : 2);
        checkLimit(limits, limit, length);
    }
    return values.join(", ");
}