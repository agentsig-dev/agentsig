import { describe, expect, it } from "vitest";
import {
    CORE_SF_LIMITS,
    createSignatureBase,
    DEFAULT_CORE_LIMITS,
    SignatureError,
    SignatureLimitError,
} from "../src/index.js";
import type {
    CanonicalizationOptions, CoveredComponent, HeaderFields, HttpMessage,
    Parameters, SignatureInput,
} from "../src/index.js";

const flag = (name: string): Parameters => [[name, { kind: "boolean", value: true }]];
const stringParam = (name: string, value: string): Parameters =>
    [[name, { kind: "string", value }]];

function request(
    targetUri = "https://example.com/",
    headers: HeaderFields = [],
): HttpMessage {
    return { kind: "request", request: { method: "GET", targetUri, headers } };
}
function input(name: string, parameters: Parameters = []): SignatureInput {
    return { label: "test", components: [{ name, parameters }], parameters: [] };
}
function expectBase(
    message: HttpMessage,
    component: CoveredComponent,
    identifier: string,
    expectedValue: string,
    options: CanonicalizationOptions = {},
): void {
    const expected = `${identifier}: ${expectedValue}\n"@signature-params": (${identifier})`;
    const actual = createSignatureBase(message, {
        label: "test", components: [component], parameters: [],
    }, options);
    expect(Buffer.from(actual.bytes)).toEqual(Buffer.from(expected, "ascii"));
    expect(actual.text).toBe(expected);
}

describe("RFC 9421 §2.1 field canonicalization", () => {
    const headers: HeaderFields = [
        ["Example-Dict", " a=1,    b=2;x=1;y=2,   c=(a   b    c), d "],
    ];
    const types = { structuredFieldTypes: { "example-dict": "dictionary" as const } };

    it("strictly serializes a known Structured Field", () => {
        expectBase(request(undefined, headers),
            { name: "example-dict", parameters: flag("sf") },
            '"example-dict";sf', "a=1, b=2;x=1;y=2, c=(a b c), d", types);
    });

    it.each([
        ["a", "1"], ["b", "2;x=1;y=2"], ["c", "(a b c)"], ["d", "?1"],
    ])("serializes Dictionary member %s without its key", (key, expected) => {
        expectBase(request(undefined, headers),
            { name: "example-dict", parameters: stringParam("key", key) },
            `"example-dict";key="${key}"`, expected, types);
    });

    it("combines Dictionary occurrences before selecting a member", () => {
        expectBase(request(undefined, [["Example-Dict", "a=1"], ["example-dict", "b=?1"]]),
            { name: "example-dict", parameters: stringParam("key", "b") },
            '"example-dict";key="b"', "?1", types);
    });

    it("distinguishes separately wrapped header values (§2.1.3)", () => {
        expectBase(request(undefined, [
            ["Example-Header", "value, with, lots"], ["Example-Header", "of, commas"],
        ]), { name: "example-header", parameters: flag("bs") },
            '"example-header";bs', ":dmFsdWUsIHdpdGgsIGxvdHM=:, :b2YsIGNvbW1hcw==:");
    });

    it("wraps original non-ASCII bytes without guessing a string encoding", () => {
        expectBase(request(undefined, [["X-Bytes", Uint8Array.of(0xff, 0xe0, 0x21)]]),
            { name: "x-bytes", parameters: flag("bs") }, '"x-bytes";bs', ":/+Ah:");
        expect(() => createSignatureBase(
            request(undefined, [["X-Bytes", Uint8Array.of(0xff)]]), input("x-bytes"),
        )).toThrow(SignatureError);
        expect(() => createSignatureBase(
            request(undefined, [["X-Bytes", "ü"]]), input("x-bytes", flag("bs")),
        )).toThrow(SignatureError);
    });

    it("preserves empty fields but rejects absent fields", () => {
        expectBase(request(undefined, [["X-Empty", "\t "]]),
            { name: "x-empty", parameters: [] }, '"x-empty"', "");
        expect(() => createSignatureBase(request(), input("x-empty")))
            .toThrow(SignatureError);
    });

    it("requires explicit HTTP/1.1 context for obsolete folding", () => {
        expect(() => createSignatureBase(
            request(undefined, [["X-Fold", "one\r\n two"]]), input("x-fold"),
        )).toThrow(SignatureError);
    });

    it("rejects unrecognized SF types and missing Dictionary keys", () => {
        expect(() => createSignatureBase(request(undefined, headers), input("example-dict", flag("sf"))))
            .toThrow(SignatureError);
        expect(() => createSignatureBase(request(undefined, headers),
            input("example-dict", stringParam("key", "absent")), types)).toThrow(SignatureError);
    });
});

describe("RFC 9421 §2.2 derived components", () => {
    it.each([
        ["@authority", "https://EXAMPLE.com:443/x", "example.com"],
        ["@authority", "http://EXAMPLE.com:80/x", "example.com"],
        ["@authority", "https://EXAMPLE.com:8443/x", "example.com:8443"],
        ["@authority", "https://[2001:DB8::1]:443/x", "[2001:db8::1]"],
        ["@scheme", "HTTPS://example.com/x", "https"],
        ["@path", "https://example.com", "/"],
        ["@path", "https://example.com/a/../b%2fc?x=1", "/a/../b%2fc"],
        ["@query", "https://example.com/", "?"],
        ["@query", "https://example.com/?", "?"],
        ["@query", "https://example.com/?a=%2f&b=+&a=2", "?a=%2f&b=+&a=2"],
        ["@target-uri", "https://example.com/a/../b%2f?x=+", "https://example.com/a/../b%2f?x=+"],
    ])("%s preserves the required URI semantics", (name, uri, expected) => {
        expectBase(request(uri), { name, parameters: [] }, `"${name}"`, expected);
    });

    it.each([
        ["var", "this%20is%20a%20big%0Amultiline%20value"],
        ["bar", "with%20plus%20whitespace"],
        ["fa%C3%A7ade%22%3A%20", "something"],
        ["qux", ""],
    ])("matches the §2.2.8 encoding for %s", (name, expected) => {
        const uri = "https://example.com/parameters?var=this%20is%20a%20big%0Amultiline%20value"
            + "&bar=with+plus+whitespace&fa%C3%A7ade%22%3A%20=something&qux=";
        expectBase(request(uri), { name: "@query-param", parameters: stringParam("name", name) },
            `"@query-param";name="${name}"`, expected);
    });

    it("rejects repeated decoded query names, including empty first values", () => {
        for (const query of ["a=1&a=2", "a=&a=2", "a=1&%61=2"]) {
            expect(() => createSignatureBase(request(`https://example.com/?${query}`),
                input("@query-param", stringParam("name", "a")))).toThrow(SignatureError);
        }
    });

    it("requires a raw request target rather than deriving one", () => {
        expect(() => createSignatureBase(request(), input("@request-target")))
            .toThrow(SignatureError);
        expectBase({
            kind: "request",
            request: { method: "OPTIONS", targetUri: "https://example.com/", rawRequestTarget: "*", headers: [] },
        }, { name: "@request-target", parameters: [] }, '"@request-target"', "*");
    });

    it.each([
        "https://example.com/#fragment", "https://user:pass@example.com/",
        "https://example.com/%xx", "https://example.com/has space",
        "https://example.com/\n", "https://example.com/ü",
    ])("rejects invalid target rather than silently repairing %j", (uri) => {
        expect(() => createSignatureBase(request(uri), input("@target-uri"))).toThrow(SignatureError);
    });

    it("keeps method case unchanged", () => {
        expectBase({
            kind: "request",
            request: { method: "custom", targetUri: "https://example.com/", headers: [] },
        }, { name: "@method", parameters: [] }, '"@method"', "custom");
    });
});

describe("component rejection and bounded output", () => {
    it.each([
        { name: "@signature-params", parameters: [] },
        { name: "@unknown", parameters: [] },
        { name: "@method", parameters: flag("req") },
        { name: "@method", parameters: flag("sf") },
        { name: "@query-param", parameters: [] },
        { name: "x", parameters: flag("tr") },
        { name: "x", parameters: flag("unknown") },
        { name: "x", parameters: [...flag("sf"), ...flag("bs")] },
        { name: "x", parameters: [["sf", { kind: "boolean", value: false }]] },
    ] satisfies CoveredComponent[])("rejects invalid/unsupported component %#", (component) => {
        expect(() => createSignatureBase(request(undefined, [["x", "a=1"]]), {
            label: "test", components: [component], parameters: [],
        })).toThrow(SignatureError);
    });

    it("rejects duplicate covered identifiers", () => {
        const component = { name: "@method", parameters: [] };
        expect(() => createSignatureBase(request(), {
            label: "test", components: [component, component], parameters: [],
        })).toThrow(SignatureError);
    });

    it("uses frozen explicit core SF limits and rejects expansion overflow", () => {
        expect(Object.isFrozen(CORE_SF_LIMITS)).toBe(true);
        expect(Object.isFrozen(DEFAULT_CORE_LIMITS)).toBe(true);
        expect(CORE_SF_LIMITS.maxInputBytes).toBe(16_384);
        const message = request(undefined, [["x", "a".repeat(12_288)]]);
        expect(() => createSignatureBase(message, input("x", flag("bs"))))
            .toThrow(SignatureLimitError);
    });

    it("checks the complete signature-base length, including its final parameters", () => {
        const message = request();
        const descriptor = input("@method");
        const size = createSignatureBase(message, descriptor).bytes.length;
        expect(() => createSignatureBase(message, descriptor, {
            limits: { maxSignatureBaseBytes: size - 1 },
        })).toThrow(SignatureLimitError);
        expect(createSignatureBase(message, descriptor, {
            limits: { maxSignatureBaseBytes: size },
        }).bytes).toHaveLength(size);
    });
});