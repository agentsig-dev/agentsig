import type { FieldType } from "@agentsig/structured-fields";
import type { CoveredComponent, LimitOverrides, RequestParts } from "../types.js";
import type { AgentBinding } from "./agent-bindings.js";
import type { WebBotAuthProfile } from "./agent-header.js";
import type { ProfileRejection, UnsignedCode, VerifiedCode } from "./codes.js";
import type { TimePolicy } from "./defaults.js";
import type { JwksFormat } from "./jwks-algorithm.js";
import type { NoncePolicy } from "./metadata.js";
import type { SecurityContext } from "./security-context.js";

/** Identity established only after all candidate gates have passed. */
export type VerifiedIdentity =
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

export type VerifiedCandidate<Identity extends { readonly thumbprint: string } = VerifiedIdentity> = {
    readonly status: "verified";
    readonly label: string;
    readonly profile: WebBotAuthProfile;
    readonly identity: Identity;
    /** Signed claim, not independently established operator ownership. */
    readonly claimedAgent: string;
    readonly coveredComponents: readonly CoveredComponent[];
    readonly verifiedAt: number;
} & (
        | { readonly reason: "nonce-consumed"; readonly replayProtected: true }
        | { readonly reason: "nonce-absent-optional"; readonly replayProtected: false }
    );

export type RejectedCandidate = ProfileRejection & {
    readonly label: string;
    readonly profile?: WebBotAuthProfile;
    /** Sanitized diagnostic; never an arbitrary provider/backend exception. */
    readonly message?: string;
};

export type CandidateResult<Identity extends { readonly thumbprint: string } = VerifiedIdentity> =
    VerifiedCandidate<Identity> | RejectedCandidate;

/**
 * Exactly the four approved external states. Pre-replay eligibility is an
 * internal implementation detail and can never be returned as verified.
 *
 * All selected candidates remain in header order, including rejected ones.
 * A failed aggregate may contain a successful candidate; that does not grant
 * aggregate acceptance or put an identity on the failed aggregate itself.
 */
export type VerificationResult<Identity extends { readonly thumbprint: string } = VerifiedIdentity> =
    | {
        readonly status: "unsigned";
        readonly reason: UnsignedCode;
        readonly candidates: readonly [];
    }
    | {
        readonly status: "verified";
        readonly reason: VerifiedCode;
        readonly candidates: readonly CandidateResult<Identity>[];
        readonly verifiedCandidates: readonly [VerifiedCandidate<Identity>, ...VerifiedCandidate<Identity>[]];
    }
    | (ProfileRejection & {
        readonly candidates: readonly CandidateResult<Identity>[];
        readonly message?: string;
    });

export type CandidatePolicy =
    | { readonly mode: "exactly-one" }
    | { readonly mode: "multiple"; readonly aggregate?: "all" | "any" };

export interface VerificationProfilePolicy {
    readonly timePolicy?: Partial<TimePolicy>;
    readonly noncePolicy?: NoncePolicy;
}

export interface OfflineVerifierOptions {
    /** Trusted local PUBLIC JWKS, not keys obtained from the incoming request. */
    readonly jwks: unknown;
    readonly jwksFormat?: JwksFormat;
    /**
     * Explicit local replay namespace. Never inferred from request claims.
     * Verifiers in one trust domain should share both context and scope.
     */
    readonly scope: string;
    /** If absent, create one memory-backed context for this verifier instance. */
    readonly context?: SecurityContext;
    readonly candidatePolicy?: CandidatePolicy;
    readonly allowedProfiles?: readonly WebBotAuthProfile[];
    readonly profiles?: Readonly<Partial<Record<WebBotAuthProfile, VerificationProfilePolicy>>>;
    readonly bindings?: readonly AgentBinding[];
    readonly identityMode?: "key-thumbprint" | "directory-url";
    readonly allowTestKeys?: boolean;
    readonly coreLimits?: LimitOverrides;
    readonly structuredFieldTypes?: Readonly<Record<string, FieldType>>;
}

export interface OfflineVerifier {
    /** Share this context on key rotation; replacing keys must not erase replay history. */
    readonly context: SecurityContext;
    verify(request: RequestParts): Promise<VerificationResult>;
}