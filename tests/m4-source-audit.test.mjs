import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Data-only audit: never import or execute retained upstream JavaScript.
// Integrity is not an independent security review or framework compatibility test.
const root = new URL("./fixtures/m4-sources/", import.meta.url);
const read = path => readFileSync(new URL(path, root));
const text = path => read(path).toString("utf8");
const json = path => JSON.parse(text(path));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const manifest = json("manifest.json");
const packages = [
    ["express-4.22.3", "express", "4.22.3", "899b52494e74327905c16164decdc6e51f803af8"],
    ["express-5.2.1", "express", "5.2.1", "dbac741a49a5a64336b70c06e85c2e2706e36336"],
    ["router-2.2.0", "router", "2.2.0", "e6d6b609fc355e558174ccd5b1db646f739fe88c"],
    ["fastify-5.12.5", "fastify", "5.12.5", "ba235fdcd9a83a4c7ccf793f7b2596a8f65389b6"],
    ["hono-4.13.8", "hono", "4.13.8", "098e11912ab244c5c33931de007f04dc8e3c2929"],
    ["hono-node-server-2.1.1", "@hono/node-server", "2.1.1", "73c03adfb01928fcd5f5b20faebd5d692f83fc93"],
    ["undici-6.28.0", "undici", "6.28.0", "01a912e49a50c48009ed2639d2a457a6ec26752a"],
];
const nodes = [
    ["v20.20.2", "3626fea570e44896ad99aaf3bf6e59def5adede5", "6.24.1"],
    ["v22.23.2", "aa4c77582be995286fc6e00aaf530dc7ade102a9", "6.28.0"],
    ["v24.21.0", "955266bfdd854cd280dffd47548673914484e4c0", "7.29.1"],
];

function assertReference(path, repository, tag, commit) {
    const evidence = json(path);
    assert(evidence.length > 0);
    assert.equal(evidence[0].ref, `refs/tags/${tag}`);
    assert.equal(evidence[0].url,
        `https://api.github.com/repos/${repository}/git/refs/tags/${tag}`);
    for (let index = 1; index < evidence.length; index++) {
        assert.equal(evidence[index - 1].object.type, "tag");
        assert.equal(evidence[index - 1].object.sha, evidence[index].sha);
        assert.equal(evidence[index - 1].object.url, evidence[index].url);
    }
    assert.equal(evidence.at(-1).object.type, "commit");
    assert.equal(evidence.at(-1).object.sha, commit);
    // API evidence and registry assertions are not local PGP/Sigstore verification.
}

test("M4 source manifest pins all retained bytes without executing upstream code", () => {
    assert.equal(hash(read("manifest.json")),
        "2fac07286e965caceaf09f6d34fee5c5acabd51c696bfc94cc3449e14396cc71");
    assert.equal(manifest.formatVersion, 1);
    assert.equal(manifest.files.length, 85);
    assert.equal(new Set(manifest.files.map(file => file.path)).size, manifest.files.length);
    const paths = [];
    function walk(prefix = "") {
        for (const item of readdirSync(new URL(prefix, root), { withFileTypes: true })) {
            const path = prefix + item.name;
            if (item.isDirectory()) walk(path + "/");
            else {
                assert(item.isFile(), path);
                paths.push(path);
            }
        }
    }
    walk();
    assert.deepEqual(paths.filter(path => path !== "manifest.json").sort(),
        manifest.files.map(file => file.path).sort());
    for (const file of manifest.files) {
        assert(!file.path.startsWith("/") && !file.path.split("/").includes(".."));
        const bytes = read(file.path);
        assert.equal(bytes.length, file.bytes, file.path);
        assert.equal(hash(bytes), file.sha256, file.path);
    }
});

for (const [id, name, version, commit] of packages) {
    test(`archive identity, selected members and license: ${id}`, () => {
        const registry = json(`${id}/registry-metadata.json`);
        const descriptor = json(`${id}/package.json`);
        assert.equal(registry.name, name);
        assert.equal(registry.version, version);
        assert.equal(descriptor.name, name);
        assert.equal(descriptor.version, version);
        assert.equal(descriptor.license, "MIT");
        assert.equal(registry.license, "MIT");
        const repository = registry.repository.url
            .replace("git+https://github.com/", "").replace(/\.git$/, "");
        assertReference(`${id}/git-ref-evidence.json`, repository, `v${version}`, commit);
        if (id !== "hono-node-server-2.1.1") assert.equal(registry.gitHead, commit);
        assert.match(registry.dist.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/);
        assert.match(text(`${id}/LICENSE`), /Permission is hereby granted/);
        const members = text(`${id}/archive-members.txt`).split(/\r?\n/).filter(Boolean);
        assert.equal(new Set(members).size, members.length);
        for (const file of manifest.files.filter(file =>
            file.path.startsWith(`${id}/`) && file.provenance.kind === "npm-archive-member")) {
            assert.equal(file.provenance.package, name);
            assert.equal(file.provenance.version, version);
            assert.equal(file.provenance.commit, commit);
            assert.equal(file.provenance.license, "MIT");
            assert.equal(file.provenance.member, `package/${file.path.slice(id.length + 1)}`);
            assert.equal(file.provenance.archiveIntegrity, registry.dist.integrity);
            assert.equal(file.provenance.url, registry.dist.tarball);
            assert.equal(file.provenance.transformation, "none");
            assert(members.includes(file.provenance.member));
        }
        const notices = members.filter(path => /(^|\/)(LICENSE|NOTICE|COPYING)(\.[^/]*)?$/i.test(path));
        for (const notice of notices) {
            assert(manifest.files.some(file =>
                file.path === `${id}/${notice.slice("package/".length)}`), notice);
        }
    });
}

for (const [version, commit, undici] of nodes) {
    test(`immutable Node source and bundled Fetch evidence: ${version}`, () => {
        const prefix = `node-${version}/`;
        assertReference(`${prefix}git-ref-evidence.json`, "nodejs/node", version, commit);
        for (const file of manifest.files.filter(file =>
            file.path.startsWith(prefix) && file.provenance.kind === "immutable-git-source")) {
            assert.equal(file.provenance.commit, commit);
            assert.equal(file.provenance.url,
                `https://raw.githubusercontent.com/nodejs/node/${commit}/${file.path.slice(prefix.length)}`);
            assert.equal(file.provenance.transformation, "none");
        }
        assert.equal(json(`${prefix}deps/undici/src/package.json`).version, undici);
        assert.match(text(`${prefix}deps/undici/src/lib/web/fetch/LICENSE`), /Ethan Arrowood/);
        assert.match(text(`${prefix}lib/_http_common.js`), /parser\.maxHeaderPairs/);
        assert.match(text(`${prefix}lib/_http_server.js`), /server\.maxHeadersCount << 1/);
        const fetch = text(`${prefix}deps/undici/src/lib/web/fetch/index.js`);
        assert.match(fetch, /request\.redirect === 'manual'/);
        assert.match(fetch, /response\.status === 421/);
        assert.match(fetch, /response = await httpNetworkOrCacheFetch/);
    });
}

test("Hono Node publication payload binds the archive digest to the retained commit", () => {
    const id = "hono-node-server-2.1.1";
    const registry = json(`${id}/registry-metadata.json`);
    const statements = json(`${id}/registry-attestations.json`).attestations.map(entry =>
        JSON.parse(Buffer.from(entry.bundle.dsseEnvelope.payload, "base64").toString("utf8")));
    const provenance = statements.filter(entry => entry.predicateType === "https://slsa.dev/provenance/v1");
    assert.equal(provenance.length, 1);
    assert.deepEqual(provenance[0].subject, [{
        name: "pkg:npm/%40hono/node-server@2.1.1",
        digest: { sha512: Buffer.from(registry.dist.integrity.slice(7), "base64").toString("hex") },
    }]);
    const definition = provenance[0].predicate.buildDefinition;
    assert.equal(definition.externalParameters.workflow.repository, "https://github.com/honojs/node-server");
    assert.equal(definition.externalParameters.workflow.ref, "refs/tags/v2.1.1");
    assert.deepEqual(definition.resolvedDependencies, [{
        uri: "git+https://github.com/honojs/node-server@refs/tags/v2.1.1",
        digest: { gitCommit: "73c03adfb01928fcd5f5b20faebd5d692f83fc93" },
    }]);
    // Decoding this payload does not validate its signature, certificate, or transparency log.
});

test("framework sources retain the early-capture and normalization evidence", () => {
    for (const path of ["express-4.22.3/lib/router/index.js", "router-2.2.0/index.js"]) {
        assert.match(text(path), /req\.originalUrl = req\.originalUrl \|\| req\.url/);
    }
    const fastify = text("fastify-5.12.5/fastify.js");
    const rewrite = fastify.indexOf("const url = rewriteUrl.call(fastify, req)");
    assert(rewrite > 0);
    assert(fastify.indexOf("router.routing(req, res", rewrite) > rewrite);
    assert.match(text("fastify-5.12.5/lib/server.js"), /options\.serverFactory\(httpHandler, options\)/);
    const hono = text("hono-node-server-2.1.1/dist/index.mjs");
    assert.match(hono, /headers\.append\(name, rawHeaders\[i \+ 1\]\)/);
    assert.match(hono, /return new URL\(url\)\.href/);
    assert.match(hono, /options\.overrideGlobalObjects !== false/);
    assert.match(hono, /res = fetchCallback\(req, \{\s+incoming,\s+outgoing/);
});

test("Forwarded source and retained notices distinguish grammar from trust", () => {
    const rfc = text("rfc7239.txt");
    assert.match(rfc, /Each parameter MUST NOT occur more than once per field-value/);
    assert.match(rfc, /value\s+= token \/ quoted-string/);
    assert.match(rfc, /parameter names are case-insensitive/);
    assert.match(rfc, /unless the communication between proxies/);
    assert.match(rfc, /Copyright \(c\) 2014 IETF Trust/);
    assert.match(text("undici-6.28.0/lib/web/fetch/LICENSE"), /Ethan Arrowood/);
});

for (const autocrlf of ["false", "true", "input"]) {
    test(`M4 source bytes survive ordinary Git add and checkout (autocrlf=${autocrlf})`, () => {
        const directory = mkdtempSync(join(tmpdir(), "agentsig-m4-sources-"));
        const git = (...args) => execFileSync("git", args, {
            cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
        });
        try {
            cpSync(new URL("../.gitattributes", import.meta.url), join(directory, ".gitattributes"));
            cpSync(new URL("../.gitignore", import.meta.url), join(directory, ".gitignore"));
            const relative = "tests/fixtures/m4-sources";
            cpSync(root, join(directory, relative), { recursive: true });
            git("init", "--quiet");
            git("config", "core.autocrlf", autocrlf);
            git("config", "core.safecrlf", "false");
            git("add", ".", "--"); // No force: ignored distribution files must fail this audit.
            const indexed = git("ls-files", "--stage", "--", relative).trim().split("\n");
            const blobs = new Map(indexed.map(line => {
                const [metadata, path] = line.split("\t");
                return [path, metadata.split(" ")[1]];
            }));
            const files = ["manifest.json", ...manifest.files.map(file => file.path)];
            assert.equal(blobs.size, files.length);
            for (const file of files) {
                const bytes = read(file);
                const blob = createHash("sha1")
                    .update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
                assert.equal(blobs.get(`${relative}/${file}`), blob, file);
            }
            rmSync(join(directory, relative), { recursive: true });
            git("checkout-index", "--all", "--force");
            for (const file of files) {
                assert.deepEqual(readFileSync(join(directory, relative, file)), read(file), file);
            }
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });
}