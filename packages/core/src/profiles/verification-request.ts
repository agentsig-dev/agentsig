import { SignatureError } from "../errors.js";
import { validateHeaders } from "../headers.js";
import { checkLimit } from "../limits.js";
import type { HeaderField, Limits, RequestParts } from "../types.js";

function malformed(): never {
    throw new SignatureError("malformed");
}

function ownData(object: object, name: string, required: boolean): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(object, name);
    if (!descriptor) {
        if (required) return malformed();
        return undefined;
    }
    if (!Object.hasOwn(descriptor, "value")) return malformed();
    return descriptor.value as unknown;
}

/**
 * Own the received descriptor BEFORE clock callbacks or asynchronous work.
 * Otherwise a caller mutation could make cryptography authenticate one request
 * while later identity/coverage evaluation observes another.
 *
 * Unlike the signer, preserve all signature fields and their order/bytes.
 * No normalization, proxy-header inference, merging or URL repair occurs here.
 * Typed-array copies remain private to this verification invocation.
 *
 * Local JS descriptors are not a hostile Proxy sandbox. Reject ordinary
 * accessors without invoking them; HTTP values remain untrusted bounded input.
 * Expected failures use the core error boundary, not signing error codes.
 */
export function snapshotVerificationRequest(
    input: RequestParts,
    limits: Readonly<Limits>,
): RequestParts {
    if (!input || typeof input !== "object" || Array.isArray(input)) return malformed();
    const source = ownData(input, "headers", true);
    if (!Array.isArray(source)) return malformed();
    // Every field costs at least ": " and CRLF in the descriptor budget.
    // Bound cardinality before growing any copied collection.
    if (source.length > Math.floor(limits.maxMessageHeaderBytes / 4)) {
        throw new SignatureError("resource-limit");
    }

    const headers: HeaderField[] = [];
    let total = 0;
    for (let index = 0; index < source.length; index++) {
        const entry = ownData(source, String(index), true);
        if (!Array.isArray(entry) || entry.length !== 2) return malformed();
        const name = ownData(entry, "0", true);
        const value = ownData(entry, "1", true);
        if (typeof name !== "string" ||
            (typeof value !== "string" && !(value instanceof Uint8Array))) {
            return malformed();
        }
        total += name.length + value.length + 4;
        checkLimit(limits, "maxMessageHeaderBytes", total);
        headers.push(Object.freeze([
            name,
            typeof value === "string" ? value : Uint8Array.from(value),
        ] as const));
    }
    // Retain the M1 field-name and ASCII contract rather than adding a second
    // parser. Actual signed-value normalization belongs to canonicalization.
    validateHeaders(headers, limits);

    const method = ownData(input, "method", true);
    const targetUri = ownData(input, "targetUri", true);
    const rawRequestTarget = ownData(input, "rawRequestTarget", false);
    const httpVersion = ownData(input, "httpVersion", false);
    if (typeof method !== "string" || typeof targetUri !== "string") return malformed();
    if (rawRequestTarget !== undefined && typeof rawRequestTarget !== "string") return malformed();
    if (httpVersion !== undefined &&
        httpVersion !== "1.1" && httpVersion !== "2" && httpVersion !== "3") {
        return malformed();
    }
    checkLimit(limits, "maxTargetUriBytes", targetUri.length);
    checkLimit(limits, "maxSignatureBaseBytes", method.length);
    if (rawRequestTarget !== undefined) {
        checkLimit(limits, "maxTargetUriBytes", rawRequestTarget.length);
    }

    return Object.freeze({
        method,
        targetUri,
        headers: Object.freeze(headers),
        ...(rawRequestTarget === undefined ? {} : { rawRequestTarget }),
        ...(httpVersion === undefined ? {} : { httpVersion }),
    });
}