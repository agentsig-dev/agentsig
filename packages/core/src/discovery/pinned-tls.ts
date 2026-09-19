import { connect as connectTcp } from "node:net";
import type { Socket } from "node:net";
import { checkServerIdentity, connect as connectTls } from "node:tls";
import type { TLSSocket } from "node:tls";
import { configuredAgentOrigin } from "../profiles/agent-origin.js";
import { ProfileConfigurationError } from "../profiles/codes.js";
import {
    assertDirectoryAddressPolicy, defaultDirectoryAddressPolicy,
} from "./address-policy.js";
import type { DirectoryAddressPolicy } from "./address-policy.js";

/** Internal transport diagnostics, separate from the frozen verifier catalog. */
export class DirectoryConnectionError extends Error {
    constructor(readonly reason:
        | "address-denied" | "peer-mismatch" | "connection-failed"
        | "tls-failed" | "connect-timeout" | "aborted") {
        super(`Directory connection rejected: ${reason}`);
        this.name = "DirectoryConnectionError";
    }
}

export interface PinnedDirectoryConnection {
    readonly hostname: string;
    readonly address: string;
    readonly family: 4 | 6;
    readonly policy?: DirectoryAddressPolicy;
    /** Explicit trust configuration; absence retains Node's system defaults. */
    readonly ca?: string;
    readonly timeoutMilliseconds?: number;
    readonly signal?: AbortSignal;
}

/**
 * Internal direct connector. Own the socket and dial a numeric address only.
 * No DNS lookup, pool, automatic family selection, retry, proxy environment,
 * caller-supplied TLS callback, or verification-disable option.
 *
 * TCP peer equality is checked BEFORE TLS, and TLS identity is checked BEFORE
 * returning a socket that the HTTP layer may use. A public-address classifier
 * is not a routing guarantee; deployments still need egress controls.
 */
export function connectPinnedDirectoryTls(
    options: PinnedDirectoryConnection,
): Promise<TLSSocket> {
    // Snapshot before asynchronous work so caller mutation cannot redirect TLS
    // identity or change which address policy justified the connection.
    const hostname = options.hostname;
    const address = options.address;
    const family = options.family;
    const policy = options.policy ?? defaultDirectoryAddressPolicy;
    const ca = options.ca;
    const timeout = options.timeoutMilliseconds ?? 1000;
    const signal = options.signal;
    assertDirectoryAddressPolicy(policy);
    if (typeof hostname !== "string" ||
        configuredAgentOrigin(`https://${hostname}`) !== `https://${hostname}` ||
        hostname.length > 253 || hostname.endsWith(".") ||
        hostname.split(".").length < 2 ||
        hostname.split(".").some((label) =>
            !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
        throw new ProfileConfigurationError("invalid-agent-binding");
    }
    if ((family !== 4 && family !== 6) ||
        !Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 2_147_483_647) {
        throw new ProfileConfigurationError("invalid-resource-limits");
    }
    if (ca !== undefined && (typeof ca !== "string" || !ca.length)) {
        throw new ProfileConfigurationError("invalid-key-configuration");
    }
    // Strict family matching must precede dialing, not rely on implicit socket
    // coercion or on a resolver having previously checked this internal input.
    if (typeof address !== "string" || !policy.allows(address) ||
        (family === 4 ? address.includes(":") : !address.includes(":"))) {
        return Promise.reject(new DirectoryConnectionError("address-denied"));
    }
    if (signal?.aborted) return Promise.reject(new DirectoryConnectionError("aborted"));

    return new Promise<TLSSocket>((resolve, reject) => {
        let raw: Socket | undefined;
        let secure: TLSSocket | undefined;
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
            // Destroy without raw backend error values: neither cause chains
            // nor application-visible exceptions should retain sensitive data.
            secure?.destroy();
            raw?.destroy();
            reject(new DirectoryConnectionError(reason));
        }

        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) {
            fail("aborted");
            return;
        }
        try {
            raw = connectTcp({
                host: address, port: 443, family, autoSelectFamily: false,
            });
            // Retain guarded error handlers across Promise handoff so an error
            // between resolution and HTTP listener installation is not unhandled.
            // Socket lifetime, not global state, owns these handlers.
            raw.on("error", () => fail("connection-failed"));
            raw.once("close", () => {
                if (!settled) fail("connection-failed");
            });
            raw.once("connect", () => {
                if (settled) return;
                if (!policy.matchesPeer(address, raw!.remoteAddress)) {
                    fail("peer-mismatch");
                    return;
                }
                try {
                    secure = connectTls({
                        socket: raw!,
                        servername: hostname,
                        rejectUnauthorized: true,
                        checkServerIdentity,
                        ALPNProtocols: ["http/1.1"],
                        ...(ca === undefined ? {} : { ca }),
                    });
                    secure.on("error", () => fail("tls-failed"));
                    secure.once("close", () => {
                        if (!settled) fail("tls-failed");
                    });
                    secure.once("secureConnect", () => {
                        if (settled) return;
                        try {
                            // Explicit identity recheck also protects future
                            // changes involving TLS session reuse. No caller
                            // override can replace hostname verification.
                            if (!secure!.authorized ||
                                checkServerIdentity(hostname, secure!.getPeerCertificate()) ||
                                (secure!.alpnProtocol && secure!.alpnProtocol !== "http/1.1")) {
                                fail("tls-failed");
                                return;
                            }
                            if (!policy.matchesPeer(address, secure!.remoteAddress)) {
                                fail("peer-mismatch");
                                return;
                            }
                            if (signal?.aborted) {
                                fail("aborted");
                                return;
                            }
                            settled = true;
                            cleanup();
                            // Ownership now passes to the HTTP reader, which
                            // must enforce the remaining total/header/body
                            // deadlines and cancellation, then destroy the socket.
                            resolve(secure!);
                        } catch {
                            fail("tls-failed");
                        }
                    });
                } catch {
                    fail("tls-failed");
                }
            });
        } catch {
            fail("connection-failed");
        }
    });
}