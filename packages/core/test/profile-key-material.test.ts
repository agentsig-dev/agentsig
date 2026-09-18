import { createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
    ed25519Thumbprint,
    importEd25519PublicMaterial,
    isKnownTestKey,
    KNOWN_TEST_KEY_THUMBPRINTS,
} from "../src/profiles/key-material.js";
import { ProfileConfigurationError } from "../src/profiles/codes.js";

const fixtureRoot = new URL("../../../tests/fixtures/m2/", import.meta.url);
const boundaries = JSON.parse(
    readFileSync(new URL("boundary-cases.json", fixtureRoot)).toString("utf8"),
) as {
    testKeys: readonly {
        id: string;
        publicKeyFile: string;
        thumbprint: string;
    }[];
};

function fixtureJwk() {
    const key = createPublicKey(readFileSync(
        new URL("generated/public-test-public.pem", fixtureRoot),
    ));
    return key.export({ format: "jwk" });
}

describe("Ed25519 material — independent fixture identities", () => {
    for (const fixture of boundaries.testKeys) {
        it(`matches pinned thumbprint for ${fixture.id}`, () => {
            const reference = createPublicKey(readFileSync(
                new URL(fixture.publicKeyFile, fixtureRoot),
            ));
            const jwk = reference.export({ format: "jwk" });
            expect(ed25519Thumbprint(jwk)).toBe(fixture.thumbprint);
            const imported = importEd25519PublicMaterial(jwk);
            expect(imported.thumbprint).toBe(fixture.thumbprint);
            expect(imported.publicKey.export({ type: "spki", format: "der" }))
                .toEqual(reference.export({ type: "spki", format: "der" }));
            expect(Object.isFrozen(imported)).toBe(true);
            expect(Object.isFrozen(imported.jwk)).toBe(true);
            expect(isKnownTestKey(imported.thumbprint)).toBe(true);
        });
    }

    it("pins the known-test-key list independently of kid", () => {
        expect(KNOWN_TEST_KEY_THUMBPRINTS).toEqual(
            boundaries.testKeys.map((fixture) => fixture.thumbprint),
        );
        expect(Object.isFrozen(KNOWN_TEST_KEY_THUMBPRINTS)).toBe(true);
        const jwk = fixtureJwk();
        expect(ed25519Thumbprint({ ...jwk, kid: "renamed-production-key" }))
            .toBe(boundaries.testKeys[1]!.thumbprint);
        expect(isKnownTestKey("not-a-known-test-key")).toBe(false);
    });

    it("includes only mandatory public members in the thumbprint", () => {
        const jwk = fixtureJwk();
        expect(ed25519Thumbprint({
            ...jwk, kid: "label", use: "sig", key_ops: ["verify"], alg: "EdDSA",
        })).toBe(ed25519Thumbprint(jwk));
        // This helper computes identity only; it does not authorize metadata.
        // Full metadata restrictions will be tested at the JWKS layer.
    });

    it("owns a copy independent of subsequent caller mutation", () => {
        const jwk = fixtureJwk();
        const imported = importEd25519PublicMaterial(jwk);
        const originalX = jwk.x;
        const originalDer = imported.publicKey.export({ type: "spki", format: "der" });
        jwk.x = "a".repeat(43);
        jwk.crv = "X25519";
        expect(imported.jwk.x).toBe(originalX);
        expect(imported.jwk.crv).toBe("Ed25519");
        expect(imported.publicKey.export({ type: "spki", format: "der" }))
            .toEqual(originalDer);
    });
});

describe("invalid public key material", () => {
    it.each([null, undefined, [], "key", 123, {}])(
        "rejects invalid input %#",
        (input) => {
            expect(() => importEd25519PublicMaterial(input))
                .toThrow(ProfileConfigurationError);
        },
    );

    it("rejects private material by presence, including undefined d", () => {
        for (const d of ["private-value", undefined]) {
            expect(() => ed25519Thumbprint({ ...fixtureJwk(), d }))
                .toThrow(expect.objectContaining({ code: "invalid-key-configuration" }));
        }
    });

    it("rejects wrong key type, curve, missing or inherited mandatory fields", () => {
        const valid = fixtureJwk();
        for (const input of [
            { ...valid, kty: "RSA" },
            { ...valid, crv: "X25519" },
            { kty: "OKP", crv: "Ed25519" },
            Object.create(valid) as unknown,
        ]) {
            expect(() => importEd25519PublicMaterial(input))
                .toThrow(ProfileConfigurationError);
        }
    });

    it("rejects noncanonical encoding, wrong length and nonzero pad bits", () => {
        const valid = fixtureJwk();
        const x = valid.x!;
        const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        const finalIndex = alphabet.indexOf(x.at(-1)!);
        expect(finalIndex % 4).toBe(0);
        const sameBytesNoncanonical = x.slice(0, -1) + alphabet[finalIndex + 1];
        expect(Buffer.from(sameBytesNoncanonical, "base64url"))
            .toEqual(Buffer.from(x, "base64url"));

        for (const invalidX of [
            x + "=", x.slice(1), x + "A", "+" + x.slice(1),
            x.slice(0, -1) + "\n", sameBytesNoncanonical, 42,
        ]) {
            expect(() => importEd25519PublicMaterial({ ...valid, x: invalidX }))
                .toThrow(ProfileConfigurationError);
        }
    });

    it("does not invoke getters for required material", () => {
        let reads = 0;
        const input = Object.defineProperty({ kty: "OKP", crv: "Ed25519" }, "x", {
            get() {
                reads++;
                return fixtureJwk().x;
            },
        });
        expect(() => ed25519Thumbprint(input)).toThrow(ProfileConfigurationError);
        expect(reads).toBe(0);
    });

    it("does not reflect supplied key material in error messages", () => {
        const marker = "secret-marker-do-not-log";
        try {
            importEd25519PublicMaterial({ kty: "OKP", crv: "Ed25519", x: marker });
            expect.unreachable("Expected rejection");
        } catch (error) {
            expect(error).toBeInstanceOf(ProfileConfigurationError);
            expect((error as Error).message).not.toContain(marker);
        }
    });
});