import { ProfileConfigurationError } from "./codes.js";
import type { ConfigurationCode } from "./codes.js";

export interface ProfileLimits {
    readonly maxJwksBytes: number;
    readonly maxKeys: number;
    readonly maxCandidates: number;
    readonly maxNonceBytes: number;
    readonly generatedNonceBytes: number;
    readonly maxScopeBytes: number;
    readonly maxAgentBindings: number;
    readonly maxAgentUrlBytes: number;
}

/**
 * Approved local resource budgets, not protocol maxima.
 * Core's explicit 16 KiB budget remains an independent lower-level boundary.
 * Check wire sizes before decoding and cardinalities before growing collections.
 */
export const DEFAULT_PROFILE_LIMITS: Readonly<ProfileLimits> = Object.freeze({
    maxJwksBytes: 262_144,
    maxKeys: 64,
    maxCandidates: 16,
    maxNonceBytes: 256,
    generatedNonceBytes: 32,
    maxScopeBytes: 256,
    maxAgentBindings: 64,
    maxAgentUrlBytes: 2_048,
});

export interface TimePolicy {
    readonly signingLifetimeSeconds: number;
    readonly maxLifetimeSeconds: number;
    readonly maxAgeSeconds: number;
    readonly clockSkewSeconds: number;
}

/** Resolve independently per profile; never infer policy from wire metadata. */
export const DEFAULT_TIME_POLICY: Readonly<TimePolicy> = Object.freeze({
    signingLifetimeSeconds: 60,
    maxLifetimeSeconds: 300,
    maxAgeSeconds: 300,
    clockSkewSeconds: 30,
});

export interface ReplayPolicy {
    readonly capacity: number;
    readonly maxPerKey: number;
}

/**
 * No live-entry eviction: exhausting these budgets must not silently reopen
 * replay windows. The per-key quota applies across the entire store instance.
 */
export const DEFAULT_REPLAY_POLICY: Readonly<ReplayPolicy> = Object.freeze({
    capacity: 10_000,
    maxPerKey: 1_000,
});

export interface ClockPolicy {
    readonly maxClockDriftSeconds: number;
}

/** Health threshold is intentionally separate from signature clock tolerance. */
export const DEFAULT_CLOCK_POLICY: Readonly<ClockPolicy> = Object.freeze({
    maxClockDriftSeconds: 30,
});

/**
 * Read each override once, reject unknown options/accessors, and freeze a copy.
 * These are trusted configuration objects, not request data; no getter should
 * run merely because a verifier is being configured.
 */
function resolveNumericOptions<T extends object>(
    defaults: Readonly<T>,
    overrides: Partial<T> | undefined,
    code: ConfigurationCode,
    zeroAllowed: readonly (keyof T)[] = [],
): Readonly<T> {
    if (overrides !== undefined &&
        (overrides === null || typeof overrides !== "object" || Array.isArray(overrides))) {
        throw new ProfileConfigurationError(code);
    }
    const result = { ...defaults };
    if (overrides !== undefined) {
        for (const key of Reflect.ownKeys(overrides)) {
            if (typeof key !== "string" || !Object.hasOwn(defaults, key)) {
                throw new ProfileConfigurationError(code);
            }
            const descriptor = Object.getOwnPropertyDescriptor(overrides, key);
            if (!descriptor || !Object.hasOwn(descriptor, "value")) {
                throw new ProfileConfigurationError(code);
            }
            const value: unknown = descriptor.value;
            if (typeof value !== "number" || !Number.isSafeInteger(value) ||
                value < 0 || (value === 0 && !zeroAllowed.includes(key as keyof T))) {
                throw new ProfileConfigurationError(code);
            }
            Object.defineProperty(result, key, {
                value, enumerable: true, writable: true, configurable: true,
            });
        }
    }
    return Object.freeze(result);
}

export function resolveProfileLimits(
    overrides?: Partial<ProfileLimits>,
): Readonly<ProfileLimits> {
    const limits = resolveNumericOptions(
        DEFAULT_PROFILE_LIMITS, overrides, "invalid-resource-limits",
        ["maxJwksBytes", "maxKeys", "maxCandidates", "maxNonceBytes",
            "maxScopeBytes", "maxAgentBindings", "maxAgentUrlBytes"],
    );
    // Unpadded base64url length, calculated before random-byte allocation.
    // A configured signer must be capable of emitting an acceptable nonce.
    const encodedLength = Math.ceil(limits.generatedNonceBytes * 4 / 3);
    if (!Number.isSafeInteger(encodedLength) || encodedLength > limits.maxNonceBytes) {
        throw new ProfileConfigurationError("invalid-resource-limits");
    }
    return limits;
}

export function resolveTimePolicy(
    overrides?: Partial<TimePolicy>,
): Readonly<TimePolicy> {
    const policy = resolveNumericOptions(
        DEFAULT_TIME_POLICY, overrides, "invalid-time-policy", ["clockSkewSeconds"],
    );
    if (policy.signingLifetimeSeconds > policy.maxLifetimeSeconds ||
        policy.signingLifetimeSeconds > policy.maxAgeSeconds ||
        !Number.isSafeInteger(policy.maxAgeSeconds + policy.clockSkewSeconds) ||
        !Number.isSafeInteger(policy.maxLifetimeSeconds + policy.clockSkewSeconds)) {
        throw new ProfileConfigurationError("invalid-time-policy");
    }
    return policy;
}

export function resolveReplayPolicy(
    overrides?: Partial<ReplayPolicy>,
): Readonly<ReplayPolicy> {
    // Zero capacity/quota intentionally disables acceptance; no unbounded mode.
    // maxPerKey may exceed capacity: the effective global bound still applies.
    return resolveNumericOptions(
        DEFAULT_REPLAY_POLICY, overrides, "invalid-replay-policy",
        ["capacity", "maxPerKey"],
    );
}

export function resolveClockPolicy(
    overrides?: Partial<ClockPolicy>,
): Readonly<ClockPolicy> {
    const policy = resolveNumericOptions(
        DEFAULT_CLOCK_POLICY, overrides, "invalid-clock-configuration",
        ["maxClockDriftSeconds"],
    );
    if (!Number.isSafeInteger(policy.maxClockDriftSeconds * 1000)) {
        throw new ProfileConfigurationError("invalid-clock-configuration");
    }
    return policy;
}