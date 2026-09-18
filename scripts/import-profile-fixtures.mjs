import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = resolve(root, "tests/fixtures/profiles");
const files = [];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function put(path, value, source) {
    const bytes = Buffer.from(value, "utf8");
    const target = resolve(destination, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    files.push({ path, bytes: bytes.length, sha256: hash(bytes), source });
}
function json(path, value) {
    put(path, JSON.stringify(value, null, 2) + "\n", {
        author: "agentsig", license: "MIT", derivation: "Explicit expectations; no production imports",
    });
}
function excerpt(path, expectedHash, start, end, output) {
    const bytes = readFileSync(resolve(root, path));
    assert.equal(hash(bytes), expectedHash);
    const text = bytes.toString("utf8");
    const from = text.indexOf("\n" + start);
    const to = text.indexOf("\n" + end, from + 1);
    assert(from >= 0 && to > from, output);
    put(output, text.slice(from + 1, to), {
        path, sha256: expectedHash, start, endExclusive: end,
        transformation: "Exact excerpt; retain pagination and whitespace",
        license: "Original IETF Trust notices retained in full source",
    });
}
const rfc9421 = "tests/fixtures/sources/rfc9421.txt";
const hash9421 = "612655786bf4293bfc486e4177571467fbb3de6e6f0eea90cb74c346a34fdf3c";
excerpt(rfc9421, hash9421, "2.3.  Signature Parameters\n",
    "2.4.  Signing Request Components", "sources/rfc9421-2.3.txt");
excerpt(rfc9421, hash9421, "2.5.  Creating the Signature Base\n",
    "3.  HTTP Message Signatures", "sources/rfc9421-2.5.txt");
excerpt("tests/fixtures/sources/rfc9651.txt",
    "fe27f2ec8819911afbe4bd11f6fcb947580da4c49e5423a1fff960e252ced26d",
    "4.2.2.  Parsing a Dictionary\n", "4.2.3.  Parsing an Item\n",
    "sources/rfc9651-dictionary.txt");
excerpt("tests/fixtures/sources/rfc9651.txt",
    "fe27f2ec8819911afbe4bd11f6fcb947580da4c49e5423a1fff960e252ced26d",
    "4.2.3.2.  Parsing Parameters\n", "4.2.3.3.  Parsing a Key\n",
    "sources/rfc9651-parameters.txt");

const canonicalOrigin = "https://agent.example";
const accepted = [
    "https://agent.example", "https://agent.example/",
    "HTTPS://AGENT.EXAMPLE", "hTtPs://Agent.Example/",
    "https://agent.example:443", "HTTPS://AGENT.EXAMPLE:443/",
];
const rejected = [
    ["http", "http://agent.example"],
    ["path", "https://agent.example/path"],
    ["double-slash", "https://agent.example//"],
    ["dot-path", "https://agent.example/."],
    ["query", "https://agent.example?x=1"],
    ["empty-query", "https://agent.example?"],
    ["fragment", "https://agent.example#x"],
    ["empty-fragment", "https://agent.example#"],
    ["userinfo", "https://user@agent.example"],
    ["empty-userinfo", "https://@agent.example"],
    ["other-port", "https://agent.example:8443"],
    ["ipv4", "https://192.0.2.1"],
    ["ipv6", "https://[2001:db8::1]"],
    ["ipv4-loopback", "https://127.0.0.1:443/"],
    ["unicode-host", "https://ajän.example"],
    ["empty-host", "https:///"],
    ["relative", "//agent.example"],
    ["leading-space", " https://agent.example"],
    ["trailing-space", "https://agent.example "],
    ["backslash", "https://agent.example\\path"],
];
json("origin-cases.json", {
    stage: "origin-validation-only",
    profiles: ["ietf-wg-protocol-00", "cloudflare-docs-2026-07-01"],
    notes: [
        "Cloudflare origin-only restriction is stricter local M2 policy, not a Cloudflare requirement.",
        "Canonical origin is for identity comparison only; never rewrite signed header bytes.",
        "Normalize scheme/host case, remove explicit :443 and optional single trailing slash.",
        "No non-default port, IP literal, non-ASCII host, userinfo, path, query or fragment.",
        "No IDNA conversion. No DNS lookup. Passing origin validation is not domain ownership proof.",
    ],
    cases: [
        ...accepted.map((value, index) => ({
            id: `equivalent-origin-${index}`, value, canonicalOrigin,
        })),
        ...rejected.map(([id, value]) => ({
            id, value, requestCode: "malformed-agent", configurationCode: "invalid-agent-binding",
        })),
    ],
});

const agent = 'agent="https://agent.example"';
const input = 'agent=("@method" "@target-uri" "signature-agent";key="agent");created=1800000000;expires=1800000060;tag="web-bot-auth"';
const signature = "agent=:AA==:";
const duplicateCases = [
    ["signature-created", "signature-input", input + ";created=1800000001", "created", "malformed-signature"],
    ["signature-tag", "signature-input", input + ';tag="other"', "tag", "malformed-signature"],
    ["signature-tag-identical", "signature-input", input + ';tag="web-bot-auth"', "tag", "malformed-signature"],
    ["signature-extension", "signature-input", input + ";custom=1;custom=2", "custom", "malformed-signature"],
    ["component-key", "signature-input", input.replace(';key="agent"', ';key="other";key="agent"'), "key", "malformed-signature"],
    ["component-identical-key", "signature-input", input.replace(';key="agent"', ';key="agent";key="agent"'), "key", "malformed-signature"],
    ["component-extension", "signature-input", input.replace('"@method"', '"@method";custom=1;custom=2'), "custom", "malformed-signature"],
    ["agent-member", "signature-agent", agent + ', agent="https://other.example"', "agent", "malformed-agent"],
    ["agent-identical-member", "signature-agent", agent + ", " + agent, "agent", "malformed-agent"],
];
json("duplicate-cases.json", {
    stage: "raw-duplicate-screening-only-before-tag-selection",
    notes: [
        "Dummy signature bytes are syntax input, not a cryptographic fixture.",
        "Reject even identical repeated values; diagnostics name the repeated SF key.",
        "RFC 9421 2.5 repeated component identifier rule is distinct from repeated parameter keys.",
        "Parameter rejection is stricter local policy to prevent parser differentials; M1 stays unchanged.",
    ],
    cases: duplicateCases.map(([id, field, value, repeatedName, code]) => ({
        id,
        headers: [
            ["signature-input", field === "signature-input" ? value : input],
            ["signature", signature],
            ["signature-agent", field === "signature-agent" ? value : agent],
        ],
        expected: { status: "invalid", code, repeatedName },
    })),
});

const thumbprint = "DR68nui99ukl-GUgfzQGaU3VwqRtArw-_DCN4LFtY84";
json("binding-cases.json", {
    stage: "local-identity-binding-only",
    notes: [
        "Assume selected key, valid cryptography and otherwise eligible request.",
        "Passing this stage is not a verified request result; time and replay remain separate.",
        "No network proof, automatic URL trust or operator identity inference.",
    ],
    cases: [
        {
            id: "manual-jwks-no-domain-trust", thumbprint, claim: canonicalOrigin,
            requireBinding: false, bindings: [],
            expected: { identityKind: "key-thumbprint", thumbprint },
        },
        ...accepted.map((claim, index) => ({
            id: `canonical-binding-match-${index}`, thumbprint, claim,
            requireBinding: true,
            bindings: [{ thumbprint, origin: "HTTPS://AGENT.EXAMPLE:443/" }],
            expected: {
                identityKind: "directory-url", canonicalOrigin,
                directoryUrl: canonicalOrigin + "/.well-known/http-message-signatures-directory",
                trustSource: "local-configuration",
            },
        })),
        {
            id: "required-binding-missing", thumbprint, claim: canonicalOrigin,
            requireBinding: true, bindings: [],
            expected: { status: "unverified", code: "agent-binding-missing" },
        },
        {
            id: "existing-binding-mismatch", thumbprint, claim: "https://other.example",
            requireBinding: true, bindings: [{ thumbprint, origin: canonicalOrigin }],
            expected: { status: "invalid", code: "agent-binding-mismatch" },
        },
    ],
});
writeFileSync(resolve(destination, "manifest.json"), JSON.stringify({
    formatVersion: 1, approvedOn: "2026-09-18",
    scope: "Pre-implementation origin, duplicate and local-binding expectations",
    relatedNotice: "tests/fixtures/m2/sources/IETF-NOTICE.txt",
    files,
}, null, 2) + "\n");
console.log(`Pinned ${files.length} profile fixture/source files; no agentsig implementation used.`);