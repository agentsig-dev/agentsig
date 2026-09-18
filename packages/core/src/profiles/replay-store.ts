import type { StoreOutcome } from "./codes.js";
import type { RetentionClock, MemoryCleanupReport } from "./context-events.js";

/**
 * Trusted, validated input assembled AFTER signature, identity and time checks.
 * No epoch identifier is transmitted: epochs isolate local operations only.
 */
export interface ReplayConsumeInput {
    readonly scope: string;
    /** Recomputed identity of the cryptographically verified public key. */
    readonly keyThumbprint: string;
    /** Exact decoded SF String, without trimming or normalization. */
    readonly nonce: string;
    /** Healthy context time at dispatch, in integer Unix seconds. */
    readonly nowEpochSeconds: number;
    /** Conservative retention deadline, in the same local clock domain. */
    readonly retainUntilEpochSeconds: number;
}

/**
 * Atomic check-and-insert, never separate lookup/write operations.
 *
 * The key is the collision-free tuple (scope, keyThumbprint, nonce).
 * Profile and signature label MUST NOT partition replay protection.
 * Per-key quotas apply to keyThumbprint across the entire store instance,
 * including all scopes. Decision order:
 * expire -> replay -> per-key quota -> global capacity -> insert.
 *
 * Never evict live entries to admit a new one. Global exhaustion returns
 * unavailable; per-key exhaustion returns per-key-quota-exceeded.
 * A replayed consume MUST NOT shorten/delete an existing live record.
 *
 * retentionClock is an immutable declaration captured at context creation:
 * - process-clock: expiry depends on the context clock; reset must clear it.
 * - independent: external expiry clock; local reset MUST NOT clear history.
 * - absent: normal consumption is allowed, but local reset is unsupported.
 *
 * An independent adapter derives a duration from the supplied deadline and
 * dispatch time, then applies retention using its own time source. It MUST NOT
 * compare a local absolute deadline directly to a different clock domain.
 * Adapter-specific delivery delays, TTL rounding and distributed atomicity
 * require their own tests; no Redis/network adapter is implemented in M2.
 *
 * Previously dispatched external consumption may complete after local reset.
 * That old invocation must not return verified. Its write can be unnecessary,
 * but cannot be allowed to shorten an existing live replay record.
 */
export interface ReplayStore {
    readonly retentionClock?: RetentionClock;
    consume(input: Readonly<ReplayConsumeInput>): Promise<StoreOutcome>;
}

/**
 * INTERNAL context-owned memory port, not a public arbitrary-store reset API.
 * The context must gate expiry and consumption on clock health and current
 * operation ownership. No timer may expire records behind that health gate.
 *
 * Only the memory backend owned by this context receives this reset port.
 * Merely declaring process-clock on a caller-supplied store does not confer
 * permission to clear it or imply safe coordination with other contexts.
 *
 * Production memory clearing is synchronous. The coordinator accepts a Promise
 * here to exercise suspended/failed cleanup with internal test doubles.
 */
export interface ContextMemoryResetPort {
    clearForClockReset(): MemoryCleanupReport | Promise<MemoryCleanupReport>;
}