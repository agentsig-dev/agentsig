import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
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
const originalCaseCount = cases.length;
cases.length = 0;

// Preserve the exact WG sections, not a rewritten summary of their requirements.
const wgPath = "tests/fixtures/m2/sources/wg-protocol-00.txt";
const wgBytes = readFileSync(resolve(root, wgPath));
assert.equal(hash(wgBytes), "3021fd94cdffdb2eb030dec68b1a5c968f2348502dd94c481e2085ec7ddd90a0");
const wg = wgBytes.toString("utf8");
const wgStart = wg.indexOf("\n5.5.  Key Distribution and Discovery\n");
const wgEnd = wg.indexOf("\n5.5.2.  Key Rotation\n", wgStart);
assert(wgStart >= 0 && wgEnd > wgStart);
put("wg-discovery-format-excerpt.txt", wg.slice(wgStart + 1, wgEnd), {
    path: wgPath, sections: ["5.5", "5.5.1"],
    transformation: "Exact section excerpt, including page breaks; no wording changes",
    license: "Original IETF Trust notices in full source; see related IETF notice",
});

// Public test material only. Deterministic independent Node derivation; this
// does not implement or test Ed448 request signing/verification in agentsig.
const ed448Seed = createHash("sha512")
    .update("agentsig JWKS Ed448 PUBLIC TEST KEY 2026-09-18").digest().subarray(0, 57);
const ed448 = createPublicKey(createPrivateKey({
    key: Buffer.concat([Buffer.from("3047020100300506032b6571043b0439", "hex"), ed448Seed]),
    format: "der", type: "pkcs8",
})).export({ format: "jwk" });
json("ed448-public-material.json", {
    key: ed448, thumbprint: thumbprint(ed448),
    derivation: "First 57 bytes of SHA-512(UTF-8 label), Ed448 PKCS8 seed, Node public export",
    label: "agentsig JWKS Ed448 PUBLIC TEST KEY 2026-09-18",
    warning: "PUBLIC TEST KEY, never use in production",
}, { license: "MIT; agentsig-authored deterministic test material" });

function metadataRejected(id, format, key, rule) {
    // Index 1 proves diagnostics locate the failing entry rather than always 0.
    rejected(`${format}-${id}`, format, [ed, key]);
    cases.at(-1).expected.diagnostic = {
        keyIndex: 1, kid: typeof key.kid === "string" ? key.kid : null, rule,
    };
}
for (const format of ["jwks", "wg-directory-00"]) {
    const kid = format === "jwks" ? "operator-label" : thumbprint(ed);
    for (const [name, metadata] of [
        ["use-sig", { use: "sig" }],
        ["verify-only", { key_ops: ["verify"] }],
        ["sign-and-verify", { key_ops: ["sign", "verify"] }],
        ["verify-and-sign", { key_ops: ["verify", "sign"] }],
        ["consistent-use-ops", { use: "sig", key_ops: ["verify"] }],
    ]) {
        accepted(`${format}-${name}`, format, [{ ...ed, kid, ...metadata }], [ed]);
    }
    for (const [name, metadata, rule] of [
        ["use-enc", { use: "enc" }, "Ed25519 use must be sig"],
        ["use-extension", { use: "custom" }, "Ed25519 use must be sig"],
        ["use-not-string", { use: 42 }, "use must be a string"],
        ["ops-not-array", { key_ops: "verify" }, "key_ops must be an array of strings"],
        ["ops-nonstring", { key_ops: ["verify", 42] }, "key_ops must be an array of strings"],
        ["ops-duplicate", { key_ops: ["verify", "verify"] }, "key_ops must not contain duplicates"],
        ["ops-empty", { key_ops: [] }, "Ed25519 key_ops must include verify and only sign/verify"],
        ["ops-sign-only", { key_ops: ["sign"] }, "Ed25519 key_ops must include verify and only sign/verify"],
        ["ops-unrelated", { key_ops: ["verify", "encrypt"] }, "Ed25519 key_ops must include verify and only sign/verify"],
        ["ops-extension", { key_ops: ["verify", "custom"] }, "Ed25519 key_ops must include verify and only sign/verify"],
        ["use-ops-conflict", { use: "sig", key_ops: ["encrypt"] }, "use and key_ops must be consistent"],
    ]) {
        metadataRejected(name, format, { ...ed, kid, ...metadata }, rule);
    }
    // Same kty as Ed25519; curve, not OKP alone, determines policy applicability.
    for (const [name, material] of [["x25519", x25519], ["ed448", ed448]]) {
        const key = {
            ...material, use: "enc",
            kid: format === "jwks" ? `unsupported-${name}` : thumbprint(material),
        };
        accepted(`${format}-${name}-enc-skipped`, format, [ed, key], [ed], [key]);
        metadataRejected(`${name}-bad-use-type`, format, { ...key, use: 42 },
            "use must be a string");
        metadataRejected(`${name}-duplicate-ops`, format,
            { ...key, key_ops: ["deriveKey", "deriveKey"] }, "key_ops must not contain duplicates");
        metadataRejected(`${name}-conflicting-ops`, format,
            { ...key, key_ops: ["verify"] }, "use and key_ops must be consistent");
    }
    metadataRejected("missing-kid-diagnostic", format, { ...ed, use: "enc" },
        "Ed25519 use must be sig");
    metadataRejected("wrong-kid-type-diagnostic", format, { ...ed, kid: 42 },
        "kid must be a string");
}
metadataRejected("escaped-kid-diagnostic", "jwks",
    { ...ed, kid: "operator\\label\n\u001b[31m", use: "enc" }, "Ed25519 use must be sig");
metadataRejected("kid-mismatch-diagnostic", "wg-directory-00",
    { ...ed, kid: "operator-label" }, "kid must equal the RFC 7638 thumbprint");

json("metadata-cases.json", {
    status: "approved-policy-pre-loader-implementation-fixtures",
    references: ["RFC 7517 sections 4.2, 4.3, 4.5", "WG-00 sections 5.5, 5.5.1"],
    policy: {
        ed25519: "After structural validation, apply A only to crv Ed25519, not all OKP",
        otherCurves: "Valid unsupported keys are reported and skipped, including use enc",
        formats: "A is identical in both formats; WG adds no use/key_ops rule",
        kid: "jwks permits arbitrary string labels; wg-directory-00 requires matching thumbprint",
        diagnostic: "invalid-jwks message includes zero-based index, string kid when present, and violated rule",
        diagnosticSafety: "Escape control characters in kid; do not include key bytes, private material or backend errors",
        catalog: "Unchanged; diagnostic rule descriptions are not new result codes",
    },
    cases,
}, { license: "MIT for policy metadata; source-derived keys retain original notices" });
const metadataCaseCount = cases.length;
cases.length = 0;
const ianaBytes = readFileSync(resolve(root, ".tmp/m2-jwks/iana-http-message-signature.xml"));
const ianaDigest = "bd4b0304e21e226fef189ed283a31392b5ffc99a37d00e9911dc011dcfb1523f";
assert.equal(hash(ianaBytes), ianaDigest);
const ianaSource = {
    url: "https://www.iana.org/assignments/http-message-signature/http-message-signature.xml",
    retrievedAt: "2026-09-18T20:36:24.390Z",
    registryUpdated: "2026-07-20",
    lastModified: "Mon, 20 Jul 2026 09:11:20 GMT",
    sha256: ianaDigest,
    attribution: "Internet Assigned Numbers Authority (IANA), HTTP Message Signature registry",
    reference: "RFC 9421 section 6.2",
};
put("sources/iana-http-message-signature.xml", ianaBytes, ianaSource);
const algorithmSection = ianaBytes.toString("utf8")
    .match(/<registry id="signature-algorithms">([\s\S]*?)<\/registry>/);
assert(algorithmSection);
const httpNames = [...algorithmSection[1].matchAll(/<name>([^<]+)<\/name>/g)]
    .map((match) => match[1]);
assert.equal(httpNames.length, 6);

// Use the registration Usage Location, not name shape, to exclude enc entries.
const joseRecords = [];
for (const rfc of [7518, 8037]) {
    const text = readFileSync(resolve(root, output, `sources/rfc${rfc}.txt`), "utf8");
    for (const record of text.matchAll(/o  Algorithm Name: "([^"]+)"([\s\S]*?)(?=\n   o  Algorithm Name:|\n7\.2\.|\n5\.|\s*$)/g)) {
        const usage = record[2].match(/Algorithm Usage Location\(s\): "([^"]+)"/);
        assert(usage, `Missing usage location: ${record[1]}`);
        if (usage[1] === "alg") joseRecords.push({ name: record[1], rfc });
    }
}
const joseNames = joseRecords.map((record) => record.name);
assert(joseNames.includes("PS512") && joseNames.includes("EdDSA"));
assert(!joseNames.includes("A128GCM") && !joseNames.includes("A128CBC-HS256"));
assert.equal(new Set(joseNames).size, joseNames.length);
assert(joseNames.every((name) => !httpNames.includes(name)));
json("algorithm-lists.json", {
    purpose: "Metadata-name classification only; not supported verification algorithms",
    jwks: { references: ["RFC 7518 section 7.1.2", "RFC 8037 section 5"], records: joseRecords, names: joseNames },
    "wg-directory-00": { source: ianaSource, names: httpNames },
}, { license: "agentsig-authored extraction metadata; RFC notices retained; IANA attribution in source" });

function algorithmAccepted(id, format, keys, selectable, skipped, reason) {
    accepted(`${format}-${id}`, format, keys, selectable, skipped);
    for (const report of cases.at(-1).expected.skipped) report.reason = reason;
}
for (const format of ["jwks", "wg-directory-00"]) {
    const ownNames = format === "jwks" ? joseNames : httpNames;
    const otherNames = format === "jwks" ? httpNames : joseNames;
    const edName = format === "jwks" ? "EdDSA" : "ed25519";
    for (const [name, material] of [["rsa", rsa], ["p256", ec], ["x25519", x25519], ["ed448", ed448]]) {
        const key = { ...material, kid: format === "jwks" ? `label-${name}` : thumbprint(material) };
        algorithmAccepted(`${name}-alg-absent`, format, [ed, key], [ed], [key], "unsupported-algorithm");
        // Deliberately includes key/algorithm mismatches: approved policy B
        // does not implement a general compatibility table for skipped keys.
        for (const alg of ownNames) {
            if (alg === edName) {
                metadataRejected(`${name}-own-ed-name`, format, { ...key, alg },
                    "Ed25519 algorithm name requires crv Ed25519");
            } else {
                const declared = { ...key, alg };
                algorithmAccepted(`${name}-own-${alg}`, format, [ed, declared], [ed],
                    [declared], "unsupported-algorithm");
            }
        }
        for (const alg of otherNames) {
            metadataRejected(`${name}-opposite-${alg}`, format, { ...key, alg },
                "alg belongs to the opposite JWKS format");
        }
        const unknown = { ...key, alg: "future-example-algorithm" };
        algorithmAccepted(`${name}-unknown-name`, format, [ed, unknown], [ed],
            [unknown], "unknown-algorithm-name");
        metadataRejected(`${name}-nonstring-alg`, format, { ...key, alg: 42 },
            "alg must be an ASCII string");
        metadataRejected(`${name}-nonascii-alg`, format, { ...key, alg: "alg-\u00e9" },
            "alg must be an ASCII string");
    }
    algorithmAccepted("ed25519-absent", format, [ed], [ed], [], "unsupported-algorithm");
    algorithmAccepted("ed25519-correct", format, [{ ...ed, alg: edName }], [ed], [], "unsupported-algorithm");
    for (const alg of [...ownNames, ...otherNames, "future-example-algorithm"]) {
        if (alg !== edName) {
            metadataRejected(`ed25519-wrong-${alg}`, format, { ...ed, alg },
                "Ed25519 alg must match the selected JWKS format");
        }
    }
    // Synthetic marker, not an actual published production secret.
    for (const key of [{ kty: "oct" }, { kty: "oct", k: "UFVCTElDLVRFU1Q" }]) {
        metadataRejected(`symmetric-${Object.hasOwn(key, "k") ? "with-k" : "without-k"}`,
            format, key, "public JWKS must not contain symmetric keys");
    }
}
json("algorithm-cases.json", {
    status: "approved-policy-pre-loader-implementation-fixtures",
    rules: [
        "Unsupported public key, alg absent: skip and report unsupported-algorithm",
        "Unsupported public key, own-format known name: skip; no general key/algorithm compatibility check",
        "Opposite-format known name: invalid-jwks",
        "Name unknown to both snapshots: skip and report unknown-algorithm-name",
        "Own-format Ed25519 algorithm name on another curve/type: invalid-jwks",
        "Symmetric kty oct in public JWKS: invalid-jwks, even without k",
    ],
    notes: [
        "All skipped keys remain outside the verification pool; request lookup yields unsupported-algorithm",
        "Skip reason unknown-algorithm-name is load-report metadata, not a result-catalog addition",
        "WG 5.5.1 registry membership is strictly enforced for usable keys, not fully validated for skipped keys",
        "Acceptance of a set with unknown-name skipped entries is not full WG directory conformance",
        "Ed448 with EdDSA is valid JOSE in RFC 8037 but rejected by the explicitly approved local Ed25519-name exception",
        "Generic compatibility is deliberately unchecked: for example RSA with ES256 is skipped, never verified",
        "Ed25519 remains strict: absent or exactly EdDSA for jwks, absent or exactly ed25519 for wg-directory-00",
    ],
    cases,
}, { license: "MIT for case metadata; source-derived public keys retain source notices" });
writeFileSync(resolve(root, output, "manifest.json"), JSON.stringify({
    formatVersion: 1, files,
    relatedNotices: [
        "tests/fixtures/m2/sources/IETF-NOTICE.txt",
        "tests/fixtures/m2/sources/cloudflare-LICENSE.txt",
    ],
}, null, 2) + "\n");
console.log(`Pinned ${files.length} files, ${originalCaseCount} load, ${metadataCaseCount} usage and ${cases.length} algorithm cases; no loader used.`);
console.log(JSON.stringify({ joseNames, httpNames }, null, 2));