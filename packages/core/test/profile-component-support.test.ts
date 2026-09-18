import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseSignatureHeaders } from "../src/signature-input.js";
import type { SignatureInput } from "../src/types.js";
import {
    assertSupportedComponents,
    assertSupportedProfile,
    ProfileSupportRejection,
} from "../src/profiles/component-support.js";
import type { ProfileSupportDiagnostic } from "../src/profiles/component-support.js";
import { selectWebBotAuthCandidates } from "../src/profiles/candidates.js";

const root = new URL("../../../tests/fixtures/profiles/", import.meta.url);
const restrictions = JSON.parse(readFileSync(
    new URL("component-restrictions.json", root), "utf8",
)) as {
    cases: {
        id: string;
        profile: string;
        component: string;
        expected: {
            status: "unverified";
            code: "unsupported-profile";
            diagnostic: ProfileSupportDiagnostic;
        };
    }[];
    unknownProfileCase: {
        profile: string;
        expected: { diagnostic: ProfileSupportDiagnostic };
    };
};
const counting = JSON.parse(readFileSync(
    new URL("rejected-candidate-counting.json", root), "utf8",
)) as {
    cases: {
        id: string;
        profile: string;
        candidates: { label: string; tag: string; covers: string | null }[];
        expected: { selectedCount: number; evaluatedLabels: string[] };
    }[];
};

function input(component: string): SignatureInput {
    // Syntax-only signature bytes; this test asserts no cryptographic validity.
    return parseSignatureHeaders([
        ["signature-input", `agent=("@method" "@target-uri" ${component})`],
        ["signature", "agent=:AA==:"],
    ])[0]!.input;
}

describe("profile component support — pre-implementation fixtures", () => {
    for (const fixture of restrictions.cases) {
        it(fixture.id, () => {
            let caught: unknown;
            try {
                assertSupportedComponents(input(fixture.component), fixture.profile);
            } catch (error) { caught = error; }
            expect(caught).toBeInstanceOf(ProfileSupportRejection);
            const error = caught as ProfileSupportRejection;
            expect(error.rejection).toEqual({
                status: fixture.expected.status, reason: fixture.expected.code,
            });
            expect(error.diagnostic).toEqual(fixture.expected.diagnostic);
            expect(Object.isFrozen(error.diagnostic)).toBe(true);
            expect(error.message).toContain(JSON.stringify(fixture.profile));
            expect(error.message).toContain(fixture.expected.diagnostic.source);
            if (fixture.expected.diagnostic.kind === "component") {
                expect(error.message).toContain(
                    JSON.stringify(fixture.expected.diagnostic.component),
                );
                if (fixture.expected.diagnostic.parameter !== undefined) {
                    expect(error.message).toContain(
                        `parameter=${JSON.stringify(fixture.expected.diagnostic.parameter)}`,
                    );
                }
            }
            expect(error.message).not.toContain('"inner"');
        });
    }

    it("distinguishes an unknown profile from an unsupported component", () => {
        const fixture = restrictions.unknownProfileCase;
        let caught: unknown;
        try { assertSupportedProfile(fixture.profile); } catch (error) { caught = error; }
        expect(caught).toBeInstanceOf(ProfileSupportRejection);
        expect((caught as ProfileSupportRejection).diagnostic).toEqual(fixture.expected.diagnostic);
        expect((caught as Error).message).toContain("Unsupported profile");
    });
});

describe("rejection does not remove selected candidates", () => {
    for (const fixture of counting.cases) {
        it(`${fixture.id}: selection and support gates only`, () => {
            const selection = selectWebBotAuthCandidates([
                ["signature-input", fixture.candidates.map((candidate) =>
                    `${candidate.label}=("@method" "@target-uri"` +
                    (candidate.covers === null ? "" : ` ${candidate.covers}`) +
                    `);tag="${candidate.tag}"`).join(", ")],
                ["signature", fixture.candidates.map((candidate) =>
                    `${candidate.label}=:AA==:`).join(", ")],
            ]);
            expect(selection.kind).toBe("candidates");
            if (selection.kind !== "candidates") throw new Error("Expected candidates");
            const visited: string[] = [];
            for (const candidate of selection.candidates) {
                visited.push(candidate.input.label);
                if (candidate.input.label === "outer") {
                    expect(() => assertSupportedComponents(candidate.input, fixture.profile))
                        .toThrow(ProfileSupportRejection);
                } else {
                    expect(() => assertSupportedComponents(candidate.input, fixture.profile))
                        .not.toThrow();
                }
            }
            expect(visited).toEqual(fixture.expected.evaluatedLabels);
            expect(selection.candidates).toHaveLength(fixture.expected.selectedCount);
            // Aggregate acceptance and nonce consumption are NOT implemented
            // by this support gate. Do not simulate them to claim conformance.
        });
    }
});

describe("support gate boundaries", () => {
    it("prioritizes the local restriction independent of component order", () => {
        const signatureInput = input('"x-example";sf "signature";key="inner"');
        expect(() => assertSupportedComponents(signatureInput, "cloudflare-docs-2026-07-01"))
            .toThrow(expect.objectContaining({
                diagnostic: expect.objectContaining({
                    source: "agentsig-m2-local-countersignature-limit",
                }),
            }));
    });

    it("does not transfer Cloudflare component restrictions into the WG profile", () => {
        expect(() => assertSupportedComponents(
            input('"x-example";sf'), "ietf-wg-protocol-00",
        )).not.toThrow();
    });

    it("does not match similarly named ordinary fields or mutate inputs", () => {
        const signatureInput = input('"signature-agent" "x-signature"');
        const original = structuredClone(signatureInput);
        for (const profile of ["ietf-wg-protocol-00", "cloudflare-docs-2026-07-01"]) {
            expect(() => assertSupportedComponents(signatureInput, profile)).not.toThrow();
        }
        expect(signatureInput).toEqual(original);
    });

    it("escapes and bounds an untrusted unknown profile in its diagnostic message", () => {
        const profile = "bad\n\u001b\u202e" + "a".repeat(1000);
        let caught: unknown;
        try { assertSupportedProfile(profile); } catch (error) { caught = error; }
        const error = caught as ProfileSupportRejection;
        expect(error.diagnostic.profile).toBe(profile);
        expect(error.message).not.toMatch(/[\u0000-\u001f\u007f-\uffff]/);
        expect(error.message).toContain("[truncated]");
        expect(error.message.length).toBeLessThan(450);
    });
});