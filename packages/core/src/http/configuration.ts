import { BlockList, isIP } from "node:net";
import { configuredHttpOriginKey } from "./authority.js";
import { invalidHttpConfiguration } from "./errors.js";
import type { HttpMapperOptions, HttpMappingLimits } from "./types.js";

export const DEFAULT_HTTP_MAPPING_LIMITS: Readonly<HttpMappingLimits> = Object.freeze({
    maxHeaderBytes: 16_384,
    maxTargetUriBytes: 16_384,
});

/** Trusted local objects are not a Proxy sandbox; ordinary accessors are rejected. */
export function configurationRecord(input: unknown, allowed: readonly string[]): Record<string, unknown> {
    if (!input || typeof input !== "object" || Array.isArray(input)) return invalidHttpConfiguration();
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(input)) {
        if (typeof key !== "string" || !allowed.includes(key)) return invalidHttpConfiguration();
        const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
        if (!Object.hasOwn(descriptor, "value")) return invalidHttpConfiguration();
        result[key] = descriptor.value as unknown;
    }
    return result;
}

function stringList(input: unknown): readonly string[] {
    if (!Array.isArray(input) || input.length === 0 || input.length > 1024) {
        return invalidHttpConfiguration();
    }
    const values: string[] = [];
    for (let index = 0; index < input.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
        const value: unknown = descriptor?.value;
        if (!descriptor || !Object.hasOwn(descriptor, "value") ||
            typeof value !== "string" || value.length === 0 || value.length > 2048) {
            return invalidHttpConfiguration();
        }
        values.push(value);
    }
    return Object.freeze(values);
}

export function httpLimits(input?: Partial<HttpMappingLimits>): Readonly<HttpMappingLimits> {
    const supplied = input === undefined ? {} : configurationRecord(input, [
        "maxHeaderBytes", "maxTargetUriBytes",
    ]);
    const result = { ...DEFAULT_HTTP_MAPPING_LIMITS, ...supplied };
    for (const value of Object.values(result)) {
        // Deliberately bounded local allocation; count << 1 cannot overflow.
        if (typeof value !== "number" || !Number.isSafeInteger(value) ||
            value < 1 || value > 1_048_576) return invalidHttpConfiguration();
    }
    return Object.freeze(result);
}

function trustedPeerCheck(values: readonly string[]): (peer: string | undefined) => boolean {
    // Keep families separate: BlockList can otherwise match mapped IPv6 to IPv4.
    const ipv4 = new BlockList();
    const ipv6 = new BlockList();
    for (const value of values) {
        const parts = value.split("/");
        if (parts.length > 2) return invalidHttpConfiguration();
        const address = parts[0]!;
        const family = isIP(address);
        if (!family || address.includes("%") || address.length > 45) return invalidHttpConfiguration();
        const list = family === 4 ? ipv4 : ipv6;
        const type = family === 4 ? "ipv4" : "ipv6";
        if (parts.length === 1) {
            list.addAddress(address, type);
        } else {
            const bits = parts[1]!;
            if (!/^(?:0|[1-9][0-9]{0,2})$/.test(bits) ||
                Number(bits) > (family === 4 ? 32 : 128)) return invalidHttpConfiguration();
            list.addSubnet(address, Number(bits), type);
        }
    }
    return (peer): boolean => {
        if (typeof peer !== "string" || peer.length > 45 || peer.includes("%")) return false;
        const family = isIP(peer);
        // No implicit cross-family trust expansion. Configure an IPv6 range
        // explicitly if the listener reports mapped IPv6 peers.
        if (family === 4) return ipv4.check(peer, "ipv4");
        if (family === 6) return ipv6.check(peer, "ipv6");
        return false;
    };
}

export interface ResolvedHttpConfiguration {
    readonly mode: "direct" | "trusted-ingress";
    readonly family: "forwarded" | "x-forwarded" | undefined;
    readonly limits: Readonly<HttpMappingLimits>;
    allowsOrigin(key: string): boolean;
    trustsPeer(peer: string | undefined): boolean;
}

export function resolveHttpConfiguration(options: HttpMapperOptions): ResolvedHttpConfiguration {
    const outer = configurationRecord(options, ["ingress", "limits"]);
    const ingress = configurationRecord(outer.ingress, [
        "mode", "allowedOrigins", "family", "trustedPeers", "sanitizingIngress",
    ]);
    const mode = ingress.mode ?? "direct";
    if (mode !== "direct" && mode !== "trusted-ingress") return invalidHttpConfiguration();
    const origins = new Set<string>();
    for (const value of stringList(ingress.allowedOrigins)) {
        try {
            const key = configuredHttpOriginKey(value);
            if (mode === "trusted-ingress" && !key.startsWith("https://")) return invalidHttpConfiguration();
            origins.add(key);
        } catch {
            return invalidHttpConfiguration();
        }
    }
    let trustsPeer: (peer: string | undefined) => boolean = () => false;
    let family: "forwarded" | "x-forwarded" | undefined;
    if (mode === "direct") {
        if (["family", "trustedPeers", "sanitizingIngress"].some(key => Object.hasOwn(ingress, key))) {
            return invalidHttpConfiguration();
        }
    } else {
        if (ingress.sanitizingIngress !== true ||
            (ingress.family !== "forwarded" && ingress.family !== "x-forwarded")) {
            return invalidHttpConfiguration();
        }
        family = ingress.family;
        trustsPeer = trustedPeerCheck(stringList(ingress.trustedPeers));
    }
    return Object.freeze({
        mode, family, limits: httpLimits(outer.limits as Partial<HttpMappingLimits> | undefined),
        allowsOrigin: (key: string): boolean => origins.has(key),
        trustsPeer,
    });
}