import assert from "node:assert/strict";
import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { startPublicDiscoveryHarness } from "../tests/helpers/public-discovery-harness.mjs";

// MAINTAINER-RUN ONLY. Build the workspace first. Never included in CI or npm.
// Real local TLS and full directory authentication; no Redis. Process-local DNS
// and an explicit CONNECT proxy route the directory's numeric public pin locally.
// The injected application transport below routes signed HTTPS requests to local
// listeners with explicit test CA and hostname validation. It is not evidence of
// native Fetch routing, public reachability, or live Cloudflare acceptance.
const resolveFrom = name => createRequire(new URL(`../packages/${name}/package.json`, import.meta.url));
const resolver = resolveFrom("express");
const esm = (from, name) => import(pathToFileURL(from.resolve(name).replace(/\.cjs$/, ".js")).href);

async function main() {
    const { createNodeHttpMapper } = await esm(resolver, "@agentsig/core/http");
    const { createWebBotAuthSigner } = await esm(resolver, "@agentsig/core/profiles");
    const { createNetworkVerifier } = await esm(resolver, "@agentsig/core/discovery");
    const { createSignedFetch } = await esm(resolveFrom("fetch"), "@agentsig/fetch");
    const expressAdapter = await esm(resolver, "@agentsig/express");
    const fastifyAdapter = await esm(resolveFrom("fastify"), "@agentsig/fastify");
    const honoAdapter = await esm(resolveFrom("hono"), "@agentsig/hono");
    const express = resolver("express");
    const Fastify = resolveFrom("fastify")("fastify");
    const { Hono } = resolveFrom("hono")("hono");
    const tlsRoot = new URL("../tests/fixtures/m3-contract/tls/", import.meta.url);
    const cert = readFileSync(new URL("server-cert.pem", tlsRoot));
    const key = readFileSync(new URL("server-key.pem", tlsRoot));
    const hostname = "directory.agentsig.test";
    const privateKey = createPrivateKey(readFileSync(new URL(
        "../tests/fixtures/m2/generated/public-test-private.pem", import.meta.url,
    )));
    const h = await startPublicDiscoveryHarness();
    const signer = createWebBotAuthSigner({
        privateKey, agentOrigin: h.origin, allowTestKeys: true,
    });
    console.log("smoke/setup/test-only DNS and explicit CONNECT routing; real local TLS; injected request transport; no Redis");

    // Only bodyless owned requests enter this repository-only transport.
    function transport(port, ingress, capture) {
        return async input => {
            assert(input instanceof Request);
            assert.equal(input.redirect, "manual");
            assert.equal(input.body, null);
            const target = new URL(input.url);
            assert.equal(target.protocol, "https:");
            const saved = {
                url: input.url, method: input.method,
                headers: [...input.headers],
            };
            capture?.(saved);
            return new Promise((resolve, reject) => {
                const headers = Object.fromEntries(saved.headers);
                // Explicit test ingress rewrites only local Host. Forwarded fields
                // retain the signed external origin; no signature repair occurs.
                headers.host = ingress ? "internal.agentsig.test" : target.host;
                const outgoing = httpsRequest({
                    hostname: "127.0.0.1", port, servername: hostname, ca: cert,
                    method: saved.method, path: target.pathname + target.search,
                    headers, agent: false, ALPNProtocols: ["http/1.1"],
                }, response => {
                    const chunks = [];
                    let size = 0;
                    response.on("data", chunk => {
                        size += chunk.length;
                        if (size > 65536) response.destroy(new Error("Smoke response limit"));
                        else chunks.push(chunk);
                    });
                    response.on("error", reject);
                    response.on("end", () => resolve(new Response(Buffer.concat(chunks), {
                        status: response.statusCode,
                    })));
                });
                outgoing.setTimeout(10000, () => outgoing.destroy(new Error("Smoke transport timeout")));
                outgoing.on("error", reject);
                outgoing.end();
            });
        };
    }

    async function run(framework, ingress = false) {
        const origin = ingress ? "https://merchant.example" : `https://${hostname}`;
        const mapper = createNodeHttpMapper({
            ingress: ingress ? {
                mode: "trusted-ingress", family: "x-forwarded",
                allowedOrigins: [origin], trustedPeers: ["127.0.0.1/32"],
                sanitizingIngress: true,
            } : { allowedOrigins: [origin] },
        });
        const network = createNetworkVerifier({
            scope: `smoke-adapters-${framework}-${ingress ? "ingress" : "direct"}`,
            allowTestKeys: true, discovery: { network: h.network },
        });
        let latestVerification;
        let verificationCalls = 0;
        let handlerCalls = 0;
        const mappingEvents = [];
        const options = {
            mapper, mode: "enforce",
            verifier: {
                async verify(parts) {
                    verificationCalls++;
                    latestVerification = await network.verify(parts);
                    return latestVerification;
                }
            },
            onEvent(event) {
                if (event.type === "mapping-rejected") mappingEvents.push(event.code);
            },
            policy(assessment, tools) {
                return assessment.status === "mapped" && assessment.verification.status === "verified"
                    ? tools.allowVerified(assessment) : tools.deny();
            },
        };
        let server;
        let shutdown;
        const success = state => {
            assert.deepEqual(state.authorization, { status: "allowed", basis: "verified-identity" });
            assert.equal(state.assessment.verification.status, "verified");
            assert.equal(state.assessment.verification.verifiedCandidates[0].identity.trustSource, "directory-https");
            handlerCalls++;
        };
        if (framework === "express") {
            const app = express();
            app.use(expressAdapter.agentSig(options));
            app.get("/items", (request, response) => {
                success(expressAdapter.getAgentSig(request));
                response.status(200).end();
            });
            server = mapper.createSecureServer(app, { key, cert });
        } else if (framework === "fastify") {
            const app = Fastify({
                logger: false,
                serverFactory: listener => mapper.createSecureServer(listener, { key, cert }),
            });
            await fastifyAdapter.agentSigPlugin(app, options);
            app.get("/items", async (request, reply) => {
                success(fastifyAdapter.getAgentSig(request));
                return reply.code(200).send();
            });
            await app.ready();
            server = app.server;
            shutdown = () => app.close();
        } else {
            const app = new Hono();
            const bridge = honoAdapter.agentSig(options);
            app.use("*", bridge.middleware);
            app.get("/items", context => {
                success(honoAdapter.getAgentSig(context));
                return new Response(null, { status: 200 });
            });
            server = bridge.createSecureServer(app, { key, cert });
        }
        try {
            await new Promise((resolve, reject) => {
                server.once("error", reject);
                server.listen(0, "127.0.0.1", resolve);
            });
            const port = server.address().port;
            let saved;
            const sendOnce = transport(port, ingress, value => { saved = value; });
            const signedFetch = createSignedFetch({ signer, fetch: sendOnce });
            const input = `${origin}/items`;
            const init = ingress ? {
                headers: {
                    "X-Forwarded-Host": "merchant.example",
                    "X-Forwarded-Proto": "https",
                    "X-Forwarded-For": "198.51.100.7",
                },
            } : {};
            const initial = await signedFetch(input, init);
            assert.equal(initial.status, 200);
            assert.equal(handlerCalls, 1);
            assert.equal(verificationCalls, 1);
            assert.equal(network.context.memoryRecords, 1);
            console.log(`${framework}/${ingress ? "d" : "a"}/allow-verified 200 directory-https`);

            const replay = transport(port, ingress);
            if (ingress) {
                // Same signed request and nonce; only the unsigned client hint is
                // made ambiguous. Mapping must fail before verification/replay.
                const headers = new Headers(saved.headers);
                headers.set("X-Forwarded-For", "198.51.100.7, 198.51.100.8");
                const rejected = await replay(new Request(saved.url, {
                    method: saved.method, headers, redirect: "manual",
                }));
                assert.equal(rejected.status, 400);
                assert.equal(await rejected.text(), "");
                assert.deepEqual(mappingEvents, ["forwarding-chain-rejected"]);
                assert.equal(verificationCalls, 1);
                assert.equal(handlerCalls, 1);
                assert.equal(network.context.memoryRecords, 1);
                console.log("express/e/forwarding-chain-rejected 400 verification-not-run");
            } else {
                // Never invoke signedFetch for a replay: that would issue a fresh nonce.
                const repeated = await replay(new Request(saved.url, {
                    method: saved.method, headers: saved.headers, redirect: "manual",
                }));
                assert.equal(repeated.status, 401);
                assert.equal(await repeated.text(), "");
                assert.equal(latestVerification.reason, "replay-detected");
                assert.equal(handlerCalls, 1);
                assert.equal(network.context.memoryRecords, 1);
                console.log(`${framework}/b/replay-detected 401`);

                const anonymous = await replay(new Request(input, { redirect: "manual" }));
                assert.equal(anonymous.status, 401);
                assert.equal(await anonymous.text(), "");
                assert.equal(latestVerification.status, "unsigned");
                assert.equal(handlerCalls, 1);
                assert.equal(verificationCalls, 3);
                console.log(`${framework}/c/policy-deny 401 unsigned`);
            }
        } finally {
            server.closeAllConnections();
            try { await shutdown?.(); }
            finally {
                if (server.listening) await new Promise((resolve, reject) =>
                    server.close(error => error ? reject(error) : resolve()));
            }
        }
    }

    try {
        for (const framework of ["express", "fastify", "hono"]) await run(framework);
        await run("express", true);
        assert.equal(h.requests, 4);
        assert.deepEqual(h.connectTargets, Array(4).fill("1.1.1.1:443"));
        console.log("smoke/complete/PASS local listeners and directory authentication; not public routing or security review");
    } finally { await h.close(); }
}

main().catch(() => {
    // Do not expose headers, nonce, key material, raw assertions or infrastructure errors.
    console.error("smoke/failure/FAIL");
    process.exitCode = 1;
});