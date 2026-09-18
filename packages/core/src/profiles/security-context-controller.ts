import { performance } from "node:perf_hooks";
import { CandidateRejection, ProfileConfigurationError, RESULT_CODES } from "./codes.js";
import type { StoreOutcome } from "./codes.js";
import { createClockTracker } from "./clock-tracker.js";
import type { ClockObservation, ClockTracker } from "./clock-tracker.js";
import { createObserverDelivery } from "./context-observer.js";
import type { ContextObserver } from "./context-observer.js";
import type {
    ClockHealthEvent, ClockResetEvent, MemoryCleanupReport,
    ResetReason, SecurityContextEvent,
} from "./context-events.js";
import { resolveClockPolicy } from "./defaults.js";
import type { ClockPolicy } from "./defaults.js";
import { createOperationEpochs } from "./operation-epochs.js";
import type { OperationLease } from "./operation-epochs.js";
import { OperatorError } from "./operator-errors.js";
import type { OperatorErrorCode } from "./operator-errors.js";
import type { ContextMemoryResetPort, ReplayConsumeInput, ReplayStore } from "./replay-store.js";
import { memoryCleanupFailureReport } from "./memory-cleanup-failure.js";

export interface SecurityControllerOptions {
    readonly store: ReplayStore;
    /** Internal capability supplied only for this context's owned memory. */
    readonly memoryReset?: ContextMemoryResetPort;
    readonly wallClock?: () => number;
    readonly monotonicClock?: () => number;
    readonly clockPolicy?: Partial<ClockPolicy>;
    readonly observer?: ContextObserver<SecurityContextEvent>;
}

export interface SecurityContextController {
    readonly activeEpoch: number | null;
    readonly reference: ClockTracker["reference"];
    readonly resetInProgress: boolean;
    readonly inFlight: number;
    readonly observerErrorCount: number;
    beginOperation(): OperationLease;
    now(lease: OperationLease): number;
    consume(
        lease: OperationLease,
        input: Omit<ReplayConsumeInput, "nowEpochSeconds">,
    ): Promise<StoreOutcome>;
    /** Final synchronous epoch/health check; caller performs its time recheck. */
    completeOperation(lease: OperationLease): number;
    finishOperation(lease: OperationLease): void;
    resetClockReference(reason?: ResetReason): Promise<ClockResetEvent>;
}

function unavailable(): never {
    throw new CandidateRejection({ status: "unverified", reason: "clock-unavailable" });
}

function validCount(value: unknown): value is number | null {
    return value === null ||
        (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

/**
 * INTERNAL coordinator. The eventual public context factory creates its memory
 * store and this controller together; verifiers receive no independent reset
 * port or tracker. External adapters receive consume input, never epoch IDs.
 *
 * Providers/stores are trusted application code, not a sandbox. Synchronous
 * reentry from them is rejected as well, preventing reset between the last
 * epoch check and store dispatch. Observer isolation is strictly stack-local.
 */
export function createSecurityContextController(
    options: SecurityControllerOptions,
): SecurityContextController {
    const policy = resolveClockPolicy(options.clockPolicy);
    const wall = options.wallClock ?? (() => Date.now());
    const monotonic = options.monotonicClock ?? (() => performance.now());
    if (typeof wall !== "function" || typeof monotonic !== "function") {
        throw new ProfileConfigurationError("invalid-clock-configuration");
    }
    const store = options.store;
    if (!store || typeof store.consume !== "function") {
        throw new ProfileConfigurationError("invalid-replay-policy");
    }
    const declaration = store.retentionClock;
    if (declaration !== undefined && declaration !== "process-clock" && declaration !== "independent") {
        throw new ProfileConfigurationError("invalid-replay-policy");
    }
    const consumeStore = store.consume.bind(store);
    const clearMemory = options.memoryReset?.clearForClockReset.bind(options.memoryReset);
    if (options.memoryReset !== undefined &&
        (declaration !== "process-clock" || typeof clearMemory !== "function")) {
        throw new ProfileConfigurationError("invalid-replay-policy");
    }
    const delivery = createObserverDelivery(options.observer);
    const epochs = createOperationEpochs();
    let busy = false;
    let providerDepth = 0;
    let healthy = true;

    function samples(): { wallMs: unknown; monotonicMs: unknown } {
        let wallMs: unknown;
        let monotonicMs: unknown;
        providerDepth++;
        try {
            // Read both independently: a failing wall provider must not hide
            // monotonic regression. Never retain a thrown provider value.
            try { wallMs = wall(); } catch { wallMs = undefined; }
            try { monotonicMs = monotonic(); } catch { monotonicMs = undefined; }
        } finally {
            providerDepth--;
        }
        return { wallMs, monotonicMs };
    }

    const first = samples();
    let tracker = createClockTracker(first.wallMs as number, first.monotonicMs as number, policy);

    function healthChange(observation: ClockObservation): ClockHealthEvent | undefined {
        if (healthy === observation.healthy) return undefined;
        healthy = observation.healthy;
        return Object.freeze(observation.healthy
            ? { type: "clock-health", healthy: true, epoch: epochs.activeEpoch }
            : {
                type: "clock-health", healthy: false, epoch: epochs.activeEpoch,
                reason: observation.reason,
            });
    }

    function requireOpen(): void {
        if (busy || delivery.delivering || providerDepth > 0 || epochs.activeEpoch === null) {
            unavailable();
        }
    }

    function currentTime(lease?: OperationLease): number {
        requireOpen();
        if (lease !== undefined) epochs.assertCurrent(lease);
        const sample = samples();
        const observation = tracker.observe(sample.wallMs, sample.monotonicMs);
        const event = healthChange(observation);
        if (event) delivery.emit(event);
        // Callback invocation has completed and cannot change context state
        // synchronously through the guarded entry points.
        requireOpen();
        if (lease !== undefined) epochs.assertCurrent(lease);
        if (!observation.healthy) return unavailable();
        return observation.epochSeconds;
    }

    function resetEvent(
        reason: ResetReason,
        oldEpoch: number,
        outcome: ClockResetEvent["outcome"],
        counts: MemoryCleanupReport = { clearedRecords: 0, clearedQuotaCounters: 0 },
        invalidatedOperations = 0,
    ): ClockResetEvent {
        return Object.freeze({
            type: "reset", reason, oldEpoch,
            newEpoch: outcome === "success" ? epochs.activeEpoch : null,
            ...counts, invalidatedOperations,
            storeDeclaration: declaration ?? "undeclared", outcome,
        });
    }

    function rejectReset(reason: ResetReason, code: OperatorErrorCode): never {
        // Busy rejection from a separate caller is observable. Hook-originated
        // reentry is handled earlier and must not recursively emit.
        delivery.emit(resetEvent(reason, epochs.lastEpoch, code));
        throw new OperatorError(code);
    }

    return Object.freeze({
        get activeEpoch() { return epochs.activeEpoch; },
        get reference() { return tracker.reference; },
        get resetInProgress() { return busy; },
        get inFlight() { return epochs.inFlight; },
        get observerErrorCount() { return delivery.observerErrorCount; },

        beginOperation(): OperationLease {
            currentTime();
            return epochs.begin();
        },
        now(lease: OperationLease): number { return currentTime(lease); },
        finishOperation(lease: OperationLease): void {
            // Observers/providers must not retire leases or alter reset counts
            // through the cleanup path. Reject only synchronous reentry: normal
            // finally cleanup must remain possible while unhealthy/resetting,
            // including completion of an already invalidated old-epoch lease.
            if (delivery.delivering || providerDepth > 0) unavailable();
            epochs.finish(lease);
        },

        completeOperation(lease: OperationLease): number {
            const now = currentTime(lease);
            epochs.finish(lease);
            return now;
        },

        async consume(
            lease: OperationLease,
            input: Omit<ReplayConsumeInput, "nowEpochSeconds">,
        ): Promise<StoreOutcome> {
            // Copy before the final guard: local configuration accessors must
            // not be able to reset after validation but before dispatch.
            const copied = {
                scope: input.scope, keyThumbprint: input.keyThumbprint,
                nonce: input.nonce, retainUntilEpochSeconds: input.retainUntilEpochSeconds,
            };
            const nowEpochSeconds = currentTime(lease);
            const payload: Readonly<ReplayConsumeInput> = Object.freeze({ ...copied, nowEpochSeconds });
            let pending: Promise<StoreOutcome>;
            try {
                providerDepth++;
                try { pending = consumeStore(payload); }
                finally { providerDepth--; }
            } catch {
                // A synchronous backend failure still cannot override a reset.
                currentTime(lease);
                return "unavailable";
            }
            let result: unknown;
            try { result = await pending; }
            catch { result = "unavailable"; }
            // Already dispatched external writes cannot be cancelled. They
            // must never yield acceptance in a newer local epoch.
            currentTime(lease);
            return typeof result === "string" &&
                (RESULT_CODES.storeOutcomes as readonly string[]).includes(result)
                ? result as StoreOutcome : "unavailable";
        },

        async resetClockReference(reason: ResetReason = "operator"): Promise<ClockResetEvent> {
            if (delivery.delivering || providerDepth > 0) {
                throw new OperatorError("reset-in-progress");
            }
            if (busy) return rejectReset(reason, "reset-in-progress");
            if (declaration === undefined || (declaration === "process-clock" && !clearMemory)) {
                return rejectReset(reason, "reset-unsupported-store");
            }
            busy = true;
            const oldEpoch = epochs.lastEpoch;
            let invalidatedOperations = 0;
            let counts: MemoryCleanupReport = { clearedRecords: 0, clearedQuotaCounters: 0 };
            let outcome: ClockResetEvent["outcome"] = "success";
            // Classification belongs to our execution phase, not to an error
            // code supplied by a backend that may throw the same error class.
            let invalidClockSample = false;
            const healthEvents: ClockHealthEvent[] = [];
            try {
                // Expose a closed interval without blocking callers, even when
                // the owned memory clear itself is synchronous.
                await Promise.resolve();
                const sample = samples();
                let replacement: ClockTracker;
                try {
                    replacement = createClockTracker(
                        sample.wallMs as number, sample.monotonicMs as number, policy,
                    );
                } catch (error) {
                    if (!(error instanceof ProfileConfigurationError)) throw error;
                    invalidClockSample = true;
                    const event = healthChange(tracker.observe(sample.wallMs, sample.monotonicMs));
                    if (event) healthEvents.push(event);
                    throw new OperatorError("reset-clock-unavailable");
                }
                // Irreversible step BEFORE cleanup; never resurrect the old
                // epoch if clearing or committing subsequently fails.
                invalidatedOperations = epochs.invalidate();
                if (!epochs.canActivateNext) throw new OperatorError("reset-failed");
                if (declaration === "process-clock") {
                    counts = { clearedRecords: null, clearedQuotaCounters: null };
                    let report: MemoryCleanupReport;
                    try {
                        report = await clearMemory!();
                    } catch (error) {
                        // Only our identity-branded accounting channel can
                        // report partial progress. No property access on an
                        // arbitrary backend exception, even if it is a Proxy.
                        const partial = memoryCleanupFailureReport(error);
                        if (partial !== undefined) counts = partial;
                        throw new OperatorError("reset-failed");
                    }
                    if (!report || !validCount(report.clearedRecords) ||
                        !validCount(report.clearedQuotaCounters)) {
                        throw new OperatorError("reset-failed");
                    }
                    counts = {
                        clearedRecords: report.clearedRecords,
                        clearedQuotaCounters: report.clearedQuotaCounters,
                    };
                }
                // Cleanup may have awaited while either clock changed. Check
                // against the PREPARED reference, never silently rebase to the
                // final sample. The old epoch is already irreversibly invalid:
                // failure here is reset-failed, not a pre-cleanup clock error.
                // Preserve actual cleanup counts even if activation is denied.
                const finalSample = samples();
                const finalObservation = replacement.observe(
                    finalSample.wallMs, finalSample.monotonicMs,
                );
                if (!finalObservation.healthy) {
                    throw new OperatorError("reset-failed");
                }

                // No user callback or await may split the final health check
                // from this commit. Publish the prepared reference only after
                // all fallible reset work has succeeded.
                epochs.activateNext();
                tracker = replacement;
                if (!healthy) {
                    healthy = true;
                    healthEvents.push(Object.freeze({
                        type: "clock-health", healthy: true, epoch: epochs.activeEpoch,
                    }));
                }
            } catch {
                // Cleanup exceptions cannot impersonate a pre-invalidation
                // clock failure. Never inspect or retain backend error values.
                outcome = invalidClockSample ? "reset-clock-unavailable" : "reset-failed";
                if (outcome === "reset-failed") {
                    invalidatedOperations += epochs.invalidate();
                    if (healthy) {
                        healthy = false;
                        healthEvents.push(Object.freeze({
                            type: "clock-health", healthy: false,
                            epoch: null, reason: "reset-failed",
                        }));
                    }
                }
            } finally {
                // Failure is retryable, not permanently reset-in-progress.
                busy = false;
            }
            const event = resetEvent(reason, oldEpoch, outcome, counts, invalidatedOperations);
            for (const healthEvent of healthEvents) delivery.emit(healthEvent);
            delivery.emit(event);
            if (outcome !== "success") throw new OperatorError(outcome);
            return event;
        },
    });
}