# @agentsig/core

[![npm](https://img.shields.io/npm/v/@agentsig/core.svg)](https://www.npmjs.com/package/@agentsig/core)

> **Status: pre-release; M3 discovery/Redis APIs in this checkout are unpublished; not security-reviewed**

Framework-independent RFC 9421 HTTP Message Signatures and Web Bot Auth
verification for Node 20+. Ed25519 uses Node's built-in cryptography. The only
runtime dependency is @agentsig/structured-fields.

Published **0.1.1** provides the pure engine and offline profiles. This checkout
adds bounded HTTPS directory discovery and an optional Redis replay adapter;
those additions are not yet available in that npm release. Package version
metadata remains unchanged pending a separately authorized release.

ESM, CommonJS, and declarations for both formats are provided. This package has
not undergone an independent security review and does not claim production
readiness or official IETF/Cloudflare endorsement. “Pre-release” describes
maturity; it is not a SemVer prerelease suffix.

## Install

```sh
npm install @agentsig/core
```

Use a supported Node release that still receives security updates.

## Quick start

This ten-line ESM example makes no network requests. Expected output:
`verified replay-detected`.

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

The ephemeral key is for demonstration. Real applications need persistent,
trusted key management. Keep the verifier/security context long-lived:
creating it per request discards replay history. Preserve that context and scope
when rotating keys. Default success establishes a key thumbprint, not domain
ownership, operator reputation, or authorization.

The same profile subpath is available to CommonJS consumers. See the
[offline verification guide](https://github.com/agentsig-dev/agentsig/blob/main/docs/offline-verification.md)
for configuration and result semantics.

## Separate entry points

| Entry point | Responsibility | Availability |
| --- | --- | --- |
| @agentsig/core | Pure RFC 9421 parsing, canonicalization, signing, and cryptographic verification | Published 0.1.1 |
| @agentsig/core/profiles | Profile signing, offline verification, trusted local public JWKS loading, shared clock/replay context | Published 0.1.1 |
| @agentsig/core/discovery | Bounded HTTPS directory discovery and full network verification | Unpublished M3 checkout |
| @agentsig/core/redis | Optional Redis replay adapter and recovery-horizon helper | Unpublished M3 checkout |

The pure engine has no clock, network, trust-resolution, or replay side effects.
The profile layer combines local authentication policies without loading directory
transport. Discovery is separate from the future @agentsig/fetch outgoing client;
Redis is optional and takes an application-owned client without adding a Redis
runtime dependency. No entry point validates request bodies.

Both module formats have separate declarations. Within either ESM or CommonJS,
shared build chunks preserve security-context and configuration-error identities
across subpaths. Do not mix ESM-created opaque contexts/policies with CommonJS
instances in one process; cross-format interchangeability is not promised.

The default signer profile is **ietf-wg-protocol-00**.
**cloudflare-docs-2026-07-01** requires explicit signer selection.
The verifier recognizes both forms by default and supports an explicit profile
allow-list. It selects one grammar and never retries another after failure.

Both local profiles require method, complete target URI, and profile-specific
agent coverage. This is stricter than the source protocols' minimum coverage.
Known published test keys are denied unless explicitly permitted for testing;
that permission does not bypass any other check.

## Pure engine operations

| Operation | Input | Output |
| --- | --- | --- |
| parseSignatureHeaders | Ordered header occurrences and optional limits | Label-matched signature inputs and bytes |
| createSignatureBase | Message context, signature input, field types, limits | Canonical text and bytes |
| signHttpMessage | Message, signature input, private Ed25519 key | Two signature-header values for one label |
| verifyHttpSignatureCryptography | Message, parsed signature, public Ed25519 key | Cryptographic validity or typed rejection |

Signing and verification return Promises, but currently execute synchronously
on bounded input. This does not imply worker-thread or nonblocking cryptography.
Ed25519 signs the exact base without prehashing, as specified in RFC 9421 §3.3.6.

### Message and key contract

Preserve ordered header tuples and repeated occurrences. Header-name matching is
case-insensitive; covered header component names must be lowercase.

String field values represent ASCII. Use byte arrays and binary-wrapped coverage
for original non-ASCII HTTP octets; the engine never guesses UTF-8 versus Latin-1.
Only explicit HTTP/1.1 context permits obsolete line-fold removal. Remaining
CR/LF characters are rejected during component normalization.

Supply the externally observed absolute HTTP(S) target URI. If covering the raw
request-target, supply it separately; it is not inferred from the URI. Proxy
headers are never trusted automatically. Consistent external URI, raw target,
and header context are the caller's responsibility.

The pure signer takes a private Ed25519 key object; the pure verifier takes a
public one. Key strings are not imported automatically. Declared signature
algorithms must agree with the selected key.

The pure signer returns one label's header values without mutating the message.
Merging them with other signatures is an explicit caller operation. In contrast,
the profile signer rejects any existing Signature, Signature-Input, or
Signature-Agent header, even an empty one.

## Pure engine coverage

| Feature | Support |
| --- | --- |
| Ordered occurrences, OWS, explicit HTTP/1.1 obs-fold | Supported |
| Strict Structured Field serialization and Dictionary member selection | Requires a known field type |
| Separate binary-wrapped encoding of each occurrence | Supported |
| Method, target URI, authority, scheme, path, query | Supported |
| Raw request-target | Requires explicit caller context |
| Individual query parameter | RFC form decoding/encoding; repeated names rejected |
| Response status and related request components | Requires explicit context |
| Multiple signatures | Parsed/verified per label; no automatic acceptance policy |
| Trailers | Explicitly rejected |
| Non-Ed25519 cryptography | Explicitly rejected |
| Unknown derived component or component parameter | Explicitly rejected |
| Unknown signature metadata | Included if its SF type is supported; no inferred semantics |
| Local profile, JWKS, nonce, and clock policy | Separate profile entry point |
| Network discovery and directory cache | Separate unpublished M3 discovery entry point |

Signature metadata and component identifiers use RFC 8941 types; RFC 9651 Date
and Display String extensions are not accepted in those positions. Other known
Structured Fields may use the RFC 9651 implementation. Built-in Dictionary type
information covers signature headers and Content-Digest; callers specify other
field types. Full RFC 9421 feature/algorithm support is not claimed.

## Trust and replay boundaries

Pure cryptographic validity does **not** prove:

- Ownership of a key by an agent, domain, or real-world operator.
- Request freshness, acceptable timestamps, or absence of replay.
- Integrity of uncovered components or the body.
- Agreement between Content-Digest and actual body bytes.
- Authorization, good intent, or exemption from rate limits.

The offline profile verifier adds local identity, coverage, time, and replay
checks. URL identity requires explicit local key-to-origin bindings and reports
local configuration as its trust source, not DNS/TLS or directory proof.

Default candidate policy requires exactly one tagged signature. Multiple tagged
candidates are all evaluated, but ambiguity consumes no nonce. Explicit multiple
mode supports all (default) or any, retaining every candidate's result.
A successful candidate in a failed aggregate does not imply aggregate acceptance.

Replay consumption is atomic and grouped only within one verification invocation.
Independent requests never share acceptance. Memory is process-local and bounded;
live entries are not evicted. Restart or explicit destructive clock reset loses
history and may permit a still-valid old signature again. Optional-nonce mode
only relaxes absence; a present nonce must still pass replay checks.

Any malformed signature pair rejects the entire parsing call, including pairs
with unrelated tags. No signature headers yields an empty parsed array. This is
the local all-pairs contract, not a claim that the RFC mandates rejection of every
unrelated signature in every application.

## Directory verification (unpublished M3)

Use a repository build for this API, not the published 0.1.1 package:

```js
import { createSecurityContext } from "@agentsig/core/profiles";
import { createNetworkVerifier } from "@agentsig/core/discovery";

const context = createSecurityContext(); // Bounded in-memory replay by default.
const verifier = createNetworkVerifier({
    scope: "merchant",
    context,
    discovery: {
        network: { allowedOrigins: ["https://agent.example"] },
    },
});
// Keep verifier/context alive across requests; pass original ordered headers.
export async function authenticate(request) {
    return verifier.verify(request);
}
```

Discovery is deny-by-default unless an origin is allow-listed. Explicit
`discovery.network.mode: "open"` permits other admissible origins, not private
addresses or disabled TLS. Configuration is trusted application input, never
incoming request metadata. Each admitted origin uses the fixed
`/.well-known/http-message-signatures-directory` path. A/AAAA answers are checked
together; one forbidden address rejects the entire answer set. Numeric connection
pinning retains the original Host, SNI, and certificate identity. Special-purpose
address exceptions are named and bounded, not arbitrary CIDR overrides.

Only HTTP 200, identity encoding, the directory media type, bounded UTF-8 JSON,
and a completely validated key set are accepted. There are no redirects, retries,
environment proxies, TLS-disable switches, application transport hooks, or local
key fallback. Custom CAs and HTTPS CONNECT proxies must be explicit. A configured
proxy is trusted infrastructure: target validation still occurs before CONNECT,
but the client cannot observe the proxy's remote peer.

A context owns shared admission across both profiles: 16 active fetches, one per
origin, 64 queued, 32 starts per rolling second, and a 30-second per-origin start
interval. The three-second total deadline includes queueing and document validation.
Each verification may initiate or join at most one fetch. Separate contexts do not
share these limits. Keep one context per compatible trust/enforcement domain.

Freshness defaults to 60 seconds only without explicit freshness and is capped at
300 seconds before age subtraction. Negative backoff defaults to 60 seconds.
Stale evidence never verifies. Successful whole-set replacement, including an
empty set, invalidates removed keys across both profile caches. Final acceptance
rechecks the original thumbprint in the current fresh set after replay awaits;
consumed nonces are not rolled back. Explicit `verifier.refresh(origin, profile)`
uses the same admission, cooldown, and backoff rules; it is not a force-refresh bypass.

A successful identity has trust source `directory-https`: HTTPS origin/key
association, not operator reputation, authorization, or publisher-signed directory
proof. Unusable fresh key evidence yields `unverified / unknown-key`; a fixed
synchronous `discovery.onRefresh` observer provides separate sanitized diagnostics.
Observer exceptions cannot change authentication. Publisher-side signed directory
responses for the Cloudflare profile remain mandatory deferred M5 work; M3 does
not claim that requirement or live Cloudflare acceptance.

## Redis replay and operational limits (unpublished M3)

The optional `createRedisReplayStore` factory takes an application-owned ready
client with automatic retries and offline queueing disabled. Pass the returned
store to `createSecurityContext({ store })`. There is no memory fallback or manual
quarantine release. Setup requires `CONFIG GET maxmemory-policy` to report
`noeviction`; narrowly scoped explicit acknowledgement is possible only when
inspection is denied or unsupported, never to override a reported mismatch.

An explicit positive recovery horizon is mandatory. `recoveryHorizonSeconds()`
returns 360 seconds for the default single-clock policy:
`min(maxAgeSeconds, maxLifetimeSeconds) + 2 * clockSkewSeconds`. Supply the largest
horizon across every verifier sharing the namespace, plus the deployment's bounded
distributed-clock allowance. The adapter cannot establish that assertion for you.
An empty namespace starts shared quarantine, during which consumption is unavailable.

The initial adapter scans and rewrites a bounded state document in **O(n)**,
with at most 10,000 records and 32 MiB of encoded state. Lua prepares a replacement
before a single MSET writes state, epoch, and quarantine. Logical expiration does
not automatically delete idle namespace data. All command boundaries are 100 ms;
timeout means unknown completion, not rollback. Full-capacity throughput/latency
has **not** been established.

The keys share one Redis Cluster hash slot, but **Cluster routing, actual
restart/failover, replication rollback, and OOM behavior are unproven**. Real Redis
service tests and deterministic-time Lua tests do not prove these deployment
properties. `noeviction` is not durability or linearizability. Valid-looking partial
deletion/rollback can evade loss detection; markers cannot detect every lost nonce.
Arbitrary Redis/distributed clock jumps remain an operational risk.

## Resource limits and errors

Core defaults use 16 KiB budgets for headers, URI, Structured Fields, and the
signature base, with separate cardinality limits. These are local policy, not
RFC maxima. Signature field values also have a combined budget. Canonicalization
can expand data; small inputs can still exceed output limits. Signed data is
never truncated to fit.

Each SF call receives explicitly resolved core budgets. Raising limits increases
CPU/memory exposure. Expected rejections have typed reasons; invalid application
configuration throws separately. Unexpected programming errors are not hidden
as ordinary authentication failures.

Diagnostics exclude header contents, key material, and raw backend errors.
Limit errors identify the budget and observed size. The verification, signing,
and operator error catalogs are separately frozen; changes require approval and
release notes.

## Tests and provenance

From a repository checkout, install workspace dependencies and build first:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
pnpm --filter @agentsig/core test
```

The package-local test command runs core unit/golden tests. The repository's
full check also runs type checks and fresh-process ESM/CJS consumers.

Four independent golden suites use RFC 9421 B.1.4/B.2.6 data for parsing,
canonicalization, signing, and verification. Profile fixtures precede their
implementations. Full offline round trips supplement, rather than replace,
independent golden bytes. Fixture files are read as bytes and checked against
pinned hashes and isolated Git line-ending behavior.

The maintainer-run repository smoke is separate from automated tests:

```sh
pnpm run build
node scripts/smoke-fetch.mjs
```

It needs no Redis, uses memory replay, and takes at least 30 seconds to preserve the
real origin cooldown. Expected scenarios: verified after the first fetch; private
DNS destination rejected before CONNECT/GET with unverified/unknown-key; and
unknown-key after a second fetch removes the key. A repository-only DNS override
and explicitly trusted local HTTPS proxy route the public numeric pin to loopback.
Actual nested TLS and authentication remain enabled; this is not public routing or
direct-peer proof. No system DNS/CA or production private-address policy is changed.
Run the script as its own process. Test helpers and public fixture private keys are
not shipped in npm packages and must never be used in production.

See [provenance](https://github.com/agentsig-dev/agentsig/blob/main/docs/fixture-provenance.md).
CI targets Node 20/22/24 on Windows/Linux. A workflow definition or past green run
does not prove that a later change passed every matrix cell.

## License

MIT for project code. Third-party test fixtures retain their own notices and are
not included in the npm package.