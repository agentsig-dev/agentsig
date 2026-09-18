import assert from "node:assert/strict";
import { createHash, createPublicKey } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// Independent fixture audit, not a JWKS loader or an algorithm verifier.
// No agentsig imports and no importer helper reuse.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = resolve(root, "tests/fixtures/jwks");
const read = (path) => readFileSync(resolve(directory, path));
const json = (path) => JSON.parse(read(path).toString("utf8"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const manifest = json("manifest.json");
const matrix = json("load-cases.json");
const material = json("public-material.json");

function independentThumbprint(key) {
    // Explicit RFC 7638 / RFC 8037 mandatory-member lists; metadata excluded.
    const names = key.kty === "RSA" ? ["e", "kty", "n"]
        : key.kty === "EC" ? ["crv", "kty", "x", "y"]
            : ["crv", "kty", "x"];
    const canonical = Object.fromEntries(names.map((name) => {
        assert.equal(typeof key[name], "string");
        return [name, key[name]];
    }));
    return createHash("sha256").update(JSON.stringify(canonical)).digest("base64url");
}

test("JWKS manifest covers all source/data files with exact LF bytes", () => {
    const paths = [];
    function walk(relative = "") {
        for (const entry of readdirSync(resolve(directory, relative), { withFileTypes: true })) {
            const path = relative ? `${relative}/${entry.name}` : entry.name;
            if (entry.isDirectory()) walk(path);
            else paths.push(path);
        }
    }
    walk();
    assert.deepEqual(paths.filter((path) => path !== "manifest.json").sort(),
        manifest.files.map((entry) => entry.path).sort());
    assert.equal(new Set(manifest.files.map((entry) => entry.path)).size, manifest.files.length);
    for (const entry of manifest.files) {
        assert(!entry.path.includes(".."));
        const bytes = read(entry.path);
        assert.equal(bytes.length, entry.bytes, entry.path);
        assert.equal(hash(bytes), entry.sha256, entry.path);
        assert(!bytes.includes(13), entry.path);
    }
    assert.equal(matrix.cases.length, 32);
    assert.equal(new Set(matrix.cases.map((entry) => entry.id)).size, 32);
});

test("source RFC digests and metadata rules are independently pinned", () => {
    const hashes = {
        7517: "681c19b92a85068716b7e89c5815aa821bd3f11c755ff1c641b40ae9851bb33c",
        7518: "9a9ae524b09ea700ad3f189bac115df95ba69af84b26ffdbe3cdfb8d2152b1fc",
        7638: "98b29ab9652070e6a5fec748d43e221bbedc66b6b22e05903fb5366c04ef3110",
        8037: "f14347f9d8eead78ef6e7a1ea3d795d35d664033095a76a80fcd567904aaedaa",
    };
    for (const [number, expected] of Object.entries(hashes)) {
        assert.equal(hash(read(`sources/rfc${number}.txt`)), expected);
    }
    const jwk = read("sources/rfc7517.txt").toString("utf8");
    for (const [start, end, name] of [
        ['4.4.  "alg" (Algorithm) Parameter', '4.5.  "kid" (Key ID) Parameter', "alg"],
        ['4.5.  "kid" (Key ID) Parameter', '4.6.  "x5u" (X.509 URL) Parameter', "kid"],
    ]) {
        const from = jwk.indexOf(`\n${start}\n`);
        const to = jwk.indexOf(`\n${end}\n`, from + 1);
        assert(from >= 0 && to > from, `Missing RFC 7517 ${name} section`);
        const section = jwk.slice(from, to).replace(/\s+/g, " ");
        assert(section.includes("Use of this member is OPTIONAL."),
            `RFC 7517 ${name} optionality statement not found`);
    }
    const okp = read("sources/rfc8037.txt").toString("utf8");
    assert(/algorithm "EdDSA" is defined here/.test(okp),
        "RFC 8037 EdDSA definition not found");
    const wg = readFileSync(resolve(root, "tests/fixtures/m2/sources/wg-protocol-00.txt"), "utf8");
    assert(/JWK MAY carry a kid/.test(wg), "WG optional kid statement not found");
    assert(/The alg parameter is restricted to algorithms/.test(wg),
        "WG algorithm restriction statement not found");
});

test("public fixtures have valid material and metadata-independent thumbprints", () => {
    for (const entry of Object.values(material)) {
        assert(!Object.hasOwn(entry.key, "d"));
        const key = createPublicKey({ key: entry.key, format: "jwk" });
        assert.equal(key.type, "public");
        assert.equal(independentThumbprint(entry.key), entry.thumbprint);
        assert.equal(independentThumbprint({
            ...entry.key, alg: "metadata-only-test", kid: "changed-label",
        }), entry.thumbprint);
    }
    for (const example of matrix.cases.filter((entry) => entry.expected.load === "accepted")) {
        for (const key of example.jwks.keys) {
            assert.equal(createPublicKey({ key, format: "jwk" }).type, "public");
        }
        const edKeys = example.jwks.keys.filter((key) =>
            key.kty === "OKP" && key.crv === "Ed25519");
        const skipped = example.jwks.keys.filter((key) => !edKeys.includes(key));
        assert.deepEqual(edKeys.map(independentThumbprint), example.expected.selectableThumbprints);
        assert.equal(skipped.length, example.expected.skippedCount);
        assert.deepEqual(skipped.map((key) => ({
            kid: key.kid ?? null,
            thumbprint: independentThumbprint(key),
            requestCode: "unsupported-algorithm",
        })), example.expected.skipped);
    }
});

test("load expectations distinguish formats, malformed keys and unsupported keys", () => {
    const cases = new Map(matrix.cases.map((entry) => [entry.id, entry]));
    for (const format of ["jwks", "wg-directory-00"]) {
        assert.equal(cases.get(`${format}-metadata-absent`).expected.load, "accepted");
        assert.equal(cases.get(`${format}-matching-alg`).jwks.keys[0].alg,
            format === "jwks" ? "EdDSA" : "ed25519");
        for (const suffix of [
            "wrong-alg-vocabulary", "nonstring-alg", "nonstring-kid",
            "missing-okp-x", "curve-length-mismatch", "key-type-curve-mismatch",
            "unknown-unhashable-type", "malformed-unsupported-key-poisons-set",
            "missing-rsa-modulus",
        ]) {
            assert.deepEqual(cases.get(`${format}-${suffix}`).expected,
                { load: "rejected", code: "invalid-jwks" });
        }
        assert.equal(cases.get(`${format}-mixed-public-keys`).expected.skippedCount, 3);
        assert.equal(cases.get(`${format}-unsupported-only`).expected.selectableThumbprints.length, 0);
    }
    assert.equal(cases.get("jwks-operator-chosen-kid").expected.load, "accepted");
    assert.equal(cases.get("wg-directory-operator-chosen-kid").expected.code, "invalid-jwks");
    // These check authored expectations only; actual loader acceptance tests
    // must execute this matrix once the loader implementation is written.
});

test("Cloudflare excerpt has no JWK alg/kid; response signature metadata is separate", () => {
    const source = readFileSync(resolve(root,
        "tests/fixtures/m2/sources/cloudflare-2026-07-01.mdx"), "utf8");
    const displayed = read("cloudflare-directory-displayed.txt").toString("utf8");
    assert(source.includes(displayed));
    const parsed = json("cloudflare-directory.json");
    assert.equal(parsed.keys.length, 1);
    const key = parsed.keys[0];
    assert.deepEqual(Object.keys(key).sort(), ["crv", "kty", "x"]);
    for (const name of ["kty", "crv", "x"]) {
        assert(displayed.includes(`"${name}": "${key[name]}"`));
    }
    assert.equal(independentThumbprint(key), "poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U");
    assert.throws(() => JSON.parse(displayed), SyntaxError);
    const responseHeader = source.split("\n")
        .find((line) => line.includes("Signature-Input: sig1="));
    assert(responseHeader?.includes(';alg="ed25519"'));
    assert(!Object.hasOwn(key, "alg"));
    assert(!Object.hasOwn(key, "kid"));
    for (const format of ["jwks", "wg-directory-00"]) {
        const example = matrix.cases.find((entry) => entry.id === `cloudflare-example-${format}`);
        assert.deepEqual(example.jwks, parsed);
        assert.equal(example.expected.load, "accepted");
    }
});