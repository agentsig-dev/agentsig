import { SignatureError } from "../errors.js";
import { validateHeaders } from "../headers.js";
import type { HeaderField, Limits, RequestParts } from "../types.js";
import { SigningError } from "./signing-errors.js";

function invalid(): never {
    throw new SigningError("invalid-request");
}

/** Read data, not executable accessors, at the local descriptor boundary. */
function ownData(object: object, name: string, required: boolean): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(object, name);
    if (!descriptor) {
        if (required) return invalid();
        return undefined;
    }
    if (!Object.hasOwn(descriptor, "value")) return invalid();
    return descriptor.value as unknown;
}

/**
 * Snapshot before invoking caller-provided clock/nonce callbacks.
 *
 * Synchronous callbacks can mutate objects through closures even without an
 * await. Signing must use the owned snapshot, not reread the caller's request
 * afterwards. This function never changes the request, header array, tuples
 * or byte buffers supplied by the caller.
 *
 * Reject existing signature fields by NAME alone: empty, malformed or partial
 * values still mean an existing field. No merge, repair or silent overwrite.
 * This is the approved M2 signer boundary, not a verifier limitation.
 *
 * Configuration/request descriptors are trusted local JS objects, not a
 * sandbox for hostile Proxies. Their HTTP values remain untrusted input.
 */
export function snapshotUnsignedRequest(
    input: RequestParts,
    limits: Readonly<Limits>,
): RequestParts {
    if (!input || typeof input !== "object" || Array.isArray(input)) return invalid();
    const sourceHeaders = ownData(input, "headers", true);
    if (!Array.isArray(sourceHeaders)) return invalid();

    // Each field contributes at least ": " and CRLF to core's descriptor
    // budget. Bound cardinality before allocating the copied header array.
    if (sourceHeaders.length > Math.floor(limits.maxMessageHeaderBytes / 4)) {
        throw new SigningError("resource-limit");
    }

    const headers: HeaderField[] = [];
    let total = 0;
    for (let index = 0; index < sourceHeaders.length; index++) {
        const entry = ownData(sourceHeaders, String(index), true);
        if (!Array.isArray(entry) || entry.length !== 2) return invalid();
        const name = ownData(entry, "0", true);
        if (typeof name !== "string") return invalid();

        // Avoid allocating a lowercased copy of an unbounded field name.
        if (name.length > limits.maxMessageHeaderBytes - total) {
            throw new SigningError("resource-limit");
        }
        const lower = name.toLowerCase();
        if (lower === "signature" || lower === "signature-input" || lower === "signature-agent") {
            throw new SigningError("existing-signature-headers");
        }

        const value = ownData(entry, "1", true);
        if (typeof value !== "string" && !(value instanceof Uint8Array)) return invalid();
        total += name.length + value.length + 4;
        if (!Number.isSafeInteger(total) || total > limits.maxMessageHeaderBytes) {
            throw new SigningError("resource-limit");
        }
        headers.push(Object.freeze([
            name,
            typeof value === "string" ? value : Uint8Array.from(value),
        ] as const));
    }

    // Reuse core's field-name/ASCII validation; do not introduce a second HTTP
    // header grammar. Signed-value normalization remains core's responsibility.
    try {
        validateHeaders(headers, limits);
    } catch (error) {
        if (error instanceof SignatureError) {
            throw new SigningError(error.reason === "resource-limit"
                ? "resource-limit" : "invalid-request");
        }
        throw error;
    }

    const method = ownData(input, "method", true);
    const targetUri = ownData(input, "targetUri", true);
    const rawRequestTarget = ownData(input, "rawRequestTarget", false);
    const httpVersion = ownData(input, "httpVersion", false);
    if (typeof method !== "string" || typeof targetUri !== "string") return invalid();
    if (rawRequestTarget !== undefined && typeof rawRequestTarget !== "string") return invalid();
    if (httpVersion !== undefined &&
        httpVersion !== "1.1" && httpVersion !== "2" && httpVersion !== "3") return invalid();
    if (targetUri.length > limits.maxTargetUriBytes ||
        method.length > limits.maxSignatureBaseBytes) {
        throw new SigningError("resource-limit");
    }

    return Object.freeze({
        method,
        targetUri,
        headers: Object.freeze(headers),
        ...(rawRequestTarget === undefined ? {} : { rawRequestTarget }),
        ...(httpVersion === undefined ? {} : { httpVersion }),
    });
}