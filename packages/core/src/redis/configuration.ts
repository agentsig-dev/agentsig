import { Buffer } from "node:buffer";
import { ProfileConfigurationError } from "../profiles/codes.js";
import type { RedisCommandClient, RedisReplayStoreOptions } from "./types.js";

export interface RedisReplayConfiguration {
    readonly client: RedisCommandClient;
    readonly send: (arguments_: readonly string[]) => Promise<unknown>;
    readonly keyPrefix: string;
    readonly recoveryMilliseconds: number;
    readonly capacity: number;
    readonly maxPerKey: number;
    readonly acknowledgeEvictionPolicy: boolean;
}

function invalid(): never {
    throw new ProfileConfigurationError("invalid-replay-policy");
}

/**
 * Snapshot operator configuration before any Redis command. Namespace encoding
 * is injective, not a hash: its hex representation forms one Cluster hash tag.
 * Different scopes still share the same enforcement domain and per-key quota.
 */
export function resolveRedisReplayConfiguration(
    options: RedisReplayStoreOptions,
): Readonly<RedisReplayConfiguration> {
    if (!options || typeof options !== "object" || Array.isArray(options)) return invalid();
    const own: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const name of Reflect.ownKeys(options)) {
        if (typeof name !== "string" || ![
            "client", "namespace", "recoveryHorizonSeconds",
            "capacity", "maxPerKey", "acknowledgeEvictionPolicy",
        ].includes(name)) return invalid();
        const property = Object.getOwnPropertyDescriptor(options, name);
        if (!property || !Object.hasOwn(property, "value")) return invalid();
        own[name] = property.value as unknown;
    }

    const horizon = own.recoveryHorizonSeconds;
    if (typeof horizon !== "number" || !Number.isSafeInteger(horizon) || horizon <= 0) {
        return invalid();
    }
    const milliseconds = BigInt(horizon) * 1000n;
    if (milliseconds > BigInt(Number.MAX_SAFE_INTEGER)) return invalid();

    const namespace = own.namespace;
    if (typeof namespace !== "string" || namespace.length === 0 ||
        namespace.length > 128 || /[^\x21-\x7e]/.test(namespace)) return invalid();
    const capacity = own.capacity === undefined ? 10000 : own.capacity;
    const maxPerKey = own.maxPerKey === undefined ? 1000 : own.maxPerKey;
    for (const value of [capacity, maxPerKey]) {
        // Zero explicitly disables admission; it never means unlimited.
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return invalid();
    }
    // The initial atomic state-document implementation scans at most 10,000
    // records per command. Do not accept configuration that defeats that bound.
    if ((capacity as number) > 10000 || (maxPerKey as number) > 10000) return invalid();
    const acknowledgement = own.acknowledgeEvictionPolicy;
    if (acknowledgement !== undefined && acknowledgement !== "noeviction") return invalid();

    const client = own.client as RedisCommandClient | undefined;
    if (!client || typeof client !== "object") return invalid();
    let send: RedisReplayConfiguration["send"];
    try {
        // The client is a trusted application-owned capability. Unlike the plain
        // options record, readiness may be a live client getter and sendCommand
        // may be a prototype method. Capture the method, not a mutable lookup.
        if (client.automaticRetries !== false || client.offlineQueue !== false ||
            typeof client.sendCommand !== "function") return invalid();
        send = client.sendCommand.bind(client);
    } catch {
        // No raw client/provider error or cause crosses configuration admission.
        return invalid();
    }
    return Object.freeze({
        client, send,
        keyPrefix: `agentsig:replay:{${Buffer.from(namespace, "ascii").toString("hex")}}:`,
        recoveryMilliseconds: Number(milliseconds),
        capacity: capacity as number,
        maxPerKey: maxPerKey as number,
        acknowledgeEvictionPolicy: acknowledgement === "noeviction",
    });
}