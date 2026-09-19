import { EventEmitter } from "node:events";
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ tcp: vi.fn(), tls: vi.fn() }));
vi.mock("node:net", async (original) => ({
    ...await original<typeof import("node:net")>(), connect: mocks.tcp,
}));
vi.mock("node:tls", async (original) => ({
    ...await original<typeof import("node:tls")>(), connect: mocks.tls,
}));

import { connectPinnedDirectoryTls } from "../src/discovery/pinned-tls.js";
import { createDirectoryAddressPolicy } from "../src/discovery/address-policy.js";

const certificate = new X509Certificate(readFileSync(new URL(
    "../../../tests/fixtures/m3-contract/tls/server-cert.pem", import.meta.url,
))).toLegacyObject();

class TestSocket extends EventEmitter {
    remoteAddress = "1.1.1.1";
    authorized = true;
    alpnProtocol: string | false = "http/1.1";
    destroyed = false;
    destroy = vi.fn(() => { this.destroyed = true; return this; });
    getPeerCertificate = vi.fn(() => certificate);
}
let raw: TestSocket;
let secure: TestSocket;
const options = () => ({
    hostname: "directory.agentsig.test", address: "1.1.1.1", family: 4 as const,
});
beforeEach(() => {
    vi.useFakeTimers();
    raw = new TestSocket();
    secure = new TestSocket();
    mocks.tcp.mockReset().mockReturnValue(raw);
    mocks.tls.mockReset().mockReturnValue(secure);
});
afterEach(() => {
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
});

describe("pinned direct TLS connector with controlled sockets", () => {
    it("dials one numeric pin, checks the peer first, and authenticates the original hostname", async () => {
        const pending = connectPinnedDirectoryTls(options());
        expect(mocks.tcp).toHaveBeenCalledExactlyOnceWith({
            host: "1.1.1.1", port: 443, family: 4, autoSelectFamily: false,
        });
        expect(mocks.tls).not.toHaveBeenCalled();
        raw.emit("connect");
        expect(mocks.tls).toHaveBeenCalledTimes(1);
        expect(mocks.tls.mock.calls[0]![0]).toMatchObject({
            socket: raw, servername: "directory.agentsig.test",
            rejectUnauthorized: true, ALPNProtocols: ["http/1.1"],
        });
        expect(mocks.tls.mock.calls[0]![0]).not.toHaveProperty("ca");
        secure.emit("secureConnect");
        expect(await pending).toBe(secure);
        expect(secure.destroy).not.toHaveBeenCalled();
    });

    it("rejects a mismatched TCP peer before initiating TLS", async () => {
        const pending = connectPinnedDirectoryTls(options());
        const assertion = expect(pending).rejects.toMatchObject({ reason: "peer-mismatch" });
        raw.remoteAddress = "127.0.0.1";
        raw.emit("connect");
        await assertion;
        expect(mocks.tls).not.toHaveBeenCalled();
        expect(raw.destroyed).toBe(true);
    });

    it.each(["10.0.0.1", "::ffff:1.1.1.1", "127.0.0.1"])(
        "rejects forbidden target %s without dialing", async (address) => {
            await expect(connectPinnedDirectoryTls({ ...options(), address }))
                .rejects.toMatchObject({ reason: "address-denied" });
            expect(mocks.tcp).not.toHaveBeenCalled();
        },
    );

    it("preserves a configured named exception through peer comparison", async () => {
        const policy = createDirectoryAddressPolicy(["pcp-anycast-v4"]);
        raw.remoteAddress = "::ffff:192.0.0.9";
        secure.remoteAddress = "::ffff:192.0.0.9";
        const pending = connectPinnedDirectoryTls({ ...options(), address: "192.0.0.9", policy });
        raw.emit("connect");
        secure.emit("secureConnect");
        expect(await pending).toBe(secure);
    });

    it.each(["unauthorized", "wrong-host", "wrong-alpn", "changed-peer"] as const)(
        "rejects TLS gate failure: %s", async (kind) => {
            const pending = connectPinnedDirectoryTls({
                ...options(),
                ...(kind === "wrong-host" ? { hostname: "wrong.agentsig.test" } : {}),
            });
            const assertion = expect(pending).rejects.toMatchObject({
                reason: kind === "changed-peer" ? "peer-mismatch" : "tls-failed",
            });
            raw.emit("connect");
            if (kind === "unauthorized") secure.authorized = false;
            if (kind === "wrong-alpn") secure.alpnProtocol = "h2";
            if (kind === "changed-peer") secure.remoteAddress = "8.8.8.8";
            secure.emit("secureConnect");
            await assertion;
            expect(secure.destroyed).toBe(true);
            expect(raw.destroyed).toBe(true);
        },
    );

    it("aborts before dialing", async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(connectPinnedDirectoryTls({ ...options(), signal: controller.signal }))
            .rejects.toMatchObject({ reason: "aborted" });
        expect(mocks.tcp).not.toHaveBeenCalled();
    });

    it("aborts during TLS and ignores late completion", async () => {
        const controller = new AbortController();
        const pending = connectPinnedDirectoryTls({ ...options(), signal: controller.signal });
        const assertion = expect(pending).rejects.toMatchObject({ reason: "aborted" });
        raw.emit("connect");
        controller.abort();
        secure.emit("secureConnect");
        await assertion;
        expect(raw.destroyed && secure.destroyed).toBe(true);
    });

    it("uses one deadline across TCP and TLS rather than renewing it", async () => {
        const pending = connectPinnedDirectoryTls({ ...options(), timeoutMilliseconds: 100 });
        const assertion = expect(pending).rejects.toMatchObject({ reason: "connect-timeout" });
        await vi.advanceTimersByTimeAsync(90);
        raw.emit("connect");
        await vi.advanceTimersByTimeAsync(10);
        await assertion;
        expect(raw.destroyed && secure.destroyed).toBe(true);
    });

    it("sanitizes connection and TLS errors without keeping backend messages", async () => {
        for (const phase of ["tcp", "tls"]) {
            const pending = connectPinnedDirectoryTls(options());
            const assertion = expect(pending).rejects.toMatchObject({
                reason: phase === "tcp" ? "connection-failed" : "tls-failed",
            });
            if (phase === "tls") raw.emit("connect");
            (phase === "tcp" ? raw : secure).emit("error", new Error("PRIVATE-MARKER"));
            await assertion;
            await expect(pending).rejects.not.toThrow("PRIVATE-MARKER");
        }
    });

    it("snapshots identity and trust configuration before asynchronous events", async () => {
        const input = { ...options(), ca: "explicit-test-ca" };
        const pending = connectPinnedDirectoryTls(input);
        input.hostname = "wrong.agentsig.test";
        input.address = "127.0.0.1";
        input.ca = "changed";
        raw.emit("connect");
        expect(mocks.tls.mock.calls[0]![0]).toMatchObject({
            servername: "directory.agentsig.test", ca: "explicit-test-ca",
        });
        secure.emit("secureConnect");
        expect(await pending).toBe(secure);
    });
});