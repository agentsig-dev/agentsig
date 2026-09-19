import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// Independent fixture audit, not a production cache/parser implementation.
// Arithmetic cases use an authored lifetime table, not production-derived values.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = resolve(root, "tests/fixtures/m3-freshness");
const read = (path) => readFileSync(resolve(directory, path));
const contract = JSON.parse(read("cases.json"));
const manifest = JSON.parse(read("manifest.json"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("freshness manifest covers exact expectation bytes and prior source pins", () => {
    assert.equal(manifest.productionImplementationExists, false);
    assert.deepEqual(readdirSync(directory).sort(), ["cases.json", "manifest.json"]);
    assert.equal(manifest.files.length, 1);
    const file = manifest.files[0];
    assert.equal(file.path, "cases.json");
    const bytes = read(file.path);
    assert.equal(bytes.length, file.bytes);
    assert.equal(hash(bytes), file.sha256);
    assert(!bytes.includes(13));
    assert.deepEqual(contract.sources, manifest.sources.map((source) => source.path));
    for (const source of manifest.sources) {
        assert.equal(hash(readFileSync(resolve(root, source.path))), source.sha256, source.path);
    }
    const ids = [...contract.cases, ...contract.residenceCases].map((row) => row.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(ids.length, 36);
});

const lifetimes = new Map([
    ["missing", 60], ["age", 60], ["delay", 60],
    ["apparent-age-dominates", 60], ["future-date-no-negative-age", 60],
    ["cap-before-subtracting-age", 86400], ["cap-already-aged-out", 86400],
    ["explicit-zero", 0], ["quoted-delta", 60],
    ["shared-shorter", 30], ["shared-cannot-extend-local-choice", 30],
    ["must-revalidate-fresh", 60], ["stale-extension-not-freshness", 0],
    ["expires", 60], ["expired", 0],
    ["fractional-delay", 60], ["unknown-quoted-comma", 60],
]);
for (const [id, lifetimeSeconds] of lifetimes) {
    test(`independent freshness arithmetic: ${id}`, () => {
        const row = contract.cases.find((entry) => entry.id === id);
        assert(row, id);
        const sample = { ...contract.defaults, ...row };
        const fields = new Map(row.headers);
        const date = fields.has("date") ? Date.parse(fields.get("date")) : sample.responseReceivedWallMs;
        assert(Number.isFinite(date));
        const apparentAgeMs = Math.max(0, sample.responseReceivedWallMs - date);
        const responseDelayMs = sample.responseReceivedMonotonicMs - sample.requestStartedMonotonicMs;
        const correctedAgeMs = Number(fields.get("age") ?? 0) * 1000 + responseDelayMs;
        const initialAgeMs = Math.max(apparentAgeMs, correctedAgeMs);
        const boundedLifetimeMs = Math.min(lifetimeSeconds, sample.maximumLifetimeSeconds) * 1000;
        assert.equal(Math.max(0, boundedLifetimeMs - initialAgeMs), row.expectedRemainingMs);
        assert.equal(row.persist, true);
        if (id === "expires" || id === "expired") {
            const difference = Date.parse(fields.get("expires")) - date;
            assert.equal(Math.max(0, difference), lifetimeSeconds * 1000);
        }
    });
}

test("restrictive and ambiguous metadata never falls back to positive freshness", () => {
    const nonReusable = contract.cases.filter((row) => !lifetimes.has(row.id));
    assert.equal(nonReusable.length, 14);
    for (const row of nonReusable) assert.equal(row.expectedRemainingMs, 0, row.id);
    assert.deepEqual(nonReusable.filter((row) => !row.persist).map((row) => row.id),
        ["no-store", "private"]);
    // Date.parse alone is permissive: canonical spelling must also be checked.
    const wrongWeekday = contract.cases.find((row) => row.id === "wrong-weekday").headers[0][1];
    assert.notEqual(new Date(Date.parse(wrongWeekday)).toUTCString(), wrongWeekday);
    const badCalendar = contract.cases.find((row) => row.id === "invalid-calendar").headers[0][1];
    assert.notEqual(new Date(Date.parse(badCalendar)).toUTCString(), badCalendar);
});

for (const row of contract.residenceCases) {
    test(`exclusive monotonic residence boundary: ${row.id}`, () => {
        assert.equal(row.elapsedMs >= 0 && row.elapsedMs < row.remainingAtReceiptMs, row.fresh);
        if (row.id === "reset-does-not-renew") {
            assert.equal(row.elapsedBeforeResetMs + row.elapsedAfterResetMs, row.elapsedMs);
        }
    });
}