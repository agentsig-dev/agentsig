import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createWebBotAuthSigner, SigningError } from "@agentsig/core/profiles";
import type { WebBotAuthProfile } from "@agentsig/core/profiles";
import { createSignedFetch } from "../src/index.js";
import type { SignedFetchInit } from "../src/index.js";

const root = new URL("../../../tests/fixtures/m4-fetch/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", root), "utf8")) as { vectors: string[] };
const negative = JSON.parse(readFileSync(new URL("negative-cases.json", root), "utf8")) as {
    collisions: { source: string; name: string; value: string; code: string }[];
    http: { input: string; allowedWithTestOption: boolean }[];
    transportResponses: { status: number }[];
};
const privateKey = createPrivateKey(readFileSync(new URL(
    "../../../tests/fixtures/m2/generated/public-test-private.pem", import.meta.url,
)));
const normalSigner = () => createWebBotAuthSigner({
    privateKey: generateKeyPairSync("ed25519").privateKey, agentOrigin: "https://agent.example",
});
const fakeTransport = (callback: (request: Request) => Response | Promise<Response>): typeof fetch =>
    async input => {
        if (!(input instanceof Request)) throw new Error("Expected an owned Request");
        return callback(input);
    };

describe("signed Fetch independent golden bytes and request ownership", () => {
    for (const id of manifest.vectors) {
        it(id, async () => {
            const vector = JSON.parse(readFileSync(new URL(`${id}/case.json`, root), "utf8")) as {
                profile: WebBotAuthProfile; clockMilliseconds: number; nonce: string;
                agentOrigin: string; bodyPolicy: "reject" | "allow-unverified";
                input: string; init: SignedFetchInit;
                expected: { method: string; url: string; body: string | null; unsignedHeaders: string[][] };
            };
            let signingCalls = 0;
            let transportCalls = 0;
            const signer = createWebBotAuthSigner({
                privateKey, profile: vector.profile, agentOrigin: vector.agentOrigin,
                allowTestKeys: true, clock: () => vector.clockMilliseconds,
                nonceGenerator: () => vector.nonce,
            });
            const response = new Response(null, { status: 204 });
            const signedFetch = createSignedFetch({
                signer: {
                    async sign(parts) {
                        signingCalls++;
                        expect(parts.method).toBe(vector.expected.method);
                        expect(parts.targetUri).toBe(vector.expected.url);
                        expect(parts.headers).toEqual(vector.expected.unsignedHeaders);
                        return signer.sign(parts);
                    }
                },
                bodyPolicy: vector.bodyPolicy,
                fetch: fakeTransport(async request => {
                    transportCalls++;
                    expect(request.method).toBe(vector.expected.method);
                    expect(request.url).toBe(vector.expected.url);
                    expect(request.redirect).toBe("manual");
                    const bytes = Buffer.from([...request.headers].map(([name, value]) =>
                        `${name}: ${value}`).join("\r\n"), "ascii");
                    expect(bytes.equals(readFileSync(new URL(`${id}/headers.bin`, root)))).toBe(true);
                    if (vector.expected.body === null) expect(request.body).toBeNull();
                    else expect(await request.text()).toBe(vector.expected.body);
                    return response;
                }),
            });
            expect(await signedFetch(vector.input, vector.init)).toBe(response);
            expect(signingCalls).toBe(1);
            expect(transportCalls).toBe(1);
        });
    }

    for (const collision of negative.collisions) {
        it(`rejects existing headers before override: ${collision.source}/${collision.name}/${collision.value.length}`, async () => {
            let signs = 0;
            let sends = 0;
            const signedFetch = createSignedFetch({
                signer: { async sign() { signs++; throw new Error("Must not sign"); } },
                fetch: fakeTransport(() => { sends++; return new Response(); }),
            });
            const input = collision.source === "init" ? "https://merchant.example/" :
                new Request("https://merchant.example/", { headers: [[collision.name, collision.value]] });
            const init = collision.source === "init"
                ? { headers: [[collision.name, collision.value]] as [string, string][] } : { headers: {} };
            await expect(signedFetch(input, init)).rejects.toMatchObject({
                name: "SigningError", code: "existing-signature-headers",
            });
            expect(signs).toBe(0);
            expect(sends).toBe(0);
        });
    }

    for (const entry of negative.http) {
        it(`exact HTTP test exception: ${entry.input}`, async () => {
            let sends = 0;
            const options = { signer: normalSigner(), fetch: fakeTransport(() => { sends++; return new Response(); }) };
            await expect(createSignedFetch(options)(entry.input)).rejects.toBeInstanceOf(TypeError);
            const allowed = createSignedFetch({ ...options, allowHttpLoopbackForTests: true })(entry.input);
            if (entry.allowedWithTestOption) await expect(allowed).resolves.toBeInstanceOf(Response);
            else await expect(allowed).rejects.toBeInstanceOf(TypeError);
            expect(sends).toBe(entry.allowedWithTestOption ? 1 : 0);
        });
    }

    for (const { status } of negative.transportResponses) {
        it(`returns status ${status} without retry or follow`, async () => {
            const actual = normalSigner();
            let signs = 0;
            let sends = 0;
            const response = new Response(null, { status, headers: { location: "https://other.example/" } });
            const signedFetch = createSignedFetch({
                signer: { async sign(parts) { signs++; return actual.sign(parts); } },
                fetch: fakeTransport(request => {
                    sends++;
                    expect(request.redirect).toBe("manual");
                    return response;
                }),
            });
            expect(await signedFetch("https://merchant.example/")).toBe(response);
            expect([signs, sends]).toEqual([1, 1]);
        });
    }

    it("constructs fresh owned requests and signatures for repeated explicit sends", async () => {
        const requests: Request[] = [];
        const source = new Request("https://merchant.example/items");
        const signedFetch = createSignedFetch({
            signer: normalSigner(),
            fetch: fakeTransport(request => { requests.push(request); return new Response(); }),
        });
        await signedFetch(source);
        await signedFetch(source);
        expect(requests[0]).not.toBe(source);
        expect(requests[1]).not.toBe(requests[0]);
        expect(requests[0]!.headers.get("signature-input")).not.toBe(requests[1]!.headers.get("signature-input"));
        expect(requests[0]!.headers.get("signature")).not.toBe(requests[1]!.headers.get("signature"));
        expect(source.headers.has("signature")).toBe(false);
        expect(source.redirect).toBe("follow");
    });

    it("owns header/URL state across awaited signing and descriptor mutation", async () => {
        const actual = normalSigner();
        const headers = new Headers({ "x-example": "original" });
        const url = new URL("https://merchant.example/items");
        const signedFetch = createSignedFetch({
            signer: {
                async sign(parts) {
                    const result = await actual.sign(parts);
                    headers.set("x-example", "mutated");
                    url.pathname = "/mutated";
                    (parts as { targetUri: string }).targetUri = "https://forged.example/";
                    return result;
                }
            },
            fetch: fakeTransport(request => {
                expect(request.url).toBe("https://merchant.example/items");
                expect(request.headers.get("x-example")).toBe("original");
                return new Response();
            }),
        });
        await signedFetch(url, { headers });
    });

    it.each(["follow", "error"] as const)("rejects explicit redirect %s before signing", async redirect => {
        let signs = 0;
        const signedFetch = createSignedFetch({ signer: { async sign() { signs++; throw new Error(); } } });
        await expect(signedFetch("https://merchant.example/", { redirect })).rejects.toBeInstanceOf(TypeError);
        expect(signs).toBe(0);
    });

    it.each(["Host", "Connection", "Content-Length", "Transfer-Encoding", "Proxy-Authorization", "Upgrade"])(
        "rejects transport override %s even when init could hide it", async name => {
            const signedFetch = createSignedFetch({ signer: normalSigner() });
            const source = new Request("https://merchant.example/", { headers: { [name]: "value" } });
            await expect(signedFetch(source, { headers: {} })).rejects.toBeInstanceOf(TypeError);
        },
    );

    it.each(["", "payload"])("rejects explicit body by default without disturbing it", async body => {
        let signs = 0;
        const signedFetch = createSignedFetch({ signer: { async sign() { signs++; throw new Error(); } } });
        await expect(signedFetch("https://merchant.example/", { method: "POST", body })).rejects.toBeInstanceOf(TypeError);
        const source = new Request("https://merchant.example/", { method: "POST", body });
        await expect(signedFetch(source)).rejects.toBeInstanceOf(TypeError);
        expect(source.bodyUsed).toBe(false);
        expect(source.body?.locked).toBe(false);
        expect(signs).toBe(0);
    });

    it("forwards a body stream once without clone or tee, and rejects reused input", async () => {
        const stream = new ReadableStream<Uint8Array>({
            start(controller) { controller.enqueue(new TextEncoder().encode("payload")); controller.close(); },
        });
        Object.defineProperty(stream, "tee", { value: () => { throw new Error("Must not tee"); } });
        const source = new Request("https://merchant.example/", { method: "POST", body: stream, duplex: "half" } as SignedFetchInit);
        Object.defineProperty(source, "clone", { value: () => { throw new Error("Must not clone"); } });
        const signedFetch = createSignedFetch({
            signer: normalSigner(), bodyPolicy: "allow-unverified",
            fetch: fakeTransport(async request => { expect(await request.text()).toBe("payload"); return new Response(); }),
        });
        await signedFetch(source);
        await expect(signedFetch(source)).rejects.toBeInstanceOf(TypeError);
    });

    it("rejects locked streams", async () => {
        const stream = new ReadableStream();
        const reader = stream.getReader();
        const signedFetch = createSignedFetch({ signer: normalSigner(), bodyPolicy: "allow-unverified" });
        await expect(signedFetch("https://merchant.example/", {
            method: "POST", body: stream, duplex: "half",
        } as SignedFetchInit)).rejects.toBeInstanceOf(TypeError);
        reader.releaseLock();
    });

    it("aborts before signing and after signing without dispatch or raw reason", async () => {
        for (const early of [true, false]) {
            const controller = new AbortController();
            let signs = 0;
            let sends = 0;
            const actual = normalSigner();
            const signedFetch = createSignedFetch({
                signer: {
                    async sign(parts) {
                        signs++;
                        const patch = await actual.sign(parts);
                        controller.abort("PRIVATE-ABORT-REASON");
                        return patch;
                    }
                },
                fetch: fakeTransport(() => { sends++; return new Response(); }),
            });
            if (early) controller.abort("PRIVATE-ABORT-REASON");
            await expect(signedFetch("https://merchant.example/", { signal: controller.signal }))
                .rejects.toMatchObject({ name: "AbortError", message: "Signed Fetch request aborted" });
            expect(signs).toBe(early ? 0 : 1);
            expect(sends).toBe(0);
        }
    });

    it("sanitizes transport errors and does not retry", async () => {
        let calls = 0;
        const signedFetch = createSignedFetch({
            signer: normalSigner(), fetch: fakeTransport(() => { calls++; throw new Error("PRIVATE-TRANSPORT"); }),
        });
        const error = await signedFetch("https://merchant.example/").catch(error => error as Error);
        expect(error).toMatchObject({ name: "TypeError", message: "Signed Fetch transport failed" });
        expect(Object.hasOwn(error, "cause")).toBe(false);
        expect(calls).toBe(1);
    });

    it("preserves signer codes but not attached arbitrary causes", async () => {
        const signedFetch = createSignedFetch({
            signer: {
                async sign() {
                    throw Object.assign(new SigningError("clock-unavailable"), { cause: "PRIVATE" });
                }
            },
        });
        const error = await signedFetch("https://merchant.example/").catch(error => error as Error);
        expect(error).toMatchObject({ code: "clock-unavailable" });
        expect(Object.hasOwn(error, "cause")).toBe(false);
    });

    it("freezes default transport selection at factory creation", async () => {
        const original = globalThis.fetch;
        let first = 0;
        let second = 0;
        try {
            globalThis.fetch = fakeTransport(() => { first++; return new Response(); });
            const signedFetch = createSignedFetch({ signer: normalSigner() });
            globalThis.fetch = fakeTransport(() => { second++; throw new Error(); });
            await signedFetch("https://merchant.example/");
            expect([first, second]).toEqual([1, 0]);
        } finally { globalThis.fetch = original; }
    });

    it("documents serialized-object loopback admission without claiming original spelling", async () => {
        const signedFetch = createSignedFetch({
            signer: normalSigner(), allowHttpLoopbackForTests: true,
            fetch: fakeTransport(() => new Response()),
        });
        await expect(signedFetch("http://127.1/")).rejects.toBeInstanceOf(TypeError);
        await expect(signedFetch(new URL("http://127.1/"))).resolves.toBeInstanceOf(Response);
    });
});