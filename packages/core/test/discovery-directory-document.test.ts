import { readFileSync } from "node:fs";
import { createPublicKey } from "node:crypto";
import { assertSelectedKeyIdentity } from "../src/profiles/metadata.js";
import { describe, expect, it } from "vitest";
import {
    assertDirectoryDocument, DirectoryDocumentError, parseDirectoryDocument,
} from "../src/discovery/directory-document.js";
import type { JwksFormat } from "../src/profiles/jwks-algorithm.js";

const root = new URL("../../../tests/fixtures/jwks/", import.meta.url);
const read = (name: string): unknown =>
    JSON.parse(readFileSync(new URL(name, root), "utf8")) as unknown;
const encode = (value: unknown): Uint8Array => Buffer.from(JSON.stringify(value));
const material = read("public-material.json") as Record<string, {
    key: Record<string, unknown>; thumbprint: string;
}>;
const ed = material.ed25519!;

interface Fixture {
    id: string;
    format: JwksFormat;
    jwks: unknown;
    expected: {
        load: "accepted" | "rejected";
        selectableThumbprints?: string[];
        skippedCount?: number;
    };
}

describe("remote document validation against independent JWKS matrices", () => {
    for (const name of ["load-cases.json", "metadata-cases.json", "algorithm-cases.json"]) {
        const matrix = read(name) as { cases: Fixture[] };
        describe(name, () => {
            for (const row of matrix.cases) {
                it(row.id, () => {
                    const run = () => parseDirectoryDocument(encode(row.jwks), row.format);
                    if (row.expected.load === "rejected") {
                        expect(run).toThrow(DirectoryDocumentError);
                        return;
                    }
                    const document = run();
                    expect(document.jwks.keys.map((key) => key.thumbprint))
                        .toEqual(row.expected.selectableThumbprints);
                    expect(document.jwks.skippedCount).toBe(row.expected.skippedCount);
                    expect(document.format).toBe(row.format);
                    expect(Object.isFrozen(document)).toBe(true);
                    expect(() => assertDirectoryDocument(document)).not.toThrow();
                });
            }
        });
    }
});

describe("remote document boundaries and trust separation", () => {
    it("rejects an entire set containing private material without exposing metadata", () => {
        let caught: unknown;
        try {
            parseDirectoryDocument(encode({
                keys: [ed.key, { ...ed.key, kid: "REMOTE-LABEL", d: "PRIVATE-MARKER" }],
            }), "jwks");
        } catch (error) { caught = error; }
        expect(caught).toBeInstanceOf(DirectoryDocumentError);
        expect((caught as Error).message).toBe("Directory document rejected");
        expect(caught).not.toHaveProperty("cause");
        expect((caught as DirectoryDocumentError).diagnostic).toEqual({
            keyIndex: 1,
            rule: "public JWKS must not contain private or symmetric key material",
        });
        expect((caught as DirectoryDocumentError).reason).toBe("invalid-jwks");
        expect(JSON.stringify(caught)).not.toContain("REMOTE-LABEL");
        expect(JSON.stringify(caught)).not.toContain("PRIVATE-MARKER");
        expect(caught).not.toHaveProperty("code");
    });

    it.each([
        { keys: [] },
        { keys: [material.rsa!.key] },
    ])("accepts a complete set with no selectable key %#", ({ keys }) => {
        const document = parseDirectoryDocument(encode({ keys }), "jwks");
        expect(document.jwks.keys).toHaveLength(0);
        expect(document.jwks.lookup(ed.thumbprint))
            .toEqual({ status: "unverified", reason: "unknown-key" });
    });

    it("counts duplicate and unsupported entries toward the 64-key bound", () => {
        const keys = Array.from({ length: 64 }, (_, index) =>
            index % 2 === 0 ? ed.key : material.rsa!.key);
        const document = parseDirectoryDocument(encode({ keys }), "jwks");
        expect(document.jwks.keys.length + document.jwks.skippedCount).toBe(64);
        expect(() => parseDirectoryDocument(encode({ keys: [...keys, ed.key] }), "jwks"))
            .toThrow(DirectoryDocumentError);
    });

    it("accepts the exact byte boundary and rejects one byte beyond it", () => {
        const text = '{"keys":[]}';
        const bytes = Buffer.from(text.padEnd(262144, " "));
        expect(parseDirectoryDocument(bytes, "jwks").bodyBytes).toBe(262144);
        expect(() => parseDirectoryDocument(Buffer.concat([bytes, Buffer.from(" ")]), "jwks"))
            .toThrow(DirectoryDocumentError);
    });

    it.each([
        Buffer.from([0xff]), Buffer.from('{"keys":['),
        Buffer.from('{"keys":[{}]}'), Buffer.from('{"keys":null}'),
    ])("rejects invalid UTF-8, JSON, structure or material %#", (bytes) => {
        expect(() => parseDirectoryDocument(bytes, "jwks")).toThrow(DirectoryDocumentError);
    });

    it("retains no mutable input buffer and grants neither identity nor test-key permission", () => {
        const bytes = encode({ keys: [ed.key] });
        const document = parseDirectoryDocument(bytes, "jwks");
        bytes.fill(0);
        expect(document.jwks.lookup(ed.thumbprint).status).toBe("found");
        expect(document.jwks.keys[0]!.knownTestKey).toBe(true);
        for (const field of ["body", "identity", "trustSource", "verified", "allowTestKeys"]) {
            expect(document).not.toHaveProperty(field);
        }
        expect(document.accountedBytes).toBe(document.bodyBytes + 2048);
    });

    it("ignores undefined key-time extensions rather than inventing JWT semantics", () => {
        const document = parseDirectoryDocument(encode({
            keys: [{ ...ed.key, nbf: "not-a-defined-key-policy", exp: 0 }],
        }), "wg-directory-00");
        expect(document.jwks.lookup(ed.thumbprint).status).toBe("found");
    });

    it("matches the pinned defensive key-identity and WG refresh rejection gates", () => {
        const rotation = JSON.parse(readFileSync(new URL(
            "../../../tests/fixtures/m3-rotation/cases.json", import.meta.url,
        ), "utf8")) as {
            keys: Record<string, {
                jwk: { kty: string; crv: string; x: string }; thumbprint: string;
            }>;
            cases: {
                id: string; signedKeyIdFrom?: string; selectedMaterialFrom?: string;
                expected: { status: string; reason: string };
                refreshKeys?: { materialFrom: string; kidFrom: string }[];
                refreshExpected?: { reason: string; diagnostic: { keyIndex: number; rule: string } };
            }[];
        };
        const mismatch = rotation.cases.find((row) =>
            row.id === "c-same-keyid-different-selected-material")!;
        const selected = createPublicKey({
            key: rotation.keys[mismatch.selectedMaterialFrom!]!.jwk, format: "jwk",
        });
        expect(() => assertSelectedKeyIdentity(
            rotation.keys[mismatch.signedKeyIdFrom!]!.thumbprint, selected,
        )).toThrow(expect.objectContaining({ rejection: mismatch.expected }));

        for (const row of rotation.cases.filter((entry) => entry.refreshExpected)) {
            const keys = row.refreshKeys!.map((entry) => ({
                ...rotation.keys[entry.materialFrom]!.jwk,
                kid: rotation.keys[entry.kidFrom]!.thumbprint,
            }));
            let caught: unknown;
            try { parseDirectoryDocument(encode({ keys }), "wg-directory-00"); }
            catch (error) { caught = error; }
            expect(caught).toBeInstanceOf(DirectoryDocumentError);
            const error = caught as DirectoryDocumentError;
            expect(error.reason).toBe(row.refreshExpected!.reason);
            expect(error.diagnostic).toEqual(row.refreshExpected!.diagnostic);
            expect(Object.isFrozen(error.diagnostic)).toBe(true);
            expect(error.diagnostic).not.toHaveProperty("kid");
            expect(error).not.toHaveProperty("cause");
            // These are document/identity gates, not the full c-prime verifier outcomes.
        }
    });

    it("omits an entry index when the document cannot be parsed", () => {
        let caught: unknown;
        try { parseDirectoryDocument(Buffer.from("{"), "wg-directory-00"); }
        catch (error) { caught = error; }
        expect(caught).toBeInstanceOf(DirectoryDocumentError);
        expect((caught as DirectoryDocumentError).diagnostic).not.toHaveProperty("keyIndex");
        expect(caught).not.toHaveProperty("cause");
    });

    it("rejects copied documents and does not infer a missing format", () => {
        const document = parseDirectoryDocument(encode({ keys: [] }), "jwks");
        expect(() => assertDirectoryDocument({ ...document })).toThrow(DirectoryDocumentError);
        expect(() => parseDirectoryDocument(encode({ keys: [] }), undefined as unknown as JwksFormat))
            .toThrow(expect.objectContaining({ code: "invalid-agent-binding" }));
    });
});