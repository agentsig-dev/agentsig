import type { ClockHealthReason } from "./clock-tracker.js";
import type { OperatorErrorCode } from "./operator-errors.js";

/**
 * Retention-clock declaration, not a claim of distributed reset support.
 * An absent declaration permits normal consumption but prohibits local reset.
 */
export type RetentionClock = "process-clock" | "independent";

export type ResetReason = "operator" | "health";

export interface ClockResetEvent {
    readonly type: "reset";
    /** "health" still requires an explicit operator call; never automatic. */
    readonly reason: ResetReason;
    /** Last allocated process-local epoch, including while closed after failure. */
    readonly oldEpoch: number;
    /** Newly activated epoch on success; null on a rejected/failed attempt. */
    readonly newEpoch: number | null;
    /** Actual known removals; null means cleanup progress is unknown. */
    readonly clearedRecords: number | null;
    readonly clearedQuotaCounters: number | null;
    readonly invalidatedOperations: number;
    readonly storeDeclaration: RetentionClock | "undeclared";
    readonly outcome: "success" | OperatorErrorCode;
}

export type ClockHealthEvent =
    | {
        readonly type: "clock-health";
        readonly healthy: true;
        readonly epoch: number | null;
    }
    | {
        readonly type: "clock-health";
        readonly healthy: false;
        readonly epoch: number | null;
        readonly reason: ClockHealthReason | "reset-failed";
    };

/**
 * Sanitized, flat event data only. No headers, key identifiers/material,
 * nonce, provider exceptions or store exception objects.
 *
 * Observers run once per event after the corresponding state is finalized.
 * These diagnostics neither authorize requests nor extend any result catalog.
 */
export type SecurityContextEvent = ClockResetEvent | ClockHealthEvent;

/**
 * Internal cleanup accounting. This is not a public arbitrary-store reset
 * interface: M2 resets only its context-owned memory implementation.
 * Test doubles may exercise partial failure at this internal boundary.
 */
export interface MemoryCleanupReport {
    readonly clearedRecords: number | null;
    readonly clearedQuotaCounters: number | null;
}