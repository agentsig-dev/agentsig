# @agentsig/core

[![npm](https://img.shields.io/npm/v/@agentsig/core.svg)](https://www.npmjs.com/package/@agentsig/core)

> **Status: pre-release; offline verifier only, no network discovery; not security-reviewed**

Framework-independent RFC 9421 HTTP Message Signatures and offline Web Bot Auth
verification for Node 20+. Ed25519 uses Node's built-in cryptography. The only
runtime dependency is @agentsig/structured-fields.

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

## Two separate entry points

| Entry point | Responsibility |
| --- | --- |
| @agentsig/core | Pure RFC 9421 parsing, canonicalization, signing, and cryptographic verification |
| @agentsig/core/profiles | Profile signing, offline verification, trusted local public JWKS loading, shared clock/replay context |

The pure engine has no clock, network, trust-resolution, or replay side effects.
The profile layer combines those local authentication policies, but does not
fetch directories or validate request bodies.

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
| Network discovery and directory cache | Not implemented |

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

See [provenance](https://github.com/agentsig-dev/agentsig/blob/main/docs/fixture-provenance.md).
CI targets Node 20/22/24 on Windows/Linux. A workflow definition or past green run
does not prove that a later change passed every matrix cell.

## License

MIT for project code. Third-party test fixtures retain their own notices and are
not included in the npm package.