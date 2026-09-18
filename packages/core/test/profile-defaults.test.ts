import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
    RESULT_CODES,
    RESULT_CATALOG_VERSION,
    ProfileConfigurationError,
} from "../src/profiles/codes.js";
import {
    DEFAULT_PROFILE_LIMITS,
    DEFAULT_TIME_POLICY,
    DEFAULT_REPLAY_POLICY,
    DEFAULT_CLOCK_POLICY,
    resolveProfileLimits,
    resolveTimePolicy,
    resolveReplayPolicy,
    resolveClockPolicy,
} from "../src/profiles/defaults.js";

const fixtureRoot = new URL("../../../tests/fixtures/m2/", import.meta.url);
const policy = JSON.parse(
    readFileSync(new URL("policy-cases.json", fixtureRoot)).toString("utf8"),
) as {
    catalogVersion: number;
    codeCatalog: Record<string, readonly string[]>;
};
const boundaries = JSON.parse(
    readFileSync(new URL("boundary-cases.json", fixtureRoot)).toString("utf8"),
) as { limits: Record<string, number | boolean> };

describe("frozen approved profile catalog and defaults", () => {
    it("matches every code and its classification, not only catalog counts", () => {
        expect(RESULT_CATALOG_VERSION).toBe(policy.catalogVersion);
        expect(RESULT_CODES).toEqual(policy.codeCatalog);
        expect(Object.isFrozen(RESULT_CODES)).toBe(true);
        for (const codes of Object.values(RESULT_CODES)) {
            expect(Object.isFrozen(codes)).toBe(true);
        }
    });

    it("matches independently committed resource boundaries", () => {
        for (const [name, value] of Object.entries(DEFAULT_PROFILE_LIMITS)) {
            expect(value, name).toBe(boundaries.limits[name]);
        }
        expect(DEFAULT_REPLAY_POLICY.capacity).toBe(boundaries.limits.capacity);
        expect(DEFAULT_REPLAY_POLICY.maxPerKey).toBe(boundaries.limits.maxPerKey);
        for (const defaults of [
            DEFAULT_PROFILE_LIMITS,
            DEFAULT_TIME_POLICY,
            DEFAULT_REPLAY_POLICY,
            DEFAULT_CLOCK_POLICY,
        ]) {
            expect(Object.isFrozen(defaults)).toBe(true);
        }
    });

    it("resolves frozen per-call copies without modifying overrides or defaults", () => {
        const overrides = { maxKeys: 32, maxCandidates: 8 };
        const resolved = resolveProfileLimits(overrides);
        expect(resolved.maxKeys).toBe(32);
        expect(resolved.maxCandidates).toBe(8);
        expect(resolved.maxJwksBytes).toBe(262144);
        expect(Object.isFrozen(resolved)).toBe(true);
        expect(overrides).toEqual({ maxKeys: 32, maxCandidates: 8 });
        expect(DEFAULT_PROFILE_LIMITS.maxKeys).toBe(64);
        overrides.maxKeys = 1;
        expect(resolved.maxKeys).toBe(32);
    });

    it("keeps clock drift detection separate from signature clock skew", () => {
        const time = resolveTimePolicy({ clockSkewSeconds: 5 });
        const clock = resolveClockPolicy({ maxClockDriftSeconds: 45 });
        expect(time.clockSkewSeconds).toBe(5);
        expect(clock.maxClockDriftSeconds).toBe(45);
        expect(DEFAULT_TIME_POLICY.clockSkewSeconds).toBe(30);
        expect(DEFAULT_CLOCK_POLICY.maxClockDriftSeconds).toBe(30);
    });
});

describe("profile configuration validation", () => {
    it.each([-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])(
        "rejects invalid resource budget %s with the frozen configuration code",
        (maxKeys) => {
            expect(() => resolveProfileLimits({ maxKeys }))
                .toThrow(ProfileConfigurationError);
            expect(() => resolveProfileLimits({ maxKeys }))
                .toThrow(expect.objectContaining({ code: "invalid-resource-limits" }));
        },
    );

    it("rejects unknown option names and does not invoke configuration getters", () => {
        expect(() => resolveProfileLimits({ maxKey: 1 } as never))
            .toThrow(ProfileConfigurationError);
        let reads = 0;
        const overrides = Object.defineProperty({}, "maxKeys", {
            enumerable: true,
            get() {
                reads++;
                return 64;
            },
        });
        expect(() => resolveProfileLimits(overrides)).toThrow(ProfileConfigurationError);
        expect(reads).toBe(0);
    });

    it("rejects invalid container values", () => {
        for (const invalid of [null, [], "limits"]) {
            expect(() => resolveProfileLimits(invalid as never))
                .toThrow(ProfileConfigurationError);
        }
    });

    it("requires generated nonce bytes to fit the configured encoded limit", () => {
        expect(() => resolveProfileLimits({ generatedNonceBytes: 32, maxNonceBytes: 42 }))
            .toThrow(ProfileConfigurationError);
        expect(resolveProfileLimits({ generatedNonceBytes: 32, maxNonceBytes: 43 })
            .generatedNonceBytes).toBe(32);
        expect(() => resolveProfileLimits({ generatedNonceBytes: 0 }))
            .toThrow(ProfileConfigurationError);
    });

    it("rejects inconsistent time policy and unsafe arithmetic", () => {
        for (const overrides of [
            { signingLifetimeSeconds: 301 },
            { maxAgeSeconds: 59 },
            { maxLifetimeSeconds: 59 },
            { signingLifetimeSeconds: 0 },
            { maxAgeSeconds: Number.MAX_SAFE_INTEGER },
        ]) {
            expect(() => resolveTimePolicy(overrides))
                .toThrow(expect.objectContaining({ code: "invalid-time-policy" }));
        }
        expect(resolveTimePolicy({ clockSkewSeconds: 0 }).clockSkewSeconds).toBe(0);
    });

    it("supports explicit zero replay acceptance capacity without an unlimited mode", () => {
        expect(resolveReplayPolicy({ capacity: 0, maxPerKey: 0 }))
            .toEqual({ capacity: 0, maxPerKey: 0 });
        expect(Object.isFrozen(resolveReplayPolicy())).toBe(true);
        expect(() => resolveReplayPolicy({ capacity: Infinity }))
            .toThrow(expect.objectContaining({ code: "invalid-replay-policy" }));
    });

    it("rejects unsafe clock threshold conversion to milliseconds", () => {
        expect(() => resolveClockPolicy({ maxClockDriftSeconds: Number.MAX_SAFE_INTEGER }))
            .toThrow(expect.objectContaining({ code: "invalid-clock-configuration" }));
        expect(resolveClockPolicy({ maxClockDriftSeconds: 0 }).maxClockDriftSeconds).toBe(0);
    });
});