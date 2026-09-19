import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
    calculateDirectoryFreshness, isDirectoryFresh, resolveDirectoryFreshnessPolicy,
} from "../src/discovery/freshness.js";
import type { DirectoryFreshnessPolicy } from "../src/discovery/freshness.js";

interface Sample {
    headers: [string, string][];
    requestStartedMonotonicMs: number;
    responseReceivedMonotonicMs: number;
    responseReceivedWallMs: number;
}
interface Fixture {
    defaults: Omit<Sample, "headers"> & DirectoryFreshnessPolicy;
    cases: (Partial<Sample> & {
        id: string; headers: [string, string][];
        expectedRemainingMs: number; persist: boolean;
    })[];
    residenceCases: {
        id: string; remainingAtReceiptMs: number; elapsedMs: number; fresh: boolean;
    }[];
}
const fixture = JSON.parse(readFileSync(new URL(
    "../../../tests/fixtures/m3-freshness/cases.json", import.meta.url,
), "utf8")) as Fixture;
const amendment = JSON.parse(readFileSync(new URL(
    "../../../tests/fixtures/m3-freshness-amendment/cases.json", import.meta.url,
), "utf8")) as {
    supersedes: {
        id: string; field: string; previousExpected: boolean;
        replacementExpected: boolean; remainingAtReceiptMsUnchanged: number;
    }[];
    cases: {
        id: string; headers: [string, string][];
        persist: boolean; expectedRemainingMs: number;
    }[];
};

function sample(headers: [string, string][] = []): Sample {
    return {
        headers,
        requestStartedMonotonicMs: fixture.defaults.requestStartedMonotonicMs,
        responseReceivedMonotonicMs: fixture.defaults.responseReceivedMonotonicMs,
        responseReceivedWallMs: fixture.defaults.responseReceivedWallMs,
    };
}

describe("independently pinned reusable freshness expectations", () => {
    for (const row of fixture.cases) {
        it(row.id, () => {
            const result = calculateDirectoryFreshness({ ...sample(), ...row }, {
                fallbackSeconds: fixture.defaults.fallbackSeconds,
                maximumLifetimeSeconds: fixture.defaults.maximumLifetimeSeconds,
            });
            expect(result.remainingAtReceiptMs).toBe(row.expectedRemainingMs);
            const change = amendment.supersedes.find((entry) => entry.id === row.id);
            if (change) {
                // Preserve the original oracle and assert the explicit narrowing,
                // rather than silently rewriting its historical expected value.
                expect(change.field).toBe("persist");
                expect(row.persist).toBe(change.previousExpected);
                expect(change.previousExpected).toBe(true);
                expect(change.replacementExpected).toBe(false);
                expect(row.expectedRemainingMs).toBe(change.remainingAtReceiptMsUnchanged);
                expect(result.persist).toBe(change.replacementExpected);
            } else {
                expect(result.persist).toBe(row.persist);
            }
            expect(Object.isFrozen(result)).toBe(true);
        });
    }
    for (const row of fixture.residenceCases) {
        it(row.id, () => {
            expect(isDirectoryFresh({
                persist: true, receivedMonotonicMs: 1000,
                remainingAtReceiptMs: row.remainingAtReceiptMs,
            }, 1000 + row.elapsedMs)).toBe(row.fresh);
        });
    }
});

describe("freshness configuration and defensive bounds", () => {
    it("snapshots and freezes explicit configuration", () => {
        const input = { fallbackSeconds: 30, maximumLifetimeSeconds: 120 };
        const policy = resolveDirectoryFreshnessPolicy(input);
        input.fallbackSeconds = 300;
        expect(policy).toEqual({ fallbackSeconds: 30, maximumLifetimeSeconds: 120 });
        expect(Object.isFrozen(policy)).toBe(true);
        expect(calculateDirectoryFreshness(sample(), policy).remainingAtReceiptMs).toBe(30000);
    });

    it("caps even a configured fallback and permits explicit zero", () => {
        expect(calculateDirectoryFreshness(sample(), {
            fallbackSeconds: 300, maximumLifetimeSeconds: 10,
        }).remainingAtReceiptMs).toBe(10000);
        expect(calculateDirectoryFreshness(sample(), {
            maximumLifetimeSeconds: 0,
        }).remainingAtReceiptMs).toBe(0);
    });

    for (const field of ["fallbackSeconds", "maximumLifetimeSeconds"] as const) {
        it.each([-1, 301, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])(
            `rejects invalid ${field}: %s`, (value) => {
                expect(() => resolveDirectoryFreshnessPolicy({ [field]: value }))
                    .toThrow(expect.objectContaining({ code: "invalid-resource-limits" }));
            },
        );
    }

    it("rejects accessors without executing them", () => {
        let calls = 0;
        const input = Object.defineProperty({}, "fallbackSeconds", {
            get() { calls++; return 60; },
        });
        expect(() => resolveDirectoryFreshnessPolicy(input))
            .toThrow(expect.objectContaining({ code: "invalid-resource-limits" }));
        expect(calls).toBe(0);
    });

    it("rejects unknown configuration fields", () => {
        expect(() => resolveDirectoryFreshnessPolicy({
            staleSeconds: 60,
        } as Partial<DirectoryFreshnessPolicy>))
            .toThrow(expect.objectContaining({ code: "invalid-resource-limits" }));
    });

    it("bounds header occurrences before interpreting them", () => {
        const result = calculateDirectoryFreshness(sample(Array.from(
            { length: 16385 }, (): [string, string] => ["x", ""],
        )));
        expect(result).toMatchObject({ persist: false, remainingAtReceiptMs: 0 });
    });

    it("bounds aggregate header bytes", () => {
        const result = calculateDirectoryFreshness(sample([
            ["x", "a".repeat(8192)], ["y", "b".repeat(8192)],
        ]));
        expect(result).toMatchObject({ persist: false, remainingAtReceiptMs: 0 });
    });

    for (const field of [
        "requestStartedMonotonicMs", "responseReceivedMonotonicMs", "responseReceivedWallMs",
    ] as const) {
        it.each([NaN, Infinity, -Infinity, Number.MAX_VALUE])(
            `rejects nonrepresentable ${field}: %s`, (value) => {
                expect(calculateDirectoryFreshness({
                    ...sample(), [field]: value,
                }).remainingAtReceiptMs).toBe(0);
            },
        );
    }

    it.each([NaN, Infinity, -Infinity, 999])("does not revive evidence at invalid now %s", (now) => {
        expect(isDirectoryFresh(calculateDirectoryFreshness(sample()), now)).toBe(false);
    });
});

describe("restrictive metadata never falls back or disappears", () => {
    it.each([
        "max-age", "max-age=-1", "max-age=1e3", "max-age=\"\"",
        "max-age=9007199254740991", "s-maxage=30, s-maxage=30",
        "max-age=60, extension=\"unterminated", "max-age=60\r\nno-store",
    ])("declines reuse for %s", (value) => {
        expect(calculateDirectoryFreshness(sample([
            ["cache-control", value],
        ])).remainingAtReceiptMs).toBe(0);
    });

    it.each(["date", "expires"])("declines reuse for duplicate %s", (name) => {
        const date = "Sun, 06 Nov 1994 08:49:37 GMT";
        expect(calculateDirectoryFreshness(sample([
            ["cache-control", "max-age=60"], [name, date], [name, date],
        ])).remainingAtReceiptMs).toBe(0);
    });

    it("keeps a separate no-store restriction despite another malformed field", () => {
        expect(calculateDirectoryFreshness(sample([
            ["cache-control", "extension=\"unterminated"],
            ["cache-control", "no-store"],
        ]))).toMatchObject({ persist: false, remainingAtReceiptMs: 0 });
    });

    it("handles case-insensitive names and quoted extension escapes", () => {
        expect(calculateDirectoryFreshness(sample([
            ["Cache-Control", 'EXTENSION="a\\\",b", MAX-AGE=30'],
        ])).remainingAtReceiptMs).toBe(30000);
    });

    it("treats legacy Pragma no-cache conservatively", () => {
        expect(calculateDirectoryFreshness(sample([
            ["cache-control", "max-age=60"], ["pragma", "no-cache"],
        ])).remainingAtReceiptMs).toBe(0);
    });

    it("does not restart freshness when the body finishes or a caller reads again", () => {
        const result = calculateDirectoryFreshness(sample());
        expect(isDirectoryFresh(result, 60000)).toBe(true);
        expect(isDirectoryFresh(result, 61000)).toBe(false);
        expect(isDirectoryFresh(result, 62000)).toBe(false);
        expect(result.remainingAtReceiptMs).toBe(60000);
    });
});

describe("independently pinned malformed-directive persistence amendment", () => {
    for (const row of amendment.cases) {
        it(row.id, () => {
            expect(calculateDirectoryFreshness(sample(row.headers))).toMatchObject({
                persist: row.persist,
                remainingAtReceiptMs: row.expectedRemainingMs,
            });
        });
    }
});