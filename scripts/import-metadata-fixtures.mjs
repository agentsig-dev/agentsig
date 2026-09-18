import assert from "node:assert/strict";
import { createHash, createPublicKey } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Pre-implementation expectations; no agentsig parser, loader or verifier.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = resolve(root, "tests/fixtures/metadata");
const files = [];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function put(path, text, source) {
    const bytes = Buffer.from(text, "utf8");
    mkdirSync(dirname(resolve(destination, path)), { recursive: true });
    writeFileSync(resolve(destination, path), bytes);
    files.push({ path, bytes: bytes.length, sha256: hash(bytes), source });
}
function json(path, value) {
    put(path, JSON.stringify(value, null, 2) + "\n", {
        author: "agentsig", license: "MIT", kind: "independently authored expectations",
    });
}
function excerpt(path, digest, start, end, output, license) {
    const bytes = readFileSync(resolve(root, path));
    assert.equal(hash(bytes), digest);
    const text = bytes.toString("utf8");
    const from = text.indexOf("\n" + start);
    const to = text.indexOf("\n" + end, from + 1);
    assert(from >= 0 && to > from, output);
    put(output, text.slice(from + 1, to), {
        path, sha256: digest, start, endExclusive: end,
        transformation: "Exact excerpt; no whitespace or wording normalization",
        license,
    });
}
const ietf = "Original IETF Trust notices retained in full source; related notice in manifest";
excerpt("tests/fixtures/sources/rfc9421.txt",
    "612655786bf4293bfc486e4177571467fbb3de6e6f0eea90cb74c346a34fdf3c",
    "3.2.  Verifying a Signature\n", "3.3.  Signature Algorithms\n",
    "sources/rfc9421-3.2.txt", ietf);
excerpt("tests/fixtures/sources/rfc9421.txt",
    "612655786bf4293bfc486e4177571467fbb3de6e6f0eea90cb74c346a34fdf3c",
    "2.3.  Signature Parameters\n", "2.4.  Signing Request Components",
    "sources/rfc9421-2.3.txt", ietf);
excerpt("tests/fixtures/m2/sources/wg-protocol-00.txt",
    "3021fd94cdffdb2eb030dec68b1a5c968f2348502dd94c481e2085ec7ddd90a0",
    "5.2.  Generating HTTP Message Signature\n", "5.2.1.  Signature-Agent\n",
    "sources/wg-5.2.txt", ietf);
excerpt("tests/fixtures/m2/sources/cloudflare-2026-07-01.mdx",
    "c4aeeef723df97b020ecc4d9e680b77b5bfb6c214a6443b0fb7f00efd7e422f7",
    "### 4.2. Calculate the JWK thumbprint\n", "### 4.3. Construct the required headers\n",
    "sources/cloudflare-4.2.mdx", "CC-BY-4.0; Cloudflare and contributors");

const publicPath = "tests/fixtures/m2/generated/public-test-public.pem";
const publicBytes = readFileSync(resolve(root, publicPath));
const publicJwk = createPublicKey(publicBytes).export({ format: "jwk" });
const thumbprint = createHash("sha256").update(JSON.stringify({
    crv: publicJwk.crv, kty: publicJwk.kty, x: publicJwk.x,
})).digest("base64url");
assert.equal(thumbprint, "DR68nui99ukl-GUgfzQGaU3VwqRtArw-_DCN4LFtY84");
const otherKey = createPublicKey(readFileSync(resolve(root,
    "tests/fixtures/m2/published/rfc9421-public.pem"))).export({ format: "jwk" });
const otherThumbprint = "poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U";
const cases = [];
const rejected = (reason, boundary = "candidate", rule) => ({
    accepted: false, status: reason === "unknown-key" ? "unverified" : "invalid",
    reason, boundary, ...(rule ? { rule } : {}),
});
for (const profile of ["ietf-wg-protocol-00", "cloudflare-docs-2026-07-01"]) {
    function add(id, layer, input, expected) {
        cases.push({ id: `${profile}-${id}`, profile, layer, input, expected });
    }
    const agentComponent = profile === "ietf-wg-protocol-00"
        ? '"signature-agent";key="agent"' : '"signature-agent"';
    const metadata = {
        created: 1800000000, expires: 1800000060, keyid: thumbprint,
        alg: "ed25519", nonce: "metadata-fixture", tag: "web-bot-auth",
    };
    const wireInput = `agent=("@method" "@target-uri" ${agentComponent})` +
        `;created=1800000000;expires=1800000060;keyid="${thumbprint}"` +
        ';alg="ed25519";nonce="metadata-fixture";tag="web-bot-auth"';
    const headers = [["Signature-Input", wireInput], ["Signature", "agent=:AA==:"]];
    add("wire-valid", "wire-types", { headers }, { accepted: true, candidateLabels: ["agent"] });
    add("wire-alg-token", "wire-types", {
        headers: [["Signature-Input", wireInput.replace(';alg="ed25519"', ";alg=ed25519")], headers[1]],
    }, rejected("malformed-signature", "whole-request"));
    add("required-present", "required-metadata", { metadata }, { accepted: true });
    for (const name of ["created", "expires", "keyid"]) {
        const missing = { ...metadata };
        delete missing[name];
        add(`missing-${name}`, "required-metadata", { metadata: missing },
            rejected("missing-required-parameter"));
    }
    add("thumbprint-valid", "keyid-format", { keyid: thumbprint }, { accepted: true });
    for (const [name, keyid, rule] of [
        ["padded", thumbprint + "=", "keyid must use unpadded base64url"],
        ["wrong-length", "YQ", "keyid must decode to exactly 32 bytes"],
        ["invalid-alphabet", "+" + thumbprint.slice(1), "keyid must use unpadded base64url"],
        ["pad-bit-alias", thumbprint.slice(0, -1) + "5", "keyid must use canonical base64url encoding"],
        ["empty", "", "keyid must decode to exactly 32 bytes"],
    ]) {
        add(`thumbprint-${name}`, "keyid-format", { keyid },
            rejected("invalid-parameter", "candidate", rule));
    }
    add("lookup-found", "key-lookup", {
        keyid: thumbprint, jwks: { keys: [publicJwk] },
    }, { accepted: true, selectedThumbprint: thumbprint });
    add("lookup-unknown", "key-lookup", {
        keyid: otherThumbprint, jwks: { keys: [publicJwk] },
    }, rejected("unknown-key"));
    add("selected-key-matches", "selected-key-binding", {
        keyid: thumbprint, selectedPublicJwk: publicJwk,
    }, { accepted: true, recomputedThumbprint: thumbprint });
    add("selected-key-mismatch", "selected-key-binding", {
        keyid: thumbprint, selectedPublicJwk: otherKey,
    }, rejected("key-id-mismatch"));

    for (const [name, tag] of [["absent", undefined], ["different", "other-protocol"]]) {
        const text = tag === undefined ? wireInput.replace(';tag="web-bot-auth"', "")
            : wireInput.replace(';tag="web-bot-auth"', `;tag="${tag}"`);
        add(`tag-${name}`, "candidate-selection", {
            headers: [["Signature-Input", text], headers[1]],
        }, { accepted: false, status: "unsigned", reason: "no-web-bot-auth-candidate" });
    }
    const withoutNonce = { ...metadata };
    delete withoutNonce.nonce;
    add("nonce-required", "nonce-policy", { metadata: withoutNonce, noncePolicy: "required" },
        rejected("nonce-required"));
    add("nonce-optional", "nonce-policy", { metadata: withoutNonce, noncePolicy: "optional" },
        { accepted: true, noncePresent: false });
    add("nonce-empty", "nonce-policy", { metadata: { ...metadata, nonce: "" }, noncePolicy: "optional" },
        rejected("nonce-invalid"));
}
json("cases.json", {
    stage: "separate metadata gates; not complete request verification",
    notes: [
        "Each of the five metadata layers has a positive counterpart and negative cases in BOTH profiles.",
        "Dummy signature bytes test syntax only; accepted means this gate passed, not verified.",
        "RFC 9421 3.2 steps 1-3 and final failure rule require parsing for signature validation.",
        "Whole-request rejection of any malformed pair is agentsig's retained M1 all-pairs policy, not a claim that RFC mandates rejecting every unrelated valid signature.",
        "Thumbprint shape is a profile rule (WG 5.2, Cloudflare 4.2), not generic RFC 9421 keyid syntax.",
        "Wrong SF metadata types fail at the whole-request parser boundary before candidate evaluation.",
        "Key selection uses recomputed thumbprints, never operator-chosen kid labels.",
        "key-id-mismatch is defensive selected-key identity validation; normal loadJwks lookup does not produce it.",
        "Canonical base64url rejects alternate pad-bit spellings of the same 32 bytes.",
    ],
    publicKeySource: { path: publicPath, sha256: hash(publicBytes) },
    cases,
});
writeFileSync(resolve(destination, "manifest.json"), JSON.stringify({
    formatVersion: 1, approvedOn: "2026-09-18",
    relatedNotices: [
        "tests/fixtures/m2/sources/IETF-NOTICE.txt",
        "tests/fixtures/m2/sources/cloudflare-LICENSE.txt",
    ],
    files,
}, null, 2) + "\n");
console.log(`Pinned ${files.length} metadata source/data files and ${cases.length} gate cases.`);