import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createObserverDelivery } from "../src/profiles/context-observer.js";

interface Event {
    readonly outcome: string;
}
const event: Readonly<Event> = Object.freeze({ outcome: "success" });
const fixtures = JSON.parse(readFileSync(new URL(
    "../../../tests/fixtures/reset/observer-cases.json", import.meta.url,
), "utf8")) as {
    cases: {
        id: string;
        observerAction: { kind: string; thrownKind?: string };
        expected: { observerCalls?: number; observerErrorCount?: number };
    }[];
};

describe("observer delivery — committed throw expectations", () => {
    for (const fixture of fixtures.cases.filter((entry) =>
        entry.observerAction.kind === "throw")) {
        it(fixture.id, () => {
            let inspected = 0;
            const opaque = Object.defineProperty({}, "message", {
                get() { inspected++; throw new Error("Must not inspect"); },
            });
            const thrown: Record<string, unknown> = {
                error: new Error("PRIVATE-OBSERVER-MARKER"),
                string: "PRIVATE-OBSERVER-MARKER",
                null: null,
                undefined,
                object: opaque,
            };
            let calls = 0;
            const delivery = createObserverDelivery<Event>(() => {
                calls++;
                expect(delivery.delivering).toBe(true);
                throw thrown[fixture.observerAction.thrownKind!];
            });
            expect(() => delivery.emit(event)).not.toThrow();
            expect(calls).toBe(fixture.expected.observerCalls);
            expect(delivery.observerErrorCount).toBe(fixture.expected.observerErrorCount);
            expect(delivery.delivering).toBe(false);
            expect(inspected).toBe(0);
            expect(JSON.stringify(delivery)).not.toContain("PRIVATE-OBSERVER-MARKER");
            // This is delivery recovery only, not a simulated verifier result.
            expect(() => delivery.emit(event)).not.toThrow();
            expect(delivery.observerErrorCount).toBe(2);
            expect(delivery.delivering).toBe(false);
        });
    }
});

describe("synchronous observer boundary", () => {
    it("delivers exactly once before returning and preserves the event reference", () => {
        const order: string[] = [];
        const delivery = createObserverDelivery<Event>((received) => {
            order.push("observer");
            expect(received).toBe(event);
        });
        order.push("before");
        delivery.emit(event);
        order.push("after");
        expect(order).toEqual(["before", "observer", "after"]);
        expect(delivery.observerErrorCount).toBe(0);
    });

    it("does not recursively deliver nested events", () => {
        let calls = 0;
        const delivery = createObserverDelivery<Event>(() => {
            calls++;
            expect(delivery.delivering).toBe(true);
            delivery.emit(event);
        });
        delivery.emit(event);
        expect(calls).toBe(1);
        expect(delivery.observerErrorCount).toBe(0);
        expect(delivery.delivering).toBe(false);
    });

    it("clears the stack-local guard before deferred work even after a throw", async () => {
        let release!: () => void;
        const completed = new Promise<void>((resolve) => { release = resolve; });
        let deferredGuard: boolean | undefined;
        const delivery = createObserverDelivery<Event>(() => {
            queueMicrotask(() => {
                deferredGuard = delivery.delivering;
                release();
            });
            throw null;
        });
        delivery.emit(event);
        expect(delivery.delivering).toBe(false);
        expect(delivery.observerErrorCount).toBe(1);
        await completed;
        expect(deferredGuard).toBe(false);
    });

    it("does not inspect a callback return value or invoke a then getter", () => {
        let reads = 0;
        const returned = Object.defineProperty({}, "then", {
            get() { reads++; throw new Error("Must not inspect return values"); },
        });
        const delivery = createObserverDelivery<Event>(() => returned);
        delivery.emit(event);
        expect(reads).toBe(0);
        expect(delivery.delivering).toBe(false);
        expect(delivery.observerErrorCount).toBe(0);
    });

    it("exposes read-only state with no observer replacement interface", () => {
        const delivery = createObserverDelivery<Event>(() => { throw "failure"; });
        delivery.emit(event);
        expect(Object.isFrozen(delivery)).toBe(true);
        expect(Object.getOwnPropertyDescriptor(delivery, "observerErrorCount")?.set)
            .toBeUndefined();
        expect(Reflect.set(delivery, "observerErrorCount", 0)).toBe(false);
        expect(delivery.observerErrorCount).toBe(1);
        expect(Object.keys(delivery).sort())
            .toEqual(["delivering", "emit", "observerErrorCount"]);
    });

    it("supports no observer without creating a failure or active guard", () => {
        const delivery = createObserverDelivery<Event>();
        delivery.emit(event);
        expect(delivery.delivering).toBe(false);
        expect(delivery.observerErrorCount).toBe(0);
    });

    it.each([null, 42, "hook", {}])("rejects invalid observer configuration %#", (value) => {
        expect(() => createObserverDelivery(value as never))
            .toThrow(expect.objectContaining({ code: "invalid-clock-configuration" }));
    });
});