import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveHttpConfiguration } from "../src/http/configuration.js";
import { HTTP_MAPPING_ERROR_CODES, HttpMappingError } from "../src/http/errors.js";
import { copyHttpMapping, mapHttpSnapshot } from "../src/http/mapping.js";
import type { HttpIngress, HttpMapperOptions, HttpMappingLimits } from "../src/http/types.js";

interface FixtureCase {
    id: string;
    policy?: string;
    input: Record<string, unknown>;
    limits?: Partial<HttpMappingLimits>;
    expected?: unknown;
    code?: string;
}
const fixture = JSON.parse(readFileSync(new URL(
    "../../../tests/fixtures/m4-http/mapping-cases.json", import.meta.url,
), "utf8")) as {
    defaults: Record<string, unknown>;
    ingressPolicies: Record<string, HttpIngress>;
    positive: FixtureCase[];
    negative: FixtureCase[];
    largeCases: {
        recipe: { first: string[]; repeat: string[]; count: number; last: string[] };
        expected: unknown;
    }[];
};
const contract = JSON.parse(readFileSync(new URL(
    "../../../tests/fixtures/m4-http/contract.json", import.meta.url,
), "utf8")) as { catalog: { codes: string[] } };

function configuration(entry: FixtureCase) {
    return resolveHttpConfiguration({
        ingress: fixture.ingressPolicies[entry.policy ?? "direct"]!,
        ...(entry.limits === undefined ? {} : { limits: entry.limits }),
    });
}
function input(entry: FixtureCase): Record<string, unknown> {
    return { ...fixture.defaults, ...entry.input };
}
function serialized(value: unknown): unknown {
    return JSON.parse(JSON.stringify(value, (_key, item: unknown) =>
        item instanceof Uint8Array ? { bytesHex: Buffer.from(item).toString("hex") } : item)) as unknown;
}

describe("HTTP mapper against pre-implementation independent fixtures", () => {
    it("retains the separately frozen mapping catalog", () => {
        expect(HTTP_MAPPING_ERROR_CODES).toEqual(contract.catalog.codes);
        expect(Object.isFrozen(HTTP_MAPPING_ERROR_CODES)).toBe(true);
        for (const code of HTTP_MAPPING_ERROR_CODES) {
            const error = new HttpMappingError(code);
            expect(error.details).toEqual({});
            expect(Object.hasOwn(error, "cause")).toBe(false);
        }
    });

    for (const entry of fixture.positive) {
        it(entry.id, () => {
            expect(serialized(mapHttpSnapshot(input(entry), configuration(entry)))).toEqual(entry.expected);
        });
    }
    for (const entry of fixture.negative.filter(entry =>
        entry.code !== "capture-missing" && entry.code !== "capture-incomplete")) {
        it(entry.id, () => {
            expect(mapHttpSnapshot(input(entry), configuration(entry))).toEqual({
                status: "mapping-rejected", code: entry.code,
            });
        });
    }
    it("rejects a duplicate Host after 2100 small fields", () => {
        const entry = fixture.largeCases[0]!;
        const { recipe } = entry;
        const rawHeaders = [
            ...recipe.first,
            ...Array.from({ length: recipe.count }, () => recipe.repeat).flat(),
            ...recipe.last,
        ];
        expect(mapHttpSnapshot({ ...fixture.defaults, rawHeaders }, configuration({
            id: "late-host", input: {},
        }))).toEqual(entry.expected);
    });

    it("does not share typed-array storage across public views", () => {
        const entry = fixture.positive.find(entry => entry.id === "obs-text-is-owned-latin1-bytes")!;
        const original = mapHttpSnapshot(input(entry), configuration(entry));
        const first = copyHttpMapping(original);
        if (first.status !== "mapped") throw new Error("Expected mapped fixture");
        const bytes = first.request.headers[1]![1];
        if (!(bytes instanceof Uint8Array)) throw new Error("Expected byte fixture");
        bytes.fill(0);
        expect(serialized(copyHttpMapping(original))).toEqual(entry.expected);
        expect(Object.isFrozen(first)).toBe(true);
        expect(Object.isFrozen(first.request.headers)).toBe(true);
    });

    it("snapshots configuration rather than trusting later mutation", () => {
        const origins = ["https://merchant.example"];
        const configured = resolveHttpConfiguration({ ingress: { allowedOrigins: origins } });
        origins[0] = "https://other.example";
        expect(mapHttpSnapshot(fixture.defaults, configured).status).toBe("mapped");
        expect(mapHttpSnapshot({
            ...fixture.defaults, rawHeaders: ["Host", "other.example"],
        }, configured)).toEqual({ status: "mapping-rejected", code: "origin-disallowed" });
    });

    it("does not execute request or configuration accessors", () => {
        let calls = 0;
        const accessor = { get rawHeaders() { calls++; return []; } };
        const configured = configuration({ id: "accessor", input: {} });
        const descriptor = { ...fixture.defaults };
        Object.defineProperty(descriptor, "rawHeaders",
            Object.getOwnPropertyDescriptor(accessor, "rawHeaders")!);
        expect(mapHttpSnapshot(descriptor, configured)).toEqual({
            status: "mapping-rejected", code: "request-malformed",
        });
        const options = { get ingress() { calls++; return {}; } };
        expect(() => resolveHttpConfiguration(options as HttpMapperOptions)).toThrow(
            "Invalid HTTP integration configuration",
        );
        expect(calls).toBe(0);
    });

    it.each([
        { ingress: { allowedOrigins: [] } },
        { ingress: { allowedOrigins: ["https://merchant.example/path"] } },
        { ingress: { allowedOrigins: ["https://user@merchant.example"] } },
        { ingress: { allowedOrigins: ["https://merchant.example"], trustProxy: true } },
        {
            ingress: {
                mode: "trusted-ingress", family: "forwarded",
                allowedOrigins: ["http://merchant.example"], trustedPeers: ["192.0.2.1"],
                sanitizingIngress: true
            }
        },
        {
            ingress: {
                mode: "trusted-ingress", family: "forwarded",
                allowedOrigins: ["https://merchant.example"], trustedPeers: ["proxy.example"],
                sanitizingIngress: true
            }
        },
        {
            ingress: {
                mode: "trusted-ingress", family: "forwarded",
                allowedOrigins: ["https://merchant.example"], trustedPeers: ["192.0.2.1/33"],
                sanitizingIngress: true
            }
        },
        { ingress: { allowedOrigins: ["https://merchant.example"] }, limits: { maxHeaderBytes: 0 } },
    ])("rejects invalid local configuration %#", options => {
        expect(() => resolveHttpConfiguration(options as HttpMapperOptions)).toThrow(
            "Invalid HTTP integration configuration",
        );
    });
});