import type { RequestParts } from "../types.js";
import type { WebBotAuthProfile } from "../profiles/agent-header.js";
import { ProfileConfigurationError } from "../profiles/codes.js";
import { resolveVerificationConfiguration } from "../profiles/verification-config.js";
import { createVerificationEngine } from "../profiles/verification-engine.js";
import type {
    OfflineVerifierOptions, VerificationResult,
} from "../profiles/verification-types.js";
import type { SecurityContext } from "../profiles/security-context.js";
import { DirectoryService } from "./directory-service.js";
import type {
    DirectoryRefreshResult, DirectoryServiceOptions,
} from "./directory-service.js";
import type { fetchDirectoryOnce } from "./fetch-directory.js";
import { createNetworkStrategy } from "./network-candidate.js";
import type { DiscoveredIdentity } from "./network-candidate.js";

export interface NetworkVerifierOptions extends Omit<
    OfflineVerifierOptions, "jwks" | "jwksFormat" | "bindings" | "identityMode"
> {
    readonly discovery?: Omit<DirectoryServiceOptions, "format">;
}

export interface NetworkVerifier {
    readonly context: SecurityContext;
    verify(request: RequestParts): Promise<VerificationResult<DiscoveredIdentity>>;
    /** Explicit refresh is subject to admission, backoff and rate limits. */
    refresh(origin: string, profile: WebBotAuthProfile): Promise<DirectoryRefreshResult>;
}

/**
 * INTERNAL until public discovery export review. Dependencies are test-only,
 * never forwarded from application configuration or incoming request metadata.
 */
export interface NetworkVerifierDependencies {
    readonly transport?: typeof fetchDirectoryOnce;
    readonly discoveryClock?: () => number;
}

export function createNetworkVerifier(
    options: NetworkVerifierOptions,
    dependencies: NetworkVerifierDependencies = {},
): NetworkVerifier {
    if (!options || typeof options !== "object" || Array.isArray(options)) {
        throw new ProfileConfigurationError("invalid-candidate-policy");
    }
    const common: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    let discovery: unknown;
    for (const name of Reflect.ownKeys(options)) {
        const descriptor = Object.getOwnPropertyDescriptor(options, name);
        if (typeof name !== "string" || ![
            "scope", "context", "candidatePolicy", "allowedProfiles", "profiles",
            "allowTestKeys", "coreLimits", "structuredFieldTypes", "discovery",
        ].includes(name) || !descriptor || !Object.hasOwn(descriptor, "value")) {
            throw new ProfileConfigurationError("invalid-candidate-policy");
        }
        if (name === "discovery") discovery = descriptor.value as unknown;
        else common[name] = descriptor.value as unknown;
    }
    const discoveryOptions: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    if (discovery !== undefined) {
        if (!discovery || typeof discovery !== "object" || Array.isArray(discovery)) {
            throw new ProfileConfigurationError("invalid-agent-binding");
        }
        for (const name of Reflect.ownKeys(discovery)) {
            const descriptor = Object.getOwnPropertyDescriptor(discovery, name);
            if (typeof name !== "string" || !["network", "cache", "onRefresh"].includes(name) ||
                !descriptor || !Object.hasOwn(descriptor, "value")) {
                throw new ProfileConfigurationError("invalid-agent-binding");
            }
            discoveryOptions[name] = descriptor.value as unknown;
        }
    }

    // Reuse validated clock/replay/profile settings only. The empty local key
    // set is never used for lookup or as fallback; no remote material or manual
    // origin binding enters the offline configuration loader.
    const config = resolveVerificationConfiguration({
        ...common, jwks: { keys: [] },
    } as unknown as OfflineVerifierOptions);
    const services = new Map<WebBotAuthProfile, DirectoryService>();
    for (const profile of config.allowedProfiles) {
        services.set(profile, new DirectoryService({
            ...discoveryOptions,
            format: profile === "ietf-wg-protocol-00" ? "wg-directory-00" : "jwks",
        }, dependencies.transport, dependencies.discoveryClock));
    }
    const serviceFor = (profile: WebBotAuthProfile): DirectoryService => {
        const service = services.get(profile);
        if (!service) throw new ProfileConfigurationError("invalid-candidate-policy");
        return service;
    };
    const engine = createVerificationEngine(config, () => createNetworkStrategy(config, serviceFor));
    return Object.freeze({
        context: config.context,
        verify: engine.verify,
        refresh(origin: string, profile: WebBotAuthProfile) {
            return serviceFor(profile).refresh(origin);
        },
    });
}