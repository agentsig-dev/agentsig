import { TLSSocket } from "node:tls";
import { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { fetchDirectoryOnce } from "../src/discovery/fetch-directory.js";
import type { DirectoryFetchDependencies } from "../src/discovery/fetch-directory.js";
import { validateDirectoryAddresses } from "../src/discovery/dns-resolution.js";

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((yes) => { resolve = yes; });
    return { promise, resolve };
}

function harness() {
    // Unconnected real socket used only to check ownership/destruction.
    // The reader double does not claim TLS authentication.
    const socket = new TLSSocket(new Socket());
    const resolve = vi.fn<DirectoryFetchDependencies["resolve"]>(async () =>
        validateDirectoryAddresses(["1.1.1.1"], []));
    const direct = vi.fn<DirectoryFetchDependencies["direct"]>(async () => socket);
    const proxy = vi.fn<DirectoryFetchDependencies["proxy"]>(async () => socket);
    const read = vi.fn<DirectoryFetchDependencies["read"]>(async () => ({
        body: new Uint8Array([123, 125]), headers: [],
        requestStartedMonotonicMs: 0, responseReceivedMonotonicMs: 1,
        responseReceivedWallMs: 1800000000000,
    }));
    return { socket, resolve, direct, proxy, read };
}
const origin = "https://directory.agentsig.test";

describe("single-fetch orchestration with controlled phase dependencies", () => {
    it("default admission denies before DNS or either connector", async () => {
        const h = harness();
        try {
            await expect(fetchDirectoryOnce(origin, {}, h))
                .rejects.toMatchObject({ reason: "origin-denied" });
            expect(h.resolve).not.toHaveBeenCalled();
            expect(h.direct).not.toHaveBeenCalled();
            expect(h.proxy).not.toHaveBeenCalled();
        } finally { h.socket.destroy(); }
    });

    it.each(["allowlist", "open"] as const)("fetches through explicit %s admission", async (mode) => {
        const h = harness();
        const result = await fetchDirectoryOnce(origin, {
            mode, ...(mode === "allowlist" ? { allowedOrigins: [origin] } : {}),
        }, h);
        expect(result.body).toEqual(new Uint8Array([123, 125]));
        expect(h.resolve).toHaveBeenCalledTimes(1);
        expect(h.direct).toHaveBeenCalledTimes(1);
        expect(h.proxy).not.toHaveBeenCalled();
        expect(h.direct.mock.calls[0]![0]).toMatchObject({
            hostname: "directory.agentsig.test", address: "1.1.1.1", family: 4,
        });
        expect(h.read.mock.calls[0]![2]).toMatchObject({
            maxBodyBytes: 262144, maxHeaderBytes: 16384,
            bodyIdleMilliseconds: 500, headersMilliseconds: 1000,
        });
        expect(h.socket.destroyed).toBe(true);
    });

    it.each([
        { name: "private", v4: ["10.0.0.1"], v6: [] },
        { name: "mixed", v4: ["1.1.1.1"], v6: ["fd00::1"] },
    ])("rejects $name answers before contacting even an explicit proxy", async ({ v4, v6 }) => {
        const h = harness();
        h.resolve.mockImplementation(async () => validateDirectoryAddresses(v4, v6));
        try {
            await expect(fetchDirectoryOnce(origin, {
                mode: "open",
                proxy: { protocol: "https:", hostname: "proxy.example", address: "127.0.0.1", port: 443 },
            }, h)).rejects.toMatchObject({ reason: "address-denied" });
            expect(h.direct).not.toHaveBeenCalled();
            expect(h.proxy).not.toHaveBeenCalled();
        } finally { h.socket.destroy(); }
    });

    it("selects configured proxy without falling back to direct on failure", async () => {
        const h = harness();
        h.proxy.mockRejectedValue(new Error("Controlled proxy failure"));
        try {
            await expect(fetchDirectoryOnce(origin, {
                mode: "open",
                proxy: { protocol: "https:", hostname: "proxy.example", address: "127.0.0.1", port: 443 },
            }, h)).rejects.toThrow("Controlled proxy failure");
            expect(h.proxy).toHaveBeenCalledTimes(1);
            expect(h.direct).not.toHaveBeenCalled();
            expect(h.read).not.toHaveBeenCalled();
        } finally { h.socket.destroy(); }
    });

    it("does not dial after cancellation while DNS is pending", async () => {
        const h = harness();
        const dns = deferred<Awaited<ReturnType<DirectoryFetchDependencies["resolve"]>>>();
        h.resolve.mockImplementation(() => dns.promise);
        const controller = new AbortController();
        const pending = fetchDirectoryOnce(origin, { mode: "open", signal: controller.signal }, h);
        const assertion = expect(pending).rejects.toMatchObject({ reason: "aborted" });
        controller.abort();
        await assertion;
        dns.resolve(validateDirectoryAddresses(["1.1.1.1"], []));
        await Promise.resolve();
        expect(h.direct).not.toHaveBeenCalled();
        expect(h.proxy).not.toHaveBeenCalled();
        h.socket.destroy();
    });

    it("destroys a connector socket arriving after cancellation", async () => {
        const h = harness();
        const connecting = deferred<TLSSocket>();
        const entered = deferred<void>();
        h.direct.mockImplementation(() => { entered.resolve(); return connecting.promise; });
        const controller = new AbortController();
        const pending = fetchDirectoryOnce(origin, { mode: "open", signal: controller.signal }, h);
        const assertion = expect(pending).rejects.toMatchObject({ reason: "aborted" });
        await entered.promise;
        controller.abort();
        await assertion;
        connecting.resolve(h.socket);
        await Promise.resolve();
        expect(h.socket.destroyed).toBe(true);
        expect(h.read).not.toHaveBeenCalled();
    });

    it("total deadline bounds a resolver double that never settles", async () => {
        const h = harness();
        const dns = deferred<Awaited<ReturnType<DirectoryFetchDependencies["resolve"]>>>();
        h.resolve.mockImplementation(() => dns.promise);
        try {
            await expect(fetchDirectoryOnce(origin, { mode: "open", totalMilliseconds: 30 }, h))
                .rejects.toMatchObject({ reason: "total-timeout" });
            dns.resolve(validateDirectoryAddresses(["1.1.1.1"], []));
            await Promise.resolve();
            expect(h.direct).not.toHaveBeenCalled();
        } finally { h.socket.destroy(); }
    });

    it.each([0, -1, 0.5, 3001, Infinity, NaN])("rejects invalid total budget %s", async (totalMilliseconds) => {
        const h = harness();
        try {
            await expect(fetchDirectoryOnce(origin, { mode: "open", totalMilliseconds }, h))
                .rejects.toMatchObject({ code: "invalid-resource-limits" });
            expect(h.resolve).not.toHaveBeenCalled();
        } finally { h.socket.destroy(); }
    });
});