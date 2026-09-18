import { isValidNonce } from "./nonce.js";
import { SigningError } from "./signing-errors.js";

/** Synchronous Unix milliseconds, not Unix seconds or a monotonic timestamp. */
export type SigningClock = () => number;
/** Synchronous decoded nonce value; the caller must serialize it as an SF String. */
export type SigningNonceGenerator = () => string;

export interface SigningTimestamps {
    readonly created: number;
    readonly expires: number;
}

// RFC 8941 / RFC 9651 Integer range. Safe JS integers alone are insufficient:
// a timestamp beyond this bound cannot be serialized into Signature-Input.
const MAX_SF_INTEGER = 999_999_999_999_999;

export function readSigningTimestamps(
    clock: SigningClock,
    lifetimeSeconds: number,
): SigningTimestamps {
    // Invalid lifetime is configuration, not a failure of the clock provider.
    if (!Number.isSafeInteger(lifetimeSeconds) ||
        lifetimeSeconds <= 0 || lifetimeSeconds > MAX_SF_INTEGER) {
        throw new SigningError("invalid-signing-options");
    }
    let milliseconds: unknown;
    try {
        milliseconds = clock();
    } catch {
        // Catch only the provider invocation. Its exception may contain secrets;
        // do not attach it as cause or copy its message into details.
        throw new SigningError("clock-unavailable");
    }
    if (typeof milliseconds !== "number" ||
        !Number.isFinite(milliseconds) || milliseconds < 0) {
        throw new SigningError("clock-unavailable");
    }
    const created = Math.floor(milliseconds / 1000);
    const expires = created + lifetimeSeconds;
    if (!Number.isSafeInteger(created) || !Number.isSafeInteger(expires) ||
        created > MAX_SF_INTEGER || expires > MAX_SF_INTEGER) {
        throw new SigningError("clock-unavailable");
    }
    return Object.freeze({ created, expires });
}

export function readSigningNonce(
    generator: SigningNonceGenerator,
    maximumBytes: number,
): string {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
        throw new SigningError("invalid-signing-options");
    }
    let nonce: unknown;
    try {
        nonce = generator();
    } catch {
        throw new SigningError("nonce-generation-failed");
    }
    // Shared with verification: no second nonce grammar, trimming or coercion.
    // Promise outputs fail this predicate; asynchronous providers are outside
    // this interface. Valid nonce text is escaped later by the SF serializer.
    if (!isValidNonce(nonce, maximumBytes)) {
        throw new SigningError("nonce-generation-failed");
    }
    return nonce;
}