import { readFileSync } from "node:fs";
import { getParameter, parse } from "@agentsig/structured-fields";
import { describe, expect, it } from "vitest";
import { resolveCoreLimits } from "../src/limits.js";
import { parseSignatureHeaders } from "../src/signature-input.js";
import type { HeaderFields } from "../src/types.js";
import {
    assertNoAgentDuplicates,
    assertNoSignatureDuplicates,
    DuplicateFieldRejection,
} from "../src/profiles/duplicates.js";

const limits = resolveCoreLimits();
const matrix = JSON.parse(readFileSync(new URL(
    "../../../tests/fixtures/profiles/duplicate-cases.json", import.meta.url,
), "utf8")) as {
    cases: {
        id: string;
        headers: HeaderFields;
        expected: { status: "invalid"; code: string; repeatedName: string };
    }[];
};

describe("profile duplicate screening — pinned raw expectations", () => {
    for (const fixture of matrix.cases) {
        it(fixture.id, () => {
            const run = () => {
                assertNoSignatureDuplicates(fixture.headers, limits);
                const agent = fixture.headers
                    .filter(([name]) => name === "signature-agent")
                    .map(([, value]) => value).join(", ");
                assertNoAgentDuplicates(agent, limits);
            };
            let caught: unknown;
            try { run(); } catch (error) { caught = error; }
            expect(caught).toBeInstanceOf(DuplicateFieldRejection);
            const error = caught as DuplicateFieldRejection;
            expect(error.rejection).toEqual({
                status: fixture.expected.status, reason: fixture.expected.code,
            });
            expect(error.repeatedName).toBe(fixture.expected.repeatedName);
            expect(error.message).toContain(JSON.stringify(fixture.expected.repeatedName));
            expect(error.message).not.toContain("https://");
        });
    }
});

describe("duplicate scopes, limits and M1 regression", () => {
    it("rejects a signature label repeated across field occurrences", () => {
        expect(() => assertNoSignatureDuplicates([
            ["Signature-Input", 'a=("@method")'],
            ["signature-input", 'a=("@target-uri")'],
            ["Signature", "a=:AA==:"],
        ], limits)).toThrow(expect.objectContaining({ repeatedName: "a" }));
    });

    it("rejects repeated Signature value parameters", () => {
        expect(() => assertNoSignatureDuplicates([
            ["signature-input", 'a=("@method")'],
            ["signature", "a=:AA==:;ext=1;ext=2"],
        ], limits)).toThrow(expect.objectContaining({
            rejection: { status: "invalid", reason: "malformed-signature" },
            repeatedName: "ext",
        }));
    });

    it.each([
        'a="https://agent.example";type=directory;type=directory',
        '"https://agent.example";ext=1;ext=2',
    ])("rejects repeated agent parameters: %s", (text) => {
        expect(() => assertNoAgentDuplicates(text, limits)).toThrow(
            expect.objectContaining({
                rejection: { status: "invalid", reason: "malformed-agent" },
            }),
        );
    });

    it("allows the same parameter name in separate semantic scopes", () => {
        expect(() => assertNoSignatureDuplicates([
            ["signature-input", 'a=("x";key="one" "y";key="two");created=1, b=("@method");created=2'],
            ["signature", "a=:AA==:, b=:AQ==:"],
        ], limits)).not.toThrow();
        expect(() => assertNoAgentDuplicates(
            'a="https://a.example";type=directory, b="https://b.example";type=directory',
            limits,
        )).not.toThrow();
    });

    it("preserves resource-limit classification rather than reporting malformed input", () => {
        const narrow = resolveCoreLimits({ structuredFields: { maxParameters: 1 } });
        expect(() => assertNoAgentDuplicates(
            'a="https://agent.example";x=1;x=2', narrow,
        )).toThrow(expect.objectContaining({
            rejection: { status: "unverified", reason: "resource-limit" },
        }));
        expect(() => assertNoSignatureDuplicates([
            ["signature-input", 'a=("@method")'],
            ["signature", "a=:AA==:"],
        ], resolveCoreLimits({ maxSignatureHeaderBytes: 1 }))).toThrow(
            expect.objectContaining({
                rejection: { status: "unverified", reason: "resource-limit" },
            }),
        );
    });

    it("does not retry another grammar after a malformed agent field", () => {
        expect(() => assertNoAgentDuplicates(
            '"https://agent.example", a="https://other.example"', limits,
        )).toThrow(expect.objectContaining({
            rejection: { status: "invalid", reason: "malformed-agent" },
        }));
    });

    it("leaves M1 and general Structured Fields last-value semantics unchanged", () => {
        const headers: HeaderFields = [
            ["signature-input", 'a=("@method");created=1;created=2'],
            ["signature", "a=:AA==:"],
        ];
        expect(getParameter(parseSignatureHeaders(headers)[0]!.input.parameters, "created"))
            .toEqual({ kind: "integer", value: 2 });
        expect(parse("a=1, a=2", "dictionary").entries[0]![1])
            .toMatchObject({ bare: { kind: "integer", value: 2 } });
        expect(() => assertNoSignatureDuplicates(headers, limits))
            .toThrow(DuplicateFieldRejection);
    });

    it("bounds diagnostic names without reflecting parameter values", () => {
        const name = "a".repeat(300);
        const error = new DuplicateFieldRejection("malformed-signature", name);
        expect(error.repeatedName).toBe(name);
        expect(error.message).toContain("[truncated]");
        expect(error.message.length).toBeLessThan(400);
    });
});