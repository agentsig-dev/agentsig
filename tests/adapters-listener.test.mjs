import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { connect as connectTls } from "node:tls";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";

const requireExpress = createRequire(new URL("../packages/express/package.json", import.meta.url));
const requireFastify = createRequire(new URL("../packages/fastify/package.json", import.meta.url));
const requireHono = createRequire(new URL("../packages/hono/package.json", import.meta.url));
const esm = (resolver, name) => import(pathToFileURL(resolver.resolve(name).replace(/\.cjs$/, ".js")).href);
// Resolve every package through the workspace links. Mixing direct file URLs
// with resolved URLs can instantiate a second ESM registry on Windows (c:/ vs C:/).
const { createNodeHttpMapper } = await esm(requireExpress, "@agentsig/core/http");
const { createOfflineVerifier, createWebBotAuthSigner } = await esm(requireExpress, "@agentsig/core/profiles");
const expressAdapter = await esm(requireExpress, "@agentsig/express");
const fastifyAdapter = await esm(requireFastify, "@agentsig/fastify");
const honoAdapter = await esm(requireHono, "@agentsig/hono");
const fastify = requireFastify("fastify");
const { Hono } = requireHono("hono");
const tlsRoot = new URL("./fixtures/m3-contract/tls/", import.meta.url);
const tls = {
    key: readFileSync(new URL("server-key.pem", tlsRoot)),
    cert: readFileSync(new URL("server-cert.pem", tlsRoot)),
};
const mappingFixture = JSON.parse(readFileSync(new URL("./fixtures/m4-http/mapping-cases.json", import.meta.url)));
const conversionFixture = JSON.parse(readFileSync(new URL("./fixtures/m4-hono-conversion/cases.json", import.meta.url)));
const unsigned = { status: "unsigned", reason: "no-signature", candidates: [] };
const kinds = ["express4", "express5", "fastify", "hono"];
const testServers = new Set();

async function start(kind, {
    secure = false,
    ingress = { allowedOrigins: [secure ? "https://merchant.example" : "http://merchant.example"] },
    mode = "observe", policy, duplicate = false, rewrite = false,
    verifier = { async verify() { return unsigned; } },
    onEvent, handler, extra = {}, omit = false, conflicting = false,
} = {}) {
    const mapper = createNodeHttpMapper({ ingress });
    const contexts = [];
    const seenRequests = [];
    let verifierCalls = 0;
    let handlerCalls = 0;
    let conversionCalls = 0;
    let failure;
    const options = {
        mapper, mode,
        verifier: {
            async verify(request) {
                verifierCalls++;
                seenRequests.push(request);
                return verifier.verify(request);
            }
        },
        ...(mode === "enforce" ? { policy: policy ?? ((_a, tools) => tools.deny()) } : {}),
        ...(onEvent === undefined ? {} : { onEvent }), ...extra,
    };
    const observe = (native, read, slot) => {
        handlerCalls++;
        try {
            if (omit) {
                assert.throws(() => read(native), /context is unavailable/);
            } else {
                const context = read(native);
                contexts.push(context);
                assert.deepEqual(slot(), context);
                handler?.(native, read, slot);
            }
        } catch (error) { failure = error; }
    };
    let server;
    let close;
    if (kind.startsWith("express")) {
        const express = requireExpress(kind === "express4" ? "express4" : "express");
        const app = express();
        if (rewrite) app.use((req, _res, next) => { req.url = "/rewritten"; next(); });
        if (!omit) {
            app.use(expressAdapter.agentSig(options));
            if (duplicate) app.use(expressAdapter.agentSig(options));
            if (conflicting) app.use(expressAdapter.agentSig({
                ...options, mode: "enforce", policy: (_a, tools) => tools.deny(),
            }));
        }
        app.use((req, res) => {
            observe(req, expressAdapter.getAgentSig, () => req.agentsig);
            res.statusCode = 204;
            res.end();
        });
        server = secure ? mapper.createSecureServer(app, tls) : mapper.createServer(app);
    } else if (kind === "fastify") {
        const app = fastify({
            logger: false,
            ...(rewrite ? { rewriteUrl: () => "/rewritten" } : {}),
            serverFactory: listener => secure
                ? mapper.createSecureServer(listener, tls) : mapper.createServer(listener),
        });
        if (!omit) {
            await fastifyAdapter.agentSigPlugin(app, options);
            if (duplicate) await fastifyAdapter.agentSigPlugin(app, options);
            if (conflicting) await fastifyAdapter.agentSigPlugin(app, {
                ...options, mode: "enforce", policy: (_a, tools) => tools.deny(),
            });
        }
        app.all("/*", async (req, reply) => {
            observe(req, fastifyAdapter.getAgentSig, () => req.agentsig);
            return reply.code(204).send();
        });
        await app.ready();
        server = app.server;
        close = () => app.close();
    } else {
        const app = new Hono();
        const bridge = honoAdapter.agentSig(options);
        if (!omit) {
            app.use("*", bridge.middleware);
            if (duplicate) app.use("*", honoAdapter.agentSig(options).middleware);
            if (conflicting) app.use("*", honoAdapter.agentSig({
                ...options, mode: "enforce", policy: (_a, tools) => tools.deny(),
            }).middleware);
        }
        app.all("*", context => {
            observe(context, honoAdapter.getAgentSig, () => context.get("agentsig"));
            return new Response(null, { status: 204 });
        });
        const application = {
            fetch(request, bindings) {
                conversionCalls++;
                return app.fetch(request, bindings);
            },
        };
        server = secure ? bridge.createSecureServer(application, tls) : bridge.createServer(application);
    }
    // Keep the peer open while asynchronous middleware settles. For fixture
    // requests without Connection: close, bound idle keep-alive during teardown.
    server.keepAliveTimeout = 1;
    testServers.add(server);
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    async function send(wire) {
        const response = await new Promise((resolve, reject) => {
            const socket = secure
                ? connectTls({
                    host: "127.0.0.1", port: server.address().port,
                    ca: tls.cert, servername: "directory.agentsig.test",
                    ALPNProtocols: ["http/1.1"],
                })
                : connect(server.address().port, "127.0.0.1");
            let received = "";
            socket.setEncoding("latin1");
            socket.setTimeout(5000, () => socket.destroy(new Error("Adapter test timeout")));
            socket.on("error", reject);
            socket.on("data", chunk => { received += chunk; });
            socket.on("close", () => resolve(received));
            socket.once(secure ? "secureConnect" : "connect", () => {
                if (secure) assert.equal(socket.authorized, true);
                socket.write(Buffer.from(wire, "latin1"));
            });
        });
        if (failure) throw failure;
        const end = response.indexOf("\r\n\r\n");
        assert(end >= 0, "Complete response headers are required");
        const head = response.slice(0, end);
        const framed = response.slice(end + 4);
        let body = framed;
        if (/^transfer-encoding:\s*chunked\s*$/im.test(head)) {
            let position = 0;
            body = "";
            for (; ;) {
                const lineEnd = framed.indexOf("\r\n", position);
                assert(lineEnd >= position, "Complete chunk size is required");
                const sizeText = framed.slice(position, lineEnd);
                assert.match(sizeText, /^[0-9a-f]+$/i);
                const size = Number.parseInt(sizeText, 16);
                position = lineEnd + 2;
                if (size === 0) {
                    assert.equal(framed.slice(position), "\r\n", "Unexpected trailers or trailing data");
                    break;
                }
                assert(position + size + 2 <= framed.length, "Complete chunk data is required");
                body += framed.slice(position, position + size);
                position += size;
                assert.equal(framed.slice(position, position + 2), "\r\n");
                position += 2;
            }
        }
        return { status: Number(response.match(/^HTTP\/1\.1 (\d+)/)?.[1]), body, head };
    }
    return {
        mapper, contexts, seenRequests, send,
        get verifierCalls() { return verifierCalls; },
        get handlerCalls() { return handlerCalls; },
        get conversionCalls() { return conversionCalls; },
        async close() {
            server.closeAllConnections();
            try {
                if (close) await close();
            } finally {
                // This harness calls server.listen directly, not Fastify.listen.
                // Close the listener we own even if framework shutdown skipped it.
                if (server.listening) {
                    await new Promise((resolve, reject) =>
                        server.close(error => error ? reject(error) : resolve()));
                }
                testServers.delete(server);
            }
        },
    };
}

after(async () => {
    const leaked = [...testServers];
    await Promise.all(leaked.map(server => new Promise(resolve => {
        server.closeAllConnections();
        server.close(() => resolve());
    })));
    assert.equal(leaked.length, 0, "Every test-owned listener must be closed");
});

const simple = "GET / HTTP/1.1\r\nHost: merchant.example\r\nConnection: close\r\n\r\n";
for (const kind of kinds) {
    test(`${kind}: identical independent raw TLS request maps to identical ordered fields and target`, async () => {
        const entry = mappingFixture.positive[0];
        const app = await start(kind, { secure: true, rewrite: kind !== "hono" });
        try {
            assert.equal((await app.send(entry.wireLatin1)).status, 204);
            assert.equal(app.handlerCalls, 1);
            assert.equal(app.verifierCalls, 1);
            assert.deepEqual(app.seenRequests[0], entry.expected.request);
            assert.deepEqual(app.contexts[0].assessment.request, entry.expected.request);
            assert.equal(app.contexts[0].authorization.status, "not-evaluated");
            assert.equal(app.contexts[0].assessment.bodyIntegrity, "unverified");
        } finally { await app.close(); }
    });

    test(`${kind}: compatible duplicate installation verifies once and context cannot forge authorization`, async () => {
        const app = await start(kind, {
            duplicate: true,
            handler(native, read) {
                const before = read(native);
                if (kind === "hono") {
                    native.set("agentsig", { authorization: { status: "allowed" } });
                } else {
                    assert.throws(() => { native.agentsig = { authorization: { status: "allowed" } }; }, TypeError);
                }
                assert.deepEqual(read(native), before);
            },
        });
        try {
            assert.equal((await app.send(simple)).status, 204);
            assert.equal(app.verifierCalls, 1);
            assert.equal(app.handlerCalls, 1);
            assert.equal((await app.send(simple)).status, 204);
            assert.equal(app.verifierCalls, 2);
            assert.notEqual(app.contexts[0], app.contexts[1]);
        } finally { await app.close(); }
    });

    for (const mode of ["observe", "enforce"]) {
        test(`${kind}: mapping rejection in ${mode} has no verifier or reason-bearing response`, async () => {
            const events = [];
            const app = await start(kind, { mode, onEvent: event => events.push(event) });
            try {
                const response = await app.send(simple.replace("merchant.example", "other.example"));
                assert.equal(response.status, mode === "observe" ? 204 : 400);
                assert.equal(response.body, "");
                assert.equal(app.verifierCalls, 0);
                assert.equal(app.handlerCalls, mode === "observe" ? 1 : 0);
                assert.deepEqual(events, [{
                    type: "mapping-rejected", code: "origin-disallowed",
                    adapter: kind.startsWith("express") ? "express" : kind, ingress: "direct",
                }]);
                if (mode === "observe") assert.deepEqual(app.contexts[0].assessment, {
                    status: "mapping-rejected", code: "origin-disallowed", bodyIntegrity: "unverified",
                });
                if (kind === "hono" && mode === "enforce") assert.equal(app.conversionCalls, 0);
            } finally { await app.close(); }
        });
    }

    for (const decision of ["deny", "rate-limit", "throw", "timeout", "anonymous"]) {
        test(`${kind}: ${decision} policy enacts one response without fall-through`, async () => {
            const app = await start(kind, {
                mode: "enforce", extra: { policyTimeoutMilliseconds: 20 },
                policy(_assessment, tools) {
                    if (decision === "throw") throw new Error("Must not appear in response");
                    if (decision === "timeout") return new Promise(() => { });
                    if (decision === "rate-limit") return tools.rateLimit(7);
                    if (decision === "anonymous") return tools.allowAnonymous();
                    return tools.deny();
                },
            });
            try {
                const response = await app.send(simple);
                assert.equal(response.status, decision === "anonymous" ? 204 : decision === "rate-limit" ? 429 : 401);
                assert.equal(response.body, "");
                assert.equal(app.handlerCalls, decision === "anonymous" ? 1 : 0);
                if (decision === "rate-limit") assert.match(response.head, /retry-after: 7/i);
            } finally { await app.close(); }
        });
    }

    test(`${kind}: trusted peer single occurrence accepted; comma chain and mixed families rejected`, async () => {
        const events = [];
        const app = await start(kind, {
            mode: "enforce",
            ingress: {
                mode: "trusted-ingress", family: "x-forwarded",
                allowedOrigins: ["https://merchant.example"], trustedPeers: ["127.0.0.1/32"],
                sanitizingIngress: true
            },
            policy: (_a, tools) => tools.allowAnonymous(),
            onEvent: event => { events.push(event); throw new Error("Observer must be isolated"); },
        });
        const base = "GET / HTTP/1.1\r\nHost: internal.example\r\nX-Forwarded-Host: merchant.example\r\n" +
            "X-Forwarded-Proto: https\r\nX-Forwarded-Port: 443\r\nConnection: close\r\n";
        try {
            assert.equal((await app.send(base + "X-Forwarded-For: 198.51.100.1\r\n\r\n")).status, 204);
            assert.deepEqual(app.contexts[0].assessment.observedClient, {
                kind: "ip", address: "198.51.100.1", source: "trusted-ingress", authenticated: false,
            });
            assert.equal((await app.send(base + "X-Forwarded-For: 198.51.100.1, 198.51.100.2\r\n\r\n")).status, 400);
            assert.equal((await app.send(base + "Forwarded: host=merchant.example;proto=https\r\n\r\n")).status, 400);
            assert.equal(app.verifierCalls, 1);
            assert.equal(app.handlerCalls, 1);
            assert.deepEqual(events.map(event => event.code),
                ["forwarding-chain-rejected", "forwarding-families-mixed"]);
        } finally { await app.close(); }
    });

    test(`${kind}: conflicting second installation fails without another verification`, async () => {
        const app = await start(kind, { conflicting: true });
        try {
            const response = await app.send(simple);
            assert.equal(response.status, 500);
            assert.equal(response.body, "");
            assert.equal(app.verifierCalls, 1);
            assert.equal(app.handlerCalls, 0);
        } finally { await app.close(); }
    });

    test(`${kind}: framed GET body is rejected unless identity-only acceptance is explicit`, async () => {
        for (const bodyPolicy of ["reject", "allow-unverified"]) {
            const app = await start(kind, {
                mode: "enforce", extra: { bodyPolicy },
                policy: (_a, tools) => tools.allowAnonymous(),
            });
            try {
                const response = await app.send(
                    "GET / HTTP/1.1\r\nHost: merchant.example\r\nContent-Length: 1\r\nConnection: close\r\n\r\nx",
                );
                assert.equal(response.status, bodyPolicy === "reject" ? 401 : 204);
                assert.equal(app.handlerCalls, bodyPolicy === "reject" ? 0 : 1);
                assert.equal(response.body, "");
                if (app.contexts.length) assert.equal(app.contexts[0].assessment.bodyIntegrity, "unverified");
            } finally { await app.close(); }
        }
    });

    test(`${kind}: missing middleware getter fails rather than fabricating unsigned`, async () => {
        const app = await start(kind, { omit: true });
        try { assert.equal((await app.send(simple)).status, 204); }
        finally { await app.close(); }
    });

    for (const profile of ["ietf-wg-protocol-00", "cloudflare-docs-2026-07-01"]) {
        test(`${kind}: full ${profile} verification, authorization and replay over real TLS`, async () => {
            const { privateKey, publicKey } = generateKeyPairSync("ed25519");
            const verifier = createOfflineVerifier({
                jwks: { keys: [publicKey.export({ format: "jwk" })] }, scope: `listener-${kind}-${profile}`,
            });
            const signer = createWebBotAuthSigner({ privateKey, profile, agentOrigin: "https://agent.example" });
            const app = await start(kind, {
                secure: true, mode: "enforce", duplicate: true, verifier,
                policy(assessment, tools) {
                    return assessment.status === "mapped" && assessment.verification.status === "verified"
                        ? tools.allowVerified(assessment) : tools.deny();
                },
            });
            try {
                const headers = await signer.sign({ method: "GET", targetUri: "https://merchant.example/", headers: [] });
                const wire = "GET / HTTP/1.1\r\nHost: merchant.example\r\nConnection: close\r\n" +
                    headers.map(([name, value]) => `${name}: ${value}\r\n`).join("") + "\r\n";
                assert.equal((await app.send(wire)).status, 204);
                assert.equal(app.verifierCalls, 1);
                assert.equal(verifier.context.memoryRecords, 1);
                assert.deepEqual(app.contexts[0].authorization, { status: "allowed", basis: "verified-identity" });
                assert.equal((await app.send(wire)).status, 401);
                assert.equal(app.verifierCalls, 2);
                assert.equal(app.handlerCalls, 1);
                assert.equal(verifier.context.memoryRecords, 1);
            } finally { await app.close(); }
        });
    }
}

for (const entry of conversionFixture.cases) {
    test(`hono conversion fixture over real TCP: ${entry.id}`, async () => {
        const events = [];
        const app = await start("hono", {
            mode: entry.mode, ingress: { allowedOrigins: entry.allowedOrigins },
            onEvent: event => events.push(event),
        });
        try {
            const response = await app.send(entry.wireLatin1);
            assert.equal(response.status, entry.expected.responseStatus);
            assert.equal(app.verifierCalls, entry.expected.verifierCalls);
            assert.equal(app.handlerCalls, entry.expected.handlerCalls);
            assert.equal(app.conversionCalls, entry.expected.convertedRequests);
            assert.equal(app.contexts.length > 0, entry.expected.contextPublished);
            assert.deepEqual(events.filter(event => event.type === "framework-conversion-failed"),
                entry.expected.conversionEvents);
            if (entry.expected.responseBody !== undefined) assert.equal(response.body, entry.expected.responseBody);
            if (entry.expected.targetUri) assert.equal(app.seenRequests[0].targetUri, entry.expected.targetUri);
        } finally { await app.close(); }
    });
}