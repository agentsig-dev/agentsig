import { Buffer } from "node:buffer";
import { createHash, createPublicKey } from "node:crypto";
import type { JsonWebKey, KeyObject } from "node:crypto";
import { InvalidJwksError } from "./jwks-error.js";

export interface PublicJwkMaterial {
    readonly kty: string;
    readonly curve: string | undefined;
    readonly thumbprint: string;
    readonly publicKey: KeyObject;
    readonly selectable: boolean;
    readonly mandatory: Readonly<Record<string, string>>;
}

function invalid(rule: string): never {
    throw new InvalidJwksError(rule);
}

function required(key: Readonly<Record<string, unknown>>, name: string): string {
    if (!Object.hasOwn(key, name) || typeof key[name] !== "string") {
        return invalid(`${name} must be a present string`);
    }
    return key[name];
}

/** Caller has bounded the complete JWKS before any decoding or key import. */
function decode(value: string, size?: number): Buffer {
    if (
        value.length === 0 ||
        /[^A-Za-z0-9_-]/.test(value) ||
        (size !== undefined && value.length !== Math.ceil(size * 4 / 3))
    ) return invalid("public component must use unpadded base64url with the required curve length");
    const bytes = Buffer.from(value, "base64url");
    if (
        !bytes.length ||
        (size !== undefined && bytes.length !== size) ||
        bytes.toString("base64url") !== value
    ) return invalid("public component must have canonical base64url encoding and the required length");
    return bytes;
}

/**
 * Validate public-key representations, including recognized unsupported types.
 * This is NOT verification support for RSA, EC, Ed448 or ECDH.
 *
 * RFC 7638 requires type-specific mandatory members. Unknown types/curves
 * cannot be safely fingerprinted by guessing those members, so the approved
 * malformed/unhashable-input policy rejects them instead of silently skipping.
 * Input must be the bounded, owned data snapshot, never arbitrary accessor data.
 */
export function inspectPublicJwk(
    key: Readonly<Record<string, unknown>>,
): PublicJwkMaterial {
    // Public-only configuration: reject secret material by presence. Do not
    // strip it and accidentally report successful public-only loading.
    for (const name of ["d", "p", "q", "dp", "dq", "qi", "oth", "k"]) {
        if (Object.hasOwn(key, name)) invalid("public JWKS must not contain private or symmetric key material");
    }
    const kty = required(key, "kty");
    let curve: string | undefined;
    let expectedBackendType: string;
    let mandatory: Record<string, string>;

    switch (kty) {
        case "OKP": {
            curve = required(key, "crv");
            // RFC 8037 §§2–3: curve-specific encoded public key lengths.
            const shapes: Readonly<Record<string, readonly [number, string]>> = {
                Ed25519: [32, "ed25519"],
                Ed448: [57, "ed448"],
                X25519: [32, "x25519"],
                X448: [56, "x448"],
            };
            if (!Object.hasOwn(shapes, curve)) return invalid("OKP crv must identify a recognized OKP curve");
            const shape = shapes[curve]!;
            const x = required(key, "x");
            decode(x, shape[0]);
            expectedBackendType = shape[1];
            mandatory = { crv: curve, kty, x };
            break;
        }
        case "EC": {
            curve = required(key, "crv");
            // RFC 7518 §6.2.1: uncompressed coordinates, full curve width.
            const widths: Readonly<Record<string, number>> = {
                "P-256": 32,
                "P-384": 48,
                "P-521": 66,
            };
            if (!Object.hasOwn(widths, curve)) return invalid("EC crv must identify a recognized EC curve");
            const x = required(key, "x");
            const y = required(key, "y");
            decode(x, widths[curve]!);
            decode(y, widths[curve]!);
            expectedBackendType = "ec";
            mandatory = { crv: curve, kty, x, y };
            break;
        }
        case "RSA": {
            const n = required(key, "n");
            const e = required(key, "e");
            const modulus = decode(n);
            const exponent = decode(e);
            // RFC 7518 Base64urlUInt is minimal unsigned encoding; no DER
            // sign-padding octet. Zero/even RSA components are not public keys.
            if (
                modulus[0] === 0 || exponent[0] === 0 ||
                (modulus[modulus.length - 1]! & 1) === 0 ||
                (exponent[exponent.length - 1]! & 1) === 0 ||
                (exponent.length === 1 && exponent[0]! < 3)
            ) return invalid("RSA n and e must be minimal nonzero odd unsigned integers, with e at least 3");
            expectedBackendType = "rsa";
            mandatory = { e, kty, n };
            break;
        }
        default:
            return invalid("kty must identify a recognized public key type with defined thumbprint members");
    }

    let publicKey: KeyObject;
    try {
        // Metadata must not select the crypto backend or relax material checks.
        // Import only the mandatory public representation.
        publicKey = createPublicKey({ key: mandatory as JsonWebKey, format: "jwk" });
    } catch {
        return invalid("public key material must be importable by the crypto backend");
    }
    if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== expectedBackendType) {
        return invalid("imported public key type must match kty and crv");
    }
    // Stable material encoding must survive import/export. This catches
    // backend normalization of a representation we would otherwise misidentify.
    const exported = publicKey.export({ format: "jwk" });
    for (const [name, value] of Object.entries(mandatory)) {
        if (exported[name] !== value) {
            return invalid("public key components must round-trip without normalization");
        }
    }

    // Object members were constructed in RFC lexicographic order above.
    // alg/kid/use/key_ops are intentionally excluded (RFC 7638 §3.2.2).
    const thumbprint = createHash("sha256")
        .update(JSON.stringify(mandatory), "utf8")
        .digest("base64url");
    return Object.freeze({
        kty,
        curve,
        thumbprint,
        publicKey,
        selectable: kty === "OKP" && curve === "Ed25519",
        mandatory: Object.freeze(mandatory),
    });
}