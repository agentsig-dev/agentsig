import { createPublicKey, KeyObject, randomBytes } from "node:crypto";
import { parse, serialize } from "@agentsig/structured-fields";
import type { FieldType, Item } from "@agentsig/structured-fields";
import { SignatureConfigurationError, SignatureError } from "../errors.js";
import { resolveCoreLimits } from "../limits.js";
import { signatureInnerList, withSfErrors } from "../signature-input.js";
import type { CoveredComponent, LimitOverrides, Limits } from "../types.js";
import { canonicalAgentOrigin } from "./agent-origin.js";
import type { WebBotAuthProfile } from "./agent-header.js";
import { CandidateRejection, ProfileConfigurationError } from "./codes.js";
import { assertSupportedComponents, assertSupportedProfile, ProfileSupportRejection } from "./component-support.js";
import { resolveProfileLimits, resolveTimePolicy } from "./defaults.js";
import type { ProfileLimits, TimePolicy } from "./defaults.js";
import { ed25519Thumbprint, isKnownTestKey } from "./key-material.js";
import { SigningError } from "./signing-errors.js";
import type { SigningClock, SigningNonceGenerator } from "./signing-providers.js";

export interface SigningOptions {
    readonly privateKey: KeyObject;
    readonly agentOrigin: string;
    readonly profile?: WebBotAuthProfile;
    readonly label?: string;
    readonly allowTestKeys?: boolean;
    readonly clock?: SigningClock;
    readonly nonceGenerator?: SigningNonceGenerator;
    readonly timePolicy?: Partial<TimePolicy>;
    readonly limits?: Partial<ProfileLimits>;
    readonly coreLimits?: LimitOverrides;
    readonly additionalComponents?: readonly CoveredComponent[];
    readonly structuredFieldTypes?: Readonly<Record<string, FieldType>>;
}

export interface SigningConfiguration {
    readonly privateKey: KeyObject;
    readonly keyid: string;
    readonly profile: WebBotAuthProfile;
    readonly label: string;
    readonly agentHeader: string;
    readonly components: readonly CoveredComponent[];
    readonly fieldTypes: Readonly<Record<string, FieldType>>;
    readonly limits: Readonly<Limits>;
    readonly profileLimits: Readonly<ProfileLimits>;
    readonly lifetimeSeconds: number;
    readonly clock: SigningClock;
    readonly nonceGenerator: SigningNonceGenerator;
}

function invalid(): never {
    throw new SigningError("invalid-signing-options");
}

/** Trusted local objects only; reject accessors rather than running them. */
function dataRecord(input: unknown, allowed?: readonly string[]): Record<string, unknown> {
    if (!input || typeof input !== "object" || Array.isArray(input)) return invalid();
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const name of Reflect.ownKeys(input)) {
        if (typeof name !== "string" || (allowed && !allowed.includes(name))) return invalid();
        const descriptor = Object.getOwnPropertyDescriptor(input, name);
        if (!descriptor || !Object.hasOwn(descriptor, "value")) return invalid();
        result[name] = descriptor.value as unknown;
    }
    return result;
}

/** Only known failures are mapped; unexpected implementation errors propagate. */
export function signingFailure(error: unknown): never {
    if (error instanceof SigningError) throw error;
    if (error instanceof ProfileSupportRejection) {
        throw new SigningError(error.diagnostic.kind === "profile"
            ? "unsupported-profile" : "unsupported-component");
    }
    if (error instanceof SignatureConfigurationError || error instanceof ProfileConfigurationError) {
        throw new SigningError("invalid-signing-options");
    }
    if (error instanceof SignatureError) {
        throw new SigningError(error.reason === "resource-limit" ? "resource-limit"
            : error.reason === "unsupported" ? "unsupported-component" : "invalid-request");
    }
    throw error;
}

export function resolveSigningConfiguration(options: SigningOptions): SigningConfiguration {
    const own = dataRecord(options, [
        "privateKey", "agentOrigin", "profile", "label", "allowTestKeys",
        "clock", "nonceGenerator", "timePolicy", "limits", "coreLimits",
        "additionalComponents", "structuredFieldTypes",
    ]);
    try {
        const core = own.coreLimits === undefined ? {} : dataRecord(own.coreLimits);
        if (core.structuredFields !== undefined) core.structuredFields = dataRecord(core.structuredFields);
        const limits = resolveCoreLimits(core as LimitOverrides);
        const profileLimits = resolveProfileLimits(own.limits as Partial<ProfileLimits> | undefined);
        const time = resolveTimePolicy(own.timePolicy as Partial<TimePolicy> | undefined);
        const profile = own.profile === undefined ? "ietf-wg-protocol-00" : own.profile;
        if (typeof profile !== "string") throw new SigningError("unsupported-profile");
        assertSupportedProfile(profile);
        const label = own.label === undefined ? "sig1" : own.label;
        if (typeof label !== "string") throw new SigningError("invalid-label");
        if (label.length > limits.structuredFields.maxKeyLength) throw new SigningError("resource-limit");
        // Validate the SF key using the existing serializer rather than a second grammar.
        try {
            serialize({
                kind: "dictionary", entries: [[label, {
                    kind: "item", bare: { kind: "boolean", value: true }, parameters: [],
                }]]
            }, { limits: limits.structuredFields });
        } catch (error) {
            // withSfErrors preserves resource/configuration boundaries.
            try { withSfErrors(() => { throw error; }); }
            catch (mapped) {
                if (mapped instanceof SignatureError && mapped.reason === "malformed") {
                    throw new SigningError("invalid-label");
                }
                throw mapped;
            }
        }

        if (own.allowTestKeys !== undefined && typeof own.allowTestKeys !== "boolean") invalid();
        const privateKey = own.privateKey;
        if (!(privateKey instanceof KeyObject) || privateKey.type !== "private" ||
            privateKey.asymmetricKeyType !== "ed25519") {
            throw new SigningError("invalid-signing-key");
        }
        let publicJwk;
        try {
            // Export public material only: no private JWK/PEM copy is needed.
            publicJwk = createPublicKey(privateKey).export({ format: "jwk" });
        } catch {
            throw new SigningError("invalid-signing-key");
        }
        const keyid = ed25519Thumbprint(publicJwk);
        if (isKnownTestKey(keyid) && own.allowTestKeys !== true) {
            throw new SigningError("test-key-disallowed");
        }
        let origin: string;
        try {
            origin = canonicalAgentOrigin(own.agentOrigin, profileLimits.maxAgentUrlBytes);
        } catch (error) {
            if (error instanceof CandidateRejection) {
                throw new SigningError(error.rejection.reason === "resource-limit"
                    ? "resource-limit" : "invalid-agent-origin");
            }
            throw error;
        }

        const clock = own.clock === undefined ? () => Date.now() : own.clock;
        const nonceGenerator = own.nonceGenerator === undefined
            ? () => randomBytes(profileLimits.generatedNonceBytes).toString("base64url")
            : own.nonceGenerator;
        if (typeof clock !== "function" || typeof nonceGenerator !== "function") invalid();

        const agent: Item = { kind: "item", bare: { kind: "string", value: origin }, parameters: [] };
        const agentHeader = withSfErrors(() => serialize(profile === "ietf-wg-protocol-00"
            ? { kind: "dictionary", entries: [[label, agent]] } : agent,
            { limits: limits.structuredFields }));
        const components: CoveredComponent[] = [
            { name: "@method", parameters: [] },
            { name: "@target-uri", parameters: [] },
            {
                name: "signature-agent", parameters: profile === "ietf-wg-protocol-00"
                    ? [["key", { kind: "string", value: label }]] : []
            },
        ];
        const extras = own.additionalComponents;
        if (extras !== undefined) {
            if (!Array.isArray(extras)) invalid();
            if (components.length + extras.length > limits.maxComponentsPerSignature) {
                throw new SigningError("resource-limit");
            }
            // This is trusted configuration. SF round-trip validates and owns
            // the semantic values before any clock/nonce callback can run.
            for (const extra of extras) {
                const component = dataRecord(extra, ["name", "parameters"]);
                if (typeof component.name !== "string" || !Array.isArray(component.parameters)) invalid();
                components.push({
                    name: component.name,
                    parameters: component.parameters as CoveredComponent["parameters"],
                });
            }
        }
        const canonical = withSfErrors(() => serialize({
            kind: "dictionary",
            entries: [[label, signatureInnerList({ label, components, parameters: [] }, limits)]],
        }, { limits: limits.structuredFields }));
        const parsed = withSfErrors(() => parse(canonical, "dictionary", { limits: limits.structuredFields }));
        const inner = parsed.entries[0]![1];
        if (inner.kind !== "inner-list") throw new Error("Internal signing component invariant");
        const ownedComponents = inner.items.map((item): CoveredComponent => {
            if (item.bare.kind !== "string") throw new Error("Internal component name invariant");
            return { name: item.bare.value, parameters: item.parameters };
        });
        assertSupportedComponents({ label, components: ownedComponents, parameters: [] }, profile);

        const fieldTypes: Record<string, FieldType> = Object.create(null) as Record<string, FieldType>;
        if (own.structuredFieldTypes !== undefined) {
            for (const [name, value] of Object.entries(dataRecord(own.structuredFieldTypes))) {
                if (name !== name.toLowerCase() ||
                    (value !== "item" && value !== "list" && value !== "dictionary")) invalid();
                fieldTypes[name] = value;
            }
        }
        const agentType = profile === "ietf-wg-protocol-00" ? "dictionary" : "item";
        if (fieldTypes["signature-agent"] !== undefined && fieldTypes["signature-agent"] !== agentType) invalid();
        fieldTypes["signature-agent"] = agentType;
        return Object.freeze({
            privateKey, keyid, profile, label, agentHeader,
            components: Object.freeze(ownedComponents),
            fieldTypes: Object.freeze(fieldTypes), limits, profileLimits,
            lifetimeSeconds: time.signingLifetimeSeconds,
            clock: clock as SigningClock,
            nonceGenerator: nonceGenerator as SigningNonceGenerator,
        });
    } catch (error) {
        return signingFailure(error);
    }
}