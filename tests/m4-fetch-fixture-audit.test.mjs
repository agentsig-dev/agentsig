import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// No agentsig or framework imports. Expected output is never derived from production.
const root = new URL("./fixtures/m4-fetch/", import.meta.url);
const repo = new URL("../", import.meta.url);
const read = path => readFileSync(new URL(path, root));
const json = path => JSON.parse(read(path));
const hash = value => createHash("sha256").update(value).digest("hex");
const manifest = json("manifest.json");
const contract = json("contract.json");
const negative = json("negative-cases.json");
const publicKey = createPublicKey(readFileSync(new URL(manifest.sources[1].path, repo)));

test("fetch inventory pins every byte and unchanged key/source attribution", () => {
    const paths = [];
    function walk(prefix = "") {
        for (const item of readdirSync(new URL(prefix, root), { withFileTypes: true })) {
            const path = prefix + item.name;
            if (item.isDirectory()) walk(path + "/");
            else { assert(item.isFile()); paths.push(path); }
        }
    }
    walk();
    assert.equal(manifest.files.length, 18);
    assert.equal(manifest.vectors.length, 4);
    assert.deepEqual(paths.sort(), ["manifest.json", ...manifest.files.map(f => f.path)].sort());
    for (const file of manifest.files) {
        const bytes = read(file.path);
        assert.equal(bytes.length, file.bytes, file.path);
        assert.equal(hash(bytes), file.sha256, file.path);
    }
    for (const source of manifest.sources) {
        assert.equal(hash(readFileSync(new URL(source.path, repo))), source.sha256, source.path);
    }
});

for (const id of manifest.vectors) {
    test(`independent fetch signature and transport-boundary bytes: ${id}`, () => {
        const vector = json(`${id}/case.json`);
        const headers = new Map(vector.expected.headers);
        const base = read(`${id}/base.txt`);
        const signature = read(`${id}/signature.bin`);
        const wg = vector.profile === "ietf-wg-protocol-00";
        const component = wg ? '"signature-agent";key="sig1"' : '"signature-agent"';
        const params = headers.get("signature-input").slice("sig1=".length);
        const expectedBase = [
            `"@method": ${vector.expected.method}`,
            `"@target-uri": ${vector.expected.url}`,
            `${component}: "https://agent.example"`,
            `"@signature-params": ${params}`,
        ].join("\n");
        assert(base.equals(Buffer.from(expectedBase, "ascii")));
        assert.equal(base.at(-1) === 10, false);
        assert.equal(signature.length, 64);
        assert(verify(null, base, publicKey, signature));
        assert.equal(headers.get("signature"), `sig1=:${signature.toString("base64")}:`);
        assert.equal(headers.get("signature-agent"),
            wg ? 'sig1="https://agent.example"' : '"https://agent.example"');
        assert(read(`${id}/headers.bin`).equals(Buffer.from(
            vector.expected.headers.map(([name, value]) => `${name}: ${value}`).join("\r\n"), "ascii",
        )));
        assert.equal(vector.expected.redirect, "manual");
        assert.equal(vector.expected.signingCalls, 1);
        assert.equal(vector.expected.transportCalls, 1);
        assert.match(params, /;created=1800000000;expires=1800000060;/);
        assert.match(params, /;nonce="fetch-fixed-nonce";/);
        // Platform behavior is compared to the literal expectation, never used to write it.
        const request = new Request(vector.input, { ...vector.init, redirect: "manual" });
        assert.equal(request.url, vector.expected.url);
        assert.equal(request.method, vector.expected.method);
        assert.deepEqual([...request.headers], vector.expected.unsignedHeaders);
    });
}

test("fetch contract distinguishes invocation count, wire retries, body integrity and collisions", () => {
    assert.equal(contract.perInvocation.exactlyOnceNetworkDelivery, false);
    assert.equal(contract.perInvocation.wrapperRetry, false);
    assert.equal(contract.body.default, "reject");
    assert.equal(contract.body.integrity, "unverified");
    assert.equal(contract.errors.frozenCatalogsChanged, false);
    assert.equal(negative.collisions.length, 36);
    for (const name of ["Signature", "Signature-Input", "Signature-Agent"]) {
        for (const spelling of [name, name.toLowerCase(), name.toUpperCase()]) {
            for (const value of ["", "already-present"]) {
                for (const source of ["input-request-overridden", "init"]) {
                    assert.equal(negative.collisions.filter(entry =>
                        entry.name === spelling && entry.value === value &&
                        entry.source === source).length, 1,
                        "Every collision combination must occur exactly once");
                }
            }
        }
    }
    for (const entry of negative.collisions) {
        assert.equal(entry.code, "existing-signature-headers");
        assert.equal(entry.signingCalls, 0);
        assert.equal(entry.transportCalls, 0);
    }
    assert.deepEqual(contract.destination.literalHosts, ["127.0.0.1", "[::1]"]);
    assert.equal(negative.http.filter(item => item.allowedWithTestOption).length, 3);
    for (const entry of negative.http) assert.equal(entry.allowedByDefault, false);
});

for (const autocrlf of ["false", "true", "input"]) {
    test(`fetch golden bytes survive Git staging and checkout: ${autocrlf}`, () => {
        const directory = mkdtempSync(join(tmpdir(), "agentsig-fetch-fixtures-"));
        const git = (...args) => execFileSync("git", args, { cwd: directory, stdio: ["ignore", "pipe", "pipe"] });
        try {
            cpSync(new URL("../.gitattributes", import.meta.url), join(directory, ".gitattributes"));
            const relative = "tests/fixtures/m4-fetch";
            cpSync(root, join(directory, relative), { recursive: true });
            git("init", "--quiet");
            git("config", "core.autocrlf", autocrlf);
            git("add", ".");
            const files = ["manifest.json", ...manifest.files.map(file => file.path)];
            for (const file of files) assert(git("show", `:${relative}/${file}`).equals(read(file)), file);
            rmSync(join(directory, relative), { recursive: true });
            git("checkout-index", "--all", "--force");
            for (const file of files) assert(readFileSync(join(directory, relative, file)).equals(read(file)), file);
        } finally { rmSync(directory, { recursive: true, force: true }); }
    });
}