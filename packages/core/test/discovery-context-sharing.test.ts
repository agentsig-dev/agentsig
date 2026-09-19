import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { contextDiscovery } from "../src/discovery/context-discovery.js";
import { createDirectoryFetchBudget } from "../src/discovery/directory-service.js";
import type { DirectoryServiceOptions } from "../src/discovery/directory-service.js";
import type { DirectoryResponse } from "../src/discovery/directory-response.js";
import type { fetchDirectoryOnce } from "../src/discovery/fetch-directory.js";
import { createSecurityContext } from "../src/profiles/security-context.js";
import type { SecurityContext } from "../src/profiles/security-context.js";

const wg = "ietf-wg-protocol-00";
const cf = "cloudflare-docs-2026-07-01";
const origin = "https://directory.agentsig.test";
const material = JSON.parse(readFileSync(new URL(
    "../../../tests/fixtures/jwks/public-material.json", import.meta.url,
), "utf8")) as Record<string, { key: Record<string, string>; thumbprint: string }>;
const ed = material.ed25519!;

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((yes) => { resolve = yes; });
    return { promise, resolve };
}

function harness() {
    let now = 1000;
    const clock = () => now;
    const context = createSecurityContext({
        wallClock: () => 1800000000000 + now,
        monotonicClock: clock,
    });
    const response = (keys: Record<string, unknown>[] = [ed.key]): DirectoryResponse => ({
        body: Buffer.from(JSON.stringify({ keys })), headers: [],
        requestStartedMonotonicMs: now,
        responseReceivedMonotonicMs: now,
        responseReceivedWallMs: 1800000000000 + now,
    });
    const transport = vi.fn<typeof fetchDirectoryOnce>(async () => response());
    const options: Omit<DirectoryServiceOptions, "format"> = { network: { mode: "open" } };
    const services = contextDiscovery(context, options, transport, clock);
    return {
        context, clock, options, services, transport, response,
        advance(ms: number) { now += ms; },
    };
}

afterEach(() => vi.useRealTimers());

describe("security-context-associated discovery coordinator", () => {
    it("returns the same profile services for repeated compatible association", () => {
        const h = harness();
        const again = contextDiscovery(h.context, h.options, h.transport, h.clock);
        expect(again).toBe(h.services);
        expect(again[wg]).toBe(h.services[wg]);
        expect(again[cf]).toBe(h.services[cf]);
        expect(again[wg]).not.toBe(again[cf]);
    });

    it("coalesces simultaneous profile requests into one transport operation", async () => {
        const h = harness();
        const pending = deferred<DirectoryResponse>();
        h.transport.mockImplementation(() => pending.promise);
        const first = h.services[wg].resolve(origin, ed.thumbprint, createDirectoryFetchBudget());
        const second = h.services[cf].resolve(origin, ed.thumbprint, createDirectoryFetchBudget());
        await Promise.resolve();
        expect(h.transport).toHaveBeenCalledTimes(1);
        expect(h.services[wg].stats.active).toBe(1);
        expect(h.services[cf].stats.active).toBe(1);
        pending.resolve(h.response());
        expect(await first).toMatchObject({ status: "found" });
        expect(await second).toMatchObject({ status: "found" });
    });

    it("does not reuse another profile's parsed key set or algorithm vocabulary", async () => {
        const h = harness();
        const pending = deferred<DirectoryResponse>();
        h.transport.mockImplementation(() => pending.promise);
        const first = h.services[wg].resolve(origin, ed.thumbprint, createDirectoryFetchBudget());
        const second = h.services[cf].resolve(origin, ed.thumbprint, createDirectoryFetchBudget());
        await Promise.resolve();
        pending.resolve(h.response([{ ...ed.key, alg: "ed25519" }]));
        expect(await first).toMatchObject({ status: "found" });
        expect(await second).toEqual({ status: "missing", reason: "unknown-key" });
        expect(h.transport).toHaveBeenCalledTimes(1);
        expect(h.services[wg].stats.positiveEntries).toBe(1);
        expect(h.services[cf].stats.positiveEntries).toBe(0);
        expect(h.services[cf].stats.negativeEntries).toBe(1);
    });

    it("shares the 16 active, 64 queued and 32 starts/second limits across profiles", async () => {
        vi.useFakeTimers();
        const h = harness();
        const pending = deferred<DirectoryResponse>();
        h.transport.mockImplementation(() => pending.promise);
        const requests = Array.from({ length: 100 }, (_, index) =>
            h.services[index % 2 ? cf : wg].refresh(`https://agent-${index}.example`));
        await Promise.resolve();
        expect(h.transport).toHaveBeenCalledTimes(16);
        for (const service of Object.values(h.services)) {
            expect(service.stats).toMatchObject({ active: 16, queued: 64 });
        }
        expect((await Promise.all(requests.slice(80))).every((result) =>
            result.outcome === "failed" && result.reason === "capacity")).toBe(true);
        pending.resolve(h.response());
        await vi.advanceTimersByTimeAsync(0);
        expect(h.transport).toHaveBeenCalledTimes(32);
        h.advance(999);
        await vi.advanceTimersByTimeAsync(999);
        expect(h.transport).toHaveBeenCalledTimes(32);
        h.advance(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(h.transport).toHaveBeenCalledTimes(64);
        h.advance(1000);
        await vi.advanceTimersByTimeAsync(1000);
        const results = await Promise.all(requests);
        expect(results.filter((result) => result.outcome === "completed")).toHaveLength(80);
        expect(h.transport).toHaveBeenCalledTimes(80);
        expect(h.services[wg].stats).toMatchObject({ active: 0, queued: 0 });
        expect(vi.getTimerCount()).toBe(0);
    });

    it("does not restart cooldown on profile change, reassociation or context reset", async () => {
        const h = harness();
        await h.services[wg].refresh(origin);
        await h.context.resetClockReference();
        const again = contextDiscovery(h.context, h.options, h.transport, h.clock);
        expect(await again[cf].refresh(origin)).toEqual({
            outcome: "failed", reason: "origin-rate",
        });
        h.advance(29999);
        expect(await again[cf].refresh(origin)).toMatchObject({ reason: "origin-rate" });
        h.advance(1);
        expect(await again[cf].refresh(origin)).toMatchObject({ outcome: "completed" });
        expect(h.transport).toHaveBeenCalledTimes(2);
    });

    it("does not renew positive cache age on verification-clock reset", async () => {
        const h = harness();
        const selected = await h.services[wg].resolve(origin, ed.thumbprint, createDirectoryFetchBudget());
        if (selected.status !== "found") throw new Error("Expected key");
        h.advance(40000);
        await h.context.resetClockReference();
        expect(h.services[wg].recheck(selected.selection)).toBe(true);
        h.advance(20000);
        expect(h.services[wg].recheck(selected.selection)).toBe(false);
        expect(h.transport).toHaveBeenCalledTimes(1);
    });

    it("rejects incompatible trust configuration instead of allocating another coordinator", () => {
        const h = harness();
        for (const options of [
            { network: { mode: "allowlist" as const } },
            { network: { mode: "open" as const, ca: "another-ca" } },
            { network: { mode: "open" as const }, cache: { negativeSeconds: 30 } },
            { network: { mode: "open" as const }, onRefresh() { } },
        ]) {
            expect(() => contextDiscovery(h.context, options, h.transport, h.clock))
                .toThrow(expect.objectContaining({ code: "invalid-agent-binding" }));
        }
        expect(contextDiscovery(h.context, h.options, h.transport, h.clock)).toBe(h.services);
        expect(h.transport).not.toHaveBeenCalled();
    });

    it("rejects foreign test clocks, transports and forged security contexts", () => {
        const h = harness();
        expect(() => contextDiscovery(h.context, h.options, h.transport, () => 1000))
            .toThrow(expect.objectContaining({ code: "invalid-agent-binding" }));
        expect(() => contextDiscovery(h.context, h.options, async () => h.response(), h.clock))
            .toThrow(expect.objectContaining({ code: "invalid-agent-binding" }));
        expect(() => contextDiscovery({ ...h.context } as SecurityContext, h.options, h.transport, h.clock))
            .toThrow(expect.objectContaining({ code: "invalid-replay-policy" }));
    });
});

describe("cross-profile visibility of a current directory response", () => {
    it.each([wg, cf] as const)("a valid empty refresh through %s removes keys from both partitions", async (profile) => {
        const h = harness();
        const initial = deferred<DirectoryResponse>();
        h.transport.mockImplementation(() => initial.promise);
        const lookups = [
            h.services[wg].resolve(origin, ed.thumbprint, createDirectoryFetchBudget()),
            h.services[cf].resolve(origin, ed.thumbprint, createDirectoryFetchBudget()),
        ];
        await Promise.resolve();
        initial.resolve(h.response());
        const selections = await Promise.all(lookups);
        expect(selections.every((result) => result.status === "found")).toBe(true);
        expect(h.transport).toHaveBeenCalledTimes(1);

        h.advance(30000);
        h.transport.mockImplementation(async () => h.response([]));
        expect(await h.services[profile].refresh(origin)).toMatchObject({ outcome: "completed" });
        expect(h.transport).toHaveBeenCalledTimes(2);
        for (const [index, service] of [h.services[wg], h.services[cf]].entries()) {
            const selected = selections[index]!;
            if (selected.status !== "found") throw new Error("Expected initial key");
            expect(service.recheck(selected.selection)).toBe(false);
            expect(await service.resolve(origin, ed.thumbprint, createDirectoryFetchBudget()))
                .toEqual({ status: "missing", reason: "unknown-key" });
        }
        expect(h.transport).toHaveBeenCalledTimes(2);
    });

    it("does not let success in JOSE bypass WG whole-document validation", async () => {
        const h = harness();
        const initial = deferred<DirectoryResponse>();
        h.transport.mockImplementation(() => initial.promise);
        const lookups = [
            h.services[wg].resolve(origin, ed.thumbprint, createDirectoryFetchBudget()),
            h.services[cf].resolve(origin, ed.thumbprint, createDirectoryFetchBudget()),
        ];
        await Promise.resolve();
        initial.resolve(h.response());
        const selections = await Promise.all(lookups);

        h.advance(30000);
        // An opaque kid is valid JOSE metadata, but violates WG thumbprint binding.
        h.transport.mockImplementation(async () => h.response([{ ...ed.key, kid: "opaque-label" }]));
        expect(await h.services[cf].refresh(origin)).toMatchObject({ outcome: "completed" });
        for (const [index, service] of [h.services[wg], h.services[cf]].entries()) {
            const selected = selections[index]!;
            if (selected.status !== "found") throw new Error("Expected initial key");
            expect(service.recheck(selected.selection)).toBe(true);
        }
        h.advance(30000);
        const wgSelection = selections[0]!;
        const cfSelection = selections[1]!;
        if (wgSelection.status !== "found" || cfSelection.status !== "found") {
            throw new Error("Expected initial selections");
        }
        // The rejected WG replacement must not renew that partition's old age.
        expect(h.services[wg].recheck(wgSelection.selection)).toBe(false);
        expect(h.services[cf].recheck(cfSelection.selection)).toBe(true);
        expect(h.transport).toHaveBeenCalledTimes(2);
    });
});

describe("shared response preparation deadline", () => {
    it("commits neither partition when the second preparation exhausts the total budget", async () => {
        const { DirectoryCache } = await import("../src/discovery/directory-cache.js");
        const h = harness();
        await h.services[wg].refresh(origin);
        const selections = await Promise.all([
            h.services[wg].resolve(origin, ed.thumbprint, createDirectoryFetchBudget()),
            h.services[cf].resolve(origin, ed.thumbprint, createDirectoryFetchBudget()),
        ]);
        expect(selections.every((result) => result.status === "found")).toBe(true);
        const before = [
            h.services[wg].stats.positiveAccountedBytes,
            h.services[cf].stats.positiveAccountedBytes,
        ];

        h.advance(30000);
        h.transport.mockImplementation(async () => h.response([]));
        const prepare = DirectoryCache.prototype.prepare;
        let preparations = 0;
        const spy = vi.spyOn(DirectoryCache.prototype, "prepare")
            .mockImplementation(function (
                this: InstanceType<typeof DirectoryCache>,
                response: DirectoryResponse,
            ) {
                const ticket = prepare.call(this, response);
                preparations++;
                if (preparations === 2) h.advance(3000);
                return ticket;
            });
        try {
            expect(await h.services[wg].refresh(origin)).toEqual({
                outcome: "failed", reason: "deadline",
            });
            expect(preparations).toBe(2);
            for (const [index, service] of [h.services[wg], h.services[cf]].entries()) {
                const selected = selections[index]!;
                if (selected.status !== "found") throw new Error("Expected initial key");
                expect(service.recheck(selected.selection)).toBe(true);
                expect(service.stats.positiveAccountedBytes).toBe(before[index]);
            }

            // Neither failed preparation renews the original sixty-second age.
            h.advance(27000);
            for (const [index, service] of [h.services[wg], h.services[cf]].entries()) {
                const selected = selections[index]!;
                if (selected.status !== "found") throw new Error("Expected initial key");
                expect(service.recheck(selected.selection)).toBe(false);
            }
            expect(h.transport).toHaveBeenCalledTimes(2);
        } finally {
            spy.mockRestore();
        }
    });
});