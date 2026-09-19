import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    createDirectoryFetchBudget, DirectoryService,
} from "../src/discovery/directory-service.js";
import type {
    DirectoryRefreshEvent, DirectoryServiceOptions,
} from "../src/discovery/directory-service.js";
import type { DirectoryResponse } from "../src/discovery/directory-response.js";
import type { fetchDirectoryOnce } from "../src/discovery/fetch-directory.js";
import { DirectoryDnsError } from "../src/discovery/dns-resolution.js";

const rotation = JSON.parse(readFileSync(new URL(
    "../../../tests/fixtures/m3-rotation/cases.json", import.meta.url,
), "utf8")) as {
    keys: Record<string, { jwk: Record<string, string>; thumbprint: string }>;
    cases: {
        id: string; refreshAtElapsedSeconds: number; finalAtElapsedSeconds: number;
        refreshKeys?: { materialFrom: string; kidFrom: string }[];
        refreshExpected?: { reason: string; diagnostic: { keyIndex: number; rule: string } };
    }[];
};
const original = rotation.keys.original!;
const other = rotation.keys.other!;
const origin = "https://directory.agentsig.test";
const second = "https://other.example";

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((yes) => { resolve = yes; });
    return { promise, resolve };
}

function harness(options: Partial<DirectoryServiceOptions> = {}) {
    let now = 1000;
    const events: Readonly<DirectoryRefreshEvent>[] = [];
    const response = (keys: readonly Record<string, unknown>[] = [original.jwk]): DirectoryResponse => ({
        body: Buffer.from(JSON.stringify({ keys })), headers: [],
        requestStartedMonotonicMs: now, responseReceivedMonotonicMs: now,
        responseReceivedWallMs: 1800000000000,
    });
    const transport = vi.fn<typeof fetchDirectoryOnce>(async () => response());
    const service = new DirectoryService({
        format: "wg-directory-00", network: { mode: "open" },
        onRefresh: (event) => { events.push(event); }, ...options,
    }, transport, () => now);
    return {
        service, transport, events, response,
        advance(ms: number) { now += ms; },
        resolve(name = origin, key = original.thumbprint) {
            return service.resolve(name, key, createDirectoryFetchBudget());
        },
    };
}

afterEach(() => { vi.useRealTimers(); });

describe("integrated directory service with controlled transport", () => {
    it("denies default unlisted origins before transport and emits no refresh", async () => {
        const h = harness({ network: {} });
        expect(await h.resolve()).toEqual({ status: "missing", reason: "unknown-key" });
        expect(h.transport).not.toHaveBeenCalled();
        expect(h.events).toHaveLength(0);
    });

    it("coalesces 100 callers into one fetch, one event and one stored set", async () => {
        const h = harness();
        const pending = deferred<DirectoryResponse>();
        h.transport.mockImplementation(() => pending.promise);
        const requests = Array.from({ length: 100 }, () => h.resolve());
        await Promise.resolve();
        expect(h.transport).toHaveBeenCalledTimes(1);
        pending.resolve(h.response());
        const results = await Promise.all(requests);
        expect(results.every((result) => result.status === "found")).toBe(true);
        expect(h.events).toEqual([{ origin, outcome: "completed", persisted: true }]);
        expect(h.service.stats).toMatchObject({
            positiveEntries: 1, pendingRefreshes: 0, active: 0, queued: 0,
        });
        expect(await h.resolve()).toMatchObject({ status: "found" });
        expect(h.transport).toHaveBeenCalledTimes(1);
    });

    it("shares one invocation budget across origins but permits fresh cache hits", async () => {
        const h = harness();
        const budget = createDirectoryFetchBudget();
        expect(await h.service.resolve(origin, original.thumbprint, budget)).toMatchObject({ status: "found" });
        expect(await h.service.resolve(second, original.thumbprint, budget))
            .toEqual({ status: "missing", reason: "resource-limit" });
        expect(await h.service.resolve(origin, original.thumbprint, budget)).toMatchObject({ status: "found" });
        expect(h.transport).toHaveBeenCalledTimes(1);
    });

    it("does not accept a forged invocation budget", async () => {
        const h = harness();
        expect(await h.service.resolve(origin, original.thumbprint, { maximumFetches: 1 }))
            .toEqual({ status: "missing", reason: "resource-limit" });
        expect(h.transport).not.toHaveBeenCalled();
    });

    it("reports private-address denial without accepting a key or retrying", async () => {
        const h = harness();
        h.transport.mockRejectedValue(new DirectoryDnsError("address-denied"));
        expect(await h.resolve()).toEqual({ status: "missing", reason: "unknown-key" });
        expect(h.events).toEqual([{ origin, outcome: "failed", reason: "address-denied" }]);
        expect(await h.resolve()).toEqual({ status: "missing", reason: "unknown-key" });
        expect(h.transport).toHaveBeenCalledTimes(1);
        expect(h.service.stats.negativeEntries).toBe(1);
        // The double supplies the DNS failure; this is not a live SSRF test.
    });

    it("keeps selections valid across refresh only while their thumbprint remains", async () => {
        const h = harness();
        const selected = await h.resolve();
        if (selected.status !== "found") throw new Error("Expected key");
        h.advance(30000);
        h.transport.mockImplementation(async () => h.response([other.jwk, original.jwk]));
        expect(await h.service.refresh(origin)).toMatchObject({ outcome: "completed" });
        expect(h.service.recheck(selected.selection)).toBe(true);
        h.advance(30000);
        h.transport.mockImplementation(async () => h.response([other.jwk]));
        expect(await h.service.refresh(origin)).toMatchObject({ outcome: "completed" });
        expect(h.service.recheck(selected.selection)).toBe(false);
    });

    for (const row of rotation.cases.filter((entry) => entry.refreshExpected)) {
        it(`discovery layer of ${row.id}, not full request authentication`, async () => {
            const h = harness();
            const selected = await h.resolve();
            if (selected.status !== "found") throw new Error("Expected initial key");
            h.events.length = 0;
            const before = h.service.stats.positiveAccountedBytes;
            h.advance(row.refreshAtElapsedSeconds * 1000);
            const keys = row.refreshKeys!.map((entry) => ({
                ...rotation.keys[entry.materialFrom]!.jwk,
                kid: rotation.keys[entry.kidFrom]!.thumbprint,
            }));
            h.transport.mockImplementation(async () => h.response(keys));
            expect(await h.service.refresh(origin)).toEqual({
                outcome: "failed", reason: row.refreshExpected!.reason,
                diagnostic: row.refreshExpected!.diagnostic,
            });
            expect(h.events).toEqual([{
                origin, outcome: "failed", reason: row.refreshExpected!.reason,
                diagnostic: row.refreshExpected!.diagnostic,
            }]);
            expect(h.service.stats.positiveAccountedBytes).toBe(before);
            h.advance((row.finalAtElapsedSeconds - row.refreshAtElapsedSeconds) * 1000);
            const fresh = row.finalAtElapsedSeconds < 60;
            expect(h.service.recheck(selected.selection)).toBe(fresh);
            expect(await h.resolve()).toMatchObject(fresh
                ? { status: "found" } : { status: "missing", reason: "unknown-key" });
            expect(h.transport).toHaveBeenCalledTimes(2);
            expect(h.events).toHaveLength(1);
        });
    }

    it("isolates observer throws and rejects synchronous observer reentry", async () => {
        let service!: DirectoryService;
        let reentry: ReturnType<DirectoryService["resolve"]> | undefined;
        const h = harness({
            onRefresh() {
                reentry = service.resolve(second, original.thumbprint, createDirectoryFetchBudget());
                throw new Error("OBSERVER-PRIVATE-MARKER");
            },
        });
        service = h.service;
        expect(await h.resolve()).toMatchObject({ status: "found" });
        expect(await reentry).toEqual({ status: "missing", reason: "resource-limit" });
        expect(h.service.stats.observerErrorCount).toBe(1);
        expect(h.transport).toHaveBeenCalledTimes(1);
    });

    it("never commits a response arriving after the scheduler deadline", async () => {
        vi.useFakeTimers();
        const h = harness();
        const late = deferred<DirectoryResponse>();
        h.transport.mockImplementation(() => late.promise);
        const resolving = h.resolve();
        await Promise.resolve();
        h.advance(3000);
        await vi.advanceTimersByTimeAsync(3000);
        expect(await resolving).toEqual({ status: "missing", reason: "unknown-key" });
        expect(h.service.stats.positiveEntries).toBe(0);
        expect(h.service.stats.active).toBe(1);
        late.resolve(h.response());
        await vi.advanceTimersByTimeAsync(0);
        expect(h.service.stats.positiveEntries).toBe(0);
        expect(h.service.stats.active).toBe(0);
        expect(h.events).toHaveLength(1);
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe("shared refresh failure and admission boundaries", () => {
    it("reports one invalid document event for 100 coalesced callers", async () => {
        const h = harness();
        const pending = deferred<DirectoryResponse>();
        h.transport.mockImplementation(() => pending.promise);
        const requests = Array.from({ length: 100 }, () => h.resolve());
        await Promise.resolve();
        pending.resolve(h.response([
            other.jwk, { ...other.jwk, kid: original.thumbprint },
        ]));
        const results = await Promise.all(requests);
        expect(results).toEqual(Array.from({ length: 100 }, () => ({
            status: "missing", reason: "unknown-key",
        })));
        expect(h.transport).toHaveBeenCalledTimes(1);
        expect(h.events).toEqual([{
            origin, outcome: "failed", reason: "invalid-jwks",
            diagnostic: { keyIndex: 1, rule: "kid must equal the RFC 7638 thumbprint" },
        }]);
        expect(h.service.stats).toMatchObject({
            positiveEntries: 0, negativeEntries: 1, pendingRefreshes: 0,
        });
    });

    it("bounds different-origin admission through the service, not only the scheduler", async () => {
        vi.useFakeTimers();
        const h = harness();
        const pending = deferred<DirectoryResponse>();
        h.transport.mockImplementation(() => pending.promise);
        const requests = Array.from({ length: 100 }, (_, index) =>
            h.resolve(`https://agent-${index}.example`));
        await Promise.resolve();
        expect(h.transport).toHaveBeenCalledTimes(16);
        expect(h.service.stats).toMatchObject({
            active: 16, queued: 64, pendingRefreshes: 80,
        });
        expect(await Promise.all(requests.slice(80))).toEqual(
            Array.from({ length: 20 }, () => ({ status: "missing", reason: "resource-limit" })),
        );
        pending.resolve(h.response());
        await vi.advanceTimersByTimeAsync(0);
        expect(h.transport).toHaveBeenCalledTimes(32);
        h.advance(1000);
        await vi.advanceTimersByTimeAsync(1000);
        expect(h.transport).toHaveBeenCalledTimes(64);
        h.advance(1000);
        await vi.advanceTimersByTimeAsync(1000);
        expect(h.transport).toHaveBeenCalledTimes(80);
        const results = await Promise.all(requests);
        expect(results.filter((result) => result.status === "found")).toHaveLength(80);
        expect(h.service.stats).toMatchObject({ active: 0, queued: 0, pendingRefreshes: 0 });
        expect(vi.getTimerCount()).toBe(0);
    });

    it("spends the invocation budget when joining an already running refresh", async () => {
        const h = harness();
        const pending = deferred<DirectoryResponse>();
        h.transport.mockImplementation(() => pending.promise);
        const refresh = h.service.refresh(origin);
        const budget = createDirectoryFetchBudget();
        const joined = h.service.resolve(origin, original.thumbprint, budget);
        expect(await h.service.resolve(second, original.thumbprint, budget))
            .toEqual({ status: "missing", reason: "resource-limit" });
        pending.resolve(h.response());
        await refresh;
        expect(await joined).toMatchObject({ status: "found" });
        expect(h.transport).toHaveBeenCalledTimes(1);
    });

    it("does not start transport when the original admission deadline elapsed before dispatch", async () => {
        const h = harness();
        const pending = h.service.refresh(origin);
        h.advance(3000);
        expect(await pending).toEqual({ outcome: "failed", reason: "deadline" });
        expect(h.transport).not.toHaveBeenCalled();
        expect(h.service.stats.positiveEntries).toBe(0);
    });
});

describe("total deadline includes synchronous document preparation", () => {
    it("abandons a validated replacement when preparation exhausts the budget", async () => {
        const { DirectoryCache } = await import("../src/discovery/directory-cache.js");
        const h = harness();
        const selected = await h.resolve();
        if (selected.status !== "found") throw new Error("Expected initial key");
        const before = h.service.stats.positiveAccountedBytes;
        h.events.length = 0;
        h.advance(30000);
        h.transport.mockImplementation(async () => h.response([other.jwk]));

        const originalPrepare = DirectoryCache.prototype.prepare;
        // Run real validation, then simulate synchronous CPU time in its owned
        // phase. No wall-clock sleep or production clock override is introduced.
        const preparation = vi.spyOn(DirectoryCache.prototype, "prepare")
            .mockImplementation(function (
                this: InstanceType<typeof DirectoryCache>,
                response: DirectoryResponse,
            ) {
                const ticket = originalPrepare.call(this, response);
                h.advance(3000);
                return ticket;
            });
        try {
            expect(await h.service.refresh(origin)).toEqual({
                outcome: "failed", reason: "deadline",
            });
            expect(preparation).toHaveBeenCalledTimes(1);
            expect(h.service.stats.positiveAccountedBytes).toBe(before);
            expect(h.service.recheck(selected.selection)).toBe(true);
            expect(await h.resolve(origin, other.thumbprint)).toEqual({
                status: "missing", reason: "unknown-key",
            });
            expect(h.events).toEqual([{ origin, outcome: "failed", reason: "deadline" }]);
            expect(h.transport).toHaveBeenCalledTimes(2);

            // Initial evidence expires at elapsed 60 seconds, not 60 seconds
            // after the failed preparation at elapsed 33 seconds.
            h.advance(27000);
            expect(h.service.recheck(selected.selection)).toBe(false);
            expect(await h.resolve()).toEqual({ status: "missing", reason: "unknown-key" });
            expect(h.transport).toHaveBeenCalledTimes(2);
        } finally {
            preparation.mockRestore();
        }
    });
});

describe("one deadline across service admission and transport", () => {
    it("subtracts time spent before scheduler admission from the transport budget", async () => {
        const h = harness();
        const pending = h.service.refresh(origin);
        h.advance(1000);
        expect(await pending).toMatchObject({ outcome: "completed" });
        expect(h.transport).toHaveBeenCalledTimes(1);
        expect(h.transport.mock.calls[0]![1]!.totalMilliseconds).toBe(2000);
    });

    it("aborts transport at the original service deadline, not a restarted deadline", async () => {
        vi.useFakeTimers();
        const h = harness();
        const late = deferred<DirectoryResponse>();
        h.transport.mockImplementation(() => late.promise);
        const pending = h.service.refresh(origin);
        h.advance(1000);
        // Dispatch the microtask without advancing the independent timer clock.
        // Admission already consumed 1,000 ms, leaving exactly 2,000 ms.
        await Promise.resolve();
        expect(h.transport.mock.calls[0]![1]!.totalMilliseconds).toBe(2000);
        const signal = h.transport.mock.calls[0]![1]!.signal!;
        h.advance(1999);
        await vi.advanceTimersByTimeAsync(1999);
        expect(signal.aborted).toBe(false);
        expect(h.service.stats.active).toBe(1);
        h.advance(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(signal.aborted).toBe(true);
        expect(await pending).toMatchObject({ outcome: "failed", reason: "deadline" });
        late.resolve(h.response());
        await vi.advanceTimersByTimeAsync(0);
        expect(h.service.stats.positiveEntries).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });
});