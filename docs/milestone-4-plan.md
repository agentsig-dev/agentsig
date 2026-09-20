# M4 proposal: signed fetch and thin Node framework adapters

Status: proposed, awaiting maintainer decisions. September 20, 2026.
This document authorizes no implementation, new acceptance rule, or publication.

## Accepted baseline

The maintainer accepted M3 after running the three-case network smoke:
verified; private DNS destination 10.0.0.1 denied before CONNECT with
unverified/unknown-key; and unknown-key after an empty replacement set.
The real origin cooldown was observed. The maintainer confirmed pushing a9f5764,
tagging core-m3, and green CI. No new npm publication occurred.

Core already owns cryptography, profile grammar, discovery, clock/replay policy,
and final identity checks. Adapters must call an application-owned long-lived
verifier, not construct one per request or implement alternative verification.
The default signer covers @method, @target-uri, and profile-specific
signature-agent. @authority can be additional coverage; it is not a required
new default proposed here.

## Package boundaries

- @agentsig/fetch: construct an owned clean outgoing request, call the existing
  profile signer once, attach its headers, and submit once. No framework code,
  directory discovery, automatic retry, redirect follow, or key persistence.
  Applications retain key management and instantiate the existing core signer.
- @agentsig/hono: Node ingress capture bridge, mapping, context publication, and
  optional explicit policy enforcement. Fetch-only/edge runtimes are not included
  in the recommended first M4 scope.
- @agentsig/fastify: early capture/plugin integration, mapping, context publication,
  and the same policy contract.
- @agentsig/express: early capture/middleware integration, mapping, context
  publication, and the same policy contract.
- Proposed @agentsig/core/http subpath: shared Node HTTP capture/mapping and
  adapter contract types, no framework dependency or crypto/discovery duplication.
  This is an additive API proposal requiring approval. Main/offline entry points
  must not load it. An alternative is a new shared package, but that adds another
  published package to the agreed package set. Copying security mapping into three
  adapters is not recommended.

Frameworks are peer dependencies of their own adapters, not of core or fetch.
Exact peer ranges, pinned test versions, Node server behavior, Hono Node bridge
capabilities, and Fastify rewrite ordering must be source-reviewed before fixtures.
No claim is made here that current framework versions already provide every
required hook. Existing source snapshots and frozen core result catalogs stay intact.
Changesets/version alignment will be a separate approved release step; adapters
must not claim compatibility with published 0.1.1's nonexistent discovery subpath.

## D1: proxy trust and external target binding

A. Direct-only in M4: ignore all forwarded headers. Use transport TLS state and
exactly one validated Host.
Benefit: least configuration surface. Cost: TLS termination/host rewriting cannot
reconstruct the external signed URI.

B. Direct default plus explicit trusted ingress policy (recommended):
- Default ignores X-Forwarded-Host, X-Forwarded-Proto, Forwarded, X-Original-URL,
  X-Rewrite-URL and framework proxy-derived getters.
- Direct mode requires an explicit allowed external-origin set. Host is attacker
  input; a valid signature is not permission to select any virtual host.
- Forwarded mode checks the immediate socket peer against explicit operator
  configured IP/CIDR rules before reading forwarding values. No trust-all boolean,
  hop-count-only trust, DNS-derived peer trust, or framework trust-proxy inheritance.
- Operator must assert that the ingress strips client-supplied forwarding values
  and writes exactly one host and one protocol value. Being on a trusted IP does
  not establish this behavior; network ACLs must exclude bypass paths.
- Require exactly one occurrence of each selected forwarded field, no comma lists,
  no partial fallback, and no conflict repair. Protocol is exactly http or https;
  authority is validated without userinfo, path, fragment, or whitespace repair.
- Select an external origin from the configured allowlist by validated authority,
  scheme and effective port. Preserve the observed external authority spelling
  when assembling targetUri; canonical comparison does not rewrite signed bytes.
- Forwarded mode rejects untrusted peers rather than silently switching to direct.
  Direct exposure can use a separately configured listener/adapter instance.
Benefit: covers common single sanitizing reverse proxies. Cost: operational trust
assertions, explicit origin configuration, no generic multi-hop chain support.

C. Generic trusted-hop chain / framework proxy settings:
Benefit: flexible deployment compatibility. Cost: ambiguous chain precedence and
different framework semantics; wider spoofing surface. Defer in the recommendation.

@authority is derived by core from the same targetUri used for @target-uri.
The adapter never verifies against a claimed authority taken from signature
metadata. Local Host may differ behind a trusted rewriting ingress, but only the
explicit external-origin mapping authorizes that difference. Internal Host and
routing data remain recorded separately, not overwritten.

A protected application must dispatch according to this bound external target,
or use a declared fixed ingress-to-application mapping. A mount-path strip can be
such a mapping; a later tenant/host/query rewrite cannot silently change what the
verified identity is being used to authorize. Arbitrary later routing mutation
cannot be prevented by a middleware library; document placement and test it.
Proxy modification of additionally signed Host/forwarding fields normally invalidates
the signature; the adapter must not replace those header values to make it pass.

## D2: raw request capture and supported transports

A. Node HTTP/1.1, captured before conversion/rewrite (recommended):
- Snapshot IncomingMessage method, url, rawHeaders, httpVersion, socket peer and
  TLS state at the server entry boundary. Enforce bounds before allocation.
- Preserve header occurrence order and spelling. ASCII values remain strings;
  Node Latin-1 obs-text values become owned bytes, not guessed UTF-8.
- Reject ambiguous/missing Host, control characters, malformed authority/escapes,
  unsupported versions/forms, and missing capture. No repaired fallback.
- Initially support origin-form targets only; reject CONNECT authority-form,
  asterisk-form and absolute-form. A leading // is a path, never a network reference.
- Build targetUri lexically from trusted scheme/validated authority plus exact
  origin-form target. Do not round-trip the inbound path/query through URL,
  URLSearchParams, router parameters or decoded framework path fields.
- Snapshot rawRequestTarget exactly; prefix stripping is not reconstructed.
- The server integration must establish complete header capture. In particular,
  a Node maxHeadersCount truncation must not silently hide a late duplicate.
  Configure compatible parser byte/count limits before accepting traffic, or
  fail setup where capture completeness cannot be established.
- Parsing before the application may reject malformed wire requests. Tests must
  distinguish HTTP-parser rejection from adapter or core rejection.

Express capture precedes mounted routers and mutating middleware; originalUrl
alone is not proof that no earlier middleware changed the target.
Fastify capture must precede rewriteUrl and route mutation; onRequest alone is
not assumed sufficient. If necessary expose an explicit Node listener/server
factory bridge in addition to the plugin.
Hono captures before IncomingMessage becomes a Fetch Request. Bind the snapshot
to that exact request through private per-request association, not an HTTP header.
A Hono middleware reading only c.req.raw.headers/url cannot promise losslessness.

Benefit: one comparable security contract for all three adapters.
Cost: explicit early integration, Node-only Hono, constrained HTTP forms.
If a supported runtime cannot expose the required boundary, reject/defer that
integration rather than synthesize evidence.

B. Best-effort normalized framework mapping:
Benefit: simple installation and edge portability.
Cost: loses duplicate screening and original target spelling. Not recommended as
an equivalent authentication mode.

HTTP/2/3 and generic Fetch-only Hono support require separate pseudo-header,
authority/Host conflict and normalized-header contracts; defer rather than
label an HTTP/2 request as HTTP/1.1.

## D3: authorization policy and failure behavior

A. Separate explicit observe and enforce modes (recommended):
- Observe requires explicit mode selection. Attach authentication information and
  continue; authorization is always not-evaluated, never an implicit allow.
- Enforce requires a policy hook. No default "verified means allowed".
  Missing policy is a setup error, not allow-all.
- Policy receives the complete immutable assessment and bound request snapshot,
  not a promoted identity from one successful candidate of a failed aggregate.
- A generic continuation decision is distinct from authenticated continuation.
  Only a verified aggregate can produce the latter, checked at runtime as well
  as in types. Public/unsigned routes can be allowed explicitly as unauthenticated.
- Policy returns allow, deny or rate-limit. The application owns allowlists,
  reputation, counters and rate-limit algorithms; adapters only enact the decision.
- Deny/rate-limit never call the downstream handler. No rollback of consumed nonce.
- Mapping failure does not masquerade as unsigned or invent a core reason code.
  It fails before verification/discovery/replay and cannot grant continuation.
- A policy throw, invalid return or unexpected verifier exception does not continue.
  Delegate a sanitized integration error to the framework error pipeline.
  Recommended response defaults: mapping 400, policy deny 403, rate-limit 429,
  internal/policy failure 500. These are adapter HTTP defaults, not core codes.
- Proposed policy wait bound: 1,000 ms, with an AbortSignal; timeout rejects and
  late allow cannot revive the request. Cancellation does not prove application
  policy work stopped. The library does not claim a process-global policy-work cap.

B. Observation only:
Benefit: minimal adapter. Cost: every application must correctly implement guards
and ensure no fall-through. C. Mandatory policy on every route: safer protected-route
defaults but no simple observation rollout.

## D4: request context publication

A. Owned immutable assessment plus framework-native readonly view (recommended):
- Express: request.agentsig.
- Fastify: declared/decorated request.agentsig, new per-request value, never a shared
  mutable prototype default.
- Hono: typed context variable agentsig.
- getAgentSig(context) checks adapter initialization; it does not return a fabricated
  unsigned value when middleware was omitted.
- Publication includes authentication, target provenance, body-integrity status
  and a separate authorization union. No convenience isAuthenticated/isAllowed
  boolean conflating outcomes.
- Use owned copies/private authoritative association so replacing a context slot
  cannot forge a valid enforcement capability. JavaScript application code is not
  a sandbox; explicit bypass/casts remain application responsibility.
- Reject double installation/conflicting existing slots; do not reverify and
  consume the same nonce twice on one incoming request.

Benefit: idiomatic discovery with cross-framework semantics.
Cost: ambient typing/decorator setup; Hono slots themselves are not intrinsically
write-protected, so guards must consult owned state.

B. Symbol/accessor only:
Benefit: fewer property collisions. Cost: less idiomatic context inspection.
Choose before fixtures; do not publish both mutable competing sources of truth.

## D5: request bodies and Content-Digest

A. Defer body authentication (recommended for a thin M4):
- Default outgoing wrapper rejects a non-null body, rather than implying protection.
- Explicit identity-only body mode may forward the body without buffering,
  hashing, rewinding or replaying it. Report/document integrity as not-verified.
- Server adapters do not read/drain/parse the body. Assessments always say
  bodyIntegrity: not-verified, even if Content-Digest is signed by core.
- Enforced routes must explicitly select body policy: reject framed bodies, or
  allow-unverified. Identity-only body traffic requires deliberate opt-in.
- For HTTP/1.1 rejection checks include Transfer-Encoding and nonzero
  Content-Length, independent of method; do not assume GET has no body.
- Signed Content-Digest is a signed assertion, not evidence that actual body
  bytes matched. No verified-body status is offered in M4.

Benefit: preserves streaming/framework ownership and avoids a half-implemented
digest check. Cost: not appropriate for claiming transaction/payload integrity.

B. Bounded buffered RFC 9530 body integrity in M4:
Benefit: authenticated small request payloads.
Cost: separate core body-verification contract, algorithm/dictionary rules, encoded
versus decoded bytes, decompression limits, parser ordering, memory/time limits,
stream ownership/cancellation and new error semantics. Requires independent digest
fixtures before code; cannot be implemented as three adapter-local hash routines.

C. Streaming digest verification in M4:
Benefit: large payload support. Cost: must withhold side effects until end-of-stream;
trailers/partial reads/backpressure make this a separate milestone. Not recommended.

## D6: signed fetch semantics and transport ownership

A. Native Node fetch wrapper, no wrapper retry/follow (recommended narrow scope):
- Factory owns a snapshot of signing configuration through the core signer.
- Every explicit invocation constructs a fresh owned Request, then signs its final
  serialized method/URL and stable headers. Never signs the pre-normalized URL.
- Reject any existing Signature, Signature-Input or Signature-Agent in either
  input Request or init headers before override merging; never strip and re-sign.
- No automatic retry on network errors, timeout, 401, 429, 5xx or redirects.
  A new explicit application invocation is a new send/sign operation, not a retry
  feature of the wrapper. No nonce cache or signed-request reuse.
- Use redirect: manual; reject explicit conflicting redirect options. Return the
  original 3xx response without following it, including same-origin redirects.
- Abort before signing submits nothing; abort after signing/before dispatch submits
  nothing. Post-dispatch abort never proves that the server did not receive data.
- HTTPS only by default; explicit local HTTP test option is a separate decision.
- Reject caller Host/authority overrides and hop-by-hop transport fields. Additional
  covered fields must be stable in the final Fetch Request; absent auto-generated
  fields cannot be covered by guessing transport output.
- Reject consumed/locked body streams; never clone/tee to enable replay.
  Reuse of an unsigned bodyless input creates a fresh owned send each time.
- Freeze transport choice at factory creation. Default native fetch only; arbitrary
  injected fetch/undici retry dispatchers are not an audited guarantee.

A wrapper can guarantee one fetch invocation and no re-signing/follow loop, not
exactly-once network delivery or behavior of externally replaced globals/dispatchers.
Review/pin Node bundled Undici behavior before asserting any stronger transport
property. GET/HEAD connection recovery can differ from application retry.

B. Owned explicit Undici transport:
Benefit: clearer supported dispatcher/retry configuration and pinned implementation.
Cost: runtime dependency, lifecycle/pool API and added source/test obligations;
still not a distributed exactly-once delivery guarantee.

C. Arbitrary application fetch injection:
Benefit: test/integration flexibility. Cost: custom function can retry/follow/mutate
signed requests. Defer the public option; repository test seams remain internal.

## Proposed API sketch (names/types subject to D1-D6 approval)

The shared HTTP subpath would own these types. Identity is generic to accept the
existing offline and directory verifiers without casts or runtime type duplication.

```ts
import type { RequestParts } from "@agentsig/core";
import type { VerificationResult } from "@agentsig/core/profiles";

interface RequestVerifier<I extends { readonly thumbprint: string }> {
    verify(request: RequestParts): Promise<VerificationResult<I>>;
}

type Authorization =
    | { readonly status: "not-evaluated" }
    | { readonly status: "allowed"; readonly basis: "verified-identity" | "unauthenticated" }
    | { readonly status: "denied" }
    | { readonly status: "rate-limited"; readonly retryAfterSeconds?: number };

interface AuthenticationAssessment<I extends { readonly thumbprint: string }> {
    readonly request: Readonly<RequestParts>;
    readonly verification: VerificationResult<I>;
    readonly targetSource: "direct" | "trusted-ingress";
    readonly bodyIntegrity: "not-verified";
}

type VerifiedAssessment<I extends { readonly thumbprint: string }> =
    AuthenticationAssessment<I> & {
        readonly verification: Extract<VerificationResult<I>, { status: "verified" }>;
    };

declare const decisionBrand: unique symbol;
type PolicyDecision = {
    readonly [decisionBrand]: true;
};

interface PolicyTools<I extends { readonly thumbprint: string }> {
    readonly signal: AbortSignal;
    allowVerified(input: VerifiedAssessment<I>): PolicyDecision;
    allowUnauthenticated(): PolicyDecision;
    deny(): PolicyDecision;
    rateLimit(retryAfterSeconds?: number): PolicyDecision;
}

type PolicyHook<I extends { readonly thumbprint: string }> = (
    assessment: AuthenticationAssessment<I>,
    tools: PolicyTools<I>,
) => PolicyDecision | Promise<PolicyDecision>;

type AdapterMode<I extends { readonly thumbprint: string }> =
    | { readonly mode: "observe" }
    | {
        readonly mode: "enforce";
        readonly bodyPolicy: "reject" | "allow-unverified";
        readonly policy: PolicyHook<I>;
    };
```

Decision tools are invocation-bound, not global token factories. allowVerified
checks that the supplied assessment is the exact owned current assessment with a
verified aggregate. Tokens from another request, fabricated objects, stale/late
decisions and invalid rate-limit metadata reject at runtime. No authorization API
can prevent an application from deliberately choosing allowUnauthenticated; the
contract makes that choice explicit and keeps the actual verification result.

Context state combines the assessment with Authorization. Mapping failures use a
separate mapping-rejected union and safe diagnostic, no fabricated VerificationResult.
Exact error catalog/status override options and type narrowing helper names will
be pinned in approved fixtures, without changing the frozen core catalogs.

Proposed factories: createSignedFetch at @agentsig/fetch; agentSig middleware at
@agentsig/hono and @agentsig/express; agentSigPlugin at @agentsig/fastify.
Each adapter receives { verifier, ingress, ...mode } and an explicit early-capture
integration where required. Fetch returns Promise<Response>, not an invented
server-verification result. Responses do not prove the server verified the request.

## Fixture-first implementation sequence

1. Obtain decisions D1-D6 and shared-subpath approval. Pin exact framework/Node/
   Undici source versions and licenses; review early hooks and header truncation.
   No package installation, implementation or fixture approval is implied here.
2. Author independent shared HTTP expectations and per-framework ingress descriptors:
   same raw request -> identical HeaderFields, method, rawRequestTarget, targetUri,
   HTTP version, target provenance, or the same mapping failure.
   Expected data must not be generated by the production mapper.
3. Commit fixtures/manifests/independent audit separately before mapper code.
   Cover repeated headers and cookies, mixed case/obs-text, late duplicates,
   Host/forwarded ambiguity, trusted/untrusted peers, default/nondefault ports,
   IPv6 authorities, encoded slash/dot segments, plus versus %20, repeated query
   parameters, empty query delimiter, mount/rewrite timing and Hono conversion loss.
   Unsupported target forms, missing raw capture and parser-level rejection are
   explicit negative cases, not expected normalized successes.
4. Implement shared mapping and three thin adapters against those expectations.
   Real Node listeners supplement framework injection tests; one verifier invocation
   per request; malformed mapping means zero verifier/discovery/replay calls.
   Test native context isolation, missing/double middleware, mutation attempts,
   policy deny/rate-limit/errors/timeouts/late decisions, and no handler fall-through.
5. Independently pin fetch expectations before wrapper implementation: clean request,
   final URL normalization, header collision before override, Host mismatch rejection,
   two explicit sends with distinct nonce/signature, one transport call, redirects
   and status failures without follow/retry/re-sign, abort and stream ownership.
   A local redirect destination must observe zero requests.
6. Cross-package full verification round trips for both profiles/frameworks with
   memory replay; actual TLS/controlled test routing boundaries stated explicitly.
   ESM/CJS runtime/type consumers, package inventories, Node matrix and documentation.
   A successful crypto-only test is not full adapter authentication/authorization.

Stop and report at every three local commits, earlier at unresolved security
decisions. Fixture-only commits count toward that limit. No push, tag, publication,
upstream report, or maintainer-owned smoke execution without authorization.
M5 publisher-signed directory proof remains separate from M4 request-body decisions.

## Approved M4 decisions and overriding amendments

Approved by the maintainer on September 20, 2026: D1-B, D2-A, D3-A,
D4-A, D5-A, D6-A, and the shared @agentsig/core/http entry point.
The proposal above is retained as design history. This section overrides any
conflicting proposal wording, including its awaiting-approval status.

### Ingress and protocol

Trusted ingress explicitly selects either RFC 7239 Forwarded or the
X-Forwarded-* family, never both. Presence of the unselected family rejects the
request; it is not ignored or used as fallback. The selected family still requires
the approved single sanitizing ingress, immediate-peer trust, unambiguous values,
and allowed external-origin binding. RFC 7239 syntax must be parsed as its own
grammar, not as X-Forwarded-* or Structured Fields. Its exact accepted subset and
negative cases will be pinned before implementation.

Trusting a loopback peer trusts other processes able to connect from that host:
a local process can spoof forwarding headers. Loopback is not process identity
or authentication of a particular reverse proxy. Deployment isolation and access
controls remain necessary.

HTTP/2 is out of scope. Detecting HTTP/2 produces an explicit unsupported mapping
outcome and no verification result, never a silent HTTP/1.1 translation.

### Policy and context

The policy decision names are allow-verified, allow-anonymous, deny and rate-limit.
The proposed allowUnauthenticated helper/terminology is superseded by allow-anonymous.
Invocation-owned checks still prevent fabricated, cross-request or unsuccessful
aggregate evidence from granting allow-verified.

Policy timeout defaults to 1,000 ms and is configurable. A policy timeout or
exception produces authorization deny and an observer report. It does not change
the authentication result to unverified. Late completion cannot revive permission.
Observer failure must not change the denial or trigger downstream execution.

Default deny response status is 401, superseding the proposed 403.
Default rate-limit response status is 429. Both are configurable.
Default response bodies do not expose rejection reasons, avoiding a diagnostic
oracle; safe reason codes remain in request context and observer events only.
A duplicate installation on the same incoming request never verifies again or
consumes another nonce; conflicting configuration remains a separate error.

### Body integrity

Assessments explicitly contain bodyIntegrity: "unverified", superseding the
proposed "not-verified" spelling. Enforcement rejects requests with bodies by
default; forwarding/acceptance without body authentication requires explicit opt-in.
Adapters do not read, hash, buffer or consume bodies to imply digest verification.

Actual Content-Digest verification is mandatory before 1.0. The intended agent
payment use case includes state-changing requests: identity and target coverage
alone do not authenticate the payment payload. Digest verification remains deferred
from M4, not optional for the eventual 1.0 scope.

### Fetch transport

redirect: "manual" is mandatory. Redirect responses return without following,
including same-origin redirects. No automatic retry or re-signing is introduced.

The default transport is global fetch. Application injection of a fetch-compatible
implementation is explicitly approved, including a wrapper using an Undici
dispatcher. This supersedes the recommendation to defer public injection.
The wrapper supplies manual redirect behavior and invokes the selected transport
once; it cannot attest that custom transport code honors redirect, retry, URL,
header or body semantics. Injected transport is trusted application code.
Default-transport evidence and custom-transport contract tests must be distinguished.

HTTPS is required except for an explicit loopback-only HTTP test option.
That exception is not permission for arbitrary plaintext destinations or a bypass
of core discovery SSRF policy. Its exact destination admission contract must be
reviewed and pinned before implementation.

### Packaging and delivery

Framework dependencies belong in adapter peerDependencies. Review Express 4 and 5;
support both if the contract is achievable and tested, otherwise support 5 with a
documented source-based reason. Review Fastify 5, Hono 4 and @hono/node-server.
Peer ranges must follow source review and test evidence, not assumptions about
major-version compatibility.

Prepare Changesets for core 0.2.0, covering /discovery, /redis and /http, and for
@agentsig/fetch, @agentsig/hono, @agentsig/fastify and @agentsig/express at 0.2.0.
Do not publish. Dependency versions and workspace links must remain consistent;
no change to the Structured Fields version is implied by this approval.

Order: framework/transport source review; independently authored fixture contract
in a separate commit; shared mapper; adapters; fetch; real-listener acceptance
tests. Targeted tests accompany each implementation step.

Resolve choices that cannot affect incorrect verified/allow-verified acceptance or
proxy/SSRF exposure conservatively and report them briefly. Escalate unresolved
choices affecting those boundaries. Stop after every three local commits,
including documentation/source/fixture commits. No push or publication.

### Source-review finding: native Fetch can resend after HTTP 421

A local research probe on Node v22.23.2 (bundled Undici 6.28.0) invoked global
fetch exactly once with redirect: "manual". An isolated loopback HTTP server
returned 421 on its first request and 200 on its second. The server observed two
GET /probe requests with the same research marker; fetch returned the second
response's 200 status. The listener and connections were closed after the probe.

The integrity-checked npm Undici 6.28.0 source independently contains this path:
lib/web/fetch/index.js, lines 1644-1672, repeats HTTP-network-or-cache fetch after
421 when the request has no body or has a reproducible body source, unless this
is already the new-connection attempt. Manual redirect handling is separate.
Matching version labels alone are not proof that the npm archive and Node's
bundled implementation are byte-identical; the runtime probe is distinct evidence.

The approved default global-fetch transport remains unchanged. The guarantee is
one wrapper signing operation and one selected transport invocation, with no
wrapper retry, redirect-follow or re-signing loop. It is NOT a guarantee of one
HTTP transmission, of observing every intermediate response, or of exactly-once
delivery. No standard Fetch option established by this review disables this path.

A transport resend must not trigger a fresh signature or nonce from the wrapper.
Replay enforcement can reject a repeated consumed tuple, but it cannot prove
that an earlier operation did not occur, and optional-nonce mode does not provide
that protection for absent nonces. Applications must not infer payment execution
status from a transport error or a later replay rejection.

This probe used an unsigned marker, not a real signed request, and establishes
neither cryptographic replay behavior nor TLS behavior. Independent fetch contract
fixtures must distinguish wrapper call/sign counts from observed wire requests;
later signed listener tests must exercise the replay consequence separately.
No behavior on other Node/Undici versions is established by this one probe.

### Approved HTTP mapping contract amendments

The maintainer confirmed pushing source-fixture commit 343c1d5 and green CI.
That confirmation covers the source checkpoint only, not subsequent HTTP work.
The following additional decisions were approved on September 20, 2026 and
override conflicting earlier proposal text.

The [independent HTTP contract](../tests/fixtures/m4-http/contract.json) pins a
separate, closed version-1 set of seventeen mapping codes. No common error union
with verification, signing or operator catalogs is introduced. Even the spelling
resource-limit belongs to a distinct mapping boundary. Changes to this catalog
require separate approval and release notes. Missing or incomplete capture,
HTTP/2, malformed/unsupported requests, Host ambiguity, peer trust, forwarding
grammar/chains/family conflicts/port consistency and origin admission remain
mapping outcomes, not fabricated unsigned or unverified results.

Target-origin validation is separate from agent-identity-origin validation.
Compare lowercase host and effective port against an explicit allowed-origin set.
Explicitly allowed IPv4/IPv6 targets and non-default ports are supported. Reject
userinfo and parser repair; do not perform implicit IDNA conversion or numeric
IPv4 alias repair. Preserve observed authority, path and query spelling for the
signature input. Canonical comparison does not rewrite signed bytes.

Trusted ingress requires HTTPS and one sanitizing, explicitly trusted socket peer.
Forwarded accepts one occurrence and one element, with required host/proto and
optional for/by. Parameter names are case-insensitive; duplicates and unknown
parameters reject. Parse RFC 7239 token/quoted-string syntax and validate for/by
as RFC node identifiers, including unknown and obfuscated forms. Neither value
establishes authenticated identity or socket-peer trust.

X-Forwarded-Host and X-Forwarded-Proto are required exactly once.
X-Forwarded-For is optional, at most once, and contains one canonical IPv4 or IPv6
address without a port. Chains reject. X-Forwarded-Port is optional, at most once,
and is an integer from 1 through 65535. It must equal the explicit host port,
or 443 when the host is portless. It does not add a port to a portless authority.
Forwarded conflicts only with X-Forwarded-Host/Proto/Port/For. Other X-Forwarded-*
fields and X-Real-IP are preserved but ignored for trust; their presence alone
does not reject. Direct mode continues to ignore forwarding claims for trust.

A validated for value is an optional observed-client hint to policy, explicitly
authenticated: false and source: trusted-ingress. Distinguish ip, unknown and
obfuscated kinds; a supplied node port is separate. Do not substitute by or the
socket peer when for is absent. The library makes no authorization or rate-limit
decision based on this hint.

Every owned mapping failure emits a sanitized observer event containing code,
adapter and ingress mode (direct/trusted-ingress), never raw headers, addresses,
targets or underlying error text. Observer failure cannot change the outcome.

**Observe mode is an explicit exception to the earlier blanket mapping-failure
blocking rule:** publish mapping-rejected plus the code, skip verification, and
continue with authorization not-evaluated. Count and investigate mapping failures
during observation before switching to enforcement; observation is not protection.

In enforcement mode, pass mapping-rejected to the policy hook without calling
verification, discovery or replay. Only deny/rate-limit can take effect; any
continuation decision becomes deny. Mapping denial defaults to configurable 400,
including ingress-peer-untrusted and origin-disallowed. This is separate from
ordinary policy denial's configurable 401; rate-limit defaults to 429. Default
response bodies disclose no reason code. Policy errors/timeouts deny, and a late
decision cannot revive a request.

HTTP-parser rejection before application capture is a separate test category.
For ordinary malformed requests Node emits clientError and, absent an application
listener and where a response can be sent safely, sends 400 and closes the socket.
Not every parser/transport failure is 400: header overflow uses 431, and other
special cases exist in the pinned Node sources. Installing a clientError handler
changes ownership of error handling. Adapters do not claim to observe requests
that never reached capture; do not log raw parser error packets or messages.