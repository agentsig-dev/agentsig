import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { inspectPublicJwk } from "../src/profiles/public-jwk.js";
import { validateJwkUsage } from "../src/profiles/jwks-usage.js";
import { InvalidJwksError, invalidJwks } from "../src/profiles/jwks-error.js";

interface PolicyCase {
    readonly id: string;
    readonly jwks: { readonly keys: Readonly<Record<string, unknown>>[] };
    readonly expected: {
        readonly load: "accepted" | "rejected";
        readonly selectableThumbprints?: readonly string[];
        readonly skipped?: readonly { readonly thumbprint: string }[];
        readonly diagnostic?: {
            readonly keyIndex: number;
            readonly kid: string | null;
            readonly rule: string;
        };
    };
}

const fixtureRoot = new URL("../../../tests/fixtures/jwks/", import.meta.url);
const matrix = JSON.parse(readFileSync(
    new URL("metadata-cases.json", fixtureRoot), "utf8",
)) as { readonly cases: readonly PolicyCase[] };

describe("JWKS usage policy against pre-implementation fixtures", () => {
    // kid belongs to format validation in the loader, not the usage helper.
    const usageCases = matrix.cases.filter((entry) =>
        !entry.expected.diagnostic?.rule.startsWith("kid "));
    for (const entry of usageCases) {
        it(entry.id, () => {
            if (entry.expected.load === "accepted") {
                const materials = entry.jwks.keys.map((key, index) => {
                    const material = inspectPublicJwk(key);
                    validateJwkUsage(key, index);
                    expect(Object.isFrozen(material)).toBe(true);
                    expect(Object.isFrozen(material.mandatory)).toBe(true);
                    return material;
                });
                expect(materials.filter((key) => key.selectable)
                    .map((key) => key.thumbprint))
                    .toEqual(entry.expected.selectableThumbprints);
                expect(materials.filter((key) => !key.selectable)
                    .map((key) => key.thumbprint))
                    .toEqual(entry.expected.skipped!.map((key) => key.thumbprint));
                return;
            }
            const expected = entry.expected.diagnostic!;
            const key = entry.jwks.keys[expected.keyIndex]!;
            // All usage-policy negatives have valid public key material.
            inspectPublicJwk(key);
            let caught: unknown;
            try {
                validateJwkUsage(key, expected.keyIndex);
            } catch (error) {
                caught = error;
            }
            expect(caught).toBeInstanceOf(InvalidJwksError);
            const error = caught as InvalidJwksError;
            expect(error.code).toBe("invalid-jwks");
            expect(error.diagnostic).toEqual({
                keyIndex: expected.keyIndex,
                rule: expected.rule,
                ...(expected.kid === null ? {} : { kid: expected.kid }),
            });
            expect(error.message).toContain(`keys[${expected.keyIndex}]`);
            expect(error.message).toContain(expected.rule);
            if (expected.kid !== null) {
                expect(error.message).toContain(JSON.stringify(expected.kid));
            }
            expect(error.message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
            expect(error.message).not.toContain(key.x);
        });
    }
});

describe("bounded operator diagnostics", () => {
    it("escapes directional controls and line separators without changing the stored kid", () => {
        const kid = "label\u202e\u2028\u2029\u0085";
        const error = new InvalidJwksError("use must be a string", 2, kid);
        expect(error.diagnostic.kid).toBe(kid);
        expect(error.message).toContain("label\\u202e\\u2028\\u2029\\u0085");
        expect(Object.isFrozen(error.diagnostic)).toBe(true);
    });

    it("explicitly truncates oversized labels without logging public or private material", () => {
        const kid = "a".repeat(255) + "😀" + "z".repeat(1000);
        expect(() => invalidJwks("use must be a string", 3, {
            kid, x: "PUBLIC-MARKER", d: "PRIVATE-MARKER",
        })).toThrow(InvalidJwksError);
        const error = new InvalidJwksError("use must be a string", 3, kid);
        expect(error.message).toContain("[truncated]");
        expect(error.message.length).toBeLessThan(400);
        expect(error.message).not.toContain("\\ud83d");
        expect(error.diagnostic.kid).toBe(kid);
    });

    it("does not stringify a non-string kid or include unrelated properties", () => {
        let called = false;
        const key = { kid: { toString() { called = true; return "unsafe"; } } };
        expect(() => invalidJwks("kid must be a string", 1, key))
            .toThrow("JWKS keys[1]: kid must be a string (invalid-jwks)");
        expect(called).toBe(false);
    });
});