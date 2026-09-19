import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { recoveryHorizonSeconds } from "../src/profiles/recovery-horizon.js";
import { createSignatureTimePolicy } from "../src/profiles/time-policy.js";
import type { TimePolicy } from "../src/profiles/defaults.js";

interface Fixture {
    helperCases: {
        id: string;
        policy: Partial<TimePolicy>;
        expectedSeconds?: number;
        expectedConfigurationCode?: string;
    }[];
    signatureBoundary: {
        firstAcceptedAt: number;
        created: number;
        expires: number;
        policy: Partial<TimePolicy>;
        cases: {
            elapsedSeconds: number;
            timeEligible: boolean;
            expectedReason?: string;
        }[];
    };
}
const fixture = JSON.parse(readFileSync(new URL(
    "../../../tests/fixtures/m3-contract/recovery-cases.json", import.meta.url,
), "utf8")) as Fixture;

describe("recovery horizon against independently pinned expectations", () => {
    for (const row of fixture.helperCases) {
        it(row.id, () => {
            if (row.expectedConfigurationCode) {
                expect(() => recoveryHorizonSeconds(row.policy)).toThrow(
                    expect.objectContaining({ code: row.expectedConfigurationCode }),
                );
            } else {
                expect(recoveryHorizonSeconds(row.policy)).toBe(row.expectedSeconds);
            }
        });
    }

    it("derives 360 seconds from the existing default policy", () => {
        expect(recoveryHorizonSeconds()).toBe(360);
        expect(recoveryHorizonSeconds({})).toBe(360);
    });

    const boundary = fixture.signatureBoundary;
    for (const row of boundary.cases) {
        it(`signature time eligibility at elapsed ${row.elapsedSeconds} seconds`, () => {
            const time = createSignatureTimePolicy(boundary.policy);
            const check = () => time.check(
                boundary.created, boundary.expires,
                boundary.firstAcceptedAt + row.elapsedSeconds,
            );
            if (row.timeEligible) {
                expect(check).not.toThrow();
                expect(row.elapsedSeconds).toBeLessThan(recoveryHorizonSeconds(boundary.policy));
            } else {
                expect(check).toThrow(expect.objectContaining({
                    rejection: { status: "invalid", reason: row.expectedReason },
                }));
                expect(row.elapsedSeconds).toBeGreaterThanOrEqual(
                    recoveryHorizonSeconds(boundary.policy),
                );
            }
            // Time eligibility is not authentication or a Redis readiness test.
        });
    }

    it("does not substitute the recovery bound for normal consume retention", () => {
        const time = createSignatureTimePolicy({ maxLifetimeSeconds: 60 });
        expect(recoveryHorizonSeconds(time.policy)).toBe(120);
        expect(time.retainUntil(1800000000, 1800000000)).toBe(1800000330);
        expect(time.retainUntil(1800000030, 1800000000)).toBe(1800000360);
    });
});

describe("recovery configuration validation and exact arithmetic", () => {
    for (const field of ["maxAgeSeconds", "maxLifetimeSeconds", "clockSkewSeconds"] as const) {
        it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
            `rejects invalid ${field}: %s`, (value) => {
                expect(() => recoveryHorizonSeconds({ [field]: value })).toThrow(
                    expect.objectContaining({ code: "invalid-time-policy" }),
                );
            },
        );
    }

    it("rejects an accessor without executing it", () => {
        let reads = 0;
        const input = Object.defineProperty({}, "clockSkewSeconds", {
            get() { reads++; return 30; },
        });
        expect(() => recoveryHorizonSeconds(input)).toThrow(
            expect.objectContaining({ code: "invalid-time-policy" }),
        );
        expect(reads).toBe(0);
    });

    it("accepts the exact maximum safe seconds result but never clamps overflow", () => {
        const maximum = Number.MAX_SAFE_INTEGER;
        expect(recoveryHorizonSeconds({
            maxAgeSeconds: maximum - 60,
            maxLifetimeSeconds: maximum - 60,
            clockSkewSeconds: 30,
        })).toBe(maximum);
        expect(() => recoveryHorizonSeconds({
            maxAgeSeconds: maximum - 59,
            maxLifetimeSeconds: maximum - 59,
            clockSkewSeconds: 30,
        })).toThrow(expect.objectContaining({ code: "invalid-time-policy" }));
        // Redis millisecond/deadline representability is an additional adapter gate.
    });

    it("preserves the supplied policy object", () => {
        const policy = Object.freeze({
            signingLifetimeSeconds: 1, maxAgeSeconds: 10,
            maxLifetimeSeconds: 5, clockSkewSeconds: 2,
        });
        expect(recoveryHorizonSeconds(policy)).toBe(9);
        expect(policy).toEqual({
            signingLifetimeSeconds: 1, maxAgeSeconds: 10,
            maxLifetimeSeconds: 5, clockSkewSeconds: 2,
        });
    });
});