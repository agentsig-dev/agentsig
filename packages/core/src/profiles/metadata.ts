import { Buffer } from "node:buffer";
import { KeyObject } from "node:crypto";
import { getParameter } from "@agentsig/structured-fields";
import type { Parameters } from "@agentsig/structured-fields";
import { CandidateRejection, ProfileConfigurationError } from "./codes.js";
import type { InvalidCode } from "./codes.js";
import { DEFAULT_PROFILE_LIMITS } from "./defaults.js";
import { ed25519Thumbprint } from "./key-material.js";
import { isValidNonce } from "./nonce.js";

export type NoncePolicy = "required" | "optional";

export interface CandidateMetadata {
    readonly created: number;
    readonly expires: number;
    readonly keyid: string;
    readonly algorithm: string | undefined;
    readonly nonce: string | undefined;
}

/** Fixed diagnostic text only; never include supplied metadata values. */
export class MetadataRejection extends CandidateRejection {
    readonly rule: string;

    constructor(reason: InvalidCode, rule: string) {
        super({ status: "invalid", reason });
        this.rule = rule;
        this.message = `Web Bot Auth metadata rejected: ${reason}; ${rule}`;
    }
}

/**
 * WG-00 §5.2 and Cloudflare §4.2 require SHA-256 JWK thumbprints.
 * Generic RFC 9421 keyid is only a String; do not impose this rule on M1.
 * Reject noncanonical pad bits so one identity cannot have multiple spellings.
 */
export function validateProfileKeyId(value: unknown): string {
    if (typeof value !== "string") {
        throw new MetadataRejection("malformed-signature", "keyid must be an SF String");
    }
    if (/[^A-Za-z0-9_-]/.test(value)) {
        throw new MetadataRejection("invalid-parameter", "keyid must use unpadded base64url");
    }
    // A 32-byte unpadded encoding has exactly 43 characters. Bound decoding
    // before allocation; incoming field text is already bounded by core.
    if (value.length !== 43) {
        throw new MetadataRejection("invalid-parameter", "keyid must decode to exactly 32 bytes");
    }
    const bytes = Buffer.from(value, "base64url");
    if (bytes.length !== 32) {
        throw new MetadataRejection("invalid-parameter", "keyid must decode to exactly 32 bytes");
    }
    if (bytes.toString("base64url") !== value) {
        throw new MetadataRejection("invalid-parameter", "keyid must use canonical base64url encoding");
    }
    return value;
}

/**
 * Internal gate AFTER M1 all-pairs parsing and tag selection.
 * Wrong wire types normally fail earlier for the entire request; defensive
 * checks here preserve that classification for internally constructed input.
 * Do not use this helper to bypass raw duplicate or all-pairs validation.
 *
 * Missing/different tags are handled by candidate selection, not as missing
 * required metadata. Unknown parameters remain signed but gain no semantics.
 * Numeric time ranges/windows are checked by the separate time policy.
 */
export function readCandidateMetadata(
    parameters: Parameters,
    noncePolicy: NoncePolicy = "required",
    maxNonceBytes: number = DEFAULT_PROFILE_LIMITS.maxNonceBytes,
): CandidateMetadata {
    if (noncePolicy !== "required" && noncePolicy !== "optional") {
        throw new ProfileConfigurationError("invalid-replay-policy");
    }
    if (!Number.isSafeInteger(maxNonceBytes) || maxNonceBytes < 0) {
        throw new ProfileConfigurationError("invalid-resource-limits");
    }
    const created = getParameter(parameters, "created");
    const expires = getParameter(parameters, "expires");
    const keyid = getParameter(parameters, "keyid");
    for (const [name, value] of [
        ["created", created], ["expires", expires], ["keyid", keyid],
    ] as const) {
        if (value === undefined) {
            throw new MetadataRejection("missing-required-parameter", `${name} is required`);
        }
    }
    if (created?.kind !== "integer" || expires?.kind !== "integer") {
        throw new MetadataRejection("malformed-signature", "created and expires must be SF Integers");
    }
    if (keyid?.kind !== "string") {
        throw new MetadataRejection("malformed-signature", "keyid must be an SF String");
    }
    const identity = validateProfileKeyId(keyid.value);
    const algorithm = getParameter(parameters, "alg");
    if (algorithm !== undefined && algorithm.kind !== "string") {
        throw new MetadataRejection("malformed-signature", "alg must be an SF String");
    }
    const nonce = getParameter(parameters, "nonce");
    if (nonce !== undefined && nonce.kind !== "string") {
        throw new MetadataRejection("malformed-signature", "nonce must be an SF String");
    }
    if (nonce === undefined && noncePolicy === "required") {
        throw new MetadataRejection("nonce-required", "nonce is required by local policy");
    }
    if (nonce !== undefined && !isValidNonce(nonce.value, maxNonceBytes)) {
        throw new MetadataRejection("nonce-invalid", "nonce must be nonempty printable ASCII within maxNonceBytes");
    }
    return Object.freeze({
        created: created.value,
        expires: expires.value,
        keyid: identity,
        algorithm: algorithm?.value,
        nonce: nonce?.value,
    });
}

/**
 * Defensive binding of a selected trusted Ed25519 key to the signed keyid.
 * Normal loadJwks lookup already selects by recomputed thumbprint; a mismatch
 * here is not the same as an unknown key and must never trigger another lookup.
 * This proves key identity only, not signature validity or domain ownership.
 */
export function assertSelectedKeyIdentity(keyid: string, publicKey: KeyObject): string {
    const identity = validateProfileKeyId(keyid);
    if (!(publicKey instanceof KeyObject) || publicKey.type !== "public" ||
        publicKey.asymmetricKeyType !== "ed25519") {
        throw new ProfileConfigurationError("invalid-key-configuration");
    }
    let jwk;
    try {
        jwk = publicKey.export({ format: "jwk" });
    } catch {
        throw new ProfileConfigurationError("invalid-key-configuration");
    }
    const recomputed = ed25519Thumbprint(jwk);
    if (identity !== recomputed) {
        throw new MetadataRejection("key-id-mismatch", "keyid must match the selected public key thumbprint");
    }
    return recomputed;
}
