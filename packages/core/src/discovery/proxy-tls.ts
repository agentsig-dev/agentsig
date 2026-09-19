import { request } from "node:https";
import type { RequestOptions } from "node:https";
import type { ClientRequest } from "node:http";
import { isIP } from "node:net";
import type { Socket, TcpNetConnectOpts } from "node:net";
import { checkServerIdentity, connect } from "node:tls";
import type { ConnectionOptions, TLSSocket } from "node:tls";
import { ProfileConfigurationError } from "../profiles/codes.js";
import {
    assertDirectoryAddressPolicy, defaultDirectoryAddressPolicy,
} from "./address-policy.js";
import { DirectoryConnectionError } from "./pinned-tls.js";
import type { PinnedDirectoryConnection } from "./pinned-tls.js";

/**
 * Explicitly trusted infrastructure endpoint, NOT an agent-provided URL.
 * The operator supplies a numeric proxy endpoint and its TLS hostname.
 * A private proxy endpoint is permitted only here; private directory targets
 * remain forbidden. The proxy must honor the numeric CONNECT authority.
 *
 * Initial support is TLS-protected CONNECT without proxy authentication.
 * No environment configuration, plaintext proxy, SOCKS, authentication retry,
 * custom dispatcher, or TLS-verification override is supported.
 */
export interface DirectoryHttpsProxy {
    readonly protocol: "https:";
    readonly hostname: string;
    readonly address: string;
    readonly port: number;
    readonly ca?: string;
}

function hostnameValid(value: unknown): value is string {
    return typeof value === "string" && value.length <= 253 &&
        value.split(".").length >= 2 && isIP(value) === 0 &&
        value.split(".").every((label) =>
            /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

function snapshotProxy(input: DirectoryHttpsProxy): DirectoryHttpsProxy {
    const invalid = (): never => {
        throw new ProfileConfigurationError("invalid-agent-binding");
    };
    if (!input || typeof input !== "object" || Array.isArray(input)) return invalid();
    const fields: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const name of Reflect.ownKeys(input)) {
        if (typeof name !== "string" ||
            !["protocol", "hostname", "address", "port", "ca"].includes(name)) return invalid();
        const property = Object.getOwnPropertyDescriptor(input, name);
        if (!property || !Object.hasOwn(property, "value")) return invalid();
        fields[name] = property.value as unknown;
    }
    if (fields.protocol !== "https:" || !hostnameValid(fields.hostname) ||
        typeof fields.address !== "string" || fields.address.length > 45 ||
        /[\s%/[\]]/.test(fields.address) || isIP(fields.address) === 0 ||
        typeof fields.port !== "number" || !Number.isInteger(fields.port) ||
        fields.port < 1 || fields.port > 65535 ||
        (fields.ca !== undefined && (typeof fields.ca !== "string" || !fields.ca.length))) {
        return invalid();
    }
    return Object.freeze({
        protocol: "https:",
        hostname: fields.hostname,
        address: fields.address,
        port: fields.port,
        ...(fields.ca === undefined ? {} : { ca: fields.ca as string }),
    });
}

/**
 * Own a one-use TLS CONNECT request and return the inner authenticated stream.
 * Target admission happens BEFORE contacting the proxy. DNS has already checked
 * the complete target answer set; this gate defensively checks the selected pin.
 * No target hostname is sent for proxy-side DNS resolution.
 *
 * Unlike direct TCP, we cannot observe the proxy's remote destination socket.
 * TLS authenticates the original directory host, while the configured proxy is
 * trusted to implement the numeric CONNECT request. Do not claim direct-peer
 * observation for this mode or accept an incoming request's proxy configuration.
 */
export function connectDirectoryThroughProxy(
    options: PinnedDirectoryConnection,
    proxyConfiguration: DirectoryHttpsProxy,
): Promise<TLSSocket> {
    const proxy = snapshotProxy(proxyConfiguration);
    const hostname = options.hostname;
    const address = options.address;
    const family = options.family;
    const policy = options.policy ?? defaultDirectoryAddressPolicy;
    const ca = options.ca;
    const timeout = options.timeoutMilliseconds ?? 1000;
    const signal = options.signal;
    assertDirectoryAddressPolicy(policy);
    if (!hostnameValid(hostname)) {
        throw new ProfileConfigurationError("invalid-agent-binding");
    }
    if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 2_147_483_647 ||
        (family !== 4 && family !== 6)) {
        throw new ProfileConfigurationError("invalid-resource-limits");
    }
    if (ca !== undefined && (typeof ca !== "string" || !ca.length)) {
        throw new ProfileConfigurationError("invalid-key-configuration");
    }
    if (typeof address !== "string" || isIP(address) !== family || !policy.allows(address)) {
        return Promise.reject(new DirectoryConnectionError("address-denied"));
    }
    if (signal?.aborted) return Promise.reject(new DirectoryConnectionError("aborted"));
    const authority = family === 6 ? `[${address}]:443` : `${address}:443`;

    return new Promise<TLSSocket>((resolve, reject) => {
        let operation: ClientRequest | undefined;
        let tunnel: Socket | undefined;
        let inner: TLSSocket | undefined;
        let settled = false;
        const timer = setTimeout(() => fail("connect-timeout"), timeout);
        const abort = () => fail("aborted");

        function cleanup(): void {
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
        }
        function fail(reason: DirectoryConnectionError["reason"]): void {
            if (settled) return;
            settled = true;
            cleanup();
            inner?.destroy();
            tunnel?.destroy();
            operation?.destroy();
            reject(new DirectoryConnectionError(reason));
        }
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) { fail("aborted"); return; }
        try {
            const requestOptions: RequestOptions & ConnectionOptions &
                Pick<TcpNetConnectOpts, "autoSelectFamily"> = {
                hostname: proxy.address, port: proxy.port,
                family: isIP(proxy.address), autoSelectFamily: false,
                servername: proxy.hostname,
                rejectUnauthorized: true,
                // The dialed endpoint is an IP, but its certificate identity is
                // the explicitly configured proxy name. No user callback.
                checkServerIdentity: (_host, certificate) =>
                    checkServerIdentity(proxy.hostname, certificate),
                ...(proxy.ca === undefined ? {} : { ca: proxy.ca }),
                ALPNProtocols: ["http/1.1"],
                method: "CONNECT", path: authority,
                headers: { Host: authority },
                agent: false, maxHeaderSize: 16384,
            };
            operation = request(requestOptions);
            operation.on("error", () => fail("connection-failed"));
            operation.once("response", (response) => {
                response.destroy();
                fail("connection-failed");
            });
            operation.once("upgrade", (_response, stream) => {
                stream.destroy();
                fail("connection-failed");
            });
            operation.once("connect", (response, stream, head) => {
                tunnel = stream;
                // Guard errors during transfer and the inner TLS handshake.
                stream.on("error", () => fail("connection-failed"));
                stream.once("close", () => {
                    if (!settled) fail("connection-failed");
                });
                if (settled) { stream.destroy(); return; }
                const outer = stream as TLSSocket;
                if (response.statusCode !== 200 || head.length !== 0) {
                    fail("connection-failed"); return;
                }
                try {
                    if (!outer.authorized ||
                        checkServerIdentity(proxy.hostname, outer.getPeerCertificate())) {
                        fail("tls-failed"); return;
                    }
                    inner = connect({
                        socket: stream, servername: hostname,
                        rejectUnauthorized: true, checkServerIdentity,
                        ALPNProtocols: ["http/1.1"],
                        ...(ca === undefined ? {} : { ca }),
                    });
                    inner.on("error", () => fail("tls-failed"));
                    inner.once("close", () => {
                        if (!settled) fail("tls-failed");
                    });
                    inner.once("secureConnect", () => {
                        if (settled) return;
                        try {
                            if (!inner!.authorized ||
                                checkServerIdentity(hostname, inner!.getPeerCertificate()) ||
                                (inner!.alpnProtocol && inner!.alpnProtocol !== "http/1.1")) {
                                fail("tls-failed"); return;
                            }
                            if (signal?.aborted) { fail("aborted"); return; }
                            settled = true;
                            cleanup();
                            // The caller owns inner TLS and its underlying tunnel.
                            // The HTTP reader must close both after its one request.
                            resolve(inner!);
                        } catch { fail("tls-failed"); }
                    });
                } catch { fail("tls-failed"); }
            });
            operation.end();
        } catch { fail("connection-failed"); }
    });
}