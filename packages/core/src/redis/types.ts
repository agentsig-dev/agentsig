import type { ReplayStore } from "../profiles/replay-store.js";

/**
 * Application-owned Redis command boundary. Supply a dedicated wrapper around
 * an authenticated client connected to one primary / one Cluster hash slot.
 *
 * These declarations are operator assertions, not runtime attestation of the
 * underlying client's behavior. Disable automatic retries and offline queues
 * in the actual client. An ambiguous write must never be retried as acceptance.
 * Commands must reject on transport failure, and Redis error replies must reject
 * with an Error containing the original Redis error prefix (for example NOPERM).
 * Successful replies use strings, numbers, null, and arrays of those values.
 *
 * The adapter neither connects nor closes this client. It imposes its own
 * operation deadline; a timeout does not prove a dispatched write was cancelled.
 */
export interface RedisCommandClient {
    readonly automaticRetries: false;
    readonly offlineQueue: false;
    readonly isReady: boolean;
    sendCommand(arguments_: readonly string[]): Promise<unknown>;
}

export interface RedisReplayStoreOptions {
    readonly client: RedisCommandClient;
    /** Explicit enforcement domain; never inferred from incoming request data. */
    readonly namespace: string;
    /**
     * Mandatory application-supplied recovery horizon in integer seconds.
     * Include the largest verifier window and distributed-clock allowance.
     * The store does not derive policy or silently substitute a default.
     */
    readonly recoveryHorizonSeconds: number;
    /** Defaults to 10,000. Live replay history is never evicted for admission. */
    readonly capacity?: number;
    /** Defaults to 1,000, across all scopes for each verified thumbprint. */
    readonly maxPerKey?: number;
    /**
     * Permits unavailable CONFIG inspection only for recognized permission or
     * capability errors. Cannot override a reported conflicting eviction policy
     * or conceal a network failure. Keep noeviction true throughout deployment.
     */
    readonly acknowledgeEvictionPolicy?: "noeviction";
}

/**
 * Independent Redis-time retention; local verification-clock resets do not
 * delete shared history. Quarantine is held in Redis, not in this object.
 * No reset, early-release, or memory-fallback API is provided.
 */
export interface RedisReplayStore extends ReplayStore {
    readonly retentionClock: "independent";
}