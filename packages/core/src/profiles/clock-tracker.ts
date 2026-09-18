import { ProfileConfigurationError } from "./codes.js";
import { resolveClockPolicy } from "./defaults.js";
import type { ClockPolicy } from "./defaults.js";

/** Internal clock diagnostics, not new verification result codes. */
export type ClockHealthReason =
    | "invalid-sample"
    | "monotonic-regression"
    | "unsafe-arithmetic"
    | "wall-drift";

export type ClockObservation = (
    | {
        readonly healthy: true;
        readonly effectiveMilliseconds: number;
        readonly epochSeconds: number;
    }
    | {
        readonly healthy: false;
        readonly reason: ClockHealthReason;
    }
) & {
    /** Only a change in health produces a transition, not each failed sample. */
    readonly transition?: "healthy" | "unhealthy";
};

export interface ClockTracker {
    readonly reference: Readonly<{ wallMs: number; monotonicMs: number }>;
    readonly policy: Readonly<ClockPolicy>;
    observe(wallMs: unknown, monotonicMs: unknown): ClockObservation;
}

function boundedNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) &&
        Math.abs(value) <= Number.MAX_SAFE_INTEGER;
}

function wallSample(value: unknown): value is number {
    return boundedNumber(value) && value >= 0;
}

/**
 * Internal, deterministic tracker. It never reads a provider or clears a store.
 *
 * Effective time = reference wall + elapsed monotonic time. Wall-clock steps
 * affect health, not the reference. A backward monotonic step permanently
 * invalidates this tracker: recovery requires an explicit context reset.
 *
 * No reset method is exposed. The owning security context must invalidate
 * operations and coordinate replay state BEFORE replacing the tracker.
 * Returning to a healthy wall drift does not rebase time or erase replay data.
 *
 * Transitions are returned as data, not delivered to user callbacks here.
 * This keeps callback exceptions/reentrancy out of clock arithmetic; the
 * security context will deliver sanitized events after its state is updated.
 */
export function createClockTracker(
    referenceWallMs: number,
    referenceMonotonicMs: number,
    overrides?: Partial<ClockPolicy>,
): ClockTracker {
    const policy = resolveClockPolicy(overrides);
    if (!wallSample(referenceWallMs) || !boundedNumber(referenceMonotonicMs)) {
        throw new ProfileConfigurationError("invalid-clock-configuration");
    }
    const reference = Object.freeze({
        wallMs: referenceWallMs, monotonicMs: referenceMonotonicMs,
    });
    const maximumDriftMs = policy.maxClockDriftSeconds * 1000;
    let previousMonotonicMs = referenceMonotonicMs;
    let regressed = false;
    let wasHealthy = true;

    function observation(
        result:
            | { healthy: true; effectiveMilliseconds: number; epochSeconds: number }
            | { healthy: false; reason: ClockHealthReason },
    ): ClockObservation {
        const changed = wasHealthy !== result.healthy;
        wasHealthy = result.healthy;
        return Object.freeze({
            ...result,
            ...(changed ? { transition: result.healthy ? "healthy" as const : "unhealthy" as const } : {}),
        });
    }

    return Object.freeze({
        reference,
        policy,
        observe(wallMs: unknown, monotonicMs: unknown): ClockObservation {
            // A valid monotonic sample must be tracked even if the wall sample
            // is bad. Otherwise a regression during a wall outage could be
            // missed when the wall provider recovers.
            const monotonicValid = boundedNumber(monotonicMs);
            if (monotonicValid) {
                if (monotonicMs < previousMonotonicMs) regressed = true;
                else previousMonotonicMs = monotonicMs;
            }
            if (regressed) {
                return observation({ healthy: false, reason: "monotonic-regression" });
            }
            if (!wallSample(wallMs) || !monotonicValid) {
                return observation({ healthy: false, reason: "invalid-sample" });
            }
            const elapsed = monotonicMs - reference.monotonicMs;
            const effective = reference.wallMs + elapsed;
            // Finite samples can still overflow safe arithmetic when combined.
            // Never clamp or return rounded-out-of-range time as healthy.
            if (!boundedNumber(elapsed) || elapsed < 0 || !wallSample(effective)) {
                return observation({ healthy: false, reason: "unsafe-arithmetic" });
            }
            const drift = wallMs - effective;
            if (Math.abs(drift) > maximumDriftMs) {
                return observation({ healthy: false, reason: "wall-drift" });
            }
            return observation({
                healthy: true,
                effectiveMilliseconds: effective,
                epochSeconds: Math.floor(effective / 1000),
            });
        },
    });
}