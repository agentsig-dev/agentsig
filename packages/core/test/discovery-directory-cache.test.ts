import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DirectoryCache } from "../src/discovery/directory-cache.js";
import type { DirectoryCacheOptions, DirectoryKeySelection } from "../src/discovery/directory-cache.js";
import { DirectoryDocumentError } from "../src/discovery/directory-document.js";
import type { DirectoryResponse } from "../src/discovery/directory-response.js";

const material = JSON.parse(readFileSync(new URL(
    "../../../tests/fixtures/jwks/public-material.json", import.meta.url,
), "utf8")) as Record<string, { key: Record<string, unknown>; thumbprint: string }>;
const ed = material.ed25519!;
const replacement = {
    kty: "OKP", crv: "Ed25519", x: "JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs",
};
const replacementThumbprint = "poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U";
const origin = "https://directory.agentsig.test";

function harness(options: DirectoryCacheOptions = {}) {
    let now = 1000;
    const cache = new DirectoryCache("wg-directory-00", options, () => now);
    const response = (
        keys: readonly Record<string, unknown>[] = [ed.key],
        headers: readonly (readonly [string, string])[] = [],
    ): DirectoryResponse => ({
        body: Buffer.from(JSON.stringify({ keys })), headers,
        requestStartedMonotonicMs: now, responseReceivedMonotonicMs: now,
        responseReceivedWallMs: 1800000000000,
    });
    const selection = (): DirectoryKeySelection => {
        const result = cache.lookup(origin, ed.thumbprint);
        if (result.status !== "found") throw new Error("Expected a cached key");
        return result.selection;
    };
    return { cache, response, selection, advance(ms: number) { now += ms; }, setNow(ms: number) { now = ms; } };
}

describe("directory cache freshness and whole-set replacement", () => {
    it("uses the default 60 seconds with an exclusive expiry boundary", () => {
        const h = harness();
        expect(h.cache.replace(origin, h.response())).toBe(true);
        const selected = h.selection();
        h.advance(59999);
        expect(h.cache.recheck(selected)).toBe(true);
        h.advance(1);
        expect(h.cache.lookup(origin, ed.thumbprint)).toEqual({ status: "missing", reason: "unknown-key" });
        expect(h.cache.recheck(selected)).toBe(false);
        expect(h.cache.stats.positiveEntries).toBe(1); // Retained, never stale acceptance.
    });

    it("subtracts wire age before caching and never resets age on reads", () => {
        const h = harness();
        h.cache.replace(origin, h.response([ed.key], [["age", "20"]]));
        const selected = h.selection();
        h.advance(39999);
        expect(h.cache.recheck(selected)).toBe(true);
        h.advance(1);
        expect(h.cache.recheck(selected)).toBe(false);
    });

    it("caps an explicit long lifetime at 300 seconds", () => {
        const h = harness();
        h.cache.replace(origin, h.response([ed.key], [["cache-control", "max-age=86400"]]));
        const selected = h.selection();
        h.advance(300000);
        expect(h.cache.recheck(selected)).toBe(false);
    });

    it("atomically replaces instead of merging the key set", () => {
        const h = harness();
        h.cache.replace(origin, h.response());
        const old = h.selection();
        h.cache.replace(origin, h.response([replacement]));
        expect(h.cache.recheck(old)).toBe(false);
        expect(h.cache.lookup(origin, ed.thumbprint).status).toBe("missing");
        expect(h.cache.lookup(origin, replacementThumbprint).status).toBe("found");
        expect(h.cache.stats.positiveEntries).toBe(1);
    });

    it("treats a successfully validated empty set as removal", () => {
        const h = harness();
        h.cache.replace(origin, h.response());
        const old = h.selection();
        expect(h.cache.replace(origin, h.response([]))).toBe(true);
        expect(h.cache.recheck(old)).toBe(false);
        expect(h.cache.lookup(origin, ed.thumbprint).status).toBe("missing");
    });

    it("rejects an old selection after replacement during an asynchronous wait", async () => {
        const h = harness();
        h.cache.replace(origin, h.response());
        const old = h.selection();
        await Promise.resolve().then(() => h.cache.replace(origin, h.response([replacement])));
        // Cache-level final check only, not a full verifier/replay integration test.
        expect(h.cache.recheck(old)).toBe(false);
    });

    it("does not revive a selection if the same key is reintroduced", () => {
        const h = harness();
        h.cache.replace(origin, h.response());
        const old = h.selection();
        h.cache.replace(origin, h.response([]));
        h.cache.replace(origin, h.response());
        expect(h.cache.recheck(old)).toBe(false);
        expect(h.cache.recheck(h.selection())).toBe(true);
    });

    it("conservatively invalidates the old generation even if its key remains", () => {
        const h = harness();
        h.cache.replace(origin, h.response());
        const old = h.selection();
        h.cache.replace(origin, h.response());
        expect(h.cache.recheck(old)).toBe(false);
        expect(h.cache.recheck(h.selection())).toBe(true);
    });

    it("rejects a malformed full set without mutating prior evidence or counters", () => {
        const h = harness();
        h.cache.replace(origin, h.response());
        const old = h.selection();
        const before = h.cache.stats;
        expect(() => h.cache.replace(origin, h.response([replacement, { ...ed.key, d: "secret" }])))
            .toThrow(DirectoryDocumentError);
        expect(h.cache.stats).toEqual(before);
        expect(h.cache.recheck(old)).toBe(true);
        expect(h.cache.lookup(origin, replacementThumbprint).status).toBe("missing");
    });

    it.each(["no-store", "private"])("invalidates older evidence without persisting %s", (directive) => {
        const h = harness();
        h.cache.replace(origin, h.response());
        const old = h.selection();
        expect(h.cache.replace(origin, h.response([replacement], [["cache-control", directive]]))).toBe(false);
        expect(h.cache.recheck(old)).toBe(false);
        expect(h.cache.stats.positiveEntries).toBe(0);
        expect(h.cache.stats.positiveAccountedBytes).toBe(0);
    });

    it.each(["no-cache", "max-age=0"])("does not reuse evidence requiring %s", (directive) => {
        const h = harness();
        h.cache.replace(origin, h.response([ed.key], [["cache-control", directive]]));
        expect(h.cache.lookup(origin, ed.thumbprint).status).toBe("missing");
    });

    it("does not grant selection for unsupported keys", () => {
        const h = harness();
        h.cache.replace(origin, h.response([material.rsa!.key]));
        expect(h.cache.lookup(origin, material.rsa!.thumbprint))
            .toEqual({ status: "missing", reason: "unsupported-algorithm" });
    });

    it("rejects fabricated and foreign cache selections", () => {
        const h = harness();
        h.cache.replace(origin, h.response());
        const selected = h.selection();
        expect(h.cache.recheck({ ...selected })).toBe(false);
        expect(harness().cache.recheck(selected)).toBe(false);
    });
});

describe("bounded origin-level negative cache", () => {
    it("blocks for 60 seconds without modifying positive evidence", () => {
        const h = harness();
        h.cache.replace(origin, h.response());
        const old = h.selection();
        h.cache.recordFailure(origin);
        expect(h.cache.fetchBlocked(origin)).toBe(true);
        expect(h.cache.recheck(old)).toBe(true);
        h.advance(59999);
        expect(h.cache.fetchBlocked(origin)).toBe(true);
        h.advance(1);
        expect(h.cache.fetchBlocked(origin)).toBe(false);
        expect(h.cache.recheck(old)).toBe(false);
        expect(h.cache.stats.positiveEntries).toBe(1);
        expect(h.cache.stats.negativeEntries).toBe(0);
    });

    it("clears origin backoff on a valid replacement, not malformed input", () => {
        const h = harness();
        h.cache.recordFailure(origin);
        expect(() => h.cache.replace(origin, h.response([{}]))).toThrow(DirectoryDocumentError);
        expect(h.cache.fetchBlocked(origin)).toBe(true);
        h.cache.replace(origin, h.response([]));
        expect(h.cache.fetchBlocked(origin)).toBe(false);
    });

    it("bounds distinct-origin records without evicting live backoff", () => {
        const h = harness({ maxNegativeEntries: 2 });
        h.cache.recordFailure(origin);
        h.cache.recordFailure("https://second.example");
        h.cache.recordFailure("https://third.example");
        expect(h.cache.stats.negativeEntries).toBe(2);
        expect(h.cache.fetchBlocked(origin)).toBe(true);
        expect(h.cache.fetchBlocked("https://third.example")).toBe(true);
        expect(h.cache.fetchBlocked("https://otherwise-unseen.example")).toBe(true);
        h.advance(60000);
        expect(h.cache.fetchBlocked("https://otherwise-unseen.example")).toBe(false);
    });

    it("stores no per-key negative records for random thumbprints", () => {
        const h = harness();
        h.cache.replace(origin, h.response([]));
        for (let index = 0; index < 100000; index++) {
            expect(h.cache.lookup(origin, `unknown-${index}`).status).toBe("missing");
        }
        expect(h.cache.stats).toMatchObject({ positiveEntries: 1, negativeEntries: 0 });
    });

    it("supports explicit zero negative duration and a 300-second duration", () => {
        const disabled = harness({ negativeSeconds: 0 });
        disabled.cache.recordFailure(origin);
        expect(disabled.cache.fetchBlocked(origin)).toBe(false);
        const capped = harness({ negativeSeconds: 300 });
        capped.cache.recordFailure(origin);
        capped.advance(299999);
        expect(capped.cache.fetchBlocked(origin)).toBe(true);
        capped.advance(1);
        expect(capped.cache.fetchBlocked(origin)).toBe(false);
    });
});

describe("cache capacity, isolation and monotonic health", () => {
    it("evicts by entry count and invalidates outstanding selections", () => {
        const h = harness({ maxPositiveEntries: 1 });
        h.cache.replace(origin, h.response());
        const old = h.selection();
        h.cache.replace("https://other.example", h.response());
        expect(h.cache.stats.positiveEntries).toBe(1);
        expect(h.cache.recheck(old)).toBe(false);
    });

    it("enforces accounted-byte capacity independently of entry count", () => {
        const h = harness({ maxPositiveAccountedBytes: 3500 });
        h.cache.replace(origin, h.response());
        const old = h.selection();
        h.cache.replace("https://other.example", h.response());
        expect(h.cache.stats.positiveEntries).toBe(1);
        expect(h.cache.stats.positiveAccountedBytes).toBeLessThanOrEqual(3500);
        expect(h.cache.recheck(old)).toBe(false);
    });

    it("invalidates an old entry if its valid replacement exceeds capacity", () => {
        const h = harness({ maxPositiveAccountedBytes: 3500 });
        h.cache.replace(origin, h.response());
        const old = h.selection();
        expect(h.cache.replace(origin, h.response([ed.key, replacement, ed.key]))).toBe(false);
        expect(h.cache.recheck(old)).toBe(false);
        expect(h.cache.stats.positiveEntries).toBe(0);
    });

    it("supports explicit zero positive capacity", () => {
        const h = harness({ maxPositiveEntries: 0 });
        expect(h.cache.replace(origin, h.response())).toBe(false);
        expect(h.cache.lookup(origin, ed.thumbprint).status).toBe("missing");
    });

    it("latches monotonic regression instead of rebasing freshness", () => {
        const h = harness();
        h.cache.replace(origin, h.response());
        const old = h.selection();
        h.advance(40000);
        expect(h.cache.recheck(old)).toBe(true);
        h.setNow(1000);
        expect(h.cache.recheck(old)).toBe(false);
        h.setNow(41000);
        expect(h.cache.recheck(old)).toBe(false);
        expect(h.cache.fetchBlocked(origin)).toBe(true);
    });

    it("exposes no verification-clock reset that could renew cache age", () => {
        const h = harness();
        h.cache.replace(origin, h.response());
        const old = h.selection();
        h.advance(40000);
        expect(h.cache.recheck(old)).toBe(true);
        h.advance(21000);
        expect(h.cache.recheck(old)).toBe(false);
        expect(h.cache).not.toHaveProperty("reset");
        expect(h.cache.stats.positiveEntries).toBe(1);
    });

    it.each([
        { negativeSeconds: 301 }, { maximumLifetimeSeconds: 301 },
        { fallbackSeconds: 301 }, { maxPositiveEntries: 1001 },
        { maxPositiveAccountedBytes: 16777217 }, { maxNegativeEntries: 1001 },
        { negativeSeconds: -1 },
    ])("rejects a configuration beyond the approved bounds %#", (options) => {
        expect(() => harness(options))
            .toThrow(expect.objectContaining({ code: "invalid-resource-limits" }));
    });
});

describe("malformed cache metadata replacement boundary", () => {
    for (const directive of [
        'no-store, extension="unterminated',
        'extension="unterminated, no-store',
        'private, max-age=60, invalid==value',
    ]) {
        it(`invalidates old evidence without storing a valid new set: ${directive}`, () => {
            const h = harness();
            h.cache.replace(origin, h.response());
            const old = h.selection();
            expect(h.cache.replace(origin, h.response(
                [replacement], [["cache-control", directive]],
            ))).toBe(false);
            expect(h.cache.recheck(old)).toBe(false);
            expect(h.cache.lookup(origin, replacementThumbprint).status).toBe("missing");
            expect(h.cache.stats).toMatchObject({
                positiveEntries: 0, positiveAccountedBytes: 0,
            });
        });
    }

    it("does not treat a malformed document as removal evidence even with no-store", () => {
        const h = harness();
        h.cache.replace(origin, h.response());
        const old = h.selection();
        expect(() => h.cache.replace(origin, h.response(
            [{}], [["cache-control", "no-store"]],
        ))).toThrow(DirectoryDocumentError);
        expect(h.cache.recheck(old)).toBe(true);
        expect(h.cache.stats.positiveEntries).toBe(1);
    });
});