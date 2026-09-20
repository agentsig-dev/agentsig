import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createOfflineVerifier, createWebBotAuthSigner } from "@agentsig/core/profiles";
import type { RequestParts } from "@agentsig/core";
import { createSignedFetch } from "../src/index.js";

const servers: Server[] = [];
afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close(error => error ? reject(error) : resolve());
    })));
});
async function listen(server: Server): Promise<string> {
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
function signer() {
    return createWebBotAuthSigner({
        privateKey: generateKeyPairSync("ed25519").privateKey,
        agentOrigin: "https://agent.example",
    });
}

describe("native Fetch on explicit loopback test transport", () => {
    it("returns a same-origin redirect without reaching its destination", async () => {
        let first = 0;
        let destination = 0;
        let signs = 0;
        const actual = signer();
        const origin = await listen(createServer((request, response) => {
            if (request.url === "/start") {
                first++;
                response.writeHead(302, { Location: "/destination" });
            } else { destination++; response.statusCode = 200; }
            response.end();
        }));
        const signed = createSignedFetch({
            signer: { async sign(parts) { signs++; return actual.sign(parts); } },
            allowHttpLoopbackForTests: true,
        });
        const response = await signed(`${origin}/start`);
        expect(response.status).toBe(302);
        await response.arrayBuffer();
        expect([first, destination, signs]).toEqual([1, 0, 1]);
    });

    it.each([401, 429, 500, 503])("does not retry native status %s", async status => {
        let calls = 0;
        const origin = await listen(createServer((_request, response) => {
            calls++;
            response.writeHead(status);
            response.end();
        }));
        const signed = createSignedFetch({ signer: signer(), allowHttpLoopbackForTests: true });
        const response = await signed(origin);
        expect(response.status).toBe(status);
        await response.arrayBuffer();
        expect(calls).toBe(1);
    });

    it("native 421 resend preserves the signature and is rejected as replay", async () => {
        const { privateKey, publicKey } = generateKeyPairSync("ed25519");
        const verifier = createOfflineVerifier({
            jwks: { keys: [publicKey.export({ format: "jwk" })] }, scope: "fetch-native-421",
        });
        const actual = createWebBotAuthSigner({ privateKey, agentOrigin: "https://agent.example" });
        const signatures: string[] = [];
        const outcomes: string[] = [];
        let signs = 0;
        let origin = "";
        let serverFailure = false;
        origin = await listen(createServer((request, response) => {
            void (async () => {
                const signature = request.headers.signature;
                if (typeof signature !== "string") {
                    throw new Error("Expected one signature header value");
                }
                signatures.push(signature);
                const headers: [string, string][] = [];
                for (let i = 0; i < request.rawHeaders.length; i += 2) {
                    headers.push([request.rawHeaders[i]!, request.rawHeaders[i + 1]!]);
                }
                const parts: RequestParts = {
                    method: request.method!, targetUri: origin + request.url,
                    headers, httpVersion: "1.1",
                };
                const result = await verifier.verify(parts);
                outcomes.push(result.status === "verified" ? "verified" : result.reason);
                response.statusCode = signatures.length === 1 ? 421 : 401;
                response.end();
            })().catch(() => { serverFailure = true; response.statusCode = 500; response.end(); });
        }));
        const signed = createSignedFetch({
            signer: { async sign(parts) { signs++; return actual.sign(parts); } },
            allowHttpLoopbackForTests: true,
        });
        const response = await signed(`${origin}/probe`);
        await response.arrayBuffer();
        expect(serverFailure).toBe(false);
        expect(response.status).toBe(401);
        expect(signs).toBe(1);
        expect(outcomes).toEqual(["verified", "replay-detected"]);
        expect(signatures).toHaveLength(2);
        expect(signatures[0]).toBe(signatures[1]);
        expect(verifier.context.memoryRecords).toBe(1);
    });

    it("explicit identity-only POST forwards body without claiming its integrity", async () => {
        let payload = "";
        let receivedSignature = false;
        const origin = await listen(createServer((request, response) => {
            receivedSignature = typeof request.headers.signature === "string";
            request.setEncoding("utf8");
            request.on("data", chunk => { payload += chunk; });
            request.on("end", () => { response.end(); });
        }));
        const signed = createSignedFetch({
            signer: signer(), bodyPolicy: "allow-unverified", allowHttpLoopbackForTests: true,
        });
        const response = await signed(origin, { method: "POST", body: "identity-only-payload" });
        await response.arrayBuffer();
        expect(payload).toBe("identity-only-payload");
        expect(receivedSignature).toBe(true);
    });
});