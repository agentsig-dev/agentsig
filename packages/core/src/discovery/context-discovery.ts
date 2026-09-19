import { performance } from "node:perf_hooks";
import { ProfileConfigurationError } from "../profiles/codes.js";
import { securityContextInternals } from "../profiles/security-context.js";
import type { SecurityContext } from "../profiles/security-context.js";
import type { WebBotAuthProfile } from "../profiles/agent-header.js";
import { DirectoryService } from "./directory-service.js";
import type { DirectoryServiceOptions } from "./directory-service.js";
import { DirectoryTransport } from "./directory-transport.js";
import { fetchDirectoryOnce } from "./fetch-directory.js";
import { snapshotDirectoryFetchOptions } from "./fetch-configuration.js";
import type { DirectoryCacheOptions } from "./directory-cache.js";

interface DiscoveryDomain {
    readonly fingerprint: string;
    readonly observer: DirectoryServiceOptions["onRefresh"];
    readonly transport: typeof fetchDirectoryOnce;
    readonly clock: () => number;
    readonly services: Readonly<Record<WebBotAuthProfile, DirectoryService>>;
}

const domains = new WeakMap<SecurityContext, DiscoveryDomain>();
const monotonic = () => performance.now();

function invalid(): never {
    throw new ProfileConfigurationError("invalid-agent-binding");
}

/** Own data only; never invoke a configuration getter while computing identity. */
function snapshotCache(input: DirectoryCacheOptions | undefined): DirectoryCacheOptions {
    if (input === undefined) return Object.freeze({});
    if (!input || typeof input !== "object" || Array.isArray(input)) return invalid();
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const name of Reflect.ownKeys(input).sort((a, b) => String(a).localeCompare(String(b)))) {
        if (typeof name !== "string" || ![
            "fallbackSeconds", "maximumLifetimeSeconds", "negativeSeconds",
            "maxPositiveEntries", "maxPositiveAccountedBytes", "maxNegativeEntries",
        ].includes(name)) return invalid();
        const property = Object.getOwnPropertyDescriptor(input, name);
        if (!property || !Object.hasOwn(property, "value") ||
            typeof property.value !== "number" || !Number.isSafeInteger(property.value)) return invalid();
        result[name] = property.value as number;
    }
    return Object.freeze(result) as DirectoryCacheOptions;
}

/**
 * INTERNAL registry: exactly one discovery transport/scheduler per owned security
 * context, with at most two format-specific caches. Weak association preserves
 * context lifetime without an unbounded global map of operator configurations.
 *
 * An already-associated context cannot be silently rebound to another CA, proxy,
 * admission/address policy, cache configuration, observer or internal test clock.
 * Different trust domains require separate contexts. Verification clock resets
 * do not replace this record, renew cache freshness or clear admission cooldowns.
 */
export function contextDiscovery(
    context: SecurityContext,
    options: Omit<DirectoryServiceOptions, "format">,
    transport: typeof fetchDirectoryOnce = fetchDirectoryOnce,
    clock: () => number = monotonic,
): Readonly<Record<WebBotAuthProfile, DirectoryService>> {
    securityContextInternals(context); // Reject forged contexts before association.
    if (options.network && (Object.hasOwn(options.network, "signal") ||
        Object.hasOwn(options.network, "totalMilliseconds"))) return invalid();
    const network = snapshotDirectoryFetchOptions(options.network);
    const cache = snapshotCache(options.cache);
    const observer = options.onRefresh;
    if (observer !== undefined && typeof observer !== "function") return invalid();

    // Compare normalized network values, not policy object identity. Owned
    // policies cannot be forged, and named exceptions completely define them.
    // CA/proxy details stay in private configuration; never log this fingerprint.
    const fingerprint = JSON.stringify({
        mode: network.mode,
        origins: [...new Set(network.allowedOrigins)].sort(),
        exceptions: [...network.policy.exceptions].sort(),
        ca: network.ca ?? null,
        proxy: network.proxy ?? null,
        // Explicit defaults and omitted cache fields are conservatively distinct.
        cache,
    });
    const previous = domains.get(context);
    if (previous) {
        if (previous.fingerprint !== fingerprint || previous.observer !== observer ||
            previous.transport !== transport || previous.clock !== clock) return invalid();
        return previous.services;
    }

    // Validate both partitions before publishing the association. A failed
    // configuration must not leave behind a half-configured discovery context.
    const shared = new DirectoryTransport(network, transport, clock);
    const settings = {
        network, cache, ...(observer === undefined ? {} : { onRefresh: observer }),
    };
    // DirectoryService owns signal/deadline, so omit the resolved deadline field.
    const { totalMilliseconds: _total, ...serviceNetwork } = network;
    const services = Object.freeze({
        "ietf-wg-protocol-00": new DirectoryService({
            ...settings, network: serviceNetwork, format: "wg-directory-00",
        }, transport, clock, shared),
        "cloudflare-docs-2026-07-01": new DirectoryService({
            ...settings, network: serviceNetwork, format: "jwks",
        }, transport, clock, shared),
    });
    domains.set(context, Object.freeze({ fingerprint, observer, transport, clock, services }));
    return services;
}