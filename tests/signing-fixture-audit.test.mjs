import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// Independent audit: neither agentsig modules nor importer helpers are used.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = resolve(root, "tests/fixtures/signing");
const read = (path) => readFileSync(resolve(directory, path));
const json = (path) => JSON.parse(read(path).toString("utf8"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const manifest = json("manifest.json");
const contract = json("contract.json");
const expectedCodes = [
    "existing-signature-headers", "invalid-signing-key", "test-key-disallowed",
    "invalid-agent-origin", "invalid-label", "unsupported-profile",
    "unsupported-component", "invalid-request", "invalid-signing-options",
    "clock-unavailable", "nonce-generation-failed", "resource-limit", "signing-failed",
];

test("signing manifest covers every file and preserves exact source-key bytes", () => {
    const paths = [];
    function walk(relative = "") {
        for (const entry of readdirSync(resolve(directory, relative), { withFileTypes: true })) {
            const path = relative ? `${relative}/${entry.name}` : entry.name;
            if (entry.isDirectory()) walk(path);
            else paths.push(path);
        }
    }
    walk();
    assert.equal(manifest.files.length, 19);
    assert.deepEqual(paths.filter((path) => path !== "manifest.json").sort(),
        manifest.files.map((entry) => entry.path).sort());
    assert.equal(new Set(manifest.files.map((entry) => entry.path)).size, 19);
    for (const entry of manifest.files) {
        assert(!entry.path.includes(".."));
        const bytes = read(entry.path);
        assert.equal(bytes.length, entry.bytes, entry.path);
        assert.equal(hash(bytes), entry.sha256, entry.path);
        if (!entry.path.endsWith(".bin")) assert(!bytes.includes(13), entry.path);
    }
    for (const key of manifest.sourceKeys) {
        assert.equal(hash(readFileSync(resolve(root, key.path))), key.sha256);
    }
});

test("signing catalog is independently frozen and preserves the approved defaults", () => {
    assert.equal(contract.catalogVersion, 1);
    assert.equal(contract.catalogFrozen, true);
    assert.equal(contract.separateFromVerificationCatalog, true);
    assert.equal(contract.errorClass, "SigningError");
    assert.deepEqual(contract.codes, expectedCodes);
    assert.equal(new Set(contract.codes).size, 13);
    assert.equal(manifest.catalogSha256, hash(Buffer.from(JSON.stringify(expectedCodes))));
    assert.equal(contract.defaults.label, "sig1");
    assert.equal(contract.defaults.profile, "ietf-wg-protocol-00");
    assert.equal(contract.defaults.lifetimeSeconds, 60);
});

const privateKey = createPrivateKey(readFileSync(resolve(root,
    "tests/fixtures/m2/generated/public-test-private.pem")));
const publicKey = createPublicKey(readFileSync(resolve(root,
    "tests/fixtures/m2/generated/public-test-public.pem")));
assert(createPublicKey(privateKey).equals(publicKey));
const publicJwk = publicKey.export({ format: "jwk" });
const thumbprint = createHash("sha256").update(JSON.stringify({
    crv: publicJwk.crv, kty: publicJwk.kty, x: publicJwk.x,
})).digest("base64url");

assert.deepEqual(manifest.vectors, [
    "ietf-wg-protocol-00/default-label",
    "ietf-wg-protocol-00/escaped-nonce",
    "cloudflare-docs-2026-07-01/default-label",
    "cloudflare-docs-2026-07-01/escaped-nonce",
]);
for (const id of manifest.vectors) {
    test(`${id}: exact headers and literal base independently verify`, () => {
        const example = json(`${id}/case.json`);
        const headers = example.expectedHeaders;
        assert.deepEqual(headers.map(([name]) => name),
            ["Signature-Input", "Signature", "Signature-Agent"]);
        assert.deepEqual(read(`${id}/headers.txt`),
            Buffer.from(headers.map(([name, value]) => `${name}: ${value}`).join("\n")));
        const wg = example.profile === "ietf-wg-protocol-00";
        const escaped = id.endsWith("/escaped-nonce");
        assert.equal(example.label, escaped ? "custom-agent" : "sig1");
        assert.equal(example.nonce, escaped ? 'quote"slash\\end' : "fixed-signing-nonce");
        // JSON quoting is identical to SF String quoting for these deliberately
        // restricted printable-ASCII fixtures; this is NOT a general SF encoder.
        assert(/^[\x20-\x7e]+$/.test(example.nonce));
        const quotedNonce = JSON.stringify(example.nonce);
        const component = wg
            ? `"signature-agent";key="${example.label}"` : '"signature-agent"';
        const created = Math.floor(example.clockMilliseconds / 1000);
        assert.equal(created, 1800000000);
        const expires = created + example.lifetimeSeconds;
        assert.equal(expires, 1800000060);
        const params = `("@method" "@target-uri" ${component});created=${created}` +
            `;expires=${expires};keyid="${thumbprint}";alg="ed25519"` +
            `;nonce=${quotedNonce};tag="web-bot-auth"`;
        assert.equal(headers[0][1], `${example.label}=${params}`);
        assert.equal(headers[2][1], wg
            ? `${example.label}="https://agent.example"` : '"https://agent.example"');
        const base = read(`${id}/base.txt`);
        assert.notEqual(base.at(-1), 10);
        assert.deepEqual(base, Buffer.from([
            '"@method": GET',
            '"@target-uri": https://merchant.example/items?sku=42',
            `${component}: "https://agent.example"`,
            `"@signature-params": ${params}`,
        ].join("\n")));
        const signature = read(`${id}/signature.bin`);
        assert.equal(signature.length, 64);
        assert.equal(headers[1][1], `${example.label}=:${signature.toString("base64")}:`);
        assert(verify(null, base, publicKey, signature));
        assert.deepEqual(sign(null, base, privateKey), signature);
        assert(!verify(null, Buffer.concat([base, Buffer.from("\n")]), publicKey, signature));
        assert.deepEqual(example.request.headers, [["X-Example", "unchanged"]]);
        assert.equal(example.allowTestKeys, true);
    });
}

test("collision negatives include empty values and all approved case variants", () => {
    const cases = json("negative-cases.json").existingHeaders;
    assert.equal(cases.length, 18);
    const seen = new Set(cases.map((entry) => JSON.stringify(entry.header)));
    assert.equal(seen.size, 18);
    for (const name of ["Signature", "Signature-Input", "Signature-Agent"]) {
        for (const spelling of [name, name.toLowerCase(), name.toUpperCase()]) {
            for (const value of ["", "already-present"]) {
                assert(seen.has(JSON.stringify([spelling, value])));
            }
        }
    }
    for (const entry of cases) {
        assert.equal(entry.expectedCode, "existing-signature-headers");
        assert.equal(entry.clockCalls, 0);
        assert.equal(entry.nonceCalls, 0);
    }
});

test("provider negative descriptors preserve non-JSON values without coercion", () => {
    const cases = json("negative-cases.json");
    assert.equal(cases.clock.length, 12);
    assert.equal(cases.nonce.length, 12);
    for (const [name, code] of [
        ["clock", "clock-unavailable"], ["nonce", "nonce-generation-failed"],
    ]) {
        const outputs = cases[name].map((entry) => entry.output);
        for (const kind of ["null", "undefined", "object", "promise", "throw"]) {
            assert(outputs.some((output) => output.kind === kind), `${name}: ${kind}`);
        }
        for (const entry of cases[name]) assert.equal(entry.expectedCode, code);
        assert.equal(outputs.find((output) => output.kind === "throw").message,
            "PRIVATE-PROVIDER-MARKER");
    }
    for (const kind of ["nan", "positive-infinity", "negative-infinity"]) {
        assert(cases.clock.some((entry) => entry.output.kind === kind));
    }
    assert(cases.clock.some((entry) => entry.output.value === -0.5));
    assert(cases.clock.some((entry) => entry.output.value === Number.MAX_VALUE));
    const nonceStrings = cases.nonce.filter((entry) => entry.output.kind === "string");
    assert.equal(nonceStrings.length, 6);
    for (const { output } of nonceStrings) {
        assert(!(output.value.length >= 1 && output.value.length <= 256 &&
            /^[\x20-\x7e]+$/.test(output.value)));
    }
});

test("nonce boundaries include printable space, escaping and exact maximum", () => {
    const cases = json("nonce-boundaries.json").cases;
    assert.equal(cases.length, 6);
    assert(cases.some((entry) => entry.nonce === " " && entry.valid));
    assert(cases.some((entry) => entry.nonce.length === 256 && entry.valid));
    assert(cases.some((entry) => entry.nonce.includes('"') && entry.nonce.includes("\\") && entry.valid));
    for (const entry of cases) {
        assert.equal(entry.valid, entry.nonce.length >= 1 && entry.nonce.length <= 256 &&
            /^[\x20-\x7e]+$/.test(entry.nonce));
    }
});