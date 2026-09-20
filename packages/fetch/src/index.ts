import { SigningError } from "@agentsig/core/profiles";
import type { WebBotAuthSigner } from "@agentsig/core/profiles";
import type { RequestParts } from "@agentsig/core";

export interface SignedFetchOptions {
    readonly signer: WebBotAuthSigner;
    /** Trusted application transport; the wrapper cannot attest its behavior. */
    readonly fetch?: typeof globalThis.fetch;
    readonly bodyPolicy?: "reject" | "allow-unverified";
    /** Test-only plaintext access to exact 127.0.0.1 or [::1] literals. */
    readonly allowHttpLoopbackForTests?: boolean;
}

export type SignedFetchInit = RequestInit & { readonly duplex?: "half" };
export type SignedFetch = (
    input: string | URL | Request,
    init?: SignedFetchInit,
) => Promise<Response>;

const signatureNames = new Set(["signature", "signature-input", "signature-agent"]);
const forbiddenNames = new Set([
    "host", ":authority", "connection", "keep-alive", "proxy-authenticate",
    "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "content-length",
]);
const initKeys = [
    "method", "headers", "body", "signal", "redirect", "cache", "credentials",
    "integrity", "keepalive", "mode", "referrer", "referrerPolicy", "duplex",
];

function invalid(): never {
    throw new TypeError("Invalid signed Fetch request");
}
function invalidOptions(): never {
    throw new TypeError("Invalid signed Fetch configuration");
}
function aborted(signal: AbortSignal | null | undefined): void {
    if (signal?.aborted) throw new DOMException("Signed Fetch request aborted", "AbortError");
}

/** Local JS objects are not a hostile Proxy sandbox. Do not invoke ordinary accessors. */
function record(value: unknown, keys: readonly string[], fail: () => never): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
    const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string" || !keys.includes(key)) return fail();
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        if (!Object.hasOwn(descriptor, "value")) return fail();
        copy[key] = descriptor.value as unknown;
    }
    return copy;
}

function checkedHeaders(value: RequestInit["headers"], HeadersClass: typeof Headers): Headers {
    let headers: Headers;
    try { headers = new HeadersClass(value); } catch { return invalid(); }
    for (const name of signatureNames) {
        if (headers.has(name)) throw new SigningError("existing-signature-headers");
    }
    for (const name of headers.keys()) {
        if (forbiddenNames.has(name)) return invalid();
    }
    return headers;
}

/**
 * Only the explicitly approved HTTP exception is checked before URL
 * normalization. Preconstructed objects have already lost original spelling.
 */
function checkedDestination(value: string, allowHttp: boolean): void {
    if (value.length > 16_384 || /[\x00-\x20\x7f\\]/.test(value) || value.includes("#")) return invalid();
    const match = /^(https?):\/\/([^/?#]+)(?:[/?]|$)/i.exec(value);
    if (!match || match[2]!.includes("@")) return invalid();
    if (match[1]!.toLowerCase() === "http") {
        if (!allowHttp) return invalid();
        const authority = /^(127\.0\.0\.1|\[::1\])(?::([0-9]{1,5}))?$/.exec(match[2]!);
        if (!authority) return invalid();
        if (authority[2] !== undefined &&
            (Number(authority[2]) < 1 || Number(authority[2]) > 65535)) return invalid();
    }
    try {
        const url = new URL(value);
        if (!url.hostname || url.username || url.password ||
            (url.protocol !== "https:" && url.protocol !== "http:")) return invalid();
    } catch { return invalid(); }
}

/**
 * One signer call and one selected transport invocation, NOT exactly-once wire
 * delivery. Native Fetch can resend after 421; injected transports are trusted.
 * No body hashing, retry, re-signing, clone or tee is performed by this wrapper.
 */
export function createSignedFetch(options: SignedFetchOptions): SignedFetch {
    const config = record(options, ["signer", "fetch", "bodyPolicy", "allowHttpLoopbackForTests"], invalidOptions);
    const signer = config.signer as WebBotAuthSigner;
    if (!signer || typeof signer !== "object" || typeof signer.sign !== "function") return invalidOptions();
    const sign = signer.sign;
    const transport = config.fetch ?? globalThis.fetch;
    const bodyPolicy = config.bodyPolicy ?? "reject";
    if (typeof transport !== "function" ||
        (bodyPolicy !== "reject" && bodyPolicy !== "allow-unverified") ||
        (config.allowHttpLoopbackForTests !== undefined && typeof config.allowHttpLoopbackForTests !== "boolean")) {
        return invalidOptions();
    }
    // Keep construction and transport choices stable across awaited signing.
    const RequestClass = globalThis.Request;
    const HeadersClass = globalThis.Headers;
    const allowHttp = config.allowHttpLoopbackForTests === true;
    if (typeof RequestClass !== "function" || typeof HeadersClass !== "function") return invalidOptions();
    const send = transport as typeof globalThis.fetch;

    return async (input, init = {}): Promise<Response> => {
        const own = record(init, initKeys, invalid);
        if (!(typeof input === "string" || input instanceof URL || input instanceof RequestClass)) return invalid();
        const source = input instanceof RequestClass ? input : undefined;
        // Screen independently BEFORE init headers replace the input header list.
        if (source) checkedHeaders(source.headers, HeadersClass);
        const headers = own.headers === undefined
            ? source ? checkedHeaders(source.headers, HeadersClass) : new HeadersClass()
            : checkedHeaders(own.headers as RequestInit["headers"], HeadersClass);
        if (own.redirect !== undefined && own.redirect !== "manual") return invalid();
        if (own.mode === "no-cors" || (own.mode === undefined && source?.mode === "no-cors")) return invalid();
        if (source && (source.bodyUsed || source.body?.locked)) return invalid();
        if (bodyPolicy === "reject" && (source?.body != null || own.body != null)) return invalid();

        const value = source ? source.url : typeof input === "string" ? input : (input as URL).href;
        checkedDestination(value, allowHttp);
        const signal = own.signal === undefined ? source?.signal : own.signal as AbortSignal | null;
        aborted(signal);

        let request: Request;
        try {
            request = new RequestClass(source ?? value, {
                ...own, headers, redirect: "manual",
            } as SignedFetchInit);
        } catch { return invalid(); }
        checkedDestination(request.url, allowHttp);
        if (request.mode === "no-cors" || request.bodyUsed || request.body?.locked ||
            (bodyPolicy === "reject" && request.body !== null)) return invalid();
        aborted(request.signal);

        // The signer receives only detached descriptor data, never the owned Request.
        const parts: RequestParts = {
            method: request.method, targetUri: request.url,
            headers: [...request.headers].map(([name, value]) => [name, value] as const),
        };
        let patch: Awaited<ReturnType<WebBotAuthSigner["sign"]>>;
        try { patch = await sign.call(signer, parts); }
        catch (error) {
            if (error instanceof SigningError) throw new SigningError(error.code);
            throw new TypeError("Signed Fetch signing failed");
        }
        aborted(request.signal);

        // Validate patch completely before mutating the owned outgoing headers.
        // This does not attest an arbitrary application signer's cryptography.
        const signed = new HeadersClass();
        try {
            if (!Array.isArray(patch) || patch.length !== 3) return invalid();
            for (const pair of patch) {
                if (!Array.isArray(pair) || pair.length !== 2 ||
                    typeof pair[0] !== "string" || typeof pair[1] !== "string") return invalid();
                const name = pair[0].toLowerCase();
                if (!signatureNames.has(name) || signed.has(name) ||
                    /[^\x20-\x7e]/.test(pair[1]) || pair[1].length === 0 ||
                    pair[1] !== pair[1].trim()) return invalid();
                signed.set(name, pair[1]);
            }
            if (![...signatureNames].every(name => signed.has(name))) return invalid();
            for (const [name, value] of signed) request.headers.set(name, value);
        } catch { return invalid(); }
        aborted(request.signal);
        try {
            // No second init object can override the signed request at dispatch.
            return await send(request);
        } catch {
            aborted(request.signal);
            throw new TypeError("Signed Fetch transport failed");
        }
    };
}