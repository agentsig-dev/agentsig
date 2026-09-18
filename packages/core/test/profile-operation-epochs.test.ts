import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createOperationEpochs } from "../src/profiles/operation-epochs.js";
import type { OperationLease } from "../src/profiles/operation-epochs.js";

const fixtures = JSON.parse(readFileSync(new URL(
    "../../../tests/fixtures/reset/cases.json", import.meta.url,
), "utf8")) as {
    cases: {
        id: string;
        initial: { epoch: number; inFlight: number };
    }[];
};

function atFixtureEpoch(id: string) {
    const fixture = fixtures.cases.find((entry) => entry.id === id)!;
    const epochs = createOperationEpochs();
    while (epochs.lastEpoch < fixture.initial.epoch) {
        epochs.invalidate();
        epochs.activateNext();
    }
    const leases = Array.from({ length: fixture.initial.inFlight }, () => epochs.begin());
    return { epochs, leases, fixture };
}

const unavailable = () => expect.objectContaining({
    rejection: { status: "unverified", reason: "clock-unavailable" },
});

describe("operation epochs — isolation before replay integration", () => {
    it("issues owned frozen leases and counts only unfinished current operations", () => {
        const epochs = createOperationEpochs();
        const first = epochs.begin();
        const second = epochs.begin();
        expect(first).not.toBe(second);
        expect(first.epoch).toBe(epochs.activeEpoch);
        expect(Object.isFrozen(first)).toBe(true);
        expect(Object.isFrozen(epochs)).toBe(true);
        expect(epochs.inFlight).toBe(2);
        expect(() => epochs.assertCurrent(first)).not.toThrow();
        epochs.finish(first);
        epochs.finish(first);
        expect(epochs.inFlight).toBe(1);
        expect(() => epochs.assertCurrent(first)).toThrow(unavailable());
        epochs.assertCurrent(second);
        epochs.finish(second);
        expect(epochs.inFlight).toBe(0);
    });

    it("invalidates all old leases before activating a new epoch", () => {
        const { epochs, leases, fixture } = atFixtureEpoch("healthy-memory-reset");
        expect(epochs.invalidate()).toBe(fixture.initial.inFlight);
        expect(epochs.activeEpoch).toBeNull();
        expect(epochs.lastEpoch).toBe(fixture.initial.epoch);
        expect(epochs.inFlight).toBe(0);
        expect(() => epochs.begin()).toThrow(unavailable());
        for (const lease of leases) {
            expect(() => epochs.assertCurrent(lease)).toThrow(unavailable());
        }
        expect(epochs.activateNext()).toBe(fixture.initial.epoch + 1);
        for (const lease of leases) {
            expect(() => epochs.assertCurrent(lease)).toThrow(unavailable());
        }
        expect(() => epochs.assertCurrent(epochs.begin())).not.toThrow();
    });

    it("keeps a failed-reset epoch closed but allows a later fresh activation", () => {
        const { epochs, leases, fixture } = atFixtureEpoch("failed-clear-then-successful-retry");
        epochs.invalidate();
        // Model only the epoch helper's boundary: no cleanup implementation
        // is exercised or claimed here. The context must handle cleanup failure.
        expect(epochs.activeEpoch).toBeNull();
        expect(epochs.invalidate()).toBe(0);
        expect(() => epochs.begin()).toThrow(unavailable());
        expect(epochs.canActivateNext).toBe(true);
        const freshEpoch = epochs.activateNext();
        expect(freshEpoch).toBeGreaterThan(fixture.initial.epoch);
        for (const lease of leases) {
            expect(() => epochs.assertCurrent(lease)).toThrow(unavailable());
        }
    });

    it("ignores late old-epoch completion when counting new operations", () => {
        const epochs = createOperationEpochs();
        const stale = epochs.begin();
        epochs.invalidate();
        epochs.activateNext();
        const current = epochs.begin();
        epochs.finish(stale);
        epochs.finish(stale);
        expect(epochs.inFlight).toBe(1);
        epochs.assertCurrent(current);
        epochs.finish(current);
        expect(epochs.inFlight).toBe(0);
    });

    it("rejects a foreign lease even when its numeric epoch matches", () => {
        const first = createOperationEpochs();
        const second = createOperationEpochs();
        const local = first.begin();
        const foreign = second.begin();
        expect(local.epoch).toBe(foreign.epoch);
        expect(() => first.assertCurrent(foreign)).toThrow(unavailable());
        first.finish(foreign);
        expect(first.inFlight).toBe(1);
        expect(second.inFlight).toBe(1);
    });

    it("rejects copied or forged handles without reading their epoch property", () => {
        const epochs = createOperationEpochs();
        const real = epochs.begin();
        let reads = 0;
        const accessor = Object.defineProperty({}, "epoch", {
            get() { reads++; throw new Error("Must not execute"); },
        });
        for (const forged of [{ ...real }, accessor, null, undefined, 1]) {
            expect(() => epochs.assertCurrent(forged as OperationLease)).toThrow(unavailable());
            expect(() => epochs.finish(forged as OperationLease)).not.toThrow();
        }
        expect(reads).toBe(0);
        expect(epochs.inFlight).toBe(1);
        epochs.assertCurrent(real);
    });

    it("refuses activation while open without changing state", () => {
        const epochs = createOperationEpochs();
        const lease = epochs.begin();
        expect(() => epochs.activateNext()).toThrow("Cannot activate an open operation epoch");
        expect(epochs.activeEpoch).toBe(lease.epoch);
        expect(epochs.inFlight).toBe(1);
        epochs.assertCurrent(lease);
    });

    it("uses strictly increasing epochs across repeated resets", () => {
        const epochs = createOperationEpochs();
        const leases: OperationLease[] = [];
        for (let index = 0; index < 100; index++) {
            leases.push(epochs.begin());
            const previous = epochs.activeEpoch!;
            expect(epochs.invalidate()).toBe(1);
            expect(epochs.activateNext()).toBe(previous + 1);
        }
        for (const lease of leases) {
            expect(() => epochs.assertCurrent(lease)).toThrow(unavailable());
            epochs.finish(lease);
        }
        expect(epochs.inFlight).toBe(0);
    });
});