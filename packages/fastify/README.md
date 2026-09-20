# @agentsig/fastify

> **Status: 0.2.0 versioned locally; publication pending; not security-reviewed.**

## Install after publication

```sh
npm install @agentsig/fastify@0.2.0 @agentsig/core@0.2.0 fastify@5.12.5
```

Until publication, use the built workspace. The command above does not imply
that 0.2.0 is already available.

## Ten-line runnable local example

Expected output: 401. This unsigned loopback request demonstrates explicit denial,
not successful authentication. The key and plaintext listener are demonstration
infrastructure only.

```js
import { generateKeyPairSync } from "node:crypto";
import { createOfflineVerifier } from "@agentsig/core/profiles";
import { createNodeHttpMapper } from "@agentsig/core/http";
import Fastify from "fastify";
import { agentSigPlugin } from "@agentsig/fastify";
const { publicKey } = generateKeyPairSync("ed25519");
const verifier = createOfflineVerifier({ jwks: { keys: [publicKey.export({ format: "jwk" })] }, scope: "example" }), mapper = createNodeHttpMapper({ ingress: { allowedOrigins: ["http://127.0.0.1:18882"] } });
const app = Fastify({ serverFactory: listener => mapper.createServer(listener) }); await agentSigPlugin(app, { mapper, verifier, mode: "enforce", policy: (_a, tools) => tools.deny() });
app.get("/", async () => "ok"); await app.listen({ port: 18882, host: "127.0.0.1" });
try { const response = await fetch("http://127.0.0.1:18882/"); console.log(response.status); await response.arrayBuffer(); } finally { app.server.closeAllConnections(); await app.close(); }
```

Version 0.2.0 for Fastify 5.12.5 and Node HTTP/1.1.
Requires exactly @agentsig/core 0.2.0; Fastify remains a pinned peer dependency.
Not security-reviewed. ESM/CommonJS and declarations are provided; use one module
format consistently. Broader framework peer ranges are not claimed.

## Owned server factory and hook scope

Create a long-lived application-owned verifier and mapper. Fastify's onRequest
hook is too late to capture the target before rewriteUrl. The serverFactory must
create the listener through the same mapper used by the plugin.

```js
import Fastify from "fastify";
import { createNodeHttpMapper } from "@agentsig/core/http";
import { agentSigPlugin, getAgentSig } from "@agentsig/fastify";

const mapper = createNodeHttpMapper({
    ingress: { allowedOrigins: ["https://merchant.example"] },
});
const app = Fastify({
    serverFactory: listener =>
        mapper.createSecureServer(listener, applicationTlsOptions),
});
await agentSigPlugin(app, {
    mapper,
    verifier: applicationVerifier,
    mode: "enforce",
    policy(assessment, tools) {
        // Supply application authorization; verification alone is not permission.
        return tools.deny();
    },
});
app.get("/", async request => {
    const state = getAgentSig(request);
    return { authorization: state.authorization.status };
});
await app.listen({ port: 443 });
```

The application supplies verifier, TLS material, policy and lifecycle. Install
directly before declaring protected routes as above, or in a registration scope
containing those routes. Ordinary Fastify encapsulation applies: registering a
plugin in a child scope does not protect sibling routes. No implicit
fastify-plugin skip-encapsulation behavior is introduced.

Do not use inject() as proof of early capture: it does not establish the owned
real-listener boundary. A request without that capture cannot silently fall back
to raw.url, normalized headers or trustProxy getters. Dispatch according to the
bound external target or a declared fixed ingress-to-application mapping; a later
tenant/query rewrite must not change what the authenticated identity authorizes.

## Context and authorization

request.agentsig is a getter backed by private per-request association, not a shared
mutable prototype assessment. getAgentSig(request) throws if initialization is
missing. A replaced public slot cannot forge owned enforcement evidence.
Compatible repeat installation shares one verification/policy operation; a nonce
is not consumed again. Conflicting configuration fails without re-verification.

Observe mode publishes mapping failures, skips verification and continues with
authorization not-evaluated. Count and investigate these events before enforcement.
Observation is not protection. Fastify has no Node-to-Fetch conversion boundary
like Hono's; Node parsing and Fastify routing can still reject independently.

Enforce mode requires an explicit policy using invocation-owned tools:
allowVerified(ownedVerifiedAssessment), allowAnonymous(), deny(), and
rateLimit(optionalSeconds). Mapping failure permits only deny/rate-limit.
Policy exceptions, invalid decisions and timeout (default 1,000 ms) deny.
Late decisions cannot revive requests; consumed nonces are never rolled back.

Default configurable statuses are mapping denial 400, ordinary policy denial 401,
and rate-limit 429. Default bodies are empty and disclose no reason codes.
Integration errors return empty 500 responses without forwarding raw errors to
Fastify logging/serialization. Downstream application errors remain application-owned.
Sanitized mapping events carry code, adapter and ingress mode only. Synchronous
observer throws are contained; deferred logging work is application responsibility.

## Trust and body limits

Direct mode ignores forwarding claims for trust. Trusted ingress requires explicit
socket peer IP/CIDR rules, allowed origins, sanitizing-ingress assertion and HTTPS.
Only one selected forwarding family is accepted. Loopback also trusts local
processes able to connect; it does not authenticate a specific reverse proxy.
observedClient is always an unauthenticated hint, not a library access decision.

bodyIntegrity is always "unverified". Enforcement rejects framed bodies by default;
bodyPolicy: "allow-unverified" explicitly permits identity-only traffic. The adapter
does not hash, buffer, read or drain request bodies. A signed digest header is not
verified payload integrity. HTTP/2, upgrades and trailers are outside scope.
Parser rejection before capture is not claimed as an adapter-observed event.

## Evidence and development

Real local TCP/TLS tests cover pre-rewrite capture, shared raw expectations, context
ownership, observation/enforcement, policy failures, duplicate installation and both
profiles' full verification/replay chains. TLS certificate and hostname validation
remain enabled. These tests are not live Cloudflare acceptance, remote CI evidence
or a security audit.

Build the workspace before running the root adapter integration tests. The
coordinated Changeset is consumed and disk metadata is 0.2.0. The maintainer
accepted M4 after its smoke passed; package publication remains pending.

MIT. Test fixtures and private test keys are not shipped.