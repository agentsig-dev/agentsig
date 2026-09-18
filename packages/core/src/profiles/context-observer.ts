import { ProfileConfigurationError } from "./codes.js";

/**
 * One synchronous observer, fixed at context creation. Application code should
 * enqueue sanitized events and handle asynchronous logging failures itself.
 * A void callback is not an asynchronous observer protocol: we never await or
 * inspect its return value, and cannot catch errors thrown by deferred work.
 */
export type ContextObserver<Event extends object> = (event: Readonly<Event>) => void;

export interface ObserverDelivery<Event extends object> {
    /** True only while executing this observer's synchronous call stack. */
    readonly delivering: boolean;
    /** Content-free, saturating counter; no raw exception is retained. */
    readonly observerErrorCount: number;
    /** Internal: the context must finalize the associated state before calling. */
    emit(event: Readonly<Event>): void;
}

/**
 * Internal delivery boundary, owned by one security context.
 * The context rejects observer-originated verification/reset calls BEFORE
 * emitting any further event. This prevents recursive failure notifications.
 *
 * No await, queued delivery, listener replacement or secondary failure hook.
 * Observers cannot roll back a completed state transition by throwing.
 */
export function createObserverDelivery<Event extends object>(
    observer?: ContextObserver<Event>,
): ObserverDelivery<Event> {
    if (observer !== undefined && typeof observer !== "function") {
        throw new ProfileConfigurationError("invalid-clock-configuration");
    }
    let delivering = false;
    let observerErrorCount = 0;
    return Object.freeze({
        get delivering() { return delivering; },
        get observerErrorCount() { return observerErrorCount; },

        emit(event: Readonly<Event>): void {
            if (observer === undefined) return;
            // Reentry rejection belongs at context entry points. Reaching this
            // branch indicates an internal caller violated that contract; do
            // not recursively invoke the observer or create another event.
            if (delivering) return;
            delivering = true;
            try {
                observer(event);
            } catch {
                // Includes Error, strings, null, undefined and arbitrary objects.
                // Do not inspect/stringify the thrown value, attach a cause,
                // log it, or dispatch an "observer error" callback.
                // Saturation prevents loss of integer precision in long-lived
                // contexts; this metric never controls security acceptance.
                if (observerErrorCount < Number.MAX_SAFE_INTEGER) observerErrorCount++;
            } finally {
                // Stack-local guard: deferred tasks never inherit this flag,
                // even when the callback threw before scheduling completed.
                delivering = false;
            }
        },
    });
}