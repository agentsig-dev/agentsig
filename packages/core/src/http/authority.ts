import { isIP } from "node:net";
import { rejectMapping } from "./errors.js";

export interface HttpAuthority {
    readonly original: string;
    readonly canonicalHost: string;
    readonly port: number | undefined;
}

/**
 * Validate before platform parsing. Only the comparison host is canonicalized;
 * never return a normalized path, query or authority as signature input.
 * Caller bounds the input before this function is invoked.
 */
export function parseHttpAuthority(value: string): HttpAuthority {
    const invalid = (): never => rejectMapping("request-malformed");
    if (!value || /[^\x21-\x7e]/.test(value) || /[\\@%/?#]/.test(value)) return invalid();

    let host: string;
    let portText: string | undefined;
    let canonicalHost: string;
    if (value.startsWith("[")) {
        const match = /^(\[([0-9a-fA-F:.]+)\])(?::([0-9]+))?$/.exec(value);
        if (!match || isIP(match[2]!) !== 6) return invalid();
        host = match[1]!;
        portText = match[3];
        // IPv6 compression is for numeric identity comparison only.
        try {
            canonicalHost = new URL(`https://${host}/`).hostname;
        } catch {
            return invalid();
        }
    } else {
        const match = /^([^:[\]]+)(?::([0-9]+))?$/.exec(value);
        if (!match) return invalid();
        host = match[1]!;
        portText = match[2];
        if (!/^[A-Za-z0-9._-]+$/.test(host)) return invalid();
        const lower = host.toLowerCase();
        let checked: URL;
        try {
            checked = new URL(`https://${host}/`);
        } catch {
            return invalid();
        }
        // Reject decoding, IDNA, numeric aliases and other URL-parser repairs.
        if (checked.hostname !== lower || checked.username || checked.password ||
            checked.pathname !== "/" || checked.search || checked.hash) return invalid();
        if (isIP(checked.hostname) === 4 && isIP(host) !== 4) return invalid();
        canonicalHost = lower;
    }

    let port: number | undefined;
    if (portText !== undefined) {
        if (portText.length > 5) return invalid();
        port = Number(portText);
        if (!Number.isInteger(port) || port < 1 || port > 65535) return invalid();
    }
    return Object.freeze({ original: value, canonicalHost, port });
}

/** Injective comparison key with an explicit effective port for both schemes. */
export function httpOriginKey(scheme: "http" | "https", authority: HttpAuthority): string {
    return `${scheme}://${authority.canonicalHost}:${authority.port ?? (scheme === "https" ? 443 : 80)}`;
}

/** Configuration origin syntax has no implicit path, query or fragment repair. */
export function configuredHttpOriginKey(value: string): string {
    const match = /^(https?):\/\/([^/?#]+)\/?$/i.exec(value);
    if (!match) return rejectMapping("request-malformed");
    const scheme = match[1]!.toLowerCase() as "http" | "https";
    return httpOriginKey(scheme, parseHttpAuthority(match[2]!));
}