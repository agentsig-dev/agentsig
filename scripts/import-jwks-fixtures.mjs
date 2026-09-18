import assert from "node:assert/strict";
import { createHash, createPublicKey } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = "tests/fixtures/jwks";
const files = [];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function put(path, data, source) {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
    const target = resolve(root, output, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    files.push({ path, bytes: bytes.length, sha256: hash(bytes), source });
}
function json(path, data, source) {
    put(path, JSON.stringify(data, null, 2) + "\n", source);
}
const hashes = {
    7517: "681c19b92a85068716b7e89c5815aa821bd3f11c755ff1c641b40ae9851bb33c",
    7518: "9a9ae524b09ea700ad3f189bac115df95ba69af84b26ffdbe3cdfb8d2152b1fc",
    7638: "98b29ab9652070e6a5fec748d43e221bbedc66b6b22e05903fb5366c04ef3110",
    8037: "f14347f9d8eead78ef6e7a1ea3d795d35d664033095a76a80fcd567904aaedaa",
};
for (const [rfc, sha256] of Object.entries(hashes)) {
    const bytes = readFileSync(resolve(root, `.tmp/m2-jwks/rfc${rfc}.txt`));
    assert.equal(hash(bytes), sha256);
    put(`sources/rfc${rfc}.txt`, bytes, {
        url: `https://www.rfc-editor.org/rfc/rfc${rfc}.txt`,
        license: "Original IETF Trust notices retained in full source",
    });
}

// Independent material extraction, not agentsig key-loading code.
const rfc9421 = readFileSync(resolve(root, "tests/fixtures/sources/rfc9421.txt"), "utf8");
function extractPem(section, next) {
    const from = rfc9421.indexOf(`\n${section}. `);
    const to = rfc9421.indexOf(`\n${next}. `, from + 1);
    assert(from >= 0 && to > from);
    const match = rfc9421.slice(from, to)
        .match(/   -----BEGIN PUBLIC KEY-----[\s\S]*?   -----END PUBLIC KEY-----/);
    assert(match);
    return match[0].replace(/^   /gm, "") + "\n";
}
const rsa = createPublicKey(extractPem("B.1.2", "B.1.3")).export({ format: "jwk" });
const ec = createPublicKey(extractPem("B.1.3", "B.1.4")).export({ format: "jwk" });
const ed = createPublicKey(readFileSync(resolve(root,
    "tests/fixtures/m2/generated/public-test-public.pem"))).export({ format: "jwk" });
const rfc8037 = readFileSync(resolve(root, ".tmp/m2-jwks/rfc8037.txt"), "utf8");
const xSection = rfc8037.slice(rfc8037.indexOf("\nA.6. "));
const xMatch = xSection.match(/\{"kty":"OKP","crv":"X25519","kid":"Bob",\s*"x":"([^"]+)"\}/);
assert(xMatch);
const x25519 = { kty: "OKP", crv: "X25519", x: xMatch[1] };

function thumbprint(key) {
    const ordered = key.kty === "RSA" ? { e: key.e, kty: key.kty, n: key.n }
        : key.kty === "EC" ? { crv: key.crv, kty: key.kty, x: key.x, y: key.y }
            : { crv: key.crv, kty: key.kty, x: key.x };
    return createHash("sha256").update(JSON.stringify(ordered)).digest("base64url");
}
const materials = { ed25519: ed, rsa, p256: ec, x25519 };
json("public-material.json", Object.fromEntries(Object.entries(materials).map(([name, key]) => {
    assert(!Object.hasOwn(key, "d"));
    createPublicKey({ key, format: "jwk" });
    return [name, { key, thumbprint: thumbprint(key) }];
})), {
    ed25519: "agentsig M2 public test key",
    rsa: "RFC 9421 B.1.2 public PEM exported to JWK",
    p256: "RFC 9421 B.1.3 public PEM exported to JWK",
    x25519: "RFC 8037 A.6 public recipient key; omit optional kid",
});

const cases = [];
function accepted(id, format, keys, selectable, skipped = []) {
    cases.push({
        id, format, jwks: { keys },
        expected: {
            load: "accepted",
            selectableThumbprints: selectable.map(thumbprint),
            skippedCount: skipped.length,
            skipped: skipped.map((key) => ({
                kid: key.kid ?? null, thumbprint: thumbprint(key),
                requestCode: "unsupported-algorithm",
            })),
        },
    });
}
function rejected(id, format, keys) {
    cases.push({ id, format, jwks: { keys }, expected: { load: "rejected", code: "invalid-jwks" } });
}
for (const format of ["jwks", "wg-directory-00"]) {
    const alg = format === "jwks" ? "EdDSA" : "ed25519";
    accepted(`${format}-metadata-absent`, format, [ed], [ed]);
    accepted(`${format}-matching-alg`, format, [{ ...ed, alg }], [ed]);
    accepted(`${format}-thumbprint-kid`, format, [{ ...ed, kid: thumbprint(ed) }], [ed]);
    rejected(`${format}-wrong-alg-vocabulary`, format,
        [{ ...ed, alg: format === "jwks" ? "ed25519" : "EdDSA" }]);
    rejected(`${format}-nonstring-alg`, format, [{ ...ed, alg: 1 }]);
    rejected(`${format}-nonstring-kid`, format, [{ ...ed, kid: 1 }]);
    const skipped = [rsa, ec, x25519].map((key) => ({
        ...key, kid: format === "jwks" ? `label-${key.kty}-${key.crv ?? "rsa"}` : thumbprint(key),
    }));
    accepted(`${format}-mixed-public-keys`, format, [ed, ...skipped], [ed], skipped);
    accepted(`${format}-unsupported-only`, format, skipped, [], skipped);
    const { x: omitted, ...withoutX } = ed;
    assert(omitted);
    rejected(`${format}-missing-okp-x`, format, [withoutX]);
    rejected(`${format}-curve-length-mismatch`, format, [{ ...ed, crv: "Ed448" }]);
    rejected(`${format}-key-type-curve-mismatch`, format, [{ ...ed, crv: "P-256" }]);
    rejected(`${format}-unknown-unhashable-type`, format, [{ kty: "UnknownExampleType" }]);
    const { y: omittedY, ...withoutY } = ec;
    assert(omittedY);
    rejected(`${format}-malformed-unsupported-key-poisons-set`, format, [ed, withoutY]);
    rejected(`${format}-missing-rsa-modulus`, format, [ed, { kty: "RSA", e: rsa.e }]);
}
accepted("jwks-operator-chosen-kid", "jwks", [{ ...ed, kid: "operator-label" }], [ed]);
rejected("wg-directory-operator-chosen-kid", "wg-directory-00", [{ ...ed, kid: "operator-label" }]);

const cfPath = "tests/fixtures/m2/sources/cloudflare-2026-07-01.mdx";
const cf = readFileSync(resolve(root, cfPath), "utf8");
const match = cf.match(/   \{\n     "keys": \[\{[\s\S]*?\n   \}/);
assert(match);
put("cloudflare-directory-displayed.txt", match[0], {
    path: cfPath, section: "2", license: "CC-BY-4.0",
    transformation: "Exact excerpt, including indentation, comment and trailing comma",
});
const cfJson = match[0].replace(/\/\/ Base64 URL-encoded public key, with no padding/g, "")
    .replace(/,\s*(?=\})/g, "");
const cfSet = JSON.parse(cfJson);
assert(!Object.hasOwn(cfSet.keys[0], "alg"));
assert(!Object.hasOwn(cfSet.keys[0], "kid"));
for (const format of ["jwks", "wg-directory-00"]) {
    accepted(`cloudflare-example-${format}`, format, cfSet.keys, cfSet.keys);
}
json("cloudflare-directory.json", cfSet, {
    path: cfPath, section: "2", license: "CC-BY-4.0",
    transformation: "Remove inline comment and trailing comma, parse and pretty-print JSON; not response signature verification",
});
json("load-cases.json", {
    status: "pre-loader-implementation-fixtures",
    testKeyPermission: true,
    notes: [
        "Key loading does not itself approve known test keys for request verification.",
        "Thumbprint selection is independent of alg and kid in both formats.",
        "Malformed-set rejection is the approved local policy, stricter than RFC 7517 section 5 SHOULD-ignore advice.",
        "No unsupported algorithm verification is implemented by these fixtures.",
    ],
    references: {
        jwks: ["RFC 7517 sections 4.4, 4.5, 5", "RFC 8037 sections 2, 3.1"],
        directory: ["Pinned WG-00 sections 5.5 and 5.5.1"],
        thumbprint: ["RFC 7638 section 3.2", "RFC 8037 section 2"],
    },
    cases,
}, { license: "MIT for agentsig-authored case metadata; source-derived key material retains source notices" });
writeFileSync(resolve(root, output, "manifest.json"), JSON.stringify({
    formatVersion: 1, files,
    relatedNotices: [
        "tests/fixtures/m2/sources/IETF-NOTICE.txt",
        "tests/fixtures/m2/sources/cloudflare-LICENSE.txt",
    ],
}, null, 2) + "\n");
console.log(`Pinned ${files.length} JWKS source/data files and ${cases.length} load cases; no loader used.`);