import { createServer } from "node:https";
import { connect as connectTcp } from "node:net";
import type { Duplex } from "node:stream";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { connectDirectoryThroughProxy } from "../src/discovery/proxy-tls.js";
import type { DirectoryHttpsProxy } from "../src/discovery/proxy-tls.js";
import { readDirectoryResponse } from "../src/discovery/directory-response.js";

const hostname = "directory.agentsig.test";
const ca = readFileSync(new URL(
    "../../../tests/fixtures/m3-contract/tls/server-cert.pem", import.meta.url,
), "utf8");
const key = readFileSync(new URL(
    "../../../tests/fixtures/m3-contract/tls/server-key.pem", import.meta.url,
));
type Mode = "tunnel" | "redirect" | "deny" | "head" | "stall";

/**
 * Deliberate test-only routing: CONNECT records a public numeric target but
 * tunnels to our isolated loopback server. This exercises nested TLS and HTTP,
 * NOT reachability of the requested public destination. The production client
 * trusts a configured proxy to honor CONNECT; it cannot inspect that remote hop.
 */
async function harness(mode: Mode = "tunnel") {
    const sockets = new Set<Duplex>();
    const connects: { target: string | undefined; host: string | undefined }[] = [];
    const requests: { host: string | undefined; path: string | undefined }[] = [];
    let proxyConnections = 0;
    const target = createServer({ key, cert: ca }, (request, response) => {
        requests.push({ host: request.headers.host, path: request.url });
        response.writeHead(200, {
            "Content-Type": "application/http-message-signatures-directory+json",
        });
        response.end('{"keys":[]}');
    });
    const proxy = createServer({ key, cert: ca });
    for (const server of [target, proxy]) {
        server.on("connection", (socket) => {
            sockets.add(socket);
            socket.once("close", () => sockets.delete(socket));
        });
        server.on("tlsClientError", () => { });
    }
    proxy.on("connection", () => { proxyConnections++; });
    async function listen(server: typeof target): Promise<number> {
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", () => {
                server.removeListener("error", reject);
                resolve();
            });
        });
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Expected TCP test listener");
        return address.port;
    }
    const targetPort = await listen(target);
    proxy.on("connect", (request, stream, head) => {
        connects.push({ target: request.url, host: request.headers.host });
        stream.on("error", () => { });
        if (mode === "stall") return;
        if (mode === "redirect" || mode === "deny") {
            stream.end(mode === "redirect"
                ? "HTTP/1.1 302 Found\r\nLocation: https://internal.example/\r\nContent-Length: 0\r\n\r\n"
                : "HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n");
            return;
        }
        if (mode === "head") {
            stream.write("HTTP/1.1 200 Connection Established\r\n\r\nUNEXPECTED");
            return;
        }
        const upstream = connectTcp({ host: "127.0.0.1", port: targetPort });
        sockets.add(upstream);
        upstream.once("close", () => sockets.delete(upstream));
        upstream.on("error", () => stream.destroy());
        stream.once("close", () => upstream.destroy());
        upstream.once("close", () => stream.destroy());
        upstream.once("connect", () => {
            stream.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            if (head.length) upstream.write(head);
            stream.pipe(upstream);
            upstream.pipe(stream);
        });
    });
    const port = await listen(proxy);
    const configuration: DirectoryHttpsProxy = {
        protocol: "https:", hostname, address: "127.0.0.1", port, ca,
    };
    return {
        configuration, connects, requests,
        get proxyConnections() { return proxyConnections; },
        async close() {
            const closing = [target, proxy].map((server) => new Promise<void>((resolve, reject) =>
                server.close((error) => error ? reject(error) : resolve())));
            for (const socket of sockets) socket.destroy();
            await Promise.all(closing);
        },
    };
}

const options = () => ({
    hostname, address: "1.1.1.1", family: 4 as const, ca, timeoutMilliseconds: 2000,
});

describe("explicit TLS CONNECT proxy with real nested TLS", () => {
    it.each([
        { address: "1.1.1.1", family: 4 as const, authority: "1.1.1.1:443" },
        { address: "2606:4700:4700::1111", family: 6 as const, authority: "[2606:4700:4700::1111]:443" },
    ])("sends numeric CONNECT for $address and preserves inner Host/TLS identity", async (pin) => {
        const h = await harness();
        try {
            const socket = await connectDirectoryThroughProxy({
                ...options(), address: pin.address, family: pin.family,
            }, h.configuration);
            expect(socket.authorized).toBe(true);
            const response = await readDirectoryResponse(socket, hostname, { remainingMilliseconds: 2000 });
            expect(Buffer.from(response.body).toString()).toBe('{"keys":[]}');
            expect(h.connects).toEqual([{ target: pin.authority, host: pin.authority }]);
            expect(h.requests).toEqual([{
                host: hostname, path: "/.well-known/http-message-signatures-directory",
            }]);
            expect(h.proxyConnections).toBe(1);
        } finally { await h.close(); }
    });

    it.each(["10.0.0.1", "127.0.0.1", "169.254.169.254"])(
        "rejects private target %s before contacting the configured proxy", async (address) => {
            const h = await harness();
            try {
                await expect(connectDirectoryThroughProxy({ ...options(), address }, h.configuration))
                    .rejects.toMatchObject({ reason: "address-denied" });
                expect(h.proxyConnections).toBe(0);
                expect(h.connects).toHaveLength(0);
            } finally { await h.close(); }
        },
    );

    it.each(["redirect", "deny", "head"] as const)(
        "rejects CONNECT %s without retry or direct fallback", async (mode) => {
            const h = await harness(mode);
            try {
                await expect(connectDirectoryThroughProxy(options(), h.configuration))
                    .rejects.toMatchObject({ reason: "connection-failed" });
                expect(h.connects).toHaveLength(1);
                expect(h.requests).toHaveLength(0);
                expect(h.proxyConnections).toBe(1);
            } finally { await h.close(); }
        },
    );

    it("does not trust the directory certificate merely because the proxy is trusted", async () => {
        const h = await harness();
        try {
            const { ca: omitted, ...targetOptions } = options();
            expect(omitted).toBe(ca);
            await expect(connectDirectoryThroughProxy(targetOptions, h.configuration))
                .rejects.toMatchObject({ reason: "tls-failed" });
            expect(h.requests).toHaveLength(0);
        } finally { await h.close(); }
    });

    it("checks the original directory hostname inside the tunnel", async () => {
        const h = await harness();
        try {
            await expect(connectDirectoryThroughProxy({
                ...options(), hostname: "wrong.agentsig.test",
            }, h.configuration)).rejects.toMatchObject({ reason: "tls-failed" });
            expect(h.requests).toHaveLength(0);
        } finally { await h.close(); }
    });

    it("checks the configured proxy certificate hostname before CONNECT", async () => {
        const h = await harness();
        try {
            await expect(connectDirectoryThroughProxy(options(), {
                ...h.configuration, hostname: "wrong.agentsig.test",
            })).rejects.toMatchObject({ reason: "connection-failed" });
            expect(h.connects).toHaveLength(0);
        } finally { await h.close(); }
    });

    it("bounds a proxy that never answers CONNECT", async () => {
        const h = await harness("stall");
        try {
            await expect(connectDirectoryThroughProxy({
                ...options(), timeoutMilliseconds: 200,
            }, h.configuration)).rejects.toMatchObject({ reason: "connect-timeout" });
            expect(h.requests).toHaveLength(0);
        } finally { await h.close(); }
    });

    it("aborts before opening a proxy connection", async () => {
        const h = await harness();
        const controller = new AbortController();
        controller.abort();
        try {
            await expect(connectDirectoryThroughProxy({
                ...options(), signal: controller.signal,
            }, h.configuration)).rejects.toMatchObject({ reason: "aborted" });
            expect(h.proxyConnections).toBe(0);
        } finally { await h.close(); }
    });

    it("rejects unsupported protocols and TLS overrides as configuration errors", async () => {
        const h = await harness();
        try {
            for (const extra of [
                { protocol: "http:" }, { rejectUnauthorized: false },
                { checkServerIdentity: () => undefined }, { dispatcher: {} },
            ]) {
                expect(() => connectDirectoryThroughProxy(options(),
                    { ...h.configuration, ...extra } as DirectoryHttpsProxy))
                    .toThrow(expect.objectContaining({ code: "invalid-agent-binding" }));
            }
            expect(h.proxyConnections).toBe(0);
        } finally { await h.close(); }
    });
});