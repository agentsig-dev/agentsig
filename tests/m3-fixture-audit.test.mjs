import assert from "node:assert/strict";
import { constants, createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// Source audit only: no production code, importer helpers, clock policy, or network.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = resolve(root, "tests/fixtures/m3");
const read = (path) => readFileSync(resolve(directory, path));
const text = (path) => read(path).toString("utf8");
const json = (path) => JSON.parse(text(path));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const manifest = json("manifest.json");
const commit = "c07ecb6f3e82701f297dedb414237cc2e54a0948";
const vectors = json("cloudflare/web_bot_auth_architecture_v2.json");
const signatureBytes = (header, label) => {
    const prefix = `${label}=:`;
    assert(header.startsWith(prefix) && header.endsWith(":"));
    const encoded = header.slice(prefix.length, -1);
    const bytes = Buffer.from(encoded, "base64");
    assert.equal(bytes.toString("base64"), encoded);
    return bytes;
};
const parameters = (input, label) => {
    assert(input.startsWith(`${label}=`));
    return input.slice(label.length + 1);
};
function requestBase(vector) {
    assert.equal(vector.target_url, "https://example.com/path/to/resource");
    const components = ['"@authority": example.com'];
    if (vector.signature_agent !== undefined) {
        assert.equal(vector.signature_agent_key, "agent2");
        assert.equal(vector.signature_agent, 'agent2="https://signature-agent.test"');
        components.push('"signature-agent";key="agent2": "https://signature-agent.test"');
    }
    components.push(`"@signature-params": ${parameters(vector.signature_input, vector.label)}`);
    return Buffer.from(components.join("\n"));
}

test("M3 manifest covers exact files, immutable upstream blobs, and licenses", () => {
    const paths = [];
    function walk(path = "") {
        for (const entry of readdirSync(resolve(directory, path), { withFileTypes: true })) {
            const next = path ? `${path}/${entry.name}` : entry.name;
            if (entry.isDirectory()) walk(next);
            else paths.push(next);
        }
    }
    walk();
    assert.equal(manifest.upstreamCommit, commit);
    assert.equal(manifest.files.length, 14);
    assert.deepEqual(paths.filter((p) => p !== "manifest.json").sort(),
        manifest.files.map((f) => f.path).sort());
    const tree = json("cloudflare/git-tree.json");
    assert.equal(tree.truncated, false);
    assert(!tree.tree.some((entry) => /(^|\/)NOTICE(?:\.[^/]*)?$/i.test(entry.path)));
    assert(!tree.tree.some((entry) => entry.path.startsWith("packages/web-bot-auth/") &&
        /(^|\/)(LICENSE|COPYING)(?:\.[^/]*)?$/i.test(entry.path)));
    for (const file of manifest.files) {
        assert(!file.path.includes("..") && !file.path.startsWith("/"));
        const bytes = read(file.path);
        assert.equal(bytes.length, file.bytes, file.path);
        assert.equal(hash(bytes), file.sha256, file.path);
        if (file.provenance.gitBlob) {
            assert.equal(file.provenance.commit, commit);
            const gitBlob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
            assert.equal(gitBlob, file.provenance.gitBlob);
            assert.equal(tree.tree.find((x) => x.path === file.provenance.upstreamPath)?.sha, gitBlob);
        }
    }
    assert.equal(hash(read("cloudflare/web_bot_auth_architecture_v2.json")),
        "d0c8dbb7631dcc22639d12318af2b1ac0a339e4fa5aa4ef6df67ca45b0094576");
    assert.equal(hash(read("cloudflare/LICENSE.txt")),
        "c442cd87211d2bab6c01bce90efc4e8509db3dc712eebf377e44e47f4e1ffded");
    assert.match(text("cloudflare/LICENSE.txt"), /Copyright 2025 Cloudflare, Inc\./);
    assert.match(text("cloudflare/LICENSE.txt"), /Version 2\.0, January 2004/);
    assert.equal(json("cloudflare/package-source.json").license, "Apache-2.0");
    assert.match(text("sources/cloudflare-docs-LICENSE.txt"), /Attribution 4\.0 International/);
});

test("source excerpts are exact byte slices of existing pinned full documents", () => {
    for (const file of manifest.files.filter((f) => f.provenance.startMarker)) {
        const source = readFileSync(resolve(root, file.provenance.source));
        assert.equal(hash(source), file.provenance.sourceSha256);
        const start = source.indexOf(Buffer.from(file.provenance.startMarker));
        const end = source.indexOf(Buffer.from(file.provenance.endMarker),
            start + Buffer.byteLength(file.provenance.startMarker));
        assert(start >= 0 && end > start);
        assert.deepEqual(read(file.path), source.subarray(start + 1, end));
    }
    assert.match(text("sources/wg-f.3.txt"), /web_bot_auth_architecture_v2\.json/);
    assert.match(text("sources/wg-5.5.txt"), /MUST NOT automatically follow HTTP\n   redirects/);
    assert.match(text("sources/wg-appendix-c.txt"), /conditional requests/);
    assert.match(text("sources/cloudflare-directory.mdx"), /one signature per key/);
});

assert.equal(vectors.length, 4);
for (const [index, vector] of vectors.entries()) {
    test(`F.3 JSON vector ${index}: independent ${vector.key.kty} cryptographic verification`, () => {
        const privateKey = createPrivateKey({ key: vector.key, format: "jwk" });
        const publicKey = createPublicKey(privateKey);
        const material = publicKey.export({ format: "jwk" });
        const rsa = vector.key.kty === "RSA";
        const canonical = rsa
            ? { e: material.e, kty: "RSA", n: material.n }
            : { crv: "Ed25519", kty: "OKP", x: material.x };
        const thumbprint = createHash("sha256").update(JSON.stringify(canonical)).digest("base64url");
        assert(vector.signature_input.includes(`;keyid="${thumbprint}"`));
        assert(vector.signature_input.includes(`;created=${vector.created_ms / 1000}`));
        assert(vector.signature_input.includes(`;expires=${vector.expires_ms / 1000}`));
        assert(vector.signature_input.includes(`;nonce="${vector.nonce}"`));
        const base = requestBase(vector);
        const bytes = signatureBytes(vector.signature, vector.label);
        // RFC 9421 RSA-PSS parameters apply only in this independent source audit.
        const key = rsa ? { key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 64 } : publicKey;
        const algorithm = rsa ? "sha512" : null;
        assert.equal(verify(algorithm, base, key, bytes), true);
        assert.equal(verify(algorithm, Buffer.concat([base, Buffer.from("\n")]), key, bytes), false);
        if (!rsa) assert.deepEqual(sign(null, base, privateKey), bytes);
        assert(vector.expires_ms - vector.created_ms > 300_000);
        assert(!vector.signature_input.includes('"@method"'));
        assert(!vector.signature_input.includes('"@target-uri"'));
    });
}

test("F.3 no-agent examples conflict with WG-00 requirements, not with preserved source bytes", () => {
    assert.deepEqual(vectors.map((v) => v.signature_agent !== undefined), [false, true, false, true]);
    for (const vector of [vectors[1], vectors[3]]) {
        assert.equal(vector.label, "sig2");
        assert.equal(vector.signature_agent_key, "agent2");
        assert.notEqual(vector.label, vector.signature_agent_key);
    }
    const wg = readFileSync(resolve(root, "tests/fixtures/m2/sources/wg-protocol-00.txt"), "utf8");
    assert.match(wg, /A signed request MUST carry the Signature-Agent header/);
    const e21 = readFileSync(resolve(root, "tests/fixtures/m2/published/wg-E.2.1/base.txt"));
    const sig = readFileSync(resolve(root, "tests/fixtures/m2/published/wg-E.2.1/signature.bin"));
    assert.deepEqual(requestBase(vectors[3]), e21);
    assert.deepEqual(signatureBytes(vectors[3].signature, "sig2"), sig);
    const headers = readFileSync(resolve(root, "tests/fixtures/m2/published/wg-E.2.1/signature-headers.txt"), "utf8");
    assert.equal(headers, `Signature-Input: ${vectors[3].signature_input}\nSignature: ${vectors[3].signature}`);
    assert(wg.includes(vectors[1].signature));
});

test("supplementary directory vector verifies and shares E.2.3 body digest, not signature parameters", () => {
    const [vector] = json("cloudflare/web_bot_auth_directory_response_v1.json");
    const body = Buffer.from(vector.response.body);
    const digest = `sha-256=:${createHash("sha256").update(body).digest("base64")}:`;
    assert.equal(digest, vector.response.headers["content-digest"]);
    const input = vector.response.headers["Signature-Input"];
    const expected = [
        '"@authority";req: signature-agent.test',
        `"content-digest": ${digest}`,
        `"@signature-params": ${parameters(input, "binding0")}`,
    ].join("\n");
    assert.equal(vector.signature_base, expected);
    const signature = signatureBytes(vector.response.headers.Signature, "binding0");
    const publicKey = createPublicKey({ key: vector.public_key, format: "jwk" });
    assert.equal(verify(null, Buffer.from(expected), publicKey, signature), true);
    const oldBase = readFileSync(resolve(root, "tests/fixtures/m2/published/wg-E.2.3/base.txt"), "utf8");
    assert.equal(expected.split("\n").slice(0, 2).join("\n"), oldBase.split("\n").slice(0, 2).join("\n"));
    assert.notEqual(expected, oldBase);
    assert(input.includes(';alg="ed25519"'));
    assert(!oldBase.includes(';alg="ed25519"'));
    const oldSignature = readFileSync(resolve(root, "tests/fixtures/m2/published/wg-E.2.3/signature.bin"));
    assert.notDeepEqual(signature, oldSignature);
    assert.equal(verify(null, Buffer.from(oldBase), publicKey, oldSignature), true);
});