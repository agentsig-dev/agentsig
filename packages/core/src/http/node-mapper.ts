import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, RequestListener, Server as HttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { ServerOptions as HttpsServerOptions, Server as HttpsServer } from "node:https";
import type { TLSSocket } from "node:tls";
import { configurationRecord, resolveHttpConfiguration } from "./configuration.js";
import { invalidHttpConfiguration } from "./errors.js";
import { copyHttpMapping, mapHttpSnapshot } from "./mapping.js";
import type { HttpMapperOptions, HttpMappingResult } from "./types.js";

export interface NodeHttpMapper {
    readonly ingressMode: "direct" | "trusted-ingress";
    /**
     * Creates an unlistened HTTP/1.1 server with capture before listener dispatch.
     * Pass this through Fastify's serverFactory, or wrap Express/Hono Node listeners.
     */
    createServer(listener: RequestListener): HttpServer;
    /** TLS remains application-owned; HTTP/2 ALPN negotiation is not supported. */
    createSecureServer(listener: RequestListener, tls: HttpsServerOptions): HttpsServer;
    /** Returns a detached view; missing owned capture is never reconstructed. */
    map(request: IncomingMessage): HttpMappingResult;
}

const missing = Object.freeze({ status: "mapping-rejected", code: "capture-missing" } as const);
const incomplete = Object.freeze({ status: "mapping-rejected", code: "capture-incomplete" } as const);
const http2 = Object.freeze({ status: "mapping-rejected", code: "http2-unsupported" } as const);

const ownedMappers = new WeakSet<object>();

export function assertNodeHttpMapper(mapper: NodeHttpMapper): void {
    if (!mapper || !ownedMappers.has(mapper)) return invalidHttpConfiguration();
}

/**
 * Server creation owns parser settings, capture placement and private request
 * association together. There is no public "headersComplete: true" assertion or
 * API that stamps an arbitrary framework descriptor as trusted capture.
 *
 * Application JavaScript can deliberately bypass listeners or emit fake events;
 * this integration is not a sandbox against privileged application code.
 */
export function createNodeHttpMapper(options: HttpMapperOptions): NodeHttpMapper {
    const config = resolveHttpConfiguration(options);
    const results = new WeakMap<object, HttpMappingResult>();

    const create = (
        listener: RequestListener,
        tls?: HttpsServerOptions,
    ): HttpServer | HttpsServer => {
        if (typeof listener !== "function") return invalidHttpConfiguration();
        // TLS material is trusted local configuration. Do not allow TLS options
        // to replace parser constructors/settings or negotiate an unsupported H2.
        let secureOptions: HttpsServerOptions | undefined;
        if (tls !== undefined) {
            const record = configurationRecord(tls, [
                "key", "cert", "ca", "pfx", "passphrase", "ciphers", "minVersion",
                "maxVersion", "requestCert", "rejectUnauthorized", "honorCipherOrder",
                "secureOptions", "sessionTimeout",
            ]);
            secureOptions = { ...record, ALPNProtocols: ["http/1.1"] } as HttpsServerOptions;
        }

        const ownedSockets = new WeakSet<object>();
        const dispatch: RequestListener = (request, response) => {
            if (results.has(request)) {
                // Re-emitting the request event is not a new incoming request.
                // Do not re-enter application processing or replay admission.
                return;
            }
            let result: HttpMappingResult;
            if (request.httpVersionMajor === 2) {
                result = http2;
            } else if (!ownedSockets.has(request.socket) ||
                server.maxHeadersCount !== config.limits.maxHeaderBytes ||
                Object.getOwnPropertyDescriptor(server, "maxHeaderSize")?.value !== config.limits.maxHeaderBytes ||
                Object.getOwnPropertyDescriptor(server, "insecureHTTPParser")?.value !== false) {
                result = incomplete;
            } else {
                result = mapHttpSnapshot({
                    method: request.method,
                    url: request.url,
                    httpVersion: request.httpVersion,
                    rawHeaders: request.rawHeaders,
                    peerAddress: request.socket.remoteAddress,
                    encrypted: (request.socket as Partial<TLSSocket>).encrypted === true,
                }, config);
            }
            results.set(request, result);
            listener(request, response);
        };
        const parserOptions = {
            maxHeaderSize: config.limits.maxHeaderBytes,
            insecureHTTPParser: false,
            joinDuplicateHeaders: false,
        };
        const server = secureOptions === undefined
            ? createHttpServer(parserOptions, dispatch)
            : createHttpsServer({ ...secureOptions, ...parserOptions }, dispatch);

        // Track actual connections without relying on undocumented Socket.server.
        // HTTPS dispatch uses the TLSSocket emitted by secureConnection, not
        // necessarily the underlying TCP socket emitted by connection.
        server.on("connection", socket => { ownedSockets.add(socket); });
        if (secureOptions !== undefined) {
            (server as HttpsServer).on("secureConnection", socket => { ownedSockets.add(socket); });
        }

        // Every occurrence consumes more than one byte. This count cannot truncate
        // a section within the parser byte budget, including fragmented delivery.
        // Configuration caps the value well below signed bit-shift overflow.
        for (const [name, value] of [
            ["maxHeadersCount", config.limits.maxHeaderBytes],
            ["maxHeaderSize", config.limits.maxHeaderBytes],
            ["insecureHTTPParser", false],
            ["joinDuplicateHeaders", false],
        ] as const) {
            Object.defineProperty(server, name, { value, writable: false, configurable: false });
        }
        return server;
    };

    const mapper: NodeHttpMapper = Object.freeze({
        ingressMode: config.mode,
        createServer(listener: RequestListener): HttpServer {
            return create(listener) as HttpServer;
        },
        createSecureServer(listener: RequestListener, tls: HttpsServerOptions): HttpsServer {
            if (tls === undefined) return invalidHttpConfiguration();
            return create(listener, tls) as HttpsServer;
        },
        map(request: IncomingMessage): HttpMappingResult {
            if (!request || typeof request !== "object") return missing;
            const result = results.get(request);
            if (result !== undefined) return copyHttpMapping(result);
            // Only explicit protocol detection precedes the missing-capture result.
            // Read data descriptors, not arbitrary framework getters.
            const major = Object.getOwnPropertyDescriptor(request, "httpVersionMajor")?.value as unknown;
            const version = Object.getOwnPropertyDescriptor(request, "httpVersion")?.value as unknown;
            if (major === 2 || version === "2" || version === "2.0") return http2;
            return missing;
        },
    });
    ownedMappers.add(mapper);
    return mapper;
}