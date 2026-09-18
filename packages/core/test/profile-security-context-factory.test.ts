import { describe, expect, it } from "vitest";
import {
    createSecurityContext,
    securityContextInternals,
} from "../src/profiles/security-context.js";
import type { SecurityContext, SecurityContextOptions } from "../src/profiles/security-context.js";
import type { ReplayStore } from "../src/profiles/replay-store.js";

const clocks = {
    wallClock: () => 1_000_000,
    monotonicClock: () => 0,
};
const input = {
    scope: "merchant",
    keyThumbprint: "DR68nui99ukl-GUgfzQGaU3VwqRtArw-_DCN4LFtY84",
    nonce: "factory-test",
    retainUntilEpochSeconds: 1330,
};

describe("shared security context factory", () => {
    it("owns real memory while exposing only operator methods and read-only counts", async () => {
        const context = createSecurityContext(clocks);
        expect(Object.isFrozen(context)).toBe(true);
        expect(Object.keys(context).sort()).toEqual([
            "activeEpoch", "inFlight", "memoryQuotaCounters", "memoryRecords",
            "observerErrorCount", "resetClockReference", "resetInProgress",
        ]);
        expect(context).not.toHaveProperty("store");
        expect(context).not.toHaveProperty("resetPort");
        expect(context).not.toHaveProperty("consume");
        expect(context.memoryRecords).toBe(0);
        expect(context.memoryQuotaCounters).toBe(0);
        expect(Reflect.set(context, "memoryRecords", 999)).toBe(false);

        const { controller } = securityContextInternals(context);
        const lease = controller.beginOperation();
        expect(await controller.consume(lease, input)).toBe("accepted");
        expect(context.memoryRecords).toBe(1);
        expect(context.memoryQuotaCounters).toBe(1);
        const event = await context.resetClockReference();
        expect(event).toMatchObject({
            outcome: "success", clearedRecords: 1, clearedQuotaCounters: 1,
            invalidatedOperations: 1,
        });
        expect(context.memoryRecords).toBe(0);
        expect(context.memoryQuotaCounters).toBe(0);
        expect(() => controller.now(lease)).toThrow(expect.objectContaining({
            rejection: { status: "unverified", reason: "clock-unavailable" },
        }));
        controller.finishOperation(lease);
    });

    it("shares one controller across consumers of the same context, not separate contexts", async () => {
        const context = createSecurityContext(clocks);
        const first = securityContextInternals(context).controller;
        const second = securityContextInternals(context).controller;
        expect(first).toBe(second);
        const a = first.beginOperation();
        const b = second.beginOperation();
        expect(await first.consume(a, input)).toBe("accepted");
        expect(await second.consume(b, input)).toBe("replayed");
        first.finishOperation(a);
        second.finishOperation(b);
        expect(context.inFlight).toBe(0);

        const separate = securityContextInternals(createSecurityContext(clocks)).controller;
        const other = separate.beginOperation();
        expect(await separate.consume(other, input)).toBe("accepted");
        separate.finishOperation(other);
    });

    it.each([undefined, "process-clock", "independent"] as const)(
        "does not grant clearing authority to an external store: %s", async (retentionClock) => {
            let calls = 0;
            let clears = 0;
            const store = {
                ...(retentionClock === undefined ? {} : { retentionClock }),
                async consume() { calls++; return "accepted" as const; },
                clearForClockReset() { clears++; },
            };
            const context = createSecurityContext({ ...clocks, store });
            expect(context.memoryRecords).toBeNull();
            expect(context.memoryQuotaCounters).toBeNull();
            const controller = securityContextInternals(context).controller;
            const lease = controller.beginOperation();
            expect(await controller.consume(lease, input)).toBe("accepted");
            if (retentionClock === "independent") {
                await expect(context.resetClockReference()).resolves.toMatchObject({
                    outcome: "success", clearedRecords: 0, clearedQuotaCounters: 0,
                });
            } else {
                await expect(context.resetClockReference()).rejects.toMatchObject({
                    code: "reset-unsupported-store",
                });
                expect(context.activeEpoch).toBe(lease.epoch);
            }
            expect(calls).toBe(1);
            expect(clears).toBe(0);
            controller.finishOperation(lease);
        },
    );

    it("snapshots memory policy and clock callbacks at construction", async () => {
        const replayPolicy = { capacity: 1, maxPerKey: 1 };
        const options = { ...clocks, replayPolicy };
        const context = createSecurityContext(options);
        replayPolicy.maxPerKey = 999;
        replayPolicy.capacity = 999;
        options.wallClock = () => NaN;
        const controller = securityContextInternals(context).controller;
        const lease = controller.beginOperation();
        expect(await controller.consume(lease, input)).toBe("accepted");
        expect(await controller.consume(lease, { ...input, nonce: "second" }))
            .toBe("per-key-quota-exceeded");
        controller.finishOperation(lease);
    });

    it("rejects copied, forged or foreign operator surfaces as verifier contexts", () => {
        const context = createSecurityContext(clocks);
        for (const value of [{ ...context }, {}, null, undefined]) {
            expect(() => securityContextInternals(value as SecurityContext))
                .toThrow(expect.objectContaining({ code: "invalid-replay-policy" }));
        }
    });

    it("rejects contradictory custom-store quota settings instead of ignoring them", () => {
        const store: ReplayStore = { async consume() { return "accepted"; } };
        expect(() => createSecurityContext({
            ...clocks, store, replayPolicy: { capacity: 1 },
        })).toThrow(expect.objectContaining({ code: "invalid-replay-policy" }));
    });

    it("does not execute top-level option accessors", () => {
        let reads = 0;
        for (const name of ["store", "observer", "wallClock", "limits"]) {
            const options = Object.defineProperty({}, name, {
                get() { reads++; throw new Error("Do not execute"); },
            });
            expect(() => createSecurityContext(options)).toThrow();
        }
        expect(reads).toBe(0);
    });

    it("validates configuration without accepting null providers as defaults", () => {
        for (const name of ["wallClock", "monotonicClock", "observer"]) {
            expect(() => createSecurityContext({
                ...clocks, [name]: null,
            } as unknown as SecurityContextOptions)).toThrow(
                expect.objectContaining({ code: "invalid-clock-configuration" }),
            );
        }
        expect(() => createSecurityContext({ ...clocks, unknown: true } as SecurityContextOptions))
            .toThrow(expect.objectContaining({ code: "invalid-replay-policy" }));
        expect(() => createSecurityContext({ ...clocks, limits: { maxScopeBytes: -1 } }))
            .toThrow(expect.objectContaining({ code: "invalid-resource-limits" }));
    });
});