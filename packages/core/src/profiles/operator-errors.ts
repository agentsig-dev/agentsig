/**
 * Approved operator-only catalog, version 1.
 * Changes require separate approval and release notes.
 *
 * Reset failures describe an operator action, not request validity. Keep this
 * catalog and error type separate from signing and verification catalogs.
 * Requests rejected by an unhealthy/resetting context still use the existing
 * verification reason clock-unavailable.
 */
export const OPERATOR_ERROR_CODES = Object.freeze([
    "reset-unsupported-store",
    "reset-in-progress",
    "reset-clock-unavailable",
    "reset-failed",
] as const);

export const OPERATOR_ERROR_CATALOG_VERSION = 1 as const;
export type OperatorErrorCode = typeof OPERATOR_ERROR_CODES[number];

const EMPTY_DETAILS: Readonly<Record<string, never>> = Object.freeze({});

/** Stable operator boundary; never attach raw provider or store exceptions. */
export class OperatorError extends Error {
    readonly code: OperatorErrorCode;
    readonly details: Readonly<Record<string, never>>;

    constructor(code: OperatorErrorCode) {
        super(`Web Bot Auth operator action failed: ${code}`);
        this.name = "OperatorError";
        this.code = code;
        // Observable reset counts/epochs belong to the sanitized event schema.
        // Arbitrary causes/details could expose keys, nonces or backend errors.
        this.details = EMPTY_DETAILS;
    }
}