import type { IncomingMessage } from "node:http";
import type { RequestParts } from "../types.js";
import type { VerificationResult, VerifiedIdentity } from "../profiles/verification-types.js";
import type { HttpMappingErrorCode } from "./errors.js";
import type { NodeHttpMapper } from "./node-mapper.js";
import type { MappedHttpRequest, RejectedHttpMapping } from "./types.js";

export type HttpAdapterName = "express" | "fastify" | "hono";

export interface HttpRequestVerifier<I extends { readonly thumbprint: string } = VerifiedIdentity> {
    verify(request: RequestParts): Promise<VerificationResult<I>>;
}

export type HttpAssessment<I extends { readonly thumbprint: string } = VerifiedIdentity> =
    | (MappedHttpRequest & {
        readonly verification: VerificationResult<I>;
        readonly bodyIntegrity: "unverified";
    })
    | (RejectedHttpMapping & { readonly bodyIntegrity: "unverified" });

export type VerifiedHttpAssessment<I extends { readonly thumbprint: string } = VerifiedIdentity> =
    MappedHttpRequest & {
        readonly verification: Extract<VerificationResult<I>, { status: "verified" }>;
        readonly bodyIntegrity: "unverified";
    };

export type HttpAuthorization =
    | { readonly status: "not-evaluated" }
    | { readonly status: "allowed"; readonly basis: "verified-identity" | "anonymous" }
    | { readonly status: "denied" }
    | { readonly status: "rate-limited"; readonly retryAfterSeconds?: number };

export interface AgentSigContext<I extends { readonly thumbprint: string } = VerifiedIdentity> {
    readonly assessment: HttpAssessment<I>;
    readonly authorization: HttpAuthorization;
}

declare const decisionBrand: unique symbol;
export interface HttpPolicyDecision {
    readonly [decisionBrand]: true;
}

export interface HttpPolicyTools<I extends { readonly thumbprint: string } = VerifiedIdentity> {
    readonly signal: AbortSignal;
    allowVerified(assessment: VerifiedHttpAssessment<I>): HttpPolicyDecision;
    allowAnonymous(): HttpPolicyDecision;
    deny(): HttpPolicyDecision;
    rateLimit(retryAfterSeconds?: number): HttpPolicyDecision;
}

export type HttpPolicyHook<I extends { readonly thumbprint: string } = VerifiedIdentity> = (
    assessment: HttpAssessment<I>,
    tools: HttpPolicyTools<I>,
) => HttpPolicyDecision | Promise<HttpPolicyDecision>;

export type HttpAdapterEvent =
    | {
        readonly type: "mapping-rejected";
        readonly code: HttpMappingErrorCode;
        readonly adapter: HttpAdapterName;
        readonly ingress: "direct" | "trusted-ingress";
    }
    | {
        readonly type: "policy-denied";
        readonly reason: "error" | "timeout" | "invalid-decision" | "body-unverified";
        readonly adapter: HttpAdapterName;
        readonly ingress: "direct" | "trusted-ingress";
    }
    | {
        readonly type: "framework-conversion-failed";
        readonly adapter: "hono";
        readonly mapping:
        | { readonly status: "mapped" }
        | { readonly status: "mapping-rejected"; readonly code: HttpMappingErrorCode };
    }
    | {
        readonly type: "verification-error";
        readonly adapter: HttpAdapterName;
        readonly ingress: "direct" | "trusted-ingress";
    };

export type HttpAgentSigOptions<I extends { readonly thumbprint: string } = VerifiedIdentity> = {
    readonly mapper: NodeHttpMapper;
    readonly verifier: HttpRequestVerifier<I>;
    /** Synchronous observer; enqueue sanitized events rather than doing I/O here. */
    readonly onEvent?: (event: Readonly<HttpAdapterEvent>) => void;
} & (
        | { readonly mode: "observe" }
        | {
            readonly mode: "enforce";
            readonly policy: HttpPolicyHook<I>;
            readonly bodyPolicy?: "reject" | "allow-unverified";
            readonly policyTimeoutMilliseconds?: number;
            readonly mappingFailureStatus?: number;
            readonly denyStatus?: number;
            readonly rateLimitStatus?: number;
        }
    );

export interface HttpAdapterOutcome<I extends { readonly thumbprint: string } = VerifiedIdentity> {
    readonly context: AgentSigContext<I>;
    readonly action: "continue" | "respond";
    readonly responseStatus?: number;
    readonly retryAfterSeconds?: number;
}

export interface HttpAgentSig<I extends { readonly thumbprint: string } = VerifiedIdentity> {
    readonly mapper: NodeHttpMapper;
    assess(request: IncomingMessage, adapter: HttpAdapterName): Promise<HttpAdapterOutcome<I>>;
    /** Requires completed assessment owned by this compatible integration. */
    get(request: IncomingMessage): AgentSigContext<I>;
}