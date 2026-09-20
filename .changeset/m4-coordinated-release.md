---
"@agentsig/core": minor
"@agentsig/fetch": minor
"@agentsig/hono": minor
"@agentsig/fastify": minor
"@agentsig/express": minor
---

Prepare the coordinated 0.2.0 release of the core and four integration packages.

Core adds the previously unpublished discovery and Redis APIs, bounded directory
admission and TLS transport, shared cache/replay coordination, and the new HTTP
entry point with owned Node HTTP/1.1 capture, explicit trusted ingress mapping,
a separate frozen mapping error catalog, and shared verification/policy ownership.

The Fetch package signs fresh owned requests using their final serialized values.
It requires manual redirects, rejects existing signature headers before overrides,
defaults to body rejection and HTTPS, and supports explicitly trusted injected
transports and a narrowly scoped loopback HTTP test option. One signing operation
and one transport invocation do not guarantee one wire transmission: native Fetch
can resend after HTTP 421.

The Express, Fastify and Node-only Hono packages provide thin adapters with
readonly context views, separate observation/enforcement modes, invocation-bound
authorization decisions, sanitized diagnostics, policy timeouts, and compatible
duplicate-installation handling without repeated replay consumption. Framework
peer ranges are limited to reviewed and tested versions.

Hono assesses before Node-to-Fetch conversion. Observation can continue only for
requests its Node bridge can convert; a valid expanded IPv6 Host may pass mapping
but fail Hono conversion, producing an empty 400 and a separate sanitized event.
Express and Fastify have no corresponding Fetch-conversion boundary.

Body integrity remains unverified; signed digest headers do not authenticate
payload bytes. Inbound HTTP/2, upgrades and trailer signatures are unsupported.
Existing verification, signing and operator catalogs are unchanged. Redis
durability/failover limits and deployment-specific proxy trust remain documented.

This is unpublished release preparation, not production-readiness or security
audit evidence. Maintainer-run adapter smoke and publication remain separate gates.
The Structured Fields package remains at 0.1.1.