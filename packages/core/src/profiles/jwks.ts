import type { KeyObject } from "node:crypto";
import { ProfileConfigurationError } from "./codes.js";
import { resolveProfileLimits } from "./defaults.js";
import type { ProfileLimits } from "./defaults.js";
import { snapshotJwksInput } from "./jwks-input.js";
import { InvalidJwksError, invalidJwks } from "./jwks-error.js";
import { inspectPublicJwk } from "./public-jwk.js";
import type { PublicJwkMaterial } from "./public-jwk.js";
import { validateJwkUsage } from "./jwks-usage.js";
import { validateJwkAlgorithm } from "./jwks-algorithm.js";
import type { JwksFormat, SkippedKeyReason } from "./jwks-algorithm.js";
import { isKnownTestKey } from "./key-material.js";

export interface LoadJwksOptions {
    readonly format?: JwksFormat;
    readonly limits?: Partial<ProfileLimits>;
}

export interface LoadedVerificationKey {
    readonly keyIndex: number;
    readonly kid: string | null;
    readonly thumbprint: string;
    readonly publicKey: KeyObject;
    readonly knownTestKey: boolean;
}

export interface SkippedJwk {
    readonly keyIndex: number;
    readonly kid: string | null;
    readonly thumbprint: string;
    readonly kty: string;
    readonly curve: string | undefined;
    readonly alg: string | undefined;
    readonly reason: SkippedKeyReason;
    readonly requestCode: "unsupported-algorithm";
}

/** Key lookup is not request verification, test-key approval or URL binding. */
export type JwksLookup =
    | { readonly status: "found"; readonly key: LoadedVerificationKey }
    | { readonly status: "unverified"; readonly reason: "unknown-key" | "unsupported-algorithm" };

export interface LoadedJwks {
    readonly format: JwksFormat;
    readonly keys: readonly LoadedVerificationKey[];
    readonly skipped: readonly SkippedJwk[];
    readonly skippedCount: number;
    lookup(thumbprint: string): JwksLookup;
}

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionsSnapshot(options: LoadJwksOptions): {
    format: JwksFormat;
    limits: Readonly<ProfileLimits>;
} {
    if (!record(options)) invalidJwks("loader options must be an object");
    let format: JwksFormat = "jwks";
    let limits: Partial<ProfileLimits> | undefined;
    for (const name of Reflect.ownKeys(options)) {
        if (name !== "format" && name !== "limits") {
            invalidJwks("loader options must contain only format and limits");
        }
        const descriptor = Object.getOwnPropertyDescriptor(options, name);
        if (!descriptor || !Object.hasOwn(descriptor, "value")) {
            invalidJwks("loader options must use data properties");
        }
        const value: unknown = descriptor.value;
        if (name === "format") {
            if (value !== "jwks" && value !== "wg-directory-00") {
                invalidJwks("format must be jwks or wg-directory-00");
            }
            format = value;
        } else {
            limits = value as Partial<ProfileLimits> | undefined;
        }
    }
    return { format, limits: resolveProfileLimits(limits) };
}

/**
 * Load PUBLIC keys from trusted local configuration only.
 *
 * Snapshot before interpreting material so caller mutation cannot change the
 * selected key. Bound bytes before decoding/import and count all entries,
 * including unsupported and repeated keys, before cryptographic work.
 * Loading neither accepts a request nor grants permission to use test keys.
 */
export function loadJwks(input: unknown, options: LoadJwksOptions = {}): LoadedJwks {
    const { format, limits } = optionsSnapshot(options);
    let snapshot: unknown;
    try {
        snapshot = snapshotJwksInput(input, limits.maxJwksBytes);
    } catch (error) {
        if (error instanceof ProfileConfigurationError && error.code === "invalid-jwks") {
            // Parsing/snapshot failure can precede any safely readable key index.
            invalidJwks("input must be bounded valid JSON data within maxJwksBytes");
        }
        throw error;
    }
    if (!record(snapshot) || !Object.hasOwn(snapshot, "keys") || !Array.isArray(snapshot.keys)) {
        invalidJwks("JWKS must be an object with an own keys array");
    }
    const entries = snapshot.keys;
    if (entries.length > limits.maxKeys) invalidJwks("keys length must not exceed maxKeys");

    const keys: LoadedVerificationKey[] = [];
    const skipped: SkippedJwk[] = [];
    for (const [keyIndex, entry] of entries.entries()) {
        if (!record(entry)) invalidJwks("key must be a JSON object", keyIndex);
        const fail = (rule: string): never => invalidJwks(rule, keyIndex, entry);
        // Reject symmetric material even if k is absent. Public directories
        // must not become an accidental secret-publication configuration.
        if (entry.kty === "oct") fail("public JWKS must not contain symmetric keys");
        if (Object.hasOwn(entry, "kid") && typeof entry.kid !== "string") {
            fail("kid must be a string");
        }
        let material: PublicJwkMaterial;
        try {
            material = inspectPublicJwk(entry);
        } catch (error) {
            if (error instanceof InvalidJwksError) {
                invalidJwks(error.diagnostic.rule, keyIndex, entry);
            }
            throw error;
        }
        const kid = Object.hasOwn(entry, "kid") ? entry.kid as string : null;
        // WG-00 §5.5: optional kid at the well-known directory is the
        // thumbprint. Generic JOSE labels remain opaque and never select keys.
        if (format === "wg-directory-00" && kid !== null && kid !== material.thumbprint) {
            fail("kid must equal the RFC 7638 thumbprint");
        }
        validateJwkUsage(entry, keyIndex);
        const reason = validateJwkAlgorithm(entry, keyIndex, format);
        if (material.selectable) {
            keys.push(Object.freeze({
                keyIndex, kid, thumbprint: material.thumbprint,
                publicKey: material.publicKey,
                knownTestKey: isKnownTestKey(material.thumbprint),
            }));
        } else {
            // Never expose skipped key objects to the verification path.
            skipped.push(Object.freeze({
                keyIndex, kid, thumbprint: material.thumbprint,
                kty: material.kty, curve: material.curve,
                alg: Object.hasOwn(entry, "alg") ? entry.alg as string : undefined,
                reason: reason!,
                requestCode: "unsupported-algorithm" as const,
            }));
        }
    }

    // Keep entry-level reporting, including duplicates. All occurrences passed
    // policy checks; repeated labels cannot redirect thumbprint lookup.
    // Bounded linear lookup avoids exposing a mutable Map as a readonly facade.
    const ownedKeys = Object.freeze(keys);
    const ownedSkipped = Object.freeze(skipped);
    return Object.freeze({
        format,
        keys: ownedKeys,
        skipped: ownedSkipped,
        skippedCount: ownedSkipped.length,
        lookup(thumbprint: string): JwksLookup {
            const key = ownedKeys.find((entry) => entry.thumbprint === thumbprint);
            if (key) return Object.freeze({ status: "found", key });
            const unsupported = ownedSkipped.some((entry) => entry.thumbprint === thumbprint);
            return Object.freeze({
                status: "unverified",
                reason: unsupported ? "unsupported-algorithm" : "unknown-key",
            });
        },
    });
}