import type { RequestParts } from "../types.js";
import type { HttpMappingErrorCode } from "./errors.js";

export interface HttpMappingLimits {
    readonly maxHeaderBytes: number;
    readonly maxTargetUriBytes: number;
}

export type HttpIngress =
    | {
        readonly mode?: "direct";
        readonly allowedOrigins: readonly string[];
    }
    | {
        readonly mode: "trusted-ingress";
        readonly family: "forwarded" | "x-forwarded";
        readonly allowedOrigins: readonly string[];
        readonly trustedPeers: readonly string[];
        /** Operator assertion, not attestation of proxy behavior. */
        readonly sanitizingIngress: true;
    };

export interface HttpMapperOptions {
    readonly ingress: HttpIngress;
    readonly limits?: Partial<HttpMappingLimits>;
}

/** Unauthenticated ingress assertion; not verified identity or socket peer. */
export interface ObservedClient {
    readonly kind: "ip" | "unknown" | "obfuscated";
    readonly address: string;
    readonly port?: string;
    readonly source: "trusted-ingress";
    readonly authenticated: false;
}

export interface MappedHttpRequest {
    readonly status: "mapped";
    readonly request: Readonly<RequestParts>;
    readonly targetSource: "direct" | "trusted-ingress";
    readonly internalAuthority: string;
    readonly bodyPresent: boolean;
    readonly observedClient?: ObservedClient;
}

export interface RejectedHttpMapping {
    readonly status: "mapping-rejected";
    readonly code: HttpMappingErrorCode;
}

export type HttpMappingResult = MappedHttpRequest | RejectedHttpMapping;

/** Internal, pre-framework descriptor. Never accepted as public capture proof. */
export interface HttpSnapshot {
    readonly method: string;
    readonly url: string;
    readonly httpVersion: string;
    readonly rawHeaders: readonly string[];
    readonly peerAddress: string | undefined;
    readonly encrypted: boolean;
}