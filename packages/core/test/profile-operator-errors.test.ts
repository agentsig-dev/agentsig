import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
    OPERATOR_ERROR_CODES,
    OPERATOR_ERROR_CATALOG_VERSION,
    OperatorError,
} from "../src/profiles/operator-errors.js";
import {
    CandidateRejection,
    ProfileConfigurationError,
    RESULT_CODES,
} from "../src/profiles/codes.js";
import { SigningError } from "../src/profiles/signing-errors.js";

const root = new URL("../../../tests/fixtures/reset/", import.meta.url);
const contract = JSON.parse(readFileSync(new URL("contract.json", root), "utf8")) as {
    catalogVersion: number;
    frozen: boolean;
    codes: readonly string[];
    separateFrom: readonly string[];
};
const manifest = JSON.parse(readFileSync(new URL("manifest.json", root), "utf8")) as {
    catalogSha256: string;
};

describe("independent frozen operator error catalog", () => {
    it("matches the fixture version, complete code list and byte digest", () => {
        expect(contract.frozen).toBe(true);
        expect(OPERATOR_ERROR_CATALOG_VERSION).toBe(contract.catalogVersion);
        expect(OPERATOR_ERROR_CODES).toEqual(contract.codes);
        expect(OPERATOR_ERROR_CODES).toHaveLength(4);
        expect(new Set(OPERATOR_ERROR_CODES).size).toBe(4);
        expect(Object.isFrozen(OPERATOR_ERROR_CODES)).toBe(true);
        expect(createHash("sha256").update(JSON.stringify(OPERATOR_ERROR_CODES)).digest("hex"))
            .toBe(manifest.catalogSha256);
    });

    it("does not extend the request verification catalog with operator codes", () => {
        expect(contract.separateFrom).toEqual(["verification-catalog", "signing-catalog"]);
        const verificationCodes: readonly string[] = Object.values(RESULT_CODES).flat();
        for (const code of OPERATOR_ERROR_CODES) {
            expect(verificationCodes).not.toContain(code);
        }
        expect(RESULT_CODES.unverified).toContain("clock-unavailable");
    });

    for (const code of OPERATOR_ERROR_CODES) {
        it(`exposes only the stable operator boundary for ${code}`, () => {
            const error = new OperatorError(code);
            expect(error).toBeInstanceOf(Error);
            expect(error.name).toBe("OperatorError");
            expect(error.code).toBe(code);
            expect(error.message).toBe(`Web Bot Auth operator action failed: ${code}`);
            expect(error.details).toEqual({});
            expect(Object.isFrozen(error.details)).toBe(true);
            expect(error).not.toHaveProperty("cause");
            expect(error).not.toBeInstanceOf(SigningError);
            expect(error).not.toBeInstanceOf(CandidateRejection);
            expect(error).not.toBeInstanceOf(ProfileConfigurationError);
            expect(Object.keys(error).sort()).toEqual(["code", "details", "name"]);
        });
    }
});