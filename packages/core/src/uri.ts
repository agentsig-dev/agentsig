import { SignatureError } from "./errors.js";
import { isFieldName } from "./headers.js";
import { checkLimit } from "./limits.js";
import type { Limits, RequestParts } from "./types.js";

interface TargetParts {
    readonly original: string;
    readonly scheme: string;
    readonly authority: string;
    readonly path: string;
    readonly query: string;
}

/**
 * Separate URI components lexically. WHATWG URL's pathname/search serialization
 * can remove dot segments or rewrite octets; RFC 9421 §§2.2.6–2.2.7 require
 * preserving the observed path/query spelling instead.
 */
function targetParts(target: string, limits: Readonly<Limits>): TargetParts {
    if (typeof target !== "string") throw new SignatureError("malformed");
    checkLimit(limits, "maxTargetUriBytes", target.length);
    // Only an already assembled ASCII HTTP(S) target is accepted. In particular,
    // never discard fragments, infer a base URL, or repair an invalid escape.
    if (
        !/^[A-Za-z0-9\-._~:/?[\]@!$&'()*+,;=%]+$/.test(target) ||
        /%(?![0-9A-Fa-f]{2})/.test(target)
    ) throw new SignatureError("malformed");

    const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]+)([^?#]*)(\?[^#]*)?$/.exec(target);
    if (!match) throw new SignatureError("malformed");
    const scheme = match[1]!.toLowerCase();
    if (scheme !== "http" && scheme !== "https") throw new SignatureError("unsupported");
    const authority = match[2]!;
    // HTTP target URIs must not carry userinfo. Do not silently remove it.
    if (authority.includes("@")) throw new SignatureError("malformed");

    const hostPort = authority.startsWith("[")
        ? /^(\[[0-9A-Fa-f:.]+\])(?::([0-9]*))?$/.exec(authority)
        : /^([^:]+)(?::([0-9]*))?$/.exec(authority);
    if (!hostPort) throw new SignatureError("malformed");

    // Validate authority syntax using the platform, but do not use its normalized
    // path/query or host spelling as the signature input.
    try {
        const checked = new URL(`${scheme}://${authority}/`);
        if (!checked.hostname || checked.username || checked.password) {
            throw new SignatureError("malformed");
        }
    } catch {
        throw new SignatureError("malformed");
    }

    const host = hostPort[1]!.toLowerCase();
    const port = hostPort[2];
    const defaultPort = scheme === "https" ? 443 : 80;
    const normalizedAuthority =
        port === undefined || port === "" || Number(port) === defaultPort
            ? host
            : `${host}:${port}`;

    return {
        original: target,
        scheme,
        authority: normalizedAuthority,
        path: match[3] || "/",
        query: match[4] ?? "?",
    };
}

/**
 * HTML form percent-encode set, with spaces encoded as %20 rather than "+".
 * RFC 9421 §2.2.8 examples explicitly require %20 after decoding form input.
 * URLSearchParams supplies the platform's UTF-8 form encoding; extracting the
 * value avoids applying encodeURIComponent's different punctuation rules.
 */
function encodeQueryPart(value: string): string {
    return new URLSearchParams([["", value]]).toString().slice(1).replace(/\+/g, "%20");
}

function queryParameter(query: string, encodedName: string): string {
    const pairs = new URLSearchParams(query.slice(1));
    let found: string | undefined;
    for (const [name, value] of pairs) {
        if (encodeQueryPart(name) !== encodedName) continue;
        // §2.2.8 forbids covering a repeated named parameter. Selecting the first
        // or last value would disagree with applications using another convention.
        if (found !== undefined) throw new SignatureError("malformed");
        found = encodeQueryPart(value);
    }
    if (found === undefined) throw new SignatureError("missing-component");
    return found;
}

/** Resolve request-only derived components; response status is handled separately. */
export function requestComponent(
    request: RequestParts,
    name: string,
    encodedQueryName: string | undefined,
    limits: Readonly<Limits>,
): string {
    if (request === null || typeof request !== "object") {
        throw new SignatureError("missing-component");
    }
    if (name === "@method") {
        if (typeof request.method !== "string") throw new SignatureError("malformed");
        checkLimit(limits, "maxSignatureBaseBytes", request.method.length);
        if (!isFieldName(request.method)) throw new SignatureError("malformed");
        // RFC 9421 §2.2.1: methods are case sensitive. Never uppercase the input.
        return request.method;
    }
    if (name === "@request-target") {
        const raw = request.rawRequestTarget;
        if (raw === undefined) throw new SignatureError("missing-component");
        if (typeof raw !== "string") throw new SignatureError("malformed");
        checkLimit(limits, "maxTargetUriBytes", raw.length);
        if (!raw.length || /[^\x21-\x7e]/.test(raw)) throw new SignatureError("malformed");
        // Preserve origin-, absolute-, authority-, and asterisk-form exactly.
        return raw;
    }

    const target = targetParts(request.targetUri, limits);
    switch (name) {
        case "@target-uri": return target.original;
        case "@authority": return target.authority;
        case "@scheme": return target.scheme;
        case "@path": return target.path;
        case "@query": return target.query;
        case "@query-param":
            if (encodedQueryName === undefined) throw new SignatureError("malformed");
            return queryParameter(target.query, encodedQueryName);
        default: throw new SignatureError("unsupported");
    }
}