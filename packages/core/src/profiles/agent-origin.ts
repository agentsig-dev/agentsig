import { isIP } from "node:net";
import { CandidateRejection, ProfileConfigurationError } from "./codes.js";
import { DEFAULT_PROFILE_LIMITS } from "./defaults.js";

/**
 * Approved M2 identity policy, shared by both request profiles.
 * Cloudflare's documentation requires HTTPS but does not impose all these
 * restrictions: origin-only, no IPs and no non-default ports are local policy.
 *
 * This function produces an identity comparison key, NEVER signature input.
 * Keep the original Signature-Agent field bytes for RFC 9421 canonicalization.
 * No DNS resolution, IDNA conversion, network access or ownership proof.
 */
export function canonicalAgentOrigin(
    value: unknown,
    maximumBytes: number = DEFAULT_PROFILE_LIMITS.maxAgentUrlBytes,
): string {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
        throw new ProfileConfigurationError("invalid-resource-limits");
    }
    const malformed = (): never => {
        throw new CandidateRejection({ status: "invalid", reason: "malformed-agent" });
    };
    if (typeof value !== "string") return malformed();
    // Bound before URL parsing or allocation. Valid input is ASCII, so its
    // code-unit length and byte count coincide.
    if (value.length > maximumBytes) {
        throw new CandidateRejection({ status: "unverified", reason: "resource-limit" });
    }
    if (!value.length || /[^\x21-\x7e]/.test(value)) return malformed();

    // Inspect the spelling BEFORE WHATWG parsing: it would repair backslashes,
    // strip dot paths, and normalize numeric IPv4 aliases. These repairs must
    // not turn a disallowed claim into an allowed origin.
    const match = /^https:\/\/([^/?#]+)(\/?)$/i.exec(value);
    if (!match) return malformed();
    const authority = match[1]!;
    if (/[\\@%[\]]/.test(authority)) return malformed();
    const hostPort = /^([^:]+)(?::([0-9]+))?$/.exec(authority);
    if (!hostPort) return malformed();
    const host = hostPort[1]!;
    const port = hostPort[2];
    if (port !== undefined && port !== "443") return malformed();

    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        return malformed();
    }
    const lowerHost = host.toLowerCase();
    // Comparison rejects host decoding/repair, including IDNA transformations.
    // Check both forms for IPs: WHATWG recognizes shortened/integer/hex IPv4.
    if (
        parsed.protocol !== "https:" || !parsed.hostname ||
        parsed.username || parsed.password || parsed.port ||
        parsed.search || parsed.hash || parsed.pathname !== "/" ||
        isIP(lowerHost) !== 0 || isIP(parsed.hostname) !== 0 ||
        parsed.hostname !== lowerHost
    ) return malformed();

    return `https://${lowerHost}`;
}

/** Same origin grammar at configuration time, with a configuration error. */
export function configuredAgentOrigin(
    value: unknown,
    maximumBytes: number = DEFAULT_PROFILE_LIMITS.maxAgentUrlBytes,
): string {
    try {
        return canonicalAgentOrigin(value, maximumBytes);
    } catch (error) {
        if (error instanceof CandidateRejection) {
            throw new ProfileConfigurationError("invalid-agent-binding");
        }
        throw error;
    }
}