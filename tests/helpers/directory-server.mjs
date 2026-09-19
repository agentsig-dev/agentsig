import { createServer } from "node:https";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const tlsRoot = new URL("../fixtures/m3-contract/tls/", import.meta.url);
const key = readFileSync(new URL("server-key.pem", tlsRoot));
export const directoryTestCertificate = readFileSync(new URL("server-cert.pem", tlsRoot));
export const directoryTestHostname = "directory.agentsig.test";
export const directoryPath = "/.well-known/http-message-signatures-directory";
const initialBody = readFileSync(new URL("../fixtures/m2/generated/jwks.json", import.meta.url));
const mediaType = "application/http-message-signatures-directory+json";
const modes = new Set([
    "valid", "empty", "redirect", "not-modified", "large",
    "slow", "drip", "compressed", "wrong-media-type", "malformed",
    "private-key", "too-many-keys", "unavailable",
]);

/**
 * Test server only. Not exported from any production package.
 *
 * Binding to loopback is intentional fixture isolation, not permission for a
 * production resolver to fetch private addresses. Transport-policy tests must
 * independently exercise address rejection before dialing this server.
 *
 * Clients must explicitly trust this public test certificate AND validate the
 * directoryTestHostname. Never disable certificate/hostname verification.
 * Test response modes are controlled locally, not by incoming request metadata.
 */
export async function startDirectoryServer() {
    let mode = "valid";
    let body = Buffer.from(initialBody);
    let cacheControl = "max-age=60";
    let requests = 0;
    let activeResponses = 0;
    let maximumActiveResponses = 0;
    const sockets = new Set();
    const timers = new Set();
    const server = createServer({ key, cert: directoryTestCertificate }, (request, response) => {
        requests++;
        activeResponses++;
        maximumActiveResponses = Math.max(maximumActiveResponses, activeResponses);
        const responseTimers = new Set();
        response.once("close", () => {
            activeResponses--;
            for (const timer of responseTimers) {
                clearTimeout(timer);
                timers.delete(timer);
            }
        });
        function later(callback, milliseconds) {
            const timer = setTimeout(() => {
                timers.delete(timer);
                responseTimers.delete(timer);
                if (!response.destroyed) callback();
            }, milliseconds);
            timers.add(timer);
            responseTimers.add(timer);
        }
        if (request.method !== "GET" || request.url !== directoryPath) {
            response.writeHead(404);
            response.end();
            return;
        }
        // Snapshot mode/body for the request; later rotation affects new fetches.
        const selected = mode;
        const payload = Buffer.from(body);
        response.setHeader("Content-Type", mediaType);
        response.setHeader("Cache-Control", cacheControl);
        if (selected === "redirect") {
            response.writeHead(302, { Location: "https://internal.example/" });
            response.end();
        } else if (selected === "not-modified") {
            response.writeHead(304);
            response.end();
        } else if (selected === "unavailable") {
            response.writeHead(503, { "Retry-After": "60" });
            response.end();
        } else if (selected === "empty") {
            response.end('{"keys":[]}');
        } else if (selected === "large") {
            // No Content-Length: clients must enforce the streaming byte limit.
            response.writeHead(200);
            response.write(" ".repeat(262145));
            response.end(payload);
        } else if (selected === "slow") {
            response.writeHead(200);
            response.write(" ");
            later(() => response.end(payload), 1000);
        } else if (selected === "drip") {
            response.writeHead(200);
            const drip = () => {
                response.write(" ");
                later(drip, 100);
            };
            drip(); // Continues until the client or test teardown closes it.
        } else if (selected === "compressed") {
            response.setHeader("Content-Encoding", "gzip");
            response.end(gzipSync(payload));
        } else if (selected === "wrong-media-type") {
            response.setHeader("Content-Type", "text/plain");
            response.end(payload);
        } else if (selected === "malformed") {
            response.end('{"keys":[');
        } else if (selected === "private-key") {
            response.end('{"keys":[{"kty":"oct","k":"cHVibGljLXRlc3Q"}]}');
        } else if (selected === "too-many-keys") {
            const entry = JSON.parse(initialBody).keys[0];
            response.end(JSON.stringify({ keys: Array.from({ length: 65 }, () => entry) }));
        } else {
            response.end(payload);
        }
    });
    server.on("connection", (socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
    });
    server.on("tlsClientError", () => {
        // Invalid trust/hostname tests may abort TLS; do not log request data.
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            server.removeListener("error", reject);
            resolve();
        });
    });
    const address = server.address();
    let closing;
    return Object.freeze({
        hostname: directoryTestHostname,
        address: "127.0.0.1",
        port: address.port,
        path: directoryPath,
        get requests() { return requests; },
        get maximumActiveResponses() { return maximumActiveResponses; },
        setMode(value) {
            if (!modes.has(value)) throw new Error("Unknown directory test mode");
            mode = value;
        },
        setBody(value) {
            if (typeof value !== "string" && !(value instanceof Uint8Array)) {
                throw new TypeError("Test directory body must be text or bytes");
            }
            body = Buffer.from(value);
        },
        setCacheControl(value) {
            if (typeof value !== "string" || /[\r\n]/.test(value)) {
                throw new TypeError("Invalid test cache-control value");
            }
            cacheControl = value;
        },
        close() {
            if (!closing) {
                closing = new Promise((resolve, reject) => {
                    server.close((error) => error ? reject(error) : resolve());
                    for (const timer of timers) clearTimeout(timer);
                    timers.clear();
                    for (const socket of sockets) socket.destroy();
                });
            }
            return closing;
        },
    });
}