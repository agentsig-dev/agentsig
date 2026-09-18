import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createAgentBindings } from "../src/profiles/agent-bindings.js";
import type { AgentBinding } from "../src/profiles/agent-bindings.js";
import { CandidateRejection } from "../src/profiles/codes.js";

interface BindingCase {
    readonly id: string;
    readonly thumbprint: string;
    readonly claim: string;
    readonly requireBinding: boolean;
    readonly bindings: readonly AgentBinding[];
    readonly expected: {
        readonly identityKind?: "key-thumbprint" | "directory-url";
        readonly thumbprint?: string;
        readonly canonicalOrigin?: string;
        readonly directoryUrl?: string;
        readonly trustSource?: "local-configuration";
        readonly status?: "invalid" | "unverified";
        readonly code?: string;
    };
}

const matrix = JSON.parse(readFileSync(new URL(
    "../../../tests/fixtures/profiles/binding-cases.json", import.meta.url,
), "utf8")) as { readonly cases: readonly BindingCase[] };
const thumbprint = matrix.cases[0]!.thumbprint;
const otherThumbprint = "poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U";
const origin = "https://agent.example";

describe("local identity binding — pre-implementation expectations", () => {
    for (const fixture of matrix.cases) {
        it(fixture.id, () => {
            const bindings = createAgentBindings(fixture.bindings);
            const run = () => bindings.proposeIdentity(
                fixture.thumbprint, fixture.claim, fixture.requireBinding,
            );
            if (fixture.expected.code) {
                expect(run).toThrow(CandidateRejection);
                expect(run).toThrow(expect.objectContaining({
                    rejection: {
                        status: fixture.expected.status,
                        reason: fixture.expected.code,
                    },
                }));
            } else {
                const proposed = run();
                expect(proposed).toMatchObject(fixture.expected);
                expect(proposed.thumbprint).toBe(fixture.thumbprint);
                expect(Object.isFrozen(proposed)).toBe(true);
                expect(proposed).not.toHaveProperty("status");
                expect(proposed).not.toHaveProperty("verified");
            }
        });
    }
});

describe("binding configuration boundaries", () => {
    it("collapses equivalent origin spellings for the same key", () => {
        const bindings = createAgentBindings([
            { thumbprint, origin },
            { thumbprint, origin: "HTTPS://AGENT.EXAMPLE:443/" },
            { thumbprint, origin: "https://Agent.Example/" },
        ]);
        expect(bindings.entries).toEqual([{ thumbprint, origin }]);
        expect(Object.isFrozen(bindings)).toBe(true);
        expect(Object.isFrozen(bindings.entries)).toBe(true);
        expect(Object.isFrozen(bindings.entries[0])).toBe(true);
    });

    it("counts input occurrences before deduplication", () => {
        const entries = [{ thumbprint, origin }, { thumbprint, origin }];
        expect(createAgentBindings(entries, { maxAgentBindings: 2 }).entries).toHaveLength(1);
        expect(() => createAgentBindings(entries, { maxAgentBindings: 1 }))
            .toThrow(expect.objectContaining({ code: "invalid-agent-binding" }));
        expect(createAgentBindings([], { maxAgentBindings: 0 }).entries).toEqual([]);
    });

    it("owns its configuration independently of subsequent caller mutations", () => {
        const input = [{ thumbprint, origin }];
        const bindings = createAgentBindings(input);
        input[0]!.origin = "https://changed.example";
        input[0]!.thumbprint = otherThumbprint;
        input.length = 0;
        expect(bindings.entries).toEqual([{ thumbprint, origin }]);
        expect(bindings.proposeIdentity(thumbprint, origin, true))
            .toMatchObject({ identityKind: "directory-url", canonicalOrigin: origin });
    });

    it("does not grant a URL identity in explicitly selected thumbprint mode", () => {
        const bindings = createAgentBindings([{ thumbprint, origin }]);
        expect(bindings.proposeIdentity(thumbprint, origin, false))
            .toEqual({ identityKind: "key-thumbprint", thumbprint });
    });

    it("does not borrow another key's binding to the claimed origin", () => {
        const bindings = createAgentBindings([{ thumbprint: otherThumbprint, origin }]);
        expect(() => bindings.proposeIdentity(thumbprint, origin, true))
            .toThrow(expect.objectContaining({
                rejection: { status: "unverified", reason: "agent-binding-missing" },
            }));
    });

    it.each([
        null, {}, [null], [[]], [{}],
        [{ thumbprint: "operator-label", origin }],
        [{ thumbprint, origin: "http://agent.example" }],
        [{ thumbprint, origin, unexpected: true }],
        new Array(1),
    ])("rejects malformed configuration %#", (value) => {
        expect(() => createAgentBindings(value as readonly AgentBinding[]))
            .toThrow(expect.objectContaining({ code: "invalid-agent-binding" }));
    });

    it("rejects accessors without invoking them", () => {
        let reads = 0;
        const entry = Object.defineProperty({ thumbprint }, "origin", {
            enumerable: true,
            get() { reads++; return origin; },
        });
        expect(() => createAgentBindings([entry as AgentBinding]))
            .toThrow(expect.objectContaining({ code: "invalid-agent-binding" }));
        const array = Object.defineProperty([], "0", {
            get() { reads++; return { thumbprint, origin }; },
        }) as AgentBinding[];
        expect(() => createAgentBindings(array))
            .toThrow(expect.objectContaining({ code: "invalid-agent-binding" }));
        expect(reads).toBe(0);
    });

    it("enforces the original origin spelling's length before normalization", () => {
        const spelling = "HTTPS://AGENT.EXAMPLE:443/";
        expect(createAgentBindings([{ thumbprint, origin: spelling }], {
            maxAgentUrlBytes: spelling.length,
        }).entries[0]!.origin).toBe(origin);
        expect(() => createAgentBindings([{ thumbprint, origin: spelling }], {
            maxAgentUrlBytes: spelling.length - 1,
        })).toThrow(expect.objectContaining({ code: "invalid-agent-binding" }));
    });

    it("rejects noncanonical thumbprint aliases", () => {
        const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        const finalIndex = alphabet.indexOf(thumbprint.at(-1)!);
        expect(finalIndex % 4).toBe(0);
        const alias = thumbprint.slice(0, -1) + alphabet[finalIndex + 1];
        expect(() => createAgentBindings([{ thumbprint: alias, origin }]))
            .toThrow(expect.objectContaining({ code: "invalid-agent-binding" }));
    });

    it("keeps invalid resource configuration separate from invalid bindings", () => {
        expect(() => createAgentBindings([], { maxAgentBindings: -1 }))
            .toThrow(expect.objectContaining({ code: "invalid-resource-limits" }));
    });
});