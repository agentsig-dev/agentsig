/**
 * Approved M2 catalog, version 1.
 * Adding/removing/renaming codes requires separate approval and release notes.
 * Tests compare this complete object against the independently pinned fixture.
 */
export const RESULT_CODES = Object.freeze({
    unsigned: Object.freeze([
        "no-signature",
        "no-web-bot-auth-candidate",
    ] as const),
    verified: Object.freeze([
        "nonce-consumed",
        "nonce-absent-optional",
    ] as const),
    invalid: Object.freeze([
        "malformed-signature",
        "malformed-agent",
        "ambiguous-signatures",
        "ambiguous-profile",
        "agent-label-mismatch",
        "agent-binding-mismatch",
        "missing-required-parameter",
        "invalid-parameter",
        "invalid-time-range",
        "created-in-future",
        "signature-expired",
        "signature-too-old",
        "lifetime-exceeded",
        "insufficient-coverage",
        "key-id-mismatch",
        "algorithm-mismatch",
        "signature-mismatch",
        "nonce-required",
        "nonce-invalid",
        "replay-detected",
    ] as const),
    unverified: Object.freeze([
        "unsupported-profile",
        "unsupported-algorithm",
        "unsupported-discovery-type",
        "profile-disallowed",
        "unknown-key",
        "agent-binding-missing",
        "resource-limit",
        "replay-store-unavailable",
        "per-key-quota-exceeded",
        "clock-unavailable",
        "test-key-disallowed",
    ] as const),
    configurationErrors: Object.freeze([
        "invalid-jwks",
        "invalid-key-configuration",
        "invalid-agent-binding",
        "invalid-time-policy",
        "invalid-replay-policy",
        "invalid-resource-limits",
        "invalid-clock-configuration",
        "invalid-candidate-policy",
    ] as const),
    storeOutcomes: Object.freeze([
        "accepted",
        "replayed",
        "unavailable",
        "per-key-quota-exceeded",
    ] as const),
});

export const RESULT_CATALOG_VERSION = 1 as const;

export type UnsignedCode = typeof RESULT_CODES.unsigned[number];
export type VerifiedCode = typeof RESULT_CODES.verified[number];
export type InvalidCode = typeof RESULT_CODES.invalid[number];
export type UnverifiedCode = typeof RESULT_CODES.unverified[number];
export type ConfigurationCode = typeof RESULT_CODES.configurationErrors[number];
export type StoreOutcome = typeof RESULT_CODES.storeOutcomes[number];

/** Discriminated pairs prevent a code from being assigned to the wrong status. */
export type ProfileRejection =
    | { readonly status: "invalid"; readonly reason: InvalidCode }
    | { readonly status: "unverified"; readonly reason: UnverifiedCode };

/**
 * Caller configuration failures are not evidence about a remote request.
 * Deliberately exclude input values and nested crypto exception messages.
 */
export class ProfileConfigurationError extends Error {
    constructor(readonly code: ConfigurationCode) {
        super(`Invalid Web Bot Auth configuration: ${code}`);
        this.name = "ProfileConfigurationError";
    }
}

/**
 * Internal control-flow error for expected candidate rejection.
 * Not a public verification result and not a catch-all for programming errors.
 */
export class CandidateRejection extends Error {
    constructor(readonly rejection: ProfileRejection) {
        super(`Web Bot Auth candidate rejected: ${rejection.reason}`);
        this.name = "CandidateRejection";
    }
}