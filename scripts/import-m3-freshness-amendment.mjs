import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Register independently authored stricter expectations before their fix.
// Never rewrite historical fixture bytes or derive outcomes from production.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = resolve(root, "tests/fixtures/m3-freshness-amendment");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const historicalManifest = JSON.parse(readFileSync(
    resolve(root, "tests/fixtures/m3-freshness/manifest.json"), "utf8",
));
const historicalEntry = historicalManifest.files.find((entry) => entry.path === "cases.json");
assert(historicalEntry);
const historicalPath = "tests/fixtures/m3-freshness/cases.json";
assert.equal(hash(readFileSync(resolve(root, historicalPath))), historicalEntry.sha256);

const path = "cases.json";
const bytes = Buffer.from(readFileSync(resolve(directory, path), "utf8").replace(/\r\n/g, "\n"));
const amendment = JSON.parse(bytes);
assert.equal(amendment.formatVersion, 1);
assert.equal(amendment.status, "pre-implementation-security-amendment");
assert.equal(amendment.historicalFixture, historicalPath);
assert.equal(amendment.historicalBytesMustRemainUnchanged, true);
assert.equal(new Set(amendment.cases.map((row) => row.id)).size, amendment.cases.length);
writeFileSync(resolve(directory, path), bytes);
writeFileSync(resolve(directory, "manifest.json"), JSON.stringify({
    formatVersion: 1,
    authoredOn: "2026-09-19",
    scope: "Malformed Cache-Control persistence correction, independently pinned before the fix",
    files: [{
        path,
        bytes: bytes.length,
        sha256: hash(bytes),
        license: "MIT",
        provenance: "Authored regression expectations under approved fail-closed implementation discretion",
    }],
    sources: [{ path: historicalPath, sha256: historicalEntry.sha256 }],
}, null, 2) + "\n");
console.log("Freshness amendment pinned; historical fixture hash unchanged.");