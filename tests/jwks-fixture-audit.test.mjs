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

test("WG discovery excerpt pins kid and algorithm rules without adding usage requirements", () => {
    const source = readFileSync(resolve(root,
        "tests/fixtures/m2/sources/wg-protocol-00.txt"));
    assert.equal(hash(source),
        "3021fd94cdffdb2eb030dec68b1a5c968f2348502dd94c481e2085ec7ddd90a0");
    const text = source.toString("utf8");
    const start = text.indexOf("\n5.5.  Key Distribution and Discovery\n");
    const end = text.indexOf("\n5.5.2.  Key Rotation\n", start);
    assert(start >= 0 && end > start);
    const excerpt = read("wg-discovery-format-excerpt.txt").toString("utf8");
    assert.equal(excerpt, text.slice(start + 1, end));
    const prose = excerpt.replace(/\s+/g, " ");
    assert(prose.includes("JWK MAY carry a kid. In this case, it MUST be set to the thumbprint"));
    assert(prose.includes("The alg parameter is restricted to algorithms registered in the HTTP Signature Algorithms"));
    assert(!excerpt.includes("key_ops"));
    // The only use field is in an example, not an additional normative rule.
    assert.equal((excerpt.match(/"use"/g) ?? []).length, 1);
    assert(excerpt.includes('"use": "sig"'));
});

test("approved usage matrix distinguishes Ed25519 from other OKP curves", () => {
    const metadata = json("metadata-cases.json");
    assert.equal(metadata.cases.length, 54);
    const cases = new Map(metadata.cases.map((entry) => [entry.id, entry]));
    assert.equal(cases.size, 54);
    const ed448 = json("ed448-public-material.json");
    assert.equal(ed448.key.crv, "Ed448");
    assert.equal(Buffer.from(ed448.key.x, "base64url").length, 57);
    assert.equal(createPublicKey({ key: ed448.key, format: "jwk" }).asymmetricKeyType, "ed448");
    assert.equal(independentThumbprint(ed448.key), ed448.thumbprint);
    assert(!Object.hasOwn(ed448.key, "d"));

    for (const format of ["jwks", "wg-directory-00"]) {
        for (const name of [
            "use-sig", "verify-only", "sign-and-verify",
            "verify-and-sign", "consistent-use-ops",
        ]) {
            assert.equal(cases.get(`${format}-${name}`).expected.load, "accepted");
        }
        for (const name of [
            "use-enc", "use-extension", "use-not-string", "ops-not-array",
            "ops-nonstring", "ops-duplicate", "ops-empty", "ops-sign-only",
            "ops-unrelated", "ops-extension", "use-ops-conflict",
            "missing-kid-diagnostic", "wrong-kid-type-diagnostic",
        ]) {
            assert.equal(cases.get(`${format}-${name}`).expected.code, "invalid-jwks");
        }
        for (const [name, expectedMaterial] of [
            ["x25519", material.x25519], ["ed448", ed448],
        ]) {
            const entry = cases.get(`${format}-${name}-enc-skipped`);
            assert.equal(entry.expected.load, "accepted");
            assert.equal(entry.expected.skippedCount, 1);
            const key = entry.jwks.keys[1];
            assert.equal(key.kty, "OKP");
            assert.equal(key.crv, expectedMaterial.key.crv);
            assert.equal(key.use, "enc");
            assert.equal(independentThumbprint(key), expectedMaterial.thumbprint);
            assert.deepEqual(entry.expected.skipped, [{
                kid: key.kid, thumbprint: expectedMaterial.thumbprint,
                requestCode: "unsupported-algorithm",
            }]);
            for (const suffix of ["bad-use-type", "duplicate-ops", "conflicting-ops"]) {
                assert.equal(cases.get(`${format}-${name}-${suffix}`).expected.code, "invalid-jwks");
            }
        }
    }

    for (const entry of metadata.cases.filter((item) => item.expected.load === "accepted")) {
        const edKeys = entry.jwks.keys.filter((key) => key.crv === "Ed25519");
        assert.deepEqual(edKeys.map(independentThumbprint), entry.expected.selectableThumbprints);
        for (const key of entry.jwks.keys) {
            assert.equal(createPublicKey({ key, format: "jwk" }).type, "public");
            if (entry.format === "wg-directory-00" && Object.hasOwn(key, "kid")) {
                assert.equal(key.kid, independentThumbprint(key));
            }
        }
    }
});

test("rejection fixtures locate the key and require safe actionable diagnostics", () => {
    const metadata = json("metadata-cases.json");
    for (const entry of metadata.cases.filter((item) => item.expected.load === "rejected")) {
        assert.equal(entry.expected.code, "invalid-jwks");
        const diagnostic = entry.expected.diagnostic;
        assert.equal(diagnostic.keyIndex, 1);
        const key = entry.jwks.keys[diagnostic.keyIndex];
        assert.equal(diagnostic.kid, typeof key.kid === "string" ? key.kid : null);
        assert.equal(typeof diagnostic.rule, "string");
        assert(diagnostic.rule.length > 0);
        assert(!diagnostic.rule.includes(key.x));
    }
    const escaped = metadata.cases.find((entry) => entry.id === "jwks-escaped-kid-diagnostic");
    assert(escaped.expected.diagnostic.kid.includes("\n"));
    assert(escaped.expected.diagnostic.kid.includes("\u001b"));
    const mismatch = metadata.cases.find((entry) =>
        entry.id === "wg-directory-00-kid-mismatch-diagnostic");
    assert.notEqual(mismatch.jwks.keys[1].kid, independentThumbprint(mismatch.jwks.keys[1]));
    assert.equal(mismatch.expected.diagnostic.rule, "kid must equal the RFC 7638 thumbprint");
    // Diagnostic text is not an extension of the frozen result-code catalog.
    assert.equal(metadata.policy.catalog,
        "Unchanged; diagnostic rule descriptions are not new result codes");
});

test("algorithm vocabularies match pinned RFC registrations and dated IANA bytes", () => {
    const lists = json("algorithm-lists.json");
    const expectedJose = [
        "HS256", "HS384", "HS512", "RS256", "RS384", "RS512",
        "ES256", "ES384", "ES512", "PS256", "PS384", "PS512", "none",
        "RSA1_5", "RSA-OAEP", "RSA-OAEP-256", "A128KW", "A192KW", "A256KW",
        "dir", "ECDH-ES", "ECDH-ES+A128KW", "ECDH-ES+A192KW", "ECDH-ES+A256KW",
        "A128GCMKW", "A192GCMKW", "A256GCMKW",
        "PBES2-HS256+A128KW", "PBES2-HS384+A192KW", "PBES2-HS512+A256KW", "EdDSA",
    ];
    const expectedHttp = [
        "rsa-pss-sha512", "rsa-v1_5-sha256", "hmac-sha256",
        "ecdsa-p256-sha256", "ecdsa-p384-sha384", "ed25519",
    ];
    assert.deepEqual(lists.jwks.names, expectedJose);
    assert.deepEqual(lists["wg-directory-00"].names, expectedHttp);
    const registrations = [];
    for (const rfc of [7518, 8037]) {
        // Separate line/block inspection rather than the importer's regex.
        const blocks = read(`sources/rfc${rfc}.txt`).toString("utf8")
            .split("   o  Algorithm Name: ").slice(1);
        for (const block of blocks) {
            const name = block.split('"')[1];
            const usageLine = block.split("\n")
                .find((line) => line.includes("Algorithm Usage Location(s):"));
            assert(usageLine, name);
            if (usageLine.trim().endsWith('"alg"')) registrations.push({ name, rfc });
        }
    }
    assert.deepEqual(lists.jwks.records, registrations);
    assert.deepEqual(registrations.map((record) => record.name), expectedJose);

    const bytes = read("sources/iana-http-message-signature.xml");
    assert.equal(hash(bytes),
        "bd4b0304e21e226fef189ed283a31392b5ffc99a37d00e9911dc011dcfb1523f");
    const source = lists["wg-directory-00"].source;
    assert.equal(source.sha256, hash(bytes));
    assert.equal(source.url,
        "https://www.iana.org/assignments/http-message-signature/http-message-signature.xml");
    assert.equal(source.retrievedAt, "2026-09-18T20:36:24.390Z");
    assert.equal(source.registryUpdated, "2026-07-20");
    const xml = bytes.toString("utf8");
    assert(xml.includes("<updated>2026-07-20</updated>"));
    const section = xml.split('<registry id="signature-algorithms">')[1].split("</registry>")[0];
    const names = section.split("<name>").slice(1).map((part) => part.split("</name>")[0]);
    assert.deepEqual(names, expectedHttp);
    assert(expectedJose.every((name) => !expectedHttp.includes(name)));
});

test("all algorithm fixtures follow the six approved rules without verifying unsupported keys", () => {
    const lists = json("algorithm-lists.json");
    const matrix = json("algorithm-cases.json");
    assert.equal(matrix.rules.length, 6);
    assert.equal(matrix.cases.length, 410);
    assert.equal(new Set(matrix.cases.map((entry) => entry.id)).size, 410);

    for (const entry of matrix.cases) {
        const own = lists[entry.format].names;
        const other = lists[entry.format === "jwks" ? "wg-directory-00" : "jwks"].names;
        const edName = entry.format === "jwks" ? "EdDSA" : "ed25519";
        const selected = [];
        const skipped = [];
        let failure;
        for (const [index, key] of entry.jwks.keys.entries()) {
            let rule;
            if (key.kty === "oct") {
                rule = "public JWKS must not contain symmetric keys";
            } else {
                assert.equal(createPublicKey({ key, format: "jwk" }).type, "public");
                const hasAlg = Object.hasOwn(key, "alg");
                if (hasAlg && (typeof key.alg !== "string" || /[^\x00-\x7f]/.test(key.alg))) {
                    rule = "alg must be an ASCII string";
                } else if (key.crv === "Ed25519") {
                    if (hasAlg && key.alg !== edName) {
                        rule = "Ed25519 alg must match the selected JWKS format";
                    } else {
                        selected.push(independentThumbprint(key));
                    }
                } else if (hasAlg && other.includes(key.alg)) {
                    rule = "alg belongs to the opposite JWKS format";
                } else if (key.alg === edName) {
                    rule = "Ed25519 algorithm name requires crv Ed25519";
                } else {
                    skipped.push({
                        kid: key.kid ?? null,
                        thumbprint: independentThumbprint(key),
                        requestCode: "unsupported-algorithm",
                        reason: !hasAlg || own.includes(key.alg)
                            ? "unsupported-algorithm" : "unknown-algorithm-name",
                    });
                }
            }
            if (rule) {
                failure = {
                    load: "rejected", code: "invalid-jwks",
                    diagnostic: { keyIndex: index, kid: key.kid ?? null, rule },
                };
                break;
            }
        }
        assert.deepEqual(entry.expected, failure ?? {
            load: "accepted", selectableThumbprints: selected,
            skippedCount: skipped.length, skipped,
        }, entry.id);
    }
});

test("algorithm matrix preserves forward compatibility and the explicit Ed25519-name exception", () => {
    const cases = new Map(json("algorithm-cases.json").cases.map((entry) => [entry.id, entry]));
    for (const format of ["jwks", "wg-directory-00"]) {
        for (const type of ["rsa", "p256", "x25519", "ed448"]) {
            assert.equal(cases.get(`${format}-${type}-alg-absent`).expected.load, "accepted");
            const unknown = cases.get(`${format}-${type}-unknown-name`).expected;
            assert.equal(unknown.load, "accepted");
            assert.equal(unknown.skipped[0].reason, "unknown-algorithm-name");
            assert.equal(unknown.skipped[0].requestCode, "unsupported-algorithm");
            assert.equal(cases.get(`${format}-${type}-own-ed-name`).expected.code, "invalid-jwks");
        }
        for (const suffix of ["with-k", "without-k"]) {
            assert.equal(cases.get(`${format}-symmetric-${suffix}`).expected.code, "invalid-jwks");
        }
        assert.equal(cases.get(`${format}-ed25519-wrong-future-example-algorithm`)
            .expected.code, "invalid-jwks");
    }
    // These incompatible declarations are intentionally not validated for
    // skipped keys. Their acceptance must never be presented as crypto support.
    assert.equal(cases.get("jwks-rsa-own-ES256").expected.load, "accepted");
    assert.equal(cases.get("wg-directory-00-p256-own-rsa-pss-sha512").expected.load, "accepted");
    assert.equal(cases.get("jwks-rsa-opposite-rsa-pss-sha512").expected.code, "invalid-jwks");
    assert.equal(cases.get("wg-directory-00-rsa-opposite-PS512").expected.code, "invalid-jwks");
});