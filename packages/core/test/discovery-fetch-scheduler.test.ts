import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DirectoryFetchScheduler } from "../src/discovery/fetch-scheduler.js";

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

const origin = "https://directory.agentsig.test";
const host = (index: number) => `https://agent-${index}.example`;
const outcome = <T>(promise: Promise<T>) => promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
);

describe("owned directory admission with controlled workers and clocks", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(1000);
    });
    afterEach(() => { vi.useRealTimers(); });

    it("coalesces 100 same-origin requests into exactly one worker", async () => {
        const pending = deferred<string>();
        const worker = vi.fn(() => pending.promise);
        const scheduler = new DirectoryFetchScheduler(worker, () => Date.now());
        const requests = Array.from({ length: 100 }, () => scheduler.run(origin));
        expect(requests.every((request) => request === requests[0])).toBe(true);
        expect(worker).toHaveBeenCalledTimes(1);
        expect(scheduler.stats).toMatchObject({ active: 1, queued: 0 });
        pending.resolve("complete");
        expect(await Promise.all(requests)).toEqual(Array(100).fill("complete"));
        expect(scheduler.stats.active).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("coalesces canonical origin spellings, not separate names", async () => {
        const pending = deferred<number>();
        const worker = vi.fn(() => pending.promise);
        const scheduler = new DirectoryFetchScheduler(worker, () => Date.now());
        const first = scheduler.run(origin);
        expect(scheduler.run("https://DIRECTORY.AGENTSIG.TEST:443/")).toBe(first);
        expect(scheduler.run("https://other.example")).not.toBe(first);
        expect(worker).toHaveBeenCalledTimes(2);
        pending.resolve(1);
        await first;
    });

    it("bounds a 100-origin flood to 16 active and 64 queued", async () => {
        const pending = deferred<number>();
        const worker = vi.fn(() => pending.promise);
        const scheduler = new DirectoryFetchScheduler(worker, () => Date.now());
        const requests = Array.from({ length: 100 }, (_, index) =>
            outcome(scheduler.run(host(index))));
        expect(worker).toHaveBeenCalledTimes(16);
        expect(scheduler.stats).toMatchObject({ active: 16, queued: 64 });
        expect(await Promise.all(requests.slice(80))).toEqual(Array.from(
            { length: 20 }, () => ({ error: expect.objectContaining({ reason: "capacity" }) }),
        ));
        pending.resolve(1);
        await vi.advanceTimersByTimeAsync(2000);
        const results = await Promise.all(requests);
        expect(results.filter((result) => "value" in result)).toHaveLength(80);
        expect(worker).toHaveBeenCalledTimes(80);
        expect(scheduler.stats).toMatchObject({ active: 0, queued: 0 });
        expect(vi.getTimerCount()).toBe(0);
    });

    it("enforces a sliding second rather than granting a fixed-window double burst", async () => {
        const starts: number[] = [];
        const worker = vi.fn(async () => { starts.push(Date.now()); return 1; });
        const scheduler = new DirectoryFetchScheduler(worker, () => Date.now());
        await Promise.all(Array.from({ length: 32 }, (_, index) => scheduler.run(host(index))));
        const waiting = scheduler.run(host(32));
        await vi.advanceTimersByTimeAsync(999);
        expect(starts).toHaveLength(32);
        expect(scheduler.stats.queued).toBe(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(await waiting).toBe(1);
        expect(starts[32]! - starts[0]!).toBe(1000);
        for (const start of starts) {
            expect(starts.filter((value) => value >= start && value < start + 1000).length)
                .toBeLessThanOrEqual(32);
        }
    });

    it("keeps 30-second origin cooldown after success and failure", async () => {
        const worker = vi.fn(async () => 1);
        const scheduler = new DirectoryFetchScheduler(worker, () => Date.now());
        await scheduler.run(origin);
        await expect(scheduler.run(origin)).rejects.toMatchObject({ reason: "origin-rate" });
        await vi.advanceTimersByTimeAsync(29999);
        await expect(scheduler.run(origin)).rejects.toMatchObject({ reason: "origin-rate" });
        await vi.advanceTimersByTimeAsync(1);
        worker.mockRejectedValueOnce(new Error("Remote details must not escape"));
        await expect(scheduler.run(origin)).rejects.toMatchObject({ reason: "fetch-failed" });
        await expect(scheduler.run(origin)).rejects.toMatchObject({ reason: "origin-rate" });
        expect(worker).toHaveBeenCalledTimes(2);
    });

    it("charges queue residence against the original total deadline", async () => {
        const pending = deferred<number>();
        const budgets: number[] = [];
        const worker = vi.fn((_origin: string, _signal: AbortSignal, remaining: number) => {
            budgets.push(remaining);
            return pending.promise;
        });
        const scheduler = new DirectoryFetchScheduler(worker, () => Date.now());
        const requests = Array.from({ length: 17 }, (_, index) => scheduler.run(host(index)));
        await vi.advanceTimersByTimeAsync(2500);
        pending.resolve(1);
        await Promise.all(requests);
        expect(budgets.slice(0, 16)).toEqual(Array(16).fill(3000));
        expect(budgets[16]).toBe(500);
    });

    it("never renews a coalesced caller's original deadline", async () => {
        const pending = deferred<number>();
        let signal!: AbortSignal;
        const scheduler = new DirectoryFetchScheduler((_origin, suppliedSignal) => {
            signal = suppliedSignal;
            return pending.promise;
        }, () => Date.now());
        const first = scheduler.run(origin);
        const result = outcome(first);
        await vi.advanceTimersByTimeAsync(2900);
        expect(scheduler.run(origin)).toBe(first);
        await vi.advanceTimersByTimeAsync(100);
        expect(await result).toMatchObject({ error: { reason: "deadline" } });
        expect(signal.aborted).toBe(true);
        expect(scheduler.stats.active).toBe(1);
        pending.resolve(1);
        await vi.advanceTimersByTimeAsync(0);
        expect(scheduler.stats.active).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("does not release active slots or start queued work merely on abort", async () => {
        const pending = deferred<number>();
        const worker = vi.fn(() => pending.promise);
        const scheduler = new DirectoryFetchScheduler(worker, () => Date.now());
        const results = Array.from({ length: 17 }, (_, index) =>
            outcome(scheduler.run(host(index))));
        await vi.advanceTimersByTimeAsync(3000);
        expect(await Promise.all(results)).toEqual(Array.from(
            { length: 17 }, () => ({ error: expect.objectContaining({ reason: "deadline" }) }),
        ));
        expect(worker).toHaveBeenCalledTimes(16);
        expect(scheduler.stats).toMatchObject({ active: 16, queued: 0 });
        await vi.advanceTimersByTimeAsync(30000);
        await expect(scheduler.run(host(0))).rejects.toMatchObject({ reason: "deadline" });
        expect(worker).toHaveBeenCalledTimes(16);
        pending.resolve(1);
        await vi.advanceTimersByTimeAsync(0);
        expect(scheduler.stats).toMatchObject({ active: 0, queued: 0 });
    });

    it("rejects late completion even if the deadline timer has not run", async () => {
        let now = 1000;
        const pending = deferred<number>();
        const scheduler = new DirectoryFetchScheduler(() => pending.promise, () => now);
        const result = outcome(scheduler.run(origin));
        now = 4000;
        pending.resolve(1);
        expect(await result).toMatchObject({ error: { reason: "deadline" } });
        expect(scheduler.stats.active).toBe(0);
    });

    it("latches regression and aborts every owned job without rebasing", async () => {
        let now = 1000;
        const pending = deferred<number>();
        const signals: AbortSignal[] = [];
        const worker = vi.fn((_origin: string, signal: AbortSignal) => {
            signals.push(signal);
            return pending.promise;
        });
        const scheduler = new DirectoryFetchScheduler(worker, () => now);
        const result = outcome(scheduler.run(origin));
        now = 999;
        await expect(scheduler.run(host(1))).rejects.toMatchObject({ reason: "clock" });
        expect(await result).toMatchObject({ error: { reason: "clock" } });
        expect(signals.every((signal) => signal.aborted)).toBe(true);
        now = 1001;
        await expect(scheduler.run(host(2))).rejects.toMatchObject({ reason: "clock" });
        pending.resolve(1);
        await vi.advanceTimersByTimeAsync(0);
        expect(scheduler.stats.active).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("contains synchronous worker exceptions and never leaks the original error", async () => {
        const scheduler = new DirectoryFetchScheduler<number>(() => {
            throw new Error("SECRET-BACKEND-MARKER");
        }, () => Date.now());
        const result = await outcome(scheduler.run(origin));
        expect(result).toMatchObject({ error: { reason: "fetch-failed" } });
        if ("error" in result) {
            expect((result.error as Error).message).not.toContain("SECRET-BACKEND-MARKER");
            expect(result.error).not.toHaveProperty("cause");
        }
        expect(scheduler.stats).toMatchObject({ active: 0, queued: 0 });
        expect(vi.getTimerCount()).toBe(0);
    });

    it("rejects invalid origin syntax before invoking the worker", () => {
        const worker = vi.fn(async () => 1);
        const scheduler = new DirectoryFetchScheduler(worker, () => Date.now());
        expect(() => scheduler.run("https://127.0.0.1"))
            .toThrow(expect.objectContaining({ code: "invalid-agent-binding" }));
        expect(worker).not.toHaveBeenCalled();
    });
});

describe("dispatch-time sampling under synchronous worker preparation", () => {
    it("starts each origin cooldown at its own dispatch, not the batch timestamp", async () => {
        vi.useFakeTimers();
        try {
            let now = 1000;
            const starts: { origin: string; time: number }[] = [];
            const scheduler = new DirectoryFetchScheduler((name) => {
                starts.push({ origin: name, time: now });
                if (name === host(32)) now += 1000;
                return Promise.resolve(1);
            }, () => now);
            await Promise.all(Array.from({ length: 32 }, (_, index) => scheduler.run(host(index))));
            // Both jobs wait on the rate window, with multiple active slots free.
            // The first worker's synchronous preparation advances the clock before
            // the same pump dispatches the second worker.
            const requests = [scheduler.run(host(32)), scheduler.run(host(33))];
            now = 2000;
            await vi.advanceTimersByTimeAsync(1000);
            await Promise.all(requests);
            const lastStart = starts.find((entry) => entry.origin === host(33))!;
            expect(lastStart.time).toBe(3000);
            now = lastStart.time + 29999;
            await expect(scheduler.run(host(33))).rejects.toMatchObject({ reason: "origin-rate" });
            now++;
            expect(await scheduler.run(host(33))).toBe(1);
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });
});