import { afterEach, describe, expect, it, vi } from "vitest";
import {
    resolveDirectoryAddresses, validateDirectoryAddresses,
} from "../src/discovery/dns-resolution.js";
import type { DirectoryDnsResolver } from "../src/discovery/dns-resolution.js";

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function harness() {
    const resolve4 = vi.fn(async (_hostname: string) => ["1.1.1.1"]);
    const resolve6 = vi.fn(async (_hostname: string) => ["2606:4700:4700::1111"]);
    const cancel = vi.fn();
    const resolver: DirectoryDnsResolver = { resolve4, resolve6, cancel };
    const factory = vi.fn(() => resolver);
    return { resolve4, resolve6, cancel, factory };
}

afterEach(() => vi.useRealTimers());

describe("directory DNS candidate validation", () => {
    it("owns and freezes the complete admitted answer set", () => {
        const ipv4 = ["1.1.1.1", "1.1.1.1"];
        const result = validateDirectoryAddresses(ipv4, ["2606:4700:4700::1111"]);
        ipv4[0] = "127.0.0.1";
        expect(result).toEqual([
            { address: "1.1.1.1", family: 4 },
            { address: "2606:4700:4700::1111", family: 6 },
        ]);
        expect(Object.isFrozen(result)).toBe(true);
        expect(result.every(Object.isFrozen)).toBe(true);
    });

    it.each([
        { v4: ["1.1.1.1", "10.0.0.1"], v6: [] },
        { v4: ["1.1.1.1"], v6: ["::1"] },
        { v4: [], v6: ["2606:4700:4700::1111", "fd00::1"] },
        { v4: ["1.1.1.1"], v6: ["::ffff:8.8.8.8"] },
        { v4: ["2606:4700:4700::1111"], v6: [] },
        { v4: [], v6: ["1.1.1.1"] },
        { v4: ["127.1"], v6: [] },
        { v4: ["1.1.1.1"], v6: ["fe80::1%eth0"] },
        { v4: Array<string>(1), v6: [] },
    ])("rejects the entire mixed or malformed set %#", ({ v4, v6 }) => {
        expect(() => validateDirectoryAddresses(v4, v6))
            .toThrow(expect.objectContaining({ reason: "address-denied" }));
    });

    it("counts occurrences before deduplication and accepts the exact budget", () => {
        expect(validateDirectoryAddresses(Array<string>(16).fill("1.1.1.1"), [])).toHaveLength(1);
        expect(() => validateDirectoryAddresses(Array<string>(17).fill("1.1.1.1"), []))
            .toThrow(expect.objectContaining({ reason: "dns-limit" }));
    });

    it("rejects an empty combined set", () => {
        expect(() => validateDirectoryAddresses([], []))
            .toThrow(expect.objectContaining({ reason: "dns-failure" }));
    });

    it.each([0, -1, 1.5, Infinity, NaN])("rejects invalid address budget %s", (maximum) => {
        expect(() => validateDirectoryAddresses(["1.1.1.1"], [], maximum))
            .toThrow(expect.objectContaining({ code: "invalid-resource-limits" }));
    });
});

describe("owned DNS resolution without live network access", () => {
    it("queries absolute DNS names once per family and releases the resolver", async () => {
        const h = harness();
        const result = await resolveDirectoryAddresses("agent.example", 1000, 16, h.factory);
        expect(result).toHaveLength(2);
        expect(h.factory).toHaveBeenCalledTimes(1);
        expect(h.resolve4).toHaveBeenCalledExactlyOnceWith("agent.example.");
        expect(h.resolve6).toHaveBeenCalledExactlyOnceWith("agent.example.");
        expect(h.cancel).toHaveBeenCalledTimes(1);
    });

    it.each([
        "", "localhost", "1.1.1.1", "::1", "[::1]", "agent.example.",
        "https://agent.example", "agent..example", "-agent.example",
        "agent_.example", `${"a".repeat(64)}.example`, "a".repeat(254),
        "agent.example:443", "agent.example/path", "agent.example\n",
    ])("rejects hostname before creating a resolver: %j", async (hostname) => {
        const h = harness();
        await expect(resolveDirectoryAddresses(hostname, 1000, 16, h.factory))
            .rejects.toMatchObject({ reason: "address-denied" });
        expect(h.factory).not.toHaveBeenCalled();
    });

    it.each([0, -1, 0.5, NaN, Infinity, 2_147_483_648])(
        "rejects invalid timer range %s before resolution", async (timeout) => {
            const h = harness();
            await expect(resolveDirectoryAddresses("agent.example", timeout, 16, h.factory))
                .rejects.toMatchObject({ code: "invalid-resource-limits" });
            expect(h.factory).not.toHaveBeenCalled();
        },
    );

    it("accepts ENODATA for one family without hiding valid results from the other", async () => {
        const h = harness();
        h.resolve6.mockRejectedValue(Object.assign(new Error("No AAAA data"), { code: "ENODATA" }));
        expect(await resolveDirectoryAddresses("agent.example", 1000, 16, h.factory))
            .toEqual([{ address: "1.1.1.1", family: 4 }]);
    });

    it.each(["ENOTFOUND", "ESERVFAIL", "ETIMEOUT", "ECANCELLED"])(
        "does not hide %s behind a successful A answer", async (code) => {
            const h = harness();
            h.resolve6.mockRejectedValue(Object.assign(new Error("PRIVATE-DNS-MARKER"), { code }));
            const outcome = resolveDirectoryAddresses("agent.example", 1000, 16, h.factory);
            await expect(outcome).rejects.toMatchObject({ reason: "dns-failure" });
            await expect(outcome).rejects.not.toThrow("PRIVATE-DNS-MARKER");
            expect(h.cancel).toHaveBeenCalledTimes(1);
        },
    );

    it("waits for both families and rejects a late private AAAA answer", async () => {
        const h = harness();
        const pending = deferred<string[]>();
        h.resolve6.mockImplementation(() => pending.promise);
        const outcome = resolveDirectoryAddresses("agent.example", 1000, 16, h.factory);
        let settled = false;
        void outcome.then(() => { settled = true; }, () => { settled = true; });
        await Promise.resolve();
        await Promise.resolve();
        expect(settled).toBe(false);
        const assertion = expect(outcome).rejects.toMatchObject({ reason: "address-denied" });
        pending.resolve(["fd00::1"]);
        await assertion;
    });

    it("times out, cancels, and never revives on late successful answers", async () => {
        vi.useFakeTimers();
        const h = harness();
        const v4 = deferred<string[]>();
        const v6 = deferred<string[]>();
        h.resolve4.mockImplementation(() => v4.promise);
        h.resolve6.mockImplementation(() => v6.promise);
        const outcome = resolveDirectoryAddresses("agent.example", 100, 16, h.factory);
        const assertion = expect(outcome).rejects.toMatchObject({ reason: "dns-timeout" });
        await vi.advanceTimersByTimeAsync(100);
        await assertion;
        expect(h.cancel).toHaveBeenCalled();
        v4.resolve(["1.1.1.1"]);
        v6.resolve(["2606:4700:4700::1111"]);
        await Promise.resolve();
        await expect(outcome).rejects.toMatchObject({ reason: "dns-timeout" });
        expect(vi.getTimerCount()).toBe(0);
    });

    it("handles a sibling's late rejection after failure and clears its timer", async () => {
        vi.useFakeTimers();
        const h = harness();
        const sibling = deferred<string[]>();
        h.resolve4.mockRejectedValue(new Error("PRIVATE-DNS-MARKER"));
        h.resolve6.mockImplementation(() => sibling.promise);
        await expect(resolveDirectoryAddresses("agent.example", 100, 16, h.factory))
            .rejects.toMatchObject({ reason: "dns-failure" });
        sibling.reject(new Error("PRIVATE-LATE-MARKER"));
        await Promise.resolve();
        expect(vi.getTimerCount()).toBe(0);
        expect(h.cancel).toHaveBeenCalledTimes(1);
    });

    it("does not replace an outcome with a cancellation exception", async () => {
        const h = harness();
        h.cancel.mockImplementation(() => { throw new Error("PRIVATE-CANCEL-MARKER"); });
        expect(await resolveDirectoryAddresses("agent.example", 1000, 16, h.factory)).toHaveLength(2);
    });
});