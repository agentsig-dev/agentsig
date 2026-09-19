import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
    isDirectoryDestinationAllowed,
    matchesPinnedDirectoryAddress,
} from "../src/discovery/address-policy.js";

const fixture = JSON.parse(readFileSync(new URL(
    "../../../tests/fixtures/m3-address/address-cases.json", import.meta.url,
), "utf8")) as { cases: { address: string; allowed: boolean }[] };

describe("directory destination policy against independently committed expectations", () => {
    for (const entry of fixture.cases) {
        it(JSON.stringify(entry.address), () => {
            expect(isDirectoryDestinationAllowed(entry.address)).toBe(entry.allowed);
        });
    }

    it.each([
        undefined, null, true, 1, {}, [], new String("1.1.1.1"),
        "1".repeat(100000), "1.1.1.1\n", "\t1.1.1.1", "1.1.1.1\0",
    ])("rejects invalid runtime input without coercion %#", (value) => {
        expect(isDirectoryDestinationAllowed(value)).toBe(false);
    });

    it("does not invoke an input object's string conversion", () => {
        const value = {
            toString() { throw new Error("Must not coerce untrusted input"); },
        };
        expect(isDirectoryDestinationAllowed(value)).toBe(false);
        expect(matchesPinnedDirectoryAddress(value, "1.1.1.1")).toBe(false);
        expect(matchesPinnedDirectoryAddress("1.1.1.1", value)).toBe(false);
    });
});

describe("numeric socket peer comparison against an already admitted destination", () => {
    it.each([
        ["1.1.1.1", "1.1.1.1"],
        ["8.8.8.8", "::ffff:8.8.8.8"],
        ["8.8.8.8", "::ffff:808:808"],
        ["8.8.8.8", "0:0:0:0:0:ffff:808:808"],
        ["2606:4700:4700::1111", "2606:4700:4700:0:0:0:0:1111"],
        ["2606:4700:4700::abcd", "2606:4700:4700::ABCD"],
        ["2606:4700:4700::808:808", "2606:4700:4700::8.8.8.8"],
    ])("matches %s to %s", (pinned, peer) => {
        expect(matchesPinnedDirectoryAddress(pinned, peer)).toBe(true);
    });

    it.each([
        ["1.1.1.1", "127.0.0.1"],
        ["1.1.1.1", "1.1.1.2"],
        ["1.1.1.1", "::ffff:127.0.0.1"],
        ["1.1.1.1", "::ffff:101:102"],
        ["8.8.8.8", "::8.8.8.8"],
        ["8.8.8.8", "64:ff9b::808:808"],
        ["8.8.8.8", "2002:808:808::"],
        ["::ffff:8.8.8.8", "8.8.8.8"],
        ["::ffff:8.8.8.8", "::ffff:8.8.8.8"],
        ["127.0.0.1", "127.0.0.1"],
        ["127.0.0.1", "::ffff:127.0.0.1"],
        ["2001:db8::1", "2001:db8::1"],
        ["2606:4700:4700::1111", "2606:4700:4700::1112"],
        ["2606:4700:4700::1111", "2606:4700:4700::1111%eth0"],
        ["1.1.1.1", "[::ffff:1.1.1.1]"],
        ["1.1.1.1", "1.1.1.1:443"],
        ["1.1.1.1", ""],
    ])("rejects %s versus %s", (pinned, peer) => {
        expect(matchesPinnedDirectoryAddress(pinned, peer)).toBe(false);
    });

    it("does not widen DNS admission through socket representation equivalence", () => {
        expect(matchesPinnedDirectoryAddress("8.8.8.8", "::ffff:8.8.8.8")).toBe(true);
        expect(isDirectoryDestinationAllowed("::ffff:8.8.8.8")).toBe(false);
    });
});