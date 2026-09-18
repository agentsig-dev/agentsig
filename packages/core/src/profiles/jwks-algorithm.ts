import { invalidJwks } from "./jwks-error.js";

export type JwksFormat = "jwks" | "wg-directory-00";

/** Load-report reasons only; not additions to the verification result catalog. */
export type SkippedKeyReason = "unsupported-algorithm" | "unknown-algorithm-name";

/**
 * RFC 7518 §7.1.2 registrations whose Usage Location is "alg", plus RFC 8037.
 * Content-encryption ("enc") registrations are intentionally excluded.
 * Name recognition does NOT imply implementation, suitability or key compatibility.
 */
export const JOSE_ALGORITHM_NAMES = Object.freeze([
    "HS256", "HS384", "HS512", "RS256", "RS384", "RS512",
    "ES256", "ES384", "ES512", "PS256", "PS384", "PS512", "none",
    "RSA1_5", "RSA-OAEP", "RSA-OAEP-256", "A128KW", "A192KW", "A256KW",
    "dir", "ECDH-ES", "ECDH-ES+A128KW", "ECDH-ES+A192KW", "ECDH-ES+A256KW",
    "A128GCMKW", "A192GCMKW", "A256GCMKW",
    "PBES2-HS256+A128KW", "PBES2-HS384+A192KW", "PBES2-HS512+A256KW", "EdDSA",
] as const);

/**
 * IANA HTTP Signature Algorithms (RFC 9421 §6.2).
 * Retrieved 2026-09-18T20:36:24.390Z; registry updated 2026-07-20.
 * https://www.iana.org/assignments/http-message-signature/http-message-signature.xml
 * SHA-256: bd4b0304e21e226fef189ed283a31392b5ffc99a37d00e9911dc011dcfb1523f
 */
export const HTTP_SIGNATURE_ALGORITHM_NAMES = Object.freeze([
    "rsa-pss-sha512", "rsa-v1_5-sha256", "hmac-sha256",
    "ecdsa-p256-sha256", "ecdsa-p384-sha384", "ed25519",
] as const);

/**
 * Run after structural public-material validation on an owned snapshot.
 * Undefined means supported Ed25519 metadata, not verification success.
 *
 * Approved policy B: unsupported keys never enter the verification pool.
 * Their unknown algorithm names are reported, not treated as malformed sets,
 * because registry snapshots age. Consequently accepting a set is NOT full
 * WG §5.5.1 conformance validation of its skipped entries. Registry membership
 * is enforced strictly for usable Ed25519 keys.
 *
 * No general key/algorithm compatibility table is applied to skipped keys.
 * The explicitly approved Ed25519-name exception includes Ed448/EdDSA:
 * that pairing is valid JOSE, but rejected by this narrower local policy.
 */
export function validateJwkAlgorithm(
    key: Readonly<Record<string, unknown>>,
    keyIndex: number,
    format: JwksFormat,
): SkippedKeyReason | undefined {
    const fail = (rule: string): never => invalidJwks(rule, keyIndex, key);
    const present = Object.hasOwn(key, "alg");
    const alg = key.alg;
    if (present && (typeof alg !== "string" || /[^\x00-\x7f]/.test(alg))) {
        fail("alg must be an ASCII string");
    }
    const supportedName = format === "jwks" ? "EdDSA" : "ed25519";
    if (key.crv === "Ed25519") {
        if (present && alg !== supportedName) {
            fail("Ed25519 alg must match the selected JWKS format");
        }
        return undefined;
    }
    if (!present) return "unsupported-algorithm";
    const own: readonly string[] = format === "jwks"
        ? JOSE_ALGORITHM_NAMES : HTTP_SIGNATURE_ALGORITHM_NAMES;
    const other: readonly string[] = format === "jwks"
        ? HTTP_SIGNATURE_ALGORITHM_NAMES : JOSE_ALGORITHM_NAMES;
    if (other.includes(alg as string)) {
        fail("alg belongs to the opposite JWKS format");
    }
    if (alg === supportedName) {
        fail("Ed25519 algorithm name requires crv Ed25519");
    }
    return own.includes(alg as string) ? "unsupported-algorithm" : "unknown-algorithm-name";
}