import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveCoreLimits } from "../src/limits.js";
import { parseSignatureHeaders } from "../src/signature-input.js";
import { createSignatureBase } from "../src/signature-base.js";
import type { HeaderFields, RequestParts } from "../src/types.js";
import {
    parseAgentHeader, resolveAgentClaim, WEB_BOT_AUTH_PROFILES,
} from "../src/profiles/agent-header.js";

const limits = resolveCoreLimits();
const root = new URL("../../../tests/fixtures/m2/", import.meta.url);
function request(headers: HeaderFields): RequestParts {
    return { method: "GET", targetUri: "https://merchant.example/items?sku=42", headers };
}
function agent(value: string): RequestParts {
    return request([["Signature-Agent", value]]);
}
function reject(reason: string, status = "invalid") {
    return expect.objectContaining({ rejection: { status, reason } });
}

describe("agent header — pinned profile vectors", () => {
    for (const profile of WEB_BOT_AUTH_PROFILES) {
        it(`parses ${profile} without changing the independent signature base`, () => {
            const text = readFileSync(new URL(`generated/${profile}/headers.txt`, root), "utf8");
            const headers: HeaderFields = text.split("\n").map((line) => {
                const colon = line.indexOf(":");
                return [line.slice(0, colon), line.slice(colon + 2)];
            });
            const message = request(headers);
            const parsed = parseAgentHeader(message, limits);
            expect(parsed.profile).toBe(profile);
            expect(resolveAgentClaim(parsed, "agent")).toEqual({
                profile, label: "agent", claimedUrl: "https://agent.example",
                canonicalOrigin: "https://agent.example",
            });
            const signature = parseSignatureHeaders(headers)[0]!;
            const base = createSignatureBase(
                { kind: "request", request: message }, signature.input,
                {
                    structuredFieldTypes: {
                        "signature-agent": profile === "ietf-wg-protocol-00" ? "dictionary" : "item",
                    }
                },
            );
            expect(Buffer.from(base.bytes)).toEqual(
                readFileSync(new URL(`generated/${profile}/base.txt`, root)),
            );
            expect(message.headers).toEqual(headers);
        });
    }

    it("reports the published E.2.1 label mismatch independently of other policy gates", () => {
        const parsed = parseAgentHeader(agent('agent2="https://signature-agent.test"'), limits);
        expect(() => resolveAgentClaim(parsed, "sig2")).toThrow(reject("agent-label-mismatch"));
    });

    it("keeps original claim spelling distinct from canonical identity", () => {
        const message = agent('agent="HTTPS://AGENT.EXAMPLE:443/"');
        const parsed = parseAgentHeader(message, limits);
        expect(resolveAgentClaim(parsed, "agent")).toMatchObject({
            claimedUrl: "HTTPS://AGENT.EXAMPLE:443/",
            canonicalOrigin: "https://agent.example",
        });
        expect(message.headers[0]![1]).toBe('agent="HTTPS://AGENT.EXAMPLE:443/"');
    });
});

describe("agent grammar, member isolation and limits", () => {
    it.each([
        "", "https://agent.example", '"https://agent.example',
        '"https://agent.example", agent="https://agent.example"',
        'agent="https://agent.example", "https://other.example"',
    ])("rejects malformed field without fallback: %s", (value) => {
        expect(() => parseAgentHeader(agent(value), limits)).toThrow(reject("malformed-agent"));
    });

    it("requires the header and rejects multiple legacy values", () => {
        expect(() => parseAgentHeader(request([]), limits)).toThrow(reject("malformed-agent"));
        expect(() => parseAgentHeader(request([
            ["Signature-Agent", '"https://agent.example"'],
            ["signature-agent", '"https://other.example"'],
        ]), limits)).toThrow(reject("malformed-agent"));
    });

    it("combines Dictionary field lines while retaining label-specific claims", () => {
        const parsed = parseAgentHeader(request([
            ["Signature-Agent", 'a="https://a.example"'],
            ["signature-agent", 'b="https://b.example"'],
        ]), limits);
        expect(resolveAgentClaim(parsed, "a").canonicalOrigin).toBe("https://a.example");
        expect(resolveAgentClaim(parsed, "b").canonicalOrigin).toBe("https://b.example");
        expect(() => resolveAgentClaim(parsed, "c")).toThrow(reject("agent-label-mismatch"));
    });

    it.each(['agent=?1', 'agent=("https://agent.example")', 'agent=42'])(
        "rejects a selected member that is not a String Item: %s", (value) => {
            const parsed = parseAgentHeader(agent(value), limits);
            expect(() => resolveAgentClaim(parsed, "agent")).toThrow(reject("malformed-agent"));
        },
    );

    it.each(["jwks_uri", "cimd", "future"])("never guesses unsupported discovery %s", (type) => {
        const parsed = parseAgentHeader(
            agent(`agent="https://agent.example/path?x=1";type=${type}`), limits,
        );
        expect(() => resolveAgentClaim(parsed, "agent")).toThrow(
            reject("unsupported-discovery-type", "unverified"),
        );
    });

    it("requires Token discovery type and accepts the explicit directory type", () => {
        const invalid = parseAgentHeader(
            agent('agent="https://agent.example";type="directory"'), limits,
        );
        expect(() => resolveAgentClaim(invalid, "agent")).toThrow(reject("malformed-agent"));
        const valid = parseAgentHeader(
            agent('agent="https://agent.example";type=directory'), limits,
        );
        expect(resolveAgentClaim(valid, "agent").canonicalOrigin).toBe("https://agent.example");
    });

    it("does not attribute an unsupported member to another candidate", () => {
        const parsed = parseAgentHeader(agent(
            'a="https://a.example/path";type=cimd, b="https://b.example"',
        ), limits);
        expect(() => resolveAgentClaim(parsed, "a")).toThrow(
            reject("unsupported-discovery-type", "unverified"),
        );
        expect(resolveAgentClaim(parsed, "b").canonicalOrigin).toBe("https://b.example");
    });

    it("preserves duplicate-name diagnostics across field occurrences", () => {
        expect(() => parseAgentHeader(request([
            ["Signature-Agent", 'agent="https://a.example"'],
            ["signature-agent", 'agent="https://b.example"'],
        ]), limits)).toThrow(expect.objectContaining({
            repeatedName: "agent",
            rejection: { status: "invalid", reason: "malformed-agent" },
        }));
    });

    it("preserves resource-limit classification", () => {
        expect(() => parseAgentHeader(agent('"https://agent.example"'),
            resolveCoreLimits({ structuredFields: { maxInputBytes: 1 } })))
            .toThrow(reject("resource-limit", "unverified"));
        const parsed = parseAgentHeader(agent('"https://agent.example"'), limits);
        expect(() => resolveAgentClaim(parsed, "agent", 1))
            .toThrow(reject("resource-limit", "unverified"));
    });

    it("normalizes obs-fold only with explicit HTTP/1.1 context", () => {
        const message = agent('a="https://a.example",\r\n b="https://b.example"');
        expect(() => parseAgentHeader(message, limits)).toThrow(reject("malformed-agent"));
        const parsed = parseAgentHeader({ ...message, httpVersion: "1.1" }, limits);
        expect(resolveAgentClaim(parsed, "b").canonicalOrigin).toBe("https://b.example");
    });
});