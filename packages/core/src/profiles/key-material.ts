import { Buffer } from "node:buffer";
import { createHash, createPublicKey } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { ProfileConfigurationError } from "./codes.js";

export interface Ed25519PublicMaterial {
    readonly kty: "OKP";
    readonly crv: "Ed25519";
    readonly x: string;
}

export interface ImportedEd25519PublicMaterial {
    readonly jwk: Readonly<Ed25519PublicMaterial>;
    readonly thumbprint: string;
    readonly publicKey: KeyObject;
}

/**
 * Publicly known fixture keys, not an exhaustive compromised-key database.
 * Checking kid would permit bypass by renaming a public test key.
 */
export const KNOWN_TEST_KEY_THUMBPRINTS: readonly string[] = Object.freeze([
    "poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U",
    "DR68nui99ukl-GUgfzQGaU3VwqRtArw-_DCN4LFtY84",
]);

/**
 * Read only own data properties. Caller-provided configuration must not execute
 * getters while importing cryptographic material. Metadata validation belongs
 * to the JWKS layer; inherited mandatory values are never accepted.
 */
function ownValue(input: object, name: string): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(input, name);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
        throw new ProfileConfigurationError("invalid-key-configuration");
    }
    return descriptor.value as unknown;
}

function publicMaterial(input: unknown): Readonly<Ed25519PublicMaterial> {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
        throw new ProfileConfigurationError("invalid-key-configuration");
    }
    // Reject private material rather than silently discarding it. Presence is
    // sufficient: even an undefined private field indicates wrong key purpose.
    if (Object.hasOwn(input, "d")) {
        throw new ProfileConfigurationError("invalid-key-configuration");
    }
    const kty = ownValue(input, "kty");
    const crv = ownValue(input, "crv");
    const x = ownValue(input, "x");
    if (kty !== "OKP" || crv !== "Ed25519" || typeof x !== "string") {
        throw new ProfileConfigurationError("invalid-key-configuration");
    }
    // RFC 8037: x is the 32-octet Ed25519 public key, base64url without padding.
    // Bound before decoding. Node's permissive decoder alone is insufficient.
    if (x.length !== 43 || /[^A-Za-z0-9_-]/.test(x)) {
        throw new ProfileConfigurationError("invalid-key-configuration");
    }
    const bytes = Buffer.from(x, "base64url");
    if (bytes.length !== 32 || bytes.toString("base64url") !== x) {
        // Round-trip equality rejects nonzero pad bits and alternative spellings.
        throw new ProfileConfigurationError("invalid-key-configuration");
    }
    return Object.freeze({ kty: "OKP", crv: "Ed25519", x });
}

function thumbprint(material: Ed25519PublicMaterial): string {
    // RFC 7638 §3 / RFC 8037 Appendix A.3: required members only, lexicographic
    // order, no whitespace. kid, alg, use, key_ops do not change key identity.
    const canonical = JSON.stringify({
        crv: material.crv,
        kty: material.kty,
        x: material.x,
    });
    return createHash("sha256").update(canonical, "utf8").digest("base64url");
}

/**
 * Compute key identity only. This does not validate JWKS metadata restrictions,
 * approve the key for verification, establish trust, or bind it to a URL.
 */
export function ed25519Thumbprint(input: unknown): string {
    return thumbprint(publicMaterial(input));
}

/**
 * Import an owned public-only copy. The resulting key object does not depend on
 * later changes to the caller's JWK. Full local-key policy is applied separately.
 */
export function importEd25519PublicMaterial(input: unknown): ImportedEd25519PublicMaterial {
    const jwk = publicMaterial(input);
    let publicKey: KeyObject;
    try {
        publicKey = createPublicKey({ key: jwk, format: "jwk" });
    } catch {
        // Do not expose backend errors containing caller-supplied key material.
        throw new ProfileConfigurationError("invalid-key-configuration");
    }
    if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519") {
        throw new ProfileConfigurationError("invalid-key-configuration");
    }
    return Object.freeze({ jwk, thumbprint: thumbprint(jwk), publicKey });
}

export function isKnownTestKey(thumbprintValue: string): boolean {
    return KNOWN_TEST_KEY_THUMBPRINTS.includes(thumbprintValue);
}