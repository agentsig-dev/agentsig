import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decimalFromString } from "../src/decimal.js";
import { SfSerializationError, SfSyntaxError } from "../src/errors.js";
import { SfLimitError } from "../src/limits.js";
import { parse } from "../src/parse.js";
import { serialize } from "../src/serializer.js";
import type { BareItem, Field, FieldType, Item, Member, Parameters } from "../src/types.js";

interface Fixture {
    name: string;
    header_type: FieldType;
    raw?: string[];
    expected?: unknown;
    canonical?: string[];
    must_fail?: boolean;
    can_fail?: boolean;
}

/**
 * Test-only JSON lexical adapter. Quoted JSON strings are consumed whole, so
 * numeric text inside a string is never rewritten. Decimal number lexemes are
 * retained before JSON.parse can erase the distinction between 1 and 1.0.
 * This does not call the SF parser or derive anything from canonical output.
 */
function load(url: URL): Fixture[] {
    const source = readFileSync(url).toString("utf8");
    const retained = source.replace(
        /"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
        (token) => token.startsWith('"') || !/[.eE]/.test(token)
            ? token
            : JSON.stringify({ fixtureDecimal: token }),
    );
    return JSON.parse(retained) as Fixture[];
}

function array(input: unknown): unknown[] {
    if (!Array.isArray(input)) throw new Error("Invalid upstream fixture array");
    return input;
}
function base32(input: string): Uint8Array {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    const output: number[] = [];
    let accumulator = 0;
    let bits = 0;
    for (const char of input.replace(/=+$/, "")) {
        const value = alphabet.indexOf(char);
        if (value < 0) throw new Error("Invalid upstream base32");
        accumulator = (accumulator << 5) | value;
        bits += 5;
        if (bits >= 8) {
            bits -= 8;
            output.push((accumulator >>> bits) & 255);
        }
        accumulator &= (1 << bits) - 1;
    }
    return Uint8Array.from(output);
}
function bare(input: unknown): BareItem {
    if (typeof input === "number") return { kind: "integer", value: input };
    if (typeof input === "string") return { kind: "string", value: input };
    if (typeof input === "boolean") return { kind: "boolean", value: input };
    if (input === null || typeof input !== "object") throw new Error("Invalid fixture bare value");
    const value = input as Record<string, unknown>;
    if (typeof value.fixtureDecimal === "string") {
        // The exact decimal constructor is part of the system under test, not an
        // expectation generator: its result must serialize to upstream's literal.
        return decimalFromString(value.fixtureDecimal);
    }
    switch (value.__type) {
        case "token": return { kind: "token", value: value.value as string };
        case "binary": return { kind: "bytes", value: base32(value.value as string) };
        case "date": return { kind: "date", epochSeconds: value.value as number };
        case "displaystring": return { kind: "display-string", value: value.value as string };
        default: throw new Error("Unknown upstream fixture type");
    }
}
function parameters(input: unknown): Parameters {
    return array(input).map((entry) => {
        const pair = array(entry);
        return [pair[0] as string, bare(pair[1])] as const;
    });
}
function member(input: unknown): Member {
    const tuple = array(input);
    if (Array.isArray(tuple[0])) {
        return {
            kind: "inner-list",
            items: tuple[0].map((entry) => member(entry) as Item),
            parameters: parameters(tuple[1]),
        };
    }
    return { kind: "item", bare: bare(tuple[0]), parameters: parameters(tuple[1]) };
}
function field(input: unknown, type: FieldType): Field {
    if (type === "item") return member(input) as Item;
    if (type === "list") return { kind: "list", members: array(input).map(member) };
    return {
        kind: "dictionary",
        entries: array(input).map((entry) => {
            const pair = array(entry);
            return [pair[0] as string, member(pair[1])] as const;
        }),
    };
}

for (const directory of ["", "serialisation-tests/"]) {
    const url = new URL(`./fixtures/httpwg/${directory}`, import.meta.url);
    for (const filename of readdirSync(fileURLToPath(url)).filter((name) => name.endsWith(".json")).sort()) {
        const fixtures = load(new URL(filename, url));
        describe(`HTTP WG serialization: ${directory}${filename}`, () => {
            for (const fixture of fixtures) {
                // Parse-negative cases have no semantic serialization input.
                if (directory === "" && fixture.must_fail) continue;
                it(fixture.name, () => {
                    if (fixture.must_fail) {
                        expect(() => serialize(field(fixture.expected, fixture.header_type)))
                            .toThrow(SfSerializationError);
                        return;
                    }
                    const expected = (fixture.canonical ?? fixture.raw ?? []).join(", ");
                    expect(serialize(field(fixture.expected, fixture.header_type))).toBe(expected);
                    if (fixture.raw) {
                        let parsed: Field;
                        try {
                            parsed = parse(Buffer.from(fixture.raw.join(", ")), fixture.header_type);
                        } catch (error) {
                            if (fixture.can_fail && (error instanceof SfSyntaxError || error instanceof SfLimitError)) {
                                return;
                            }
                            throw error;
                        }
                        expect(serialize(parsed)).toBe(expected);
                    }
                });
            }
        });
    }
}

describe("serializer validation and budgets", () => {
    const item = (bare: BareItem): Item => ({ kind: "item", bare, parameters: [] });

    it.each(["\uD800", "\uDC00", "\uD800x"])("rejects lone surrogate %j", (value) => {
        expect(() => serialize(item({ kind: "display-string", value })))
            .toThrow(SfSerializationError);
    });
    it("preserves valid supplementary Unicode and BOM", () => {
        expect(serialize(item({ kind: "display-string", value: "\uFEFF😀" })))
            .toBe('%"%ef%bb%bf%f0%9f%98%80"');
    });
    it("rejects duplicate semantic keys rather than silently choosing a value", () => {
        expect(() => serialize({
            kind: "dictionary",
            entries: [["a", item({ kind: "integer", value: 1 })], ["a", item({ kind: "integer", value: 2 })]],
        })).toThrow(SfSerializationError);
        expect(() => serialize({
            ...item({ kind: "boolean", value: true }),
            parameters: [["a", { kind: "boolean", value: true }], ["a", { kind: "boolean", value: false }]],
        })).toThrow(SfSerializationError);
    });
    it("checks encoded byte budget before base64 allocation", () => {
        expect(() => serialize(item({ kind: "bytes", value: new Uint8Array(3) }), {
            limits: { maxOutputBytes: 5 },
        })).toThrow(SfLimitError);
    });
    it("counts escaping and UTF-8 expansion in output budgets", () => {
        expect(() => serialize(item({ kind: "string", value: '"' }), {
            limits: { maxOutputBytes: 3 },
        })).toThrow(SfLimitError);
        expect(() => serialize(item({ kind: "display-string", value: "ü" }), {
            limits: { maxOutputBytes: 8 },
        })).toThrow(SfLimitError);
    });
    it("rejects aggregate exhaustion with individually valid members", () => {
        expect(() => serialize({
            kind: "list", members: [item({ kind: "integer", value: 1 }), item({ kind: "integer", value: 2 })],
        }, { limits: { maxTotalOccurrences: 1 } })).toThrow(SfLimitError);
    });
    it("represents empty containers as omission-compatible empty output", () => {
        expect(serialize({ kind: "list", members: [] })).toBe("");
        expect(serialize({ kind: "dictionary", entries: [] })).toBe("");
    });
});