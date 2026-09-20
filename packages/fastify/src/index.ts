import type { FastifyInstance, FastifyRequest } from "fastify";
import {
    createHttpAgentSig,
    type AgentSigContext,
    type HttpAgentSigOptions,
} from "@agentsig/core/http";

type Identity = { readonly thumbprint: string };
type View = AgentSigContext<Identity>;
const contexts = new WeakMap<object, () => View>();
const installations = new WeakSet<object>();

declare module "fastify" {
    interface FastifyRequest {
        readonly agentsig: View;
    }
}

/** Private association is authoritative, not a replaceable decorator value. */
export function getAgentSig(request: FastifyRequest): View {
    const read = contexts.get(request);
    if (!read) throw new Error("AgentSig context is unavailable");
    return read();
}

/**
 * Install directly on an instance before declaring protected routes, or within
 * an explicitly scoped registration containing those routes. The serverFactory
 * must create its HTTP/1.1 listener through the same options.mapper.
 */
export async function agentSigPlugin<I extends Identity>(
    instance: FastifyInstance,
    options: HttpAgentSigOptions<I>,
): Promise<void> {
    const integration = createHttpAgentSig(options);
    if (!installations.has(instance)) {
        if (instance.hasRequestDecorator("agentsig")) {
            throw new Error("AgentSig context conflict");
        }
        instance.decorateRequest("agentsig", {
            getter(this: FastifyRequest) { return getAgentSig(this); },
        });
        installations.add(instance);
    }
    instance.addHook("onRequest", async (request, reply) => {
        try {
            const outcome = await integration.assess(request.raw, "fastify");
            if (!contexts.has(request)) contexts.set(request, () => integration.get(request.raw));
            if (outcome.action === "respond") {
                reply.code(outcome.responseStatus!);
                if (outcome.retryAfterSeconds !== undefined) {
                    reply.header("Retry-After", String(outcome.retryAfterSeconds));
                }
                return reply.send();
            }
        } catch {
            // Do not pass raw exceptions to Fastify's logger/error serialization.
            return reply.code(500).send();
        }
    });
}