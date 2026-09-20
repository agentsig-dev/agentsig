import { describe, expect, it } from "vitest";
import { resolveHttpConfiguration } from "../src/http/configuration.js";
import { forwardedNode, parseForwarded, xForwardedClient } from "../src/http/forwarding.js";
import { HttpMappingError } from "../src/http/errors.js";
import { mapHttpSnapshot } from "../src/http/mapping.js";
import type { HttpMapperOptions } from "../src/http/types.js";

const ingress = {
    mode: "trusted-ingress" as const, family: "forwarded" as const,
    allowedOrigins: ["https://merchant.example"],
    trustedPeers: ["192.0.2.0/24"], sanitizingIngress: true as const,
};
const raw = {
    method: "GET", url: "/", httpVersion: "1.1",
    rawHeaders: ["Host", "internal.example", "Forwarded", "host=merchant.example;proto=https"],
    peerAddress: "192.0.2.1", encrypted: false,
};

describe("HTTP forwarding and configuration boundaries", () => {
    it.each([
        "host=merchant.example;proto=https;for=\"unterminated",
        "host=merchant.example;proto=https;for=\"bad\\",
        "host=merchant.example;proto=https;for=\"bad\nvalue\"",
        "host=merchant.example;proto=https;for=\"bad\\\nvalue\"",
        "host=merchant.example;proto=https;FOR=unknown;for=unknown",
        "host=merchant.example;proto=https;;for=unknown",
        "host=merchant.example;proto=https;",
        "host =merchant.example;proto=https",
        "host=merchant.example;proto=",
        "host=merchant.example;proto=https;extension=test",
    ])("rejects malformed Forwarded without repair %#", value => {
        expect(() => parseForwarded(value)).toThrow(HttpMappingError);
    });

    it("unescapes quoted-string values without changing the original header", () => {
        const value = 'host="merchant\\.example";proto="https";for="unknown"';
        const mapped = mapHttpSnapshot({
            ...raw, rawHeaders: ["Host", "internal.example", "Forwarded", value],
        }, resolveHttpConfiguration({ ingress }));
        expect(mapped).toMatchObject({
            status: "mapped",
            request: {
                targetUri: "https://merchant.example/",
                headers: [["Host", "internal.example"], ["Forwarded", value]],
            },
            observedClient: { kind: "unknown", address: "unknown", authenticated: false },
        });
    });

    it.each([
        "host=merchant.example;proto=https,",
        ",host=merchant.example;proto=https",
        "host=merchant.example;proto=https,for=unknown",
    ])("rejects list syntax even when another element is empty %#", value => {
        expect(mapHttpSnapshot({
            ...raw, rawHeaders: ["Host", "internal.example", "Forwarded", value],
        }, resolveHttpConfiguration({ ingress }))).toEqual({
            status: "mapping-rejected", code: "forwarding-chain-rejected",
        });
    });

    it.each([
        ["unknown", "unknown", "unknown", undefined],
        ["UNKNOWN:1234", "unknown", "UNKNOWN", "1234"],
        ["_hidden:_port", "obfuscated", "_hidden", "_port"],
        ["[2001:DB8::1]:4711", "ip", "2001:DB8::1", "4711"],
        ["192.0.2.1:65535", "ip", "192.0.2.1", "65535"],
    ])("represents RFC node hints without treating them as authenticated: %s",
        (value, kind, address, port) => {
            expect(forwardedNode(value!)).toEqual({
                kind, address, ...(port === undefined ? {} : { port }),
                source: "trusted-ingress", authenticated: false,
            });
        });

    it.each([
        "_", "hostname", "[::1", "[not-ip]", "127.1", "192.0.2.1:",
        "192.0.2.1:123456", "unknown:abc", "_foo:port", "2001:db8::1", "forged,unknown",
    ])("rejects invalid RFC node hints: %s", value => {
        expect(() => forwardedNode(value)).toThrow(HttpMappingError);
    });

    it.each([
        "127.1", "0x7f000001", "127.0.0.01", "[::1]", "::1%lo",
        "2001:DB8::1", "2001:db8:0:0:0:0:0:1", "192.0.2.1:80", "unknown",
    ])("rejects noncanonical or non-IP X-Forwarded-For: %s", value => {
        expect(() => xForwardedClient(value)).toThrow(HttpMappingError);
    });

    it.each([
        ["192.0.2.0", true], ["192.0.2.255", true],
        ["192.0.1.255", false], ["192.0.3.0", false],
        ["::ffff:192.0.2.1", false], ["::1", false], [undefined, false],
    ])("checks exact IPv4 peer subnet without implicit mapped expansion: %s", (peer, allowed) => {
        const config = resolveHttpConfiguration({ ingress });
        expect(config.trustsPeer(peer)).toBe(allowed);
    });

    it.each([
        ["2001:db8:1::", true], ["2001:DB8:1:ffff::1", true],
        ["2001:db8:2::1", false], ["192.0.2.1", false],
        ["::ffff:192.0.2.1", false],
    ])("checks native IPv6 peer subnet: %s", (peer, allowed) => {
        const config = resolveHttpConfiguration({
            ingress: { ...ingress, trustedPeers: ["2001:db8:1::/48"] },
        });
        expect(config.trustsPeer(peer)).toBe(allowed);
    });

    it.each([
        ["maxHeaderBytes", -1], ["maxHeaderBytes", 1.5],
        ["maxHeaderBytes", NaN], ["maxHeaderBytes", Infinity],
        ["maxHeaderBytes", 1_048_577], ["maxTargetUriBytes", 0],
        ["maxTargetUriBytes", Number.MAX_SAFE_INTEGER],
    ])("rejects invalid resource configuration: %s %s", (name, value) => {
        expect(() => resolveHttpConfiguration({
            ingress, limits: { [name]: value },
        } as HttpMapperOptions)).toThrow("Invalid HTTP integration configuration");
    });

    it("owns the peer rules and origin list after setup", () => {
        const trustedPeers = ["192.0.2.0/24"];
        const allowedOrigins = ["https://merchant.example"];
        const config = resolveHttpConfiguration({ ingress: { ...ingress, trustedPeers, allowedOrigins } });
        trustedPeers[0] = "198.51.100.0/24";
        allowedOrigins[0] = "https://attacker.example";
        expect(config.trustsPeer("192.0.2.1")).toBe(true);
        expect(config.trustsPeer("198.51.100.1")).toBe(false);
        expect(config.allowsOrigin("https://merchant.example:443")).toBe(true);
        expect(config.allowsOrigin("https://attacker.example:443")).toBe(false);
    });

    it("charges header and assembled URI limits at exact boundaries", () => {
        const input = { ...raw, encrypted: true, rawHeaders: ["Host", "merchant.example"] };
        const configuration = (maxHeaderBytes: number, maxTargetUriBytes: number) =>
            resolveHttpConfiguration({
                ingress: { allowedOrigins: ["https://merchant.example"] },
                limits: { maxHeaderBytes, maxTargetUriBytes },
            });
        const headerBytes = "Host".length + "merchant.example".length + 4;
        const uriBytes = "https://merchant.example/".length;
        expect(mapHttpSnapshot(input, configuration(headerBytes, uriBytes)).status).toBe("mapped");
        expect(mapHttpSnapshot(input, configuration(headerBytes - 1, uriBytes))).toEqual({
            status: "mapping-rejected", code: "resource-limit",
        });
        expect(mapHttpSnapshot(input, configuration(headerBytes, uriBytes - 1))).toEqual({
            status: "mapping-rejected", code: "resource-limit",
        });
    });
});