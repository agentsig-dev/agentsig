import type { IncomingMessage, RequestListener } from "node:http";
import type { ServerOptions as HttpsServerOptions } from "node:https";
import type { Context, MiddlewareHandler } from "hono";
import { getRequestListener } from "@hono/node-server";
import type { HttpBindings } from "@hono/node-server";
import {
    createHttpAgentSig,
    type AgentSigContext,
    type HttpAgentSigOptions,
} from "@agentsig/core/http";

type Identity = { readonly thumbprint: string };
type View = AgentSigContext<Identity>;
const contexts = new WeakMap<object, () => View>();
// Shared only inside this adapter module; compatible factory instances may
// consume the same owned conversion without trusting public bindings or headers.
const incomingRequests = new WeakMap<object, IncomingMessage>();

declare module "hono" {
    interface ContextVariableMap {
        readonly agentsig: View;
    }
}

/** The replaceable Hono context variable is never authoritative evidence. */
export function getAgentSig(context: Context): View {
    const read = contexts.get(context);
    if (!read) throw new Error("AgentSig context is unavailable");
    return read();
}

export interface HonoApplication {
    fetch(request: Request, bindings: HttpBindings): Response | Promise<Response>;
}

/**
 * Node-only bridge. Use both middleware and the owned server factory; standalone
 * app.request()/Fetch-only runtimes cannot establish the private request binding.
 */
export function agentSig<I extends Identity>(options: HttpAgentSigOptions<I>) {
    const integration = createHttpAgentSig(options);
    const observer = options.onEvent;

    const middleware: MiddlewareHandler = async (context, next) => {
        try {
            const incoming = incomingRequests.get(context.req.raw);
            if (!incoming) throw new Error("AgentSig capture is unavailable");
            // Check this installation even when another compatible middleware has
            // already published the context. A conflicting factory cannot reuse it.
            integration.get(incoming);
            if (!contexts.has(context)) {
                if (context.get("agentsig") !== undefined) throw new Error("AgentSig context conflict");
                // Assessment/enforcement already ran before conversion. This getter
                // consults private core ownership, never a returned mutable copy.
                integration.get(incoming);
                contexts.set(context, () => integration.get(incoming));
            }
            context.set("agentsig", getAgentSig(context));
        } catch {
            return new Response(null, { status: 500 });
        }
        await next();
    };

    function listener(application: HonoApplication): RequestListener {
        if (!application || typeof application.fetch !== "function") {
            throw new TypeError("Invalid Hono application");
        }
        const fetch = application.fetch.bind(application);
        return (incoming, outgoing) => {
            void (async () => {
                const outcome = await integration.assess(incoming, "hono");
                if (outcome.action === "respond") {
                    outgoing.statusCode = outcome.responseStatus!;
                    if (outcome.retryAfterSeconds !== undefined) {
                        outgoing.setHeader("Retry-After", String(outcome.retryAfterSeconds));
                    }
                    outgoing.end();
                    return;
                }

                let converted = false;
                let reported = false;
                const conversionFailed = (): Response => {
                    if (!reported) {
                        reported = true;
                        const assessment = outcome.context.assessment;
                        const mapping = assessment.status === "mapped"
                            ? Object.freeze({ status: "mapped" as const })
                            : Object.freeze({ status: "mapping-rejected" as const, code: assessment.code });
                        try {
                            observer?.(Object.freeze({
                                type: "framework-conversion-failed", adapter: "hono", mapping,
                            }));
                        } catch { /* No observer failure may alter the empty 400. */ }
                    }
                    return new Response(null, { status: 400 });
                };

                // Per-request closure identifies conversion failure before callback
                // entry without reading or retaining the raw upstream exception.
                const convert = getRequestListener(async (request) => {
                    converted = true;
                    incomingRequests.set(request, incoming);
                    try {
                        return await fetch(request, { incoming, outgoing });
                    } catch {
                        // Application failures are not conversion failures. Never
                        // forward their raw exception to node-server logging paths.
                        return new Response(null, { status: 500 });
                    }
                }, {
                    overrideGlobalObjects: false,
                    autoCleanupIncoming: false,
                    errorHandler: () => converted
                        ? new Response(null, { status: 500 }) : conversionFailed(),
                });
                await convert(incoming, outgoing);
            })().catch(() => {
                if (!outgoing.headersSent) {
                    outgoing.statusCode = 500;
                    outgoing.end();
                } else outgoing.destroy();
            });
        };
    }

    return Object.freeze({
        middleware,
        createServer(application: HonoApplication) {
            return integration.mapper.createServer(listener(application));
        },
        createSecureServer(application: HonoApplication, tls: HttpsServerOptions) {
            return integration.mapper.createSecureServer(listener(application), tls);
        },
    });
}