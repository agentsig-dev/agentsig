import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Offline registration of authored expectations, never production-derived output.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = resolve(root, "tests/fixtures/m3-freshness");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const references = [
    ["m3-contract", "fetch-cache-cases.json"],
    ["m3", "sources/wg-appendix-c.txt"],
];
const sources = references.map(([group, name]) => {
    const manifest = JSON.parse(readFileSync(resolve(root, `tests/fixtures/${group}/manifest.json`)));
    const entry = manifest.files.find((file) => file.path === name);
    assert(entry, name);
    const path = `tests/fixtures/${group}/${name}`;
    assert.equal(hash(readFileSync(resolve(root, path))), entry.sha256, path);
    return { path, sha256: entry.sha256 };
});
const path = "cases.json";
const bytes = Buffer.from(readFileSync(resolve(directory, path), "utf8").replace(/\r\n/g, "\n"));
const contract = JSON.parse(bytes);
assert.equal(contract.formatVersion, 1);
assert.equal(contract.status, "pre-implementation-expectations");
assert.deepEqual(contract.sources, sources.map((source) => source.path));
const ids = [...contract.cases, ...contract.residenceCases].map((row) => row.id);
assert.equal(new Set(ids).size, ids.length);
// Normalize only newly authored fixture text, never referenced source bytes.
writeFileSync(resolve(directory, path), bytes);
writeFileSync(resolve(directory, "manifest.json"), JSON.stringify({
    formatVersion: 1,
    authoredOn: "2026-09-19",
    productionImplementationExists: false,
    scope: "Reusable freshness boundaries; no cache or authentication implementation",
    files: [{
        path,
        bytes: bytes.length,
        sha256: hash(bytes),
        provenance: "Independently authored under approved fail-closed implementation discretion",
        license: "MIT",
    }],
    sources,
}, null, 2) + "\n");
console.log(`M3 freshness: ${ids.length} expectations pinned; referenced source bytes verified.`);