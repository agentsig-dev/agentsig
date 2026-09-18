import { CandidateRejection } from "./codes.js";
import type { InvalidCode } from "./codes.js";
import { resolveTimePolicy } from "./defaults.js";
import type { TimePolicy } from "./defaults.js";

export interface SignatureTimePolicy {
    readonly policy: Readonly<TimePolicy>;
    /**
     * A successful check means only that the time window is acceptable.
     * It does not verify a signature, establish identity or consume a nonce.
     */
    check(created: number, expires: number, nowEpochSeconds: number): void;
}

const MAX_SF_INTEGER = 999_999_999_999_999;

function timestamp(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) &&
        value >= 0 && value <= MAX_SF_INTEGER;
}

function reject(reason: InvalidCode): never {
    throw new CandidateRejection({ status: "invalid", reason });
}

/**
 * Pure, per-profile time-window evaluator. No implicit Date.now, network or
 * replay side effects. The caller supplies a healthy clock's integer seconds.
 *
 * Missing parameters and wrong SF types belong to the metadata parsing gate.
 * This gate checks numeric time ranges and the approved window inequalities.
 * Run again after awaiting replay consumption: a signature that expires
 * during the await must not be accepted, and its nonce must not be rolled back.
 */
export function createSignatureTimePolicy(
    overrides?: Partial<TimePolicy>,
): SignatureTimePolicy {
    const policy = resolveTimePolicy(overrides);
    const skew = BigInt(policy.clockSkewSeconds);
    const maxLifetime = BigInt(policy.maxLifetimeSeconds);
    const maxAge = BigInt(policy.maxAgeSeconds);

    return Object.freeze({
        policy,
        check(created: number, expires: number, nowEpochSeconds: number): void {
            // A bad clock sample is not evidence of an invalid remote request.
            // Never coerce, floor or replace it with a second wall-clock read.
            if (typeof nowEpochSeconds !== "number" ||
                !Number.isSafeInteger(nowEpochSeconds) || nowEpochSeconds < 0) {
                throw new CandidateRejection({
                    status: "unverified", reason: "clock-unavailable",
                });
            }
            if (!timestamp(created) || !timestamp(expires) || expires <= created) {
                reject("invalid-time-range");
            }

            // Even individually safe numeric inputs can overflow when added.
            // Exact arithmetic preserves boundary comparisons without clamping
            // signed timestamps or imposing a new undocumented policy maximum.
            const start = BigInt(created);
            const end = BigInt(expires);
            const now = BigInt(nowEpochSeconds);
            if (end - start > maxLifetime) reject("lifetime-exceeded");
            if (start > now + skew) reject("created-in-future");

            // Both end boundaries are exclusive. Accepting equality could
            // reopen a replay window after a store expires the corresponding
            // record at that exact second.
            if (now >= end + skew) reject("signature-expired");
            if (now >= start + maxAge + skew) reject("signature-too-old");
        },
    });
}