import { describe, expect, it } from "vitest";
import { decimalFromString } from "../src/decimal.js";
import { SfSerializationError } from "../src/errors.js";
import {
    Budget,
    DEFAULT_LIMITS,
    resolveLimits,
    SfConfigurationError,
    SfLimitError,
} from "../src/limits.js";

describe("exact decimal construction — RFC 9651 §4.1.5", () => {
    it.each([
        ["0", 0],
        ["-0.0000", 0],
        ["1.0", 1000],
        ["00001.2300", 1230],
        ["0.0015", 2],
        ["0.0025", 2],
        ["-0.0015", -2],
        ["-0.0025", -2],
        ["0.00250001", 3],
        ["-0.00250001", -3],
        ["9.9995", 10000],
        ["999999999999.9994", 999999999999999],
        ["123456789012.1", 123456789012100],
    ] as const)("converts %s to %s thousandths", (text, expected) => {
        expect(decimalFromString(text)).toEqual({
            kind: "decimal",
            thousandths: expected,
        });
    });

    it.each([
        "", "-", ".1", "1.", "+1", "1e3", " 1", "1 ", "1\n",
        "1.2.3", "１２", "NaN", "Infinity",
        "1000000000000", "999999999999.9995", "-999999999999.9995",
    ])("rejects invalid or overflowing input %j", (text) => {
        expect(() => decimalFromString(text)).toThrow(SfSerializationError);
    });

    it("does not create negative zero", () => {
        expect(Object.is(decimalFromString("-0.0001").thousandths, -0)).toBe(false);
    });

    it("checks the input budget before numeric validation", () => {
        expect(() => decimalFromString("invalid", {
            limits: { maxInputBytes: 3 },
        })).toThrow(SfLimitError);
    });
});

describe("operation-local resource budgets", () => {
    it("exports frozen defaults and resolves overrides without mutation", () => {
        const overrides = { maxInputBytes: 16_384 };
        const limits = resolveLimits(overrides);
        expect(Object.isFrozen(DEFAULT_LIMITS)).toBe(true);
        expect(Object.isFrozen(limits)).toBe(true);
        expect(limits.maxInputBytes).toBe(16_384);
        expect(DEFAULT_LIMITS.maxInputBytes).toBe(1_048_576);
        expect(overrides).toEqual({ maxInputBytes: 16_384 });
        expect(limits.maxMembers).toBe(DEFAULT_LIMITS.maxMembers);
    });

    it.each([-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])(
        "rejects invalid limit %s",
        (value) => {
            expect(() => resolveLimits({ maxMembers: value })).toThrow(SfConfigurationError);
        },
    );

    it("permits zero and reports the exact exceeded limit", () => {
        const budget = new Budget({ maxMembers: 0 });
        budget.check("maxMembers", 0);
        try {
            budget.check("maxMembers", 1);
            expect.unreachable("Expected a resource limit failure");
        } catch (error) {
            expect(error).toBeInstanceOf(SfLimitError);
            expect(error).toMatchObject({
                code: "SF_LIMIT_EXCEEDED",
                limit: "maxMembers",
                maximum: 0,
                observed: 1,
            });
        }
    });

    it("counts every occurrence, independently of eventual duplicate resolution", () => {
        const budget = new Budget({ maxTotalOccurrences: 2 });
        budget.consumeOccurrence();
        budget.consumeOccurrence();
        expect(() => budget.consumeOccurrence()).toThrow(SfLimitError);
        const independent = new Budget({ maxTotalOccurrences: 2 });
        expect(() => independent.consumeOccurrence()).not.toThrow();
    });

    it("rejects unknown options rather than silently ignoring misspellings", () => {
        const overrides = { maxMembers: 10, maxMember: 1 };
        expect(() => resolveLimits(overrides)).toThrow(SfConfigurationError);
    });
});