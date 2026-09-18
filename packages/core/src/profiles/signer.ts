import { sign } from "node:crypto";
import { serialize } from "@agentsig/structured-fields";
import { validateHeaders } from "../headers.js";
import { checkLimit } from "../limits.js";
import { createSignatureBase } from "../signature-base.js";
import { signatureInnerList, withSfErrors } from "../signature-input.js";
import type { RequestParts, SignatureInput } from "../types.js";
import { resolveSigningConfiguration, signingFailure } from "./signing-config.js";
import type { SigningOptions } from "./signing-config.js";
import { SigningError } from "./signing-errors.js";
import { readSigningNonce, readSigningTimestamps } from "./signing-providers.js";
import { snapshotUnsignedRequest } from "./signing-request.js";

/** Append explicitly at the transport boundary; no automatic merging. */
export type SignedRequestHeaders = readonly [
    readonly ["Signature-Input", string],
    readonly ["Signature", string],
    readonly ["Signature-Agent", string],
];

export interface WebBotAuthSigner {
    sign(request: RequestParts): Promise<SignedRequestHeaders>;
}

/**
 * One signature on a clean request, with a pinned profile and trusted key.
 * Existing signature-related headers are rejected, never overwritten.
 *
 * A Promise return does not imply asynchronous providers or off-thread crypto.
 * Request copying, synchronous providers and Ed25519 signing run without an
 * intervening await. Providers receive no request reference; even a provider
 * that mutates the original request through a closure cannot alter our copy.
 *
 * This signs method, full target URI and agent metadata, not the request body.
 * Additional Content-Digest coverage alone would not validate the actual body.
 * Applying returned headers to a different/mutated request invalidates the
 * intended binding; transports must sign the exact request they will send.
 */
export function createWebBotAuthSigner(options: SigningOptions): WebBotAuthSigner {
    const config = resolveSigningConfiguration(options);
    return Object.freeze({
        async sign(request: RequestParts): Promise<SignedRequestHeaders> {
            try {
                // Must precede all clock/nonce/cryptographic operations for
                // this request, including when an existing field is empty.
                const snapshot = snapshotUnsignedRequest(request, config.limits);
                const { created, expires } = readSigningTimestamps(
                    config.clock, config.lifetimeSeconds,
                );
                const nonce = readSigningNonce(
                    config.nonceGenerator, config.profileLimits.maxNonceBytes,
                );
                const input: SignatureInput = {
                    label: config.label,
                    components: config.components,
                    parameters: [
                        ["created", { kind: "integer", value: created }],
                        ["expires", { kind: "integer", value: expires }],
                        ["keyid", { kind: "string", value: config.keyid }],
                        ["alg", { kind: "string", value: "ed25519" }],
                        ["nonce", { kind: "string", value: nonce }],
                        ["tag", { kind: "string", value: "web-bot-auth" }],
                    ],
                };
                const sfOptions = { limits: config.limits.structuredFields };
                const inner = signatureInnerList(input, config.limits);
                const signatureInput = withSfErrors(() => serialize({
                    kind: "dictionary", entries: [[config.label, inner]],
                }, sfOptions));
                const unsignedSignature = (bytes: Uint8Array): string => withSfErrors(() =>
                    serialize({
                        kind: "dictionary",
                        entries: [[config.label, {
                            kind: "item", bare: { kind: "bytes", value: bytes }, parameters: [],
                        }]],
                    }, sfOptions));

                // Ed25519 is always 64 bytes. Check final wire budgets BEFORE
                // signing, using an equal-length placeholder, not guessed
                // serialization overhead. No partial output escapes on failure.
                const placeholder = unsignedSignature(new Uint8Array(64));
                checkLimit(config.limits, "maxSignatureHeaderBytes",
                    signatureInput.length + placeholder.length);
                validateHeaders([
                    ...snapshot.headers,
                    ["Signature-Input", signatureInput],
                    ["Signature", placeholder],
                    ["Signature-Agent", config.agentHeader],
                ], config.limits);
                const signedRequest: RequestParts = {
                    ...snapshot,
                    headers: [...snapshot.headers, ["Signature-Agent", config.agentHeader]],
                };
                const base = createSignatureBase(
                    { kind: "request", request: signedRequest }, input,
                    { limits: config.limits, structuredFieldTypes: config.fieldTypes },
                );
                let signature: Uint8Array;
                try {
                    // RFC 9421 Ed25519 primitive: sign exact canonical bytes,
                    // no prehash and no additional cryptographic dependency.
                    signature = sign(null, base.bytes, config.privateKey);
                } catch {
                    throw new SigningError("signing-failed");
                }
                if (signature.length !== 64) throw new SigningError("signing-failed");
                return Object.freeze([
                    Object.freeze(["Signature-Input", signatureInput] as const),
                    Object.freeze(["Signature", unsignedSignature(signature)] as const),
                    Object.freeze(["Signature-Agent", config.agentHeader] as const),
                ] as const);
            } catch (error) {
                return signingFailure(error);
            }
        },
    });
}