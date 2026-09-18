import { DEFAULT_PROFILE_LIMITS } from "./defaults.js";

/**
 * Shared nonce syntax predicate for signing and verification.
 * Each caller maps false to its own error catalog; this helper throws neither
 * signing errors nor candidate rejections.
 *
 * Approved local policy: nonempty printable ASCII, including space, quotation
 * mark and backslash. Valid ASCII has identical byte and code-unit lengths.
 * Check length before scanning to bound work on oversized provider outputs.
 *
 * Do not trim, normalize, escape or decode here. Signing must pass the original
 * value to the SF String serializer; verification must check the decoded SF
 * String and retain that exact value for replay grouping.
 *
 * Syntax acceptance proves neither entropy nor uniqueness. Secure random
 * generation and atomic replay consumption are separate responsibilities.
 */
export function isValidNonce(
    value: unknown,
    maximumBytes: number = DEFAULT_PROFILE_LIMITS.maxNonceBytes,
): value is string {
    // Configuring callers validate their budgets separately. Defensively fail
    // closed here as well, without mixing the signer and verifier error types.
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) return false;
    if (typeof value !== "string" || value.length === 0 || value.length > maximumBytes) {
        return false;
    }
    return !/[^\x20-\x7e]/.test(value);
}