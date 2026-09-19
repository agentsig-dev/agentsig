import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
    assertDirectoryAddressPolicy, createDirectoryAddressPolicy,
    defaultDirectoryAddressPolicy,
} from "../src/discovery/address-policy.js";
import type {
    DirectoryAddressException, DirectoryAddressPolicy,
} from "../src/discovery/address-policy.js";
import {
    resolveDirectoryAddresses, validateDirectoryAddresses,
} from "../src/discovery/dns-resolution.js";

const fixture = JSON.parse(readFileSync(new URL(
    "../../../tests/fixtures/m3-transport/contract.json", import.meta.url,
), "utf8")) as {
    exceptions: {
        catalog: { id: DirectoryAddressException; prefix: string }[];
        cases: { address: string; enabled: DirectoryAddressException[]; allowed: boolean }[];
        invalidConfiguration: string[][];
    };
};

describe("explicit address exceptions from committed transport expectations", () => {
    for (const row of fixture.exceptions.cases) {
        it(`${row.address} with ${row.enabled.join(",") || "no exceptions"}`, () => {
            const policy = createDirectoryAddressPolicy(row.enabled);
            expect(policy.allows(row.address)).toBe(row.allowed);
        });
    }

    for (const entry of fixture.exceptions.catalog) {
        it(`opens only the named registry entry: ${entry.id}`, () => {
            const address = entry.prefix.split("/")[0]!;
            expect(defaultDirectoryAddressPolicy.allows(address)).toBe(false);
            const policy = createDirectoryAddressPolicy([entry.id]);
            expect(policy.allows(address)).toBe(true);
            expect(policy.matchesPeer(address, address)).toBe(true);
            expect(() => assertDirectoryAddressPolicy(policy)).not.toThrow();
        });
    }

    for (const input of fixture.exceptions.invalidConfiguration) {
        it(`rejects invalid configuration ${JSON.stringify(input)}`, () => {
            expect(() => createDirectoryAddressPolicy(input as DirectoryAddressException[]))
                .toThrow(expect.objectContaining({ code: "invalid-agent-binding" }));
        });
    }

    it("copies and freezes the configuration rather than retaining a mutable array", () => {
        const names: DirectoryAddressException[] = ["pcp-anycast-v4"];
        const policy = createDirectoryAddressPolicy(names);
        names[0] = "turn-anycast-v4";
        expect(policy.exceptions).toEqual(["pcp-anycast-v4"]);
        expect(policy.allows("192.0.0.9")).toBe(true);
        expect(policy.allows("192.0.0.10")).toBe(false);
        expect(Object.isFrozen(policy)).toBe(true);
        expect(Object.isFrozen(policy.exceptions)).toBe(true);
    });

    it("rejects accessor entries without invoking them", () => {
        const getter = vi.fn(() => "pcp-anycast-v4");
        const names: DirectoryAddressException[] = [];
        Object.defineProperty(names, "0", { get: getter });
        expect(() => createDirectoryAddressPolicy(names))
            .toThrow(expect.objectContaining({ code: "invalid-agent-binding" }));
        expect(getter).not.toHaveBeenCalled();
    });

    it("does not open private or transition destinations even with every exception enabled", () => {
        const policy = createDirectoryAddressPolicy(fixture.exceptions.catalog.map((entry) => entry.id));
        for (const address of [
            "10.0.0.1", "127.0.0.1", "169.254.169.254", "192.168.1.1",
            "::1", "fd00::1", "fe80::1", "2001:db8::1", "3fff::1",
            "::ffff:192.0.0.9", "64:ff9b::808:808", "2002:808:808::",
        ]) expect(policy.allows(address), address).toBe(false);
    });

    it("permits an OS-mapped peer only for equality with an admitted native IPv4 pin", () => {
        const policy = createDirectoryAddressPolicy(["pcp-anycast-v4"]);
        expect(policy.matchesPeer("192.0.0.9", "::ffff:192.0.0.9")).toBe(true);
        expect(policy.matchesPeer("192.0.0.9", "::ffff:127.0.0.1")).toBe(false);
        expect(policy.matchesPeer("::ffff:192.0.0.9", "::ffff:192.0.0.9")).toBe(false);
        expect(policy.allows("::ffff:192.0.0.9")).toBe(false);
    });
});

describe("DNS integration preserves exception ownership and mixed-answer rejection", () => {
    it("admits an explicitly selected entry through both DNS families", async () => {
        const policy = createDirectoryAddressPolicy(["pcp-anycast-v4", "pcp-anycast-v6"]);
        const resolver = {
            resolve4: vi.fn(async () => ["192.0.0.9"]),
            resolve6: vi.fn(async () => ["2001:1::1"]),
            cancel: vi.fn(),
        };
        expect(await resolveDirectoryAddresses("agent.example", 1000, 16, () => resolver, policy))
            .toEqual([
                { address: "192.0.0.9", family: 4 },
                { address: "2001:1::1", family: 6 },
            ]);
        expect(resolver.resolve4).toHaveBeenCalledExactlyOnceWith("agent.example.");
        expect(resolver.resolve6).toHaveBeenCalledExactlyOnceWith("agent.example.");
    });

    it("rejects a private answer accompanying an enabled exception", () => {
        const policy = createDirectoryAddressPolicy(["pcp-anycast-v4"]);
        expect(() => validateDirectoryAddresses(["192.0.0.9", "10.0.0.1"], [], 16, policy))
            .toThrow(expect.objectContaining({ reason: "address-denied" }));
    });

    it("rejects forged and copied policy objects before resolver creation", async () => {
        const forged: DirectoryAddressPolicy = {
            exceptions: [], allows: () => true, matchesPeer: () => true,
        };
        const factory = vi.fn(() => ({
            resolve4: async () => ["127.0.0.1"],
            resolve6: async () => [],
            cancel() { },
        }));
        for (const policy of [forged, { ...defaultDirectoryAddressPolicy }]) {
            expect(() => validateDirectoryAddresses(["127.0.0.1"], [], 16, policy))
                .toThrow(expect.objectContaining({ code: "invalid-agent-binding" }));
            await expect(resolveDirectoryAddresses("agent.example", 1000, 16, factory, policy))
                .rejects.toMatchObject({ code: "invalid-agent-binding" });
        }
        expect(factory).not.toHaveBeenCalled();
    });
});