import { isIP } from "node:net";
import { rejectMapping } from "./errors.js";
import type { ObservedClient } from "./types.js";

const token = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const tokenCharacter = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]$/;

/** Input is bounded and header-value validated by the capture/mapper boundary. */
export function parseForwarded(value: string): ReadonlyMap<string, string> {
    const malformed = (): never => rejectMapping("forwarding-malformed");
    const pairs = new Map<string, string>();
    let position = 0;
    const whitespace = (): void => {
        while (value[position] === " " || value[position] === "\t") position++;
    };
    whitespace();
    while (position < value.length) {
        if (value[position] === ",") return rejectMapping("forwarding-chain-rejected");
        const start = position;
        while (position < value.length && tokenCharacter.test(value[position]!)) position++;
        const name = value.slice(start, position).toLowerCase();
        if (!name || !["host", "proto", "for", "by"].includes(name) || pairs.has(name)) {
            return malformed();
        }
        if (value[position++] !== "=") return malformed();
        let decoded = "";
        if (value[position] === '"') {
            position++;
            let closed = false;
            while (position < value.length) {
                let character = value[position++]!;
                if (character === '"') { closed = true; break; }
                if (character === "\\") {
                    if (position >= value.length) return malformed();
                    character = value[position++]!;
                    const code = character.charCodeAt(0);
                    if (code !== 9 && (code < 32 || code > 126)) return malformed();
                } else {
                    const code = character.charCodeAt(0);
                    if (code !== 9 && (code < 32 || code > 126)) return malformed();
                }
                decoded += character;
            }
            if (!closed) return malformed();
        } else {
            const begin = position;
            while (position < value.length && tokenCharacter.test(value[position]!)) position++;
            decoded = value.slice(begin, position);
            if (!token.test(decoded)) return malformed();
        }
        pairs.set(name, decoded);
        whitespace();
        if (position === value.length) break;
        if (value[position] === ",") return rejectMapping("forwarding-chain-rejected");
        if (value[position++] !== ";") return malformed();
        // Conservative subset: no empty pairs, including a trailing semicolon.
        whitespace();
        if (position === value.length) return malformed();
    }
    if (pairs.size === 0) return malformed();
    return pairs;
}

/** RFC 7239 node, not an IP-only client identity or a transport destination. */
export function forwardedNode(value: string): ObservedClient {
    const malformed = (): never => rejectMapping("forwarding-malformed");
    const match = /^(\[[0-9A-Fa-f:.]+\]|[^:]+)(?::([^:]+))?$/.exec(value);
    if (!match) return malformed();
    const node = match[1]!;
    const port = match[2];
    if (port !== undefined && !/^(?:[0-9]{1,5}|_[A-Za-z0-9._-]+)$/.test(port)) return malformed();
    let address = node;
    let kind: ObservedClient["kind"];
    if (node.startsWith("[")) {
        address = node.slice(1, -1);
        if (isIP(address) !== 6) return malformed();
        kind = "ip";
    } else if (isIP(node) === 4) {
        kind = "ip";
    } else if (node.toLowerCase() === "unknown") {
        kind = "unknown";
    } else if (/^_[A-Za-z0-9._-]+$/.test(node)) {
        kind = "obfuscated";
    } else {
        return malformed();
    }
    return Object.freeze({
        kind, address, ...(port === undefined ? {} : { port }),
        source: "trusted-ingress", authenticated: false,
    });
}

/** Canonical numeric hint only; no hostnames, zones, brackets, aliases or ports. */
export function xForwardedClient(value: string): ObservedClient {
    const family = isIP(value);
    if (family === 0 || value.includes("%") || value.length > 45) {
        return rejectMapping("forwarding-malformed");
    }
    if (family === 6 && new URL(`https://[${value}]/`).hostname !== `[${value}]`) {
        return rejectMapping("forwarding-malformed");
    }
    return Object.freeze({
        kind: "ip", address: value, source: "trusted-ingress", authenticated: false,
    });
}