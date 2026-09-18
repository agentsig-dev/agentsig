import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createOwnedMemoryReplayStore } from "../src/profiles/memory-replay-store.js";
import type { ReplayConsumeInput } from "../src/profiles/replay-store.js";

const policy = JSON.parse(readFileSync(new URL(
    "../../../tests/fixtures/m2/policy-cases.json", import.meta.url,
), "utf8")) as {
    defaults: { capacity: number; maxPerKey: number };
    replayCases: {
        id: string; simultaneousAttempts?: number;
        expectedAccepted?: number; expectedReplayed?: number;
    }[];
};
const key = (name: string) => createHash("sha256").update(name).digest("base64url");
const firstKey = key("memory-test-key-a");
const secondKey = key("memory-test-key-b");
function input(overrides: Partial<ReplayConsumeInput> = {}): ReplayConsumeInput {
    return {
        scope: "merchant", keyThumbprint: firstKey, nonce: "nonce",
        nowEpochSeconds: 1000, retainUntilEpochSeconds: 1330,
        ...overrides,
    };
}

describe("memory replay store — approved atomicity and quota contracts", () => {
    it("accepts once in 100 concurrent attempts and reports 99 replays", async () => {
        const scenario = policy.replayCases.find((entry) =>
            entry.id === "concurrent-identical-valid-request")!;
        const memory = createOwnedMemoryReplayStore();
        const results = await Promise.all(Array.from(
            { length: scenario.simultaneousAttempts! }, () => memory.store.consume(input()),
        ));
        expect(results.filter((value) => value === "accepted")).toHaveLength(scenario.expectedAccepted!);
        expect(results.filter((value) => value === "replayed")).toHaveLength(scenario.expectedReplayed!);
        expect(memory.records).toBe(1);
        expect(memory.quotaCounters).toBe(1);
    });

    it("enforces default capacity without evicting any live entry", async () => {
        const memory = createOwnedMemoryReplayStore();
        expect(memory.policy).toEqual({
            capacity: policy.defaults.capacity, maxPerKey: policy.defaults.maxPerKey,
        });
        for (let index = 0; index < policy.defaults.capacity; index++) {
            expect(await memory.store.consume(input({
                keyThumbprint: key(`key-${Math.floor(index / policy.defaults.maxPerKey)}`),
                nonce: `nonce-${index}`,
            }))).toBe("accepted");
        }
        expect(await memory.store.consume(input({ keyThumbprint: secondKey }))).toBe("unavailable");
        expect(memory.records).toBe(10000);
        expect(memory.quotaCounters).toBe(10);
        expect(await memory.store.consume(input({
            keyThumbprint: key("key-0"), nonce: "nonce-0",
        }))).toBe("replayed");
        expect(memory.records).toBe(10000);
    });

    it("applies the per-key quota across scopes rather than partitioning it", async () => {
        const memory = createOwnedMemoryReplayStore();
        for (let index = 0; index < 1000; index++) {
            expect(await memory.store.consume(input({
                scope: index < 600 ? "scope-a" : "scope-b", nonce: `n-${index}`,
            }))).toBe("accepted");
        }
        expect(await memory.store.consume(input({ scope: "scope-c" })))
            .toBe("per-key-quota-exceeded");
        expect(await memory.store.consume(input({ keyThumbprint: secondKey }))).toBe("accepted");
        expect(memory.records).toBe(1001);
        expect(memory.quotaCounters).toBe(2);
    });

    it("checks replay before quota, and quota before global capacity", async () => {
        const memory = createOwnedMemoryReplayStore({ capacity: 1, maxPerKey: 1 });
        expect(await memory.store.consume(input())).toBe("accepted");
        expect(await memory.store.consume(input())).toBe("replayed");
        expect(await memory.store.consume(input({ nonce: "different" }))).toBe("per-key-quota-exceeded");
        expect(await memory.store.consume(input({ keyThumbprint: secondKey }))).toBe("unavailable");
        expect(memory.records).toBe(1);
    });

    it("handles explicit zero capacity and quota without an unlimited mode", async () => {
        expect(await createOwnedMemoryReplayStore({ capacity: 0 }).store.consume(input()))
            .toBe("unavailable");
        expect(await createOwnedMemoryReplayStore({ maxPerKey: 0 }).store.consume(input()))
            .toBe("per-key-quota-exceeded");
        expect(await createOwnedMemoryReplayStore({ capacity: 0, maxPerKey: 0 }).store.consume(input()))
            .toBe("per-key-quota-exceeded");
    });
});

describe("expiry, key encoding and reset ownership", () => {
    it("expires at the exact deadline before replay and quota checks", async () => {
        const memory = createOwnedMemoryReplayStore({ capacity: 1, maxPerKey: 1 });
        expect(await memory.store.consume(input())).toBe("accepted");
        expect(await memory.store.consume(input({ nowEpochSeconds: 1329, retainUntilEpochSeconds: 1500 })))
            .toBe("replayed");
        expect(await memory.store.consume(input({ nowEpochSeconds: 1330, retainUntilEpochSeconds: 1500 })))
            .toBe("accepted");
        expect(memory.records).toBe(1);
        expect(memory.quotaCounters).toBe(1);
    });

    it("does not shorten or extend a live record on replay", async () => {
        const memory = createOwnedMemoryReplayStore();
        await memory.store.consume(input());
        expect(await memory.store.consume(input({ retainUntilEpochSeconds: 1001 }))).toBe("replayed");
        expect(await memory.store.consume(input({ nowEpochSeconds: 1002, retainUntilEpochSeconds: 2000 })))
            .toBe("replayed");
        expect(await memory.store.consume(input({ nowEpochSeconds: 1330, retainUntilEpochSeconds: 2000 })))
            .toBe("accepted");
    });

    it("expires out-of-order deadlines and removes unused per-key counters", async () => {
        const memory = createOwnedMemoryReplayStore({ capacity: 2, maxPerKey: 1 });
        await memory.store.consume(input({ retainUntilEpochSeconds: 1500 }));
        await memory.store.consume(input({ keyThumbprint: secondKey, retainUntilEpochSeconds: 1100 }));
        expect(await memory.store.consume(input({
            keyThumbprint: key("third"), nowEpochSeconds: 1100, retainUntilEpochSeconds: 1600,
        }))).toBe("accepted");
        expect(memory.records).toBe(2);
        expect(memory.quotaCounters).toBe(2);
        expect(await memory.store.consume(input({ nowEpochSeconds: 1100, retainUntilEpochSeconds: 1600 })))
            .toBe("replayed");
    });

    it("preserves exact tuple identity including separator-like characters", async () => {
        const memory = createOwnedMemoryReplayStore();
        const tuples = [
            { scope: "a", nonce: "b:c" }, { scope: "a:b", nonce: "c" },
            { scope: 'a"\\', nonce: " " }, { scope: "a\u0000", nonce: '"\\' },
            { scope: "a", nonce: "n" }, { scope: "a", nonce: "n", keyThumbprint: secondKey },
        ];
        for (const tuple of tuples) expect(await memory.store.consume(input(tuple))).toBe("accepted");
        for (const tuple of tuples) expect(await memory.store.consume(input(tuple))).toBe("replayed");
        expect(memory.records).toBe(tuples.length);
    });

    it("retains physical counts without timers or implicit expiry", async () => {
        const memory = createOwnedMemoryReplayStore();
        await memory.store.consume(input({ nowEpochSeconds: 0, retainUntilEpochSeconds: 1 }));
        await Promise.resolve();
        expect(memory.records).toBe(1);
        expect(memory.quotaCounters).toBe(1);
        expect(memory.store.retentionClock).toBe("process-clock");
        expect(memory.store).not.toHaveProperty("clearForClockReset");
    });

    it("clears records, quota counters and time high-water together on explicit reset", async () => {
        const memory = createOwnedMemoryReplayStore();
        await memory.store.consume(input());
        await memory.store.consume(input({ keyThumbprint: secondKey }));
        expect(await memory.resetPort.clearForClockReset()).toEqual({
            clearedRecords: 2, clearedQuotaCounters: 2,
        });
        expect(memory.records).toBe(0);
        expect(memory.quotaCounters).toBe(0);
        expect(await memory.store.consume(input({ nowEpochSeconds: 0, retainUntilEpochSeconds: 1 })))
            .toBe("accepted");
        expect(Object.isFrozen(memory)).toBe(true);
        expect(Object.isFrozen(memory.store)).toBe(true);
        expect(Object.isFrozen(memory.resetPort)).toBe(true);
    });
});

describe("invalid input must not expire existing records", () => {
    it.each([
        { scope: "" }, { scope: "a".repeat(257) }, { scope: "ü" },
        { nonce: "" }, { nonce: "\n" }, { nonce: "a".repeat(257) },
        { keyThumbprint: "arbitrary-label" }, { keyThumbprint: firstKey.slice(0, -1) + "B" },
        { nowEpochSeconds: NaN }, { nowEpochSeconds: 0.5 },
        { retainUntilEpochSeconds: Infinity }, { retainUntilEpochSeconds: 2000 },
    ])("rejects invalid fields without mutating live history %#", async (override) => {
        const memory = createOwnedMemoryReplayStore();
        await memory.store.consume(input());
        expect(await memory.store.consume(input({
            nowEpochSeconds: 2000, retainUntilEpochSeconds: 2500, ...override,
        }))).toBe("unavailable");
        expect(memory.records).toBe(1);
        expect(memory.quotaCounters).toBe(1);
        expect(await memory.store.consume(input())).toBe("replayed");
    });

    it("rejects regressing dispatch time without expiry or insertion", async () => {
        const memory = createOwnedMemoryReplayStore();
        await memory.store.consume(input());
        expect(await memory.store.consume(input({ nonce: "second", nowEpochSeconds: 999 })))
            .toBe("unavailable");
        expect(memory.records).toBe(1);
        expect(await memory.store.consume(input())).toBe("replayed");
    });

    it("does not execute input accessors", async () => {
        const memory = createOwnedMemoryReplayStore();
        let reads = 0;
        const value = Object.defineProperty(input(), "nonce", {
            get() { reads++; return "nonce"; },
        });
        expect(await memory.store.consume(value)).toBe("unavailable");
        expect(reads).toBe(0);
        expect(memory.records).toBe(0);
    });
});