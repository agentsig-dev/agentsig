import { ProfileConfigurationError } from "./codes.js";
import type { ConfigurationCode } from "./codes.js";
import type { ClockResetEvent, ResetReason, SecurityContextEvent } from "./context-events.js";
import type { ContextObserver } from "./context-observer.js";
import { resolveClockPolicy, resolveProfileLimits } from "./defaults.js";
import type { ClockPolicy, ProfileLimits, ReplayPolicy } from "./defaults.js";
import { createOwnedMemoryReplayStore } from "./memory-replay-store.js";
import type { ReplayStore } from "./replay-store.js";
import { createSecurityContextController } from "./security-context-controller.js";
import type { SecurityContextController } from "./security-context-controller.js";

export interface SecurityContextOptions {
    readonly store?: ReplayStore;
    /** Applies only to the default context-owned memory store. */
    readonly replayPolicy?: Partial<ReplayPolicy>;
    readonly limits?: Partial<ProfileLimits>;
    readonly clockPolicy?: Partial<ClockPolicy>;
    readonly wallClock?: () => number;
    readonly monotonicClock?: () => number;
    /** Fixed at creation; synchronous, observational and non-replaceable. */
    readonly observer?: ContextObserver<SecurityContextEvent>;
}

/**
 * Shared operator surface. No raw store, cleanup port, mutable clock tracker
 * or operation lease is exposed. Give the same instance to related verifiers.
 */
export interface SecurityContext {
    readonly activeEpoch: number | null;
    readonly resetInProgress: boolean;
    readonly inFlight: number;
    readonly observerErrorCount: number;
    /** Physical retained counts; reading these never runs expiry. */
    readonly memoryRecords: number | null;
    readonly memoryQuotaCounters: number | null;
    resetClockReference(reason?: ResetReason): Promise<ClockResetEvent>;
}

interface ContextInternals {
    readonly controller: SecurityContextController;
    readonly limits: Readonly<ProfileLimits>;
}

const internals = new WeakMap<SecurityContext, ContextInternals>();

/** Internal verifier access; deliberately excluded from the public entry point. */
export function securityContextInternals(context: SecurityContext): ContextInternals {
    if (!context || typeof context !== "object") {
        throw new ProfileConfigurationError("invalid-replay-policy");
    }
    const owned = internals.get(context);
    if (!owned) throw new ProfileConfigurationError("invalid-replay-policy");
    return owned;
}

function invalid(code: ConfigurationCode): never {
    throw new ProfileConfigurationError(code);
}

/**
 * Own data properties only. Local configuration is not a hostile Proxy sandbox.
 * Reject unknown options instead of silently ignoring a misspelled safety flag.
 */
function snapshotOptions(options: SecurityContextOptions): Record<string, unknown> {
    if (!options || typeof options !== "object" || Array.isArray(options)) {
        return invalid("invalid-replay-policy");
    }
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const clockNames = ["clockPolicy", "wallClock", "monotonicClock", "observer"];
    for (const name of Reflect.ownKeys(options)) {
        if (typeof name !== "string" ||
            !["store", "replayPolicy", "limits", ...clockNames].includes(name)) {
            return invalid("invalid-replay-policy");
        }
        const descriptor = Object.getOwnPropertyDescriptor(options, name);
        if (!descriptor || !Object.hasOwn(descriptor, "value")) {
            return invalid(clockNames.includes(name) ? "invalid-clock-configuration"
                : name === "limits" ? "invalid-resource-limits" : "invalid-replay-policy");
        }
        result[name] = descriptor.value as unknown;
    }
    return result;
}

/**
 * Construct the real memory backend and clock/epoch coordinator together.
 * Only an internally created backend obtains a memory reset capability.
 * External stores retain their history on independent-clock resets; no
 * capability declaration can grant access to a caller-supplied clear method.
 */
export function createSecurityContext(options: SecurityContextOptions = {}): SecurityContext {
    const own = snapshotOptions(options);
    const limits = resolveProfileLimits(own.limits as Partial<ProfileLimits> | undefined);
    const clockPolicy = resolveClockPolicy(own.clockPolicy as Partial<ClockPolicy> | undefined);
    for (const name of ["wallClock", "monotonicClock", "observer"]) {
        if (own[name] !== undefined && typeof own[name] !== "function") {
            invalid("invalid-clock-configuration");
        }
    }
    if (own.store !== undefined && own.replayPolicy !== undefined) {
        // Quotas on a custom store are the adapter's responsibility; pretending
        // to enforce memory quotas on it would misstate resource protection.
        invalid("invalid-replay-policy");
    }
    const memory = own.store === undefined
        ? createOwnedMemoryReplayStore(own.replayPolicy as Partial<ReplayPolicy> | undefined, limits)
        : undefined;
    const controller = createSecurityContextController({
        store: memory ? memory.store : own.store as ReplayStore,
        ...(memory ? { memoryReset: memory.resetPort } : {}),
        clockPolicy,
        ...(own.wallClock === undefined ? {} : { wallClock: own.wallClock as () => number }),
        ...(own.monotonicClock === undefined ? {} : { monotonicClock: own.monotonicClock as () => number }),
        ...(own.observer === undefined ? {} : {
            observer: own.observer as ContextObserver<SecurityContextEvent>,
        }),
    });
    const context: SecurityContext = Object.freeze({
        get activeEpoch() { return controller.activeEpoch; },
        get resetInProgress() { return controller.resetInProgress; },
        get inFlight() { return controller.inFlight; },
        get observerErrorCount() { return controller.observerErrorCount; },
        get memoryRecords() { return memory?.records ?? null; },
        get memoryQuotaCounters() { return memory?.quotaCounters ?? null; },
        resetClockReference(reason?: ResetReason) {
            return controller.resetClockReference(reason);
        },
    });
    internals.set(context, Object.freeze({ controller, limits }));
    return context;
}