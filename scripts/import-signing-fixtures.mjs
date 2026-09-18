import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Independent fixture construction: no agentsig imports or general SF encoder.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = resolve(root, "tests/fixtures/signing");
const files = [];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function put(path, data) {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
    const target = resolve(destination, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    files.push({ path, bytes: bytes.length, sha256: hash(bytes) });
}
function json(path, data) {
    put(path, JSON.stringify(data, null, 2) + "\n");
}

const codes = [
    "existing-signature-headers",
    "invalid-signing-key",
    "test-key-disallowed",
    "invalid-agent-origin",
    "invalid-label",
    "unsupported-profile",
    "unsupported-component",
    "invalid-request",
    "invalid-signing-options",
    "clock-unavailable",
    "nonce-generation-failed",
    "resource-limit",
    "signing-failed",
];
json("contract.json", {
    catalogVersion: 1,
    approvedOn: "2026-09-18",
    catalogFrozen: true,
    changePolicy: "Changes require separate approval and release notes.",
    separateFromVerificationCatalog: true,
    errorClass: "SigningError",
    codes,
    defaults: {
        label: "sig1",
        profile: "ietf-wg-protocol-00",
        lifetimeSeconds: 60,
        clock: "Date.now; synchronous Unix milliseconds",
        nonce: "crypto.randomBytes(32), unpadded base64url",
    },
    contract: [
        "Return three canonical name/value pairs; never mutate request or its headers array.",
        "Existing signature headers are detected case-insensitively, even with empty values.",
        "Existing-header rejection precedes clock, nonce and crypto calls.",
        "Clock output must be a finite nonnegative number; created is floor(ms/1000).",
        "created and expires must be representable RFC 9421 SF integers.",
        "Nonce uses the same 1–256 printable ASCII validation helper as the verifier.",
        "Serialize nonce as SF string; never concatenate an unescaped provider result.",
        "Use the shared origin validator, with canonical origin in newly emitted agent headers.",
        "Provider failures expose no raw exception, nonce or key material in message/details.",
        "Clock/nonce providers are synchronous; remote signing providers are a future interface.",
        "Custom clock/nonce providers are test hooks; deterministic overrides are unsafe in production.",
        "Golden acceptance is byte equality, not a signer/verifier round trip.",
        "Full offline verified round trip is mandatory after time/replay/verifier implementation.",
    ],
});

const privatePath = "tests/fixtures/m2/generated/public-test-private.pem";
const publicPath = "tests/fixtures/m2/generated/public-test-public.pem";
const privateKey = createPrivateKey(readFileSync(resolve(root, privatePath)));
const publicKey = createPublicKey(readFileSync(resolve(root, publicPath)));
assert(createPublicKey(privateKey).equals(publicKey));
const jwk = publicKey.export({ format: "jwk" });
const keyid = createHash("sha256").update(JSON.stringify({
    crv: jwk.crv, kty: jwk.kty, x: jwk.x,
})).digest("base64url");
assert.equal(keyid, "DR68nui99ukl-GUgfzQGaU3VwqRtArw-_DCN4LFtY84");

const profiles = ["ietf-wg-protocol-00", "cloudflare-docs-2026-07-01"];
// Expected SF spellings are authored literally, not obtained from a serializer.
const nonces = [
    { id: "default-label", label: "sig1", nonce: "fixed-signing-nonce", sf: '"fixed-signing-nonce"' },
    { id: "escaped-nonce", label: "custom-agent", nonce: 'quote"slash\\end', sf: '"quote\\"slash\\\\end"' },
];
const vectors = [];
for (const profile of profiles) {
    for (const example of nonces) {
        const wg = profile === "ietf-wg-protocol-00";
        const agentComponent = wg
            ? `"signature-agent";key="${example.label}"` : '"signature-agent"';
        const components = `("@method" "@target-uri" ${agentComponent})`;
        const metadata = ';created=1800000000;expires=1800000060' +
            `;keyid="${keyid}";alg="ed25519";nonce=${example.sf};tag="web-bot-auth"`;
        const base = [
            '"@method": GET',
            '"@target-uri": https://merchant.example/items?sku=42',
            `${agentComponent}: "https://agent.example"`,
            `"@signature-params": ${components}${metadata}`,
        ].join("\n");
        const signature = sign(null, Buffer.from(base), privateKey);
        assert.equal(signature.length, 64);
        assert(verify(null, Buffer.from(base), publicKey, signature));
        const headers = [
            ["Signature-Input", `${example.label}=${components}${metadata}`],
            ["Signature", `${example.label}=:${signature.toString("base64")}:`],
            ["Signature-Agent", wg ? `${example.label}="https://agent.example"` : '"https://agent.example"'],
        ];
        const id = `${profile}/${example.id}`;
        put(`${id}/base.txt`, base);
        put(`${id}/signature.bin`, signature);
        put(`${id}/headers.txt`, headers.map(([name, value]) => `${name}: ${value}`).join("\n"));
        json(`${id}/case.json`, {
            id, profile, label: example.label,
            agentOrigin: "HTTPS://AGENT.EXAMPLE:443/",
            request: {
                method: "GET", targetUri: "https://merchant.example/items?sku=42",
                headers: [["X-Example", "unchanged"]],
            },
            clockMilliseconds: 1800000000999.5,
            nonce: example.nonce,
            lifetimeSeconds: 60,
            allowTestKeys: true,
            expectedHeaders: headers,
        });
        vectors.push(id);
    }
}

const collisions = [];
for (const name of ["Signature", "Signature-Input", "Signature-Agent"]) {
    for (const spelling of [name, name.toLowerCase(), name.toUpperCase()]) {
        for (const value of ["", "already-present"]) {
            collisions.push({
                header: [spelling, value], expectedCode: "existing-signature-headers",
                clockCalls: 0, nonceCalls: 0,
            });
        }
    }
}
json("negative-cases.json", {
    // Tagged descriptors represent non-JSON JS values without lossy coercion.
    clock: [
        { kind: "nan" }, { kind: "positive-infinity" }, { kind: "negative-infinity" },
        { kind: "number", value: -1 }, { kind: "number", value: -0.5 },
        { kind: "string", value: "1800000000000" }, { kind: "null" },
        { kind: "undefined" }, { kind: "object" }, { kind: "promise" },
        { kind: "throw", message: "PRIVATE-PROVIDER-MARKER" },
        { kind: "number", value: Number.MAX_VALUE },
    ].map((output) => ({ output, expectedCode: "clock-unavailable" })),
    nonce: [
        { kind: "string", value: "" }, { kind: "string", value: "\t" },
        { kind: "string", value: "\n" }, { kind: "string", value: "\u007f" },
        { kind: "string", value: "ü" }, { kind: "string", value: "a".repeat(257) },
        { kind: "number", value: 42 }, { kind: "null" },
        { kind: "undefined" }, { kind: "object" }, { kind: "promise" },
        { kind: "throw", message: "PRIVATE-PROVIDER-MARKER" },
    ].map((output) => ({ output, expectedCode: "nonce-generation-failed" })),
    existingHeaders: collisions,
    notes: [
        "Promise output is invalid, not awaited; providers are synchronous.",
        "Finite enormous clock output cannot become a representable signed timestamp.",
        "Exception markers are synthetic test data and must never appear in error message/details.",
        "Retain request object, headers-array and header-entry references across both success and failure.",
    ],
});
json("nonce-boundaries.json", {
    cases: [
        { nonce: " ", valid: true },
        { nonce: "a", valid: true },
        { nonce: "a".repeat(256), valid: true },
        { nonce: 'quote"slash\\end', valid: true },
        { nonce: "a".repeat(257), valid: false },
        { nonce: "", valid: false },
    ],
});
writeFileSync(resolve(destination, "manifest.json"), JSON.stringify({
    formatVersion: 1,
    approvedOn: "2026-09-18",
    warning: "Public test keys only; never production credentials.",
    sourceKeys: [privatePath, publicPath].map((path) => ({
        path, sha256: hash(readFileSync(resolve(root, path))),
    })),
    catalogSha256: hash(Buffer.from(JSON.stringify(codes))),
    vectors,
    license: "MIT, agentsig-authored expectations and deterministic M2 test material.",
    files,
}, null, 2) + "\n");
console.log(`Pinned ${files.length} signing fixture files and ${vectors.length} independent golden vectors.`);