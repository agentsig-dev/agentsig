import type { FieldType, Limits as SfLimits, Parameters } from "@agentsig/structured-fields";

/**
 * Strings represent ASCII field values, not an implicit UTF-8 wire encoding.
 * Supply bytes when a field contains obs-text and is covered using `bs`.
 * Preserve occurrences and order; do not pre-collapse Set-Cookie-like fields.
 */
export type HeaderField = readonly [name: string, value: string | Uint8Array];
export type HeaderFields = readonly HeaderField[];

export interface RequestParts {
    readonly method: string;
    /** Externally observed absolute HTTP(S) target URI, without a fragment. */
    readonly targetUri: string;
    /** Required when covering @request-target; never guessed from targetUri. */
    readonly rawRequestTarget?: string;
    readonly headers: HeaderFields;
    /** Only explicit HTTP/1.1 context permits removal of obsolete line folding. */
    readonly httpVersion?: "1.1" | "2" | "3";
}

export type HttpMessage =
    | { readonly kind: "request"; readonly request: RequestParts }
    | {
        readonly kind: "response";
        readonly status: number;
        readonly headers: HeaderFields;
        readonly httpVersion?: "1.1" | "2" | "3";
        readonly request?: RequestParts;
    };

export interface CoveredComponent {
    readonly name: string;
    readonly parameters: Parameters;
}

export interface SignatureInput {
    readonly label: string;
    readonly components: readonly CoveredComponent[];
    readonly parameters: Parameters;
}

export interface ParsedSignature {
    readonly input: SignatureInput;
    readonly signature: Uint8Array;
}

/**
 * Core resource limits are application policy, not RFC maximum sizes.
 * SF calls always receive the explicitly resolved core SF budget.
 */
export interface Limits {
    readonly maxSignatureHeaderBytes: number;
    readonly maxSignatures: number;
    readonly maxComponentsPerSignature: number;
    readonly maxParameters: number;
    readonly maxMessageHeaderBytes: number;
    readonly maxTargetUriBytes: number;
    readonly maxSignatureBaseBytes: number;
    readonly structuredFields: Readonly<SfLimits>;
}

export type LimitOverrides =
    Partial<Omit<Limits, "structuredFields">> & {
        readonly structuredFields?: Partial<SfLimits>;
    };

export interface CanonicalizationOptions {
    readonly limits?: LimitOverrides;
    /** Lowercase field names; `key` requires a known Dictionary field. */
    readonly structuredFieldTypes?: Readonly<Record<string, FieldType>>;
}

export interface SignatureBase {
    readonly text: string;
    readonly bytes: Uint8Array;
}

/** Values for one label; applying/merging them is an explicit caller operation. */
export interface SignatureHeaderPatch {
    readonly label: string;
    readonly signatureInput: string;
    readonly signature: string;
}

export type RejectionReason =
    | "malformed"
    | "unsupported"
    | "missing-component"
    | "invalid-key"
    | "algorithm-mismatch"
    | "signature-mismatch"
    | "resource-limit";

/**
 * Pure cryptographic result, NOT Web Bot Auth authentication or authorization.
 * No key discovery, clock, nonce, body-digest verification, or trust decision.
 */
export type CryptoVerification =
    | { readonly status: "signature-valid"; readonly input: SignatureInput }
    | { readonly status: "rejected"; readonly reason: RejectionReason };

export type { Parameters } from "@agentsig/structured-fields";