import { get } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpAgentSig } from "../src/http/assessment.js";
import { createNodeHttpMapper } from "../src/http/node-mapper.js";
import type { HttpAdapterOutcome, HttpAgentSigOptions, HttpPolicyDecision, HttpPolicyTools } from "../src/http/assessment-types.js";
import type { VerificationResult } from "../src/profiles/verification-types.js";
import { createOfflineVerifier } from "../src/profiles/verifier.js";
import { createWebBotAuthSigner } from "../src/profiles/signer.js";

const servers: Server[] = [];
afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close(error => error ? reject(error) : resolve());
    })));
});
const unsigned: VerificationResult = { status: "unsigned", reason: "no-signature", candidates: [] };
const mapperOptions = { ingress: { allowedOrigins: ["http://merchant.example"] } };

async function serve(handler: (request: IncomingMessage) => Promise<void>, mapper = createNodeHttpMapper(mapperOptions)) {
    let failure: unknown;
    const server = mapper.createServer((request, response) => {
        void handler(request).then(() => response.end(), error => {
            failure = error;
            response.statusCode = 500;
            response.end();
        });
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    return async (headers: Record<string, string> = {}): Promise<void> => {
        await new Promise<void>((resolve, reject) => {
            const request = get({
                host: "127.0.0.1", port, path: "/", agent: false,
                headers: { Host: "merchant.example", ...headers },
            }, response => { response.resume(); response.on("end", resolve); });
            request.on("error", reject);
        });
        if (failure) throw failure;
    };
}

describe("shared HTTP authentication/policy ownership", () => {
    it.each(["observe", "enforce"] as const)("never verifies a failed mapping in %s", async mode => {
        const mapper = createNodeHttpMapper(mapperOptions);
        let verifies = 0;
        let policies = 0;
        const events: unknown[] = [];
        const shared = { mapper, verifier: { async verify() { verifies++; return unsigned; } }, onEvent: (event: unknown) => { events.push(event); } };
        const agent = mode === "observe"
            ? createHttpAgentSig({ ...shared, mode })
            : createHttpAgentSig({
                ...shared, mode, policy(assessment, tools) {
                    policies++;
                    expect(assessment.status).toBe("mapping-rejected");
                    expect("verification" in assessment).toBe(false);
                    return tools.allowAnonymous();
                }
            });
        const send = await serve(async request => {
            const outcome = await agent.assess(request, "express");
            expect(outcome.context.assessment).toEqual({
                status: "mapping-rejected", code: "origin-disallowed", bodyIntegrity: "unverified",
            });
            expect(outcome.action).toBe(mode === "observe" ? "continue" : "respond");
            expect(outcome.responseStatus).toBe(mode === "observe" ? undefined : 400);
        }, mapper);
        await send({ Host: "other.example" });
        expect(verifies).toBe(0);
        expect(policies).toBe(mode === "observe" ? 0 : 1);
        expect(events).toEqual([{
            type: "mapping-rejected", code: "origin-disallowed", adapter: "express", ingress: "direct",
        }]);
    });

    it.each(["deny", "rate-limit", "throw", "invalid", "allow-anonymous"] as const)(
        "enacts policy without turning unsigned into verified: %s", async kind => {
            const mapper = createNodeHttpMapper(mapperOptions);
            const agent = createHttpAgentSig({
                mapper, mode: "enforce", verifier: { async verify() { return unsigned; } },
                policy(_assessment, tools) {
                    if (kind === "throw") throw new Error("Private application diagnostic");
                    if (kind === "invalid") return {} as HttpPolicyDecision;
                    if (kind === "rate-limit") return tools.rateLimit(12);
                    if (kind === "allow-anonymous") return tools.allowAnonymous();
                    return tools.deny();
                },
            });
            const send = await serve(async request => {
                const outcome = await agent.assess(request, "fastify");
                expect(outcome.context.assessment).toMatchObject({ verification: unsigned, bodyIntegrity: "unverified" });
                expect(outcome.action).toBe(kind === "allow-anonymous" ? "continue" : "respond");
                expect(outcome.responseStatus).toBe(kind === "allow-anonymous" ? undefined : kind === "rate-limit" ? 429 : 401);
                if (kind === "rate-limit") expect(outcome.retryAfterSeconds).toBe(12);
            }, mapper);
            await send();
        },
    );

    it("times out, aborts the policy signal and rejects a late decision", async () => {
        const mapper = createNodeHttpMapper(mapperOptions);
        let tools: HttpPolicyTools | undefined;
        let finish: ((value: HttpPolicyDecision) => void) | undefined;
        let earlyToken: HttpPolicyDecision | undefined;
        const events: unknown[] = [];
        const agent = createHttpAgentSig({
            mapper, mode: "enforce", policyTimeoutMilliseconds: 5,
            verifier: { async verify() { return unsigned; } },
            onEvent(event) { events.push(event); },
            policy(_assessment, provided) {
                tools = provided;
                earlyToken = provided.allowAnonymous();
                return new Promise(resolve => { finish = resolve; });
            },
        });
        const send = await serve(async request => {
            const result = await agent.assess(request, "hono");
            expect(result.action).toBe("respond");
            expect(result.context.authorization.status).toBe("denied");
            expect(tools!.signal.aborted).toBe(true);
            expect(() => tools!.allowAnonymous()).toThrow("HTTP integration failed");
            finish!(earlyToken!);
            await Promise.resolve();
            expect(agent.get(request).authorization.status).toBe("denied");
        }, mapper);
        await send();
        expect(events).toEqual([{ type: "policy-denied", reason: "timeout", adapter: "hono", ingress: "direct" }]);
    });

    it("counts synchronous policy work against the timeout", async () => {
        const mapper = createNodeHttpMapper(mapperOptions);
        const agent = createHttpAgentSig({
            mapper, mode: "enforce", policyTimeoutMilliseconds: 1,
            verifier: { async verify() { return unsigned; } },
            policy(_assessment, tools) {
                const until = performance.now() + 5;
                while (performance.now() < until) { /* Deliberate test-only blocking callback. */ }
                return tools.allowAnonymous();
            },
        });
        const send = await serve(async request => {
            expect((await agent.assess(request, "express")).action).toBe("respond");
        }, mapper);
        await send();
    });

    it("does not accept another request's decision token", async () => {
        const mapper = createNodeHttpMapper(mapperOptions);
        let firstToken: HttpPolicyDecision | undefined;
        let calls = 0;
        const agent = createHttpAgentSig({
            mapper, mode: "enforce", verifier: { async verify() { return unsigned; } },
            policy(_assessment, tools) {
                calls++;
                return firstToken ??= tools.allowAnonymous();
            },
        });
        const outcomes: HttpAdapterOutcome[] = [];
        const send = await serve(async request => { outcomes.push(await agent.assess(request, "express")); }, mapper);
        await send();
        await send();
        expect(calls).toBe(2);
        expect(outcomes.map(value => value.action)).toEqual(["continue", "respond"]);
    });

    it("shares compatible installation and full verifier replay consumption", async () => {
        const { privateKey, publicKey } = generateKeyPairSync("ed25519");
        const verifier = createOfflineVerifier({ jwks: { keys: [publicKey.export({ format: "jwk" })] }, scope: "http-assessment" });
        const signer = createWebBotAuthSigner({ privateKey, agentOrigin: "https://agent.example" });
        const mapper = createNodeHttpMapper(mapperOptions);
        let verifies = 0;
        const wrapped = {
            async verify(request: Parameters<typeof verifier.verify>[0]) {
                verifies++;
                return verifier.verify(request);
            }
        };
        const options: HttpAgentSigOptions = {
            mapper, mode: "enforce", verifier: wrapped,
            policy(assessment, tools) {
                if (assessment.status === "mapped" && assessment.verification.status === "verified") {
                    return tools.allowVerified(assessment as Parameters<typeof tools.allowVerified>[0]);
                }
                return tools.deny();
            },
        };
        const first = createHttpAgentSig(options);
        const second = createHttpAgentSig(options);
        const outcomes: HttpAdapterOutcome[] = [];
        const send = await serve(async request => {
            const results = await Promise.all([first.assess(request, "express"), second.assess(request, "express")]);
            expect(results[0]).toEqual(results[1]);
            outcomes.push(results[0]!);
        }, mapper);
        const headers = Object.fromEntries(await signer.sign({
            method: "GET", targetUri: "http://merchant.example/", headers: [],
        }));
        await send(headers);
        expect(verifies).toBe(1);
        expect(verifier.context.memoryRecords).toBe(1);
        expect(outcomes[0]!.context.authorization).toEqual({ status: "allowed", basis: "verified-identity" });
        await send(headers);
        expect(verifies).toBe(2);
        expect(outcomes[1]!.context.assessment).toMatchObject({ verification: { status: "invalid", reason: "replay-detected" } });
        expect(outcomes[1]!.action).toBe("respond");
    });

    it("rejects conflicting installation before another verification", async () => {
        const mapper = createNodeHttpMapper(mapperOptions);
        let verifies = 0;
        const verifier = { async verify() { verifies++; return unsigned; } };
        const first = createHttpAgentSig({ mapper, mode: "observe", verifier });
        const second = createHttpAgentSig({ mapper, mode: "enforce", verifier, policy: (_a, tools) => tools.deny() });
        const send = await serve(async request => {
            await first.assess(request, "express");
            expect(() => second.assess(request, "express")).toThrow("HTTP integration failed");
            expect(() => second.get(request)).toThrow("HTTP integration failed");
        }, mapper);
        await send();
        expect(verifies).toBe(1);
    });

    it("contains observer throws and shares work during synchronous observer reentry", async () => {
        const mapper = createNodeHttpMapper(mapperOptions);
        let incoming: IncomingMessage;
        let eventCount = 0;
        let reentered: Promise<HttpAdapterOutcome> | undefined;
        const agent = createHttpAgentSig({
            mapper, mode: "enforce", verifier: { async verify() { return unsigned; } },
            policy: (_a, tools) => tools.deny(),
            onEvent() {
                eventCount++;
                reentered = agent.assess(incoming, "express");
                throw { private: "must not escape" };
            },
        });
        const send = await serve(async request => {
            incoming = request;
            const result = await agent.assess(request, "express");
            expect(await reentered).toEqual(result);
            expect(result.responseStatus).toBe(400);
        }, mapper);
        await send({ Host: "other.example" });
        expect(eventCount).toBe(1);
    });

    it("does not expose verifier exceptions or fabricate an authentication result", async () => {
        const mapper = createNodeHttpMapper(mapperOptions);
        const events: unknown[] = [];
        const agent = createHttpAgentSig({
            mapper, mode: "observe", onEvent(event) { events.push(event); },
            verifier: { async verify() { throw new Error("secret backend detail"); } },
        });
        const send = await serve(async request => {
            await expect(agent.assess(request, "express")).rejects.toThrow("HTTP integration failed");
            expect(() => agent.get(request)).toThrow("HTTP integration failed");
        }, mapper);
        await send();
        expect(events).toEqual([{ type: "verification-error", adapter: "express", ingress: "direct" }]);
    });

    it("rejects bodies by default even if policy permits anonymous traffic", async () => {
        const mapper = createNodeHttpMapper(mapperOptions);
        const agent = createHttpAgentSig({
            mapper, mode: "enforce", verifier: { async verify() { return unsigned; } },
            policy: (_a, tools) => tools.allowAnonymous(),
        });
        const send = await serve(async request => {
            expect(request.readableDidRead).toBe(false);
            expect((await agent.assess(request, "express")).action).toBe("respond");
            expect(request.readableDidRead).toBe(false);
        }, mapper);
        await send({ "Content-Length": "1" });
    });
});