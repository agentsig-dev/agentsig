# agentsig — core API proposal

Updated September 19, 2026. The original proposal below is a historical design
record. M1 was implemented and tagged core-m1; §11 compares the original API
proposal with that implementation. Subsequent approvals led to the completed M2
offline verifier, time/replay integration, and ESM/CommonJS profile entry.
The full local round-trip gate passed. Current M2 references:
[offline verification](offline-verification.md) and [M2 plan](milestone-2-plan.md).

## Implementation approval — September 18, 2026

This section takes precedence over conflicting initial proposals below.

- The maintainer approved the first core milestone, including our Structured Fields parser.
- Repository: https://github.com/agentsig-dev/agentsig. npm organization and package names are unchanged.
- The parser is a separate workspace package, @agentsig/structured-fields.
  Core depends on it, not the reverse.
- The SF package owns the raw AST, semantic model, resource limits, RFC 9651
  parser/serializer, and property/fuzz tests.
- Sequence: infrastructure → independent source fixtures and fixture commit →
  Structured Fields → core engine.
- Before library implementation, commit the RFC 9421 B.1.4 key, B.2.6 signature
  base/bytes, and official HTTP WG Structured Fields test suite.
- Pin source version, upstream commit where applicable, content hash, and license.
  Identify RFC publications by RFC number/section/hash, not an invented Git commit.
- Read fixtures as bytes. Never trim canonical values, normalize their line endings,
  or append a final LF automatically.
- Git attributes enforce LF for text fixtures; binary fixtures are exempt.
- Exercise real add/checkout operations in isolated Git repositories under different
  line-ending settings without changing the user's global configuration.
- Report completed work, observed tests, and pending decisions at each major stage.
- CI targets Node 20/22/24 × Windows/Linux. Distinguish local results from unrun cells.
- The first engine delivery excludes profiles, networking, nonce storage, adapters,
  and CLI. No assistant push or package publication.

## 1. Agreed boundaries

Package names: @agentsig/core, @agentsig/fetch, @agentsig/hono,
@agentsig/fastify, @agentsig/express; unscoped CLI: agentsig.

The first milestone is profile-independent RFC 9421 canonicalization and Ed25519
signing/verification with golden and negative tests. Later profiles are pinned:
IETF by default, Cloudflare explicitly selected, without downgrade or silent retry.
Verification recognizes both formats and reports the selected profile; application
policy may disallow a profile.

Both profiles default to required nonce replay checking with a memory store.
Optional policy is explicit and reports unprotected success.
Per-profile defaults: signing lifetime 60 seconds, maximum lifetime/age 300 seconds,
clock skew 30 seconds.

TypeScript, ESM/CJS, Node 20+, pnpm workspaces, Changesets, Vitest, and MIT.
Cryptography uses Node's built-in module with no external crypto dependency.
Publication remains a separate manual maintainer action.

## 2. Package boundaries

| Package | Responsibility | Boundary |
| --- | --- | --- |
| @agentsig/core | RFC 9421 engine; later profiles, JWK/thumbprint, directory/cache, replay, verification policy | No framework dependency or automatic authorization |
| @agentsig/fetch | Sign outgoing requests; explicit profile and key selection | Redirect/retry must not silently transfer a signature to another target |
| @agentsig/hono | Hono request mapping, verification context, policy hook | Do not duplicate crypto/discovery |
| @agentsig/fastify | Hooks, request decoration, policy hook | Do not implicitly widen proxy trust |
| @agentsig/express | Middleware, request context, policy hook | Capture original target before router rewrites |
| agentsig | Key generation, directory output, signed test request, safe debugging | No private-key logging or automatic npm publication |

Dependency direction: adapters/fetch → core; CLI → core/fetch. Core depends on no
adapter. Directory creation and response signing can remain shared in core, with
convenience exports from fetch. Keep the pure engine and future network directory
module in separate entry points. Operator names are supplied by application
mapping, not inferred from cryptography.

## 3. First milestone: historical type-level proposal

These declarations are the original proposal, not the current API. See §11 for
implemented types and justified differences. Ordered header tuples preserve
occurrences; callers are not forced into a Headers object or a plain record.
The target URI represents the externally observed HTTP request. Do not normalize
it arbitrarily before signing or trust Forwarded/X-Forwarded-* automatically.

```ts
import type { KeyObject } from "node:crypto";

export type HeaderField = readonly [name: string, value: string];
export type HeaderFields = readonly HeaderField[];
export type SfBare =
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "token"; readonly value: string }
  | { readonly kind: "integer"; readonly value: number }
  | { readonly kind: "decimal"; readonly thousandths: number }
  | { readonly kind: "date"; readonly epochSeconds: number }
  | { readonly kind: "display-string"; readonly value: string }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "bytes"; readonly value: Uint8Array };
export type SfParameter = readonly [name: string, value: SfBare];
export type Parameters = readonly SfParameter[];

export interface RequestParts {
  readonly method: string;
  readonly targetUri: string;
  readonly rawRequestTarget?: string;
  readonly headers: HeaderFields;
}
export type HttpMessage =
  | { readonly kind: "request"; readonly request: RequestParts }
  | {
      readonly kind: "response";
      readonly status: number;
      readonly headers: HeaderFields;
      readonly request?: RequestParts;
    };
export interface CoveredComponent {
  readonly name: string;
  readonly parameters: Parameters;
}
export interface SignatureInput {
  readonly label: string;
  readonly components: readonly CoveredComponent[];
  readonly parameters: Parameters;
}
export interface ParsedSignature {
  readonly input: SignatureInput;
  readonly signature: Uint8Array;
}
export interface Limits {
  readonly maxSignatureHeaderBytes: number;
  readonly maxSignatures: number;
  readonly maxComponentsPerSignature: number;
  readonly maxParameters: number;
}
export interface CanonicalizationOptions {
  readonly structuredFieldTypes?: Readonly<Record<string, "item" | "list" | "dictionary">>;
}
export interface SignatureBase {
  readonly text: string;
  readonly bytes: Uint8Array;
}
export interface SignatureHeaderPatch {
  readonly label: string;
  readonly signatureInput: string;
  readonly signature: string;
}
export type CryptoVerification =
  | { readonly status: "signature-valid"; readonly input: SignatureInput }
  | {
      readonly status: "rejected";
      readonly reason: "malformed" | "unsupported" | "missing-component" | "invalid-key" | "signature-mismatch";
    };

export declare function parseSignatureHeaders(
  headers: HeaderFields,
  limits: Limits,
): readonly ParsedSignature[];
export declare function createSignatureBase(
  message: HttpMessage,
  input: SignatureInput,
  options?: CanonicalizationOptions,
): SignatureBase;
export declare function signHttpMessage(
  message: HttpMessage,
  input: SignatureInput,
  privateKey: KeyObject,
  options?: CanonicalizationOptions,
): Promise<SignatureHeaderPatch>;
export declare function verifyHttpSignatureCryptography(
  message: HttpMessage,
  signature: ParsedSignature,
  publicKey: KeyObject,
  options?: CanonicalizationOptions,
): Promise<CryptoVerification>;
```

### Engine contract

- Preserve component and parameter ordering rather than reordering object fields.
- Raw parsing preserves duplicate occurrences and positions; apply RFC semantic
  resolution separately, rather than blindly serializing every raw duplicate.
- Test header duplicates/collisions against RFC 9421 and SF rules; document stricter
  local rejection policies.
- Require explicit raw-target context when covered; adapters own consistency with
  the absolute URI. Never infer missing context.
- Use actual SF parsing/serialization, not a regex/split substitute.
- Validate numeric ranges, ASCII, key purpose/type, and Ed25519 curve at runtime.
- Reject other signing algorithms; sign exact bytes without an additional prehash.
- Construct the RFC signature base with no final newline.
- Response coverage of request components requires explicit related-request context.
- One-label patches do not overwrite existing signatures; merging is explicit.
- The pure engine performs no time, nonce, directory, or authorization checks.
  Cryptographic validity is not full Web Bot Auth verification.
- Expected parser/base/crypto failures use typed reasons; unsupported components
  or parameters are not silently ignored. No trailers in M1.
- General RFC 9651 Date/Display String support does not make those types valid in
  RFC 9421's RFC 8941-based signature fields.
- Decimals use integer thousandths, preserving integer/decimal distinctions and
  avoiding binary-floating-point canonicalization changes.

## 4. Profile layer: historical proposed contracts

The following sketch is not the current external API.
The [implemented result/configuration types](../packages/core/src/profiles/verification-types.ts)
use closed codes and per-candidate results. M2 selects one agent-header grammar
per request; it does not combine grammars or retry a failed candidate under another.

Proposed profile names became ietf-wg-protocol-00 and cloudflare-docs-2026-07-01.
The latter is agentsig's pinned-document identifier, not Cloudflare's own version.
Protocol changes require a new profile; bug/security fixes require release notes,
not preservation of unsafe behavior. The initial proposal considered independent
signatures from different profiles within one request; this is not implemented
by M2's single agent-header grammar.

```ts
export type ProfileId = "ietf-wg-protocol-00" | "cloudflare-docs-2026-07-01";
export interface TimePolicy {
  readonly signingLifetimeSeconds: number;
  readonly maxLifetimeSeconds: number;
  readonly maxAgeSeconds: number;
  readonly clockSkewSeconds: number;
}
export type NoncePolicy = "required" | "optional";
export type ReplayProtection =
  | { readonly replayProtected: true; readonly replayReason: "nonce-consumed" }
  | { readonly replayProtected: false; readonly replayReason: "nonce-absent-optional" };
export interface ReplayStore {
  consume(input: {
    readonly scope: string;
    readonly keyId: string;
    readonly nonce: string;
    readonly retainUntilEpochSeconds: number;
  }): Promise<"accepted" | "replayed" | "unavailable">;
}
export interface VerifiedIdentity {
  readonly keyId: string;
  readonly identifier:
    | { readonly kind: "directory-url"; readonly url: string }
    | { readonly kind: "key-thumbprint"; readonly thumbprint: string };
}
export type VerificationResult =
  | ({
      readonly status: "verified";
      readonly label: string;
      readonly profile: ProfileId;
      readonly identity: VerifiedIdentity;
    } & ReplayProtection)
  | { readonly status: "unsigned" }
  | {
      readonly status: "invalid" | "unverified";
      readonly label?: string;
      readonly profile?: ProfileId;
      readonly reason: string;
    };
```

This sketch indicated direction only; later approvals replaced free-text reasons
with the frozen catalog and added the per-key quota outcome.

Future directory resolution must preserve URL/key binding and replace complete
sets atomically, rather than merging removed keys back into validity.
Replay consumption is atomic and follows crypto, identity, and time checks.
Scope comes from local configuration, not attacker-controlled URL/label claims.

The proposed conservative retention deadline is the greater of validation time
and creation time, plus maximum age and skew. With age 300 and skew 30, a creation
time accepted 30 seconds ahead may require 360 seconds of retention, not a fixed
330 seconds. Later M2 approvals pinned exact inequalities and dispatch-time
arithmetic. Full/unavailable storage never counts as successful replay protection.
Optional mode relaxes absence only; it does not hide present-nonce replay or
store failure. Memory is process-local; multiple instances need a shared atomic
backend. Unverified resource rejection is not permission to proceed.

## 5. Security decisions and deferred alternatives

Nonce requirement and balanced time defaults were approved. Structured Fields
dependency criteria and evaluation are recorded in §9. Network/cache choices
remain proposals for separate approval, not implemented defaults.

| Decision | Original recommendation | Alternative / cost |
| --- | --- | --- |
| Missing nonce | Required by default | Optional absence improves compatibility but cannot prevent nonce-less replay; report it |
| Balanced time | Sign 60 s; lifetime/age 300 s; skew 30 s | Skew 5 s is tighter but requires better synchronization |
| Broad compatibility | Do not enable by default | Sign 60 s; lifetime/age 86,400 s; skew 60 s accepts older examples but increases replay exposure/storage |
| Directory access | HTTPS, no redirects, globally routable IPs, pin DNS result to connection | Origin allow-list narrows exposure but restricts open discovery |
| Stale cache | Failed fetch does not delete history or silently make stale keys trusted | Bounded stale-if-error improves availability but extends removed-key acceptance |
| Structured Fields | Evaluate small auditable dependency | Own parser removes a runtime dependency but increases testing/maintenance obligations |

Time defaults are local per-profile policies, not protocol MUST requirements.
Nonce presence does not bind method, path, or body. Write-request body integrity
needs separate coverage and actual Content-Digest validation.
A DNS precheck alone is not SSRF protection: reconnects, IPv6, mapped IPv4,
proxy behavior, and connection pools require tests.
Timeout, byte/key/cache/concurrency limits need approval in the network milestone.

## 6. Protocol compatibility sources

WG source: draft-ietf-webbotauth-httpsig-protocol-00, September 1, 2026.
Cloudflare documentation date: July 1, 2026; retrieved September 18, 2026.
The initial requirement to pin Cloudflare before implementation was fulfilled at
commit acfb1f2270b9473ae65a15674995e0b2f3b6ab0c.

| Topic | WG-00 | Cloudflare documented profile | Sources |
| --- | --- | --- | --- |
| Signature-Agent form | Dictionary keyed to signature label | Quoted String; Dictionary form rejected | [WG §5.2.1](https://www.ietf.org/archive/id/draft-ietf-webbotauth-httpsig-protocol-00.html#section-5.2.1), [CF §4.3](https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/#43-construct-the-required-headers) |
| Agent coverage | Matching member using key selection | Entire header covered | [WG §5.2.1](https://www.ietf.org/archive/id/draft-ietf-webbotauth-httpsig-protocol-00.html#section-5.2.1), [CF §4.3](https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/#43-construct-the-required-headers) |
| Target | Authority or target URI minimum | Authority recommended | [WG §5.2](https://www.ietf.org/archive/id/draft-ietf-webbotauth-httpsig-protocol-00.html#section-5.2), [CF §4.1](https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/#41-choose-a-set-of-components-to-sign) |
| Nonce | No additional requirement | Recommended; no replay tracking stated | [WG §5.2.3](https://www.ietf.org/archive/id/draft-ietf-webbotauth-httpsig-protocol-00.html#section-5.2.3), [CF §4.3](https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/#43-construct-the-required-headers) |
| Lifetime | At most 24 hours recommended | Short; one minute generally sufficient | [WG §5.2](https://www.ietf.org/archive/id/draft-ietf-webbotauth-httpsig-protocol-00.html#section-5.2), [CF §4.3](https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/#43-construct-the-required-headers) |
| Directory response | Appendix B optional for basic URL identity; proof covers authority and content-digest | Response signature for every key used; displayed required-component table lists authority | [WG Appendix B](https://www.ietf.org/archive/id/draft-ietf-webbotauth-httpsig-protocol-00.html#appendix-B), [CF §2](https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/#2-host-a-key-directory) |
| Key identity | Base64url SHA-256 JWK thumbprint | JWK thumbprint | [WG §5.2](https://www.ietf.org/archive/id/draft-ietf-webbotauth-httpsig-protocol-00.html#section-5.2), [CF §4.2](https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/#42-calculate-the-jwk-thumbprint) |
| Verified Bot status | No authorization/reputation implied | Separate registration/approval | [WG §4](https://www.ietf.org/archive/id/draft-ietf-webbotauth-httpsig-protocol-00.html#section-4), [CF §3](https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/#3-register-your-bot-and-key-directory) |

This is source comparison, not a live Cloudflare result. WG §5.5's status-200
requirement, Appendix C's conditional-cache guidance, and redirect provisions
need explicit interpretation in the future network milestone.

## 7. First milestone acceptance criteria

- Inspect RFC 9421 B.2.6 real base/signature bytes and map implemented §2–§3 rules
  to their source sections.
- Separate golden suites: headers → parsed structure; message → base;
  fixed private key → published headers; published signature/public key → verification.
- Pin B.1.4/B.2.6 attribution and remove only recorded RFC 8792 presentation folds.
  Old timestamps remain usable in pure-engine tests because that engine has no clock policy.
- Test header normalization, repeats, OWS, empty values, and ASCII boundaries.
- Cover authority/method/target/scheme/raw-target/path/query/query-param/status,
  SF/key/binary wrapping, request references, parameter order, and signature-params.
- Reject unsupported trailers and parameter combinations explicitly; no full-RFC claim.
- Do not rely solely on our own sign/verify round trip.
- Test wrong keys, malformed SF/base64, label pairing, missing components,
  modified signatures/messages, percent encoding, empty queries, repeated query
  names, ports, and authority edge cases.
- Keep per-label verification independent; first success never grants authorization.
- Preserve licenses and explain security decisions in code/test comments.
- Test ESM/CommonJS, declarations, Node versions, and Windows/Linux; publish nothing.

## 8. Later profile/integration acceptance criteria

WG and Cloudflare fixtures remain separate with source versions recorded.
Use actual published vectors where available, not illustrative signatures.
Separate exact documentation serialization from independently generated crypto
fixtures. Live tests require explicit user execution with target/key configuration.

Replay tests cover concurrency, skew-aware retention, capacity, and backend failure.
Network work separately needs SSRF, DNS rebinding, cache refresh, key removal,
and multi-process boundary tests.

At initial research, WG appendix inventory was incomplete. The later M2 inventory
independently verified all three E.2 Ed25519 vectors; E.1 RSA is outside scope.
The requested Appendix F.3 JSON collection remains a separate M3 pinning task.
Package comparisons below are documentation/selected-source reviews, not audits
or execution of alternative packages' test suites.

## 9. Source-based package comparison and dependency decision

Research date: September 18, 2026. This is a targeted review, not an exhaustive npm
inventory. Versioned npm links are used where available; GitHub main-branch
inspection is not immutable release evidence.

| Package / examined version | Documented capabilities | Limits / remaining agentsig work | Source |
| --- | --- | --- | --- |
| http-message-sig 0.3.0 | RFC 9421 engine, ordered occurrences, request/response context, Dictionary selection, multiple signatures, WebCrypto providers | Generic SF serialization, binary wrapping, trailers, and query-param explicitly rejected; RFC 9651 new types rejected in signature fields; discovery belongs to caller | [npm 0.3.0](https://www.npmjs.com/package/http-message-sig/v/0.3.0), Capabilities/Limitations |
| web-bot-auth, repository badge 0.2.0 | WBA signing/verification policy; Ed25519/RSA; Signature-Agent, registry, agent-card parsing; multiple labels | Documented individual protocol-00 target is not WG-00; resolver and atomic replay cache left to application in examples; complete Hono/Fastify/Express adapter set not established | [Cloudflare package docs](https://github.com/cloudflare/web-bot-auth/tree/main/packages/web-bot-auth), Features/Verifying/Security Considerations |
| http-message-signatures 1.0.6 | Node crypto; RSA/ECDSA/Ed25519; signing/verification and two historical formats | Documentation targets draft revision 13; final RFC conformance not tested; raw-target and complex-context limitations documented; WBA profiles not established by this review | [npm 1.0.6](https://www.npmjs.com/package/http-message-signatures/v/1.0.6), Caveats/Limitations/Examples |
| structured-headers, observed latest 2.1.0 | RFC 9651/8941, Date/Display String, TypeScript, ESM/CJS, no-dependency claim, recent maintenance, official HTTP WG tests | Documented integer-valued decimal/rounding serialization limits; parameter occurrences lost; does not satisfy our lossless-AST criterion | [Repository](https://github.com/evert/structured-headers), Compatibility; [parser source](https://github.com/evert/structured-headers/blob/main/src/parser.ts), lines 195–218 at review |

### Structured Fields decision

The recommendation was not to adopt the examined structured-headers version.
Under the maintainer-approved fallback, implement our own separate parser/serializer.
This was not a maintenance objection: active development, TypeScript, dual module
formats, zero-dependency declaration, and visible Date/Display String support
were positive findings. Lossless canonicalization and raw duplicate observability
were the deciding criteria.

Actual installation/tarball size was not measured and is not reported as passing.
Other mandatory criteria already ruled it out. Standard last-value duplicate
resolution is not itself an RFC violation; raw AST and semantic models must remain
separate. Our implementation requires official compatibility tests, lossless
numeric distinctions, limits, and deterministic fuzz/property tests.

The [official HTTP WG suite](https://github.com/httpwg/structured-field-tests) was
subsequently pinned by commit and license. RFC 9421 metadata acceptance is not
the same as general RFC 9651 parser capability. No claim is made that no suitable
parser exists; no alternative parser was shown to pass every criterion.

### Cloudflare reference implementation findings

The [Cloudflare repository](https://github.com/cloudflare/web-bot-auth) lists
TypeScript/Rust packages, Workers examples, directory tools, and a research test
environment. It is Apache-2.0; agentsig code is MIT. Copying code was not proposed;
any future reuse must preserve applicable licenses and attribution.

The research server uses a published RFC test key. This is test material, not a
production key-generation default. Research testing, documentation-form
compatibility, and production Verified Bots registration/approval are distinct.

Examined main-branch examples use Dictionary form while production documentation
describes the legacy single String. Repository behavior does not prove production
acceptance. Documentation and selected code were reviewed, not all crypto paths
or tests. No performance or security superiority is claimed.

### Positioning

agentsig is not the first Node HTTP-signature engine or TypeScript Web Bot Auth
package. Intended differentiation: built-in crypto, explicit pinned profiles,
default atomic replay checks, safe discovery, adapters, CLI, and source-backed
compatibility. Pinned offline profiles/replay were subsequently implemented in M2;
network discovery, adapters, and CLI remain future goals. No official
IETF/Cloudflare reference-implementation or endorsement claim is made.

## 10. Historical first implementation delivery plan

1. Set up monorepo, MIT, pnpm/Changesets, ESM/CommonJS, types, and tests.
2. Finalize message/type/error boundaries and RFC rule coverage.
3. Commit independent source expectations, keys, and four golden suites first.
4. Implement bounded SF parsing/serialization with RFC 9651 and property tests.
5. Implement RFC 9421 parsing/canonicalization with explicit unsupported results.
6. Add Ed25519 and exact B.2.6 signing/verification plus mutation rejection.
7. Run real consumers, types, and available Node/OS tests; distinguish actual
   execution from intended CI coverage.
8. Document why agentsig, why not stealth, rate-limit differences, and compatibility.
9. Stop at M1 pending separate approval for profiles, networking, replay, adapters,
   and CLI. Do not publish.

Node 20 runtime compatibility is separate from lifecycle/security support and
tooling minimums. Directory budgets/cache policy and vector inventory are later
gates; they do not add network behavior to the pure engine.

## 11. core-m1: proposed versus implemented API

Review basis: engine **b3b0829**, SF **584144c**, independent audit **5fd54d3**.
The maintainer confirmed the core-m1 tag was pushed and CI was green. This history
does not represent later CI results or a security audit.

The four-operation separation is retained. The following differences from the
initial type sketch are deliberate; this is not a claim of zero API changes.

| Area | Original proposal | Implemented contract / reason |
| --- | --- | --- |
| Four operations | Parse, base, sign, crypto verify | Same responsibilities; sign/verify return Promises. [Exports](../packages/core/src/index.ts) |
| Network/time/nonce/authorization | Outside pure engine | Preserved; [crypto verification](../packages/core/src/crypto.ts:80) checks supplied key/signature only, not body digest |
| Header values | Strings only | [HeaderField](../packages/core/src/types.ts:8) supports ASCII strings or raw bytes to avoid encoding guesses |
| HTTP version | No field | [RequestParts](../packages/core/src/types.ts:11) and message types carry explicit context for HTTP/1.1 obs-fold |
| Raw target / related request | Optional explicit context | Preserved; required when corresponding component is covered, never inferred |
| Resource limits | Four parser budgets | [Limits](../packages/core/src/types.ts:52) also bound message headers, URI, base, and SF with approved 16 KiB defaults |
| Parse arguments | Required complete limits | Optional [partial overrides](../packages/core/src/types.ts:63) over frozen explicit defaults |
| Canonicalization options | Field types only | [Options](../packages/core/src/types.ts:68) also carry budgets to bound expansion |
| SF type ownership | Local core types | Separate SF package owns BareItem and related types; core reexports Parameters, not the historical SfBare/SfParameter aliases |
| Rejection reasons | Five codes | [Reasons](../packages/core/src/types.ts:86) add algorithm mismatch and resource limit for distinct diagnostics |
| Errors | Typed parsing/base failures and crypto rejection results | [Error classes](../packages/core/src/errors.ts) preserve configuration failures separately; direct limit errors carry accounting, crypto results only the reason |
| Multiple signatures | Per-label parsed array | All pairs parsed; missing counterpart rejects entire call, no headers returns empty array; no single-label selector |
| Duplicates | Raw syntax preserved, semantics separate | SF retains raw AST; RFC signature labels must be unique; semantic results omit raw AST; serializer rejects duplicate caller-created semantic keys |
| Field type knowledge | Caller table | Built-in signature and Content-Digest Dictionaries added; no network/IANA lookup |
| Execution | Promise API | Bounded synchronous implementation; no off-thread/nonblocking guarantee |
| Trailers / algorithms | No trailers; Ed25519 only | Preserved, with explicit rejection and four golden suites |
| Full WBA result | Future sketch | Outside M1 as approved. Later M2 provides closed results and time/replay via a separate [profile entry](../packages/core/src/profiles.ts) |

Current references: [core README](../packages/core/README.md) and
[offline verification](offline-verification.md).
GitHub metadata uses agentsig-dev/agentsig; npm scope remains @agentsig.
Project manifests were corrected without modifying the HTTP WG fixture's
third-party manifest, preserving its hash and provenance.