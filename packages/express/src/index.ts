import type { Request, RequestHandler } from "express";
import {
    createHttpAgentSig,
    type AgentSigContext,
    type HttpAgentSigOptions,
} from "@agentsig/core/http";

type Identity = { readonly thumbprint: string };
type View = AgentSigContext<Identity>;
const contexts = new WeakMap<object, () => View>();

declare global {
    namespace Express {
        interface Request {
            readonly agentsig?: View;
        }
    }
}

/** Consult private association, never a caller-replaced request slot. */
export function getAgentSig(request: Request): View {
    const read = contexts.get(request);
    if (!read) throw new Error("AgentSig context is unavailable");
    return read();
}

/**
 * Install before body parsers and application side effects. The application's
 * Node listener MUST be created through options.mapper before Express dispatch.
 */
export function agentSig<I extends Identity>(options: HttpAgentSigOptions<I>): RequestHandler {
    const integration = createHttpAgentSig(options);
    return async (request, response, next): Promise<void> => {
        try {
            if (!contexts.has(request) && "agentsig" in request) {
                throw new Error("AgentSig context conflict");
            }
            const outcome = await integration.assess(request, "express");
            const existing = contexts.get(request);
            if (!existing) {
                contexts.set(request, () => integration.get(request));
                Object.defineProperty(request, "agentsig", {
                    enumerable: false, configurable: false,
                    get: () => getAgentSig(request),
                });
            }
            if (outcome.action === "respond") {
                response.statusCode = outcome.responseStatus!;
                if (outcome.retryAfterSeconds !== undefined) {
                    response.setHeader("Retry-After", String(outcome.retryAfterSeconds));
                }
                response.end();
                return;
            }
        } catch {
            // No raw exception/cause enters Express's default logging pipeline.
            if (!response.headersSent) {
                response.statusCode = 500;
                response.end();
            } else response.destroy();
            return;
        }
        // Application errors belong to Express; do not mislabel them as agentsig.
        next();
    };
}