import { ProfileConfigurationError } from "./codes.js";
import { resolveTimePolicy } from "./defaults.js";
import type { TimePolicy } from "./defaults.js";

/**
 * Single-clock recovery bound after detected replay-history loss.
 * Pure calculation: does not connect to Redis, start quarantine, clear history,
 * consume a nonce, or change the normal per-consume retention calculation.
 *
 * Derivation from the verifier's acceptance inequalities:
 * At first acceptance T, creation C satisfies C <= T + skew.
 * Any later accepted time N satisfies
 *   N < min(expires, C + maxAge) + skew.
 * Since expires <= C + maxLifetime,
 *   N < T + min(maxAge, maxLifetime) + 2 * skew.
 * Equality is already rejected by the exclusive signature-time boundaries.
 * Defaults therefore require 360 seconds, not maxAge + skew = 330 seconds.
 *
 * Assumes one non-regressing verification time domain. The application must
 * supply the largest horizon across every verifier sharing the Redis domain,
 * plus a bounded distributed-clock allowance. This helper cannot establish
 * that deployment-wide assertion or compensate for arbitrary clock resets.
 * Redis configuration must still require an explicit horizon; this function's
 * default policy is NOT permission for the adapter to choose one implicitly.
 */
export function recoveryHorizonSeconds(overrides?: Partial<TimePolicy>): number {
    const policy = resolveTimePolicy(overrides);
    const horizon = BigInt(Math.min(policy.maxAgeSeconds, policy.maxLifetimeSeconds)) +
        2n * BigInt(policy.clockSkewSeconds);
    if (horizon > BigInt(Number.MAX_SAFE_INTEGER)) {
        // Rounding/clamping could reopen replay; reject the policy instead.
        throw new ProfileConfigurationError("invalid-time-policy");
    }
    // Positive age/lifetime and nonnegative skew were validated above.
    // Millisecond and Redis absolute-deadline bounds belong to adapter admission.
    return Number(horizon);
}