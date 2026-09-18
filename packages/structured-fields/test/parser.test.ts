import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "../src/parse.js";
import { parseRaw } from "../src/parser.js";
import { SfSyntaxError } from "../src/errors.js";
import { SfLimitError } from "../src/limits.js";
import type { BareItem, Field, FieldType, Member, Parameters } from "../src/types.js";

interface Fixture {
    readonly name: string;
    readonly raw: readonly string[];
    readonly header_type: FieldType;
    readonly expected?: unknown;
    readonly must_fail?: boolean;
    readonly can_fail?: boolean;
}

// Independent test representation: upstream binary expectations use base32.
function base32(bytes: Uint8Array): string {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let result = "";
    let accumulator = 0;
    let bits = 0;
    for (const byte of bytes) {
        accumulator = (accumulator << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            bits -= 5;
            result += alphabet[(accumulator >>> bits) & 31];
        }
        accumulator &= (1 << bits) - 1;
    }
    if (bits) result += alphabet[(accumulator << (5 - bits)) & 31];
    while (result.length % 8) result += "=";
    return result;
}

function expectedBare(value: BareItem): unknown {
    switch (value.kind) {
        case "integer": return value.value;
        case "decimal": return value.thousandths / 1000;
        case "string": case "boolean": return value.value;
        case "token": return { __type: "token", value: value.value };
        case "bytes": return { __type: "binary", value: base32(value.value) };
        case "date": return { __type: "date", value: value.epochSeconds };
        case "display-string": return { __type: "displaystring", value: value.value };
    }
}
function expectedParameters(value: Parameters): unknown {
    return value.map(([key, bare]) => [key, expectedBare(bare)]);
}
function expectedMember(value: Member): unknown {
    return [
        value.kind === "item" ? expectedBare(value.bare) : value.items.map(expectedMember),
        expectedParameters(value.parameters),
    ];
}
function expectedField(value: Field): unknown {
    switch (value.kind) {
        case "item": return expectedMember(value);
        case "list": return value.members.map(expectedMember);
        case "dictionary": return value.entries.map(([key, member]) => [key, expectedMember(member)]);
    }
}

const fixtures = fileURLToPath(new URL("./fixtures/httpwg/", import.meta.url));
for (const file of readdirSync(fixtures).filter((name) => name.endsWith(".json")).sort()) {
    // Read pinned bytes. JSON decoding is for numeric semantic comparisons only:
    // exact integer/decimal distinctions are checked below and in serialization tests.
    const bytes = readFileSync(new URL(`./fixtures/httpwg/${file}`, import.meta.url));
    const cases = JSON.parse(bytes.toString("utf8")) as Fixture[];
    describe(`HTTP WG parsing: ${file}`, () => {
        for (const fixture of cases) {
            it(fixture.name, () => {
                const input = Buffer.from(fixture.raw.join(", "), "utf8");
                if (fixture.must_fail) {
                    expect(() => parse(input, fixture.header_type)).toThrow(SfSyntaxError);
                    return;
                }
                let value: Field;
                try {
                    value = parse(input, fixture.header_type);
                } catch (error) {
                    // Only upstream-designated optional failures may fail. Never swallow
                    // assertion errors, TypeErrors, or unexpected runtime exceptions.
                    if (fixture.can_fail && (error instanceof SfSyntaxError || error instanceof SfLimitError)) {
                        return;
                    }
                    throw error;
                }
                expect(expectedField(value)).toEqual(fixture.expected);
            });
        }
    });
}

describe("lossless raw AST and semantic ordering", () => {
    it("keeps duplicates and original text while semantics replace in place", () => {
        const source = "  a=01;x=1;y=2;x=3, b, a=2.0;z  ";
        const raw = parseRaw(source, "dictionary");
        expect(raw.source).toBe(source);
        expect(raw.root.entries.map((entry) => entry.key)).toEqual(["a", "b", "a"]);
        const first = raw.root.entries[0]!.member;
        expect(first.parameters.map((parameter) => parameter.key)).toEqual(["x", "y", "x"]);
        expect(source.slice(first.start, first.end)).toBe("01;x=1;y=2;x=3");
        const result = parse(source, "dictionary");
        expect(result.entries.map(([key]) => key)).toEqual(["a", "b"]);
        expect(result.entries[0]![1]).toMatchObject({
            bare: { kind: "decimal", thousandths: 2000 },
        });
        const single = parse("01;x=1;y=2;x=3", "item");
        expect(single.parameters).toEqual([
            ["x", { kind: "integer", value: 3 }],
            ["y", { kind: "integer", value: 2 }],
        ]);
    });

    it("distinguishes integer, decimal, token, string, and date", () => {
        const result = parse('1, 1.0, a, "a", @1', "list");
        expect(result.members.map((value) => value.kind === "item" && value.bare.kind))
            .toEqual(["integer", "decimal", "token", "string", "date"]);
    });

    it("preserves a leading Unicode BOM in a display string", () => {
        expect(parse('%"%ef%bb%bfhello"', "item").bare).toEqual({
            kind: "display-string", value: "\uFEFFhello",
        });
    });

    it.each(['%"%ed%a0%80"', '%"%c0%80"', '%"%f4%90%80%80"', '("nested" ())'])(
        "rejects invalid UTF-8 or nesting %s",
        (source) => expect(() => parse(source, "list")).toThrow(SfSyntaxError),
    );

    it("does not modify input byte arrays", () => {
        const bytes = Buffer.from('"hello";a=1');
        const before = Buffer.from(bytes);
        parse(bytes, "item");
        expect(bytes).toEqual(before);
    });
});

describe("parser resource accounting", () => {
    it.each([
        ["a=1,a=2", "dictionary", { maxMembers: 1 }, "maxMembers", 2],
        ["1;a=1;a=2", "item", { maxParameters: 1 }, "maxParameters", 2],
        ["(1 2)", "list", { maxInnerListItems: 1 }, "maxInnerListItems", 2],
        ["a=1", "dictionary", { maxKeyLength: 0 }, "maxKeyLength", 1],
        ['"ab"', "item", { maxDecodedBytes: 1 }, "maxDecodedBytes", 2],
        [":YWJj:", "item", { maxDecodedBytes: 2 }, "maxDecodedBytes", 3],
        ['%"%c3%bc"', "item", { maxDecodedBytes: 1 }, "maxDecodedBytes", 2],
        ["abc", "item", { maxTokenLength: 2 }, "maxTokenLength", 3],
        ["1;a", "item", { maxTotalOccurrences: 1 }, "maxTotalOccurrences", 2],
    ] as const)("checks %s against %s budgets", (input, type, limits, limit, observed) => {
        try {
            parseRaw(input, type, { limits });
            expect.unreachable("Expected limit rejection");
        } catch (error) {
            expect(error).toBeInstanceOf(SfLimitError);
            expect(error).toMatchObject({ limit, observed });
        }
    });
});