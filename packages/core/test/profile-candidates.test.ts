import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { HeaderFields } from "../src/types.js";
import { selectWebBotAuthCandidates } from "../src/profiles/candidates.js";

interface CandidateFixture {
    readonly id: string;
    readonly inputs?: readonly { label: string; tag: string }[];
    readonly expectedCandidateLabels?: readonly string[];
    readonly expectedResultLabels?: readonly string[];
    readonly expectedCode?: string;
}
const policy = JSON.parse(readFileSync(new URL(
    "../../../tests/fixtures/m2/policy-cases.json", import.meta.url,
), "utf8")) as { candidateCases: CandidateFixture[] };

function headers(inputs: readonly { label: string; tag: string }[]): HeaderFields {
    // Syntax fixtures only: these dummy bytes assert no cryptographic validity.
    return [
        ["signature-input", inputs.map(({ label, tag }) =>
            `${label}=("@method");tag="${tag}"`).join(", ")],
        ["signature", inputs.map(({ label }) => `${label}=:AA==:`).join(", ")],
    ];
}
const candidate = headers([{ label: "agent", tag: "web-bot-auth" }]);

describe("candidate selection against approved policy fixtures", () => {
    for (const fixture of policy.candidateCases.filter((entry) => entry.inputs)) {
        it(fixture.id, () => {
            const result = selectWebBotAuthCandidates(headers(fixture.inputs!));
            if (fixture.expectedCode === "no-web-bot-auth-candidate") {
                expect(result).toEqual({
                    kind: "unsigned", reason: "no-web-bot-auth-candidate",
                });
            } else {
                expect(result.kind).toBe("candidates");
                if (result.kind !== "candidates") throw new Error("Expected candidates");
                expect(result.candidates.map((entry) => entry.input.label)).toEqual(
                    fixture.expectedCandidateLabels ?? fixture.expectedResultLabels,
                );
                expect(result.signatures).toHaveLength(fixture.inputs!.length);
                expect(result).not.toHaveProperty("status");
                expect(result).not.toHaveProperty("verified");
            }
        });
    }

    it("distinguishes absent signatures from parsed signatures without matching tags", () => {
        expect(selectWebBotAuthCandidates([])).toEqual({
            kind: "unsigned", reason: "no-signature",
        });
        expect(selectWebBotAuthCandidates([
            ["signature-input", 'a=("@method")'], ["signature", "a=:AA==:"],
        ])).toEqual({ kind: "unsigned", reason: "no-web-bot-auth-candidate" });
    });

    it.each(([
        [["signature-input", 'a=("@method");tag="other"']],
        [["signature", "a=:AA==:"]],
        [["signature-input", 'a=("@method");tag="other"'], ["signature", "b=:AA==:"]],
        [["signature-input", 'a=("@method");tag="other"'], ["signature", "a=not-bytes"]],
        [["signature-input", 'a=("@method");tag=web-bot-auth'], ["signature", "a=:AA==:"]],
    ] satisfies HeaderFields[]).map((input) => ({ input })))(
        "never hides malformed pairs as unsigned %#", ({ input }) => {
            expect(() => selectWebBotAuthCandidates(input)).toThrow(
                expect.objectContaining({
                    rejection: { status: "invalid", reason: "malformed-signature" },
                }),
            );
        });

    it("rejects repeated tags before last-value semantics can conceal a candidate", () => {
        expect(() => selectWebBotAuthCandidates([
            ["signature-input", 'a=("@method");tag="web-bot-auth";tag="other"'],
            ["signature", "a=:AA==:"],
        ])).toThrow(expect.objectContaining({
            repeatedName: "tag",
            rejection: { status: "invalid", reason: "malformed-signature" },
        }));
    });

    it("requires exact case-sensitive tag value rather than a familiar label", () => {
        expect(selectWebBotAuthCandidates(headers([
            { label: "web-bot-auth", tag: "Web-Bot-Auth" },
        ]))).toEqual({ kind: "unsigned", reason: "no-web-bot-auth-candidate" });
    });

    it("enforces the candidate boundary without applying it to unrelated signatures", () => {
        const inputs = Array.from({ length: 16 }, (_, index) => ({
            label: `a${index}`, tag: "web-bot-auth",
        }));
        expect(selectWebBotAuthCandidates(headers(inputs)).kind).toBe("candidates");
        expect(() => selectWebBotAuthCandidates(headers([
            ...inputs, { label: "extra", tag: "web-bot-auth" },
        ]))).toThrow(expect.objectContaining({
            rejection: { status: "unverified", reason: "resource-limit" },
        }));
        expect(selectWebBotAuthCandidates(headers([
            ...inputs, { label: "other", tag: "other" },
        ])).kind).toBe("candidates");
    });

    it("keeps core parsing budgets independent of the profile candidate budget", () => {
        expect(() => selectWebBotAuthCandidates(candidate, {
            maxSignatureHeaderBytes: 1,
        }, 100)).toThrow(expect.objectContaining({
            rejection: { status: "unverified", reason: "resource-limit" },
        }));
    });

    it("supports zero candidates as an explicit acceptance budget", () => {
        expect(() => selectWebBotAuthCandidates(candidate, undefined, 0)).toThrow(
            expect.objectContaining({
                rejection: { status: "unverified", reason: "resource-limit" },
            }),
        );
        expect(selectWebBotAuthCandidates(headers([
            { label: "other", tag: "other" },
        ]), undefined, 0).kind).toBe("unsigned");
    });

    it.each([-1, NaN, Infinity, 1.5])("rejects invalid candidate budget %s", (budget) => {
        expect(() => selectWebBotAuthCandidates([], undefined, budget)).toThrow(
            expect.objectContaining({ code: "invalid-resource-limits" }),
        );
    });
});