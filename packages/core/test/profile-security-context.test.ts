import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createSecurityContextController } from "../src/profiles/security-context-controller.js";
import type { SecurityContextController } from "../src/profiles/security-context-controller.js";
import type { SecurityContextEvent, MemoryCleanupReport } from "../src/profiles/context-events.js";
import type { ReplayConsumeInput, ReplayStore } from "../src/profiles/replay-store.js";
import type { StoreOutcome } from "../src/profiles/codes.js";

interface Scenario {
    id: string;
    initial: {
        epoch: number;
        reference: { wallMs: number; monotonicMs: number };
        records: number;
        quotaCounters: number;
        inFlight: number;
    };
    resetSample?: { wallMs: number; monotonicMs: number };
    expected?: Record<string, unknown>;
}
const fixture = JSON.parse(readFileSync(new URL(
    "../../../tests/fixtures/reset/cases.json", import.meta.url,
), "utf8")) as { cases: Scenario[] };
const reference = fixture.cases[0]!.initial.reference;
const replacement = fixture.cases[0]!.resetSample!;
const unavailable = () => expect.objectContaining({
    rejection: { status: "unverified", reason: "clock-unavailable" },
});
const payload = {
    scope: "merchant",
    keyThumbprint: "DR68nui99ukl-GUgfzQGaU3VwqRtArw-_DCN4LFtY84",
    nonce: "test-nonce",
    retainUntilEpochSeconds: 1800000330,
};

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function harness(
    declaration?: "process-clock" | "independent",
    observer?: (event: Readonly<SecurityContextEvent>) => void,
    owned = declaration === "process-clock",
) {
    let wallMs = reference.wallMs;
    let monotonicMs = reference.monotonicMs;
    let records = 2;
    let quotas = 1;
    let wallReads = 0;
    let clearCalls = 0;
    const calls: Readonly<ReplayConsumeInput>[] = [];
    const events: Readonly<SecurityContextEvent>[] = [];
    let consume: ReplayStore["consume"] = async () => "accepted";
    let clear: () => MemoryCleanupReport | Promise<MemoryCleanupReport> = () => {
        const result = { clearedRecords: records, clearedQuotaCounters: quotas };
        records = 0;
        quotas = 0;
        return result;
    };
    const store: ReplayStore = {
        ...(declaration === undefined ? {} : { retentionClock: declaration }),
        consume(input) { calls.push(input); return consume(input); },
    };
    const context = createSecurityContextController({
        store,
        ...(owned ? {
            memoryReset: {
                clearForClockReset() { clearCalls++; return clear(); },
            }
        } : {}),
        wallClock: () => { wallReads++; return wallMs; },
        monotonicClock: () => monotonicMs,
        observer: (event) => { events.push(event); observer?.(event); },
    });
    return {
        context, calls, events,
        get records() { return records; },
        get quotas() { return quotas; },
        get wallReads() { return wallReads; },
        get clearCalls() { return clearCalls; },
        sample(wall: number, mono: number) { wallMs = wall; monotonicMs = mono; },
        setConsume(value: ReplayStore["consume"]) { consume = value; },
        setClear(value: typeof clear) { clear = value; },
        setCounts(r: number, q: number) { records = r; quotas = q; },
    };
}

describe("shared context reset and epoch coordination", () => {
    it("matches healthy memory reset event and state against the pinned fixture", async () => {
        const expected = fixture.cases.find((entry) => entry.id === "healthy-memory-reset")!;
        const h = harness("process-clock");
        while (h.context.activeEpoch! < expected.initial.epoch) {
            await h.context.resetClockReference();
        }
        h.events.length = 0;
        h.setCounts(expected.initial.records, expected.initial.quotaCounters);
        const leases = Array.from({ length: expected.initial.inFlight }, () => h.context.beginOperation());
        h.sample(replacement.wallMs, replacement.monotonicMs);
        const pending = h.context.resetClockReference();
        expect(h.context.resetInProgress).toBe(true);
        expect(() => h.context.beginOperation()).toThrow(unavailable());
        const event = await pending;
        expect(event).toEqual({ type: "reset", ...expected.expected!.event as object });
        expect(h.events).toEqual([event]);
        expect(h.records).toBe(0);
        expect(h.quotas).toBe(0);
        expect(h.context.reference).toEqual(replacement);
        expect(h.context.resetInProgress).toBe(false);
        for (const lease of leases) {
            await expect(h.context.consume(lease, payload)).rejects.toMatchObject({
                rejection: { reason: "clock-unavailable" },
            });
            expect(() => h.context.completeOperation(lease)).toThrow(unavailable());
        }
        expect(h.calls).toHaveLength(0);
    });

    it("preserves independent-store history and never sends local epoch IDs", async () => {
        const h = harness("independent");
        const old = h.context.beginOperation();
        const pendingStore = deferred<StoreOutcome>();
        h.setConsume(() => pendingStore.promise);
        const operation = h.context.consume(old, payload);
        expect(h.calls).toHaveLength(1);
        expect(h.calls[0]).not.toHaveProperty("epoch");
        expect(Object.isFrozen(h.calls[0])).toBe(true);
        h.sample(replacement.wallMs, replacement.monotonicMs);
        const event = await h.context.resetClockReference();
        pendingStore.resolve("accepted");
        await expect(operation).rejects.toMatchObject({
            rejection: { status: "unverified", reason: "clock-unavailable" },
        });
        expect(event.clearedRecords).toBe(0);
        expect(event.clearedQuotaCounters).toBe(0);
        expect(h.clearCalls).toBe(0);
        expect(h.records).toBe(2);
        expect(h.quotas).toBe(1);
        await expect(h.context.consume(old, payload)).rejects.toMatchObject({
            rejection: { reason: "clock-unavailable" },
        });
        expect(h.calls).toHaveLength(1);
    });

    it.each([undefined, "process-clock"] as const)(
        "rejects unsupported reset capability without changing state: %s", async (declaration) => {
            const h = harness(declaration, undefined, false);
            const before = h.context.reference;
            const reads = h.wallReads;
            const lease = h.context.beginOperation();
            const readsAfterBegin = h.wallReads;
            await expect(h.context.resetClockReference()).rejects.toMatchObject({
                code: "reset-unsupported-store",
            });
            expect(h.wallReads).toBe(readsAfterBegin);
            expect(readsAfterBegin).toBeGreaterThan(reads);
            expect(h.context.reference).toBe(before);
            expect(h.context.activeEpoch).toBe(lease.epoch);
            expect(h.context.inFlight).toBe(1);
            expect(h.records).toBe(2);
            expect(h.clearCalls).toBe(0);
            expect(h.events).toHaveLength(1);
            expect(h.events[0]).toMatchObject({ type: "reset", outcome: "reset-unsupported-store" });
        },
    );

    it("rejects a separate concurrent reset once and does not block verification", async () => {
        const h = harness("process-clock");
        const clearing = deferred<MemoryCleanupReport>();
        h.setClear(() => clearing.promise);
        const first = h.context.resetClockReference();
        await Promise.resolve();
        expect(h.context.activeEpoch).toBeNull();
        await expect(h.context.resetClockReference()).rejects.toMatchObject({ code: "reset-in-progress" });
        expect(() => h.context.beginOperation()).toThrow(unavailable());
        expect(h.events.filter((event) => event.type === "reset")).toHaveLength(1);
        clearing.resolve({ clearedRecords: 2, clearedQuotaCounters: 1 });
        await expect(first).resolves.toMatchObject({ outcome: "success" });
        expect(h.events.filter((event) => event.type === "reset")).toHaveLength(2);
        expect(h.context.resetInProgress).toBe(false);
    });

    it("preserves old references and records on invalid reset samples", async () => {
        const h = harness("process-clock");
        const lease = h.context.beginOperation();
        const oldReference = h.context.reference;
        h.sample(NaN, replacement.monotonicMs);
        await expect(h.context.resetClockReference()).rejects.toMatchObject({
            code: "reset-clock-unavailable",
        });
        expect(h.context.reference).toBe(oldReference);
        expect(h.context.activeEpoch).toBe(lease.epoch);
        expect(h.context.inFlight).toBe(1);
        expect(h.records).toBe(2);
        expect(h.clearCalls).toBe(0);
        expect(h.context.resetInProgress).toBe(false);
        expect(h.events).toContainEqual(expect.objectContaining({
            type: "clock-health", healthy: false, reason: "invalid-sample",
        }));
        expect(() => h.context.now(lease)).toThrow(unavailable());
    });

    it("invalidates before partial cleanup failure, reports unknown counts, and retries", async () => {
        const h = harness("process-clock");
        const lease = h.context.beginOperation();
        const oldReference = h.context.reference;
        h.setClear(() => {
            expect(h.context.activeEpoch).toBeNull();
            expect(() => h.context.now(lease)).toThrow(unavailable());
            h.setCounts(1, 1);
            throw "PRIVATE-STORE-MARKER";
        });
        h.sample(replacement.wallMs, replacement.monotonicMs);
        await expect(h.context.resetClockReference()).rejects.toMatchObject({
            code: "reset-failed", details: {},
        });
        expect(h.context.activeEpoch).toBeNull();
        expect(h.context.reference).toBe(oldReference);
        expect(h.context.resetInProgress).toBe(false);
        expect(() => h.context.beginOperation()).toThrow(unavailable());
        expect(h.events.at(-1)).toMatchObject({
            outcome: "reset-failed", newEpoch: null,
            clearedRecords: null, clearedQuotaCounters: null, invalidatedOperations: 1,
        });
        expect(JSON.stringify(h.events)).not.toContain("PRIVATE-STORE-MARKER");
        h.setClear(() => {
            h.setCounts(0, 0);
            return { clearedRecords: 1, clearedQuotaCounters: 1 };
        });
        await expect(h.context.resetClockReference()).resolves.toMatchObject({ outcome: "success" });
        expect(h.context.reference).toEqual(replacement);
        expect(h.context.beginOperation().epoch).toBeGreaterThan(lease.epoch);
        await expect(h.context.consume(lease, payload)).rejects.toMatchObject({
            rejection: { reason: "clock-unavailable" },
        });
        expect(h.calls).toHaveLength(0);
    });
});

describe("context observer integration", () => {
    it.each([new Error("PRIVATE-HOOK-MARKER"), "PRIVATE-HOOK-MARKER", null, undefined, {}])(
        "swallows thrown values and permits subsequent operations %#", async (thrown) => {
            const h = harness("process-clock", () => { throw thrown; });
            await expect(h.context.resetClockReference()).resolves.toMatchObject({ outcome: "success" });
            expect(h.context.observerErrorCount).toBe(1);
            const lease = h.context.beginOperation();
            expect(h.context.completeOperation(lease)).toBe(1800000000);
            expect(h.context.inFlight).toBe(0);
        },
    );

    it("reports committed state and suppresses events for hook-originated reentry", async () => {
        let context!: SecurityContextController;
        let nested!: Promise<void>;
        let callbackCalls = 0;
        const h = harness("process-clock", (event) => {
            callbackCalls++;
            expect(event.type).toBe("reset");
            expect(context.resetInProgress).toBe(false);
            expect(context.activeEpoch).toBe(2);
            expect(h.records).toBe(0);
            expect(() => context.beginOperation()).toThrow(unavailable());
            nested = context.resetClockReference().then(
                () => { throw new Error("Nested reset unexpectedly succeeded"); },
                (error: unknown) => { expect(error).toMatchObject({ code: "reset-in-progress" }); },
            );
        });
        context = h.context;
        await context.resetClockReference();
        await nested;
        expect(callbackCalls).toBe(1);
        expect(h.events).toHaveLength(1);
        expect(context.observerErrorCount).toBe(0);
        expect(() => context.beginOperation()).not.toThrow();
    });

    it("does not carry the observer guard into deferred work", async () => {
        const h = harness("process-clock", () => {
            queueMicrotask(() => {
                try {
                    const lease = h.context.beginOperation();
                    h.context.finishOperation(lease);
                    finished.resolve(true);
                } catch { finished.resolve(false); }
            });
        });
        const finished = deferred<boolean>();
        await h.context.resetClockReference();
        expect(await finished.promise).toBe(true);
    });

    it("delivers only clock health transitions and does not consume while unhealthy", async () => {
        const h = harness("independent");
        const lease = h.context.beginOperation();
        h.sample(reference.wallMs + 30001, reference.monotonicMs);
        await expect(h.context.consume(lease, payload)).rejects.toMatchObject({
            rejection: { reason: "clock-unavailable" },
        });
        expect(() => h.context.now(lease)).toThrow(unavailable());
        expect(h.calls).toHaveLength(0);
        h.sample(reference.wallMs, reference.monotonicMs);
        expect(h.context.now(lease)).toBe(1800000000);
        expect(h.context.now(lease)).toBe(1800000000);
        expect(h.events.map((event) => event.type === "clock-health" ? event.healthy : null))
            .toEqual([false, true]);
    });
});

describe("observer isolation and delayed store failures", () => {
    it("prevents an observer from finishing an active operation", () => {
        const h = harness("independent", () => {
            try { h.context.finishOperation(lease); } catch { /* Expected reentry rejection. */ }
        });
        const lease = h.context.beginOperation();
        h.sample(reference.wallMs + 30001, reference.monotonicMs);
        expect(() => h.context.now(lease)).toThrow(unavailable());
        // An observational hook must not retire an operation or alter reset
        // invalidation counts through the cleanup entry point.
        expect(h.context.inFlight).toBe(1);
        h.sample(reference.wallMs, reference.monotonicMs);
        expect(h.context.now(lease)).toBe(1800000000);
        expect(h.context.inFlight).toBe(1);
        h.context.finishOperation(lease);
        expect(h.context.inFlight).toBe(0);
    });

    it("rejects a stale operation even when its dispatched store call later rejects", async () => {
        const h = harness("independent");
        const lease = h.context.beginOperation();
        const pending = deferred<StoreOutcome>();
        h.setConsume(() => pending.promise);
        const consuming = h.context.consume(lease, payload);
        // Attach the rejection assertion before releasing the deferred backend.
        const assertion = expect(consuming).rejects.toMatchObject({
            rejection: { status: "unverified", reason: "clock-unavailable" },
        });
        await h.context.resetClockReference();
        pending.reject(new Error("PRIVATE-DELAYED-STORE-MARKER"));
        await assertion;
        expect(h.calls).toHaveLength(1);
        expect(h.clearCalls).toBe(0);
        expect(JSON.stringify(h.events)).not.toContain("PRIVATE-DELAYED-STORE-MARKER");
        h.context.finishOperation(lease);
        expect(h.context.inFlight).toBe(0);
    });

    it("preserves failed reset outcome and retry when the reset observer throws", async () => {
        let resetDeliveries = 0;
        const h = harness("process-clock", (event) => {
            if (event.type !== "reset") return;
            resetDeliveries++;
            if (resetDeliveries === 1) throw undefined;
        });
        h.setClear(() => { throw new Error("PRIVATE-CLEANUP-MARKER"); });
        await expect(h.context.resetClockReference()).rejects.toMatchObject({
            code: "reset-failed",
        });
        expect(h.context.resetInProgress).toBe(false);
        expect(h.context.activeEpoch).toBeNull();
        expect(h.context.observerErrorCount).toBe(1);
        expect(() => h.context.beginOperation()).toThrow(unavailable());
        h.setClear(() => {
            h.setCounts(0, 0);
            return { clearedRecords: 2, clearedQuotaCounters: 1 };
        });
        await expect(h.context.resetClockReference()).resolves.toMatchObject({
            outcome: "success",
        });
        expect(resetDeliveries).toBe(2);
        expect(h.context.observerErrorCount).toBe(1);
        const lease = h.context.beginOperation();
        expect(h.context.completeOperation(lease)).toBe(1800000000);
    });
});

describe("reset failure classification follows the execution phase", () => {
    it("does not mistake a cleanup-thrown operator error for invalid clock samples", async () => {
        const { OperatorError } = await import("../src/profiles/operator-errors.js");
        const h = harness("process-clock");
        const lease = h.context.beginOperation();
        const originalReference = h.context.reference;
        h.setClear(() => {
            throw new OperatorError("reset-clock-unavailable");
        });

        await expect(h.context.resetClockReference()).rejects.toMatchObject({
            code: "reset-failed",
        });
        expect(h.context.activeEpoch).toBeNull();
        expect(h.context.reference).toBe(originalReference);
        expect(h.context.resetInProgress).toBe(false);
        expect(h.events.at(-1)).toMatchObject({
            type: "reset", outcome: "reset-failed",
            newEpoch: null, invalidatedOperations: 1,
        });
        expect(h.events).toContainEqual(expect.objectContaining({
            type: "clock-health", healthy: false, reason: "reset-failed",
        }));
        expect(() => h.context.now(lease)).toThrow(unavailable());

        h.setClear(() => ({ clearedRecords: 2, clearedQuotaCounters: 1 }));
        await expect(h.context.resetClockReference()).resolves.toMatchObject({
            outcome: "success",
        });
    });
});

describe("clock health at reset commit after suspended cleanup", () => {
    it.each([
        { name: "wall drift", wallDelta: 30001, monotonicDelta: 0 },
        { name: "invalid wall sample", wallDelta: NaN, monotonicDelta: 0 },
        { name: "monotonic regression", wallDelta: 0, monotonicDelta: -1 },
    ])("does not reopen after $name during cleanup", async ({ wallDelta, monotonicDelta }) => {
        const h = harness("process-clock");
        const lease = h.context.beginOperation();
        const oldReference = h.context.reference;
        const clearing = deferred<MemoryCleanupReport>();
        h.setClear(() => clearing.promise);
        h.sample(replacement.wallMs, replacement.monotonicMs);

        const pending = h.context.resetClockReference();
        const assertion = expect(pending).rejects.toMatchObject({ code: "reset-failed" });
        await Promise.resolve();
        expect(h.context.activeEpoch).toBeNull();
        expect(h.clearCalls).toBe(1);

        h.sample(replacement.wallMs + wallDelta, replacement.monotonicMs + monotonicDelta);
        h.setCounts(0, 0);
        clearing.resolve({ clearedRecords: 2, clearedQuotaCounters: 1 });
        await assertion;

        expect(h.context.reference).toBe(oldReference);
        expect(h.context.activeEpoch).toBeNull();
        expect(h.context.resetInProgress).toBe(false);
        expect(() => h.context.beginOperation()).toThrow(unavailable());
        expect(() => h.context.completeOperation(lease)).toThrow(unavailable());
        expect(h.events.at(-1)).toMatchObject({
            type: "reset", outcome: "reset-failed", newEpoch: null,
            clearedRecords: 2, clearedQuotaCounters: 1, invalidatedOperations: 1,
        });
        expect(h.events.some((event) => event.type === "clock-health" && event.healthy))
            .toBe(false);

        h.sample(replacement.wallMs, replacement.monotonicMs);
        h.setClear(() => ({ clearedRecords: 0, clearedQuotaCounters: 0 }));
        await expect(h.context.resetClockReference()).resolves.toMatchObject({ outcome: "success" });
        expect(() => h.context.now(lease)).toThrow(unavailable());
        const fresh = h.context.beginOperation();
        h.context.finishOperation(fresh);
    });

    it("retains the prepared reference when both clocks advance healthily during cleanup", async () => {
        const h = harness("process-clock");
        const clearing = deferred<MemoryCleanupReport>();
        h.setClear(() => clearing.promise);
        h.sample(replacement.wallMs, replacement.monotonicMs);
        const pending = h.context.resetClockReference();
        await Promise.resolve();

        h.sample(replacement.wallMs + 5000, replacement.monotonicMs + 5000);
        h.setCounts(0, 0);
        clearing.resolve({ clearedRecords: 2, clearedQuotaCounters: 1 });
        await expect(pending).resolves.toMatchObject({ outcome: "success" });
        // The final health check must not silently rebase to its sample.
        expect(h.context.reference).toEqual(replacement);
        const fresh = h.context.beginOperation();
        expect(h.context.completeOperation(fresh)).toBe(
            Math.floor((replacement.wallMs + 5000) / 1000),
        );
    });
});

describe("identity-branded partial memory cleanup accounting", () => {
    it("matches the committed partial-failure event and recovers on retry", async () => {
        const { MemoryCleanupFailure } = await import("../src/profiles/memory-cleanup-failure.js");
        const matrix = JSON.parse(readFileSync(new URL(
            "../../../tests/fixtures/reset/cases.json", import.meta.url,
        ), "utf8")) as {
            cases: (Scenario & {
                firstClear?: { removedRecords: number; removedQuotaCounters: number };
                expectedAfterFailure?: { event: Record<string, unknown> };
            })[];
        };
        const expected = matrix.cases.find((entry) =>
            entry.id === "failed-clear-then-successful-retry")!;
        const h = harness("process-clock");
        while (h.context.activeEpoch! < expected.initial.epoch) {
            await h.context.resetClockReference();
        }
        h.events.length = 0;
        h.setCounts(expected.initial.records, expected.initial.quotaCounters);
        const leases = Array.from({ length: expected.initial.inFlight }, () =>
            h.context.beginOperation());
        const oldReference = h.context.reference;
        const progress = {
            clearedRecords: expected.firstClear!.removedRecords,
            clearedQuotaCounters: expected.firstClear!.removedQuotaCounters,
        };
        const failure = new MemoryCleanupFailure(progress);
        // The error owns a validated snapshot, not the mutable report.
        progress.clearedRecords = 999;
        h.setClear(() => {
            if (h.context.activeEpoch !== null) throw new Error("Epoch was not invalidated");
            h.setCounts(1, 1);
            throw failure;
        });
        h.sample(replacement.wallMs, replacement.monotonicMs);
        await expect(h.context.resetClockReference()).rejects.toMatchObject({
            code: "reset-failed", details: {},
        });
        expect(h.events.at(-1)).toEqual({
            type: "reset", ...expected.expectedAfterFailure!.event,
        });
        expect(h.context.reference).toBe(oldReference);
        expect(h.context.activeEpoch).toBeNull();
        expect(h.context.resetInProgress).toBe(false);
        expect(h.records).toBe(1);
        expect(h.quotas).toBe(1);

        h.setClear(() => {
            h.setCounts(0, 0);
            return { clearedRecords: 1, clearedQuotaCounters: 1 };
        });
        await expect(h.context.resetClockReference()).resolves.toMatchObject({
            outcome: "success", clearedRecords: 1, clearedQuotaCounters: 1,
        });
        for (const lease of leases) {
            await expect(h.context.consume(lease, payload)).rejects.toMatchObject({
                rejection: { reason: "clock-unavailable" },
            });
        }
        expect(h.calls).toHaveLength(0);
        const fresh = h.context.beginOperation();
        h.context.finishOperation(fresh);
    });

    it("does not inspect an arbitrary thrown Proxy or trust a forged prototype", async () => {
        const { MemoryCleanupFailure } = await import("../src/profiles/memory-cleanup-failure.js");
        let accesses = 0;
        const opaque = new Proxy({}, {
            get() { accesses++; throw new Error("PRIVATE-GETTER"); },
            getPrototypeOf() { accesses++; throw new Error("PRIVATE-PROTOTYPE"); },
        });
        const forged: unknown = Object.create(MemoryCleanupFailure.prototype);
        for (const failure of [opaque, forged]) {
            const h = harness("process-clock");
            h.setClear(() => { throw failure; });
            await expect(h.context.resetClockReference()).rejects.toMatchObject({
                code: "reset-failed",
            });
            expect(h.events.at(-1)).toMatchObject({
                outcome: "reset-failed", clearedRecords: null, clearedQuotaCounters: null,
            });
            expect(h.context.activeEpoch).toBeNull();
            expect(h.context.resetInProgress).toBe(false);
        }
        expect(accesses).toBe(0);
    });
});