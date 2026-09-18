import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveCoreLimits } from "../src/limits.js";
import type { RequestParts } from "../src/types.js";
import { snapshotUnsignedRequest } from "../src/profiles/signing-request.js";
import { SigningError } from "../src/profiles/signing-errors.js";

const limits = resolveCoreLimits();
const fixtures = JSON.parse(readFileSync(new URL(
    "../../../tests/fixtures/signing/negative-cases.json", import.meta.url,
), "utf8")) as {
    existingHeaders: {
        header: [string, string];
        expectedCode: string;
    }[];
};

function request(): RequestParts {
    return {
        method: "GET",
        targetUri: "https://merchant.example/items?sku=42",
        headers: [["X-Example", "unchanged"]],
    };
}

describe("unsigned request snapshot — pinned collision expectations", () => {
    for (const [index, fixture] of fixtures.existingHeaders.entries()) {
        it(`collision ${index}: ${fixture.header[0]}`, () => {
            const entry = Object.freeze([...fixture.header] as [string, string]);
            const headers = Object.freeze([entry]);
            const source = Object.freeze({ ...request(), headers });
            expect(() => snapshotUnsignedRequest(source, limits)).toThrow(
                expect.objectContaining({ code: fixture.expectedCode }),
            );
            expect(source.headers).toBe(headers);
            expect(source.headers[0]).toBe(entry);
            expect(entry).toEqual(fixture.header);
        });
    }
});

describe("unsigned request ownership and bounds", () => {
    it("retains caller references and owns copied bytes and tuples", () => {
        const bytes = new Uint8Array([65, 66]);
        const tuple: [string, Uint8Array] = ["X-Bytes", bytes];
        const headers = [tuple];
        const source = { ...request(), headers };
        const snapshot = snapshotUnsignedRequest(source, limits);
        expect(source.headers).toBe(headers);
        expect(source.headers[0]).toBe(tuple);
        expect(source.headers[0]![1]).toBe(bytes);
        expect(Array.from(bytes)).toEqual([65, 66]);
        expect(snapshot.headers).not.toBe(headers);
        expect(snapshot.headers[0]).not.toBe(tuple);
        expect(snapshot.headers[0]![1]).not.toBe(bytes);
        bytes[0] = 90;
        tuple[0] = "Changed";
        headers.length = 0;
        source.method = "POST";
        expect(snapshot.method).toBe("GET");
        expect(snapshot.headers[0]![0]).toBe("X-Bytes");
        expect(snapshot.headers[0]![1]).toEqual(new Uint8Array([65, 66]));
        expect(Object.isFrozen(snapshot)).toBe(true);
        expect(Object.isFrozen(snapshot.headers)).toBe(true);
        expect(Object.isFrozen(snapshot.headers[0])).toBe(true);
    });

    it("copies optional request context without inventing it", () => {
        const source = { ...request(), rawRequestTarget: "/raw?q=1", httpVersion: "1.1" as const };
        expect(snapshotUnsignedRequest(source, limits)).toEqual(source);
        expect(snapshotUnsignedRequest(request(), limits)).not.toHaveProperty("httpVersion");
    });

    it("rejects existing headers without reading their values", () => {
        let reads = 0;
        const entry: [string, string] = ["sIgNaTuRe", ""];
        Object.defineProperty(entry, "1", { get() { reads++; throw new Error("SECRET"); } });
        const source: RequestParts = { ...request(), headers: [entry] };
        expect(() => snapshotUnsignedRequest(source, limits)).toThrow(
            expect.objectContaining({ code: "existing-signature-headers" }),
        );
        expect(reads).toBe(0);
    });

    it("does not execute request or ordinary header accessors", () => {
        let reads = 0;
        const source = Object.defineProperty(request(), "method", {
            get() { reads++; return "GET"; },
        });
        expect(() => snapshotUnsignedRequest(source, limits)).toThrow(SigningError);
        const entry: [string, string] = ["X-Example", ""];
        Object.defineProperty(entry, "1", { get() { reads++; return "value"; } });
        expect(() => snapshotUnsignedRequest({
            ...request(), headers: [entry],
        }, limits)).toThrow(SigningError);
        expect(reads).toBe(0);
    });

    it("counts exact header descriptor bytes before copying", () => {
        const source = { ...request(), headers: [["X", "a"]] } as RequestParts;
        expect(snapshotUnsignedRequest(source, resolveCoreLimits({
            maxMessageHeaderBytes: 6,
        })).headers).toEqual(source.headers);
        expect(() => snapshotUnsignedRequest(source, resolveCoreLimits({
            maxMessageHeaderBytes: 5,
        }))).toThrow(expect.objectContaining({ code: "resource-limit" }));
        expect(() => snapshotUnsignedRequest({
            ...request(), headers: new Array(100),
        }, resolveCoreLimits({ maxMessageHeaderBytes: 4 }))).toThrow(
            expect.objectContaining({ code: "resource-limit" }),
        );
    });

    it("rejects malformed descriptors without coercion or sensitive diagnostics", () => {
        for (const source of [
            null, [], { ...request(), method: 42 },
            { ...request(), headers: [null] },
            { ...request(), headers: [["Bad Name", "SECRET"]] },
            { ...request(), headers: [["X-Example", "ü"]] },
            { ...request(), headers: [["X-Example", 42]] },
            { ...request(), headers: new Array(1) },
            { ...request(), httpVersion: "unknown" },
        ]) {
            let caught: unknown;
            try { snapshotUnsignedRequest(source as RequestParts, limits); }
            catch (error) { caught = error; }
            expect(caught).toBeInstanceOf(SigningError);
            expect((caught as SigningError).code).toBe("invalid-request");
            expect((caught as Error).message).not.toContain("SECRET");
        }
    });
});