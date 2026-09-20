import { connect } from "node:net";
import { connect as connectTls } from "node:tls";
import type { AddressInfo } from "node:net";
import type { IncomingMessage, Server } from "node:http";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeHttpMapper } from "../src/http/node-mapper.js";
import type { HttpMappingResult } from "../src/http/types.js";

const servers: Server[] = [];
afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close(error => error ? reject(error) : resolve());
    })));
});

async function listen(server: Server): Promise<number> {
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    return (server.address() as AddressInfo).port;
}

function send(port: number, pieces: readonly string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        const socket = connect(port, "127.0.0.1");
        let response = "";
        socket.setEncoding("latin1");
        socket.setTimeout(3000, () => socket.destroy(new Error("Test socket timeout")));
        socket.on("data", chunk => { response += chunk; });
        socket.on("error", reject);
        socket.on("close", () => resolve(response));
        socket.once("connect", () => {
            let index = 0;
            const next = (): void => {
                if (index === pieces.length) return;
                socket.write(pieces[index++]!, "latin1", () => { setImmediate(next); });
            };
            next();
        });
    });
}

const options = { ingress: { allowedOrigins: ["http://merchant.example"] } };
const wire = "GET /a/%2E/../b?q=+&q=%20 HTTP/1.1\r\nHost: merchant.example\r\nConnection: close\r\n\r\n";

describe("owned Node HTTP/1.1 capture over real loopback TCP", () => {
    it("maps before downstream mutation and returns detached original views", async () => {
        const mapper = createNodeHttpMapper(options);
        let before: HttpMappingResult | undefined;
        let after: HttpMappingResult | undefined;
        const port = await listen(mapper.createServer((request, response) => {
            before = mapper.map(request);
            request.url = "/rewritten";
            request.rawHeaders.splice(0, request.rawHeaders.length, "Host", "forged.example");
            after = mapper.map(request);
            response.end();
        }));
        expect(await send(port, [wire])).toContain("200 OK");
        expect(after).toEqual(before);
        expect(before).toMatchObject({
            status: "mapped",
            request: {
                targetUri: "http://merchant.example/a/%2E/../b?q=+&q=%20",
                rawRequestTarget: "/a/%2E/../b?q=+&q=%20",
                headers: [["Host", "merchant.example"], ["Connection", "close"]],
            },
        });
    });

    it("preserves obs-text bytes without exposing owned mutable storage", async () => {
        const mapper = createNodeHttpMapper(options);
        let latest: HttpMappingResult | undefined;
        const port = await listen(mapper.createServer((request, response) => {
            const first = mapper.map(request);
            if (first.status === "mapped") {
                const value = first.request.headers[1]![1];
                if (value instanceof Uint8Array) value.fill(0);
            }
            latest = mapper.map(request);
            response.end();
        }));
        await send(port, ["GET / HTTP/1.1\r\nHost: merchant.example\r\nX-Raw: \x80\xe9\xff\r\nConnection: close\r\n\r\n"]);
        if (latest?.status !== "mapped") throw new Error("Expected mapped request");
        expect(latest.request.headers[1]![1]).toEqual(Uint8Array.from([128, 233, 255]));
    });

    it("captures a late duplicate Host across fragmented headers without truncation", async () => {
        const mapper = createNodeHttpMapper(options);
        let result: HttpMappingResult | undefined;
        const port = await listen(mapper.createServer((request, response) => {
            expect(request.rawHeaders.length).toBe(4206);
            result = mapper.map(request);
            response.end();
        }));
        const pieces = [
            "GET / HTTP/1.1\r\nHost: merchant.example\r\n",
            "X: a\r\n".repeat(1050),
            "X: a\r\n".repeat(1050),
            "host: other.example\r\nConnection: close\r\n\r\n",
        ];
        await send(port, pieces);
        expect(result).toEqual({ status: "mapping-rejected", code: "host-ambiguous" });
    });

    it("does not reconstruct missing capture or accept capture from another mapper", async () => {
        const first = createNodeHttpMapper(options);
        const second = createNodeHttpMapper(options);
        let result: HttpMappingResult | undefined;
        const port = await listen(first.createServer((request, response) => {
            result = second.map(request);
            response.end();
        }));
        await send(port, [wire]);
        expect(result).toEqual({ status: "mapping-rejected", code: "capture-missing" });
        expect(first.map({ httpVersion: "2.0" } as IncomingMessage)).toEqual({
            status: "mapping-rejected", code: "http2-unsupported",
        });
    });

    it("refuses forged request dispatch without an owned socket", async () => {
        const mapper = createNodeHttpMapper(options);
        let result: HttpMappingResult | undefined;
        const server = mapper.createServer((request) => { result = mapper.map(request); });
        await listen(server);
        const fake = { httpVersionMajor: 1, socket: {} } as IncomingMessage;
        server.emit("request", fake, {});
        expect(result).toEqual({ status: "mapping-rejected", code: "capture-incomplete" });
    });

    it("locks parser completeness settings before accepting connections", async () => {
        const mapper = createNodeHttpMapper(options);
        const server = mapper.createServer((_request, response) => response.end());
        await listen(server);
        expect(server.maxHeadersCount).toBe(16384);
        expect(() => { server.maxHeadersCount = 1; }).toThrow(TypeError);
        expect(() => Object.defineProperty(server, "maxHeaderSize", { value: 1 })).toThrow(TypeError);
    });

    const fixture = JSON.parse(readFileSync(new URL(
        "../../../tests/fixtures/m4-http/mapping-cases.json", import.meta.url,
    ), "utf8")) as { parserCases: { id: string; wireLatin1: string; expectedDefaultStatus: number }[] };
    for (const entry of fixture.parserCases) {
        it(`Node default parser rejection before capture: ${entry.id}`, async () => {
            const mapper = createNodeHttpMapper(options);
            let calls = 0;
            const port = await listen(mapper.createServer((_request, response) => {
                calls++;
                response.end();
            }));
            const response = await send(port, [entry.wireLatin1]);
            expect(response).toContain(`HTTP/1.1 ${entry.expectedDefaultStatus} `);
            expect(calls).toBe(0);
        });
    }

    it("reports parser errors through clientError only when the application owns that event", async () => {
        const mapper = createNodeHttpMapper(options);
        let captures = 0;
        let events = 0;
        const server = mapper.createServer((_request, response) => { captures++; response.end(); });
        server.on("clientError", (_error, socket) => {
            // Deliberately do not retain/log the error or raw packet.
            events++;
            socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        });
        const port = await listen(server);
        await send(port, [fixture.parserCases[1]!.wireLatin1]);
        expect(events).toBe(1);
        expect(captures).toBe(0);
    });

    it("captures HTTPS over real TLS with certificate and hostname validation", async () => {
        const tlsRoot = new URL("../../../tests/fixtures/m3-contract/tls/", import.meta.url);
        const cert = readFileSync(new URL("server-cert.pem", tlsRoot));
        const key = readFileSync(new URL("server-key.pem", tlsRoot));
        const mapper = createNodeHttpMapper({
            ingress: { allowedOrigins: ["https://merchant.example"] },
        });
        let result: HttpMappingResult | undefined;
        const port = await listen(mapper.createSecureServer((request, response) => {
            result = mapper.map(request);
            response.end();
        }, { key, cert }));
        const response = await new Promise<string>((resolve, reject) => {
            const socket = connectTls({
                host: "127.0.0.1", port, ca: cert,
                servername: "directory.agentsig.test",
                ALPNProtocols: ["http/1.1"],
            });
            let output = "";
            socket.setEncoding("latin1");
            socket.setTimeout(3000, () => socket.destroy(new Error("Test TLS timeout")));
            socket.on("data", chunk => { output += chunk; });
            socket.on("error", reject);
            socket.on("close", () => resolve(output));
            socket.once("secureConnect", () => {
                expect(socket.authorized).toBe(true);
                expect(socket.alpnProtocol).toBe("http/1.1");
                socket.write(wire, "latin1");
            });
        });
        expect(response).toContain("200 OK");
        expect(result).toMatchObject({
            status: "mapped",
            targetSource: "direct",
            request: { targetUri: "https://merchant.example/a/%2E/../b?q=+&q=%20" },
        });
    });

    it.each([
        { trustedPeers: ["127.0.0.1/32"], expected: "mapped" },
        { trustedPeers: ["192.0.2.0/24"], expected: "ingress-peer-untrusted" },
    ])("uses actual socket peer for trusted ingress: $expected", async ({ trustedPeers, expected }) => {
        const mapper = createNodeHttpMapper({
            ingress: {
                mode: "trusted-ingress", family: "x-forwarded",
                allowedOrigins: ["https://merchant.example"], trustedPeers,
                sanitizingIngress: true,
            },
        });
        let result: HttpMappingResult | undefined;
        const port = await listen(mapper.createServer((request, response) => {
            result = mapper.map(request);
            response.end();
        }));
        await send(port, [
            "GET /%2f?x=+ HTTP/1.1\r\nHost: internal.example:8080\r\n" +
            "X-Forwarded-Host: merchant.example\r\nX-Forwarded-Proto: https\r\n" +
            "X-Forwarded-Port: 443\r\nX-Forwarded-For: 198.51.100.3\r\nConnection: close\r\n\r\n",
        ]);
        if (expected === "mapped") {
            expect(result).toMatchObject({
                status: "mapped", targetSource: "trusted-ingress",
                internalAuthority: "internal.example:8080",
                request: { targetUri: "https://merchant.example/%2f?x=+" },
                observedClient: {
                    kind: "ip", address: "198.51.100.3",
                    source: "trusted-ingress", authenticated: false,
                },
            });
        } else {
            expect(result).toEqual({ status: "mapping-rejected", code: expected });
        }
    });
});