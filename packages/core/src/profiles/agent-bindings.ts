import { Buffer } from "node:buffer";
import { CandidateRejection, ProfileConfigurationError } from "./codes.js";
import { configuredAgentOrigin, canonicalAgentOrigin } from "./agent-origin.js";
import { resolveProfileLimits } from "./defaults.js";
import type { ProfileLimits } from "./defaults.js";

export interface AgentBinding {
    readonly thumbprint: string;
    readonly origin: string;
}

/**
 * Internal identity proposal only. The verifier must not expose it as verified
 * until cryptography, time, test-key policy and replay checks all succeed.
 */
export type LocalIdentityProposal =
    | {
        readonly identityKind: "key-thumbprint";
        readonly thumbprint: string;
    }
    | {
        readonly identityKind: "directory-url";
        readonly thumbprint: string;
        readonly canonicalOrigin: string;
        readonly directoryUrl: string;
        readonly trustSource: "local-configuration";
    };

export interface AgentBindings {
    readonly entries: readonly AgentBinding[];
    proposeIdentity(
        selectedThumbprint: string,
        signedAgentClaim: string,
        requireBinding: boolean,
    ): LocalIdentityProposal;
}

function invalid(): never {
    throw new ProfileConfigurationError("invalid-agent-binding");
}

function dataProperty(object: object, name: string): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(object, name);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) return invalid();
    return descriptor.value as unknown;
}

function validThumbprint(value: unknown): value is string {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
    // Canonical encoding prevents aliases through nonzero base64url pad bits.
    const bytes = Buffer.from(value, "base64url");
    return bytes.length === 32 && bytes.toString("base64url") === value;
}

/**
 * Explicit local key-to-origin associations; never inferred from a request.
 * No key discovery, DNS, TLS proof or operator-name inference occurs here.
 *
 * Snapshot and normalize each association once. Different spellings of the
 * same origin produce one association for the same thumbprint. Count input
 * occurrences before deduplication so repetition cannot bypass the budget.
 * Explicit associations may bind a rotated key to the same origin; replay
 * storage is independent and must not be cleared by changing this snapshot.
 */
export function createAgentBindings(
    input: readonly AgentBinding[] = [],
    overrides?: Partial<ProfileLimits>,
): AgentBindings {
    const limits = resolveProfileLimits(overrides);
    if (!Array.isArray(input) || input.length > limits.maxAgentBindings) invalid();
    const entries: AgentBinding[] = [];
    for (let index = 0; index < input.length; index++) {
        const value = dataProperty(input, String(index));
        if (value === null || typeof value !== "object" || Array.isArray(value)) invalid();
        const prototype: unknown = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) invalid();
        for (const name of Reflect.ownKeys(value)) {
            if (name !== "thumbprint" && name !== "origin") invalid();
        }
        const thumbprint = dataProperty(value, "thumbprint");
        if (!validThumbprint(thumbprint)) invalid();
        const origin = configuredAgentOrigin(
            dataProperty(value, "origin"), limits.maxAgentUrlBytes,
        );
        if (!entries.some((entry) =>
            entry.thumbprint === thumbprint && entry.origin === origin)) {
            entries.push(Object.freeze({ thumbprint, origin }));
        }
    }

    const owned = Object.freeze(entries);
    return Object.freeze({
        entries: owned,
        proposeIdentity(
            selectedThumbprint: string,
            signedAgentClaim: string,
            requireBinding: boolean,
        ): LocalIdentityProposal {
            // This parameter must come from trusted key selection, not an
            // unvalidated keyid. Validate its representation defensively.
            if (!validThumbprint(selectedThumbprint) || typeof requireBinding !== "boolean") {
                return invalid();
            }
            const origin = canonicalAgentOrigin(signedAgentClaim, limits.maxAgentUrlBytes);
            if (!requireBinding) {
                // Merely supplying keys or a URL claim does not enable domain
                // identity. The caller must explicitly select binding mode.
                return Object.freeze({
                    identityKind: "key-thumbprint", thumbprint: selectedThumbprint,
                });
            }
            const associated = owned.filter((entry) => entry.thumbprint === selectedThumbprint);
            if (!associated.length) {
                throw new CandidateRejection({
                    status: "unverified", reason: "agent-binding-missing",
                });
            }
            if (!associated.some((entry) => entry.origin === origin)) {
                throw new CandidateRejection({
                    status: "invalid", reason: "agent-binding-mismatch",
                });
            }
            return Object.freeze({
                identityKind: "directory-url",
                thumbprint: selectedThumbprint,
                canonicalOrigin: origin,
                directoryUrl: `${origin}/.well-known/http-message-signatures-directory`,
                trustSource: "local-configuration",
            });
        },
    });
}