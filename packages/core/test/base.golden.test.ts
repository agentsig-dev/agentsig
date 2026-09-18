import { describe, expect, it } from "vitest";
import { createSignatureBase } from "../src/index.js";
import { fixtureBytes, rfcRequest, rfcSignatureInput } from "./rfc9421-fixture.js";
import type { HttpMessage, SignatureInput } from "../src/types.js";

describe("signature base golden — RFC 9421", () => {
    it("matches B.2.6 bytes without signing or parsing signature headers", () => {
        const base = createSignatureBase(rfcRequest(), rfcSignatureInput());
        expect(Buffer.from(base.bytes)).toEqual(fixtureBytes("signature-base.txt"));
        expect(Buffer.from(base.text, "utf8")).toEqual(fixtureBytes("signature-base.txt"));
        expect(base.bytes).toHaveLength(284);
        expect(base.text.includes("\r")).toBe(false);
        expect(base.text.endsWith("\n")).toBe(false);
    });

    it("normalizes repeated header occurrences as specified in §2.1", () => {
        const message: HttpMessage = {
            kind: "request",
            request: {
                method: "GET",
                targetUri: "https://example.com/",
                httpVersion: "1.1",
                headers: [
                    ["Cache-Control", " max-age=60\t"],
                    ["cache-control", "   must-revalidate "],
                    ["X-Fold", "Obsolete\r\n    line folding."],
                ],
            },
        };
        const input: SignatureInput = {
            label: "example",
            components: [
                { name: "cache-control", parameters: [] },
                { name: "x-fold", parameters: [] },
            ],
            parameters: [],
        };
        const expected = [
            '"cache-control": max-age=60, must-revalidate',
            '"x-fold": Obsolete line folding.',
            '"@signature-params": ("cache-control" "x-fold")',
        ].join("\n");
        expect(Buffer.from(createSignatureBase(message, input).bytes))
            .toEqual(Buffer.from(expected, "ascii"));
    });

    it("derives response components and related request components separately (§2.4)", () => {
        const request = rfcRequest();
        if (request.kind !== "request") throw new Error("Invalid test setup");
        const message: HttpMessage = {
            kind: "response",
            status: 503,
            headers: [["Content-Type", "application/json"]],
            request: request.request,
        };
        const input: SignatureInput = {
            label: "response",
            components: [
                { name: "@status", parameters: [] },
                { name: "content-type", parameters: [] },
                { name: "@method", parameters: [["req", { kind: "boolean", value: true }]] },
            ],
            parameters: [],
        };
        const expected = [
            '"@status": 503',
            '"content-type": application/json',
            '"@method";req: POST',
            '"@signature-params": ("@status" "content-type" "@method";req)',
        ].join("\n");
        expect(Buffer.from(createSignatureBase(message, input).bytes))
            .toEqual(Buffer.from(expected, "ascii"));
    });

    it("does not include the signature label in the base (§3.2 step 7)", () => {
        const input = { ...rfcSignatureInput(), label: "another-label" };
        expect(Buffer.from(createSignatureBase(rfcRequest(), input).bytes))
            .toEqual(fixtureBytes("signature-base.txt"));
    });
});