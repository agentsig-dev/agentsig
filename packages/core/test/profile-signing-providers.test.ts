import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
    readSigningNonce,
    readSigningTimestamps,
} from "../src/profiles/signing-providers.js";
import type {
    SigningClock,
    SigningNonceGenerator,
} from "../src/profiles/signing-providers.js";
import { SigningError } from "../src/profiles/signing-errors.js";

interface OutputDescriptor {
    readonly kind: string;
    readonly value?: string | number;
    readonly message?: string;
}
interface NegativeCase {
    readonly output: OutputDescriptor;
    readonly expectedCode: string;
}
const fixtures = JSON.parse(readFileSync(new URL(
    "../../../tests/fixtures/signing/negative-cases.json", import.meta.url,
), "utf8")) as {
    readonly clock: readonly NegativeCase[];
    readonly nonce: readonly NegativeCase[];
};

function provider(descriptor: OutputDescriptor): () => unknown {
    return () => {
        switch (descriptor.kind) {
            case "nan": return NaN;
            case "positive-infinity": return Infinity;
            case "negative-infinity": return -Infinity;
            case "number":
            case "string": return descriptor.value;
            case "null": return null;
            case "undefined": return undefined;
            case "object": return {};
            case "promise": return Promise.resolve("not-synchronous");
            case "throw": throw new Error(descriptor.message);
            default: throw new Error("Unknown fixture descriptor");
        }
    };
}

describe("signing providers — pre-implementation negative fixtures", () => {
    for (const group of ["clock", "nonce"] as const) {
        for (const [index, fixture] of fixtures[group].entries()) {
            it(`${group} ${index}: ${fixture.output.kind}`, () => {
                let calls = 0;
                const output = provider(fixture.output);
                const supplied = () => { calls++; return output(); };
                let caught: unknown;
                try {
                    // Casts deliberately exercise runtime output checks that
                    // JavaScript consumers can bypass at the type boundary.
                    if (group === "clock") {
                        readSigningTimestamps(supplied as SigningClock, 60);
                    } else {
                        readSigningNonce(supplied as SigningNonceGenerator, 256);
                    }
                } catch (error) {
                    caught = error;
                }
                expect(calls).toBe(1);
                expect(caught).toBeInstanceOf(SigningError);
                const error = caught as SigningError;
                expect(error.code).toBe(fixture.expectedCode);
                expect(error.details).toEqual({});
                expect(error).not.toHaveProperty("cause");
                expect(error.message).not.toContain("PRIVATE-PROVIDER-MARKER");
                expect(JSON.stringify(error)).not.toContain("PRIVATE-PROVIDER-MARKER");
                expect(error.stack).not.toContain("PRIVATE-PROVIDER-MARKER");
            });
        }
    }
});

describe("signing timestamp arithmetic", () => {
    it.each([
        { milliseconds: 0, created: 0 },
        { milliseconds: 0.5, created: 0 },
        { milliseconds: 999.999, created: 0 },
        { milliseconds: 1000, created: 1 },
        { milliseconds: 1800000000999.5, created: 1800000000 },
    ])("floors $milliseconds milliseconds exactly once", ({ milliseconds, created }) => {
        let calls = 0;
        const result = readSigningTimestamps(() => { calls++; return milliseconds; }, 60);
        expect(calls).toBe(1);
        expect(result).toEqual({ created, expires: created + 60 });
        expect(Number.isInteger(result.created)).toBe(true);
        expect(Number.isInteger(result.expires)).toBe(true);
        expect(Object.isFrozen(result)).toBe(true);
    });

    it("accepts the maximum representable expiry and rejects overflow", () => {
        const maximum = 999_999_999_999_999;
        // At these magnitudes milliseconds have coarse floating-point spacing.
        // Choose a representable sample and derive its exact integer second.
        const milliseconds = 999_999_999_999_998_000;
        const created = Math.floor(milliseconds / 1000);
        const lifetime = maximum - created;
        expect(lifetime).toBeGreaterThan(0);
        expect(readSigningTimestamps(() => milliseconds, lifetime))
            .toEqual({ created, expires: maximum });
        expect(() => readSigningTimestamps(() => milliseconds, lifetime + 1))
            .toThrow(expect.objectContaining({ code: "clock-unavailable" }));
    });

    it.each([0, -1, 0.5, NaN, Infinity, 1_000_000_000_000_000])(
        "rejects invalid lifetime %s without invoking the clock", (lifetime) => {
            let calls = 0;
            expect(() => readSigningTimestamps(() => { calls++; return 0; }, lifetime))
                .toThrow(expect.objectContaining({ code: "invalid-signing-options" }));
            expect(calls).toBe(0);
        },
    );
});

describe("nonce provider boundary", () => {
    it("preserves quotes, backslashes and spaces for the SF serializer", () => {
        const nonce = ' quote"slash\\end ';
        let calls = 0;
        expect(readSigningNonce(() => { calls++; return nonce; }, 256)).toBe(nonce);
        expect(calls).toBe(1);
    });

    it("accepts the exact configured limit and rejects the next byte", () => {
        expect(readSigningNonce(() => "a".repeat(256), 256)).toHaveLength(256);
        expect(() => readSigningNonce(() => "a".repeat(257), 256))
            .toThrow(expect.objectContaining({ code: "nonce-generation-failed" }));
        expect(readSigningNonce(() => "ab", 2)).toBe("ab");
        expect(() => readSigningNonce(() => "ab", 1))
            .toThrow(expect.objectContaining({ code: "nonce-generation-failed" }));
    });

    it.each([0, -1, 1.5, NaN, Infinity])(
        "rejects invalid nonce budget %s before invoking its provider", (maximum) => {
            let calls = 0;
            expect(() => readSigningNonce(() => { calls++; return "nonce"; }, maximum))
                .toThrow(expect.objectContaining({ code: "invalid-signing-options" }));
            expect(calls).toBe(0);
        },
    );

    it("sanitizes even typed errors thrown by custom providers", () => {
        const thrown = new SigningError("invalid-signing-key");
        thrown.message = "PRIVATE-PROVIDER-MARKER";
        expect(() => readSigningTimestamps(() => { throw thrown; }, 60))
            .toThrow("Web Bot Auth signing failed: clock-unavailable");
        expect(() => readSigningNonce(() => { throw thrown; }, 256))
            .toThrow("Web Bot Auth signing failed: nonce-generation-failed");
    });
});