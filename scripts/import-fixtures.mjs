import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const upstream = resolve(root, ".tmp/structured-field-tests");
const commit = "00462dd7938b43bf596cb2af6a373d9c928a6cbe";
const sfRoot = "packages/structured-fields/test/fixtures/httpwg";
const rfcRoot = "packages/core/test/fixtures/rfc9421";
const sources = [
    {
        number: 9421,
        sha256: "612655786bf4293bfc486e4177571467fbb3de6e6f0eea90cb74c346a34fdf3c",
    },
    {
        number: 9651,
        sha256: "fe27f2ec8819911afbe4bd11f6fcb947580da4c49e5423a1fff960e252ced26d",
    },
];
const files = [];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Always write bytes directly: editor defaults must not change fixture EOLs.
function put(path, value, source) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
    const destination = resolve(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, bytes);
    files.push({ path, bytes: bytes.length, sha256: hash(bytes), source });
}

function git(...args) {
    return execFileSync("git", ["-C", upstream, ...args], {
        maxBuffer: 32 * 1024 * 1024,
    });
}

assert.equal(git("rev-parse", "HEAD").toString("utf8").trim(), commit);
const paths = git("ls-tree", "-r", "--name-only", commit)
    .toString("utf8")
    .trim()
    .split("\n")
    .filter((path) =>
        path.endsWith(".json") || path === "README.md" || path === "LICENSE.md",
    );
assert(paths.includes("date.json"));
assert(paths.includes("display-string.json"));
assert(paths.includes("LICENSE.md"));
assert(paths.some((path) => path.startsWith("serialisation-tests/")));
for (const path of paths) {
    // Read Git blobs, not the potentially CRLF-converted upstream worktree.
    put(`${sfRoot}/${path}`, git("show", `${commit}:${path}`), {
        repository: "https://github.com/httpwg/structured-field-tests",
        commit,
        path,
    });
}

let rfc;
for (const source of sources) {
    const bytes = readFileSync(resolve(root, `.tmp/rfc/rfc${source.number}.txt`));
    assert.equal(hash(bytes), source.sha256, `RFC ${source.number} source changed`);
    put(`tests/fixtures/sources/rfc${source.number}.txt`, bytes, {
        url: `https://www.rfc-editor.org/rfc/rfc${source.number}.txt`,
        sha256: source.sha256,
    });
    if (source.number === 9421) rfc = bytes.toString("utf8");
}
assert(rfc);

function section(start, end) {
    const from = rfc.lastIndexOf(start);
    assert(from >= 0, `Missing section: ${start}`);
    const to = rfc.indexOf(end, from + start.length);
    assert(to > from, `Missing section end: ${end}`);
    return rfc.slice(from, to);
}

const keySection = section(
    "B.1.4.  Example Ed25519 Test Key",
    "B.1.5.",
);
const vector = section(
    "B.2.6.  Signing a Request Using ed25519",
    "B.3.",
);
const requests = section("B.2.  Test Cases", "B.2.1.");
const provenance = (sectionName, transformation) => ({
    rfc: 9421,
    section: sectionName,
    url: `https://www.rfc-editor.org/rfc/rfc9421.html#appendix-${sectionName}`,
    transformation,
});

for (const kind of ["PUBLIC", "PRIVATE"]) {
    const match = keySection.match(
        new RegExp(`   -----BEGIN ${kind} KEY-----[\\s\\S]*?   -----END ${kind} KEY-----`),
    );
    assert(match, `Missing ${kind} PEM`);
    const pem = match[0].replace(/^   /gm, "") + "\n";
    put(
        `${rfcRoot}/ed25519-${kind.toLowerCase()}.pem`,
        pem,
        provenance("B.1.4", "Remove publication indentation; append PEM final LF"),
    );
}
const jwkMatch = keySection.match(/^   \{[\s\S]*?^   \}/m);
assert(jwkMatch);
const jwk = jwkMatch[0].replace(/^   /gm, "") + "\n";
assert.equal(JSON.parse(jwk).kid, "test-key-ed25519");
put(
    `${rfcRoot}/ed25519-private.jwk.json`,
    jwk,
    provenance("B.1.4", "Remove publication indentation; append final LF"),
);

// RFC 8792 backslash wrapping is presentation, not part of the signed data.
// Keep a space preceding a wrapping backslash: it may separate components.
function unfold(block) {
    return block.replace(/^   /gm, "").replace(/\\\n[ \t]*/g, "");
}
function blockAt(text, marker) {
    const start = text.indexOf(marker);
    assert(start >= 0, `Missing block: ${marker}`);
    const end = text.indexOf("\n\n", start);
    assert(end > start);
    return text.slice(start, end);
}

const base = unfold(blockAt(vector, '   "date":'));
assert(!base.includes("\r"));
assert(!base.endsWith("\n"));
put(
    `${rfcRoot}/signature-base.txt`,
    base,
    provenance("B.2.6", "Remove publication indentation and RFC 8792 wrapping; no final LF"),
);
const headers = unfold(blockAt(vector, "   Signature-Input:"));
put(
    `${rfcRoot}/signature-headers.txt`,
    headers,
    provenance("B.2.6", "Remove publication indentation and RFC 8792 wrapping; no final LF"),
);
const signatureMatch = headers.match(/\nSignature: sig-b26=:([A-Za-z0-9+/=]+):$/);
assert(signatureMatch);
const signature = Buffer.from(signatureMatch[1], "base64");
assert.equal(signature.length, 64);
assert.equal(signature.toString("base64"), signatureMatch[1]);
put(
    `${rfcRoot}/signature.bin`,
    signature,
    provenance("B.2.6", "Decode the published Signature byte sequence; do not regenerate"),
);

const requestHeaders = unfold(blockAt(requests, "   POST /foo?"));
put(
    `${rfcRoot}/request-head.txt`,
    requestHeaders,
    provenance("B.2", "LF textual request-head representation; not HTTP wire CRLF; body excluded"),
);

const manifest = {
    formatVersion: 1,
    retrievedOn: "2026-09-18",
    warning: "Published test private key: NEVER use in production.",
    upstream: {
        repository: "https://github.com/httpwg/structured-field-tests",
        commit,
        licensePath: `${sfRoot}/LICENSE.md`,
    },
    rfcSources: sources,
    files: files.sort((a, b) => a.path.localeCompare(b.path, "en")),
};
const manifestPath = resolve(root, "tests/fixtures/manifest.json");
mkdirSync(dirname(manifestPath), { recursive: true });
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
console.log(`Imported ${files.length} source/fixture files; no library implementation used.`);
console.log(`Signature base: ${Buffer.byteLength(base)} bytes; signature: ${signature.length} bytes.`);