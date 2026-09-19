import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Offline registration only; never generate expectations from production code.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = resolve(root, "tests/fixtures/m3-rotation");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const references = [
    ["jwks", "public-material.json"],
    ["metadata", "cases.json"],
    ["m3-contract", "fetch-cache-cases.json"],
];
const sources = references.map(([group, name]) => {
    const manifest = JSON.parse(readFileSync(resolve(root, `tests/fixtures/${group}/manifest.json`)));
    const entry = manifest.files.find((file) => file.path === name);
    assert(entry, `${group}/${name}`);
    const path = `tests/fixtures/${group}/${name}`;
    assert.equal(hash(readFileSync(resolve(root, path))), entry.sha256, path);
    return { path, sha256: entry.sha256 };
});
const path = "cases.json";
const bytes = Buffer.from(readFileSync(resolve(directory, path), "utf8").replace(/\r\n/g, "\n"));
const contract = JSON.parse(bytes);
assert.equal(contract.formatVersion, 1);
assert.equal(contract.status, "approved-pre-implementation-expectations");
assert.deepEqual(contract.sources, sources.map((source) => source.path));
const ids = [...contract.cases, ...contract.membershipCases].map((row) => row.id);
assert.equal(new Set(ids).size, ids.length);
writeFileSync(resolve(directory, path), bytes);
writeFileSync(resolve(directory, "manifest.json"), JSON.stringify({
    formatVersion: 1,
    authoredOn: "2026-09-19",
    scope: "Approved thumbprint membership and sanitized refresh diagnostic expectations",
    implementationStatusAtPinning: "Network verifier and revised final membership are not implemented",
    files: [{
        path, bytes: bytes.length, sha256: hash(bytes), license: "MIT",
        provenance: "Independently authored from explicit maintainer rotation and diagnostic decisions",
    }],
    sources,
}, null, 2) + "\n");
console.log(`M3 rotation: ${ids.length} expectations pinned; referenced source bytes verified.`);