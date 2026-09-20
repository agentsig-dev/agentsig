# agentsig

[![npm: @agentsig/core](https://img.shields.io/npm/v/@agentsig/core.svg?label=%40agentsig%2Fcore)](https://www.npmjs.com/package/@agentsig/core)
[![npm: @agentsig/structured-fields](https://img.shields.io/npm/v/@agentsig/structured-fields.svg?label=%40agentsig%2Fstructured-fields)](https://www.npmjs.com/package/@agentsig/structured-fields)

> **Status: pre-release; 0.2.0 versioned locally, publication pending; M4 accepted; not security-reviewed**

Open-source HTTP Message Signatures and Web Bot Auth tooling for Node.js.

agentsig provides a profile-independent RFC 9421 Ed25519 engine, a separate
RFC 9651 Structured Fields package, and signing/verification for two pinned Web
Bot Auth profiles. Published **0.1.1** supports offline verification with trusted
local public JWKS, explicit identity bindings, time policies, and memory replay.

This checkout additionally implements bounded HTTPS directory discovery, shared
cache/admission coordination, an optional Redis replay adapter, and owned Node
HTTP/1.1 mapping with Express, Fastify and Hono integrations, and signed Fetch.
These additions are **not in published 0.1.1**. The coordinated Changeset has been
consumed: core, fetch, Hono, Fastify and Express are versioned at **0.2.0** locally.
Structured Fields remains **0.1.1**. The maintainer accepted M4 after all eleven
adapter smoke scenarios passed and confirmed core-m4 and green CI. Publication
of 0.2.0 remains pending; milestone acceptance is not a security audit.

This project is not security-reviewed and does not claim production readiness,
IETF endorsement, or Cloudflare reference-implementation status. “Pre-release”
describes maturity; a version such as 0.1.1 has no SemVer prerelease suffix.

## Install

Requires Node 20+. Use a Node release that still receives security updates.

```sh
npm install @agentsig/core
```

For the standalone Structured Fields parser/serializer:

```sh
npm install @agentsig/structured-fields
```

Both packages provide ESM, CommonJS, and declarations for both module formats.
The core package depends on @agentsig/structured-fields; neither package uses
an external cryptographic implementation.

## Quick start

This ten-line ESM example signs and verifies locally without making an HTTP
request. Expected output: `verified replay-detected`.

```js
import { generateKeyPairSync } from "node:crypto";
import { createWebBotAuthSigner, createOfflineVerifier } from "@agentsig/core/profiles";
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const jwks = { keys: [publicKey.export({ format: "jwk" })] };
const signer = createWebBotAuthSigner({ privateKey, agentOrigin: "https://agent.example" });
const verifier = createOfflineVerifier({ jwks, scope: "example" });
const request = { method: "GET", targetUri: "https://merchant.example/items", headers: [] };
const headers = await signer.sign(request);
const signed = { ...request, headers: [...request.headers, ...headers] };
console.log((await verifier.verify(signed)).status, (await verifier.verify(signed)).reason);
```

Use persistent, trusted key management in a real application; the ephemeral key
above is for demonstration. Keep the verifier/security context long-lived.
Creating one per request discards replay history. The default verified identity
is a key thumbprint, not proof of domain ownership or authorization.

See the [offline verification guide](docs/offline-verification.md),
[core API](packages/core/README.md), and
[Structured Fields API](packages/structured-fields/README.md).

## Why agentsig?

Node HTTP-signature engines and TypeScript Web Bot Auth packages already exist.
agentsig is not the first. Its focus is pinned profiles, independently sourced
golden fixtures, explicit trust boundaries, default atomic replay checks, and
Node's built-in cryptography. Network discovery, signed Fetch and Node-only
framework adapters are implemented in this unpublished checkout; CLI remains future work.

The [source-based comparison](docs/core-api-proposal.md) records the versions and
documentation examined. It is not a security audit or performance comparison.

## Why this is not stealth tooling

agentsig helps clients identify themselves through signatures. It does not
change browser fingerprints, solve CAPTCHAs, evade bot detection, automate
browsers, or bypass access rules.

A valid signature does not prove good intent, a real-world operator's identity,
or permission to access a resource. Binding a key to an operator and deciding
whether to allow a request remain application responsibilities.

## How it differs from rate limiting

Signature verification answers which key signed the covered request components.
Rate limiting decides how frequently an identity or client may act. A valid
signature does not grant a rate-limit exemption.

A short signature lifetime narrows a replay window but does not prevent replay
by itself. The profile API adds clock and nonce checks; the pure RFC engine does
not. Explicit optional-nonce mode can accept a nonce-less signature, but reports
that the accepted candidate is not replay-protected.

## Packages and milestones

| Package | Checkout version / release state | Current scope |
| --- | --- | --- |
| @agentsig/structured-fields | 0.1.1; published, unchanged | Lossless RFC 9651 AST, semantic model, parsing/serialization and resource limits |
| @agentsig/core | 0.2.0; publication pending | RFC 9421 engine, offline profiles, discovery, Redis and HTTP subpaths |
| @agentsig/fetch | 0.2.0; publication pending | Signed Fetch; manual redirects, explicit transport/body policy, no wrapper retry |
| @agentsig/hono | 0.2.0; publication pending | Node HTTP/1.1 bridge, assessment and policy integration |
| @agentsig/fastify | 0.2.0; publication pending | Early-capture integration and policy hook |
| @agentsig/express | 0.2.0; publication pending | Express 4/5 middleware with owned early capture |
| agentsig (CLI) | Planned; not implemented | Future command-line tooling |

- **M1:** RFC 9421 Ed25519 engine, Structured Fields package, independent fixture audit.
- **M2:** accepted offline profile verification, time/replay integration, and dual-format consumers.
  The user confirmed green CI/fixture workflows for **core-m2** and successful
  two-profile smoke verification in commit **08592a2**.
- **M3 checkout:** full network verification, bounded directory cache/transport,
  shared cross-profile admission, and Redis replay/recovery. Public APIs live at
  @agentsig/core/discovery and @agentsig/core/redis; the pure and offline entries
  do not load discovery transport. The maintainer accepted M3 after its smoke
  and core-m3 tag; this was not an npm publication.
- **M4 accepted:** signed Fetch, shared HTTP mapping and three thin Node adapters, with
  independent fixtures and real local listener tests. See the
  [HTTP guide](docs/http-mapping.md) and adapter READMEs:
  [Express](packages/express/README.md), [Fastify](packages/fastify/README.md),
  [Hono](packages/hono/README.md). Verification is not authorization; body
  integrity remains unverified. Hono observation has a documented conversion boundary.
  The [Fetch guide](packages/fetch/README.md) distinguishes one transport call from
  exactly-once network delivery. The maintainer confirmed all eleven adapter smoke
  scenarios passed, including Express forwarding-chain rejection before verification.
  The coordinated 0.2.0 Changeset is consumed; publication remains maintainer-owned.
- **Next:** maintainer 0.2.0 publication, CLI, and publisher-signed directory responses
  (mandatory Cloudflare-profile M5 work). See the [M3 design record](docs/milestone-3-plan.md)
  and [deferred work](docs/deferred.md).

The GitHub organization is **agentsig-dev**; the npm organization is **agentsig**.
Repository: https://github.com/agentsig-dev/agentsig

## Protocol compatibility

The following compares pinned source requirements, not a claim of complete
draft conformance or acceptance by Cloudflare's live services. The implemented
M2 profiles use stricter local coverage, origin, time, and replay policies.

| Topic | IETF WG protocol-00 | Cloudflare documentation profile | Sources |
| --- | --- | --- | --- |
| Signature-Agent wire form | Dictionary member keyed to the signature label | Quoted Structured String; Dictionary form rejected | [WG §5.2.1](https://www.ietf.org/archive/id/draft-ietf-webbotauth-httpsig-protocol-00.html#section-5.2.1), [CF §4.3](https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/#43-construct-the-required-headers) |
| Agent coverage | Corresponding Dictionary member | Entire header | [WG §5.2.1](https://www.ietf.org/archive/id/draft-ietf-webbotauth-httpsig-protocol-00.html#section-5.2.1), [CF §4.3](https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/#43-construct-the-required-headers) |
| Target coverage | At least authority or target URI | At least authority recommended | [WG §5.2](https://www.ietf.org/archive/id/draft-ietf-webbotauth-httpsig-protocol-00.html#section-5.2), [CF §4.1](https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/#41-choose-a-set-of-components-to-sign) |
| Nonce | No additional requirement | Recommended; documentation states no nonce replay tracking | [WG §5.2.3](https://www.ietf.org/archive/id/draft-ietf-webbotauth-httpsig-protocol-00.html#section-5.2.3), [CF §4.3](https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/#43-construct-the-required-headers) |
| Lifetime | At most 24 hours recommended | Short lifetime; one minute usually sufficient | [WG §5.2](https://www.ietf.org/archive/id/draft-ietf-webbotauth-httpsig-protocol-00.html#section-5.2), [CF §4.3](https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/#43-construct-the-required-headers) |
| Directory response signatures | Appendix B can be omitted for basic URL identity; proof covers authority and content-digest | Response signature requested for each key used | [WG Appendix B](https://www.ietf.org/archive/id/draft-ietf-webbotauth-httpsig-protocol-00.html#appendix-B), [CF §2](https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/#2-host-a-key-directory) |
| Key identity | Base64url SHA-256 JWK thumbprint | JWK thumbprint | [WG §5.2](https://www.ietf.org/archive/id/draft-ietf-webbotauth-httpsig-protocol-00.html#section-5.2), [CF §4.2](https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/#42-calculate-the-jwk-thumbprint) |
| Authorization / Verified Bot status | No authorization or operator reputation implied | Separate registration and approval required | [WG §4](https://www.ietf.org/archive/id/draft-ietf-webbotauth-httpsig-protocol-00.html#section-4), [CF §3](https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/#3-register-your-bot-and-key-directory) |

The default signer profile is **ietf-wg-protocol-00** (September 1, 2026 draft).
The **cloudflare-docs-2026-07-01** signer profile requires explicit selection.
Sources were retrieved on September 18, 2026; Cloudflare's source was pinned
before implementation at commit **acfb1f2270b9473ae65a15674995e0b2f3b6ab0c**.

There is no automatic downgrade or retry under another grammar. Verification
reports each candidate's profile; applications may restrict accepted profiles.
Both local profiles require method, complete target URI, and profile-specific
agent coverage, with nonce protection enabled by default.

Cloudflare's research server, production Verified Bots service, and the WG draft
are separate compatibility targets. Illustrative signatures are not treated as
cryptographic golden vectors. No live Cloudflare acceptance test has been run.
The E.2.1 label/member discrepancy is tracked in
[upstream issue #135](https://github.com/webbotauth/draft-ietf-webbotauth-httpsig-protocol/issues/135);
original fixture bytes remain unchanged.

## Development and tests

Use pnpm 10.12.1. Development tools require Node 20.19+ or 22.12+; Node 24 is also
targeted. Runtime compatibility does not promise security support for EOL Node.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run check
```

The full check builds all workspace packages, checks types, and runs unit, golden,
property, real adapter listener, consumer, and fixture-integrity tests. Additional commands:

- `pnpm run test:unit` — unit/golden/property tests.
- `pnpm run test:integration` — built-package and fixture-integrity tests.
- `pnpm run audit:fixtures` — independent RFC → fixture → Node crypto audit.
- `pnpm run test:fixtures` — fixture byte and Git line-ending checks.
- `pnpm run test:watch` — watch package tests.
- `pnpm --filter @agentsig/core test` — package-local core tests.
- `pnpm --filter @agentsig/structured-fields test` — package-local SF tests.

Build before standalone tests or type checks on a fresh checkout: core consumes
the built Structured Fields package. See [fixture provenance](docs/fixture-provenance.md).
Golden expectations precede implementation in separate commits; they are not
regenerated from production code to make tests pass.

The maintainer-run network smoke is intentionally separate from automated checks:

```sh
pnpm run build
node scripts/smoke-fetch.mjs
```

It uses memory replay only, needs no Redis, and waits 30.1 seconds for the normal
origin cooldown. The three scenarios are: full verified acceptance after fetching
a key; private DNS destination rejection before CONNECT/GET with an unverified
result; and unknown-key after a second fetch removes that key. The test-only DNS
answers and explicit local HTTPS proxy route numeric pin 1.1.1.1:443 to loopback.
Real nested TLS and certificate identity checks remain enabled. This is not proof
of public routing or direct observation of the proxy's remote peer. Run it as a
standalone process; no production private-IP exception or system DNS/CA change
is introduced. See the [core documentation](packages/core/README.md) for details.

The separate adapter acceptance smoke was run successfully by the maintainer:

```sh
pnpm run build
node scripts/smoke-adapters.mjs
```

It uses memory replay, a local directory and sequential real framework listeners.
For each framework it checks signed allow-verified/200, exact signed-request
replay/401 and unsigned policy-deny/401; Express additionally checks trusted ingress
acceptance and comma-chain mapping rejection/400. Output uses one
framework/scenario/result line per case. The maintainer reported eleven passing
scenarios and smoke/complete/PASS; the assistant did not execute the smoke.
Its injected request transport and explicit directory
CONNECT routing are test-only; real TLS hostname/certificate checks remain enabled.
It does not prove native Fetch routing, public reachability or live Cloudflare acceptance.

The [CI matrix](.github/workflows/ci.yml) targets Node 20/22/24 on Windows/Linux.
The [fixture workflow](.github/workflows/fixtures.yml) runs on every PR without
path filtering and fetches full history for historical fixture-commit checks.
Past green results are not evidence that later commits passed remote CI.

## Security, release, and license

The unpublished M3 discovery API defaults to origin allow-list admission. Explicit
open mode retains destination filtering, numeric pinning, TLS, redirect rejection,
and resource limits. Limits are shared per security context, not process-global or
distributed. Keep compatible verifier contexts long-lived. Directory HTTPS identity
does not establish operator reputation, authorization, or publisher-signed proof.
Body-digest comparison, countersignatures and CLI remain outside this
implementation. Actual body verification is mandatory before 1.0. The unpublished
adapters default to rejecting framed bodies in enforcement, with explicit
identity-only opt-in. Live Cloudflare acceptance is unproven.

The initial Redis adapter performs **O(n) scans and bounded state-document
rewrites**, capped at 10,000 records and 32 MiB of encoded state. Full-capacity
performance is unproven. **Redis Cluster routing, actual restart/failover,
replication rollback, and OOM behavior are not established by the tests.**
A shared hash slot and noeviction policy do not prove durability or linearizability.
Valid-looking partial history loss may escape detection; arbitrary distributed
clock jumps remain an operational risk. Explicit recovery horizon and shared
quarantine are required, with no retry or memory fallback.

Never use published fixture private keys in production. Memory replay state is
process-local; restart or explicit destructive clock reset loses that history.
This project has not undergone an independent security audit.

Releases are performed manually by the maintainer; no automatic publishing
workflow is included. Documentation and packaging work does not itself publish
a package or push commits.

Project code is [MIT licensed](LICENSE). RFC and HTTP WG fixture material retains
its original copyright and license notices; see [provenance](docs/fixture-provenance.md).