import { describe, expect, it } from "vitest";
import { createOwnedMemoryReplayStore } from "../src/profiles/memory-replay-store.js";
import { createSecurityContextController } from "../src/profiles/security-context-controller.js";
import type { SecurityContextEvent } from "../src/profiles/context-events.js";

const keyThumbprint = "DR68nui99ukl-GUgfzQGaU3VwqRtArw-_DCN4LFtY84";
const input = {
    scope: "merchant",
    keyThumbprint,
    nonce: "memory-context-nonce",
    retainUntilEpochSeconds: 1330,
};
const unavailable = {
    rejection: { status: "unverified", reason: "clock-unavailable" },
};

function setup() {
    let wall = 1_000_000;
    let monotonic = 0;
    const memory = createOwnedMemoryReplayStore({ capacity: 2, maxPerKey: 1 });
    const events: Readonly<SecurityContextEvent>[] = [];
    const context = createSecurityContextController({
        store: memory.store,
        memoryReset: memory.resetPort,
        wallClock: () => wall,
        monotonicClock: () => monotonic,
        observer: (event) => { events.push(event); },
    });
    return {
        memory, context, events,
        sample(wallMs: number, monotonicMs: number) {
            wall = wallMs;
            monotonic = monotonicMs;
        },
    };
}

describe("real memory store with shared clock and epoch controller", () => {
    it("does not consume or expire records while clock health fails", async () => {
        const h = setup();
        const lease = h.context.beginOperation();
        expect(await h.context.consume(lease, input)).toBe("accepted");
        // Effective time has passed the record deadline, but wall drift is
        // unhealthy. A forbidden store call would expire the old record here.
        h.sample(1_400_001, 370_000);
        await expect(h.context.consume(lease, {
            ...input, nonce: "second", retainUntilEpochSeconds: 1700,
        })).rejects.toMatchObject(unavailable);
        expect(h.memory.records).toBe(1);
        expect(h.memory.quotaCounters).toBe(1);

        h.sample(1_370_000, 370_000);
        expect(await h.context.consume(lease, {
            ...input, nonce: "second", retainUntilEpochSeconds: 1700,
        })).toBe("accepted");
        expect(h.memory.records).toBe(1);
        expect(h.memory.quotaCounters).toBe(1);
        expect(h.events.filter((event) => event.type === "clock-health")
            .map((event) => event.healthy)).toEqual([false, true]);
        h.context.finishOperation(lease);
    });

    it("clears real records and quotas on healthy reset and reopens replay acceptance", async () => {
        const h = setup();
        const old = h.context.beginOperation();
        expect(await h.context.consume(old, input)).toBe("accepted");
        expect(await h.context.consume(old, input)).toBe("replayed");

        const event = await h.context.resetClockReference();
        expect(event).toMatchObject({
            outcome: "success", oldEpoch: old.epoch, newEpoch: old.epoch + 1,
            clearedRecords: 1, clearedQuotaCounters: 1, invalidatedOperations: 1,
        });
        expect(h.memory.records).toBe(0);
        expect(h.memory.quotaCounters).toBe(0);
        await expect(h.context.consume(old, input)).rejects.toMatchObject(unavailable);
        expect(h.memory.records).toBe(0);

        const fresh = h.context.beginOperation();
        // Explicitly demonstrate the approved destructive reset discontinuity.
        expect(await h.context.consume(fresh, input)).toBe("accepted");
        h.context.finishOperation(old);
        expect(h.context.inFlight).toBe(1);
        h.context.finishOperation(fresh);
    });

    it("rejects old completion when reset starts after atomic insertion but before return", async () => {
        const h = setup();
        const old = h.context.beginOperation();
        const consuming = h.context.consume(old, input);
        // The backend insertion is synchronous, although its interface returns
        // a Promise. The coordinator has not completed its post-await checks.
        expect(h.memory.records).toBe(1);
        const assertion = expect(consuming).rejects.toMatchObject(unavailable);
        const resetting = h.context.resetClockReference();
        await assertion;
        await resetting;
        expect(h.memory.records).toBe(0);
        expect(h.memory.quotaCounters).toBe(0);
        expect(() => h.context.completeOperation(old))
            .toThrow(expect.objectContaining(unavailable));
        h.context.finishOperation(old);
    });

    it("restores memory time bookkeeping after an explicit backward clock reset", async () => {
        const h = setup();
        const old = h.context.beginOperation();
        expect(await h.context.consume(old, input)).toBe("accepted");
        h.sample(500_000, 1000);
        expect(() => h.context.now(old)).toThrow(expect.objectContaining(unavailable));
        await h.context.resetClockReference("health");
        const fresh = h.context.beginOperation();
        expect(h.context.now(fresh)).toBe(500);
        expect(await h.context.consume(fresh, {
            ...input, retainUntilEpochSeconds: 830,
        })).toBe("accepted");
        h.context.finishOperation(fresh);
    });

    it("admits one of 100 concurrent operations through the real controller", async () => {
        const h = setup();
        const results = await Promise.all(Array.from({ length: 100 }, async () => {
            const lease = h.context.beginOperation();
            try {
                return await h.context.consume(lease, input);
            } finally {
                h.context.finishOperation(lease);
            }
        }));
        expect(results.filter((value) => value === "accepted")).toHaveLength(1);
        expect(results.filter((value) => value === "replayed")).toHaveLength(99);
        expect(h.context.inFlight).toBe(0);
        expect(h.memory.records).toBe(1);
        expect(h.memory.quotaCounters).toBe(1);
    });
});