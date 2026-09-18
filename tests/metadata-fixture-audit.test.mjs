import assert from "node:assert/strict";
import { createHash, createPublicKey } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// No agentsig imports or importer helpers: this audits authored expectations,
// not a substitute for executing those expectations against the real verifier.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = resolve(root, "tests/fixtures/metadata");
const read = (path) => readFileSync(resolve(directory, path));
const json = (path) => JSON.parse(read(path).toString("utf8"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const manifest = json("manifest.json");
const matrix = json("cases.json");
const thumbprint = (jwk) => createHash("sha256").update(JSON.stringify({
    crv: jwk.crv, kty: jwk.kty, x: jwk.x,
})).digest("base64url");

test("metadata manifest covers exact bytes, source excerpts and public-key provenance", () => {
    const paths = [];
    function walk(relative = "") {
        for (const entry of readdirSync(resolve(directory, relative), { withFileTypes: true })) {
            const path = relative ? `${relative}/${entry.name}` : entry.name;
            if (entry.isDirectory()) walk(path);
            else paths.push(path);
        }
    }
    walk();
    assert.equal(manifest.files.length, 5);
    assert.deepEqual(paths.filter((path) => path !== "manifest.json").sort(),
        manifest.files.map((entry) => entry.path).sort());
    const sourceHashes = {
        "tests/fixtures/sources/rfc9421.txt":
            "612655786bf4293bfc486e4177571467fbb3de6e6f0eea90cb74c346a34fdf3c",
        "tests/fixtures/m2/sources/wg-protocol-00.txt":
            "3021fd94cdffdb2eb030dec68b1a5c968f2348502dd94c481e2085ec7ddd90a0",
        "tests/fixtures/m2/sources/cloudflare-2026-07-01.mdx":
            "c4aeeef723df97b020ecc4d9e680b77b5bfb6c214a6443b0fb7f00efd7e422f7",
    };
    for (const entry of manifest.files) {
        assert(!entry.path.includes(".."));
        const bytes = read(entry.path);
        assert.equal(bytes.length, entry.bytes);
        assert.equal(hash(bytes), entry.sha256);
        assert(!bytes.includes(13));
        if (!entry.path.startsWith("sources/")) continue;
        const original = readFileSync(resolve(root, entry.source.path));
        assert.equal(entry.source.sha256, sourceHashes[entry.source.path]);
        assert.equal(hash(original), entry.source.sha256);
        const text = original.toString("utf8");
        const start = text.indexOf("\n" + entry.source.start);
        const end = text.indexOf("\n" + entry.source.endExclusive, start + 1);
        assert(start >= 0 && end > start);
        assert.deepEqual(bytes, Buffer.from(text.slice(start + 1, end)));
    }
    const source = matrix.publicKeySource;
    assert.equal(hash(readFileSync(resolve(root, source.path))), source.sha256);
    assert.equal(createPublicKey(readFileSync(resolve(root, source.path))).asymmetricKeyType, "ed25519");
});

test("source attribution separates signature-validation failure from local all-pairs policy", () => {
    const rfc = read("sources/rfc9421-3.2.txt").toString("utf8").replace(/\s+/g, " ");
    assert(rfc.includes("Parse the Signature and Signature-Input fields"));
    assert(rfc.includes("Parse the values of the chosen Signature-Input field as a parameterized Inner List"));
    assert(rfc.includes("If any of the above steps fail or produce an error, the signature validation fails."));
    const metadata = read("sources/rfc9421-2.3.txt").toString("utf8").replace(/\s+/g, " ");
    assert(metadata.includes("keyid: The identifier for the key material as a String value."));
    const wg = read("sources/wg-5.2.txt").toString("utf8").replace(/\s+/g, " ");
    assert(wg.includes("keyid MUST be a base64url JWK SHA-256 Thumbprint"));
    const cf = read("sources/cloudflare-4.2.mdx").toString("utf8");
    assert(cf.includes("base64 URL-encoded JWK thumbprint"));
    assert(matrix.notes.some((note) => note.includes("not a claim that RFC mandates")));
    assert(matrix.notes.some((note) => note.includes("not generic RFC 9421 keyid syntax")));
});

test("both profiles have positive and negative examples for each of the five gates", () => {
    assert.equal(matrix.cases.length, 42);
    assert.equal(new Set(matrix.cases.map((entry) => entry.id)).size, 42);
    for (const profile of ["ietf-wg-protocol-00", "cloudflare-docs-2026-07-01"]) {
        const entries = matrix.cases.filter((entry) => entry.profile === profile);
        assert.equal(entries.length, 21);
        for (const layer of [
            "wire-types", "required-metadata", "keyid-format",
            "key-lookup", "selected-key-binding",
        ]) {
            const matching = entries.filter((entry) => entry.layer === layer);
            assert(matching.some((entry) => entry.expected.accepted), `${profile}/${layer}: positive`);
            assert(matching.some((entry) => !entry.expected.accepted), `${profile}/${layer}: negative`);
        }
    }
});

test("wire and required metadata expectations preserve the approved failure boundaries", () => {
    for (const entry of matrix.cases) {
        if (entry.layer === "wire-types") {
            const text = entry.input.headers[0][1];
            assert(text.includes(entry.expected.accepted ? ';alg="ed25519"' : ";alg=ed25519"));
            if (!entry.expected.accepted) {
                assert.equal(entry.expected.reason, "malformed-signature");
                assert.equal(entry.expected.boundary, "whole-request");
            }
        }
        if (entry.layer === "required-metadata") {
            const present = ["created", "expires", "keyid"]
                .every((name) => Object.hasOwn(entry.input.metadata, name));
            assert.equal(entry.expected.accepted, present);
            if (!present) assert.equal(entry.expected.reason, "missing-required-parameter");
        }
    }
});

test("thumbprint representations and selected-key identities are independently checked", () => {
    for (const entry of matrix.cases) {
        const { input, expected } = entry;
        if (entry.layer === "keyid-format") {
            const bytes = Buffer.from(input.keyid, "base64url");
            const alphabet = /^[A-Za-z0-9_-]*$/.test(input.keyid);
            const valid = alphabet && bytes.length === 32 &&
                bytes.toString("base64url") === input.keyid;
            assert.equal(expected.accepted, valid, entry.id);
            if (!valid) {
                assert.equal(expected.reason, "invalid-parameter");
                const rule = !alphabet ? "keyid must use unpadded base64url"
                    : bytes.length !== 32 ? "keyid must decode to exactly 32 bytes"
                        : "keyid must use canonical base64url encoding";
                assert.equal(expected.rule, rule);
            }
        }
        if (entry.layer === "key-lookup") {
            assert.equal(Buffer.from(input.keyid, "base64url").length, 32);
            const identities = input.jwks.keys.map(thumbprint);
            assert.equal(expected.accepted, identities.includes(input.keyid));
            if (expected.accepted) assert.equal(expected.selectedThumbprint, input.keyid);
            else assert.equal(expected.reason, "unknown-key");
        }
        if (entry.layer === "selected-key-binding") {
            const key = createPublicKey({ key: input.selectedPublicJwk, format: "jwk" });
            const recomputed = thumbprint(key.export({ format: "jwk" }));
            assert.equal(expected.accepted, input.keyid === recomputed);
            if (expected.accepted) assert.equal(expected.recomputedThumbprint, recomputed);
            else assert.equal(expected.reason, "key-id-mismatch");
        }
    }
});

test("tag/nonce cases retain their distinctions without extending the frozen catalog", () => {
    const catalog = JSON.parse(readFileSync(resolve(root,
        "tests/fixtures/m2/policy-cases.json"), "utf8")).codeCatalog;
    for (const entry of matrix.cases) {
        const { input, expected } = entry;
        if (expected.reason) assert(catalog[expected.status].includes(expected.reason), entry.id);
        if (entry.layer === "candidate-selection") {
            assert(!input.headers[0][1].includes(';tag="web-bot-auth"'));
            assert.equal(expected.status, "unsigned");
            assert.equal(expected.reason, "no-web-bot-auth-candidate");
        }
        if (entry.layer === "nonce-policy") {
            if (Object.hasOwn(input.metadata, "nonce")) {
                assert.equal(input.metadata.nonce, "");
                assert.equal(expected.reason, "nonce-invalid");
            } else if (input.noncePolicy === "required") {
                assert.equal(expected.reason, "nonce-required");
            } else {
                assert.equal(expected.accepted, true);
                assert.equal(expected.noncePresent, false);
            }
        }
    }
});