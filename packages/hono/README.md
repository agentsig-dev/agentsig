# @agentsig/hono

Unpublished M4 development package. Requires the repository's unpublished
@agentsig/core/http API, Hono 4.13.8 and @hono/node-server 2.1.1.
Not security-reviewed; no production-readiness claim. Node HTTP/1.1 only.

## Installation boundary

Build the workspace before using this package. Published core 0.1.1 does not
contain the required HTTP API. Package versions and workspace dependencies are
development metadata pending the separately authorized M4 0.2.0 preparation.
Both ESM and CommonJS exports are provided. Use one module format consistently.

Create a long-lived core verifier and mapper in application-owned configuration.
Install both the middleware and its owned Node server bridge:

```js
import { Hono } from "hono";
import { createNodeHttpMapper } from "@agentsig/core/http";
import { agentSig, getAgentSig } from "@agentsig/hono";

const app = new Hono();
const mapper = createNodeHttpMapper({
    ingress: { allowedOrigins: ["https://merchant.example"] },
});
const bridge = agentSig({
    mapper,
    verifier: applicationVerifier,
    mode: "enforce",
    policy(assessment, tools) {
        // Replace this deny policy with the application's authorization policy.
        // Verification alone is never permission.
        return tools.deny();
    },
});
app.use("*", bridge.middleware);
app.get("/", c => {
    const state = getAgentSig(c);
    return c.json({ authorization: state.authorization.status });
});
const server = bridge.createSecureServer(app, applicationTlsOptions);
server.listen(443);
```

The application supplies its verifier, TLS material, access policy and lifecycle.
Do not wrap this middleware in the ordinary node-server serve function instead
of the owned bridge. Fetch-only/edge runtimes and standalone app.request calls
cannot establish capture. No artificial URL or normalized-header fallback exists.
Global Request/Response replacement and automatic incoming-body cleanup in the
Node bridge are disabled explicitly.

The bridge runs the shared assessment after Node capture and **before conversion**.
Enforcement rejection sends the response before Hono dispatch or conversion.
Successful conversion binds the exact Fetch request privately to its original
Node request. The middleware publishes the readonly assessment in c.get("agentsig").
Use getAgentSig(c) for authoritative ownership checks: replacing the public slot
cannot forge authentication or authorization. Repeated compatible installation
does not verify again or consume another nonce. Conflicting setup fails closed.

## Observation and conversion limits

In observe mode, mapping errors are reported and verification is skipped; Hono
continues with mapping-rejected context only when its Node bridge can convert
the request. **Observation continuation is guaranteed only for requests Hono
can convert.** Express/Fastify do not have this Node-to-Fetch conversion boundary
(their own parsers/routers may still reject requests independently).

Concrete tested example:

- Allowed origin: http://[2001:db8::1]:8443
- Received Host: [2001:DB8:0:0:0:0:0:1]:8443
- Received target: /

The mapper correctly accepts that explicitly allowed numeric origin and preserves
the raw authority spelling as http://[2001:DB8:0:0:0:0:0:1]:8443/. No repair occurs.
The pinned Hono Node buildUrl check rejects the expanded spelling after its
WHATWG URL parser compresses the hostname. The rejection is a **Hono conversion
restriction**, not invalid mapper input. Real loopback TCP tests reproduce it.

Conversion failure returns an empty 400 and emits framework-conversion-failed
with adapter hono and only mapping status/code. It adds no mapping error code.
No Hono context or verification result is published to a handler in that case.
The pre-conversion assessment may already have verified and consumed a nonce;
conversion failure does not roll back replay state. Retrying a signed request
does not prove that an earlier operation did not occur.

## Policy, trust and diagnostics

The shared core policy offers allowVerified(ownedVerifiedAssessment),
allowAnonymous(), deny() and rateLimit(optionalSeconds). Decisions are bound to
one invocation. Mapping failures in enforcement can only deny/rate-limit.
Policy throws, invalid decisions and timeout (default 1,000 ms) deny; late decisions
cannot revive the request. Response defaults are mapping denial 400, ordinary
policy denial 401 and rate-limit 429, configurable through core options. Bodies
contain no reason codes. Integration failures return an empty 500.

Every mapping rejection sends a sanitized observer event with code, adapter and
ingress mode. Observer callbacks are synchronous; enqueue sanitized events rather
than performing I/O. Throws cannot change the decision. Deferred observer work
and general application/framework error logging remain application responsibilities.
The adapter does not sanitize arbitrary application response streams or Hono's
own onError handler. Never forward raw headers, errors, keys or nonces to logs.

Direct mode does not trust forwarding headers. Trusted ingress requires explicit
peer IP/CIDR rules, allowed external origins, sanitizing-ingress assertion and
HTTPS, with one selected forwarding family. Loopback is not proxy process identity.
observedClient is always an unauthenticated hint, never an authorization decision.

bodyIntegrity is always "unverified". Enforcement rejects framed bodies unless
bodyPolicy: "allow-unverified" is explicitly selected. No body hashing/comparison
is provided. This is not payload/payment integrity. HTTP/2, upgrades and trailers
are outside the integration contract. Node parser rejections before capture are
not observed by the adapter.

## Evidence

Independent fixtures precede implementation. Real local listener tests cover
ordered raw mapping, observation/enforcement, duplicate installation, both profile
verification/replay chains and the three conversion outcomes. TLS tests explicitly
trust a public test certificate and retain hostname checks. They are not live
Cloudflare acceptance, a remote CI result or a security audit. Compatibility is
limited to the exact peer versions; broader ranges require review and tests.

MIT. Test fixtures and private test keys are not shipped.