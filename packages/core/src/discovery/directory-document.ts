import { ProfileConfigurationError } from "../profiles/codes.js";
import { loadJwks } from "../profiles/jwks.js";
import type { LoadedJwks } from "../profiles/jwks.js";
import type { JwksFormat } from "../profiles/jwks-algorithm.js";
import { InvalidJwksError } from "../profiles/jwks-error.js";

/** Sanitized operational detail; no remote labels or key component values. */
export interface DirectoryDocumentDiagnostic {
    readonly rule: string;
    readonly keyIndex?: number;
}

/** Internal discovery diagnostic, not an operator configuration exception. */
export class DirectoryDocumentError extends Error {
    readonly reason = "invalid-jwks" as const;
    readonly diagnostic: Readonly<DirectoryDocumentDiagnostic>;

    constructor(diagnostic?: DirectoryDocumentDiagnostic) {
        super("Directory document rejected");
        this.name = "DirectoryDocumentError";
        this.diagnostic = Object.freeze({
            rule: diagnostic?.rule ?? "directory must contain bounded valid public JWKS",
            ...(diagnostic?.keyIndex === undefined ? {} : { keyIndex: diagnostic.keyIndex }),
        });
    }
}

export interface DirectoryDocument {
    readonly format: JwksFormat;
    readonly jwks: LoadedJwks;
    readonly bodyBytes: number;
    /** Accounting budget, not a claim about exact JavaScript/native heap size. */
    readonly accountedBytes: number;
}

const ownedDocuments = new WeakSet<object>();

/**
 * INTERNAL: validate untrusted response bytes, never request-supplied objects.
 * The format is chosen by trusted profile configuration, not inferred from alg
 * or retried after failure. Transport origin evidence is established elsewhere.
 *
 * Reuse the local loader's bounded structural/material checks only. Do not
 * create a local agent binding or attach local-configuration trust to the result.
 * Every entry must pass policy before returning any document. Unsupported keys
 * remain nonselectable under the existing explicitly approved loader policy.
 */
export function parseDirectoryDocument(
    body: Uint8Array,
    format: JwksFormat,
): DirectoryDocument {
    if (format !== "jwks" && format !== "wg-directory-00") {
        throw new ProfileConfigurationError("invalid-agent-binding");
    }
    try {
        if (!(body instanceof Uint8Array) || body.byteLength > 262144) {
            throw new DirectoryDocumentError();
        }
        // Own the bytes before interpretation; caller mutation cannot change a
        // validated set. Nothing retains the remote body after this call.
        const bytes = Uint8Array.from(body);
        const jwks = loadJwks(bytes, {
            format,
            limits: { maxJwksBytes: 262144, maxKeys: 64 },
        });
        const document: DirectoryDocument = Object.freeze({
            format,
            jwks,
            bodyBytes: bytes.byteLength,
            // Charge encoded representation plus fixed per-entry/record budgets.
            // Cache entry count independently bounds empty/very small documents.
            accountedBytes: bytes.byteLength + 1024 +
                (jwks.keys.length + jwks.skipped.length) * 1024,
        });
        ownedDocuments.add(document);
        return document;
    } catch (error) {
        // Only this owned loader's implementation-authored rule and bounded
        // entry index may cross the remote diagnostic boundary. Never copy
        // its message, kid, stack, cause, or complete diagnostic object.
        // Remote invalid-jwks remains operational, not caller misconfiguration.
        if (error instanceof InvalidJwksError) {
            const index = error.diagnostic.keyIndex;
            throw new DirectoryDocumentError({
                rule: error.diagnostic.rule,
                ...(index !== undefined && Number.isInteger(index) && index >= 0 && index < 64
                    ? { keyIndex: index } : {}),
            });
        }
        throw new DirectoryDocumentError();
    }
}

/** Prevent fabricated partially validated sets from entering the internal cache. */
export function assertDirectoryDocument(document: DirectoryDocument): void {
    if (!document || typeof document !== "object" || !ownedDocuments.has(document)) {
        throw new DirectoryDocumentError();
    }
}