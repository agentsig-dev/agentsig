import type { MemoryCleanupReport } from "./context-events.js";

/**
 * INTERNAL accounting channel for context-owned memory cleanup only.
 * Not an operator error, public adapter capability or new result-catalog code.
 *
 * Ordinary backend exceptions carry no trustworthy progress information.
 * This branded error records only explicitly known removal counts and never
 * accepts a cause, message, nonce, key or arbitrary backend exception.
 * The coordinator still returns the existing reset-failed operator error.
 */
export class MemoryCleanupFailure extends Error {
    constructor(report: MemoryCleanupReport) {
        super("Context-owned memory cleanup did not complete");
        this.name = "MemoryCleanupFailure";
        // Read once and copy only validated counters. No caller-owned report
        // object or arbitrary exception properties survive this boundary.
        const records = report.clearedRecords;
        const quotas = report.clearedQuotaCounters;
        reports.set(this, Object.freeze({
            clearedRecords: count(records),
            clearedQuotaCounters: count(quotas),
        }));
    }
}

const reports = new WeakMap<object, Readonly<MemoryCleanupReport>>();

function count(value: unknown): number | null {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
        ? value : null;
}

/**
 * WeakMap identity, not instanceof/property reads: arbitrary thrown objects
 * cannot execute getters or impersonate a report using their prototype.
 */
export function memoryCleanupFailureReport(
    error: unknown,
): Readonly<MemoryCleanupReport> | undefined {
    if (error === null || typeof error !== "object") return undefined;
    return reports.get(error);
}