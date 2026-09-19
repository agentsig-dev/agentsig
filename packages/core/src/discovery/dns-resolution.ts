import { Resolver } from "node:dns/promises";
import { isIP } from "node:net";
import { ProfileConfigurationError } from "../profiles/codes.js";
import { isDirectoryDestinationAllowed } from "./address-policy.js";

/** Internal discovery diagnostics, not additions to the frozen WBA catalog. */
export class DirectoryDnsError extends Error {
    constructor(readonly reason: "dns-failure" | "dns-timeout" | "address-denied" | "dns-limit") {
        super(`Directory DNS resolution rejected: ${reason}`);
        this.name = "DirectoryDnsError";
    }
}

export interface DirectoryAddress {
    readonly address: string;
    readonly family: 4 | 6;
}

/**
 * Internal test seam only; never expose a request-controlled resolver.
 * Production uses an owned Resolver so cancellation cannot affect other callers.
 */
export interface DirectoryDnsResolver {
    resolve4(hostname: string): Promise<string[]>;
    resolve6(hostname: string): Promise<string[]>;
    cancel(): void;
}

function validateHostname(hostname: string): void {
    // Require a multi-label ASCII DNS name, not OS search-list expansion,
    // numeric aliases, URL syntax, zones, or a silently repaired hostname.
    if (typeof hostname !== "string" || hostname.length > 253 ||
        isIP(hostname) !== 0 || hostname.endsWith(".")) {
        throw new DirectoryDnsError("address-denied");
    }
    const labels = hostname.split(".");
    if (labels.length < 2 || labels.some((label) =>
        !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) {
        throw new DirectoryDnsError("address-denied");
    }
}

/** Validate every occurrence before deduplication; no mixed-answer filtering. */
export function validateDirectoryAddresses(
    ipv4: readonly string[],
    ipv6: readonly string[],
    maximumAddresses: number = 16,
): readonly DirectoryAddress[] {
    if (!Number.isSafeInteger(maximumAddresses) || maximumAddresses <= 0) {
        throw new ProfileConfigurationError("invalid-resource-limits");
    }
    if (!Array.isArray(ipv4) || !Array.isArray(ipv6)) {
        throw new DirectoryDnsError("dns-failure");
    }
    if (ipv4.length + ipv6.length > maximumAddresses) {
        throw new DirectoryDnsError("dns-limit");
    }
    const result: DirectoryAddress[] = [];
    for (const [family, addresses] of [[4, ipv4], [6, ipv6]] as const) {
        for (const address of addresses) {
            if (typeof address !== "string" || address.length > 45 ||
                isIP(address) !== family || !isDirectoryDestinationAllowed(address)) {
                throw new DirectoryDnsError("address-denied");
            }
            if (!result.some((entry) => entry.family === family && entry.address === address)) {
                result.push(Object.freeze({ address, family }));
            }
        }
    }
    if (!result.length) throw new DirectoryDnsError("dns-failure");
    return Object.freeze(result);
}

/**
 * Resolve both families before returning any dialable candidate.
 * A successful A response cannot conceal a failing/forbidden AAAA response.
 * ENODATA is the only accepted empty-family response; errors such as SERVFAIL,
 * timeout, or NXDOMAIN do not establish that the other family is safe.
 *
 * No transport is opened here. The caller must dial one returned address
 * without another lookup and verify the connected peer and original TLS host.
 * The caller's total discovery deadline must also include this operation.
 */
export async function resolveDirectoryAddresses(
    hostname: string,
    timeoutMilliseconds: number = 1000,
    maximumAddresses: number = 16,
    createResolver: () => DirectoryDnsResolver = () => new Resolver(),
): Promise<readonly DirectoryAddress[]> {
    if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds <= 0 ||
        timeoutMilliseconds > 2_147_483_647 ||
        !Number.isSafeInteger(maximumAddresses) || maximumAddresses <= 0) {
        throw new ProfileConfigurationError("invalid-resource-limits");
    }
    validateHostname(hostname);
    const resolver = createResolver();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const query = async (family: 4 | 6): Promise<string[]> => {
        try {
            // Trailing dot on the wire prevents search-domain expansion.
            return await (family === 4
                ? resolver.resolve4(`${hostname}.`)
                : resolver.resolve6(`${hostname}.`));
        } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENODATA") return [];
            throw new DirectoryDnsError(timedOut ? "dns-timeout" : "dns-failure");
        }
    };
    try {
        const deadline = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
                timedOut = true;
                reject(new DirectoryDnsError("dns-timeout"));
                try { resolver.cancel(); } catch { /* Never expose backend errors. */ }
            }, timeoutMilliseconds);
        });
        const [ipv4, ipv6] = await Promise.race([
            Promise.all([query(4), query(6)]),
            deadline,
        ]);
        return validateDirectoryAddresses(ipv4, ipv6, maximumAddresses);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
        // Also cancel a still-pending sibling when one family failed.
        // Promise.all has handlers for both, so late rejection cannot leak.
        try { resolver.cancel(); } catch { /* Cleanup cannot change the outcome. */ }
    }
}