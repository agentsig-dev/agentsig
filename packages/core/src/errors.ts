import type { RejectionReason } from "./types.js";

/** Expected failures when processing a message, not application authorization. */
export class SignatureError extends Error {
    readonly code = "SIGNATURE_REJECTED" as const;

    constructor(readonly reason: RejectionReason) {
        // Do not interpolate untrusted headers, signature bases, or key material.
        super(`HTTP message signature rejected: ${reason}`);
        this.name = "SignatureError";
    }
}

/** A bounded-operation rejection with machine-readable resource accounting. */
export class SignatureLimitError extends SignatureError {
    constructor(
        readonly limit: string,
        readonly maximum: number,
        readonly observed: number,
    ) {
        super("resource-limit");
        this.name = "SignatureLimitError";
    }
}

/**
 * Invalid caller configuration is not a signature mismatch. Keep it separate
 * so the cryptographic verifier cannot silently turn programming mistakes
 * into an ordinary authentication failure.
 */
export class SignatureConfigurationError extends Error {
    readonly code = "SIGNATURE_INVALID_CONFIGURATION" as const;

    constructor() {
        super("Invalid HTTP message signature configuration");
        this.name = "SignatureConfigurationError";
    }
}