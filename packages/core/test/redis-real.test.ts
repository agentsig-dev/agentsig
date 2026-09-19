import { randomBytes } from "node:crypto";
import { execFile, fork } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, describe, expect, it } from "vitest";
import { createRedisReplayStore } from "../src/redis/replay-store.js";
import { resolveRedisReplayConfiguration } from "../src/redis/configuration.js";
import { REDIS_REPLAY_SCRIPT } from "../src/redis/replay-script.js";
import { prepareRedisConsume } from "../src/redis/consume-input.js";
import type { RedisCommandClient, RedisReplayStoreOptions } from "../src/redis/types.js";
import type { ReplayConsumeInput } from "../src/profiles/replay-store.js";
import { connectRedisTestClient, createRedisTestClient } from "./redis-test-client.js";

const suppliedPort = process.env.AGENTSIG_TEST_REDIS_PORT;
const port = Number(suppliedPort);
if (suppliedPort !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error("AGENTSIG_TEST_REDIS_PORT must be an explicit dedicated Redis test port");
}
const client = createRedisTestClient(port);
const namespaces: string[] = [];
const base: ReplayConsumeInput = {
    scope: "merchant-a",
    keyThumbprint: "DR68nui99ukl-GUgfzQGaU3VwqRtArw-_DCN4LFtY84",
    nonce: "real-redis-nonce",
    nowEpochSeconds: 1800000000,
    retainUntilEpochSeconds: 1800000330,
};
function options(overrides: Partial<RedisReplayStoreOptions> = {}): RedisReplayStoreOptions {
    const namespace = `agentsig-integration-${randomBytes(12).toString("hex")}`;
    namespaces.push(namespace);
    return { client, namespace, recoveryHorizonSeconds: 1, ...overrides };
}
function keys(config: RedisReplayStoreOptions): string[] {
    const prefix = resolveRedisReplayConfiguration(config).keyPrefix;
    return [`${prefix}epoch`, `${prefix}quarantine-until`, `${prefix}state`];
}
async function state(config: RedisReplayStoreOptions) {
    const encoded = await client.sendCommand(["GET", keys(config)[2]!]);
    if (typeof encoded !== "string") throw new Error("Expected Redis state document");
    return JSON.parse(encoded) as {
        version: string; epoch: string; quarantineUntil: string; detectedAt: string;
        lastTime: string; horizon: string; capacity: string; quota: string;
        records: { identity: string; thumbprint: string; deadline: string }[];
    };
}
async function ready(config: RedisReplayStoreOptions) {
    const store = await createRedisReplayStore(config);
    // Real server-time passage; no adapter readiness bypass or production clock override.
    await delay(config.recoveryHorizonSeconds * 1000 + 80);
    return store;
}

afterAll(async () => {
    if (suppliedPort === undefined) return;
    for (const namespace of namespaces) {
        const config = { client, namespace, recoveryHorizonSeconds: 1 };
        await client.sendCommand(["DEL", ...keys(config)]);
    }
});

// Ordinary unit runs explicitly skip this suite. The dedicated CI job requires
// the environment variable and executes this file against its real service.
describe.skipIf(suppliedPort === undefined)("real Redis atomic replay and recovery", () => {
    it("uses the actual Redis service with noeviction", async () => {
        expect(await client.sendCommand(["PING"])).toBe("PONG");
        expect(await client.sendCommand(["CONFIG", "GET", "maxmemory-policy"]))
            .toEqual(["maxmemory-policy", "noeviction"]);
    });

    it("initializes shared quarantine and does not restart it on instance recreation", async () => {
        const config = options();
        const first = await createRedisReplayStore(config);
        const initial = await state(config);
        expect(Number(initial.quarantineUntil) - Number(initial.detectedAt)).toBe(1000);
        expect(await first.consume(base)).toBe("unavailable");
        const second = await createRedisReplayStore(config);
        expect(await state(config)).toEqual(initial);
        expect(await second.consume(base)).toBe("unavailable");
        await delay(1080);
        expect(await second.consume(base)).toBe("accepted");
        expect(await first.consume(base)).toBe("replayed");
    });

    it("accepts one of 100 concurrent consumes and records exactly one tuple", async () => {
        const connected = await connectRedisTestClient(port);
        try {
            const config = options({ client: connected });
            const store = await ready(config);
            const started = performance.now();
            const results = await Promise.all(Array.from({ length: 100 }, () => store.consume(base)));
            const elapsedMilliseconds = performance.now() - started;
            // Diagnostic counts only: distinguish committed Redis history from
            // replies lost to the adapter deadline without exposing tuple contents.
            const summary = {
                accepted: results.filter((value) => value === "accepted").length,
                replayed: results.filter((value) => value === "replayed").length,
                unavailable: results.filter((value) => value === "unavailable").length,
                quotaRejected: results.filter((value) => value === "per-key-quota-exceeded").length,
                records: (await state(config)).records.length,
            };
            console.info("Redis concurrent consume diagnostic", { ...summary, elapsedMilliseconds });
            expect(summary).toEqual({
                accepted: 1, replayed: 99, unavailable: 0, quotaRejected: 0, records: 1,
            });
        } finally {
            connected.close();
        }
    });

    it("preserves replay deadlines and checks replay before quotas", async () => {
        const config = options({ capacity: 1, maxPerKey: 1 });
        const store = await ready(config);
        expect(await store.consume(base)).toBe("accepted");
        const original = await state(config);
        expect(await store.consume({ ...base, retainUntilEpochSeconds: base.retainUntilEpochSeconds + 600 }))
            .toBe("replayed");
        expect(await state(config)).toEqual(original);
        expect(await store.consume({ ...base, nonce: "second", scope: "merchant-b" }))
            .toBe("per-key-quota-exceeded");
        expect(await store.consume({
            ...base, keyThumbprint: "poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U",
        })).toBe("unavailable");
        expect(await state(config)).toEqual(original);
    });

    it("expires records using Redis execution time and releases quota", async () => {
        const config = options({ capacity: 1, maxPerKey: 1 });
        const store = await ready(config);
        const short = { ...base, retainUntilEpochSeconds: base.nowEpochSeconds + 1 };
        expect(await store.consume(short)).toBe("accepted");
        const original = await state(config);
        expect(Number(original.records[0]!.deadline) - Number(original.lastTime)).toBe(1000);
        expect(await store.consume({ ...short, nonce: "next" })).toBe("per-key-quota-exceeded");
        await delay(1080);
        expect(await store.consume({ ...short, nonce: "next" })).toBe("accepted");
        expect((await state(config)).records).toHaveLength(1);
    });

    it.each([0, 1, 2])("missing recovery/state key %s starts new shared quarantine", async (index) => {
        const config = options();
        const store = await ready(config);
        expect(await store.consume(base)).toBe("accepted");
        const original = await state(config);
        await client.sendCommand(["DEL", keys(config)[index]!]);
        expect(await store.consume({ ...base, nonce: "after-loss" })).toBe("unavailable");
        const recovered = await state(config);
        expect(recovered.epoch).not.toBe(original.epoch);
        expect(Number(recovered.quarantineUntil) - Number(recovered.detectedAt)).toBe(1000);
        const restarted = await createRedisReplayStore(config);
        expect(await state(config)).toEqual(recovered);
        expect(await restarted.consume(base)).toBe("unavailable");
    });

    it("rejects a conflicting shared horizon or quota without rewriting recovery state", async () => {
        const config = options();
        await createRedisReplayStore(config);
        const original = await state(config);
        await expect(createRedisReplayStore({ ...config, recoveryHorizonSeconds: 2 }))
            .rejects.toMatchObject({ code: "invalid-replay-policy" });
        await expect(createRedisReplayStore({ ...config, capacity: 2 }))
            .rejects.toMatchObject({ code: "invalid-replay-policy" });
        expect(await state(config)).toEqual(original);
    });

    it("handles a lost reply after a real committed write without retry or fallback", async () => {
        const config = options();
        await ready(config);
        let dropped = false;
        const lossy: RedisCommandClient = {
            automaticRetries: false, offlineQueue: false, isReady: true,
            async sendCommand(args) {
                const result = await client.sendCommand(args);
                if (args[0] === "EVAL" && args[6] === "consume" && !dropped) {
                    dropped = true;
                    throw new Error("Simulated reply loss AFTER real Redis completion");
                }
                return result;
            },
        };
        const store = await createRedisReplayStore({ ...config, client: lossy });
        expect(await store.consume(base)).toBe("unavailable");
        expect(dropped).toBe(true);
        expect((await state(config)).records).toHaveLength(1);
        expect(await store.consume(base)).toBe("replayed");
    });

    it("requires acknowledgement when real Redis ACL denies CONFIG", async () => {
        const username = `agentsig-${randomBytes(8).toString("hex")}`;
        const password = randomBytes(16).toString("hex");
        await client.sendCommand(["ACL", "SETUSER", username, "on", `>${password}`, "~*", "+@all", "-config"]);
        try {
            const restricted = createRedisTestClient(port, { username, password });
            const config = options({ client: restricted });
            await expect(createRedisReplayStore(config))
                .rejects.toMatchObject({ code: "invalid-replay-policy" });
            const store = await createRedisReplayStore({
                ...config, acknowledgeEvictionPolicy: "noeviction",
            });
            expect(await store.consume(base)).toBe("unavailable"); // Initial shared quarantine.
        } finally {
            await client.sendCommand(["ACL", "DELUSER", username]);
        }
    });

    it("does not let acknowledgement override an actual conflicting server policy", async () => {
        // Dedicated test service only; restore its global policy even on failure.
        await client.sendCommand(["CONFIG", "SET", "maxmemory-policy", "allkeys-lru"]);
        try {
            await expect(createRedisReplayStore(options({
                acknowledgeEvictionPolicy: "noeviction",
            }))).rejects.toMatchObject({ code: "invalid-replay-policy" });
        } finally {
            await client.sendCommand(["CONFIG", "SET", "maxmemory-policy", "noeviction"]);
        }
    });
});

describe.skipIf(suppliedPort === undefined)("real Redis across independent Node processes", () => {
    it("admits one of 100 identical consumes across four processes", async () => {
        const directory = await mkdtemp(join(tmpdir(), "agentsig-redis-workers-"));
        const workers: {
            child: ReturnType<typeof fork>;
            ready: Promise<number>;
            results: Promise<{ pid: number; results: string[] }>;
            exited: Promise<number | null>;
        }[] = [];
        try {
            // Use the installed CLI without importing its optional declaration
            // dependencies into the strict core TypeScript compilation.
            const require = createRequire(import.meta.url);
            // Anchor the CLI explicitly and use a relative entry. On Windows,
            // Node 20/CLI path normalization can otherwise combine a drive-
            // qualified entry with a relative prefix into an invalid path.
            const workerDirectory = dirname(fileURLToPath(import.meta.url));
            await promisify(execFile)(process.execPath, [
                require.resolve("tsup/dist/cli-default.js"),
                "./redis-process-worker.ts",
                "--format", "cjs", "--platform", "node", "--target", "node20",
                "--out-dir", directory, "--no-config", "--silent",
            ], { cwd: workerDirectory, timeout: 15000, maxBuffer: 1048576 });
            // tsup's extension inference differs with package/cwd discovery.
            // The requested output is CommonJS in both cases; explicitly name
            // it .cjs so Node never infers ESM from an enclosing package.
            const outputs = await readdir(directory);
            const emitted = outputs.filter((name) =>
                name === "redis-process-worker.js" || name === "redis-process-worker.cjs");
            expect(emitted).toHaveLength(1);
            if (emitted[0] === "redis-process-worker.js") {
                await rename(join(directory, emitted[0]), join(directory, "redis-process-worker.cjs"));
            }
            const config = options();
            await ready(config);
            for (let index = 0; index < 4; index++) {
                const child = fork(join(directory, "redis-process-worker.cjs"), [], {
                    execPath: process.execPath,
                    execArgv: [],
                    env: {
                        ...process.env,
                        AGENTSIG_TEST_REDIS_PORT: String(port),
                        AGENTSIG_TEST_REDIS_NAMESPACE: config.namespace,
                    },
                    stdio: ["ignore", "ignore", "ignore", "ipc"],
                });
                let readyResolve!: (pid: number) => void;
                let readyReject!: (error: Error) => void;
                let resultsResolve!: (value: { pid: number; results: string[] }) => void;
                let resultsReject!: (error: Error) => void;
                const initialized = new Promise<number>((resolve, reject) => {
                    readyResolve = resolve; readyReject = reject;
                });
                const results = new Promise<{ pid: number; results: string[] }>((resolve, reject) => {
                    resultsResolve = resolve; resultsReject = reject;
                });
                // Handle rejection immediately even while other children start.
                void initialized.catch(() => { });
                void results.catch(() => { });
                let hasReady = false;
                let hasResults = false;
                const fail = () => {
                    const error = new Error("Redis integration child failed");
                    if (!hasReady) readyReject(error);
                    if (!hasResults) resultsReject(error);
                };
                const watchdog = setTimeout(() => {
                    fail();
                    child.kill();
                }, 15000);
                child.on("error", fail);
                child.on("message", (message: unknown) => {
                    if (!message || typeof message !== "object") { fail(); return; }
                    const value = message as { type?: unknown; pid?: unknown; results?: unknown };
                    if (value.pid !== child.pid) { fail(); return; }
                    if (value.type === "ready" && !hasReady) {
                        hasReady = true;
                        readyResolve(child.pid!);
                    } else if (value.type === "results" && hasReady && !hasResults &&
                        Array.isArray(value.results) && value.results.length === 25 &&
                        value.results.every((item: unknown) => typeof item === "string" &&
                            ["accepted", "replayed", "unavailable", "per-key-quota-exceeded"].includes(item))) {
                        hasResults = true;
                        resultsResolve({ pid: child.pid!, results: value.results as string[] });
                    } else {
                        fail();
                    }
                });
                const exited = new Promise<number | null>((resolve) => {
                    child.once("exit", (code) => {
                        clearTimeout(watchdog);
                        if (code !== 0 || !hasReady || !hasResults) fail();
                        resolve(code);
                    });
                    child.once("error", () => {
                        clearTimeout(watchdog);
                        resolve(null);
                    });
                });
                workers.push({ child, ready: initialized, results, exited });
            }
            const pids = await Promise.all(workers.map((worker) => worker.ready));
            expect(new Set(pids).size).toBe(4);
            expect(pids).not.toContain(process.pid);
            for (const worker of workers) worker.child.send("consume");
            const reports = await Promise.all(workers.map((worker) => worker.results));
            const outcomes = reports.flatMap((report) => report.results);
            expect(outcomes).toHaveLength(100);
            expect(outcomes.filter((value) => value === "accepted")).toHaveLength(1);
            expect(outcomes.filter((value) => value === "replayed")).toHaveLength(99);
            expect((await state(config)).records).toHaveLength(1);
            expect(await Promise.all(workers.map((worker) => worker.exited))).toEqual([0, 0, 0, 0]);
        } finally {
            for (const worker of workers) {
                if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill();
            }
            await Promise.all(workers.map((worker) => worker.exited));
            await rm(directory, { recursive: true, force: true });
        }
    }, 25000);
});

describe.skipIf(suppliedPort === undefined)("real Redis recovery-state integrity", () => {
    it.each(["invalid-json", "wrong-type", "epoch-mismatch", "deadline-mismatch", "invalid-record"] as const)(
        "starts quarantine instead of inferring readiness from %s", async (corruption) => {
            const config = options();
            const store = await ready(config);
            expect(await store.consume(base)).toBe("accepted");
            const previous = await state(config);
            const [epochKey, untilKey, stateKey] = keys(config) as [string, string, string];
            if (corruption === "invalid-json") {
                await client.sendCommand(["SET", stateKey, "{"]);
            } else if (corruption === "wrong-type") {
                await client.sendCommand(["DEL", stateKey]);
                await client.sendCommand(["LPUSH", stateKey, "not-a-state-document"]);
            } else if (corruption === "epoch-mismatch") {
                await client.sendCommand(["SET", epochKey, "0".repeat(32)]);
            } else if (corruption === "deadline-mismatch") {
                await client.sendCommand(["SET", untilKey, String(Number(previous.quarantineUntil) + 1)]);
            } else {
                previous.records[0]!.deadline = "not-an-integer";
                await client.sendCommand(["SET", stateKey, JSON.stringify(previous)]);
            }
            expect(await store.consume({ ...base, nonce: "after-corruption" })).toBe("unavailable");
            const recovered = await state(config);
            expect(recovered.epoch).not.toBe(previous.epoch);
            expect(Number(recovered.quarantineUntil) - Number(recovered.detectedAt)).toBe(1000);
            expect(Object.keys(recovered.records)).toHaveLength(0);
            expect(await client.sendCommand(["GET", epochKey])).toBe(recovered.epoch);
            expect(await client.sendCommand(["GET", untilKey])).toBe(recovered.quarantineUntil);
            const restarted = await createRedisReplayStore(config);
            expect(await state(config)).toEqual(recovered);
            expect(await restarted.consume(base)).toBe("unavailable");
        },
    );

    it("initializes one shared 360-second quarantine under concurrent detection", async () => {
        const connected = await connectRedisTestClient(port);
        try {
            const config = options({ client: connected, recoveryHorizonSeconds: 360 });
            const stores = await Promise.all(Array.from({ length: 8 }, () => createRedisReplayStore(config)));
            const initial = await state(config);
            expect(Number(initial.quarantineUntil) - Number(initial.detectedAt)).toBe(360000);
            expect(await Promise.all(stores.map((store) => store.consume(base))))
                .toEqual(Array(8).fill("unavailable"));
            expect(await state(config)).toEqual(initial);
            for (const key of keys(config)) {
                // Recovery state must not disappear merely because the service
                // was idle or one application instance restarted.
                expect(await client.sendCommand(["PTTL", key])).toBe(-1);
            }
            await createRedisReplayStore(config);
            expect(await state(config)).toEqual(initial);
            // This checks a real 360-second shared deadline, not elapsed boundary
            // passage; 359/360/361 acceptance arithmetic has separate fixtures.
        } finally {
            connected.close();
        }
    });

    it("leaves all prior state unchanged when Redis ACL forbids the atomic write", async () => {
        const config = options();
        await ready(config);
        const initial = await state(config);
        const username = `agentsig-${randomBytes(8).toString("hex")}`;
        const password = randomBytes(16).toString("hex");
        await client.sendCommand(["ACL", "SETUSER", username, "on", `>${password}`, "~*", "+@all", "-mset"]);
        try {
            const restricted = createRedisTestClient(port, { username, password });
            const store = await createRedisReplayStore({ ...config, client: restricted });
            expect(await store.consume(base)).toBe("unavailable");
            expect(await state(config)).toEqual(initial);
            expect(await client.sendCommand(["GET", keys(config)[0]!])).toBe(initial.epoch);
            expect(await client.sendCommand(["GET", keys(config)[1]!])).toBe(initial.quarantineUntil);
        } finally {
            await client.sendCommand(["ACL", "DELUSER", username]);
        }
    });
});

describe.skipIf(suppliedPort === undefined)("real Redis Lua with deterministic time samples", () => {
    async function executeAt(
        config: RedisReplayStoreOptions,
        seconds: number,
        microseconds: number,
        mode: "setup" | "consume",
    ): Promise<unknown> {
        const marker = "local time = redis.call('TIME')";
        expect(REDIS_REPLAY_SCRIPT.split(marker)).toHaveLength(2);
        // Test-only script copy: actual Redis executes all remaining production
        // Lua unchanged. This is deterministic time injection, not live elapsed
        // time evidence and not a production adapter configuration option.
        const script = REDIS_REPLAY_SCRIPT.replace(marker,
            `local time = {'${seconds}', '${microseconds}'}`);
        const resolved = resolveRedisReplayConfiguration(config);
        const record = prepareRedisConsume({
            ...base, retainUntilEpochSeconds: base.nowEpochSeconds + 1,
        })!;
        return client.sendCommand([
            "EVAL", script, "3", ...keys(config), mode,
            String(resolved.recoveryMilliseconds),
            String(resolved.capacity), String(resolved.maxPerKey),
            randomBytes(16).toString("hex"),
            record.identity, record.thumbprint, String(record.durationMilliseconds),
        ]);
    }

    it("does not end quarantine before its absolute millisecond deadline", async () => {
        const config = options({ recoveryHorizonSeconds: 360 });
        expect(await executeAt(config, 2000000000, 1, "setup")).toBe("quarantine");
        const initial = await state(config);
        expect(initial.quarantineUntil).toBe("2000000360001");
        expect(await executeAt(config, 2000000359, 0, "setup")).toBe("quarantine");
        expect(await executeAt(config, 2000000360, 999, "setup")).toBe("quarantine");
        expect(await executeAt(config, 2000000360, 1000, "setup")).toBe("ready");
        expect(await executeAt(config, 2000000361, 0, "setup")).toBe("ready");
        expect(await state(config)).toEqual(initial);
    });

    it("never expires a replay record by rounding observation time upward", async () => {
        const config = options();
        expect(await executeAt(config, 2000000000, 0, "setup")).toBe("quarantine");
        expect(await executeAt(config, 2000000001, 1, "consume")).toBe("accepted");
        const inserted = await state(config);
        expect(inserted.records[0]!.deadline).toBe("2000000002001");
        expect(await executeAt(config, 2000000002, 999, "consume")).toBe("replayed");
        expect(await state(config)).toEqual(inserted);
        expect(await executeAt(config, 2000000002, 1000, "consume")).toBe("accepted");
    });
});