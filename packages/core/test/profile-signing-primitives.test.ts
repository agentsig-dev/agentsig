import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isValidNonce } from "../src/profiles/nonce.js";
import {
    SIGNING_ERROR_CODES,
    SIGNING_ERROR_CATALOG_VERSION,
    SigningError,
} from "../src/profiles/signing-errors.js";
import { CandidateRejection, ProfileConfigurationError } from "../src/profiles/codes.js";

const root = new URL("../../../tests/fixtures/", import.meta.url);
const contract = JSON.parse(readFileSync(
    new URL("signing/contract.json", root), "utf8",
)) as { catalogVersion: number; codes: string[] };
const signingNonces = JSON.parse(readFileSync(
    new URL("signing/nonce-boundaries.json", root), "utf8",
)) as { cases: { nonce: string; valid: boolean }[] };
const verificationBoundaries = JSON.parse(readFileSync(
    new URL("m2/boundary-cases.json", root), "utf8",
)) as { nonceCases: { id: string; value: string; validSyntax: boolean }[] };

describe("shared nonce syntax — signer and verifier fixture contracts", () => {
    for (const [index, fixture] of signingNonces.cases.entries()) {
        it(`signer boundary ${index}`, () => {
            expect(isValidNonce(fixture.nonce)).toBe(fixture.valid);
        });
    }
    for (const fixture of verificationBoundaries.nonceCases) {
        it(`verifier boundary ${fixture.id}`, () => {
            expect(isValidNonce(fixture.value)).toBe(fixture.validSyntax);
        });
    }

    it("accepts every printable ASCII character without transforming it", () => {
        for (let code = 32; code <= 126; code++) {
            expect(isValidNonce(String.fromCharCode(code))).toBe(true);
        }
        const nonce = ' quote"slash\\end ';
        expect(isValidNonce(nonce)).toBe(true);
        expect(nonce).toBe(' quote"slash\\end ');
    });

    it("rejects controls, obs-text and Unicode", () => {
        for (let code = 0; code < 32; code++) {
            expect(isValidNonce(String.fromCharCode(code))).toBe(false);
        }
        for (const value of ["\u007f", "\u0080", "\u00ff", "😀", "\ud800"]) {
            expect(isValidNonce(value)).toBe(false);
        }
    });

    it("does not coerce provider outputs or await promises", () => {
        let coerced = false;
        for (const value of [
            undefined, null, 42, true, [], new Uint8Array([65]),
            Promise.resolve("nonce"),
            { toString() { coerced = true; return "nonce"; } },
        ]) {
            expect(isValidNonce(value)).toBe(false);
        }
        expect(coerced).toBe(false);
    });

    it("honors an explicit valid budget and fails closed on invalid budgets", () => {
        expect(isValidNonce("ab", 2)).toBe(true);
        expect(isValidNonce("ab", 1)).toBe(false);
        for (const maximum of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
            expect(isValidNonce("a", maximum)).toBe(false);
        }
    });
});

describe("separate frozen signing error contract", () => {
    it("matches all 13 independently pinned codes and the catalog version", () => {
        expect(SIGNING_ERROR_CODES).toEqual(contract.codes);
        expect(SIGNING_ERROR_CODES).toHaveLength(13);
        expect(new Set(SIGNING_ERROR_CODES).size).toBe(13);
        expect(SIGNING_ERROR_CATALOG_VERSION).toBe(contract.catalogVersion);
        expect(Object.isFrozen(SIGNING_ERROR_CODES)).toBe(true);
    });

    for (const code of SIGNING_ERROR_CODES) {
        it(`provides a typed, value-free error for ${code}`, () => {
            const error = new SigningError(code);
            expect(error).toBeInstanceOf(Error);
            expect(error.name).toBe("SigningError");
            expect(error.code).toBe(code);
            expect(error.message).toBe(`Web Bot Auth signing failed: ${code}`);
            expect(error.details).toEqual({});
            expect(Object.isFrozen(error.details)).toBe(true);
            expect(error).not.toHaveProperty("cause");
            expect(error).not.toBeInstanceOf(CandidateRejection);
            expect(error).not.toBeInstanceOf(ProfileConfigurationError);
        });
    }
});