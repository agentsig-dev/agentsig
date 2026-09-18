import { createPublicKey } from "node:crypto";
import type { JsonWebKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Parameters } from "@agentsig/structured-fields";
import type { HeaderFields } from "../src/types.js";
import { selectWebBotAuthCandidates } from "../src/profiles/candidates.js";
import { loadJwks } from "../src/profiles/jwks.js";
import {
    assertSelectedKeyIdentity,
    MetadataRejection,
    readCandidateMetadata,
    validateProfileKeyId,
} from "../src/profiles/metadata.js";
import type { NoncePolicy } from "../src/profiles/metadata.js";

interface Fixture {
    id: string;
    profile: string;
    layer: string;
    input: {
        headers?: HeaderFields;
        metadata?: Record<string, string | number>;
        keyid?: string;
        jwks?: unknown;
        selectedPublicJwk?: JsonWebKey;
        noncePolicy?: NoncePolicy;
    };
    expected: {
        accepted: boolean;
        status?: string;
        reason?: string;
        rule?: string;
        candidateLabels?: string[];
        selectedThumbprint?: string;
        recomputedThumbprint?: string;
        noncePresent?: boolean;
    };
}
const fixtures = JSON.parse(readFileSync(new URL(
    "../../../tests/fixtures/metadata/cases.json", import.meta.url,
), "utf8")) as { cases: Fixture[] };
const keyid = "DR68nui99ukl-GUgfzQGaU3VwqRtArw-_DCN4LFtY84";

// Translate authored values to tagged SF data, not expected results.
function parameters(values: Record<string, string | number>): Parameters {
    return Object.entries(values).map(([name, value]) => [
        name, typeof value === "number"
            ? { kind: "integer" as const, value }
            : { kind: "string" as const, value },
    ]);
}
const valid = () => parameters({
    created: 1800000000, expires: 1800000060, keyid,
    alg: "ed25519", nonce: "fixture-nonce", tag: "web-bot-auth",
});

describe("metadata classification — committed five-layer expectations", () => {
    for (const fixture of fixtures.cases) {
        it(fixture.id, () => {
            const { input, expected } = fixture;
            if (fixture.layer === "wire-types" || fixture.layer === "candidate-selection") {
                const run = () => selectWebBotAuthCandidates(input.headers!);
                if (expected.status === "invalid") {
                    expect(run).toThrow(expect.objectContaining({
                        rejection: { status: expected.status, reason: expected.reason },
                    }));
                } else if (expected.status === "unsigned") {
                    expect(run()).toEqual({ kind: "unsigned", reason: expected.reason });
                } else {
                    const selected = run();
                    expect(selected.kind).toBe("candidates");
                    if (selected.kind !== "candidates") throw new Error("Expected candidates");
                    expect(selected.candidates.map((candidate) => candidate.input.label))
                        .toEqual(expected.candidateLabels);
                }
                return;
            }
            if (fixture.layer === "key-lookup") {
                const result = loadJwks(input.jwks).lookup(input.keyid!);
                if (expected.accepted) {
                    expect(result.status).toBe("found");
                    if (result.status !== "found") throw new Error("Expected key");
                    expect(result.key.thumbprint).toBe(expected.selectedThumbprint);
                } else {
                    expect(result).toEqual({ status: expected.status, reason: expected.reason });
                }
                return;
            }
            const run = () => {
                switch (fixture.layer) {
                    case "keyid-format":
                        return validateProfileKeyId(input.keyid);
                    case "selected-key-binding":
                        return assertSelectedKeyIdentity(input.keyid!, createPublicKey({
                            key: input.selectedPublicJwk!, format: "jwk",
                        }));
                    case "required-metadata":
                    case "nonce-policy":
                        return readCandidateMetadata(parameters(input.metadata!), input.noncePolicy);
                    default:
                        throw new Error("Unknown fixture layer");
                }
            };
            if (!expected.accepted) {
                let caught: unknown;
                try { run(); } catch (error) { caught = error; }
                expect(caught).toBeInstanceOf(MetadataRejection);
                const error = caught as MetadataRejection;
                expect(error.rejection).toEqual({
                    status: expected.status, reason: expected.reason,
                });
                if (expected.rule) {
                    expect(error.rule).toBe(expected.rule);
                    expect(error.message).toContain(expected.rule);
                }
                expect(error.message).not.toContain(keyid);
            } else {
                const result = run();
                if (fixture.layer === "keyid-format") expect(result).toBe(input.keyid);
                else if (fixture.layer === "selected-key-binding") {
                    expect(result).toBe(expected.recomputedThumbprint);
                } else {
                    expect(Object.isFrozen(result)).toBe(true);
                    expect(result).toMatchObject({ keyid });
                    if (expected.noncePresent === false) {
                        expect(result).toHaveProperty("nonce", undefined);
                    }
                    expect(result).not.toHaveProperty("status");
                }
            }
        });
    }
});

describe("metadata boundary regressions", () => {
    it("keeps malformed unrelated pairs at the whole-request boundary", () => {
        expect(() => selectWebBotAuthCandidates([
            ["Signature-Input", 'good=("@method");tag="web-bot-auth", bad=("@method");alg=ed25519;tag="other"'],
            ["Signature", "good=:AA==:, bad=:AA==:"],
        ])).toThrow(expect.objectContaining({
            rejection: { status: "invalid", reason: "malformed-signature" },
        }));
    });

    it("uses the shared printable nonce grammar without normalization", () => {
        const nonce = ' quote"slash\\end ';
        const values = valid().filter(([name]) => name !== "nonce");
        expect(readCandidateMetadata([
            ...values, ["nonce", { kind: "string", value: nonce }],
        ]).nonce).toBe(nonce);
        expect(() => readCandidateMetadata([
            ...values, ["nonce", { kind: "string", value: "a".repeat(257) }],
        ], "optional")).toThrow(expect.objectContaining({
            rejection: { status: "invalid", reason: "nonce-invalid" },
        }));
    });

    it("does not impose a timestamp window or algorithm decision at extraction", () => {
        const result = readCandidateMetadata(parameters({
            created: -1, expires: 0, keyid, alg: "unknown-algorithm", nonce: "nonce",
        }));
        expect(result.created).toBe(-1);
        expect(result.algorithm).toBe("unknown-algorithm");
        // Separate time and trusted-key algorithm gates must still reject as
        // appropriate. Metadata extraction is never a verification result.
    });

    it("keeps nonce configuration errors out of candidate results", () => {
        expect(() => readCandidateMetadata(valid(), "invalid" as NoncePolicy))
            .toThrow(expect.objectContaining({ code: "invalid-replay-policy" }));
        expect(() => readCandidateMetadata(valid(), "required", -1))
            .toThrow(expect.objectContaining({ code: "invalid-resource-limits" }));
    });
});