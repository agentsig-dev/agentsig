import { Agent, request } from "node:http";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { TLSSocket } from "node:tls";
import { performance } from "node:perf_hooks";
import { configuredAgentOrigin } from "../profiles/agent-origin.js";
import { ProfileConfigurationError } from "../profiles/codes.js";

export class DirectoryResponseError extends Error {
    constructor(readonly reason:
        | "response-failed" | "status-rejected" | "encoding-rejected"
        | "media-type-rejected" | "response-limit" | "response-timeout" | "aborted") {
        super(`Directory response rejected: ${reason}`);
        this.name = "DirectoryResponseError";
    }
}

export interface DirectoryResponseOptions {
    /** Remaining total budget AFTER admission, DNS, and connection time. */
    readonly remainingMilliseconds: number;
    readonly headersMilliseconds?: number;
    readonly bodyIdleMilliseconds?: number;
    readonly maxHeaderBytes?: number;
    readonly maxBodyBytes?: number;
    readonly signal?: AbortSignal;
}

export interface DirectoryResponse {
    readonly body: Uint8Array;
    /** Preserve occurrences for subsequent restrictive cache-header handling. */
    readonly headers: readonly (readonly [string, string])[];
    readonly requestStartedMonotonicMs: number;
    readonly responseReceivedMonotonicMs: number;
    readonly responseReceivedWallMs: number;
}

/**
 * INTERNAL reader: takes ownership of a socket returned by the pinned connector.
 * Never export this as an arbitrary socket/fetch injection API.
 *
 * HTTP framing runs over an already authenticated TLS stream. An owned one-use
 * Agent returns that stream only; it cannot resolve or dial another destination.
 * No redirects, decompression, authentication retries, pooling, or cookies.
 * The caller must validate JWKS before using the returned bytes as evidence.
 */
export function readDirectoryResponse(
    socket: TLSSocket,
    hostname: string,
    options: DirectoryResponseOptions,
): Promise<DirectoryResponse> {
    const remaining = options.remainingMilliseconds;
    const headersMs = options.headersMilliseconds ?? 1000;
    const idleMs = options.bodyIdleMilliseconds ?? 500;
    const headerLimit = options.maxHeaderBytes ?? 16384;
    const bodyLimit = options.maxBodyBytes ?? 262144;
    const signal = options.signal;
    for (const value of [remaining, headersMs, idleMs, headerLimit, bodyLimit]) {
        if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
            socket.destroy();
            throw new ProfileConfigurationError("invalid-resource-limits");
        }
    }
    try {
        if (configuredAgentOrigin(`https://${hostname}`) !== `https://${hostname}`) {
            throw new ProfileConfigurationError("invalid-agent-binding");
        }
    } catch (error) {
        socket.destroy();
        throw error;
    }
    if (socket.destroyed || !socket.authorized) {
        socket.destroy();
        return Promise.reject(new DirectoryResponseError("response-failed"));
    }
    if (signal?.aborted) {
        socket.destroy();
        return Promise.reject(new DirectoryResponseError("aborted"));
    }

    return new Promise((resolve, reject) => {
        const started = performance.now();
        const agent = new Agent({ keepAlive: false, maxSockets: 1 });
        let handedOff = false;
        agent.createConnection = () => {
            if (handedOff || socket.destroyed) {
                throw new DirectoryResponseError("response-failed");
            }
            handedOff = true;
            return socket;
        };
        let operation: ClientRequest | undefined;
        let response: IncomingMessage | undefined;
        let settled = false;
        let idleTimer: ReturnType<typeof setTimeout> | undefined;
        const deadline = setTimeout(() => fail("response-timeout"), remaining);
        const headerTimer = setTimeout(() => fail("response-timeout"), Math.min(headersMs, remaining));
        const abort = () => fail("aborted");

        function cleanup(): void {
            clearTimeout(deadline);
            clearTimeout(headerTimer);
            if (idleTimer !== undefined) clearTimeout(idleTimer);
            signal?.removeEventListener("abort", abort);
        }
        function close(): void {
            response?.destroy();
            operation?.destroy();
            socket.destroy();
            agent.destroy();
        }
        function fail(reason: DirectoryResponseError["reason"]): void {
            if (settled) return;
            settled = true;
            cleanup();
            close();
            reject(new DirectoryResponseError(reason));
        }
        function armIdle(): void {
            if (idleTimer !== undefined) clearTimeout(idleTimer);
            idleTimer = setTimeout(() => fail("response-timeout"), idleMs);
        }

        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) {
            fail("aborted");
            return;
        }
        try {
            operation = request({
                hostname, port: 443, method: "GET",
                path: "/.well-known/http-message-signatures-directory",
                agent, maxHeaderSize: headerLimit,
                headers: {
                    Host: hostname,
                    Accept: "application/http-message-signatures-directory+json",
                    "Accept-Encoding": "identity",
                    Connection: "close",
                },
            }, (incoming) => {
                response = incoming;
                incoming.on("error", () => fail("response-failed"));
                incoming.once("aborted", () => fail("response-failed"));
                if (settled) { incoming.destroy(); return; }
                clearTimeout(headerTimer);
                const receivedMono = performance.now();
                const receivedWall = Date.now();
                if (incoming.statusCode !== 200) { fail("status-rejected"); return; }
                const fields: (readonly [string, string])[] = [];
                for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
                    fields.push(Object.freeze([
                        incoming.rawHeaders[i]!.toLowerCase(), incoming.rawHeaders[i + 1]!,
                    ] as const));
                }
                const values = (name: string) => fields.filter(([key]) => key === name).map(([, value]) => value);
                const encodings = values("content-encoding");
                if (encodings.length > 1 || (encodings.length === 1 &&
                    encodings[0]!.trim().toLowerCase() !== "identity")) {
                    fail("encoding-rejected"); return;
                }
                const types = values("content-type");
                if (types.length !== 1 ||
                    !/^application\/http-message-signatures-directory\+json(?:\s*;\s*charset=(?:"utf-8"|utf-8))?\s*$/i.test(types[0]!)) {
                    fail("media-type-rejected"); return;
                }
                const length = incoming.headers["content-length"];
                if (length !== undefined && (!/^[0-9]+$/.test(length) ||
                    !Number.isSafeInteger(Number(length)) || Number(length) > bodyLimit)) {
                    fail("response-limit"); return;
                }
                const chunks: Buffer[] = [];
                let size = 0;
                armIdle();
                incoming.on("data", (chunk: Buffer) => {
                    if (settled) return;
                    size += chunk.length;
                    if (size > bodyLimit) { fail("response-limit"); return; }
                    chunks.push(Buffer.from(chunk));
                    armIdle(); // Never renew the total deadline on a drip feed.
                });
                incoming.once("end", () => {
                    if (settled) return;
                    if (!incoming.complete || performance.now() - started >= remaining) {
                        fail(incoming.complete ? "response-timeout" : "response-failed"); return;
                    }
                    settled = true;
                    cleanup();
                    const body = Uint8Array.from(Buffer.concat(chunks, size));
                    close();
                    resolve(Object.freeze({
                        body, headers: Object.freeze(fields),
                        requestStartedMonotonicMs: started,
                        responseReceivedMonotonicMs: receivedMono,
                        responseReceivedWallMs: receivedWall,
                    }));
                });
                incoming.once("close", () => {
                    if (!settled) fail("response-failed");
                });
            });
            // Node's default header-count limit silently truncates rawHeaders,
            // potentially hiding Content-Encoding or restrictive Cache-Control.
            // Each field consumes more than one header byte, so this count cannot
            // truncate a section within maxHeaderSize. The byte budget remains
            // enforced by the HTTP parser; this is not an unbounded header policy.
            operation.maxHeadersCount = headerLimit;
            operation.on("error", (error: NodeJS.ErrnoException) =>
                fail(error.code === "HPE_HEADER_OVERFLOW" ? "response-limit" : "response-failed"));
            operation.end();
        } catch {
            fail("response-failed");
        }
    });
}