/**
 * Approved signer-only catalog, version 1.
 * Changes require separate approval and release notes.
 * Never combine this union with the frozen verification result catalog:
 * identical spellings do not imply identical error boundaries.
 */
export const SIGNING_ERROR_CODES = Object.freeze([
    "existing-signature-headers",
    "invalid-signing-key",
    "test-key-disallowed",
    "invalid-agent-origin",
    "invalid-label",
    "unsupported-profile",
    "unsupported-component",
    "invalid-request",
    "invalid-signing-options",
    "clock-unavailable",
    "nonce-generation-failed",
    "resource-limit",
    "signing-failed",
] as const);

export const SIGNING_ERROR_CATALOG_VERSION = 1 as const;
export type SigningErrorCode = typeof SIGNING_ERROR_CODES[number];

const EMPTY_DETAILS: Readonly<Record<string, never>> = Object.freeze({});

export class SigningError extends Error {
    readonly code: SigningErrorCode;
    readonly details: Readonly<Record<string, never>>;

    constructor(code: SigningErrorCode) {
        super(`Web Bot Auth signing failed: ${code}`);
        this.name = "SigningError";
        this.code = code;
        // No arbitrary context/cause parameter: provider exceptions can contain
        // secrets. Keep details empty rather than copying request data, nonce,
        // private material or backend error messages into serializable errors.
        this.details = EMPTY_DETAILS;
    }
}