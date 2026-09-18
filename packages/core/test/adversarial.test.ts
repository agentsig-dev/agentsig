import { createPublicKey } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
    createSignatureBase,
    parseSignatureHeaders,
    SignatureConfigurationError,
    SignatureError,
    SignatureLimitError,
    verifyHttpSignatureCryptography,
} from "../src/index.js";
import { fixtureBytes, rfcParsedSignature, rfcRequest, rfcSignatureInput } from "./rfc9421-fixture.js";
import type { HttpMessage, SignatureInput } from "../src/index.js";

describe("hostile signature headers", () => {
    it.each([
        ['a="@method"', "a=:AQ==:"],
        ['a=(@method)', "a=:AQ==:"],
        ['a=("@method");created="1"', "a=:AQ==:"],
        ['a=("@method");keyid=token', "a=:AQ==:"],
        ['a=("@method");created=@1', "a=:AQ==:"],
        ['a=("@method");extension=%"hello"', "a=:AQ==:"],
        ['a=("@method")', 'a="not-bytes"'],
        ['a=("@method")', "b=:AQ==:"],
        ['a=("@method"), b=("@path")', "a=:AQ==:"],
        ['a=("@Method")', "a=:AQ==:"],
        ['a=("@signature-params")', "a=:AQ==:"],
        ['a=("@method")', "a=:AQ!==:"],
        ['a=("@method")', "a=:AQ==:\r\nInjected: true"],
    ])("rejects malformed pair %#", (input, signature) => {
        expect(() => parseSignatureHeaders([
            ["Signature-Input", input], ["Signature", signature],
        ])).toThrow(SignatureError);
    });

    it("leaves unsigned traffic distinct from malformed partial signatures", () => {
        expect(parseSignatureHeaders([["X-Other", "yes"]])).toEqual([]);
        expect(() => parseSignatureHeaders([["Signature-Input", 'a=("@method")']]))
            .toThrow(SignatureError);
    });

    it("accounts for combined signature fields, not just individual lines", () => {
        expect(() => parseSignatureHeaders([
            ["Signature-Input", 'a=("@method")'], ["Signature", "a=:AQ==:"],
        ], { maxSignatureHeaderBytes: 18 })).toThrow(SignatureLimitError);
    });

    it("passes an explicitly narrower budget into SF parsing", () => {
        expect(() => parseSignatureHeaders([
            ["Signature-Input", 'a=("@method")'], ["Signature", "a=:AQ==:"],
        ], { structuredFields: { maxInputBytes: 5 } }))
            .toThrow(SignatureLimitError);
    });

    it("random header bytes never escape as unexpected implementation failures", () => {
        fc.assert(fc.property(
            fc.uint8Array({ maxLength: 128 }),
            fc.uint8Array({ maxLength: 128 }),
            (input, signature) => {
                try {
                    parseSignatureHeaders([
                        ["Signature-Input", input], ["Signature", signature],
                    ]);
                } catch (error) {
                    expect(error).toBeInstanceOf(SignatureError);
                }
            },
        ), { seed: 94219651, numRuns: 2000 });
    });
});

describe("cryptography boundary", () => {
    const key = createPublicKey(fixtureBytes("ed25519-public.pem"));

    it("rejects every single-byte mutation of the published Ed25519 signature", async () => {
        for (let index = 0; index < 64; index++) {
            const candidate = rfcParsedSignature();
            candidate.signature[index] = candidate.signature[index]! ^ 1;
            expect(await verifyHttpSignatureCryptography(rfcRequest(), candidate, key))
                .toEqual({ status: "rejected", reason: "signature-mismatch" });
        }
    });

    it("returns a resource rejection rather than misreporting an invalid signature", async () => {
        expect(await verifyHttpSignatureCryptography(rfcRequest(), rfcParsedSignature(), key, {
            limits: { maxSignatureBaseBytes: 1 },
        })).toEqual({ status: "rejected", reason: "resource-limit" });
    });

    it("does not hide invalid caller configuration", async () => {
        await expect(verifyHttpSignatureCryptography(rfcRequest(), rfcParsedSignature(), key, {
            limits: { maxSignatureBaseBytes: -1 },
        })).rejects.toBeInstanceOf(SignatureConfigurationError);
    });

    it("does not claim body integrity for an uncovered body or query", async () => {
        // B.2.6 does not cover @query. A query change must NOT be advertised as
        // detected by cryptography: applications must require sufficient coverage.
        const message = rfcRequest();
        if (message.kind !== "request") throw new Error("Invalid fixture");
        const changed: HttpMessage = {
            ...message,
            request: { ...message.request, targetUri: "https://example.com/foo?different=1" },
        };
        expect(await verifyHttpSignatureCryptography(changed, rfcParsedSignature(), key))
            .toMatchObject({ status: "signature-valid" });
    });

    it("retains extension metadata in the signature base without inventing semantics", () => {
        const input: SignatureInput = {
            ...rfcSignatureInput(),
            parameters: [...rfcSignatureInput().parameters, ["extension", { kind: "string", value: "value" }]],
        };
        expect(createSignatureBase(rfcRequest(), input).text.endsWith(';extension="value"')).toBe(true);
    });

    it("rejects missing related-request context and trailers explicitly", () => {
        const response: HttpMessage = { kind: "response", status: 200, headers: [["date", "today"]] };
        const related: SignatureInput = {
            label: "s",
            components: [{ name: "@method", parameters: [["req", { kind: "boolean", value: true }]] }],
            parameters: [],
        };
        expect(() => createSignatureBase(response, related)).toThrow(SignatureError);
        expect(() => createSignatureBase(response, {
            ...related,
            components: [{ name: "date", parameters: [["tr", { kind: "boolean", value: true }]] }],
        })).toThrow(SignatureError);
    });
});