import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cwd = resolve(root, "packages/fetch");
for (const format of ["module", "commonjs"]) {
    test(`signed Fetch works through public ${format} package exports`, () => {
        const imports = format === "module"
            ? `import assert from "node:assert/strict";
               import { generateKeyPairSync } from "node:crypto";
               import { createSignedFetch } from "@agentsig/fetch";
               import { createWebBotAuthSigner, createOfflineVerifier, SigningError } from "@agentsig/core/profiles";`
            : `const assert = require("node:assert/strict");
               const { generateKeyPairSync } = require("node:crypto");
               const { createSignedFetch } = require("@agentsig/fetch");
               const { createWebBotAuthSigner, createOfflineVerifier, SigningError } = require("@agentsig/core/profiles");`;
        const body = `
(async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const verifier = createOfflineVerifier({
        jwks: { keys: [publicKey.export({ format: "jwk" })] }, scope: "fetch-consumer",
    });
    let calls = 0;
    const send = createSignedFetch({
        signer: createWebBotAuthSigner({ privateKey, agentOrigin: "https://agent.example" }),
        fetch: async request => {
            calls++;
            assert.equal(request.redirect, "manual");
            const parts = { method: request.method, targetUri: request.url, headers: [...request.headers] };
            assert.equal((await verifier.verify(parts)).status, "verified");
            assert.equal((await verifier.verify(parts)).reason, "replay-detected");
            return new Response(null, { status: 204 });
        },
    });
    const input = new Request("https://merchant.example/items");
    assert.equal((await send(input)).status, 204);
    assert.equal((await send(input)).status, 204);
    assert.equal(calls, 2);
    assert.equal(input.headers.has("signature"), false);
    await assert.rejects(send(new Request(input, { headers: { Signature: "" } }), { headers: {} }),
        error => error instanceof SigningError && error.code === "existing-signature-headers");
    assert.equal(calls, 2);
    await assert.rejects(import("@agentsig/fetch/dist/index.js"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
    process.stdout.write("fetch-consumer-ok");
})().catch(() => { process.stderr.write("Fetch consumer failed"); process.exitCode = 1; });
`;
        assert.equal(execFileSync(process.execPath, [`--input-type=${format}`, "--eval", imports + body], {
            cwd, encoding: "utf8", timeout: 15000,
        }), "fetch-consumer-ok");
    });

    test(`signed Fetch declarations resolve for ${format}`, () => {
        const directory = mkdtempSync(join(cwd, ".fetch-consumer-"));
        try {
            const filename = join(directory, format === "module" ? "consumer.mts" : "consumer.cts");
            writeFileSync(filename, `
import { createSignedFetch, type SignedFetch, type SignedFetchInit } from "@agentsig/fetch";
import type { WebBotAuthSigner } from "@agentsig/core/profiles";
declare const signer: WebBotAuthSigner;
const send: SignedFetch = createSignedFetch({
    signer, bodyPolicy: "allow-unverified", allowHttpLoopbackForTests: true,
    fetch: async request => new Response(null, { status: request instanceof Request ? 204 : 500 }),
});
const init: SignedFetchInit = { method: "POST", body: "identity only", redirect: "manual" };
const result: Promise<Response> = send("https://merchant.example/", init);
void result;
// @ts-expect-error No implicit signer configuration/key material at this boundary.
createSignedFetch({ privateKey: "secret" });
// @ts-expect-error Body policy cannot claim verified integrity.
createSignedFetch({ signer, bodyPolicy: "verified" });
// @ts-expect-error No automatic retry option.
createSignedFetch({ signer, retry: 2 });
`, "utf8");
            execFileSync(process.execPath, [
                resolve(root, "node_modules/typescript/bin/tsc"),
                "--noEmit", "--strict", "--exactOptionalPropertyTypes", "--module", "NodeNext",
                "--moduleResolution", "NodeNext", "--target", "ES2022", "--types", "node", filename,
            ], { cwd, encoding: "utf8", timeout: 30000 });
        } finally { rmSync(directory, { recursive: true, force: true }); }
    });
}