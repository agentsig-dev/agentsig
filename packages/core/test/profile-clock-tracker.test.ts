import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createClockTracker } from "../src/profiles/clock-tracker.js";

interface ClockCase {
    readonly id: string;
    readonly referenceWallMs: number;
    readonly referenceMonotonicMs: number;
    readonly previousMonotonicMs?: number;
    readonly wallMs: number;
    readonly monotonicMs: number;
    readonly healthy: boolean;
    readonly effectiveEpochSeconds?: number;
}
interface RecoverySequence {
    readonly id: string;
    readonly reference: { wallMs: number; monotonicMs: number };
    readonly samples: readonly {
        wallMs: number; monotonicMs: number; healthy: boolean;
    }[];
    readonly expectedHealthTransitions: readonly string[];
    readonly finalEffectiveEpochSeconds: number;
}
const fixtures = JSON.parse(readFileSync(new URL(
    "../../../tests/fixtures/m2/boundary-cases.json", import.meta.url,
), "utf8")) as {
    clockCases: readonly ClockCase[];
    clockSequences: readonly (RecoverySequence | { id: string })[];
};

describe("clock tracker — pre-implementation boundary fixtures", () => {
    for (const fixture of fixtures.clockCases) {
        it(fixture.id, () => {
            const tracker = createClockTracker(
                fixture.referenceWallMs, fixture.referenceMonotonicMs,
            );
            if (fixture.previousMonotonicMs !== undefined) {
                const elapsed = fixture.previousMonotonicMs - fixture.referenceMonotonicMs;
                expect(tracker.observe(
                    fixture.referenceWallMs + elapsed, fixture.previousMonotonicMs,
                ).healthy).toBe(true);
            }
            const result = tracker.observe(fixture.wallMs, fixture.monotonicMs);
            expect(result.healthy).toBe(fixture.healthy);
            expect(Object.isFrozen(result)).toBe(true);
            if (result.healthy) {
                expect(result.epochSeconds).toBe(fixture.effectiveEpochSeconds);
            } else {
                expect(result).not.toHaveProperty("epochSeconds");
                expect(result).not.toHaveProperty("effectiveMilliseconds");
                expect(result.transition).toBe("unhealthy");
            }
        });
    }

    it("recovers from wall drift against the original reference without rebasing", () => {
        const fixture = fixtures.clockSequences.find((entry) =>
            entry.id === "recover-without-rebase") as RecoverySequence;
        const tracker = createClockTracker(
            fixture.reference.wallMs, fixture.reference.monotonicMs,
        );
        const originalReference = tracker.reference;
        const transitions: string[] = [];
        const results = fixture.samples.map((sample) => {
            const result = tracker.observe(sample.wallMs, sample.monotonicMs);
            expect(result.healthy).toBe(sample.healthy);
            if (result.transition) transitions.push(result.transition);
            expect(tracker.reference).toBe(originalReference);
            expect(tracker.reference).toEqual(fixture.reference);
            return result;
        });
        expect(transitions).toEqual(fixture.expectedHealthTransitions);
        expect(results.at(-1)).toMatchObject({
            healthy: true, epochSeconds: fixture.finalEffectiveEpochSeconds,
        });
    });
});

describe("clock tracker health and arithmetic boundaries", () => {
    it("does not recover a regressed monotonic reference automatically", () => {
        const tracker = createClockTracker(100000, 1000);
        expect(tracker.observe(101000, 2000).healthy).toBe(true);
        expect(tracker.observe(100999, 1999)).toEqual({
            healthy: false, reason: "monotonic-regression", transition: "unhealthy",
        });
        expect(tracker.observe(102000, 3000)).toEqual({
            healthy: false, reason: "monotonic-regression",
        });
        expect(tracker.reference).toEqual({ wallMs: 100000, monotonicMs: 1000 });
        expect(tracker).not.toHaveProperty("resetClockReference");
    });

    it("tracks monotonic advancement even during invalid wall samples", () => {
        const tracker = createClockTracker(100000, 1000);
        expect(tracker.observe(NaN, 5000)).toEqual({
            healthy: false, reason: "invalid-sample", transition: "unhealthy",
        });
        expect(tracker.observe(103999, 4999)).toEqual({
            healthy: false, reason: "monotonic-regression",
        });
        expect(tracker.observe(105000, 6000).healthy).toBe(false);
    });

    it.each([NaN, Infinity, -Infinity, undefined, null, "1000", {}])(
        "fails closed on invalid samples without exposing time %#", (invalid) => {
            for (const result of [
                createClockTracker(100000, 1000).observe(invalid, 2000),
                createClockTracker(100000, 1000).observe(101000, invalid),
            ]) {
                expect(result).toEqual({
                    healthy: false, reason: "invalid-sample", transition: "unhealthy",
                });
            }
        },
    );

    it("uses an arbitrary monotonic origin and floors effective time only at output", () => {
        const tracker = createClockTracker(100000, -500.5);
        expect(tracker.observe(100999.75, 499.25)).toMatchObject({
            healthy: true, effectiveMilliseconds: 100999.75, epochSeconds: 100,
        });
        expect(tracker.observe(101000, 499.5)).toMatchObject({
            healthy: true, effectiveMilliseconds: 101000, epochSeconds: 101,
        });
    });

    it("treats the drift threshold as inclusive and independent of signature skew", () => {
        const tracker = createClockTracker(100000, 0, { maxClockDriftSeconds: 1 });
        expect(tracker.observe(102000, 1000).healthy).toBe(true);
        expect(tracker.observe(102000.5, 1000)).toEqual({
            healthy: false, reason: "wall-drift", transition: "unhealthy",
        });
        expect(tracker.observe(100000, 1000)).toMatchObject({
            healthy: true, transition: "healthy", epochSeconds: 101,
        });
        expect(tracker.observe(99999.5, 1000)).toMatchObject({
            healthy: false, reason: "wall-drift", transition: "unhealthy",
        });
    });

    it("supports zero drift allowance and does not repeat same-state transitions", () => {
        const tracker = createClockTracker(100000, 0, { maxClockDriftSeconds: 0 });
        expect(tracker.observe(101000, 1000)).not.toHaveProperty("transition");
        expect(tracker.observe(101001, 1000).transition).toBe("unhealthy");
        expect(tracker.observe(101002, 1000)).not.toHaveProperty("transition");
        expect(tracker.observe(101000, 1000).transition).toBe("healthy");
        expect(tracker.observe(101000, 1000)).not.toHaveProperty("transition");
    });

    it("rejects unsafe combined arithmetic even when individual samples are bounded", () => {
        const tracker = createClockTracker(Number.MAX_SAFE_INTEGER, 0);
        expect(tracker.observe(Number.MAX_SAFE_INTEGER, 1)).toEqual({
            healthy: false, reason: "unsafe-arithmetic", transition: "unhealthy",
        });
        const distant = createClockTracker(0, -Number.MAX_SAFE_INTEGER);
        expect(distant.observe(0, Number.MAX_SAFE_INTEGER)).toMatchObject({
            healthy: false, reason: "unsafe-arithmetic",
        });
    });

    it("owns frozen configuration and rejects invalid reference values", () => {
        const overrides = { maxClockDriftSeconds: 1 };
        const tracker = createClockTracker(0, 0, overrides);
        overrides.maxClockDriftSeconds = 100;
        expect(tracker.policy.maxClockDriftSeconds).toBe(1);
        expect(Object.isFrozen(tracker)).toBe(true);
        expect(Object.isFrozen(tracker.reference)).toBe(true);
        expect(Object.isFrozen(tracker.policy)).toBe(true);
        for (const [wall, monotonic] of [
            [-1, 0], [NaN, 0], [0, Infinity], [Number.MAX_SAFE_INTEGER + 1, 0],
        ]) {
            expect(() => createClockTracker(wall!, monotonic!)).toThrow(
                expect.objectContaining({ code: "invalid-clock-configuration" }),
            );
        }
    });
});