import { Buffer } from "node:buffer";
import { DEFAULT_PROFILE_LIMITS } from "../profiles/defaults.js";
import { isValidNonce } from "../profiles/nonce.js";
import type { ReplayConsumeInput } from "../profiles/replay-store.js";

export interface RedisConsumeRecord {
    /** Encoded hash/sorted-set member, never a Redis key name or diagnostic. */
    readonly identity: string;
    readonly thumbprint: string;
    readonly durationMilliseconds: number;
}

function data(input: object, name: keyof ReplayConsumeInput): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(input, name);
    return descriptor && Object.hasOwn(descriptor, "value")
        ? descriptor.value as unknown : undefined;
}

function second(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Validate and snapshot before ANY Redis command, including expiry cleanup.
 * No signature policy is inferred here: normal retention comes from consume.
 *
 * JSON array encoding is injective for the validated strings. Base64url preserves
 * that property and avoids delimiters/control characters in Redis members.
 * It is reversible encoding, NOT encryption or protection against Redis readers.
 * Neither raw nor encoded nonce identity belongs in logs or Redis key names.
 * Profile, signature label, and local operation epoch never partition replay.
 */
export function prepareRedisConsume(input: Readonly<ReplayConsumeInput>): RedisConsumeRecord | undefined {
    try {
        if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
        const scope = data(input, "scope");
        const thumbprint = data(input, "keyThumbprint");
        const nonce = data(input, "nonce");
        const now = data(input, "nowEpochSeconds");
        const until = data(input, "retainUntilEpochSeconds");
        if (typeof scope !== "string" || scope.length === 0 ||
            scope.length > DEFAULT_PROFILE_LIMITS.maxScopeBytes || /[^\x00-\x7f]/.test(scope) ||
            typeof thumbprint !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(thumbprint) ||
            !isValidNonce(nonce, DEFAULT_PROFILE_LIMITS.maxNonceBytes) ||
            !second(now) || !second(until) || until <= now) return undefined;

        const decoded = Buffer.from(thumbprint, "base64url");
        if (decoded.length !== 32 || decoded.toString("base64url") !== thumbprint) return undefined;

        const duration = (BigInt(until) - BigInt(now)) * 1000n;
        if (duration <= 0n || duration > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;

        return Object.freeze({
            identity: Buffer.from(JSON.stringify([scope, thumbprint, nonce]), "utf8").toString("base64url"),
            thumbprint,
            durationMilliseconds: Number(duration),
        });
    } catch {
        // Malformed provider objects cannot leak exceptions or initiate cleanup.
        // Ordinary accessors are not invoked; arbitrary Proxies are not sandboxed.
        return undefined;
    }
}