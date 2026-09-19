import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveRedisReplayConfiguration } from "../src/redis/configuration.js";
import { assertRedisEvictionPolicy, runRedisCommand } from "../src/redis/command.js";
import type { RedisCommandClient, RedisReplayStoreOptions } from "../src/redis/types.js";

const fixture = JSON.parse(readFileSync(new URL(
    "../../../tests/fixtures/m3-contract/recovery-cases.json", import.meta.url,
), "utf8")) as {
    configurationCases: {
        id: string; input: Record<string, unknown>; expectedConfigurationCode: string;
    }[];
    evictionAdmissionCases: {
        id: string; configGet: string; acknowledgeEvictionPolicy?: "noeviction";
        connectionAdmitted: boolean;
    }[];
};

function harness() {
    const send = vi.fn<RedisCommandClient["sendCommand"]>(
        async () => ["maxmemory-policy", "noeviction"],
    );
    const client: RedisCommandClient = {
        automaticRetries: false, offlineQueue: false, isReady: true, sendCommand: send,
    };
    const options: RedisReplayStoreOptions = {
        client, namespace: "redis-admission-tests", recoveryHorizonSeconds: 360,
    };
    return { send, client, options };
}

afterEach(() => vi.useRealTimers());

// Controlled client tests only. Actual Redis admission and replay must also
// pass the dedicated real-service integration suite.
describe("Redis configuration before command dispatch", () => {
    for (const row of fixture.configurationCases) {
        it(row.id, () => {
            const h = harness();
            expect(() => resolveRedisReplayConfiguration({
                client: h.client, namespace: "tests", ...row.input,
            } as unknown as RedisReplayStoreOptions)).toThrow(
                expect.objectContaining({ code: row.expectedConfigurationCode }),
            );
            expect(h.send).not.toHaveBeenCalled();
        });
    }

    it("rejects millisecond overflow before contacting Redis", () => {
        const h = harness();
        expect(() => resolveRedisReplayConfiguration({
            ...h.options, recoveryHorizonSeconds: Number.MAX_SAFE_INTEGER,
        })).toThrow(expect.objectContaining({ code: "invalid-replay-policy" }));
        expect(h.send).not.toHaveBeenCalled();
    });

    it("does not execute ordinary option accessors", () => {
        const h = harness();
        let reads = 0;
        Object.defineProperty(h.options, "recoveryHorizonSeconds", {
            get() { reads++; return 360; },
        });
        expect(() => resolveRedisReplayConfiguration(h.options))
            .toThrow(expect.objectContaining({ code: "invalid-replay-policy" }));
        expect(reads).toBe(0);
        expect(h.send).not.toHaveBeenCalled();
    });

    it.each(["automaticRetries", "offlineQueue"] as const)(
        "requires explicit disabled %s", (field) => {
            const h = harness();
            expect(() => resolveRedisReplayConfiguration({
                ...h.options, client: { ...h.client, [field]: true } as unknown as RedisCommandClient,
            })).toThrow(expect.objectContaining({ code: "invalid-replay-policy" }));
            expect(h.send).not.toHaveBeenCalled();
        },
    );

    it("uses injective namespace encoding and one Cluster hash tag", () => {
        const h = harness();
        const a = resolveRedisReplayConfiguration({ ...h.options, namespace: "a{b}:c" });
        const b = resolveRedisReplayConfiguration({ ...h.options, namespace: "a:b{c}" });
        expect(a.keyPrefix).not.toBe(b.keyPrefix);
        expect(a.keyPrefix).toMatch(/^agentsig:replay:\{[0-9a-f]+\}:$/);
        expect(a.recoveryMilliseconds).toBe(360000);
        expect(Object.isFrozen(a)).toBe(true);
    });
});

describe("eviction-policy admission against pinned decisions", () => {
    for (const row of fixture.evictionAdmissionCases) {
        it(row.id, async () => {
            const h = harness();
            if (row.configGet === "permission-denied") {
                h.send.mockRejectedValue(new Error("NOPERM this user has no permissions"));
            } else if (row.configGet === "network-error") {
                h.send.mockRejectedValue(new Error("ECONNRESET"));
            } else {
                h.send.mockResolvedValue(["maxmemory-policy", row.configGet]);
            }
            const configuration = resolveRedisReplayConfiguration({
                ...h.options,
                ...(row.acknowledgeEvictionPolicy === undefined ? {} : {
                    acknowledgeEvictionPolicy: row.acknowledgeEvictionPolicy,
                }),
            });
            const result = assertRedisEvictionPolicy(configuration);
            if (row.connectionAdmitted) await expect(result).resolves.toBeUndefined();
            else await expect(result).rejects.toMatchObject({ code: "invalid-replay-policy" });
            expect(h.send).toHaveBeenCalledExactlyOnceWith(["CONFIG", "GET", "maxmemory-policy"]);
        });
    }

    it.each([
        "NOAUTH Authentication required",
        "OOM command not allowed",
        "ERR arbitrary failure",
        "connection failed: NOPERM",
    ])("cannot acknowledge unrelated failure: %s", async (message) => {
        const h = harness();
        h.send.mockRejectedValue(new Error(message));
        await expect(assertRedisEvictionPolicy(resolveRedisReplayConfiguration({
            ...h.options, acknowledgeEvictionPolicy: "noeviction",
        }))).rejects.toMatchObject({ code: "invalid-replay-policy" });
    });

    it.each([
        "ERR unknown command 'CONFIG', with args beginning with: 'GET'",
        "ERR unknown subcommand 'GET'. Try CONFIG HELP.",
    ])("allows explicit acknowledgement for capability failure: %s", async (message) => {
        const h = harness();
        h.send.mockRejectedValue(new Error(message));
        await expect(assertRedisEvictionPolicy(resolveRedisReplayConfiguration({
            ...h.options, acknowledgeEvictionPolicy: "noeviction",
        }))).resolves.toBeUndefined();
    });
});

describe("bounded commands without retries or offline queueing", () => {
    it("never dispatches to an offline client", async () => {
        const h = harness();
        const configuration = resolveRedisReplayConfiguration({
            ...h.options, client: { ...h.client, isReady: false },
        });
        expect(await runRedisCommand(configuration, ["PING"])).toEqual({ outcome: "unavailable" });
        expect(h.send).not.toHaveBeenCalled();
    });

    it("returns unavailable at 100 ms and ignores a later successful write reply", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
        const h = harness();
        let release!: (value: unknown) => void;
        h.send.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
        const operation = runRedisCommand(resolveRedisReplayConfiguration(h.options), ["EVAL", "test"]);
        await vi.advanceTimersByTimeAsync(99);
        expect(h.send).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(await operation).toEqual({ outcome: "unavailable" });
        release("accepted");
        await vi.advanceTimersByTimeAsync(0);
        expect(await operation).toEqual({ outcome: "unavailable" });
        expect(h.send).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });
});