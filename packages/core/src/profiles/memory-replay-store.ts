import { Buffer } from "node:buffer";
import { resolveProfileLimits, resolveReplayPolicy } from "./defaults.js";
import type { ProfileLimits, ReplayPolicy } from "./defaults.js";
import type { StoreOutcome } from "./codes.js";
import type { ContextMemoryResetPort, ReplayConsumeInput, ReplayStore } from "./replay-store.js";
import { isValidNonce } from "./nonce.js";

interface Entry {
    readonly keyThumbprint: string;
    readonly retainUntil: number;
}

/** Internal ownership bundle; do not expose the reset port to verifiers. */
export interface OwnedMemoryReplayStore {
    readonly store: ReplayStore;
    readonly resetPort: ContextMemoryResetPort;
    /** Physical retained counts, without triggering clock reads or expiry. */
    readonly records: number;
    readonly quotaCounters: number;
    readonly policy: Readonly<ReplayPolicy>;
}

function second(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Own data fields only: no callbacks in the atomic check-and-insert path. */
function data(input: object, name: string): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(input, name);
    return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
}

/**
 * Process-local replay memory, owned by exactly one shared security context.
 * No network, timers, implicit clock reads or live-entry eviction.
 *
 * The coordinator must gate every call on clock health and operation epoch.
 * This backend's high-water check is only a defensive regression check, not
 * a substitute for the coordinator's wall/monotonic drift detection.
 *
 * Atomicity is within one JS execution agent: consume has no await or user
 * callbacks between checking records and inserting. Separate processes/workers
 * do not share this memory. Restart/reset loses replay history.
 */
export function createOwnedMemoryReplayStore(
    overrides?: Partial<ReplayPolicy>,
    limitOverrides?: Partial<ProfileLimits>,
): OwnedMemoryReplayStore {
    const policy = resolveReplayPolicy(overrides);
    const limits = resolveProfileLimits(limitOverrides);
    const entries = new Map<string, Entry>();
    const perKey = new Map<string, number>();
    let nextExpiry = Infinity;
    let lastNow = 0;

    function expire(now: number): void {
        if (now < nextExpiry) return;
        nextExpiry = Infinity;
        for (const [identity, entry] of entries) {
            if (entry.retainUntil <= now) {
                entries.delete(identity);
                const count = perKey.get(entry.keyThumbprint)! - 1;
                if (count === 0) perKey.delete(entry.keyThumbprint);
                else perKey.set(entry.keyThumbprint, count);
            } else {
                nextExpiry = Math.min(nextExpiry, entry.retainUntil);
            }
        }
    }

    const store: ReplayStore = Object.freeze({
        retentionClock: "process-clock" as const,
        async consume(input: Readonly<ReplayConsumeInput>): Promise<StoreOutcome> {
            if (!input || typeof input !== "object" || Array.isArray(input)) return "unavailable";
            // All validation precedes expiry: malformed input cannot delete
            // replay history, even if it supplies a very large timestamp.
            const scope = data(input, "scope");
            const thumbprint = data(input, "keyThumbprint");
            const nonce = data(input, "nonce");
            const now = data(input, "nowEpochSeconds");
            const until = data(input, "retainUntilEpochSeconds");
            if (
                typeof scope !== "string" || scope.length === 0 ||
                scope.length > limits.maxScopeBytes || /[^\x00-\x7f]/.test(scope) ||
                typeof thumbprint !== "string" || thumbprint.length !== 43 ||
                !/^[A-Za-z0-9_-]{43}$/.test(thumbprint) ||
                !isValidNonce(nonce, limits.maxNonceBytes) ||
                !second(now) || !second(until) || until <= now || now < lastNow
            ) return "unavailable";
            const decoded = Buffer.from(thumbprint, "base64url");
            if (decoded.length !== 32 || decoded.toString("base64url") !== thumbprint) {
                return "unavailable";
            }

            // JSON array encoding is injective for these bounded strings,
            // including scopes/nonces containing quotes, backslashes or NUL.
            // No delimiter ambiguity, hashing collision or profile partition.
            const identity = JSON.stringify([scope, thumbprint, nonce]);
            lastNow = now;
            expire(now);

            // Preserve approved precedence, even when quota and capacity are
            // both exhausted. Replays do not shorten or extend existing TTLs.
            if (entries.has(identity)) return "replayed";
            const count = perKey.get(thumbprint) ?? 0;
            if (count >= policy.maxPerKey) return "per-key-quota-exceeded";
            if (entries.size >= policy.capacity) return "unavailable";

            entries.set(identity, { keyThumbprint: thumbprint, retainUntil: until });
            perKey.set(thumbprint, count + 1);
            nextExpiry = Math.min(nextExpiry, until);
            return "accepted";
        },
    });

    const resetPort: ContextMemoryResetPort = Object.freeze({
        clearForClockReset() {
            // Coordinator invalidates old operations BEFORE invoking this.
            // No callbacks/await split removal of records, counters and time
            // bookkeeping. The operation is deliberately destructive.
            const report = Object.freeze({
                clearedRecords: entries.size,
                clearedQuotaCounters: perKey.size,
            });
            entries.clear();
            perKey.clear();
            nextExpiry = Infinity;
            lastNow = 0;
            return report;
        },
    });

    return Object.freeze({
        store,
        resetPort,
        policy,
        get records() { return entries.size; },
        get quotaCounters() { return perKey.size; },
    });
}