import { Buffer } from "node:buffer";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { getParameter } from "@agentsig/structured-fields";
import { parseSignatureHeaders } from "../src/signature-input.js";
import { verifyHttpSignatureCryptography } from "../src/crypto.js";
import type { RequestParts } from "../src/types.js";
import type { WebBotAuthProfile } from "../src/profiles/agent-header.js";
import { createWebBotAuthSigner } from "../src/profiles/signer.js";
import type { SigningOptions } from "../src/profiles/signing-config.js";
import { SigningError } from "../src/profiles/signing-errors.js";

const root = new URL("../../../tests/fixtures/signing/", import.meta.url);
const privateKey = createPrivateKey(readFileSync(new URL(
    "../../../tests/fixtures/m2/generated/public-test-private.pem", import.meta.url,
)));
const publicKey = createPublicKey(privateKey);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", root), "utf8")) as {
    vectors: string[];
};
interface Golden {
    profile: WebBotAuthProfile;
    label: string;
    agentOrigin: string;
    request: RequestParts;
    clockMilliseconds: number;
    nonce: string;
    lifetimeSeconds: number;
    expectedHeaders: [string, string][];
}
const negatives = JSON.parse(readFileSync(new URL("negative-cases.json", root), "utf8")) as {
    existingHeaders: { header: [string, string]; expectedCode: string }[];
    clock: NegativeProvider[];
    nonce: NegativeProvider[];
};
interface NegativeProvider {
    output: { kind: string; value?: unknown; message?: string };
    expectedCode: string;
}
function output(descriptor: NegativeProvider["output"]): unknown {
    switch (descriptor.kind) {
        case "number":
        case "string": return descriptor.value;
        case "nan": return NaN;
        case "positive-infinity": return Infinity;
        case "negative-infinity": return -Infinity;
        case "null": return null;
        case "undefined": return undefined;
        case "object": return {};
        case "promise": return Promise.resolve("not-synchronous");
        case "throw": throw new Error(descriptor.message);
        default: throw new Error("Unknown fixture descriptor");
    }
}
function options(): SigningOptions {
    return {
        privateKey, agentOrigin: "https://agent.example", allowTestKeys: true,
        clock: () => 1800000000000, nonceGenerator: () => "fixed-signing-nonce",
    };
}
function request(): RequestParts {
    return {
        method: "GET", targetUri: "https://merchant.example/items?sku=42",
        headers: [["X-Example", "unchanged"]],
    };
}

describe("profile signer — independently committed golden bytes", () => {
    for (const id of manifest.vectors) {
        it(id, async () => {
            const fixture = JSON.parse(readFileSync(new URL(`${id}/case.json`, root), "utf8")) as Golden;
            const clock = vi.fn(() => fixture.clockMilliseconds);
            const nonceGenerator = vi.fn(() => fixture.nonce);
            const signer = createWebBotAuthSigner({
                ...options(), profile: fixture.profile, label: fixture.label,
                agentOrigin: fixture.agentOrigin, clock, nonceGenerator,
                timePolicy: { signingLifetimeSeconds: fixture.lifetimeSeconds },
            });
            const source = fixture.request;
            const headersReference = source.headers;
            const entryReferences = [...source.headers];
            const before = structuredClone(source);
            const result = await signer.sign(source);
            expect(result).toEqual(fixture.expectedHeaders);
            expect(Buffer.from(result.map(([name, value]) => `${name}: ${value}`).join("\n")))
                .toEqual(readFileSync(new URL(`${id}/headers.txt`, root)));
            expect(clock).toHaveBeenCalledTimes(1);
            expect(nonceGenerator).toHaveBeenCalledTimes(1);
            expect(source).toEqual(before);
            expect(source.headers).toBe(headersReference);
            source.headers.forEach((entry, index) => expect(entry).toBe(entryReferences[index]));
            expect(Object.isFrozen(result)).toBe(true);
            result.forEach((entry) => expect(Object.isFrozen(entry)).toBe(true));
            expect(await signer.sign(source)).toEqual(result);

            const signed: RequestParts = { ...source, headers: [...source.headers, ...result] };
            const parsed = parseSignatureHeaders(signed.headers)[0]!;
            expect(getParameter(parsed.input.parameters, "nonce"))
                .toEqual({ kind: "string", value: fixture.nonce });
            const crypto = await verifyHttpSignatureCryptography(
                { kind: "request", request: signed }, parsed, publicKey,
                {
                    structuredFieldTypes: {
                        "signature-agent": fixture.profile === "ietf-wg-protocol-00" ? "dictionary" : "item",
                    }
                },
            );
            // Supplemental crypto check, NOT the golden oracle or a verified
            // round trip. Full offline time/replay verification remains pending.
            expect(crypto.status).toBe("signature-valid");
        });
    }

    it("uses sig1 and the WG profile when neither is supplied", async () => {
        const fixture = JSON.parse(readFileSync(new URL(
            "ietf-wg-protocol-00/default-label/case.json", root,
        ), "utf8")) as Golden;
        expect(await createWebBotAuthSigner(options()).sign(request())).toEqual(fixture.expectedHeaders);
    });
});

describe("signer collision and provider boundaries", () => {
    for (const [index, fixture] of negatives.existingHeaders.entries()) {
        it(`rejects existing header ${index} without calling providers`, async () => {
            const clock = vi.fn(() => 0);
            const nonceGenerator = vi.fn(() => "nonce");
            const signer = createWebBotAuthSigner({ ...options(), clock, nonceGenerator });
            const source = { ...request(), headers: [fixture.header] };
            const reference = source.headers;
            await expect(signer.sign(source)).rejects.toMatchObject({ code: fixture.expectedCode });
            expect(clock).not.toHaveBeenCalled();
            expect(nonceGenerator).not.toHaveBeenCalled();
            expect(source.headers).toBe(reference);
            expect(source.headers[0]).toBe(fixture.header);
        });
    }
    for (const group of ["clock", "nonce"] as const) {
        for (const [index, fixture] of negatives[group].entries()) {
            it(`${group} provider negative ${index}`, async () => {
                const provider = () => output(fixture.output);
                const signer = createWebBotAuthSigner({
                    ...options(),
                    ...(group === "clock"
                        ? { clock: provider as () => number }
                        : { nonceGenerator: provider as () => string }),
                });
                const source = request();
                const reference = source.headers;
                let caught: unknown;
                try { await signer.sign(source); } catch (error) { caught = error; }
                expect(caught).toBeInstanceOf(SigningError);
                expect((caught as SigningError).code).toBe(fixture.expectedCode);
                expect(JSON.stringify(caught)).not.toContain("PRIVATE-PROVIDER-MARKER");
                expect((caught as Error).stack).not.toContain("PRIVATE-PROVIDER-MARKER");
                expect(source.headers).toBe(reference);
            });
        }
    }

    it("signs its pre-callback snapshot even if a callback changes the original", async () => {
        const bytes = new Uint8Array([65, 66]);
        const source = {
            method: "GET", targetUri: "https://merchant.example/items?sku=42",
            headers: [["X-Bytes", bytes] as const],
        };
        const original: RequestParts = {
            ...source, headers: [["X-Bytes", new Uint8Array(bytes)]],
        };
        const signer = createWebBotAuthSigner({
            ...options(), additionalComponents: [{ name: "x-bytes", parameters: [] }],
            clock: () => {
                source.method = "POST";
                source.targetUri = "https://changed.example/";
                bytes.fill(90);
                source.headers.length = 0;
                return 1800000000000;
            },
        });
        const result = await signer.sign(source);
        const signed: RequestParts = { ...original, headers: [...original.headers, ...result] };
        expect((await verifyHttpSignatureCryptography(
            { kind: "request", request: signed },
            parseSignatureHeaders(signed.headers)[0]!, publicKey,
            { structuredFieldTypes: { "signature-agent": "dictionary" } },
        )).status).toBe("signature-valid");
    });

    it("generates default nonces as 32 random bytes encoded in base64url", async () => {
        const configured = options();
        const { nonceGenerator: omitted, ...defaults } = configured;
        expect(omitted).toBeTypeOf("function");
        const signer = createWebBotAuthSigner(defaults);
        const nonces = new Set<string>();
        for (let index = 0; index < 16; index++) {
            const headers = await signer.sign(request());
            const nonce = getParameter(parseSignatureHeaders(headers)[0]!.input.parameters, "nonce");
            expect(nonce?.kind).toBe("string");
            if (nonce?.kind !== "string") throw new Error("Expected nonce");
            expect(nonce.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
            expect(Buffer.from(nonce.value, "base64url")).toHaveLength(32);
            nonces.add(nonce.value);
        }
        // Regression smoke test, not proof of entropy or uniqueness.
        expect(nonces.size).toBe(16);
    });

    it("rejects missing covered fields and final header budget overflow", async () => {
        const missing = createWebBotAuthSigner({
            ...options(), additionalComponents: [{ name: "x-missing", parameters: [] }],
        });
        await expect(missing.sign(request())).rejects.toMatchObject({ code: "invalid-request" });
        const narrow = createWebBotAuthSigner({
            ...options(), coreLimits: { maxMessageHeaderBytes: 100 },
        });
        await expect(narrow.sign(request())).rejects.toMatchObject({ code: "resource-limit" });
    });
});