import { invalidJwks } from "./jwks-error.js";

const signatureOperations: ReadonlySet<string> = new Set(["sign", "verify"]);
const encryptionOperations: ReadonlySet<string> = new Set([
    "encrypt", "decrypt", "wrapKey", "unwrapKey", "deriveKey", "deriveBits",
]);

/**
 * Validate the approved local usage policy on an owned, bounded JWK snapshot.
 *
 * RFC 7517 §§4.2–4.3 require string values, unique operations and consistent
 * use/key_ops when both are supplied. WG-00 §§5.5–5.5.1 add no usage rule.
 * The stronger Ed25519 verification restriction below is agentsig policy A,
 * identical for generic JWKS and the explicitly selected WG directory format.
 *
 * Structural material validation must run first: a caller must not use a
 * mismatched kty/crv pair to evade the curve-specific policy.
 */
export function validateJwkUsage(
    key: Readonly<Record<string, unknown>>,
    keyIndex: number,
): void {
    const fail = (rule: string): never => invalidJwks(rule, keyIndex, key);
    let use: string | undefined;
    let operations: readonly string[] | undefined;

    if (Object.hasOwn(key, "use")) {
        if (typeof key.use !== "string") fail("use must be a string");
        use = key.use as string;
    }
    if (Object.hasOwn(key, "key_ops")) {
        const value = key.key_ops;
        if (!Array.isArray(value) || value.some((operation: unknown) =>
            typeof operation !== "string")) {
            fail("key_ops must be an array of strings");
        }
        operations = value as string[];
        if (new Set(operations).size !== operations.length) {
            fail("key_ops must not contain duplicates");
        }
    }

    if (operations !== undefined) {
        // Reject established contradictions, including on skipped key types.
        // RFC 7517 allows extension values: do not invent semantics for them
        // on unsupported keys that will never reach signature verification.
        const inconsistent =
            (use === "sig" && operations.some((operation) =>
                encryptionOperations.has(operation))) ||
            (use === "enc" && operations.some((operation) =>
                signatureOperations.has(operation)));
        if (inconsistent) fail("use and key_ops must be consistent");
    }

    // OKP is a key family, not a signature algorithm. In particular, X25519
    // and Ed448 must not inherit the approved Ed25519-only usage restriction.
    if (key.crv !== "Ed25519") return;

    // Metadata must never silently expand the trusted key's permitted use.
    // Reject the complete configuration rather than returning a misleading
    // unsupported-algorithm result for a supported but disallowed key.
    if (use !== undefined && use !== "sig") {
        fail("Ed25519 use must be sig");
    }
    if (operations !== undefined &&
        (!operations.includes("verify") ||
            operations.some((operation) => !signatureOperations.has(operation)))) {
        fail("Ed25519 key_ops must include verify and only sign/verify");
    }
}