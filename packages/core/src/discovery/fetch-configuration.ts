import { configuredAgentOrigin } from "../profiles/agent-origin.js";
import { ProfileConfigurationError } from "../profiles/codes.js";
import {
    assertDirectoryAddressPolicy, defaultDirectoryAddressPolicy,
} from "./address-policy.js";
import type { DirectoryAddressPolicy } from "./address-policy.js";
import { snapshotDirectoryProxy } from "./proxy-tls.js";
import type { DirectoryHttpsProxy } from "./proxy-tls.js";
import type { DirectoryFetchOptions } from "./fetch-directory.js";

export interface ResolvedDirectoryFetchOptions extends DirectoryFetchOptions {
    readonly mode: "allowlist" | "open";
    readonly allowedOrigins: readonly string[];
    readonly policy: DirectoryAddressPolicy;
    readonly totalMilliseconds: number;
}

/**
 * INTERNAL trusted configuration boundary, shared by single-fetch and discovery.
 * Snapshot before queueing or DNS: ordinary getters must not execute, and later
 * mutation must not redirect traffic, relax admission, or change TLS identity.
 * Arbitrary JavaScript Proxy objects are not a sandboxed configuration source.
 */
export function snapshotDirectoryFetchOptions(
    input: DirectoryFetchOptions = {},
): Readonly<ResolvedDirectoryFetchOptions> {
    const invalid = (): never => {
        throw new ProfileConfigurationError("invalid-agent-binding");
    };
    if (!input || typeof input !== "object" || Array.isArray(input)) return invalid();
    const fields: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const name of Reflect.ownKeys(input)) {
        if (typeof name !== "string" || ![
            "mode", "allowedOrigins", "policy", "proxy", "ca", "totalMilliseconds", "signal",
        ].includes(name)) return invalid();
        const descriptor = Object.getOwnPropertyDescriptor(input, name);
        if (!descriptor || !Object.hasOwn(descriptor, "value")) return invalid();
        fields[name] = descriptor.value as unknown;
    }

    const mode = fields.mode === undefined ? "allowlist" : fields.mode;
    if (mode !== "allowlist" && mode !== "open") return invalid();
    const total = fields.totalMilliseconds === undefined ? 3000 : fields.totalMilliseconds;
    if (typeof total !== "number" || !Number.isSafeInteger(total) || total <= 0 || total > 3000) {
        throw new ProfileConfigurationError("invalid-resource-limits");
    }
    const policy = fields.policy === undefined
        ? defaultDirectoryAddressPolicy : fields.policy as DirectoryAddressPolicy;
    assertDirectoryAddressPolicy(policy);

    const supplied = fields.allowedOrigins === undefined ? [] : fields.allowedOrigins;
    if (!Array.isArray(supplied) || supplied.length > 1000) return invalid();
    const allowedOrigins: string[] = [];
    for (let index = 0; index < supplied.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(supplied, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, "value")) return invalid();
        // Count all supplied occurrences before normalization/deduplication.
        allowedOrigins.push(configuredAgentOrigin(descriptor.value as unknown));
    }

    const ca = fields.ca;
    if (ca !== undefined && (typeof ca !== "string" || !ca.length)) {
        throw new ProfileConfigurationError("invalid-key-configuration");
    }
    const signal = fields.signal;
    if (signal !== undefined && !(signal instanceof AbortSignal)) return invalid();
    // Do not spread proxy input before validation: that would invoke accessors.
    const proxy = fields.proxy === undefined ? undefined
        : snapshotDirectoryProxy(fields.proxy as DirectoryHttpsProxy);
    return Object.freeze({
        mode, totalMilliseconds: total, policy,
        allowedOrigins: Object.freeze(allowedOrigins),
        ...(ca === undefined ? {} : { ca }),
        ...(signal === undefined ? {} : { signal }),
        ...(proxy === undefined ? {} : { proxy }),
    });
}