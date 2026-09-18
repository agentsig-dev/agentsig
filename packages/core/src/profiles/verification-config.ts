import type { FieldType } from "@agentsig/structured-fields";
import { SignatureConfigurationError } from "../errors.js";
import { resolveCoreLimits } from "../limits.js";
import type { LimitOverrides, Limits } from "../types.js";
import { createAgentBindings } from "./agent-bindings.js";
import type { AgentBinding, AgentBindings } from "./agent-bindings.js";
import { WEB_BOT_AUTH_PROFILES } from "./agent-header.js";
import type { WebBotAuthProfile } from "./agent-header.js";
import { ProfileConfigurationError } from "./codes.js";
import type { ConfigurationCode } from "./codes.js";
import type { ProfileLimits, TimePolicy } from "./defaults.js";
import { loadJwks } from "./jwks.js";
import type { LoadedJwks } from "./jwks.js";
import type { JwksFormat } from "./jwks-algorithm.js";
import type { NoncePolicy } from "./metadata.js";
import { createSecurityContext, securityContextInternals } from "./security-context.js";
import type { SecurityContext } from "./security-context.js";
import type { SecurityContextController } from "./security-context-controller.js";
import { createSignatureTimePolicy } from "./time-policy.js";
import type { SignatureTimePolicy } from "./time-policy.js";
import type { OfflineVerifierOptions } from "./verification-types.js";

export interface ResolvedVerificationProfile {
    readonly time: SignatureTimePolicy;
    readonly noncePolicy: NoncePolicy;
}

export interface VerificationConfiguration {
    readonly context: SecurityContext;
    readonly controller: SecurityContextController;
    readonly limits: Readonly<ProfileLimits>;
    readonly coreLimits: Readonly<Limits>;
    readonly jwks: LoadedJwks;
    readonly scope: string;
    readonly candidateMode: "exactly-one" | "multiple";
    readonly aggregate: "all" | "any";
    readonly allowedProfiles: readonly WebBotAuthProfile[];
    readonly profiles: Readonly<Record<WebBotAuthProfile, ResolvedVerificationProfile>>;
    readonly bindings: AgentBindings;
    readonly requireBinding: boolean;
    readonly allowTestKeys: boolean;
    readonly fieldTypes: Readonly<Record<string, FieldType>>;
}

function invalid(code: ConfigurationCode): never {
    throw new ProfileConfigurationError(code);
}

/** Trusted local configuration only; never execute option getters. */
function record(
    input: unknown,
    code: ConfigurationCode,
    allowed?: readonly string[],
): Record<string, unknown> {
    if (!input || typeof input !== "object" || Array.isArray(input)) return invalid(code);
    const result = Object.create(null) as Record<string, unknown>;
    for (const name of Reflect.ownKeys(input)) {
        if (typeof name !== "string" || (allowed && !allowed.includes(name))) return invalid(code);
        const descriptor = Object.getOwnPropertyDescriptor(input, name);
        if (!descriptor || !Object.hasOwn(descriptor, "value")) return invalid(code);
        result[name] = descriptor.value as unknown;
    }
    return result;
}

export function resolveVerificationConfiguration(
    options: OfflineVerifierOptions,
): VerificationConfiguration {
    const own = record(options, "invalid-candidate-policy", [
        "jwks", "jwksFormat", "scope", "context", "candidatePolicy",
        "allowedProfiles", "profiles", "bindings", "identityMode",
        "allowTestKeys", "coreLimits", "structuredFieldTypes",
    ]);
    const context = own.context === undefined ? createSecurityContext() : own.context as SecurityContext;
    const { controller, limits } = securityContextInternals(context);
    const scope = own.scope;
    // Scope is an explicit application namespace, never a remote URL/label.
    if (typeof scope !== "string" || !scope.length ||
        scope.length > limits.maxScopeBytes || /[^\x00-\x7f]/.test(scope)) {
        invalid("invalid-replay-policy");
    }
    const candidate = own.candidatePolicy === undefined ? { mode: "exactly-one" }
        : record(own.candidatePolicy, "invalid-candidate-policy", ["mode", "aggregate"]);
    if (candidate.mode !== "exactly-one" && candidate.mode !== "multiple") {
        invalid("invalid-candidate-policy");
    }
    const aggregate = Object.hasOwn(candidate, "aggregate")
        ? (candidate as Record<string, unknown>).aggregate : undefined;
    if ((candidate.mode === "exactly-one" && aggregate !== undefined) ||
        (aggregate !== undefined && aggregate !== "all" && aggregate !== "any")) {
        invalid("invalid-candidate-policy");
    }
    const allowed = own.allowedProfiles === undefined ? WEB_BOT_AUTH_PROFILES : own.allowedProfiles;
    if (!Array.isArray(allowed) || allowed.length > WEB_BOT_AUTH_PROFILES.length) {
        invalid("invalid-candidate-policy");
    }
    const allowedProfiles: WebBotAuthProfile[] = [];
    for (let index = 0; index < allowed.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(allowed, String(index));
        const value: unknown = descriptor?.value;
        if (!descriptor || !Object.hasOwn(descriptor, "value") ||
            !WEB_BOT_AUTH_PROFILES.includes(value as WebBotAuthProfile) ||
            allowedProfiles.includes(value as WebBotAuthProfile)) {
            invalid("invalid-candidate-policy");
        }
        allowedProfiles.push(value as WebBotAuthProfile);
    }
    const suppliedProfiles = own.profiles === undefined ? {}
        : record(own.profiles, "invalid-candidate-policy", WEB_BOT_AUTH_PROFILES);
    const profiles = Object.create(null) as Record<WebBotAuthProfile, ResolvedVerificationProfile>;
    for (const profile of WEB_BOT_AUTH_PROFILES) {
        const value = (suppliedProfiles as Record<string, unknown>)[profile];
        const settings = value === undefined ? {}
            : record(value, "invalid-candidate-policy", ["timePolicy", "noncePolicy"]);
        const noncePolicy = settings.noncePolicy === undefined ? "required" : settings.noncePolicy;
        if (noncePolicy !== "required" && noncePolicy !== "optional") invalid("invalid-replay-policy");
        profiles[profile] = Object.freeze({
            time: createSignatureTimePolicy(settings.timePolicy as Partial<TimePolicy> | undefined),
            noncePolicy,
        });
    }
    if (own.identityMode !== undefined &&
        own.identityMode !== "key-thumbprint" && own.identityMode !== "directory-url") {
        invalid("invalid-agent-binding");
    }
    if (own.allowTestKeys !== undefined && typeof own.allowTestKeys !== "boolean") {
        invalid("invalid-key-configuration");
    }

    let coreLimits: Readonly<Limits>;
    try {
        const core = own.coreLimits === undefined ? {}
            : record(own.coreLimits, "invalid-resource-limits");
        if (core.structuredFields !== undefined) {
            core.structuredFields = record(core.structuredFields, "invalid-resource-limits");
        }
        coreLimits = resolveCoreLimits(core as LimitOverrides);
    } catch (error) {
        if (error instanceof SignatureConfigurationError) invalid("invalid-resource-limits");
        throw error;
    }
    const fieldTypes = Object.create(null) as Record<string, FieldType>;
    if (own.structuredFieldTypes !== undefined) {
        for (const [name, value] of Object.entries(
            record(own.structuredFieldTypes, "invalid-candidate-policy"),
        )) {
            // The agent grammar depends on the detected profile, never on an
            // application override that could change what is authenticated.
            if (name === "signature-agent" || name !== name.toLowerCase() ||
                (value !== "item" && value !== "list" && value !== "dictionary")) {
                invalid("invalid-candidate-policy");
            }
            fieldTypes[name] = value;
        }
    }
    const jwks = loadJwks(own.jwks, {
        limits,
        ...(own.jwksFormat === undefined ? {} : { format: own.jwksFormat as JwksFormat }),
    });
    const bindings = createAgentBindings(own.bindings as readonly AgentBinding[] | undefined, limits);
    return Object.freeze({
        context, controller, limits, coreLimits, jwks, scope,
        candidateMode: candidate.mode,
        aggregate: aggregate ?? "all",
        allowedProfiles: Object.freeze(allowedProfiles),
        profiles: Object.freeze(profiles), bindings,
        requireBinding: own.identityMode === "directory-url",
        allowTestKeys: own.allowTestKeys === true,
        fieldTypes: Object.freeze(fieldTypes),
    });
}