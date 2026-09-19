import { createServer } from "node:https";
import type { ServerResponse } from "node:http";
import { connect } from "node:tls";
import type { TLSSocket } from "node:tls";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { readDirectoryResponse } from "../src/discovery/directory-response.js";

const hostname = "directory.agentsig.test";
const certificate = readFileSync(new URL(
    "../../../tests/fixtures/m3-contract/tls/server-cert.pem", import.meta.url,
));
const key = readFileSync(new URL(
    "../../../tests/fixtures/m3-contract/tls/server-key.pem", import.meta.url,
));
const media = "application/http-message-signatures-directory+json";
const body = '{"keys":[]}';

// Real TLS reader tests, not public-address admission tests. The loopback dial
// is test code only and keeps certificate and hostname verification enabled.
async function harness(
    handler: (response: ServerResponse) => void,
    presetContentType = true,
) {
    const requests: { host: string | undefined; encoding: string | undefined; path: string | undefined }[] = [];
    const server = createServer({ key, cert: certificate }, (request, response) => {
        requests.push({
            host: request.headers.host,
            encoding: request.headers["accept-encoding"],
            path: request.url,
        });
        // Node 20 merges writeHead's array into previously set headers, losing
        // duplicate occurrences. Raw-header tests must bypass this preset so
        // the intended repeated fields actually reach the TLS wire unchanged.
        if (presetContentType) response.setHeader("Content-Type", media);
        handler(response);
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP test address");
    let socket: TLSSocket;
    try {
        socket = await new Promise<TLSSocket>((resolve, reject) => {
            const stream = connect({
                host: "127.0.0.1", port: address.port, servername: hostname,
                ca: certificate, rejectUnauthorized: true, ALPNProtocols: ["http/1.1"],
            });
            stream.once("error", reject);
            stream.once("secureConnect", () => resolve(stream));
        });
    } catch (error) {
        server.closeAllConnections();
        server.close();
        throw error;
    }
    return {
        socket, requests,
        async close() {
            socket.destroy();
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) =>
                server.close((error) => error ? reject(error) : resolve()));
        },
    };
}

describe("bounded directory reader over real, explicitly trusted local TLS", () => {
    it("uses the supplied authenticated socket and sends the fixed directory request", async () => {
        const h = await harness((response) => {
            response.setHeader("Cache-Control", "max-age=60");
            response.end(body);
        });
        try {
            const result = await readDirectoryResponse(h.socket, hostname, { remainingMilliseconds: 2000 });
            expect(Buffer.from(result.body).toString()).toBe(body);
            expect(result.headers).toContainEqual(["cache-control", "max-age=60"]);
            expect(h.requests).toEqual([{
                host: hostname, encoding: "identity",
                path: "/.well-known/http-message-signatures-directory",
            }]);
            expect(result.responseReceivedMonotonicMs).toBeGreaterThanOrEqual(result.requestStartedMonotonicMs);
            expect(h.socket.destroyed).toBe(true);
        } finally { await h.close(); }
    });

    for (const status of [301, 302, 307, 304, 401, 503]) {
        it(`rejects HTTP ${status} without following or retrying`, async () => {
            const h = await harness((response) => {
                response.writeHead(status, { Location: "https://internal.example/" });
                response.end();
            });
            try {
                await expect(readDirectoryResponse(h.socket, hostname, { remainingMilliseconds: 2000 }))
                    .rejects.toMatchObject({ reason: "status-rejected" });
                expect(h.requests).toHaveLength(1);
                expect(h.socket.destroyed).toBe(true);
            } finally { await h.close(); }
        });
    }

    it("rejects compressed bytes without decoding them", async () => {
        const h = await harness((response) => {
            response.setHeader("Content-Encoding", "gzip");
            response.end(gzipSync(body));
        });
        try {
            await expect(readDirectoryResponse(h.socket, hostname, { remainingMilliseconds: 2000 }))
                .rejects.toMatchObject({ reason: "encoding-rejected" });
        } finally { await h.close(); }
    });

    it("rejects a wrong media type", async () => {
        const h = await harness((response) => {
            response.setHeader("Content-Type", "text/plain");
            response.end(body);
        });
        try {
            await expect(readDirectoryResponse(h.socket, hostname, { remainingMilliseconds: 2000 }))
                .rejects.toMatchObject({ reason: "media-type-rejected" });
        } finally { await h.close(); }
    });

    it("enforces the streaming body limit without Content-Length", async () => {
        const h = await harness((response) => {
            response.write(" ".repeat(65));
            response.end(body);
        });
        try {
            await expect(readDirectoryResponse(h.socket, hostname, {
                remainingMilliseconds: 2000, maxBodyBytes: 64,
            })).rejects.toMatchObject({ reason: "response-limit" });
            expect(h.socket.destroyed).toBe(true);
        } finally { await h.close(); }
    });

    it("accepts the exact body-size boundary", async () => {
        const h = await harness((response) => response.end(body));
        try {
            const result = await readDirectoryResponse(h.socket, hostname, {
                remainingMilliseconds: 2000, maxBodyBytes: Buffer.byteLength(body),
            });
            expect(result.body.byteLength).toBe(Buffer.byteLength(body));
        } finally { await h.close(); }
    });

    it("rejects oversized response headers", async () => {
        const h = await harness((response) => {
            response.setHeader("X-Large", "x".repeat(2048));
            response.end(body);
        });
        try {
            await expect(readDirectoryResponse(h.socket, hostname, {
                remainingMilliseconds: 2000, maxHeaderBytes: 512,
            })).rejects.toMatchObject({ reason: "response-limit" });
        } finally { await h.close(); }
    });

    it("destroys a stalled response on the idle deadline", async () => {
        const h = await harness((response) => { response.write(" "); });
        try {
            await expect(readDirectoryResponse(h.socket, hostname, {
                remainingMilliseconds: 2000, bodyIdleMilliseconds: 100,
            })).rejects.toMatchObject({ reason: "response-timeout" });
            expect(h.socket.destroyed).toBe(true);
        } finally { await h.close(); }
    });

    it("does not renew the total deadline on a drip feed", async () => {
        const h = await harness((response) => {
            response.write(" ");
            const timer = setInterval(() => response.write(" "), 20);
            response.once("close", () => clearInterval(timer));
        });
        try {
            await expect(readDirectoryResponse(h.socket, hostname, {
                remainingMilliseconds: 200, bodyIdleMilliseconds: 1000,
            })).rejects.toMatchObject({ reason: "response-timeout" });
        } finally { await h.close(); }
    });

    it("aborts before sending HTTP bytes", async () => {
        const h = await harness((response) => response.end(body));
        const controller = new AbortController();
        controller.abort();
        try {
            await expect(readDirectoryResponse(h.socket, hostname, {
                remainingMilliseconds: 2000, signal: controller.signal,
            })).rejects.toMatchObject({ reason: "aborted" });
            expect(h.requests).toHaveLength(0);
            expect(h.socket.destroyed).toBe(true);
        } finally { await h.close(); }
    });
});

describe("response header occurrence preservation", () => {
    it("does not lose a trailing encoding field after many small headers", async () => {
        const h = await harness((response) => {
            const headers = ["Content-Type", media];
            for (let index = 0; index < 2100; index++) headers.push("X", "a");
            headers.push("Content-Encoding", "gzip");
            response.writeHead(200, headers);
            response.end(gzipSync(body));
        }, false);
        try {
            // The complete header section fits the approved 16 KiB budget.
            // Node's default count limit must not hide security-relevant fields.
            await expect(readDirectoryResponse(h.socket, hostname, {
                remainingMilliseconds: 2000,
            })).rejects.toMatchObject({ reason: "encoding-rejected" });
        } finally { await h.close(); }
    });
});

describe("security-relevant fields beyond the default header-count boundary", () => {
    it("preserves late restrictive cache directives and all occurrences", async () => {
        const h = await harness((response) => {
            const headers = ["Content-Type", media, "Cache-Control", "max-age=300"];
            for (let index = 0; index < 2100; index++) headers.push("X", "a");
            headers.push("Cache-Control", "no-store", "Age", "120");
            response.writeHead(200, headers);
            response.end(body);
        }, false);
        try {
            const result = await readDirectoryResponse(h.socket, hostname, {
                remainingMilliseconds: 2000,
            });
            expect(result.headers.filter(([name]) => name === "x")).toHaveLength(2100);
            expect(result.headers.filter(([name]) => name === "cache-control")).toEqual([
                ["cache-control", "max-age=300"], ["cache-control", "no-store"],
            ]);
            expect(result.headers).toContainEqual(["age", "120"]);
        } finally { await h.close(); }
    });

    for (const [name, value, reason] of [
        ["Content-Encoding", "identity", "encoding-rejected"],
        ["Content-Type", media, "media-type-rejected"],
    ] as const) {
        it(`rejects a late duplicate ${name} rather than hiding it`, async () => {
            const h = await harness((response) => {
                const headers = ["Content-Type", media, "Content-Encoding", "identity"];
                for (let index = 0; index < 2100; index++) headers.push("X", "a");
                headers.push(name, value);
                response.writeHead(200, headers);
                response.end(body);
            }, false);
            try {
                await expect(readDirectoryResponse(h.socket, hostname, {
                    remainingMilliseconds: 2000,
                })).rejects.toMatchObject({ reason });
            } finally { await h.close(); }
        });
    }
});