import { createServer } from "node:https";
import { connect } from "node:net";
import { Resolver } from "node:dns/promises";
import { readFileSync } from "node:fs";
import {
    startDirectoryServer, directoryTestCertificate, directoryTestHostname,
} from "./directory-server.mjs";

const key = readFileSync(new URL("../fixtures/m3-contract/tls/server-key.pem", import.meta.url));

/**
 * REPOSITORY TEST INFRASTRUCTURE ONLY, never an npm export.
 *
 * Real HTTPS CONNECT and directory TLS, with deliberately controlled local DNS:
 * the test host resolves to 1.1.1.1, and our explicitly trusted test proxy routes
 * that numeric CONNECT target to the isolated loopback directory. This does NOT
 * prove public routing or direct target-peer observation. Production address
 * filtering, numeric CONNECT, Host/SNI and both TLS checks remain enabled.
 *
 * Only this process's Resolver prototype is temporarily modified. No OS DNS,
 * hosts file, system CA store or production private-address policy is changed.
 * Use in an isolated child process; always call close() in finally.
 */
export async function startPublicDiscoveryHarness() {
    const original4 = Resolver.prototype.resolve4;
    const original6 = Resolver.prototype.resolve6;
    let privateAnswer = false;
    let dnsQueries = 0;
    const connects = [];
    const sockets = new Set();
    const directory = await startDirectoryServer();
    const proxy = createServer({ key, cert: directoryTestCertificate });
    let closed;
    async function close() {
        if (!closed) {
            Resolver.prototype.resolve4 = original4;
            Resolver.prototype.resolve6 = original6;
            closed = (async () => {
                const stopping = proxy.listening
                    ? new Promise((resolve, reject) => proxy.close(error => error ? reject(error) : resolve()))
                    : Promise.resolve();
                for (const socket of sockets) socket.destroy();
                await Promise.all([stopping, directory.close()]);
            })();
        }
        return closed;
    }
    proxy.on("connection", socket => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
    });
    proxy.on("tlsClientError", () => { });
    proxy.on("connect", (request, stream, head) => {
        connects.push(request.url);
        stream.on("error", () => { });
        if (request.url !== "1.1.1.1:443" || head.length) {
            stream.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
            return;
        }
        const upstream = connect({ host: directory.address, port: directory.port });
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
    try {
        await new Promise((resolve, reject) => {
            proxy.once("error", reject);
            proxy.listen(0, "127.0.0.1", () => {
                proxy.removeListener("error", reject);
                resolve();
            });
        });
        const address = proxy.address();
        if (!address || typeof address === "string") throw new Error("Expected local proxy listener");
        // Refuse every unexpected query rather than contact external DNS.
        Resolver.prototype.resolve4 = async function (hostname) {
            dnsQueries++;
            if (hostname !== `${directoryTestHostname}.`) {
                throw Object.assign(new Error("Unexpected test DNS name"), { code: "ENOTFOUND" });
            }
            return [privateAnswer ? "10.0.0.1" : "1.1.1.1"];
        };
        Resolver.prototype.resolve6 = async function (hostname) {
            dnsQueries++;
            throw Object.assign(new Error("Controlled empty IPv6 family"), {
                code: hostname === `${directoryTestHostname}.` ? "ENODATA" : "ENOTFOUND",
            });
        };
        const ca = directoryTestCertificate.toString("utf8");
        return Object.freeze({
            origin: `https://${directoryTestHostname}`,
            network: Object.freeze({
                allowedOrigins: Object.freeze([`https://${directoryTestHostname}`]),
                ca,
                proxy: Object.freeze({
                    protocol: "https:", hostname: directoryTestHostname,
                    address: "127.0.0.1", port: address.port, ca,
                }),
            }),
            get requests() { return directory.requests; },
            get dnsQueries() { return dnsQueries; },
            get connectTargets() { return [...connects]; },
            setPrivateAnswer(value) { privateAnswer = value; },
            removeKeys() { directory.setMode("empty"); },
            close,
        });
    } catch (error) {
        await close();
        throw error;
    }
}