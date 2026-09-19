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

describe("configuration snapshot before DNS and asynchronous work", () => {
    it("rejects an option accessor without executing it or starting DNS", async () => {
        const h = harness();
        let reads = 0;
        const options = Object.defineProperty({}, "mode", {
            get() { reads++; return "open"; },
        });
        try {
            await expect(fetchDirectoryOnce(origin, options, h))
                .rejects.toMatchObject({ code: "invalid-agent-binding" });
            expect(reads).toBe(0);
            expect(h.resolve).not.toHaveBeenCalled();
            expect(h.direct).not.toHaveBeenCalled();
        } finally { h.socket.destroy(); }
    });

    it("rejects nested proxy accessors before spreading them or starting DNS", async () => {
        const h = harness();
        let reads = 0;
        const proxy = Object.defineProperty({
            protocol: "https:" as const,
            hostname: "proxy.example",
            address: "127.0.0.1",
            port: 443,
        }, "address", {
            enumerable: true,
            get() { reads++; return "127.0.0.1"; },
        });
        try {
            await expect(fetchDirectoryOnce(origin, { mode: "open", proxy }, h))
                .rejects.toMatchObject({ code: "invalid-agent-binding" });
            expect(reads).toBe(0);
            expect(h.resolve).not.toHaveBeenCalled();
            expect(h.proxy).not.toHaveBeenCalled();
        } finally { h.socket.destroy(); }
    });

    it("rejects unsupported proxy fields before DNS even with a connector double", async () => {
        const h = harness();
        const proxy = {
            protocol: "https:" as const,
            hostname: "proxy.example",
            address: "127.0.0.1",
            port: 443,
            rejectUnauthorized: false,
        };
        try {
            await expect(fetchDirectoryOnce(origin, { mode: "open", proxy }, h))
                .rejects.toMatchObject({ code: "invalid-agent-binding" });
            expect(h.resolve).not.toHaveBeenCalled();
            expect(h.proxy).not.toHaveBeenCalled();
        } finally { h.socket.destroy(); }
    });

    it("rejects allowlist element accessors without executing them", async () => {
        const h = harness();
        let reads = 0;
        const allowedOrigins = [origin];
        Object.defineProperty(allowedOrigins, "0", {
            get() { reads++; return origin; },
        });
        try {
            await expect(fetchDirectoryOnce(origin, { allowedOrigins }, h))
                .rejects.toMatchObject({ code: "invalid-agent-binding" });
            expect(reads).toBe(0);
            expect(h.resolve).not.toHaveBeenCalled();
        } finally { h.socket.destroy(); }
    });

    it("isolates proxy, CA and allowlist configuration from mutation during DNS", async () => {
        const h = harness();
        const dns = deferred<Awaited<ReturnType<DirectoryFetchDependencies["resolve"]>>>();
        h.resolve.mockImplementation(() => dns.promise);
        const proxy = {
            protocol: "https:" as const,
            hostname: "proxy.example",
            address: "127.0.0.1",
            port: 443,
            ca: "original-proxy-ca",
        };
        const options = {
            allowedOrigins: [origin],
            proxy,
            ca: "original-directory-ca",
        };
        try {
            const pending = fetchDirectoryOnce(origin, options, h);
            expect(h.resolve).toHaveBeenCalledTimes(1);
            proxy.hostname = "changed.example";
            proxy.address = "10.0.0.1";
            proxy.port = 8443;
            proxy.ca = "changed-proxy-ca";
            options.ca = "changed-directory-ca";
            options.allowedOrigins.length = 0;
            dns.resolve(validateDirectoryAddresses(["1.1.1.1"], []));
            await pending;
            expect(h.direct).not.toHaveBeenCalled();
            expect(h.proxy).toHaveBeenCalledTimes(1);
            expect(h.proxy.mock.calls[0]![0]).toMatchObject({
                hostname: "directory.agentsig.test",
                address: "1.1.1.1",
                ca: "original-directory-ca",
            });
            expect(h.proxy.mock.calls[0]![1]).toEqual({
                protocol: "https:", hostname: "proxy.example",
                address: "127.0.0.1", port: 443, ca: "original-proxy-ca",
            });
            expect(Object.isFrozen(h.proxy.mock.calls[0]![1])).toBe(true);
        } finally { h.socket.destroy(); }
    });
});