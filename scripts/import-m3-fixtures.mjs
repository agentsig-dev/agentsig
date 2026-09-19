import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Offline import only. Never execute upstream code or derive expectations
// from agentsig implementations. Download research inputs separately.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = resolve(root, "tests/fixtures/m3");
const commit = "c07ecb6f3e82701f297dedb414237cc2e54a0948";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const blob = (bytes) => createHash("sha1")
    .update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const files = [];
function checked(path, expected) {
    const bytes = readFileSync(resolve(root, path));
    assert.equal(hash(bytes), expected, path);
    return bytes;
}
function put(path, bytes, provenance) {
    const output = resolve(destination, path);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, bytes);
    files.push({ path, bytes: bytes.length, sha256: hash(bytes), provenance });
}
const upstream = [
    {
        input: "web_bot_auth_architecture_v2.json",
        path: "cloudflare/web_bot_auth_architecture_v2.json",
        upstreamPath: "packages/web-bot-auth/test/test_data/web_bot_auth_architecture_v2.json",
        sha256: "d0c8dbb7631dcc22639d12318af2b1ac0a339e4fa5aa4ef6df67ca45b0094576",
        gitBlob: "fc3960edeb077a843b5ef8bdc6e7bee0004ca219",
        role: "Direct target of WG protocol-00 Appendix F.3",
    },
    {
        input: "web_bot_auth_directory_response_v1.json",
        path: "cloudflare/web_bot_auth_directory_response_v1.json",
        upstreamPath: "packages/web-bot-auth/test/test_data/web_bot_auth_directory_response_v1.json",
        sha256: "ab2226c895940f0d169433ea0485ca7938e2dd2b89090945088b931031a7a1de",
        gitBlob: "b46176e1ed826c22d0cb24fb07794723e4b6dca0",
        role: "Supplementary directory-response vector; not the F.3 link target",
    },
    {
        input: "LICENSE", path: "cloudflare/LICENSE.txt", upstreamPath: "LICENSE",
        sha256: "c442cd87211d2bab6c01bce90efc4e8509db3dc712eebf377e44e47f4e1ffded",
        gitBlob: "d3a3b3e6d3c0187abc5aa49487622593d761293c",
        role: "Unmodified upstream Apache-2.0 license and copyright notice",
    },
    {
        input: "package.json", path: "cloudflare/package-source.json",
        upstreamPath: "packages/web-bot-auth/package.json",
        sha256: "0b3faff49ffa6fa69e2f40b42a16c60a2604ca2b066d7e55756767bb48f4ac60",
        gitBlob: "67ffc3bc1b491cf81faa391032af716ace85c16a",
        role: "Package attribution/license declaration; not installed or executed",
    },
];
const treeBytes = checked(".tmp/m3-research/tree.json",
    "c8df881d55dd9b943eac96a7a14f60b0b546871e4a874e03850c29f4be4f798f");
const tree = JSON.parse(treeBytes);
assert.equal(tree.truncated, false);
put("cloudflare/git-tree.json", treeBytes, {
    url: `https://api.github.com/repos/cloudflare/web-bot-auth/git/trees/${commit}?recursive=1`,
    commit, transformation: "none", role: "Retrieved path/blob and license-location evidence",
});
for (const entry of upstream) {
    const bytes = checked(`.tmp/m3-research/${entry.input}`, entry.sha256);
    assert.equal(blob(bytes), entry.gitBlob);
    assert.equal(tree.tree.find((item) => item.path === entry.upstreamPath)?.sha, entry.gitBlob);
    put(entry.path, bytes, {
        url: `https://raw.githubusercontent.com/cloudflare/web-bot-auth/${commit}/${entry.upstreamPath}`,
        commit, upstreamPath: entry.upstreamPath, gitBlob: entry.gitBlob,
        license: "Apache-2.0", transformation: "none", role: entry.role,
    });
}

const wgPath = "tests/fixtures/m2/sources/wg-protocol-00.txt";
const wgHash = "3021fd94cdffdb2eb030dec68b1a5c968f2348502dd94c481e2085ec7ddd90a0";
const wg = checked(wgPath, wgHash);
const cfPath = "tests/fixtures/m2/sources/cloudflare-2026-07-01.mdx";
const cfHash = "c4aeeef723df97b020ecc4d9e680b77b5bfb6c214a6443b0fb7f00efd7e422f7";
const cf = checked(cfPath, cfHash);
function excerpt(path, source, sourcePath, sourceHash, start, end, license) {
    const from = source.indexOf(Buffer.from(start));
    const to = source.indexOf(Buffer.from(end), from + Buffer.byteLength(start));
    assert(from >= 0 && to > from, path);
    put(path, source.subarray(from + 1, to), {
        source: sourcePath, sourceSha256: sourceHash,
        startMarker: start, endMarker: end,
        transformation: "Exact byte slice after leading LF through before next heading LF; pagination preserved",
        license,
    });
}
for (const [name, start, end] of [
    ["wg-4", "\n4.  Identifiers and Trust Model", "\n5.  Protocol Overview"],
    ["wg-5.4", "\n5.4.  Validating Message Signature", "\n5.5.  Key Distribution"],
    ["wg-5.5", "\n5.5.  Key Distribution", "\n5.6.  Session Considerations"],
    ["wg-6.7-6.10", "\n6.7.  Server-Side Request Forgery", "\n6.11.  Unsigned Requests"],
    ["wg-appendix-b", "\nAppendix B.  Validating", "\nAppendix C.  Deployment"],
    ["wg-appendix-c", "\nAppendix C.  Deployment", "\nAppendix D.  Examples"],
    ["wg-f.3", "\nF.3.  Test Vectors", "\nAcknowledgments"],
]) {
    excerpt(`sources/${name}.txt`, wg, wgPath, wgHash, start, end,
        "IETF Trust Legal Provisions; source notices retained in referenced full document");
}
excerpt("sources/cloudflare-directory.mdx", cf, cfPath, cfHash,
    "\n## 2. Host a key directory", "\n## 3. Register your bot",
    "CC-BY-4.0; Cloudflare and contributors");
const cfLicense = checked("tests/fixtures/m2/sources/cloudflare-LICENSE.txt",
    "9e5f1b3c610b9c2da5c313bf81d577a7d1acec686bdb0384edefa6df0f90cd94");
put("sources/cloudflare-docs-LICENSE.txt", cfLicense, {
    source: "tests/fixtures/m2/sources/cloudflare-LICENSE.txt",
    license: "CC-BY-4.0", transformation: "none",
});
writeFileSync(resolve(destination, "manifest.json"), JSON.stringify({
    formatVersion: 1,
    retrievedOn: "2026-09-19",
    warning: "PUBLIC TEST PRIVATE KEYS. Never use in production. No M3 acceptance policy is approved.",
    sourceBaseline: "WG protocol-00 and pinned Cloudflare documentation reused from M2; no claim these are newer revisions",
    upstreamCommit: commit,
    licenseReview: "Root Apache-2.0 and package declaration agree; full tree contains no NOTICE or closer license for packages/web-bot-auth/test/test_data",
    files: files.sort((a, b) => a.path.localeCompare(b.path, "en")),
}, null, 2) + "\n");
console.log(`M3: ${files.length} source/vector files pinned without production code.`);