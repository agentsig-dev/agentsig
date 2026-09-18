import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createSignatureTimePolicy } from "../src/profiles/time-policy.js";
import { createOwnedMemoryReplayStore } from "../src/profiles/memory-replay-store.js";
import type { TimePolicy } from "../src/profiles/defaults.js";

const fixture = JSON.parse(readFileSync(new URL(
    "../../../tests/fixtures/m2/policy-cases.json", import.meta.url,
), "utf8")) as {
    timeContract: {
        cases: {
            id: string;
            now: number;
            created: number;
            expires: number;
            retainUntil?: number;
            policyOverrides?: Partial<TimePolicy>;
        }[];
    };
};

describe("conservative replay retention", () => {
    for (const entry of fixture.timeContract.cases.filter((item) => item.retainUntil !== undefined)) {
        it(`matches independently pinned deadline: ${entry.id}`, () => {
            const policy = createSignatureTimePolicy(entry.policyOverrides);
            policy.check(entry.created, entry.expires, entry.now);
            expect(policy.retainUntil(entry.created, entry.now)).toBe(entry.retainUntil);
        });
    }

    it("retains future-created signatures past a fixed 330-second TTL", async () => {
        const policy = createSignatureTimePolicy();
        const now = 1800000000;
        policy.check(now + 30, now + 90, now);
        const deadline = policy.retainUntil(now + 30, now);
        expect(deadline).toBe(now + 360);
        const memory = createOwnedMemoryReplayStore();
        const input = {
            scope: "retention-test",
            keyThumbprint: "DR68nui99ukl-GUgfzQGaU3VwqRtArw-_DCN4LFtY84",
            nonce: "same-nonce",
            nowEpochSeconds: now,
            retainUntilEpochSeconds: deadline,
        };
        expect(await memory.store.consume(input)).toBe("accepted");
        expect(await memory.store.consume({
            ...input, nowEpochSeconds: now + 330,
        })).toBe("replayed");
        expect(await memory.store.consume({
            ...input, nowEpochSeconds: deadline, retainUntilEpochSeconds: deadline + 330,
        })).toBe("accepted");
        // Backend retention test only; no claim that the signature itself is
        // still eligible at these later times. The verifier checks time separately.
    });

    it("uses consumption time when it is later than creation", () => {
        const policy = createSignatureTimePolicy();
        expect(policy.retainUntil(1000, 1050)).toBe(1380);
        expect(policy.retainUntil(1000, 1051)).toBe(1381);
        expect(createSignatureTimePolicy({ clockSkewSeconds: 0 }).retainUntil(0, 0)).toBe(300);
    });

    it("accepts the maximum safe deadline but never clamps an overflowing deadline", () => {
        const policy = createSignatureTimePolicy();
        const maximum = Number.MAX_SAFE_INTEGER;
        expect(policy.retainUntil(0, maximum - 330)).toBe(maximum);
        expect(() => policy.retainUntil(0, maximum - 329)).toThrow(
            expect.objectContaining({
                rejection: { status: "unverified", reason: "resource-limit" },
            }),
        );
    });

    it("keeps invalid clock samples distinct from invalid signed creation times", () => {
        const policy = createSignatureTimePolicy();
        for (const value of [-1, NaN, Infinity, 0.5, "1000", null, undefined]) {
            expect(() => policy.retainUntil(0, value as number)).toThrow(
                expect.objectContaining({
                    rejection: { status: "unverified", reason: "clock-unavailable" },
                }),
            );
            expect(() => policy.retainUntil(value as number, 1000)).toThrow(
                expect.objectContaining({
                    rejection: { status: "invalid", reason: "invalid-time-range" },
                }),
            );
        }
    });
});