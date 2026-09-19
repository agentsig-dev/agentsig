import { performance } from "node:perf_hooks";
import { ProfileConfigurationError } from "../profiles/codes.js";
import type { RedisReplayConfiguration } from "./configuration.js";

export type RedisCommandResult =
    | { readonly outcome: "reply"; readonly value: unknown }
    | { readonly outcome: "unavailable" }
    | { readonly outcome: "inspection-unavailable" };

/**
 * Internal command boundary. Never retry, enqueue, or expose backend exceptions.
 * A timeout means completion is unknown, NOT that Redis rolled back the write.
 * The application-owned client must independently disable retry/offline queues.
 */
export async function runRedisCommand(
    configuration: RedisReplayConfiguration,
    arguments_: readonly string[],
    inspectEvictionPolicy = false,
): Promise<RedisCommandResult> {
    const started = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        if (configuration.client.isReady !== true) return { outcome: "unavailable" };
        const command = Promise.resolve().then(async (): Promise<RedisCommandResult> => {
            // Recheck before dispatch: readiness can change while entering the
            // microtask. Never ask an offline client to queue this command.
            if (performance.now() - started >= 100 ||
                configuration.client.isReady !== true) return { outcome: "unavailable" };
            try {
                const value: unknown = await configuration.send(Object.freeze([...arguments_]));
                return { outcome: "reply", value };
            } catch (error) {
                // Recognize only narrow Redis CONFIG permission/capability
                // failures. Network errors, OOM, authentication failure and
                // arbitrary backend messages must not authorize the override.
                if (inspectEvictionPolicy && error instanceof Error) {
                    const message = error.message;
                    if (typeof message === "string" && message.length <= 2048 &&
                        (/^NOPERM\b/.test(message) ||
                            /^ERR unknown (?:command ['"]CONFIG['"]|subcommand ['"]GET['"])/i.test(message))) {
                        return { outcome: "inspection-unavailable" };
                    }
                }
                return { outcome: "unavailable" };
            }
        });
        // Attach handlers to every pending path, including a late rejection
        // after the timeout has won. Never store a raw exception or its cause.
        const guarded = command.catch((): RedisCommandResult => ({ outcome: "unavailable" }));
        const deadline = new Promise<RedisCommandResult>((resolve) => {
            timer = setTimeout(() => resolve({ outcome: "unavailable" }), 100);
        });
        const result = await Promise.race([guarded, deadline]);
        // A delayed event-loop timer cannot extend acceptance of a late reply.
        return performance.now() - started >= 100 ? { outcome: "unavailable" } : result;
    } catch {
        return { outcome: "unavailable" };
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

/**
 * Setup gate only, not continuous server-policy attestation.
 * Operators must preserve noeviction throughout the adapter's lifetime.
 * A conflicting or malformed server reply cannot be overridden.
 */
export async function assertRedisEvictionPolicy(
    configuration: RedisReplayConfiguration,
): Promise<void> {
    const result = await runRedisCommand(configuration, ["CONFIG", "GET", "maxmemory-policy"], true);
    if (result.outcome === "inspection-unavailable" && configuration.acknowledgeEvictionPolicy) return;
    if (result.outcome === "reply" && Array.isArray(result.value) &&
        result.value.length === 2 && result.value[0] === "maxmemory-policy" &&
        result.value[1] === "noeviction") return;
    // The adapter cannot be safely configured against this backend. Do not
    // expose a partially admitted store or the underlying server error.
    throw new ProfileConfigurationError("invalid-replay-policy");
}