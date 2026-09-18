import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = "tests/fixtures/m2";
const cfCommit = "acfb1f2270b9473ae65a15674995e0b2f3b6ab0c";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const files = [];
const sources = [
    {
        local: ".tmp/m2-research/wg-protocol-00.txt",
        path: "sources/wg-protocol-00.txt",
        sha256: "3021fd94cdffdb2eb030dec68b1a5c968f2348502dd94c481e2085ec7ddd90a0",
        url: "https://www.ietf.org/archive/id/draft-ietf-webbotauth-httpsig-protocol-00.txt",
        license: "IETF Trust Legal Provisions; extracted Code Components: Revised BSD",
    },
    {
        local: ".tmp/m2-research/cloudflare-2026-07-01.mdx",
        path: "sources/cloudflare-2026-07-01.mdx",
        sha256: "c4aeeef723df97b020ecc4d9e680b77b5bfb6c214a6443b0fb7f00efd7e422f7",
        url: `https://raw.githubusercontent.com/cloudflare/cloudflare-docs/${cfCommit}/src/content/docs/bots/reference/bot-verification/web-bot-auth.mdx`,
        commit: cfCommit,
        gitBlob: "3914e02c768bd59a2a42ab82c0ea326517edb40d",
        license: "CC-BY-4.0",
    },
    {
        local: ".tmp/m2-research/cloudflare-LICENSE",
        path: "sources/cloudflare-LICENSE.txt",
        sha256: "9e5f1b3c610b9c2da5c313bf81d577a7d1acec686bdb0384edefa6df0f90cd94",
        url: `https://raw.githubusercontent.com/cloudflare/cloudflare-docs/${cfCommit}/LICENSE`,
        commit: cfCommit,
        license: "CC-BY-4.0",
    },
];

function put(path, value, provenance) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
    const output = resolve(root, destination, path);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, bytes);
    files.push({ path, bytes: bytes.length, sha256: hash(bytes), provenance });
}
function json(path, value, provenance) {
    put(path, JSON.stringify(value, null, 2) + "\n", provenance);
}
for (const source of sources) {
    const bytes = readFileSync(resolve(root, source.local));
    assert.equal(hash(bytes), source.sha256, source.path);
    put(source.path, bytes, source);
}
const wg = readFileSync(resolve(root, sources[0].local), "utf8");
const cf = readFileSync(resolve(root, sources[1].local), "utf8");
const rfcPublicPath = "packages/core/test/fixtures/rfc9421/ed25519-public.pem";
const rfcPublic = readFileSync(resolve(root, rfcPublicPath));
const rfcKey = createPublicKey(rfcPublic);
put("published/rfc9421-public.pem", rfcPublic, {
    source: rfcPublicPath, section: "RFC 9421 B.1.4", transformation: "none",
});
const unfold = (text) => text.replace(/\\\r?\n[ \t]*/g, "");
const inventory = [];
for (const [id, next] of [
    ["E.2.1", "E.2.2."], ["E.2.2", "E.2.3."], ["E.2.3", "Appendix F."],
]) {
    const start = wg.indexOf(`\n${id}. `);
    const end = wg.indexOf(`\n${next} `, start + 1);
    assert(start >= 0 && end > start, id);
    const section = wg.slice(start + 1, end);
    const baseMatch = section.match(/\n("@authority"[\s\S]*?)\n\n/);
    const signatureMatch = section.match(/\nSignature: ([a-z0-9-]+)=:([A-Za-z0-9+/=]+):/);
    const inputStart = section.indexOf("\nSignature-Input: ");
    assert(baseMatch && signatureMatch && inputStart >= 0, id);
    const signatureEnd = section.indexOf("\n", section.indexOf("\nSignature: ") + 1);
    assert(signatureEnd > inputStart);
    const base = Buffer.from(unfold(baseMatch[1]), "utf8");
    const signature = Buffer.from(signatureMatch[2], "base64");
    assert.equal(signature.length, 64);
    assert.equal(verify(null, base, rfcKey, signature), true, id);
    assert.notEqual(base.at(-1), 10);
    const provenance = {
        source: sources[0].path, section: id,
        transformation: "Extract block; unfold RFC 8792; no final LF on base/headers",
        license: "IETF Trust Revised BSD",
    };
    put(`published/wg-${id}/section.txt`, section, {
        ...provenance, transformation: "Exact source section, including publication pagination",
    });
    put(`published/wg-${id}/base.txt`, base, provenance);
    put(`published/wg-${id}/signature.bin`, signature, provenance);
    put(`published/wg-${id}/signature-headers.txt`,
        unfold(section.slice(inputStart + 1, signatureEnd)), provenance);
    inventory.push({
        id, kind: "published-cryptographic-vector", cryptoValid: true,
        label: signatureMatch[1],
        m2Positive: false,
        exclusions: id === "E.2.1"
            ? ["agent-member-label-mismatch", "missing-method-and-target-uri", "lifetime-exceeds-M2-policy"]
            : id === "E.2.2"
                ? ["legacy-format-not-WG-signer-profile", "missing-method-and-target-uri", "lifetime-exceeds-M2-policy"]
                : ["directory-response-outside-M2-scope"],
    });
}

// Keep the displayed Cloudflare request exactly as a source-format fixture.
// Its indented continuation lines are presentation, not valid literal wire lines.
const cfSectionStart = cf.indexOf("### 4.4.");
const cfExample = cf.slice(cfSectionStart).match(/```txt\n([\s\S]*?)\n```/);
assert(cfSectionStart >= 0 && cfExample);
put("published/cloudflare/request-displayed.txt", cfExample[1], {
    source: sources[1].path, section: "4.4",
    transformation: "Extract fenced block content; exclude fence and final LF; otherwise unchanged",
    license: "CC-BY-4.0",
});
const cfHeaders = cfExample[1].replace(/\n[ \t]+(?=;)/g, "");
put("published/cloudflare/request-headers.txt", cfHeaders, {
    source: sources[1].path, section: "4.4",
    transformation: "Join displayed metadata continuation lines; no other normalization; no final LF",
    license: "CC-BY-4.0",
});
inventory.push({
    id: "cloudflare-section-4.4",
    kind: "document-serialization-fixture",
    cryptoCrossReference: "WG E.2.2 (requires example.com authority and RFC public key)",
    m2Positive: false,
    exclusions: ["missing-method-and-target-uri", "lifetime-exceeds-M2-policy"],
});
inventory.push({
    id: "WG E.1.1/E.1.2", kind: "published-rsa-vectors",
    checked: false, exclusions: ["RSA-outside-Ed25519-scope"],
});

// New fixture key: deterministically derived PUBLIC TEST MATERIAL, never secret.
// No system randomness, runtime default key, agentsig parser, or signer is used.
const seed = createHash("sha256").update("agentsig M2 PUBLIC TEST KEY 2026-09-18").digest();
const privateKey = createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
    format: "der", type: "pkcs8",
});
const publicKey = createPublicKey(privateKey);
const publicJwk = publicKey.export({ format: "jwk" });
const thumbprintInput = JSON.stringify({ crv: publicJwk.crv, kty: publicJwk.kty, x: publicJwk.x });
const keyid = createHash("sha256").update(thumbprintInput).digest("base64url");
const own = { source: "agentsig independently authored test data", license: "MIT", productionSafe: false };
put("generated/public-test-private.pem", privateKey.export({ format: "pem", type: "pkcs8" }), own);
put("generated/public-test-public.pem", publicKey.export({ format: "pem", type: "spki" }), own);
put("generated/thumbprint-input.txt", thumbprintInput, own);
json("generated/jwks.json", { keys: [{ ...publicJwk, kid: keyid, use: "sig" }] }, own);

for (const profile of ["ietf-wg-protocol-00", "cloudflare-docs-2026-07-01"]) {
    const label = "agent";
    const agent = profile.startsWith("ietf")
        ? 'agent="https://agent.example"' : '"https://agent.example"';
    const component = profile.startsWith("ietf")
        ? '"signature-agent";key="agent"' : '"signature-agent"';
    const covered = `("@method" "@target-uri" ${component})`;
    const metadata = `;created=1800000000;expires=1800000060;keyid="${keyid}";alg="ed25519";nonce="m2-public-test-nonce-0001";tag="web-bot-auth"`;
    const signatureInput = label + "=" + covered + metadata;
    // Fixed literal expected components; NOT a general protocol implementation.
    const base = Buffer.from([
        '"@method": GET',
        '"@target-uri": https://merchant.example/items?sku=42',
        `${component}: "https://agent.example"`,
        `"@signature-params": ${covered}${metadata}`,
    ].join("\n"));
    const signature = sign(null, base, privateKey);
    assert(verify(null, base, publicKey, signature));
    const headers = [
        `Signature-Agent: ${agent}`,
        `Signature-Input: ${signatureInput}`,
        `Signature: ${label}=:${signature.toString("base64")}:`,
    ].join("\n");
    put(`generated/${profile}/base.txt`, base, own);
    put(`generated/${profile}/signature.bin`, signature, own);
    put(`generated/${profile}/headers.txt`, headers, own);
    json(`generated/${profile}/case.json`, {
        kind: "agentsig-generated-cryptographic-fixture", profile,
        publicTestKey: true, now: 1800000000,
        method: "GET", targetUri: "https://merchant.example/items?sku=42",
        label, agentClaim: "https://agent.example", keyid,
        expected: {
            status: "verified", identityKind: "key-thumbprint",
            replayProtected: true, reason: "nonce-consumed",
        },
        prerequisites: ["fresh replay store", "explicit test-key permission if enabled"],
    }, own);
}
json("vector-inventory.json", inventory, own);
json("sources.json", sources.map(({ local, ...source }) => source), own);

// Local policy fixtures are authored before implementation, not produced by it.
// Normalize editor EOLs only for this local document; upstream bytes stay exact.
const policyPath = resolve(root, destination, "policy-cases.json");
const policyBytes = readFileSync(policyPath, "utf8").replace(/\r\n/g, "\n");
JSON.parse(policyBytes);
put("policy-cases.json", policyBytes, {
    ...own, transformation: "Local authored policy data; editor CRLF converted to LF",
});
const rfcLicensePath = "packages/core/test/fixtures/rfc9421/LICENSE.txt";
const license = readFileSync(resolve(root, rfcLicensePath), "utf8")
    .replace(/\r\n/g, "\n")
    .split("\nSource:")[0]
    .replace("RFC 9421 extracted Code Components", "RFC 9421 and WG protocol-00 extracted Code Components")
    .replace("Copyright (c) 2024 IETF Trust", "Copyright (c) 2024, 2026 IETF Trust");
put("sources/IETF-NOTICE.txt", license + [
    "",
    "Sources: RFC 9421 B.1.4 and draft-ietf-webbotauth-httpsig-protocol-00 Appendix E.",
    "RFC authors: Annabelle Backman, Justin Richer, Manu Sporny.",
    "Draft authors: Thibault Meunier, Sandor Major.",
    "https://www.rfc-editor.org/rfc/rfc9421.html",
    "https://www.ietf.org/archive/id/draft-ietf-webbotauth-httpsig-protocol-00.txt",
    "https://trustee.ietf.org/license-info",
    "Complete source documents retain their original IETF Trust notices.",
    "PUBLIC TEST KEYS ONLY. Never use these keys in production.",
    "",
].join("\n"), {
    source: rfcLicensePath,
    transformation: "Retain Revised BSD terms; extend attribution to WG-00",
});
const output = resolve(root, destination, "manifest.json");
writeFileSync(output, JSON.stringify({
    formatVersion: 1,
    retrievedOn: "2026-09-18",
    warning: "All private keys in this fixture set are PUBLIC TEST MATERIAL.",
    files: files.sort((a, b) => a.path.localeCompare(b.path, "en")),
}, null, 2) + "\n", "utf8");
console.log(`M2: ${files.length} pinned source/vector files. No agentsig implementation used.`);