import { CandidateRejection } from "./codes.js";

/**
 * Internal operation handle. Epoch numbers are process-local diagnostics, not
 * credentials and never part of a remote replay-store consume request.
 */
export interface OperationLease {
    readonly epoch: number;
}

export interface OperationEpochs {
    readonly activeEpoch: number | null;
    readonly lastEpoch: number;
    readonly inFlight: number;
    begin(): OperationLease;
    assertCurrent(lease: OperationLease): void;
    finish(lease: OperationLease): void;
    /** Irreversibly close the old epoch; returns invalidated operation count. */
    invalidate(): number;
    /** Activate a fresh epoch only after reset cleanup/reference commit. */
    activateNext(): number;
    readonly canActivateNext: boolean;
}

function unavailable(): never {
    throw new CandidateRejection({ status: "unverified", reason: "clock-unavailable" });
}

/**
 * Owned exclusively by the shared security context, not by each verifier.
 * No user callbacks, awaits, clock reads or store writes occur in this helper.
 *
 * Invalidate BEFORE resetting memory. A cleanup failure leaves activeEpoch
 * null, while activateNext remains available to a later successful retry.
 * Neither a saved numeric epoch nor a handle from another context can bypass
 * lease ownership checks. Completion of invalidated work cannot decrement the
 * count of operations started in a newer epoch.
 *
 * The WeakMap does not keep abandoned operation handles alive. Callers must
 * nevertheless finish handles in finally blocks for accurate event counts.
 * Invalidation drops the old count without enumerating or retaining handles.
 */
export function createOperationEpochs(): OperationEpochs {
    let lastEpoch = 1;
    let activeEpoch: number | null = lastEpoch;
    let inFlight = 0;
    const leases = new WeakMap<OperationLease, { epoch: number; finished: boolean }>();

    function state(lease: OperationLease) {
        if (!lease || typeof lease !== "object") return undefined;
        return leases.get(lease);
    }

    return Object.freeze({
        get activeEpoch() { return activeEpoch; },
        get lastEpoch() { return lastEpoch; },
        get inFlight() { return inFlight; },
        get canActivateNext() { return lastEpoch < Number.MAX_SAFE_INTEGER; },

        begin(): OperationLease {
            if (activeEpoch === null || inFlight >= Number.MAX_SAFE_INTEGER) {
                return unavailable();
            }
            const lease = Object.freeze({ epoch: activeEpoch });
            leases.set(lease, { epoch: activeEpoch, finished: false });
            inFlight++;
            return lease;
        },

        assertCurrent(lease: OperationLease): void {
            const owned = state(lease);
            if (!owned || owned.finished || activeEpoch === null || owned.epoch !== activeEpoch) {
                unavailable();
            }
        },

        finish(lease: OperationLease): void {
            const owned = state(lease);
            // Idempotent cleanup also permits finally after a failed begin/use
            // path without reviving an invalidated lease or corrupting counts.
            if (!owned || owned.finished) return;
            owned.finished = true;
            if (activeEpoch !== null && owned.epoch === activeEpoch) inFlight--;
        },

        invalidate(): number {
            const invalidated = inFlight;
            activeEpoch = null;
            inFlight = 0;
            return invalidated;
        },

        activateNext(): number {
            // These are internal state-machine invariants, not remote-request
            // failures. The reset coordinator must handle failed commit while
            // remaining closed; never reuse an old epoch on overflow.
            if (activeEpoch !== null) throw new Error("Cannot activate an open operation epoch");
            if (lastEpoch >= Number.MAX_SAFE_INTEGER) {
                throw new Error("Operation epoch identifier exhausted");
            }
            lastEpoch++;
            activeEpoch = lastEpoch;
            return activeEpoch;
        },
    });
}