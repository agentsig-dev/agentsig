import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createSignatureTimePolicy } from "../src/profiles/time-policy.js";
import type { TimePolicy } from "../src/profiles/defaults.js";

interface TimeCase {
    readonly id: string;
    readonly now: number;
    readonly created: number;
    readonly expires: number;
    readonly policyOverrides?: Partial<TimePolicy>;
    readonly expectedTimeValid?: boolean;
    readonly expectedCode?: string;
}
const fixtures = JSON.parse(readFileSync(new URL(
    "../../../tests/fixtures/m2/policy-cases.json", import.meta.url,
), "utf8")) as { timeContract: { cases: TimeCase[] } };

function rejection(reason: string, status = "invalid") {
    return expect.objectContaining({ rejection: { status, reason } });
}

describe("signature time policy — independently pinned windows", () => {
    for (const fixture of fixtures.timeContract.cases) {
        it(fixture.id, () => {
            const evaluator = createSignatureTimePolicy(fixture.policyOverrides);
            const run = () => evaluator.check(fixture.created, fixture.expires, fixture.now);
            if (fixture.expectedTimeValid) expect(run()).toBeUndefined();
            else expect(run).toThrow(rejection(fixture.expectedCode!));
        });
    }
});

describe("exclusive expiry and age boundaries", () => {
    it("accepts exactly the maximum lifetime, not one second more", () => {
        const evaluator = createSignatureTimePolicy();
        expect(() => evaluator.check(1000, 1300, 1000)).not.toThrow();
        expect(() => evaluator.check(1000, 1301, 1000))
            .toThrow(rejection("lifetime-exceeded"));
    });

    it("applies zero skew without adding an implicit tolerance", () => {
        const evaluator = createSignatureTimePolicy({ clockSkewSeconds: 0 });
        expect(() => evaluator.check(1000, 1060, 1059)).not.toThrow();
        expect(() => evaluator.check(1000, 1060, 1060))
            .toThrow(rejection("signature-expired"));
        expect(() => evaluator.check(1001, 1061, 1000))
            .toThrow(rejection("created-in-future"));
    });

    it("checks age independently of expiry with an exclusive end", () => {
        const evaluator = createSignatureTimePolicy({ maxLifetimeSeconds: 600 });
        expect(() => evaluator.check(1000, 1600, 1329)).not.toThrow();
        expect(() => evaluator.check(1000, 1600, 1330))
            .toThrow(rejection("signature-too-old"));
    });

    it("can recheck after an asynchronous operation without remembering acceptance", () => {
        const evaluator = createSignatureTimePolicy();
        expect(evaluator.check(1000, 1060, 1089)).toBeUndefined();
        expect(() => evaluator.check(1000, 1060, 1090))
            .toThrow(rejection("signature-expired"));
        // No store is used here; await/consumption ordering requires verifier tests.
    });
});

describe("numeric validation and exact arithmetic", () => {
    it.each([-1, 1.5, NaN, Infinity, 1_000_000_000_000_000])(
        "rejects invalid signed timestamp %s", (value) => {
            const evaluator = createSignatureTimePolicy();
            expect(() => evaluator.check(value, 1060, 1000))
                .toThrow(rejection("invalid-time-range"));
            expect(() => evaluator.check(1000, value, 1000))
                .toThrow(rejection("invalid-time-range"));
        },
    );

    it("does not coerce nonnumeric signed values or clock values", () => {
        const evaluator = createSignatureTimePolicy();
        for (const value of [undefined, null, "1000", {}, true]) {
            expect(() => evaluator.check(value as number, 1060, 1000))
                .toThrow(rejection("invalid-time-range"));
            expect(() => evaluator.check(1000, 1060, value as number))
                .toThrow(rejection("clock-unavailable", "unverified"));
        }
    });

    it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
        "classifies invalid clock second %s as unavailable", (now) => {
            expect(() => createSignatureTimePolicy().check(1000, 1060, now))
                .toThrow(rejection("clock-unavailable", "unverified"));
        },
    );

    it("rejects nonpositive lifetime and accepts epoch zero", () => {
        const evaluator = createSignatureTimePolicy();
        expect(evaluator.check(0, 60, 0)).toBeUndefined();
        expect(() => evaluator.check(1000, 1000, 1000))
            .toThrow(rejection("invalid-time-range"));
        expect(() => evaluator.check(1000, 999, 1000))
            .toThrow(rejection("invalid-time-range"));
    });

    it("compares large safe inputs whose sums exceed the safe integer range exactly", () => {
        const maximum = Number.MAX_SAFE_INTEGER;
        const evaluator = createSignatureTimePolicy({
            signingLifetimeSeconds: 1,
            maxLifetimeSeconds: 1,
            maxAgeSeconds: 1,
            clockSkewSeconds: maximum - 1,
        });
        // Exact expiry boundary = 2 + (MAX_SAFE_INTEGER - 1) = MAX + 1.
        // Rounding that sum down would incorrectly reject now=MAX.
        expect(evaluator.check(1, 2, maximum)).toBeUndefined();
        // Exact boundary here equals MAX; equality must be rejected.
        expect(() => evaluator.check(0, 1, maximum))
            .toThrow(rejection("signature-expired"));
    });

    it("owns frozen per-profile policy and does not consult a wall clock", () => {
        const overrides = { clockSkewSeconds: 0 };
        const evaluator = createSignatureTimePolicy(overrides);
        overrides.clockSkewSeconds = 100;
        expect(evaluator.policy.clockSkewSeconds).toBe(0);
        expect(Object.isFrozen(evaluator)).toBe(true);
        expect(Object.isFrozen(evaluator.policy)).toBe(true);
        const wall = vi.spyOn(Date, "now").mockImplementation(() => {
            throw new Error("Implicit wall clock access");
        });
        try {
            expect(evaluator.check(1000, 1060, 1000)).toBeUndefined();
            expect(wall).not.toHaveBeenCalled();
        } finally {
            wall.mockRestore();
        }
    });

    it("keeps invalid local time configuration outside request-result errors", () => {
        expect(() => createSignatureTimePolicy({ maxAgeSeconds: -1 }))
            .toThrow(expect.objectContaining({ code: "invalid-time-policy" }));
    });
});