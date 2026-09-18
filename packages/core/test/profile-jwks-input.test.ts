import { describe, expect, it } from "vitest";
import { snapshotJwksInput } from "../src/profiles/jwks-input.js";
import { ProfileConfigurationError } from "../src/profiles/codes.js";

const budget = 262_144;

describe("bounded local JWKS configuration input", () => {
    it("accepts text and UTF-8 bytes at the exact input boundary", () => {
        const source = '{"keys":[]}';
        const bytes = Buffer.from(source);
        expect(snapshotJwksInput(source, bytes.length)).toEqual({ keys: [] });
        expect(snapshotJwksInput(bytes, bytes.length)).toEqual({ keys: [] });
        for (const input of [source, bytes]) {
            expect(() => snapshotJwksInput(input, bytes.length - 1))
                .toThrow(expect.objectContaining({ code: "invalid-jwks" }));
        }
    });

    it("counts UTF-8 bytes rather than JavaScript string length", () => {
        const source = '{"keys":[],"note":"ü😀"}';
        const size = Buffer.byteLength(source);
        expect(size).toBeGreaterThan(source.length);
        expect(snapshotJwksInput(source, size))
            .toEqual({ keys: [], note: "ü😀" });
        expect(() => snapshotJwksInput(source, size - 1))
            .toThrow(ProfileConfigurationError);
    });

    it.each([
        "{", '{"keys":', '{"keys":[],}', "",
        Buffer.from([0xff]), Buffer.from([0xc3, 0x28]),
    ])("rejects malformed JSON or invalid UTF-8 %#", (input) => {
        expect(() => snapshotJwksInput(input, budget))
            .toThrow(expect.objectContaining({ code: "invalid-jwks" }));
    });

    it("preserves the RFC-permitted last-member-wins JSON behavior", () => {
        expect(snapshotJwksInput('{"keys":[1],"keys":[]}', budget))
            .toEqual({ keys: [] });
    });

    it("copies object input without retaining mutable references", () => {
        const input = { keys: [{ kty: "OKP", nested: { value: [1, 2] } }] };
        const copied = snapshotJwksInput(input, budget);
        expect(copied).toEqual(input);
        input.keys[0]!.nested.value[0] = 99;
        expect(copied).toEqual({
            keys: [{ kty: "OKP", nested: { value: [1, 2] } }],
        });
    });

    it.each([
        { keys: [] },
        { keys: [], note: 'quote"slash\\\t\n' },
        { keys: [], note: "ü😀" },
        { keys: [], note: "\ud800" },
        { keys: [], nested: [null, true, false, 1.5, -0] },
    ])("accounts for JSON encoding before growing the object snapshot %#", (input) => {
        const size = Buffer.byteLength(JSON.stringify(input));
        expect(snapshotJwksInput(input, size)).toEqual(input);
        expect(() => snapshotJwksInput(input, size - 1))
            .toThrow(ProfileConfigurationError);
    });

    it("rejects property getters without invoking them", () => {
        let reads = 0;
        const input = Object.defineProperty({}, "keys", {
            enumerable: true,
            get() {
                reads++;
                return [];
            },
        });
        expect(() => snapshotJwksInput(input, budget))
            .toThrow(ProfileConfigurationError);
        expect(reads).toBe(0);
    });

    it("rejects array element getters and sparse arrays", () => {
        let reads = 0;
        const values = Object.defineProperty([], "0", {
            enumerable: true,
            get() {
                reads++;
                return "key";
            },
        });
        expect(() => snapshotJwksInput({ keys: values }, budget))
            .toThrow(ProfileConfigurationError);
        expect(reads).toBe(0);
        expect(() => snapshotJwksInput({ keys: new Array(2) }, budget))
            .toThrow(ProfileConfigurationError);
    });

    it("rejects cycles but accepts independently copied shared subtrees", () => {
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        expect(() => snapshotJwksInput(cyclic, budget))
            .toThrow(ProfileConfigurationError);
        const shared = { value: 1 };
        expect(snapshotJwksInput({ a: shared, b: shared }, budget))
            .toEqual({ a: { value: 1 }, b: { value: 1 } });
    });

    it.each([undefined, NaN, Infinity, 1n, () => 1, new Date()])(
        "rejects non-JSON object contents %#", (value) => {
            expect(() => snapshotJwksInput({ keys: [], value }, budget))
                .toThrow(ProfileConfigurationError);
        },
    );

    it("keeps __proto__ as data without changing result prototypes", () => {
        const input = JSON.parse('{"keys":[],"__proto__":{"polluted":true}}');
        const result = snapshotJwksInput(input, budget) as Record<string, unknown>;
        expect(Object.getPrototypeOf(result)).toBe(null);
        expect(Object.hasOwn(result, "__proto__")).toBe(true);
        expect(Object.hasOwn({}, "polluted")).toBe(false);
    });

    it("handles deep object input without using the JavaScript call stack", () => {
        let input: unknown = null;
        for (let index = 0; index < 5000; index++) input = [input];
        expect(() => snapshotJwksInput(input, 10_004)).not.toThrow();
        expect(() => snapshotJwksInput(input, 100))
            .toThrow(ProfileConfigurationError);
    });

    it("does not execute toJSON methods", () => {
        let calls = 0;
        const input = {
            keys: [],
            toJSON() {
                calls++;
                return { keys: [] };
            },
        };
        expect(() => snapshotJwksInput(input, budget))
            .toThrow(ProfileConfigurationError);
        expect(calls).toBe(0);
    });
});