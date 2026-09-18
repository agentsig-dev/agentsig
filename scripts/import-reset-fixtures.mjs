import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Authored expectations only. No production imports or reset implementation.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = resolve(root, "tests/fixtures/reset");
const files = [];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function json(path, value) {
    const bytes = Buffer.from(JSON.stringify(value, null, 2) + "\n");
    mkdirSync(destination, { recursive: true });
    writeFileSync(resolve(destination, path), bytes);
    files.push({ path, bytes: bytes.length, sha256: hash(bytes) });
}
const codes = [
    "reset-unsupported-store", "reset-in-progress",
    "reset-clock-unavailable", "reset-failed",
];
json("contract.json", {
    catalogVersion: 1, approvedOn: "2026-09-18", frozen: true,
    codes,
    separateFrom: ["verification-catalog", "signing-catalog"],
    changePolicy: "Separate approval and release notes required.",
    storeDeclarations: {
        "process-clock": "Context-owned memory retention; clear records and quota counters on reset.",
        independent: "External retention clock; never clear records or counters on local reset.",
        undeclared: "Reject reset without changing references, epoch or records.",
    },
    implementedM2Store: "context-owned in-memory only",
    externalStoreScope: "Contract and test doubles only; no Redis or distributed reset adapter.",
    epoch: {
        representation: "monotonically increasing process-local integer",
        sentToExternalStore: false,
        operationCapturesStartingEpoch: true,
        compareBeforeConsumeAndBeforeVerified: true,
        invalidationPrecedesMemoryClear: true,
        invalidationReversible: false,
        activateNewEpochOnlyAfterSuccessfulCommit: true,
    },
    phases: [
        "check-busy-and-store-capability",
        "close-context-for-reset",
        "validate-fresh-wall-and-monotonic-samples",
        "invalidate-old-epoch-then-clear-process-clock-memory",
        "commit-new-references-and-epoch-then-report",
    ],
    verificationDuringReset: { status: "unverified", reason: "clock-unavailable", waits: false },
    failureRecovery: {
        resetFailed: "Closed but retryable; busy flag cleared; old epoch stays invalid.",
        invalidSamples: "References and records preserved; bad samples remain visible to clock health.",
        automaticRetry: false,
        automaticReset: false,
    },
    events: {
        resetFields: [
            "reason", "oldEpoch", "newEpoch", "clearedRecords", "clearedQuotaCounters",
            "invalidatedOperations", "storeDeclaration", "outcome",
        ],
        reasons: ["operator", "health"],
        reasonMeaning: "Health identifies an explicitly requested recovery, not automatic reset.",
        outcomes: ["success", ...codes],
        forbidden: ["key material", "nonce", "request headers", "raw store/provider errors"],
        failedNewEpoch: "No new active epoch; report null.",
        partialCounts: "Report actual known counts; unknown cleanup counts must be null, not invented zero.",
        healthEvents: "Entry/exit transitions only, not repeated same-state samples.",
    },
    independentPendingOperation: [
        "A consume dispatched before reset may complete; no distributed cancellation is claimed.",
        "Local old-epoch work cannot dispatch a new consume or return verified after invalidation.",
        "Completion does not authorize the old verification invocation.",
        "It may retain an unnecessary nonce with an old-clock retention calculation.",
        "This is harmless to replay safety only if consume does not delete or shorten an existing live record.",
        "The same nonce could have been accepted by another invocation; do not claim otherwise.",
    ],
    destructiveReset: "Even when healthy, memory reset can reopen replay acceptance for still-valid signatures.",
});
const reference = { wallMs: 1800000000000, monotonicMs: 1000 };
const replacement = { wallMs: 1800003611000, monotonicMs: 12000 };
const initial = {
    epoch: 7, reference, records: 2, quotaCounters: 1, inFlight: 2,
};
const successEvent = (storeDeclaration, reason = "operator") => ({
    reason, oldEpoch: 7, newEpoch: 8,
    clearedRecords: storeDeclaration === "process-clock" ? 2 : 0,
    clearedQuotaCounters: storeDeclaration === "process-clock" ? 1 : 0,
    invalidatedOperations: 2, storeDeclaration, outcome: "success",
});

json("cases.json", {
    stage: "pre-implementation-security-context-contract",
    notes: [
        "Epoch 7 is an illustrative current epoch, not a required initial epoch.",
        "Memory adapter implementation and full verifier tests must execute these scenarios later.",
        "Here events and state transitions are expectations, not simulated proof of implementation.",
    ],
    cases: [
        {
            id: "healthy-memory-reset", declaration: "process-clock",
            initial: { ...initial, healthy: true }, resetSample: replacement,
            expected: {
                reference: replacement, epoch: 8, records: 0, quotaCounters: 0,
                verificationOpen: true, busy: false, oldEpochValid: false,
                event: successEvent("process-clock"),
                previouslyConsumedStillValidSignatureMayBeAcceptedAgain: true,
            },
        },
        {
            id: "unhealthy-memory-reset", declaration: "process-clock",
            initial: { ...initial, healthy: false }, resetReason: "health", resetSample: replacement,
            expected: {
                reference: replacement, epoch: 8, records: 0, quotaCounters: 0,
                verificationOpen: true, busy: false, oldEpochValid: false,
                event: successEvent("process-clock", "health"),
                healthTransitions: ["healthy"],
            },
        },
        {
            id: "independent-retention-preserves-history", declaration: "independent",
            initial, resetSample: replacement,
            expected: {
                reference: replacement, epoch: 8, records: 2, quotaCounters: 1,
                storeClearCalls: 0, verificationOpen: true, oldEpochValid: false,
                event: successEvent("independent"),
            },
        },
        {
            id: "undeclared-store-reset-rejected", declaration: null, initial,
            expected: {
                operatorCode: "reset-unsupported-store",
                reference, epoch: 7, records: 2, quotaCounters: 1,
                clockProviderCalls: 0, storeClearCalls: 0, invalidatedOperations: 0,
                busy: false,
            },
        },
        {
            id: "concurrent-second-reset", declaration: "process-clock", initial,
            pauseFirstResetAt: "after-close-before-commit",
            expected: {
                secondOperatorCode: "reset-in-progress",
                secondCallStateChanges: 0,
                verificationDuringPause: { status: "unverified", reason: "clock-unavailable", waits: false },
                firstResetCanComplete: true,
            },
        },
        {
            id: "old-operation-cannot-dispatch-after-reset", declaration: "process-clock", initial,
            steps: ["begin-operation-in-epoch-7", "complete-reset-to-epoch-8", "attempt-old-consume"],
            expected: {
                oldOperationConsumeCalls: 0,
                oldOperationResult: { status: "unverified", reason: "clock-unavailable" },
                records: 0, quotaCounters: 0,
            },
        },
        {
            id: "independent-consume-already-dispatched", declaration: "independent", initial,
            steps: ["dispatch-consume-in-epoch-7", "complete-reset-to-epoch-8", "old-consume-resolves-accepted"],
            expected: {
                dispatchedConsumeCalls: 1, additionalOldEpochConsumeCalls: 0,
                oldOperationResult: { status: "unverified", reason: "clock-unavailable" },
                storeClearCalls: 0, externalWriteMayComplete: true,
                epochIncludedInExternalConsume: false,
                existingLiveRetentionMayBeShortened: false,
            },
        },
        {
            id: "invalid-sample-preserves-references", declaration: "process-clock", initial,
            resetSample: { wallMs: { kind: "nan" }, monotonicMs: 12000 },
            expected: {
                operatorCode: "reset-clock-unavailable", reference, epoch: 7,
                records: 2, quotaCounters: 1, storeClearCalls: 0,
                busy: false, healthFailureVisible: true, invalidatedOperations: 0,
            },
        },
        {
            id: "failed-clear-then-successful-retry", declaration: "process-clock", initial,
            resetSample: replacement,
            firstClear: { throws: true, removedRecords: 1, removedQuotaCounters: 0 },
            expectedAfterFailure: {
                operatorCode: "reset-failed", reference,
                activeEpoch: null, oldEpochValid: false, records: 1, quotaCounters: 1,
                busy: false, retryAllowed: true,
                verification: { status: "unverified", reason: "clock-unavailable" },
                invalidationOccurredBeforeClear: true,
                event: {
                    reason: "operator", oldEpoch: 7, newEpoch: null,
                    clearedRecords: 1, clearedQuotaCounters: 0,
                    invalidatedOperations: 2, storeDeclaration: "process-clock", outcome: "reset-failed",
                },
            },
            retry: { resetSample: replacement, clearSucceeds: true },
            expectedAfterRetry: {
                reference: replacement, activeEpochGreaterThan: 7,
                records: 0, quotaCounters: 0, verificationOpen: true, busy: false,
                oldEpochValid: false, resetOutcome: "success",
            },
        },
    ],
});
const sources = [
    "tests/fixtures/m2/boundary-cases.json",
    "tests/fixtures/m2/policy-cases.json",
];
for (const path of sources) assert(readFileSync(resolve(root, path)).length > 0);
writeFileSync(resolve(destination, "manifest.json"), JSON.stringify({
    formatVersion: 1, approvedOn: "2026-09-18",
    catalogSha256: hash(Buffer.from(JSON.stringify(codes))),
    sources: sources.map((path) => ({ path, sha256: hash(readFileSync(resolve(root, path))) })),
    license: "MIT; agentsig-authored expectations based on approved local policy.",
    files,
}, null, 2) + "\n");
console.log(`Pinned ${files.length} reset data files, 4 operator codes and 9 scenarios; no implementation used.`);