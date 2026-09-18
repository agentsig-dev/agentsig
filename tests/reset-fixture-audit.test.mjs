import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// Authored-contract audit only: no production imports or reset simulation.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = resolve(root, "tests/fixtures/reset");
const read = (path) => readFileSync(resolve(directory, path));
const json = (path) => JSON.parse(read(path).toString("utf8"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const manifest = json("manifest.json");
const contract = json("contract.json");
const scenarios = json("cases.json").cases;
const cases = new Map(scenarios.map((entry) => [entry.id, entry]));
const codes = [
    "reset-unsupported-store", "reset-in-progress",
    "reset-clock-unavailable", "reset-failed",
];
const unavailable = { status: "unverified", reason: "clock-unavailable" };

test("reset manifest pins all expectations and their approved source contracts", () => {
    assert.deepEqual(readdirSync(directory).sort(), [
        "cases.json", "contract.json", "manifest.json",
    ]);
    assert.deepEqual(manifest.files.map((entry) => entry.path).sort(), [
        "cases.json", "contract.json",
    ]);
    for (const entry of manifest.files) {
        const bytes = read(entry.path);
        assert.equal(bytes.length, entry.bytes);
        assert.equal(hash(bytes), entry.sha256);
        assert(!bytes.includes(13));
    }
    assert.equal(manifest.sources.length, 2);
    for (const source of manifest.sources) {
        assert.equal(hash(readFileSync(resolve(root, source.path))), source.sha256);
    }
    assert.equal(scenarios.length, 9);
    assert.equal(cases.size, 9);
});

test("operator catalog is frozen and separate from signer and verification types", () => {
    assert.equal(contract.catalogVersion, 1);
    assert.equal(contract.frozen, true);
    assert.deepEqual(contract.codes, codes);
    assert.deepEqual(contract.separateFrom, ["verification-catalog", "signing-catalog"]);
    assert.equal(manifest.catalogSha256, hash(Buffer.from(JSON.stringify(codes))));
    assert.deepEqual(contract.phases, [
        "check-busy-and-store-capability",
        "close-context-for-reset",
        "validate-fresh-wall-and-monotonic-samples",
        "invalidate-old-epoch-then-clear-process-clock-memory",
        "commit-new-references-and-epoch-then-report",
    ]);
    assert.equal(contract.epoch.sentToExternalStore, false);
    assert.equal(contract.epoch.invalidationPrecedesMemoryClear, true);
    assert.equal(contract.epoch.invalidationReversible, false);
    assert.equal(contract.epoch.activateNewEpochOnlyAfterSuccessfulCommit, true);
    assert.equal(contract.failureRecovery.automaticReset, false);
});

test("three store declarations distinguish destructive reset, preservation and rejection", () => {
    assert.deepEqual(Object.keys(contract.storeDeclarations).sort(),
        ["independent", "process-clock", "undeclared"]);
    const memory = cases.get("healthy-memory-reset");
    assert.equal(memory.initial.healthy, true);
    assert.equal(memory.expected.records, 0);
    assert.equal(memory.expected.quotaCounters, 0);
    assert.equal(memory.expected.epoch, memory.initial.epoch + 1);
    assert.equal(memory.expected.verificationOpen, true);
    assert.equal(memory.expected.previouslyConsumedStillValidSignatureMayBeAcceptedAgain, true);
    const independent = cases.get("independent-retention-preserves-history");
    assert.equal(independent.expected.records, independent.initial.records);
    assert.equal(independent.expected.quotaCounters, independent.initial.quotaCounters);
    assert.equal(independent.expected.storeClearCalls, 0);
    assert.equal(independent.expected.oldEpochValid, false);
    const absent = cases.get("undeclared-store-reset-rejected");
    assert.equal(absent.expected.operatorCode, "reset-unsupported-store");
    for (const name of ["reference", "epoch", "records", "quotaCounters"]) {
        assert.deepEqual(absent.expected[name], absent.initial[name], name);
    }
    for (const name of ["clockProviderCalls", "storeClearCalls", "invalidatedOperations"]) {
        assert.equal(absent.expected[name], 0, name);
    }
});

test("concurrent reset and stale operations cannot authorize new work", () => {
    const concurrent = cases.get("concurrent-second-reset").expected;
    assert.equal(concurrent.secondOperatorCode, "reset-in-progress");
    assert.equal(concurrent.secondCallStateChanges, 0);
    assert.deepEqual(concurrent.verificationDuringPause, { ...unavailable, waits: false });
    assert.equal(concurrent.firstResetCanComplete, true);
    const stale = cases.get("old-operation-cannot-dispatch-after-reset").expected;
    assert.equal(stale.oldOperationConsumeCalls, 0);
    assert.deepEqual(stale.oldOperationResult, unavailable);
    const dispatched = cases.get("independent-consume-already-dispatched").expected;
    assert.equal(dispatched.dispatchedConsumeCalls, 1);
    assert.equal(dispatched.additionalOldEpochConsumeCalls, 0);
    assert.equal(dispatched.externalWriteMayComplete, true);
    assert.equal(dispatched.storeClearCalls, 0);
    assert.equal(dispatched.epochIncludedInExternalConsume, false);
    assert.equal(dispatched.existingLiveRetentionMayBeShortened, false);
    assert.deepEqual(dispatched.oldOperationResult, unavailable);
});

test("invalid clock samples preserve references and records without hiding unhealthy samples", () => {
    const entry = cases.get("invalid-sample-preserves-references");
    assert.equal(entry.expected.operatorCode, "reset-clock-unavailable");
    for (const name of ["reference", "epoch", "records", "quotaCounters"]) {
        assert.deepEqual(entry.expected[name], entry.initial[name], name);
    }
    assert.equal(entry.expected.storeClearCalls, 0);
    assert.equal(entry.expected.invalidatedOperations, 0);
    assert.equal(entry.expected.healthFailureVisible, true);
    assert.equal(entry.expected.busy, false);
});

test("failed cleanup never resurrects the old epoch and remains retryable", () => {
    const entry = cases.get("failed-clear-then-successful-retry");
    const failed = entry.expectedAfterFailure;
    assert.equal(failed.operatorCode, "reset-failed");
    assert.equal(failed.activeEpoch, null);
    assert.equal(failed.oldEpochValid, false);
    assert.equal(failed.invalidationOccurredBeforeClear, true);
    assert.equal(failed.busy, false);
    assert.equal(failed.retryAllowed, true);
    assert.deepEqual(failed.verification, unavailable);
    assert.deepEqual(failed.reference, entry.initial.reference);
    assert.equal(failed.records, entry.initial.records - entry.firstClear.removedRecords);
    assert.equal(failed.quotaCounters,
        entry.initial.quotaCounters - entry.firstClear.removedQuotaCounters);
    const recovered = entry.expectedAfterRetry;
    assert.equal(recovered.activeEpochGreaterThan, entry.initial.epoch);
    assert.equal(recovered.oldEpochValid, false);
    assert.equal(recovered.verificationOpen, true);
    assert.equal(recovered.busy, false);
    assert.equal(recovered.records, 0);
    assert.equal(recovered.quotaCounters, 0);
    assert.equal(recovered.resetOutcome, "success");
});

test("reset event fixtures expose only approved metadata and honest cleanup counts", () => {
    const fields = [
        "reason", "oldEpoch", "newEpoch", "clearedRecords", "clearedQuotaCounters",
        "invalidatedOperations", "storeDeclaration", "outcome",
    ];
    assert.deepEqual(contract.events.resetFields, fields);
    assert.deepEqual(contract.events.outcomes, ["success", ...codes]);
    for (const entry of scenarios) {
        const event = entry.expected?.event ?? entry.expectedAfterFailure?.event;
        if (!event) continue;
        assert.deepEqual(Object.keys(event).sort(), [...fields].sort());
        assert(contract.events.reasons.includes(event.reason));
        assert(contract.events.outcomes.includes(event.outcome));
        assert.equal(event.oldEpoch, entry.initial.epoch);
        assert.equal(event.invalidatedOperations, entry.initial.inFlight);
        if (event.outcome === "success") assert(event.newEpoch > event.oldEpoch);
        else assert.equal(event.newEpoch, null);
        if (entry.declaration === "independent") {
            assert.equal(event.clearedRecords, 0);
            assert.equal(event.clearedQuotaCounters, 0);
        }
    }
    assert.deepEqual(cases.get("unhealthy-memory-reset").expected.healthTransitions, ["healthy"]);
    assert(contract.events.partialCounts.includes("unknown cleanup counts must be null"));
});