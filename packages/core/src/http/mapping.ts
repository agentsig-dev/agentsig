import { parseHttpAuthority, httpOriginKey } from "./authority.js";
import type { ResolvedHttpConfiguration } from "./configuration.js";
import { HttpMappingError, rejectMapping } from "./errors.js";
import { forwardedNode, parseForwarded, xForwardedClient } from "./forwarding.js";
import { snapshotHttpRequest } from "./snapshot.js";
import type { HeaderField } from "../types.js";
import type { HttpMappingResult, MappedHttpRequest, ObservedClient } from "./types.js";

const xFields = ["x-forwarded-host", "x-forwarded-proto", "x-forwarded-port", "x-forwarded-for"];

/** Internal pure mapping boundary. It is not proof of owned listener capture. */
export function mapHttpSnapshot(input: unknown, config: ResolvedHttpConfiguration): HttpMappingResult {
    try {
        const snapshot = snapshotHttpRequest(input, config.limits);
        const fields = new Map<string, string[]>();
        const headers: HeaderField[] = [];
        for (let index = 0; index < snapshot.rawHeaders.length; index += 2) {
            const name = snapshot.rawHeaders[index]!;
            const value = snapshot.rawHeaders[index + 1]!;
            const lower = name.toLowerCase();
            const occurrences = fields.get(lower);
            if (occurrences) occurrences.push(value);
            else fields.set(lower, [value]);
            headers.push(Object.freeze([
                name, /[^\x00-\x7f]/.test(value) ? Uint8Array.from(Buffer.from(value, "latin1")) : value,
            ] as const));
        }
        const host = fields.get("host");
        if (!host) return rejectMapping("host-missing");
        if (host.length !== 1) return rejectMapping("host-ambiguous");
        const internal = parseHttpAuthority(host[0]!);
        let authority = internal;
        let scheme: "http" | "https" = snapshot.encrypted ? "https" : "http";
        let observedClient: ObservedClient | undefined;

        if (config.mode === "trusted-ingress") {
            if (!config.trustsPeer(snapshot.peerAddress)) return rejectMapping("ingress-peer-untrusted");
            const forwarded = fields.get("forwarded");
            const hasX = xFields.some(name => fields.has(name));
            // The unselected recognized family is never fallback evidence.
            if ((config.family === "forwarded" && hasX) ||
                (config.family === "x-forwarded" && forwarded)) {
                return rejectMapping("forwarding-families-mixed");
            }

            const single = (name: string, required: boolean): string | undefined => {
                const values = fields.get(name);
                if (!values) {
                    if (required) return rejectMapping("forwarding-missing");
                    return undefined;
                }
                if (values.length !== 1 || values[0]!.includes(",")) {
                    return rejectMapping("forwarding-chain-rejected");
                }
                if (!values[0]) return rejectMapping("forwarding-malformed");
                return values[0]!;
            };

            let externalHost: string;
            let protocol: string;
            if (config.family === "forwarded") {
                if (!forwarded) return rejectMapping("forwarding-missing");
                if (forwarded.length !== 1) return rejectMapping("forwarding-chain-rejected");
                const pairs = parseForwarded(forwarded[0]!);
                if (!pairs.has("host") || !pairs.has("proto")) return rejectMapping("forwarding-missing");
                externalHost = pairs.get("host")!;
                protocol = pairs.get("proto")!;
                if (pairs.has("for")) observedClient = forwardedNode(pairs.get("for")!);
                if (pairs.has("by")) forwardedNode(pairs.get("by")!);
            } else {
                // Screen every recognized occurrence before selecting target values.
                externalHost = single("x-forwarded-host", true)!;
                protocol = single("x-forwarded-proto", true)!;
                const port = single("x-forwarded-port", false);
                const client = single("x-forwarded-for", false);
                if (client !== undefined) observedClient = xForwardedClient(client);
                authority = parseHttpAuthority(externalHost);
                if (port !== undefined) {
                    if (!/^[0-9]{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
                        return rejectMapping("forwarding-malformed");
                    }
                    if (Number(port) !== (authority.port ?? 443)) {
                        return rejectMapping("forwarding-port-inconsistent");
                    }
                }
            }
            if (protocol !== "https") return rejectMapping("ingress-https-required");
            scheme = "https";
            authority = parseHttpAuthority(externalHost);
        }

        if (!config.allowsOrigin(httpOriginKey(scheme, authority))) return rejectMapping("origin-disallowed");
        const length = scheme.length + 3 + authority.original.length + snapshot.url.length;
        if (length > config.limits.maxTargetUriBytes) return rejectMapping("resource-limit");

        const contentLength = fields.get("content-length");
        const transferEncoding = fields.get("transfer-encoding");
        // Defensive checks also apply to internal descriptor tests. The strict Node
        // parser normally rejects ambiguous framing before the listener is reached.
        if (contentLength && (contentLength.length !== 1 || !/^[0-9]+$/.test(contentLength[0]!))) {
            return rejectMapping("headers-malformed");
        }
        if (transferEncoding && (contentLength || transferEncoding.length !== 1 ||
            transferEncoding[0]!.toLowerCase() !== "chunked")) {
            return rejectMapping("headers-malformed");
        }
        const bodyPresent = transferEncoding !== undefined ||
            (contentLength !== undefined && /[1-9]/.test(contentLength[0]!));
        const result: MappedHttpRequest = Object.freeze({
            status: "mapped",
            request: Object.freeze({
                method: snapshot.method,
                targetUri: `${scheme}://${authority.original}${snapshot.url}`,
                rawRequestTarget: snapshot.url,
                httpVersion: "1.1" as const,
                headers: Object.freeze(headers),
            }),
            targetSource: config.mode,
            internalAuthority: internal.original,
            bodyPresent,
            ...(observedClient === undefined ? {} : { observedClient }),
        });
        return result;
    } catch (error) {
        if (error instanceof HttpMappingError) {
            return Object.freeze({ status: "mapping-rejected", code: error.code });
        }
        // Programming/integration errors must not be hidden as input rejection.
        throw error;
    }
}

/** Public views never share mutable typed-array storage with the owned result. */
export function copyHttpMapping(result: HttpMappingResult): HttpMappingResult {
    if (result.status === "mapping-rejected") return result;
    return Object.freeze({
        ...result,
        request: Object.freeze({
            ...result.request,
            headers: Object.freeze(result.request.headers.map(([name, value]) => Object.freeze([
                name, typeof value === "string" ? value : Uint8Array.from(value),
            ] as const))),
        }),
    });
}