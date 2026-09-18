import { describe, expect, it } from "vitest";
import { CandidateRejection } from "../src/profiles/codes.js";
import { createSecurityContextController } from "../src/profiles/security-context-controller.js";
import { createSignatureTimePolicy } from "../src/profiles/time-policy.js";
import type { ReplayConsumeInput } from "../src/profiles/replay-store.js";

const start = 1800000000;
const identity = {
    scope: "merchant",
    keyThumbprint: "DR68nui99ukl-GUgfzQGaU3VwqRtArw-_DCN4LFtY84",
    nonce: "dispatch-time-nonce",
};

function harness() {
    let elapsed = 0;
    const calls: Readonly<ReplayConsumeInput>[] = [];
    const controller = createSecurityContextController({
        store: {
            retentionClock: "independent",
            async consume(input) {
                calls.push(input);
                return "accepted";
            },
        },
        wallClock: () => start * 1000 + elapsed,
        monotonicClock: () => elapsed,
    });
    return {
        controller, calls,
        advance(milliseconds: number) { elapsed += milliseconds; },
    };
}

describe("internal replay preparation at the exact dispatch clock sample", () => {
    it("computes the approved retention formula from dispatch time, not an earlier sample", async () => {
        const h = harness();
        const lease = h.controller.beginOperation();
        const time = createSignatureTimePolicy();
        expect(h.controller.now(lease)).toBe(start);
        h.advance(89000);
        await expect(h.controller.consume(lease, (now) => {
            time.check(start, start + 60, now);
            return {
                ...identity,
                retainUntilEpochSeconds: time.retainUntil(start, now),
            };
        })).resolves.toBe("accepted");
        expect(h.calls).toEqual([{
            ...identity,
            nowEpochSeconds: start + 89,
            retainUntilEpochSeconds: start + 419,
        }]);
        expect(Object.isFrozen(h.calls[0])).toBe(true);
        expect(h.calls[0]).not.toHaveProperty("epoch");
        h.controller.finishOperation(lease);
    });

    it("never dispatches if the signature expired before the dispatch sample", async () => {
        const h = harness();
        const lease = h.controller.beginOperation();
        const time = createSignatureTimePolicy();
        h.advance(90000);
        await expect(h.controller.consume(lease, (now) => {
            time.check(start, start + 60, now);
            return { ...identity, retainUntilEpochSeconds: time.retainUntil(start, now) };
        })).rejects.toMatchObject({
            rejection: { status: "invalid", reason: "signature-expired" },
        });
        expect(h.calls).toHaveLength(0);
        h.controller.finishOperation(lease);
    });

    it("does not run preparation for an invalidated operation", async () => {
        const h = harness();
        const lease = h.controller.beginOperation();
        await h.controller.resetClockReference();
        let prepared = false;
        await expect(h.controller.consume(lease, () => {
            prepared = true;
            return { ...identity, retainUntilEpochSeconds: start + 330 };
        })).rejects.toMatchObject({ rejection: { reason: "clock-unavailable" } });
        expect(prepared).toBe(false);
        expect(h.calls).toHaveLength(0);
        h.controller.finishOperation(lease);
    });

    it("blocks synchronous reentry and preserves preparation errors rather than calling them backend failures", async () => {
        const h = harness();
        const lease = h.controller.beginOperation();
        const failure = new CandidateRejection({ status: "unverified", reason: "resource-limit" });
        await expect(h.controller.consume(lease, () => {
            expect(() => h.controller.completeOperation(lease)).toThrow(
                expect.objectContaining({
                    rejection: { status: "unverified", reason: "clock-unavailable" },
                }),
            );
            throw failure;
        })).rejects.toBe(failure);
        expect(h.calls).toHaveLength(0);
        expect(h.controller.inFlight).toBe(1);
        h.controller.finishOperation(lease);
    });
});