import { randomBytes } from "node:crypto";
import { ProfileConfigurationError } from "../profiles/codes.js";
import type { StoreOutcome } from "../profiles/codes.js";
import type { ReplayConsumeInput } from "../profiles/replay-store.js";
import { assertRedisEvictionPolicy, runRedisCommand } from "./command.js";
import { resolveRedisReplayConfiguration } from "./configuration.js";
import type { RedisReplayConfiguration } from "./configuration.js";
import { prepareRedisConsume } from "./consume-input.js";
import type { RedisConsumeRecord } from "./consume-input.js";
import { REDIS_REPLAY_SCRIPT } from "./replay-script.js";
import type { RedisReplayStore, RedisReplayStoreOptions } from "./types.js";

function argumentsFor(
    configuration: RedisReplayConfiguration,
    mode: "setup" | "consume",
    record?: RedisConsumeRecord,
): readonly string[] {
    const prefix = configuration.keyPrefix;
    // A fresh proposal is used only if the atomic script detects missing or
    // inconsistent history. Existing healthy markers never adopt this epoch.
    const proposedEpoch = randomBytes(16).toString("hex");
    return [
        "EVAL", REDIS_REPLAY_SCRIPT, "3",
        `${prefix}epoch`, `${prefix}quarantine-until`, `${prefix}state`,
        mode,
        String(configuration.recoveryMilliseconds),
        String(configuration.capacity),
        String(configuration.maxPerKey),
        proposedEpoch,
        record?.identity ?? "",
        record?.thumbprint ?? "",
        String(record?.durationMilliseconds ?? 0),
    ];
}

/**
 * Application-owned connection, library-owned atomic replay operation.
 * Factory completion does NOT mean quarantine has ended. Every consume checks
 * the Redis-resident recovery state atomically with expiry/quota/insertion.
 *
 * No cached readiness, automatic retry, EVALSHA fallback, memory fallback,
 * administrative reset, or early-release capability is provided.
 * This module remains internal until public export and integration review.
 */
export async function createRedisReplayStore(
    options: RedisReplayStoreOptions,
): Promise<RedisReplayStore> {
    // Validate the mandatory horizon and all options before any backend command.
    const configuration = resolveRedisReplayConfiguration(options);
    await assertRedisEvictionPolicy(configuration);
    const setup = await runRedisCommand(configuration, argumentsFor(configuration, "setup"));
    if (setup.outcome !== "reply" ||
        (setup.value !== "ready" && setup.value !== "quarantine")) {
        // Never return a usable adapter after unknown or contradictory setup.
        throw new ProfileConfigurationError("invalid-replay-policy");
    }

    return Object.freeze({
        retentionClock: "independent" as const,
        async consume(input: Readonly<ReplayConsumeInput>): Promise<StoreOutcome> {
            const record = prepareRedisConsume(input);
            if (!record) return "unavailable";
            try {
                const result = await runRedisCommand(
                    configuration, argumentsFor(configuration, "consume", record),
                );
                if (result.outcome !== "reply") return "unavailable";
                switch (result.value) {
                    case "accepted":
                    case "replayed":
                    case "per-key-quota-exceeded":
                        return result.value;
                    default:
                        // Includes quarantine, configuration mismatch, capacity,
                        // malformed replies and unknown future backend outcomes.
                        return "unavailable";
                }
            } catch {
                // Includes local entropy/provider failures. Never expose nonce
                // identity or backend exceptions, and never retry this operation.
                return "unavailable";
            }
        },
    });
}