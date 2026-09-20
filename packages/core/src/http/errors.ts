/**
 * Approved HTTP mapping-only catalog, version 1.
 * Changes require separate approval and release notes.
 * No shared union with verification, signing or operator errors: identical
 * spellings, including resource-limit, do not imply identical boundaries.
 */
export const HTTP_MAPPING_ERROR_CODES = Object.freeze([
    "capture-missing",
    "capture-incomplete",
    "http2-unsupported",
    "request-unsupported",
    "request-malformed",
    "headers-malformed",
    "host-missing",
    "host-ambiguous",
    "ingress-peer-untrusted",
    "ingress-https-required",
    "forwarding-missing",
    "forwarding-malformed",
    "forwarding-chain-rejected",
    "forwarding-families-mixed",
    "forwarding-port-inconsistent",
    "origin-disallowed",
    "resource-limit",
] as const);

export const HTTP_MAPPING_ERROR_CATALOG_VERSION = 1 as const;
export type HttpMappingErrorCode = typeof HTTP_MAPPING_ERROR_CODES[number];

const EMPTY_DETAILS: Readonly<Record<string, never>> = Object.freeze({});

/** Mapping failure, never a fabricated authentication result. */
export class HttpMappingError extends Error {
    readonly code: HttpMappingErrorCode;
    readonly details: Readonly<Record<string, never>>;

    constructor(code: HttpMappingErrorCode) {
        super(`HTTP request mapping failed: ${code}`);
        this.name = "HttpMappingError";
        this.code = code;
        // No arbitrary cause/details: never retain headers, addresses, targets,
        // nonces, key material or infrastructure error messages in diagnostics.
        this.details = EMPTY_DETAILS;
    }
}

export function rejectMapping(code: HttpMappingErrorCode): never {
    throw new HttpMappingError(code);
}

/** Setup errors are not request outcomes and do not reuse a frozen catalog. */
export function invalidHttpConfiguration(): never {
    throw new TypeError("Invalid HTTP integration configuration");
}