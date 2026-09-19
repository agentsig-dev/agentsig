import { createServer } from "node:https";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { readFileSync } from "node:fs";
import { fetchDirectoryOnce } from "../src/discovery/fetch-directory.js";
import { validateDirectoryAddresses } from "../src/discovery/dns-resolution.js";
import { connectPinnedDirectoryTls } from "../src/discovery/pinned-tls.js";
import { connectDirectoryThroughProxy } from "../src/discovery/proxy-tls.js";
import { readDirectoryResponse } from "../src/discovery/directory-response.js";
import type { DirectoryHttpsProxy } from "../src/discovery/proxy-tls.js";

export const directoryHostname = "directory.agentsig.test";
export const directoryOrigin = `https://${directoryHostname}`;
const tlsRoot = new URL("../../../tests/fixtures/m3-contract/tls/", import.meta.url);
const ca = readFileSync(new URL("server-cert.pem", tlsRoot), "utf8");
const key = readFileSync(new URL("server-key.pem", tlsRoot));

/**
 * Real local HTTPS and TLS CONNECT, with explicit TEST-ONLY routing.
 * DNS answers are controlled and checked by the production address classifier.
 * The proxy records a public numeric CONNECT pin but routes to a loopback test
 * listener: this is not proof of public routing or direct target-peer pinning.
 * No production loopback exception, disabled TLS verification, or system trust
 * modification is introduced. Never export this helper in a published package.
 */
export async function startNetworkDirectory(initialKeys: readonly Record<string, unknown>[]) {
    let body = JSON.stringify({ keys: initialKeys });
    let addresses = ["1.1.1.1"];
    const sockets = new Set<Duplex>();
    const requests: { host: string | undefined; path: string | undefined }[] = [];
    const connectTargets: (string | undefined)[] = [];
    let dnsCalls = 0;
    const target = createServer({ key, cert: ca }, (request, response) => {
        requests.push({ host: request.headers.host, path: request.url });
        // No live wall Date: controlled cache-clock tests must not infer age
        // from the runner's wall clock. Freshness is explicitly sixty seconds.
        response.sendDate = false;
        response.writeHead(200, {
            "Content-Type": "application/http-message-signatures-directory+json",
            "Cache-Control": "max-age=60",
        });
        response.end(body);
    });
    const proxy = createServer({ key, cert: ca });
    for (const server of [target, proxy]) {
        server.on("connection", (socket) => {
            sockets.add(socket);
            socket.once("close", () => sockets.delete(socket));
        });
        server.on("tlsClientError", () => { });
    }
    async function listen(server: typeof target): Promise<number> {
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", () => {
                server.removeListener("error", reject);
                resolve();
            });
        });
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Expected local TCP listener");
        return address.port;
    }
    async function close(): Promise<void> {
        const pending = [target, proxy].map((server) => new Promise<void>((resolve, reject) => {
            if (!server.listening) { resolve(); return; }
            server.close((error) => error ? reject(error) : resolve());
        }));
        for (const socket of sockets) socket.destroy();
        await Promise.all(pending);
    }
    try {
        const targetPort = await listen(target);
        proxy.on("connect", (request, stream, head) => {
            connectTargets.push(request.url);
            stream.on("error", () => { });
            // Unexpected authority never routes anywhere, even in this test proxy.
            if (request.url !== "1.1.1.1:443" || head.length !== 0) {
                stream.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
                return;
            }
            const upstream = connect({ host: "127.0.0.1", port: targetPort });
            sockets.add(upstream);
            upstream.once("close", () => sockets.delete(upstream));
            upstream.on("error", () => stream.destroy());
            stream.once("close", () => upstream.destroy());
            upstream.once("close", () => stream.destroy());
            upstream.once("connect", () => {
                stream.write("HTTP/1.1 200 Connection Established\r\n\r\n");
                stream.pipe(upstream);
                upstream.pipe(stream);
            });
        });
        const port = await listen(proxy);
        const proxyConfiguration: DirectoryHttpsProxy = Object.freeze({
            protocol: "https:", hostname: directoryHostname, address: "127.0.0.1", port, ca,
        });
        const transport: typeof fetchDirectoryOnce = (origin, options) =>
            fetchDirectoryOnce(origin, options, {
                async resolve(hostname, _timeout, maximum, _factory, policy) {
                    dnsCalls++;
                    if (hostname !== directoryHostname) throw new Error("Unexpected test DNS query");
                    return validateDirectoryAddresses(addresses, [], maximum, policy);
                },
                direct: connectPinnedDirectoryTls,
                proxy: connectDirectoryThroughProxy,
                read: readDirectoryResponse,
            });
        return {
            network: { allowedOrigins: [directoryOrigin], proxy: proxyConfiguration, ca },
            transport, requests, connectTargets,
            get dnsCalls() { return dnsCalls; },
            setKeys(keys: readonly Record<string, unknown>[]) { body = JSON.stringify({ keys }); },
            setAddresses(values: readonly string[]) { addresses = [...values]; },
            close,
        };
    } catch (error) {
        await close();
        throw error;
    }
}