import { describe, expect, it } from "vitest";
import { parseSignatureHeaders } from "../src/index.js";
import {
    fixtureBytes,
    rfcSignatureHeaders,
    rfcSignatureInput,
} from "./rfc9421-fixture.js";
import type { HeaderFields } from "../src/types.js";

describe("parsing golden — RFC 9421 B.2.6", () => {
    it("matches the independently transcribed structure and published bytes", () => {
        const signatures = parseSignatureHeaders(rfcSignatureHeaders());
        expect(signatures).toHaveLength(1);
        expect(signatures[0]!.input).toEqual(rfcSignatureInput());
        expect(Buffer.from(signatures[0]!.signature)).toEqual(fixtureBytes("signature.bin"));
    });

    it("matches field names case-insensitively without changing signed parameters", () => {
        const headers: HeaderFields = rfcSignatureHeaders()
            .map(([name, value]) => [name.toUpperCase(), value]);
        const signatures = parseSignatureHeaders(headers);
        expect(signatures[0]!.input).toEqual(rfcSignatureInput());
    });

    it("preserves a different signature-parameter order", () => {
        const headers: HeaderFields = [
            ["Signature-Input", 'a=("@method");keyid="k";created=1;nonce="n"'],
            ["Signature", "a=:AQID:"],
        ];
        expect(parseSignatureHeaders(headers)).toEqual([{
            input: {
                label: "a",
                components: [{ name: "@method", parameters: [] }],
                parameters: [
                    ["keyid", { kind: "string", value: "k" }],
                    ["created", { kind: "integer", value: 1 }],
                    ["nonce", { kind: "string", value: "n" }],
                ],
            },
            // Parsing is algorithm independent; signature length is checked by crypto.
            signature: Uint8Array.of(1, 2, 3),
        }]);
    });

    it("pairs signatures by label rather than header ordering", () => {
        const signatures = parseSignatureHeaders([
            ["Signature-Input", 'a=("@method");keyid="a"'],
            ["Signature-Input", 'b=("@path");keyid="b"'],
            ["Signature", "b=:Ag==:, a=:AQ==:"],
        ]);
        expect(signatures.map(({ input }) => input.label)).toEqual(["a", "b"]);
        expect(signatures.map(({ signature }) => Array.from(signature))).toEqual([[1], [2]]);
    });

    it("rejects duplicate labels across field occurrences (RFC 9421 §4.1)", () => {
        expect(() => parseSignatureHeaders([
            ["Signature-Input", 'a=("@method")'],
            ["Signature-Input", 'a=("@path")'],
            ["Signature", "a=:AQ==:"],
        ])).toThrow();
    });

    it("rejects duplicate signature labels (RFC 9421 §4.2)", () => {
        expect(() => parseSignatureHeaders([
            ["Signature-Input", 'a=("@method")'],
            ["Signature", "a=:AQ==:, a=:Ag==:"],
        ])).toThrow();
    });

    it("rejects a signature without corresponding input (RFC 9421 §3.2)", () => {
        expect(() => parseSignatureHeaders([["Signature", "a=:AQ==:"]])).toThrow();
    });
});