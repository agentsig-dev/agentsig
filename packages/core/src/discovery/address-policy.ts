import { isIP } from "node:net";
import { ProfileConfigurationError } from "../profiles/codes.js";

interface Address {
    readonly family: 4 | 6;
    readonly value: bigint;
}

/**
 * Bounded numeric parsing after Node's strict syntax validation.
 * Do not let URL parsing repair octal, abbreviated, bracketed, or zoned input.
 * These are DNS/socket addresses, not Signature-Agent origin strings.
 */
function parseAddress(input: unknown): Address | undefined {
    if (typeof input !== "string" || input.length === 0 || input.length > 45 ||
        /[\s%/[\]]/.test(input)) return undefined;
    const family = isIP(input);
    if (family === 4) {
        let value = 0n;
        for (const octet of input.split(".")) value = (value << 8n) | BigInt(octet);
        return { family: 4, value };
    }
    if (family !== 6) return undefined;
    let text = input;
    // Convert an embedded dotted suffix only for numeric comparison. Admission
    // still rejects mapped/compatible/translation ranges below.
    if (text.includes(".")) {
        const colon = text.lastIndexOf(":");
        const octets = text.slice(colon + 1).split(".").map(Number);
        const high = (octets[0]! * 256 + octets[1]!).toString(16);
        const low = (octets[2]! * 256 + octets[3]!).toString(16);
        text = text.slice(0, colon + 1) + high + ":" + low;
    }
    const halves = text.split("::");
    const left = halves[0] ? halves[0].split(":") : [];
    const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
    const groups = halves.length === 2
        ? [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right]
        : left;
    let value = 0n;
    for (const group of groups) value = (value << 16n) | BigInt(`0x${group}`);
    return { family: 6, value };
}

function prefix(text: string, bits: number): (address: Address) => boolean {
    const network = parseAddress(text);
    if (!network) throw new Error("Invalid internal address prefix");
    const shift = BigInt((network.family === 4 ? 32 : 128) - bits);
    return (address) => address.family === network.family &&
        (address.value >> shift) === (network.value >> shift);
}

/**
 * Conservative local exclusions from IANA snapshots updated 2025-10-09:
 * IPv4 SHA-256 cf24e11f41b7d42c68debe2d18b97cac815084ec413ebb3b244f704028a16f20
 * IPv6 SHA-256 c17f4380ba84fb2160dae82ebfd8bd155a5853cfab624ed3a9fd251638a8be02
 *
 * Reject ALL special-purpose entries, including globally reachable exceptions.
 * Broader prefixes subsume their nested records. This is intentionally narrower
 * than IANA global reachability, not a complete allocation/routing inventory.
 * IPv4 multicast is additionally denied; IPv6 must be in 2000::/3. That envelope
 * already excludes mapped, compatible, NAT64, ULA, link-local and multicast.
 * No runtime registry download occurs. Explicit exceptions are restricted to
 * the named non-transition catalog below, never arbitrary CIDRs or predicates.
 */
const excluded = [
    prefix("0.0.0.0", 8), prefix("10.0.0.0", 8),
    prefix("100.64.0.0", 10), prefix("127.0.0.0", 8),
    prefix("169.254.0.0", 16), prefix("172.16.0.0", 12),
    prefix("192.0.0.0", 24), prefix("192.0.2.0", 24),
    prefix("192.31.196.0", 24), prefix("192.52.193.0", 24),
    prefix("192.88.99.0", 24), prefix("192.168.0.0", 16),
    prefix("192.175.48.0", 24), prefix("198.18.0.0", 15),
    prefix("198.51.100.0", 24), prefix("203.0.113.0", 24),
    prefix("224.0.0.0", 4), prefix("240.0.0.0", 4),
    prefix("2001::", 23), prefix("2001:db8::", 32),
    prefix("2002::", 16), prefix("2620:4f:8000::", 48),
    prefix("3fff::", 20),
];
const globalV6Envelope = prefix("2000::", 3);

function admitted(address: Address): boolean {
    return (address.family === 4 || globalV6Envelope(address)) &&
        !excluded.some((contains) => contains(address));
}

/** Internal destination gate; passing is not proof of reachability or identity. */
export function isDirectoryDestinationAllowed(input: unknown): boolean {
    const address = parseAddress(input);
    return address !== undefined && admitted(address);
}

/**
 * Check the connected peer against an admitted pin, never a new DNS lookup.
 * An OS may report a native IPv4 connection as ::ffff:a.b.c.d. Accept this
 * representation only for equality with that already admitted IPv4 pin.
 * This comparison does not admit mapped addresses supplied as DNS candidates.
 */
export function matchesPinnedDirectoryAddress(pinned: unknown, peer: unknown): boolean {
    return defaultDirectoryAddressPolicy.matchesPeer(pinned, peer);
}

/**
 * Names and ranges match the independently pinned transport fixture.
 * These entries have IANA global=True, but remain opt-in local policy.
 * No translation prefix, private range, or broad parent exception is exposed.
 */
const exceptionPrefixes = {
    "pcp-anycast-v4": prefix("192.0.0.9", 32),
    "turn-anycast-v4": prefix("192.0.0.10", 32),
    "as112-v4": prefix("192.31.196.0", 24),
    "amt-v4": prefix("192.52.193.0", 24),
    "as112-direct-v4": prefix("192.175.48.0", 24),
    "pcp-anycast-v6": prefix("2001:1::1", 128),
    "turn-anycast-v6": prefix("2001:1::2", 128),
    "dnssd-anycast-v6": prefix("2001:1::3", 128),
    "amt-v6": prefix("2001:3::", 32),
    "as112-v6": prefix("2001:4:112::", 48),
    "orchid-v2": prefix("2001:20::", 28),
    "det-v6": prefix("2001:30::", 28),
    "as112-direct-v6": prefix("2620:4f:8000::", 48),
} as const;

export type DirectoryAddressException = keyof typeof exceptionPrefixes;

export interface DirectoryAddressPolicy {
    readonly exceptions: readonly DirectoryAddressException[];
    allows(address: unknown): boolean;
    matchesPeer(pinned: unknown, peer: unknown): boolean;
}

// Internal identity check prevents callers from supplying an arbitrary
// allow-everything predicate in place of a validated policy.
const ownedPolicies = new WeakSet<object>();

export function assertDirectoryAddressPolicy(
    policy: DirectoryAddressPolicy,
): void {
    if (!policy || typeof policy !== "object" || !ownedPolicies.has(policy)) {
        throw new ProfileConfigurationError("invalid-agent-binding");
    }
}

/** Snapshot trusted local configuration; reject ordinary executable accessors. */
export function createDirectoryAddressPolicy(
    exceptions: readonly DirectoryAddressException[] = [],
): DirectoryAddressPolicy {
    const invalid = (): never => {
        throw new ProfileConfigurationError("invalid-agent-binding");
    };
    if (!Array.isArray(exceptions) ||
        exceptions.length > Object.keys(exceptionPrefixes).length) return invalid();
    const selected: DirectoryAddressException[] = [];
    for (let index = 0; index < exceptions.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(exceptions, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, "value")) return invalid();
        const name: unknown = descriptor.value;
        if (typeof name !== "string" || !Object.hasOwn(exceptionPrefixes, name)) return invalid();
        const id = name as DirectoryAddressException;
        if (selected.includes(id)) return invalid();
        selected.push(id);
    }
    const checks = selected.map((id) => exceptionPrefixes[id]);
    const allowed = (address: Address): boolean =>
        admitted(address) || checks.some((contains) => contains(address));
    const policy: DirectoryAddressPolicy = Object.freeze({
        exceptions: Object.freeze(selected),
        allows(input: unknown): boolean {
            const address = parseAddress(input);
            return address !== undefined && allowed(address);
        },
        matchesPeer(pinned: unknown, peer: unknown): boolean {
            const expected = parseAddress(pinned);
            const actual = parseAddress(peer);
            if (!expected || !allowed(expected) || !actual) return false;
            if (expected.family === actual.family) return expected.value === actual.value;
            // Comparison-only OS representation; never a DNS admission alias.
            return expected.family === 4 && actual.family === 6 &&
                (actual.value >> 32n) === 0xffffn &&
                (actual.value & 0xffffffffn) === expected.value;
        },
    });
    ownedPolicies.add(policy);
    return policy;
}

export const defaultDirectoryAddressPolicy = createDirectoryAddressPolicy();