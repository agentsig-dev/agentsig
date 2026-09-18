import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadJwks } from "../src/profiles/jwks.js";
import { InvalidJwksError } from "../src/profiles/jwks-error.js";
import {
    HTTP_SIGNATURE_ALGORITHM_NAMES,
    JOSE_ALGORITHM_NAMES,
} from "../src/profiles/jwks-algorithm.js";
import type { JwksFormat } from "../src/profiles/jwks-algorithm.js";

interface Fixture {
    readonly id: string;
    readonly format: JwksFormat;
    readonly jwks: { readonly keys: Record<string, unknown>[] };
    readonly expected: {
        readonly load: "accepted" | "rejected";
        readonly code?: string;
        readonly selectableThumbprints?: string[];
        readonly skippedCount?: number;
        readonly skipped?: {
            readonly kid: string | null;
            readonly thumbprint: string;
            readonly requestCode: "unsupported-algorithm";
            readonly reason?: string;
        }[];
        readonly diagnostic?: {
            readonly keyIndex: number;
            readonly kid: string | null;
            readonly rule: string;
        };
    };
}

const root = new URL("../../../tests/fixtures/jwks/", import.meta.url);
function readJson(name: string): unknown {
    return JSON.parse(readFileSync(new URL(name, root), "utf8")) as unknown;
}
const matrices = ["load-cases.json", "metadata-cases.json", "algorithm-cases.json"]
    .map((name) => ({
        name,
        fixtures: (readJson(name) as { cases: Fixture[] }).cases,
    }));
const material = readJson("public-material.json") as Record<string, {
    key: Record<string, unknown>;
    thumbprint: string;
}>;
const ed = material.ed25519!;

describe("local JWKS — pre-implementation fixture contract", () => {
    for (const { name, fixtures } of matrices) {
        describe(name, () => {
            for (const fixture of fixtures) {
                it(fixture.id, () => {
                    const json = JSON.stringify(fixture.jwks);
                    for (const input of [fixture.jwks, json, Buffer.from(json)]) {
                        const run = () => loadJwks(input, { format: fixture.format });
                        const expected = fixture.expected;
                        if (expected.load === "rejected") {
                            let caught: unknown;
                            try { run(); } catch (error) { caught = error; }
                            expect(caught).toBeInstanceOf(InvalidJwksError);
                            const error = caught as InvalidJwksError;
                            expect(error.code).toBe(expected.code);
                            if (expected.diagnostic) {
                                const diagnostic = expected.diagnostic;
                                expect(error.diagnostic).toEqual({
                                    keyIndex: diagnostic.keyIndex,
                                    rule: diagnostic.rule,
                                    ...(diagnostic.kid === null ? {} : { kid: diagnostic.kid }),
                                });
                                expect(error.message).toContain(`keys[${diagnostic.keyIndex}]`);
                                expect(error.message).toContain(diagnostic.rule);
                                if (diagnostic.kid !== null) {
                                    expect(error.message).toContain(JSON.stringify(diagnostic.kid));
                                }
                            }
                            expect(error.message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
                            continue;
                        }
                        const loaded = run();
                        expect(loaded.format).toBe(fixture.format);
                        expect(loaded.keys.map((key) => key.thumbprint))
                            .toEqual(expected.selectableThumbprints);
                        expect(loaded.skippedCount).toBe(expected.skippedCount);
                        expect(loaded.skipped).toHaveLength(expected.skippedCount!);
                        for (const [index, report] of loaded.skipped.entries()) {
                            expect(report).toMatchObject(expected.skipped![index]!);
                            expect(report).not.toHaveProperty("publicKey");
                            expect(loaded.lookup(report.thumbprint)).toEqual({
                                status: "unverified", reason: "unsupported-algorithm",
                            });
                            expect(Object.isFrozen(report)).toBe(true);
                        }
                        for (const key of loaded.keys) {
                            expect(key.publicKey.asymmetricKeyType).toBe("ed25519");
                            expect(loaded.lookup(key.thumbprint)).toEqual({ status: "found", key });
                            expect(Object.isFrozen(key)).toBe(true);
                        }
                        expect(Object.isFrozen(loaded)).toBe(true);
                        expect(Object.isFrozen(loaded.keys)).toBe(true);
                        expect(Object.isFrozen(loaded.skipped)).toBe(true);
                    }
                });
            }
        });
    }
});

describe("JWKS bounds, snapshot isolation and selection", () => {
    it("matches both complete source-pinned algorithm name lists", () => {
        const lists = readJson("algorithm-lists.json") as Record<string, { names: string[] }>;
        expect(JOSE_ALGORITHM_NAMES).toEqual(lists.jwks!.names);
        expect(HTTP_SIGNATURE_ALGORITHM_NAMES).toEqual(lists["wg-directory-00"]!.names);
        expect(Object.isFrozen(JOSE_ALGORITHM_NAMES)).toBe(true);
        expect(Object.isFrozen(HTTP_SIGNATURE_ALGORITHM_NAMES)).toBe(true);
    });

    it("defaults to JOSE, not WG, and never selects by an arbitrary kid", () => {
        const loaded = loadJwks({ keys: [{ ...ed.key, kid: "operator-label", alg: "EdDSA" }] });
        expect(loaded.format).toBe("jwks");
        expect(loaded.lookup(ed.thumbprint).status).toBe("found");
        expect(loaded.lookup("operator-label")).toEqual({
            status: "unverified", reason: "unknown-key",
        });
        expect(() => loadJwks({ keys: [{ ...ed.key, alg: "ed25519" }] }))
            .toThrow(InvalidJwksError);
    });

    it("reports known test material without approving it for request verification", () => {
        const loaded = loadJwks({ keys: [ed.key] });
        expect(loaded.keys[0]!.knownTestKey).toBe(true);
        expect(loaded.lookup(ed.thumbprint).status).toBe("found");
        expect(loaded).not.toHaveProperty("verified");
    });

    it("owns material and reports independently of caller mutation", () => {
        const source = {
            keys: [{ ...ed.key, kid: "original", key_ops: ["verify"] }],
        };
        const loaded = loadJwks(source);
        const der = loaded.keys[0]!.publicKey.export({ type: "spki", format: "der" });
        source.keys[0]!.key_ops.push("encrypt");
        source.keys[0]!.kid = "changed";
        source.keys.length = 0;
        expect(loaded.keys[0]!.kid).toBe("original");
        expect(loaded.lookup(ed.thumbprint).status).toBe("found");
        expect(loaded.keys[0]!.publicKey.export({ type: "spki", format: "der" })).toEqual(der);
    });

    it("enforces byte budgets on objects, text and bytes at the exact boundary", () => {
        const source = { keys: [ed.key] };
        const text = JSON.stringify(source);
        const bytes = Buffer.byteLength(text);
        for (const input of [source, text, Buffer.from(text)]) {
            expect(loadJwks(input, { limits: { maxJwksBytes: bytes } }).keys).toHaveLength(1);
            expect(() => loadJwks(input, { limits: { maxJwksBytes: bytes - 1 } }))
                .toThrow(expect.objectContaining({ code: "invalid-jwks" }));
        }
    });

    it("counts every entry before material import, including unsupported keys", () => {
        const source = { keys: [ed.key, material.rsa!.key] };
        expect(loadJwks(source, { limits: { maxKeys: 2 } }).skippedCount).toBe(1);
        expect(() => loadJwks(source, { limits: { maxKeys: 1 } }))
            .toThrow("keys length must not exceed maxKeys");
        // The limit error precedes any import of this malformed entry.
        expect(() => loadJwks({ keys: [{}] }, { limits: { maxKeys: 0 } }))
            .toThrow("keys length must not exceed maxKeys");
        expect(loadJwks({ keys: [] }, { limits: { maxKeys: 0 } }).keys).toHaveLength(0);
    });

    it.each([null, [], {}, { keys: null }, { keys: {} }, { keys: [null] }, { keys: [[]] }])(
        "rejects malformed set structure %#", (input) => {
            expect(() => loadJwks(input)).toThrow(InvalidJwksError);
        },
    );

    it("locates malformed material without exposing private or public component values", () => {
        const marker = "PRIVATE-MATERIAL-NOT-FOR-LOGS";
        let caught: unknown;
        try {
            loadJwks({ keys: [ed.key, { ...ed.key, kid: "bad-key", d: marker }] });
        } catch (error) { caught = error; }
        expect(caught).toBeInstanceOf(InvalidJwksError);
        const error = caught as InvalidJwksError;
        expect(error.diagnostic.keyIndex).toBe(1);
        expect(error.message).toContain('kid="bad-key"');
        expect(error.message).toContain("private or symmetric key material");
        expect(error.message).not.toContain(marker);
        expect(error.message).not.toContain(ed.key.x);
    });

    it("does not execute getters in configuration or input", () => {
        let reads = 0;
        const getter = () => { reads++; return "jwks"; };
        expect(() => loadJwks({ keys: [] }, Object.defineProperty({}, "format", { get: getter })))
            .toThrow(InvalidJwksError);
        expect(() => loadJwks(Object.defineProperty({}, "keys", {
            enumerable: true, get: getter,
        }))).toThrow(InvalidJwksError);
        expect(reads).toBe(0);
    });

    it("rejects unknown format and preserves invalid-resource-limits classification", () => {
        expect(() => loadJwks({ keys: [] }, { format: "guess" as JwksFormat }))
            .toThrow(InvalidJwksError);
        expect(() => loadJwks({ keys: [] }, { limits: { maxKeys: -1 } }))
            .toThrow(expect.objectContaining({ code: "invalid-resource-limits" }));
    });

    it("performs no fetch for unknown keys or metadata URLs", () => {
        const originalFetch = globalThis.fetch;
        let calls = 0;
        globalThis.fetch = (() => {
            calls++;
            throw new Error("Network must not be used");
        }) as typeof fetch;
        try {
            const loaded = loadJwks({
                keys: [{
                    ...ed.key, x5u: "https://example.invalid/certificate",
                }]
            });
            expect(loaded.lookup("https://example.invalid/key")).toEqual({
                status: "unverified", reason: "unknown-key",
            });
            expect(calls).toBe(0);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});