import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { prepareRedisConsume } from "../src/redis/consume-input.js";
import type { ReplayConsumeInput } from "../src/profiles/replay-store.js";

const fixture = JSON.parse(readFileSync(new URL(
    "../../../tests/fixtures/m3-contract/redis-cases.json", import.meta.url,
), "utf8")) as {
    retentionCases: {
        id: string;
        nowEpochSeconds: number;
        retainUntilEpochSeconds: number;
        expectedDurationMilliseconds?: number;
        expectedOutcome?: string;
    }[];
};
const thumbprint = "DR68nui99ukl-GUgfzQGaU3VwqRtArw-_DCN4LFtY84";
const other = "poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U";
const base: ReplayConsumeInput = {
    scope: "merchant", keyThumbprint: thumbprint, nonce: "request-1",
    nowEpochSeconds: 1800000000, retainUntilEpochSeconds: 1800000330,
};

describe("Redis duration preparation against pinned expectations", () => {
    for (const row of fixture.retentionCases) {
        it(row.id, () => {
            const record = prepareRedisConsume({
                ...base,
                nowEpochSeconds: row.nowEpochSeconds,
                retainUntilEpochSeconds: row.retainUntilEpochSeconds,
            });
            if (row.expectedOutcome) {
                expect(row.expectedOutcome).toBe("unavailable");
                expect(record).toBeUndefined();
            } else {
                expect(record?.durationMilliseconds).toBe(row.expectedDurationMilliseconds);
            }
        });
    }

    it("uses a duration, not an absolute timestamp from another clock domain", () => {
        const first = prepareRedisConsume(base)!;
        const shifted = prepareRedisConsume({
            ...base, nowEpochSeconds: 42, retainUntilEpochSeconds: 372,
        })!;
        expect(first.durationMilliseconds).toBe(330000);
        expect(shifted).toEqual(first);
        expect(Object.isFrozen(first)).toBe(true);
    });

    it.each([NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
        "rejects invalid timestamp %s", (value) => {
            expect(prepareRedisConsume({ ...base, nowEpochSeconds: value })).toBeUndefined();
            expect(prepareRedisConsume({ ...base, retainUntilEpochSeconds: value })).toBeUndefined();
        },
    );
});

describe("bounded injective replay tuple representation", () => {
    it("round-trips exact decoded values including delimiters and escapes", () => {
        const input = { ...base, scope: "a\u0000:b", nonce: ' "quoted"\\value: ' };
        const record = prepareRedisConsume(input)!;
        expect(record.identity).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(JSON.parse(Buffer.from(record.identity, "base64url").toString("utf8")))
            .toEqual([input.scope, input.keyThumbprint, input.nonce]);
        expect(record.thumbprint).toBe(thumbprint);
    });

    it("separates scope, key and nonce without ambiguous delimiters", () => {
        const inputs = [
            base,
            { ...base, scope: "another" },
            { ...base, keyThumbprint: other },
            { ...base, nonce: "another" },
            { ...base, scope: "a:b", nonce: "c" },
            { ...base, scope: "a", nonce: "b:c" },
        ];
        const identities = inputs.map((input) => prepareRedisConsume(input)!.identity);
        expect(new Set(identities).size).toBe(inputs.length);
    });

    it("does not partition by profile, label or local operation epoch", () => {
        const enriched = {
            ...base, profile: "other-profile", label: "other-label", epoch: 99,
        };
        expect(prepareRedisConsume(enriched)).toEqual(prepareRedisConsume(base));
    });

    it.each(["", "x".repeat(257), "non-ascii-\u00fc"])("rejects invalid scope %#", (scope) => {
        expect(prepareRedisConsume({ ...base, scope })).toBeUndefined();
    });

    it.each(["", "x".repeat(257), "\n", "\u007f", "\u00fc"])("rejects invalid nonce %#", (nonce) => {
        expect(prepareRedisConsume({ ...base, nonce })).toBeUndefined();
    });

    it.each([thumbprint + "=", thumbprint.slice(0, -1) + "5", "x", "x".repeat(44)])(
        "rejects noncanonical key identity %#", (keyThumbprint) => {
            expect(prepareRedisConsume({ ...base, keyThumbprint })).toBeUndefined();
        },
    );

    it("accepts the exact scope and nonce size boundaries", () => {
        expect(prepareRedisConsume({
            ...base, scope: "s".repeat(256), nonce: "n".repeat(256),
        })).toBeDefined();
    });

    it("rejects ordinary accessors without executing them", () => {
        let calls = 0;
        const input = Object.defineProperty({ ...base }, "nonce", {
            get() { calls++; return base.nonce; },
        });
        expect(prepareRedisConsume(input)).toBeUndefined();
        expect(calls).toBe(0);
    });

    it("contains malformed provider-object failures", () => {
        const input = new Proxy({ ...base }, {
            getOwnPropertyDescriptor() { throw new Error("PRIVATE-PROVIDER-MARKER"); },
        });
        expect(prepareRedisConsume(input)).toBeUndefined();
    });
});