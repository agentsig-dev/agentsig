import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parse } from "../src/parse.js";
import { parseRaw } from "../src/parser.js";
import { serialize } from "../src/serializer.js";
import { SfSerializationError, SfSyntaxError } from "../src/errors.js";
import { SfLimitError } from "../src/limits.js";
import type { BareItem, Field, FieldType, Item, Member, Parameters } from "../src/types.js";

const settings = { seed: 96519421, numRuns: 1000 };
const ascii = fc.array(fc.integer({ min: 32, max: 126 }), { maxLength: 40 })
    .map((codes) => String.fromCharCode(...codes));
const scalar = fc.oneof(
    fc.integer({ min: 0, max: 0xd7ff }),
    fc.integer({ min: 0xe000, max: 0x10ffff }),
);
const unicode = fc.array(scalar, { maxLength: 24 })
    .map((codes) => String.fromCodePoint(...codes));

const bare: fc.Arbitrary<BareItem> = fc.oneof(
    fc.integer({ min: -999_999_999_999_999, max: 999_999_999_999_999 })
        .map((value): BareItem => ({ kind: "integer", value })),
    fc.integer({ min: -999_999_999_999_999, max: 999_999_999_999_999 })
        .map((thousandths): BareItem => ({ kind: "decimal", thousandths })),
    ascii.map((value): BareItem => ({ kind: "string", value })),
    fc.constantFrom("a", "*", "text/plain", "A:B", "a!#$%&'*+-.^_`|~")
        .map((value): BareItem => ({ kind: "token", value })),
    fc.uint8Array({ maxLength: 64 })
        .map((value): BareItem => ({ kind: "bytes", value })),
    fc.boolean().map((value): BareItem => ({ kind: "boolean", value })),
    fc.integer({ min: -999_999_999_999_999, max: 999_999_999_999_999 })
        .map((epochSeconds): BareItem => ({ kind: "date", epochSeconds })),
    unicode.map((value): BareItem => ({ kind: "display-string", value })),
);
const parameters: fc.Arbitrary<Parameters> = fc.array(bare, { maxLength: 5 })
    .map((values) => values.map((value, index) => [`p${index}`, value] as const));
const item: fc.Arbitrary<Item> = fc.tuple(bare, parameters)
    .map(([value, params]) => ({ kind: "item", bare: value, parameters: params }));
const member: fc.Arbitrary<Member> = fc.oneof(
    item,
    fc.tuple(fc.array(item, { maxLength: 5 }), parameters)
        .map(([items, params]): Member => ({
            kind: "inner-list", items, parameters: params,
        })),
);
const field: fc.Arbitrary<Field> = fc.oneof(
    item,
    fc.array(member, { maxLength: 6 })
        .map((members): Field => ({ kind: "list", members })),
    fc.array(member, { maxLength: 6 })
        .map((members): Field => ({
            kind: "dictionary",
            entries: members.map((value, index) => [`k${index}`, value] as const),
        })),
);

describe("deterministic Structured Fields properties", () => {
    it("round-trips generated semantic models and produces stable ASCII", () => {
        fc.assert(fc.property(field, (value) => {
            const wire = serialize(value);
            expect(/^[\x20-\x7e]*$/.test(wire)).toBe(true);
            const parsed = parse(Buffer.from(wire, "ascii"), value.kind);
            expect(parsed).toEqual(value);
            expect(serialize(parsed)).toBe(wire);
        }), settings);
    });

    it("arbitrary bytes either parse completely or raise a typed rejection", () => {
        fc.assert(fc.property(
            fc.uint8Array({ maxLength: 256 }),
            fc.constantFrom<FieldType>("item", "list", "dictionary"),
            (bytes, type) => {
                let parsed: Field;
                try {
                    parsed = parse(bytes, type);
                } catch (error) {
                    expect(error instanceof SfSyntaxError || error instanceof SfLimitError).toBe(true);
                    return;
                }
                const canonical = serialize(parsed);
                expect(serialize(parse(canonical, type))).toBe(canonical);
                expect(parseRaw(bytes, type).source).toBe(Buffer.from(bytes).toString("ascii"));
            },
        ), { ...settings, numRuns: 5000 });
    });

    it("input budget rejects before accepting a syntactically valid token", () => {
        fc.assert(fc.property(fc.integer({ min: 1, max: 512 }), (size) => {
            const token = "a".repeat(size);
            expect(() => parse(token, "item", {
                limits: { maxInputBytes: size - 1 },
            })).toThrow(SfLimitError);
            expect(parse(token, "item", {
                limits: { maxInputBytes: size },
            }).bare).toEqual({ kind: "token", value: token });
        }), settings);
    });

    it("output budget includes every canonical byte", () => {
        fc.assert(fc.property(field, (value) => {
            const wire = serialize(value);
            expect(serialize(value, { limits: { maxOutputBytes: wire.length } })).toBe(wire);
            if (wire.length > 0) {
                expect(() => serialize(value, {
                    limits: { maxOutputBytes: wire.length - 1 },
                })).toThrow(SfLimitError);
            }
        }), settings);
    });

    it("raw duplicate occurrences cannot bypass semantic-map budgets", () => {
        fc.assert(fc.property(fc.integer({ min: 2, max: 40 }), (count) => {
            const wire = Array.from({ length: count }, (_, index) => `a=${index}`).join(",");
            expect(parse(wire, "dictionary").entries).toHaveLength(1);
            expect(parseRaw(wire, "dictionary").root.entries).toHaveLength(count);
            expect(() => parse(wire, "dictionary", {
                limits: { maxMembers: count - 1 },
            })).toThrow(SfLimitError);
        }), settings);
    });
});

describe("serialization delimiter-injection regressions", () => {
    it.each(["\n", "\r", "\r\n", "\u2028", "\u2029"])(
        "rejects line terminator %j after a valid key or token",
        (suffix) => {
            const value: Item = {
                kind: "item", bare: { kind: "integer", value: 1 }, parameters: [],
            };
            expect(() => serialize({
                kind: "dictionary", entries: [[`a${suffix}`, value]],
            })).toThrow(SfSerializationError);
            expect(() => serialize({
                ...value, bare: { kind: "token", value: `a${suffix}` },
            })).toThrow(SfSerializationError);
            expect(() => serialize({
                ...value, parameters: [[`a${suffix}`, { kind: "boolean", value: true }]],
            })).toThrow(SfSerializationError);
        },
    );
});