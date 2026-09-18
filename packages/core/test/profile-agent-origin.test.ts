import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
    canonicalAgentOrigin,
    configuredAgentOrigin,
} from "../src/profiles/agent-origin.js";
import { CandidateRejection, ProfileConfigurationError } from "../src/profiles/codes.js";

interface OriginCase {
    readonly id: string;
    readonly value: string;
    readonly canonicalOrigin?: string;
    readonly requestCode?: string;
    readonly configurationCode?: string;
}

const matrix = JSON.parse(readFileSync(new URL(
    "../../../tests/fixtures/profiles/origin-cases.json", import.meta.url,
), "utf8")) as { readonly cases: readonly OriginCase[] };

describe("agent origin — pre-implementation expectations", () => {
    for (const fixture of matrix.cases) {
        it(fixture.id, () => {
            if (fixture.canonicalOrigin !== undefined) {
                expect(canonicalAgentOrigin(fixture.value)).toBe(fixture.canonicalOrigin);
                expect(configuredAgentOrigin(fixture.value)).toBe(fixture.canonicalOrigin);
            } else {
                expect(() => canonicalAgentOrigin(fixture.value)).toThrow(
                    expect.objectContaining({
                        rejection: { status: "invalid", reason: fixture.requestCode },
                    }),
                );
                expect(() => configuredAgentOrigin(fixture.value)).toThrow(
                    expect.objectContaining({ code: fixture.configurationCode }),
                );
            }
        });
    }
});

describe("origin boundary and parser-repair resistance", () => {
    it.each([
        "https://127.1",
        "https://2130706433",
        "https://0x7f000001",
        "https://0177.0.0.1",
        "https://%61gent.example",
        "https://agent.example\\",
        "https://agent.example/\t",
        "https://agent.example/\n",
        "https://agent.example/%2e",
    ])("does not repair disallowed spelling: %s", (value) => {
        expect(() => canonicalAgentOrigin(value)).toThrow(
            expect.objectContaining({
                rejection: { status: "invalid", reason: "malformed-agent" },
            }),
        );
    });

    it.each([undefined, null, 42, {}, [], new URL("https://agent.example")])(
        "requires an explicit string %#", (value) => {
            expect(() => canonicalAgentOrigin(value)).toThrow(CandidateRejection);
            expect(() => configuredAgentOrigin(value)).toThrow(ProfileConfigurationError);
        },
    );

    it("checks the original spelling's budget before normalization", () => {
        const original = "HTTPS://AGENT.EXAMPLE:443/";
        expect(canonicalAgentOrigin(original, original.length)).toBe("https://agent.example");
        expect(() => canonicalAgentOrigin(original, original.length - 1)).toThrow(
            expect.objectContaining({
                rejection: { status: "unverified", reason: "resource-limit" },
            }),
        );
        expect(() => configuredAgentOrigin(original, original.length - 1)).toThrow(
            expect.objectContaining({ code: "invalid-agent-binding" }),
        );
        expect(original).toBe("HTTPS://AGENT.EXAMPLE:443/");
    });

    it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
        "rejects an invalid budget without remapping its configuration code: %s", (budget) => {
            for (const operation of [canonicalAgentOrigin, configuredAgentOrigin]) {
                expect(() => operation("https://agent.example", budget)).toThrow(
                    expect.objectContaining({ code: "invalid-resource-limits" }),
                );
            }
        },
    );

    it("does not reflect rejected claims in exception messages", () => {
        const claim = "https://private-operator-marker@agent.example";
        for (const operation of [canonicalAgentOrigin, configuredAgentOrigin]) {
            let caught: unknown;
            try { operation(claim); } catch (error) { caught = error; }
            expect(caught).toBeInstanceOf(Error);
            expect((caught as Error).message).not.toContain("private-operator-marker");
        }
    });
});