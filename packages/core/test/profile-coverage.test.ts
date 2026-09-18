import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseSignatureHeaders } from "../src/signature-input.js";
import type { SignatureInput } from "../src/types.js";
import { assertRequiredCoverage } from "../src/profiles/coverage.js";
import type { WebBotAuthProfile } from "../src/profiles/agent-header.js";

interface CoverageCase {
    readonly id: string;
    readonly profile: WebBotAuthProfile;
    readonly label: string;
    readonly components: readonly string[];
    readonly expected: {
        readonly sufficient: boolean;
        readonly status?: string;
        readonly code?: string;
    };
}

const matrix = JSON.parse(readFileSync(new URL(
    "../../../tests/fixtures/profiles/coverage-cases.json", import.meta.url,
), "utf8")) as { readonly cases: readonly CoverageCase[] };

function input(components: readonly string[], label = "agent"): SignatureInput {
    // Dummy signature bytes: parsing and coverage only, never crypto validity.
    return parseSignatureHeaders([
        ["signature-input", `${label}=(${components.join(" ")})`],
        ["signature", `${label}=:AA==:`],
    ])[0]!.input;
}

const insufficient = () => expect.objectContaining({
    rejection: { status: "invalid", reason: "insufficient-coverage" },
});

describe("required coverage — independently pinned expectations", () => {
    for (const fixture of matrix.cases) {
        it(fixture.id, () => {
            const signatureInput = input(fixture.components, fixture.label);
            const operation = () => assertRequiredCoverage(signatureInput, fixture.profile);
            if (fixture.expected.sufficient) {
                expect(operation()).toBeUndefined();
            } else {
                expect(operation).toThrow(expect.objectContaining({
                    rejection: {
                        status: fixture.expected.status, reason: fixture.expected.code,
                    },
                }));
            }
        });
    }
});

describe("required component parameter boundaries", () => {
    it.each([
        '"signature-agent";key="agent";req',
        '"signature-agent";key="agent";tr',
        '"signature-agent";key="agent";bs',
        '"signature-agent";key="agent";custom',
        '"signature-agent";key="agent";sf=?0',
    ])("does not count a modified WG agent component: %s", (component) => {
        expect(() => assertRequiredCoverage(input([
            '"@method"', '"@target-uri"', component,
        ]), "ietf-wg-protocol-00")).toThrow(insufficient());
    });

    it("allows strict SF serialization combined with matching member selection", () => {
        expect(() => assertRequiredCoverage(input([
            '"@method"', '"@target-uri"', '"signature-agent";sf;key="agent"',
        ]), "ietf-wg-protocol-00")).not.toThrow();
    });

    it.each(["@method", "@target-uri"])("requires the current unmodified %s", (name) => {
        const components = ['"@method"', '"@target-uri"', '"signature-agent"']
            .map((component) => component === `"${name}"` ? `${component};req` : component);
        expect(() => assertRequiredCoverage(input(components),
            "cloudflare-docs-2026-07-01")).toThrow(insufficient());
    });

    it("does not count SF-only legacy coverage as the required whole-field component", () => {
        expect(() => assertRequiredCoverage(input([
            '"@method"', '"@target-uri"', '"signature-agent";sf',
        ]), "cloudflare-docs-2026-07-01")).toThrow(insufficient());
    });

    it("matches the actual candidate label, not a hardcoded label", () => {
        expect(() => assertRequiredCoverage(input([
            '"@method"', '"@target-uri"', '"signature-agent";key="different"',
        ], "different"), "ietf-wg-protocol-00")).not.toThrow();
    });

    it("does not mutate components or metadata during coverage checks", () => {
        const signatureInput = input([
            '"@method"', '"@target-uri"', '"signature-agent";key="agent"',
        ]);
        const before = structuredClone(signatureInput);
        assertRequiredCoverage(signatureInput, "ietf-wg-protocol-00");
        expect(signatureInput).toEqual(before);
    });
});