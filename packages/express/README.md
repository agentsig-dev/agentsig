# @agentsig/express

Unpublished M4 development package for Express 4.22.3 and 5.2.1, Node HTTP/1.1.
Requires the repository's unpublished @agentsig/core/http API, not npm core 0.1.1.
Not security-reviewed. ESM/CommonJS and declarations are provided; use one module
format consistently. Broader framework peer ranges are not claimed.

## Early installation

Create a long-lived application-owned verifier and a mapper with explicit allowed
external origins. Create the listener through the mapper, not app.listen().
Install the middleware before body parsers, mutating middleware and side effects.

```js
import express from "express";
import { createNodeHttpMapper } from "@agentsig/core/http";
import { agentSig, getAgentSig } from "@agentsig/express";

const app = express();
const mapper = createNodeHttpMapper({
    ingress: { allowedOrigins: ["https://merchant.example"] },
});
app.use(agentSig({
    mapper,
    verifier: applicationVerifier,
    mode: "enforce",
    policy(assessment, tools) {
        // Supply application authorization; verification alone is not permission.
        return tools.deny();
    },
}));
app.get("/", (request, response) => {
    const state = getAgentSig(request);
    response.json({ authorization: state.authorization.status });
});
const server = mapper.createSecureServer(app, applicationTlsOptions);
server.listen(443);
```

The application supplies its verifier, TLS material, policy and server lifecycle.
The mapper captures before Express and mount-path rewrites. request.originalUrl,
hostname/protocol getters and Express trust-proxy settings are not capture proof.
Dispatch according to the bound external target or an explicitly declared fixed
ingress/mount mapping; later tenant/query rewrites cannot silently change what
the authenticated identity is authorizing.

## Context and policy

request.agentsig is an optional readonly getter. getAgentSig(request) checks the
private association and throws if middleware has not initialized it. Replacing
a public slot cannot forge owned authentication or enforcement evidence.
Compatible repeated installation shares one authentication/policy operation and
does not consume a nonce twice; conflicting installation fails closed.

Observe mode publishes mapping failures without verification and continues with
authorization not-evaluated. Count and investigate these failures before enabling
enforcement. Observation is not protection. Unlike Hono, Express has no separate
Node-to-Fetch conversion boundary limiting observation continuation; Node parsing
and Express routing can still reject requests independently.

Enforce mode requires a policy hook using invocation-owned tools:
allowVerified(ownedVerifiedAssessment), allowAnonymous(), deny(), or
rateLimit(optionalSeconds). A valid signature is not implicit permission.
Mapping failures permit only deny/rate-limit; every continuation decision becomes
deny. Policy errors, invalid decisions and timeout (default 1,000 ms) deny.
Late completion cannot revive permission. Consumed nonces are not rolled back.

Default configurable response statuses: mapping denial 400, ordinary policy
denial 401, rate-limit 429. Default bodies are empty and disclose no reason code.
Sanitized mapping observer events contain code, adapter and ingress mode only.
Synchronous observer throws cannot change decisions; deferred work remains the
application's responsibility. Integration errors return an empty 500, without
passing raw exceptions or causes to Express's default error pipeline. Errors from
downstream application handlers remain application-owned.

## Trust and limits

Direct mode ignores forwarding claims for trust. Trusted ingress requires explicit
socket peer IP/CIDR rules, allowed origins, sanitizing-ingress assertion and HTTPS.
Only one configured forwarding family is accepted. Other local processes may
connect from loopback; loopback trust is not authentication of a proxy process.
observedClient is an unauthenticated hint, never an automatic rate-limit exemption.

bodyIntegrity is always "unverified". Framed bodies are denied by default in
enforcement; bodyPolicy: "allow-unverified" is explicit identity-only acceptance.
The adapter does not read, buffer, hash or drain bodies. Signed digest headers
do not authenticate payload bytes. HTTP/2, upgrades and trailers are unsupported.
Parser errors before capture are separate from mapping errors and are not claimed
as adapter-observed requests.

## Evidence and development

Real local TCP/TLS listener tests cover Express 4 and 5, identical independent
raw-request mapping, rewrite timing, context isolation, policy failures, duplicate
installation and both profiles' full verification/replay chains. TLS certificate
and hostname checks remain enabled. These are not live Cloudflare acceptance,
remote CI evidence or a security audit.

Build the workspace, then run the root adapter integration tests. Version 0.0.0
and workspace dependency metadata are development-only pending M4 0.2.0 release
preparation. TypeScript consumers need the Express declarations appropriate to
their application; the adapter's API uses standard request/middleware types.

MIT. Test fixtures and private test keys are not shipped.