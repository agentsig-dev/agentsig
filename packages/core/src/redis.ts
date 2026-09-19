/**
 * Public Redis replay adapter for an application-owned command client.
 * No connection lifecycle, automatic retry, offline queue, memory fallback,
 * destructive reset, or quarantine early-release API is provided.
 *
 * Initial implementation scans and rewrites bounded state in O(n) time.
 * Cluster routing, failover, OOM behavior and full-capacity performance have
 * not been established by the current real standalone Redis test suite.
 */
export { createRedisReplayStore } from "./redis/replay-store.js";
export type {
    RedisCommandClient, RedisReplayStore, RedisReplayStoreOptions,
} from "./redis/types.js";
export { recoveryHorizonSeconds } from "./profiles/recovery-horizon.js";