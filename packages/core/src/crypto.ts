import { KeyObject, sign, verify } from "node:crypto";
import { serialize } from "@agentsig/structured-fields";
import { SignatureError } from "./errors.js";
import { checkLimit, resolveCoreLimits } from "./limits.js";
import { createSignatureBase } from "./signature-base.js";
import { signatureInnerList, withSfErrors } from "./signature-input.js";
import type {
    CanonicalizationOptions,
    CryptoVerification,
    HttpMessage,
    ParsedSignature,
    SignatureHeaderPatch,
    SignatureInput,
} from "./types.js";

function requireKey(key: KeyObject, type: "private" | "public"): void {
    // Do not auto-import strings or silently derive a public key from a private
    // key on the verifier path. Algorithm and key purpose are explicit.
    if (!(key instanceof KeyObject) || key.type !== type || key.asymmetricKeyType !== "ed25519") {
        throw new SignatureError("invalid-key");
    }
}

function requireAlgorithm(input: SignatureInput): void {
    const algorithm = input.parameters.find(([name]) => name === "alg")?.[1];
    if (
        algorithm !== undefined &&
        (algorithm.kind !== "string" || algorithm.value !== "ed25519")
    ) {
        // RFC 9421 §3.2 step 6.5: declared and key-derived algorithms must agree.
        throw new SignatureError("algorithm-mismatch");
    }
}

/**
 * RFC 9421 §3.3.6: Ed25519 signs the signature-base bytes with NO prehash.
 * Returns one label's header values; never mutates/overwrites message headers.
 * The Promise API permits future asynchronous providers. This Node primitive
 * runs synchronously on bounded input, with no await between validation and use,
 * so caller mutation cannot change descriptors across an asynchronous boundary.
 */
export async function signHttpMessage(
    message: HttpMessage,
    input: SignatureInput,
    privateKey: KeyObject,
    options: CanonicalizationOptions = {},
): Promise<SignatureHeaderPatch> {
    requireKey(privateKey, "private");
    const limits = resolveCoreLimits(options.limits);
    const inner = signatureInnerList(input, limits);
    requireAlgorithm(input);
    const base = createSignatureBase(message, input, options);
    const signature = sign(null, base.bytes, privateKey);
    const sfOptions = { limits: limits.structuredFields };
    const signatureInput = withSfErrors(() => serialize({
        kind: "dictionary",
        entries: [[input.label, inner]],
    }, sfOptions));
    const signatureHeader = withSfErrors(() => serialize({
        kind: "dictionary",
        entries: [[input.label, {
            kind: "item",
            bare: { kind: "bytes", value: signature },
            parameters: [],
        }]],
    }, sfOptions));
    checkLimit(
        limits, "maxSignatureHeaderBytes", signatureInput.length + signatureHeader.length,
    );
    return { label: input.label, signatureInput, signature: signatureHeader };
}

/**
 * Cryptographic validity only. The caller supplies the exact candidate public
 * key; this function does not establish its ownership, trust, or URL binding.
 * It does not verify Content-Digest against a message body.
 * Configuration/programming errors propagate rather than masquerading as an
 * ordinary signature mismatch. Expected message rejections become typed results.
 */
export async function verifyHttpSignatureCryptography(
    message: HttpMessage,
    signature: ParsedSignature,
    publicKey: KeyObject,
    options: CanonicalizationOptions = {},
): Promise<CryptoVerification> {
    // Validate caller configuration even if the key/signature is unusable.
    const limits = resolveCoreLimits(options.limits);
    try {
        requireKey(publicKey, "public");
        if (
            signature === null || typeof signature !== "object" ||
            !(signature.signature instanceof Uint8Array)
        ) throw new SignatureError("malformed");
        signatureInnerList(signature.input, limits);
        requireAlgorithm(signature.input);
        if (signature.signature.byteLength !== 64) {
            return { status: "rejected", reason: "signature-mismatch" };
        }
        const base = createSignatureBase(message, signature.input, options);
        if (!verify(null, base.bytes, publicKey, signature.signature)) {
            return { status: "rejected", reason: "signature-mismatch" };
        }
        return { status: "signature-valid", input: signature.input };
    } catch (error) {
        if (error instanceof SignatureError) {
            return { status: "rejected", reason: error.reason };
        }
        throw error;
    }
}