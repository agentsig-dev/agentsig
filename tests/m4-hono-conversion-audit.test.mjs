import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Data-only audit: no agentsig, framework, or retained upstream-code imports.
const root = new URL("./fixtures/m4-hono-conversion/", import.meta.url);
const read = path => readFileSync(new URL(path, root));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const manifest = JSON.parse(read("manifest.json"));
const fixture = JSON.parse(read("cases.json"));

test("Hono conversion amendment pins its bytes and unchanged fixture baselines", () => {
    assert.equal(hash(read("manifest.json")),
        "984c925f50404dd92c25d8b52ff053bca58379d88183f5adc2be18dafed1e4c7");
    assert.deepEqual(readdirSync(root).sort(), ["cases.json", "manifest.json"]);
    for (const file of manifest.files) {
        const bytes = read(file.path);
        assert.equal(bytes.length, file.bytes);
        assert.equal(hash(bytes), file.sha256);
        assert.equal(bytes.includes(13), false, "Physical JSON line endings must remain LF");
    }
    for (const source of manifest.sources) assert.equal(hash(read(source.path)), source.sha256);
    assert.equal(fixture.contract.mappingCatalogChange, false);
    assert.equal(fixture.contract.repairTarget, false);
    assert.equal(fixture.contract.conversionFailurePublishesContext, false);
    assert.equal(fixture.cases.length, 3);
});

test("expanded IPv6 is valid mapper input but conflicts with the retained Hono host check", () => {
    const entry = fixture.cases[1];
    const authority = entry.wireLatin1.match(/\r\nHost: ([^\r\n]+)\r\n/)[1];
    const canonical = new URL(`http://${authority}/`);
    assert.equal(canonical.origin, entry.allowedOrigins[0]);
    assert.equal(entry.expected.targetUri, `http://${authority}/`);
    assert.notEqual(canonical.hostname, authority.replace(/:\d+$/, "").toLowerCase());
    assert.notEqual(canonical.hostname.length, authority.length);
    const source = read("../m4-sources/hono-node-server-2.1.1/dist/index.mjs").toString("utf8");
    assert(source.includes('const urlObj = new URL(url);'));
    assert(source.includes('urlObj.hostname.length !== host.length'));
    assert(source.includes('host.replace(/:\\d+$/, "")'));
    assert(source.includes('throw new RequestError("Invalid host header")'));
    // This is source/expectation consistency, not execution of Hono conversion.
});

test("conversion outcomes separate mapping, context publication and enforcement", () => {
    const [success, conversionFailure, mappingFailure] = fixture.cases;
    assert.equal(success.mode, "observe");
    assert.equal(success.expected.mapping.status, "mapped");
    assert.equal(success.expected.handlerCalls, 1);
    assert.equal(success.expected.contextPublished, true);
    assert.equal(success.expected.responseStatus, 204);

    assert.equal(conversionFailure.mode, "observe");
    assert.equal(conversionFailure.expected.mapping.status, "mapped");
    assert.equal(conversionFailure.expected.verifierCalls, 1);
    assert.equal(conversionFailure.expected.convertedRequests, 0);
    assert.equal(conversionFailure.expected.handlerCalls, 0);
    assert.equal(conversionFailure.expected.contextPublished, false);
    assert.equal(conversionFailure.expected.responseStatus, 400);
    assert.equal(conversionFailure.expected.responseBody, "");
    assert.deepEqual(conversionFailure.expected.conversionEvents, [{
        type: "framework-conversion-failed",
        adapter: "hono",
        mapping: { status: "mapped" },
    }]);

    assert.equal(mappingFailure.mode, "enforce");
    assert.deepEqual(mappingFailure.expected.mapping, {
        status: "mapping-rejected", code: "origin-disallowed",
    });
    assert.equal(mappingFailure.expected.verifierCalls, 0);
    assert.equal(mappingFailure.expected.conversionAttempts, 0);
    assert.equal(mappingFailure.expected.contextPublished, false);
    assert.equal(mappingFailure.expected.responseStatus, 400);
    assert.deepEqual(mappingFailure.expected.conversionEvents, []);
});

for (const autocrlf of ["false", "true", "input"]) {
    test(`Hono amendment bytes survive ordinary Git staging and checkout: ${autocrlf}`, () => {
        const directory = mkdtempSync(join(tmpdir(), "agentsig-hono-fixture-"));
        const git = (...args) => execFileSync("git", args, {
            cwd: directory, stdio: ["ignore", "pipe", "pipe"],
        });
        try {
            cpSync(new URL("../.gitattributes", import.meta.url), join(directory, ".gitattributes"));
            const relative = "tests/fixtures/m4-hono-conversion";
            cpSync(root, join(directory, relative), { recursive: true });
            git("init", "--quiet");
            git("config", "core.autocrlf", autocrlf);
            git("add", ".");
            for (const name of readdirSync(root)) {
                assert(git("show", `:${relative}/${name}`).equals(read(name)), name);
            }
            rmSync(join(directory, relative), { recursive: true });
            git("checkout-index", "--all", "--force");
            for (const name of readdirSync(root)) {
                assert(readFileSync(join(directory, relative, name)).equals(read(name)), name);
            }
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });
}