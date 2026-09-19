import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// Contract/integrity audit only: no production parser or importer helpers.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = resolve(root, "tests/fixtures/m3-freshness-amendment");
const read = (path) => readFileSync(resolve(directory, path));
const amendment = JSON.parse(read("cases.json"));
const manifest = JSON.parse(read("manifest.json"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const historical = JSON.parse(readFileSync(resolve(root, amendment.historicalFixture)));

test("amendment pins exact bytes and preserves the historical fixture", () => {
    assert.deepEqual(readdirSync(directory).sort(), ["cases.json", "manifest.json"]);
    assert.equal(manifest.files.length, 1);
    const file = manifest.files[0];
    assert.equal(file.path, "cases.json");
    const bytes = read(file.path);
    assert.equal(bytes.length, file.bytes);
    assert.equal(hash(bytes), file.sha256);
    assert(!bytes.includes(13));
    assert.equal(manifest.sources.length, 1);
    assert.equal(manifest.sources[0].path, amendment.historicalFixture);
    const previousManifest = JSON.parse(readFileSync(
        resolve(root, "tests/fixtures/m3-freshness/manifest.json"),
    ));
    const previousPin = previousManifest.files.find((entry) => entry.path === "cases.json");
    assert(previousPin);
    assert.equal(manifest.sources[0].sha256, previousPin.sha256);
    assert.equal(hash(readFileSync(resolve(root, amendment.historicalFixture))), previousPin.sha256);
    assert.equal(amendment.historicalBytesMustRemainUnchanged, true);
});

test("supersession is explicit and narrows persistence without extending freshness", () => {
    assert.equal(amendment.supersedes.length, 1);
    const change = amendment.supersedes[0];
    const original = historical.cases.find((row) => row.id === change.id);
    const replacement = amendment.cases.find((row) => row.id === change.id);
    assert(original && replacement);
    assert.equal(change.field, "persist");
    assert.equal(original.persist, change.previousExpected);
    assert.equal(change.previousExpected, true);
    assert.equal(replacement.persist, change.replacementExpected);
    assert.equal(change.replacementExpected, false);
    assert.deepEqual(replacement.headers, original.headers);
    assert.equal(replacement.expectedRemainingMs, original.expectedRemainingMs);
    assert.equal(replacement.expectedRemainingMs, change.remainingAtReceiptMsUnchanged);
    assert.equal(change.remainingAtReceiptMsUnchanged, 0);
});

test("all amendment scenarios prohibit persistence and reuse", () => {
    assert.equal(amendment.cases.length, 4);
    assert.equal(new Set(amendment.cases.map((row) => row.id)).size, 4);
    for (const row of amendment.cases) {
        assert.equal(row.persist, false, row.id);
        assert.equal(row.expectedRemainingMs, 0, row.id);
        assert.equal(row.headers.length, 1);
        assert.equal(row.headers[0][0], "cache-control");
        // These authored inputs exhibit an unmatched quote or invalid assignment.
        const value = row.headers[0][1];
        assert(value.split('"').length % 2 === 0 || value.includes("invalid==value"), row.id);
    }
    assert.match(amendment.replacementRule, /invalidates older cached evidence/);
    assert.match(amendment.authenticationEffect, /No additional verified outcome/);
});