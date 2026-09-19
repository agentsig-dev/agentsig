# Deferred work and implementation decisions

Updated September 19, 2026. This record does not change approved security contracts.

## Language and decision boundaries

All project-authored repository content must be English: READMEs, documentation,
comments, changelogs, commit messages, and diagnostics. Conversation with the
maintainer remains Turkish. Immutable upstream sources, cryptographic fixture
bytes, and deliberate Unicode test inputs must not be translated or normalized.

For details that cannot affect incorrect verified acceptance, choose a reasonable
default, document it, and proceed without another approval question. This includes
diagnostic precedence between rejection reasons. Ambiguities affecting incorrect
acceptance require approval. M3 security decisions must be presented explicitly
with alternatives, benefits, and costs; no silent defaults.

The verification, signing, and operator catalogs are frozen separately.
Adding, removing, or renaming codes requires approval and release notes.

The maintainer pushes after delivery reports. Do not accumulate more than three
local commits without an interim report; report at the third commit at the latest.
The assistant does not push, publish packages, or submit WG reports.

## Recorded implementation details

- Metadata tests preserve five distinct gates, with positive/negative cases for
  both profiles. Passing one gate is not full authentication.
  See the [metadata fixtures](../tests/fixtures/metadata/cases.json).
- Thumbprint-format diagnostics show only fixed violated-rule text, not supplied
  key identifiers or nonces. See [metadata checks](../packages/core/src/profiles/metadata.ts).
- The [RFC smoke script](../scripts/smoke-core.mjs) resolves fixtures relative to
  itself and uses the built ESM engine. It needs a prior build but performs no
  installation or networking. The maintainer confirmed exact equality of all
  64 RFC B.2.6 signature bytes on September 18, 2026.
- The [WG report text](wg-e2-1-report-draft.md) was prepared for the maintainer.
  The maintainer later supplied
  [protocol issue #135](https://github.com/webbotauth/draft-ietf-webbotauth-httpsig-protocol/issues/135).
  No upstream resolution is assumed; original fixtures remain unchanged.
- Failed aggregate summaries use the first failed candidate in header order,
  preserving all individual results. Default exactly-one ambiguity takes
  precedence. This diagnostic choice does not alter acceptance or counting.
- Verified identities belong to individual successful candidates. Multiple
  successes are not reduced to one operator/URL identity. A failed aggregate
  never promotes an individual candidate's identity to aggregate acceptance.
- If any successful candidate is nonce-less, the aggregate success summary uses
  the nonce-less reason. Each candidate reports replay protection separately.
- The profile API lives at @agentsig/core/profiles, separate from the pure engine.
  Internal evaluations, leases, and context capabilities are not exported.
- Dispatch-time eligibility and conservative retention use the same healthy
  clock sample through an internal synchronous preparation path. The public
  replay-store interface is unchanged.
  See [dispatch-time tests](../packages/core/test/profile-consume-preparation.test.ts).

## Deferred functionality

- Network directory discovery, SSRF/DNS protection, network caching, and automatic
  refresh are outside M2. Their security policies need separate decisions.
- Countersignature coverage is outside M2; revisit in a separate milestone if
  proxy deployment requires it.
- Signer merging of existing signature headers and remote/asynchronous signing
  providers remain deferred.
- No Redis adapter or distributed reset protocol is implemented. An independent
  retention-clock declaration does not guarantee cancellation of remote work.
- Body-digest comparison, framework adapters, fetch wrappers, and CLI are not
  silently included in the offline implementation.

## Completed M2 acceptance gates

The offline verifier integrates metadata, key selection, cryptography, identity,
time, replay, and multiple-candidate policy. Integration tests exercise zero
consumption on ambiguity, invocation-local nonce sharing, all/any aggregation,
and reset races.

Four independent golden signer outputs across both profiles passed full offline
verification, followed by replay rejection on second use. For each profile,
100 concurrent identical requests produced one acceptance and 99 replay rejections.
Pure cryptographic validity was not substituted for this gate.

ESM/CommonJS exports, fresh-process runtime consumers, and declarations for both
module formats passed. Completed local Windows / Node 22 regression passed
4,284 unit tests, 13 integration tests, builds, and type checks. The independent
M1 audit and 60 additional fixture audits passed separately.

## Maintainer-confirmed delivery

- The maintainer pushed **e8ecb27** and **88e1fc0**, created **core-m2**, and
  confirmed green CI and fixture workflows.
- The maintainer ran and pushed **08592a2**, confirming the two-profile
  verified → replay-detected → signature-expired smoke sequence, and accepted M2.
- The [verification smoke script](../scripts/smoke-verify.mjs) keeps default
  verifier policy. Signing at a clock ten minutes in the past with a 60-second
  lifetime triggers expiry before the age check. Age boundaries have separate
  unit coverage.
- The maintainer subsequently reported that published npm READMEs contained
  Turkish and obsolete pre-publication wording, requesting the 0.1.1 correction.
  Publication was not performed by the assistant.

Past CI confirmations do not establish remote CI success for later commits.

## Historical 0.1.0 preparation

The initial two-package minor changeset was recorded in **17b98d3**, then consumed
by Changesets to produce 0.1.0 versions and changelogs. Preparation was committed
in **371c214**. Do not recreate the consumed changeset without a new change.

For direct npm packaging/publication, core's SF dependency was changed from the
pnpm workspace protocol to exact version 0.1.0. Explicit workspace linking and
the lockfile preserve the local link. Future versioning must update both the
dependency and lockfile consistently.

The original preparation passed locked offline installation, builds, type checks,
4,284 unit tests, and 13 integration tests. All three ten-line README examples
were executed. The npm dry-run inventory was:

| Package | Files | Compressed / unpacked |
| --- | ---: | ---: |
| @agentsig/structured-fields@0.1.0 | 7 | 21.1 kB / 80.2 kB |
| @agentsig/core@0.1.0 | 14 | 76.7 kB / 346.4 kB |

Only built outputs, README, LICENSE, and the automatically included manifest were
listed. Source, test, and fixture files were excluded. Changelogs remained in the
repository. These historical sizes do not describe the new documentation patch.

## Current 0.1.1 documentation correction

The requested patch translates project prose and diagnostic comments/messages,
removes obsolete pre-publication README wording, adds npm badges and direct
installation instructions, and distinguishes each package's maturity/scope band.
Package-local test commands are development metadata, not a runtime feature.

The change must not alter parser, signing, verification, replay, or protocol
behavior. Upstream sources and fixtures remain immutable. Existing English
changelogs retain their history; a new patch note records the documentation
correction and development-script changes.

The patch changeset was recorded in **78dedf7**, then consumed by Changesets.
Both packages and core's exact Structured Fields dependency are now 0.1.1;
the lockfile retains the local workspace link.

Validation for this correction completed locally on Windows / Node 22:

- Locked offline installation, builds, type checks, 4,284 unit tests, and
  13 integration tests passed.
- Package-local commands passed 1,342 core tests and 2,942 Structured Fields
  tests. These repeat the same unit suites; they are not additional tests.
- The translated independent M1 audit and 60 additional fixture audits passed.
- All three ten-line README examples executed successfully.
- The translated smoke script passed both profiles' verified, replay-detected,
  and signature-expired sequence.
- A language scan found only deliberate Unicode test inputs among remaining
  Turkish-character matches. Library source, tests, and pinned fixture files
  are unchanged from the 0.1.0 preparation commit.

The npm dry-run inventories for this correction are:

| Package | Files | Compressed / unpacked |
| --- | ---: | ---: |
| @agentsig/structured-fields@0.1.1 | 7 | 20.7 kB / 80.4 kB |
| @agentsig/core@0.1.1 | 14 | 76.0 kB / 346.3 kB |

Both contain built outputs, README, LICENSE, and the package manifest, with no
source, tests, fixtures, or private test keys. Dry runs did not create archives
or publish packages. The maintainer subsequently confirmed that **78dedf7** and
**53b457e** were pushed, CI is green, the repository is public, and **0.1.1**
is published on npm with tag **v0.1.1**. These are maintainer confirmations;
the assistant did not publish or push.

## M3 planning and source pinning

The [M3 proposal](milestone-3-plan.md) preserves the original alternatives.
The maintainer subsequently approved the restrictive A choices with the
amendments recorded below. This approval authorizes fixture-first implementation,
not a claim that network discovery or Redis has already been implemented.

Fourteen files are pinned in the [M3 manifest](../tests/fixtures/m3/manifest.json),
including exact excerpts of WG §5.5, Appendix C and supporting sections, and
the Cloudflare directory section. The WG/Cloudflare documentation baseline is
reused from the accepted M2 snapshots, not represented as a newer revision.

The F.3 JSON collection and a separately identified supplementary directory
response vector are pinned from cloudflare/web-bot-auth commit
**c07ecb6f3e82701f297dedb414237cc2e54a0948**, with original Apache-2.0 license,
package attribution, Git blob identities, and source-tree evidence.
Cloudflare documentation retains its separate CC BY 4.0 license.

The [independent M3 audit](../tests/m3-fixture-audit.test.mjs) initially passed
eight tests: exact source/manifest checks, four valid request signatures
(two RSA and two Ed25519), and a valid directory-response signature plus
comparisons with existing fixtures. RSA is audited as source material only;
production remains Ed25519-only.

Two F.3 requests omit Signature-Agent; two retain the sig2/agent2 mismatch.
They are not WG-00 positive acceptance vectors. The Ed25519 member example
matches the original E.2.1 bytes and existing issue #135. Long lifetimes and
missing method/target-URI coverage separately conflict with local M2 policy.
The supplementary directory response shares the E.2.3 body/digest but signs
different metadata; both signatures are valid, so different signature bytes
are not a cryptographic contradiction.

No old fixtures or production APIs were changed by source preparation.
The maintainer confirmed that **9697d6c** and **e90f155** were pushed and CI
passed. That result does not extend to the subsequent contract or implementation
work. No assistant push, publication, or upstream issue submission was performed.

### M3 preparation validation

Source/vector preparation and independent audit were committed in **9697d6c**,
before any M3 production implementation. Reimporting produced identical bytes.
The combined seven independent audit suites passed **68 tests** locally on
Windows / Node 22, including eight new M3 source/vector checks.

All fourteen staged source/vector files matched their manifest byte lengths and
SHA-256 digests. The exact Appendix C excerpt retains a source-derived blank
line at EOF; only that file was excluded from the whitespace-style check, not
from byte-integrity validation. Existing production code and earlier fixtures
were unchanged.

The decision proposal was a separate documentation delivery. Its later approval
came from explicit maintainer instructions, not from committing the document.

## Approved M3 amendments and fixture-first work

- Allow-list admission remains the default. Explicit open discovery is a
  first-class M3 mode, not deferred. Neither mode can disable HTTPS, certificate
  and hostname verification, public-address filtering, mixed-DNS-answer
  rejection, connection pinning, redirect rejection, or resource/admission bounds.
  Verified identity is not authorization; application policy remains separate.
- Coalesce fetches per origin, with one active fetch per origin and sixteen
  globally. Bound different-origin fetch starts as well as concurrency.
- Use unconditional GET and accept only HTTP 200. Request identity encoding and
  reject compressed responses. Read no proxy environment variables. Proxy and
  custom CA configuration must be explicit; there is no TLS-disable option.
- Cache freshness falls back to 60 seconds when explicit freshness is absent;
  restrictive directives and response-age accounting take precedence. Negative
  caching defaults to 60 seconds and has bounded capacity. Configured positive
  and negative lifetimes cannot exceed 300 seconds. Stale evidence never grants
  verified acceptance.
- Successful fetch replaces the complete validated key set atomically, including
  an empty set. Removed keys become unusable immediately upon replacement,
  including at the final check of pending verification. No separate revocation
  list is introduced. Failed fetches neither replace evidence nor renew its age.
- Explicit verification-clock reset does not clear the directory cache or renew
  TTLs. Cache age uses monotonic elapsed time from fetch, independently of replay
  clock-reference resets. Old verification leases remain invalidated as in M2.
- WG-00 includes nbf/exp in its example but defines neither their types nor
  acceptance inequalities. These extensions are ignored for key-time decisions;
  no JOSE/JWT semantics are inferred. The exact example remains pinned in the
  [WG source excerpt](../tests/fixtures/m3/sources/wg-5.5.txt).
- **Publisher-side signed directory responses are mandatory for the Cloudflare
  profile in M5.** M3 direct-TLS discovery does not claim to implement that
  publisher requirement, portable response proof, or body-digest verification.
- Architecture-v2 F.3 vectors remain negative fixtures, never WG-00 positives.
  All four carry the protocol tag: the two missing agent headers produce
  malformed-agent, not absence of a selected candidate. The other two produce
  agent-label-mismatch at the agent-binding gate. Other crypto/coverage/time
  failures remain separate.

### Redis recovery approval

Normal nonce retention continues to come from each consume call. The store
does not calculate signature policy. Per-key quota spans all scopes within the
shared enforcement domain. Callers must ensure that supplied retention covers
every verifier that can accept the same tuple; sharing a store alone does not
make incompatible acceptance windows safe.

Recovery configuration requires a positive, representable horizon in seconds,
supplied by the application, with no implicit default. Missing or invalid
configuration produces invalid-replay-policy before the adapter becomes usable.
The planned library helper derives the single-clock horizon from the acceptance
inequalities: min(maximum age, maximum lifetime) + twice the clock skew.
Defaults produce **360 seconds**, not 330. The 359/360/361 boundaries are pinned
in [recovery expectations](../tests/fixtures/m3-contract/recovery-cases.json).

The operator must supply the largest horizon of all verifiers sharing the
enforcement domain, plus a bounded distributed-clock allowance. The library
cannot establish that deployment-wide assertion. Explicit resets and Redis
clock anomalies require the same operational clock assumptions; a marker does
not solve arbitrary clock jumps.

The epoch marker and an absolute quarantine-until timestamp live in Redis.
Quarantine starts when loss is detected. All instances observe the same atomic
recovery state; restarting one instance does not restart or shorten quarantine.
Missing or inconsistent recovery markers start a new quarantine, never imply
readiness. During quarantine, consume returns unavailable. M3 has no manual
early-release API and introduces no operator-catalog changes.

At connection setup, inspect CONFIG GET maxmemory-policy and require noeviction.
If inspection is denied or unsupported, only explicit
acknowledgeEvictionPolicy: "noeviction" permits relying on the operator's
declaration. An acknowledgement cannot override a server-reported eviction
policy or conceal an ordinary connection failure. A known policy mismatch
prevents use and raises invalid-replay-policy; no usable adapter is returned.

**Accepted residual risk:** manual deletion or replication rollback may remove
nonce records while retaining the marker. Those partial losses cannot in general
be detected. noeviction addresses eviction-driven loss only; it is not proof of
durability, intact history, or linearizability. A marker and quarantine mechanism
must not be advertised as detecting every partial history loss.

### Contract validation checkpoint

The [contract manifest](../tests/fixtures/m3-contract/manifest.json) pins four
independently authored expectation files and two public TLS test files.
The [contract audit](../tests/m3-contract-audit.test.mjs) passed thirteen checks;
the [local HTTPS harness tests](../tests/directory-server.test.mjs) passed six.
These nineteen checks validate expectation consistency and test infrastructure,
not production SSRF defenses or a working Redis adapter.

The local server is test-only and binds to loopback. Its certificate is trusted
explicitly by test clients; certificate and hostname verification stay enabled.
No production private-address exception is authorized. The eventual smoke must
state which network-policy parts use test infrastructure rather than suggest
that a production open resolver accepts loopback origins.

### Conservative directory destination policy

Before implementing the production address classifier, two IANA special-purpose
registry snapshots and 92 independently authored address expectations were
recorded in the [address manifest](../tests/fixtures/m3-address/manifest.json).
Both registries report an update date of 2025-10-09 and were retrieved on
2026-09-19. Original XML bytes, including whitespace, are preserved.

The initial local policy rejects every prefix in those snapshots, including
globally reachable special-purpose exceptions. It additionally rejects IPv4
multicast and limits IPv6 admission to 2000::/3 after exclusions. This deliberately
sacrifices compatibility with some special-purpose services; it must not be
described as IANA declaring every excluded prefix globally unreachable.
Mapped and transition forms do not widen DNS admission. The subsequent explicit
exception approval below narrowly amends special-purpose admission; neither
allow-list nor open mode may disable private-address, transition-address, TLS,
redirect, or resource protections.

The special-purpose registries are not complete allocation or routing inventories.
An admitted address is not proven allocated, reachable, honest, or safe under
deployment-local routing. Custom translation prefixes and sensitive public
destinations still require deployment egress controls.

The independent address audit passed 94 checks: 92 address expectations and
two source/policy checks. An initial audit defect used one Node BlockList for
both families; its mapped-IPv6 matching also rejected native IPv4. Separate
family lists fixed the audit without changing expected outcomes or source bytes.
This audit is not evidence of implemented production SSRF or DNS-rebinding defense.

### M3 address and DNS implementation checkpoint

The address classifier and owned DNS resolver have been implemented internally,
after contract fixtures in **442c2ba** and address fixtures in **d01b774**.
They are not yet exported as a usable network verifier.

The classifier uses bounded numeric address comparison and the pinned conservative
exclusions. IPv4-mapped IPv6 is denied as DNS input; an OS-mapped socket address
may match only an already admitted native IPv4 pin. The DNS layer waits for both
A and AAAA results, rejects mixed forbidden answers, counts occurrences before
deduplication, owns cancellation, and prevents a late result from reviving a
timed-out operation. Queries use absolute DNS names without OS search expansion.
Only ENODATA permits an empty family; other DNS failures reject the resolution.
Multi-label ASCII hostnames without a trailing dot are required at this internal
boundary. These narrower choices prioritize explicit, fail-closed resolution.

Local core type checking and **177 targeted tests** passed: 129 address-policy
tests and 48 resolver tests using controlled doubles, not live DNS.
The full workspace check (build, type checks, unit tests, and existing integration
tests) also passed. A separate run passed **113 checks** covering the independent
address expectations, M3 contract audit, and local HTTPS test harness. These
overlapping runs are not additive test totals.

This checkpoint does not yet implement or prove the complete SSRF defense:
the owned HTTPS connector, actual destination pinning during connection,
proxy handling, bounded body fetching, cache/admission coordination, Redis
adapter and recovery helper, network verifier integration, and smoke-fetch
script remain unfinished. No production private-address exception was added.
The existing offline API and published package version are unchanged.
The maintainer subsequently confirmed that **442c2ba**, **d01b774**, and
**5869d57** were pushed and CI passed. This confirmation does not extend to
subsequent transport work. No assistant push or publication occurred.

### Explicit special-purpose exceptions and proxy transport

The maintainer approved default rejection of IANA special-purpose ranges with
explicitly configurable exceptions. The
[transport contract](../tests/fixtures/m3-transport/contract.json) narrows this
to thirteen named, globally reachable, non-transition registry entries.
There is no arbitrary CIDR override. Exceptions come only from trusted local
configuration, never incoming claims. Private, loopback, link-local, mapped,
translation, multicast, documentation, and reserved destinations remain denied.
Existing default-denial fixtures remain unchanged; explicit exceptions have
separate expectations. Selecting an exception does not change IP-literal origin
rejection or permit a forbidden member in a mixed DNS answer set.

Direct transport must connect to the selected numeric address without another
lookup or pooling, check its socket peer, and authenticate the original hostname
through TLS before sending HTTP request bytes.

An explicitly configured proxy uses a bounded CONNECT tunnel addressed to the
validated numeric target and port 443. Target A/AAAA validation occurs locally
before contacting the proxy. End-to-end TLS still authenticates the original
directory hostname. No environment proxy variables, redirect/authentication
retry, or direct fallback are used. Credentials, if supported, belong only to
the proxy request, never the directory request.

The configured proxy is a trusted infrastructure boundary: the client cannot
observe its remote socket and must trust it to honor the numeric CONNECT target.
This is not the same as directly observing the target peer. The proxy endpoint
is selected by the operator, not by request metadata. Unsupported proxy modes
must fail configuration rather than weaken destination or TLS checks.

The independent transport-contract audit passed fourteen checks before production
implementation. This establishes source/expectation consistency only, not working
HTTPS/proxy protection. Local success tests must use private test-only plumbing,
not a production loopback override. The eventual smoke must distinguish that
test plumbing from its real private-destination rejection check.

### Internal transport implementation checkpoint

Following transport expectations committed in **ce2b7ea**, internal implementation
now includes owned named-exception policies, direct numeric TCP pinning with
pre-TLS peer checks, original-host TLS authentication, explicit HTTPS CONNECT,
a bounded response reader, and single-fetch orchestration. These modules are
not public exports and do not yet constitute a network verifier.

Initial proxy support is HTTPS CONNECT without authentication. Plaintext HTTP,
SOCKS, credentials, unknown proxy fields, environment configuration, TLS-disable
options, retries, pooling, and direct fallback are unsupported. The configured
numeric proxy endpoint may be private because it is operator-trusted infrastructure;
the directory target still passes the same public-address policy before CONNECT.
The proxy must honor the numeric target: its remote peer cannot be observed here.

The response reader accepts only HTTP 200 and the directory media type, rejects
non-identity encoding, and enforces header/body/deadline budgets. A real local TLS
regression exposed Node's default header-count truncation: a trailing encoding
field disappeared after 2,100 small fields despite fitting the byte budget.
The reader now sets the count ceiling from the byte ceiling before sending the
request. Every field consumes more than one byte, so the count cannot truncate
an in-budget section; the parser's byte limit remains active. Additional tests
preserve late restrictive cache directives and reject late duplicate encoding
or media-type fields. Expected fixture bytes were not changed.

Validation passed locally on Windows / Node 22: full workspace build, type checks,
unit suites, and existing integration consumers; separately, **135 checks** across
the M3 source, contract, address, and transport audits and HTTPS test harness.
The response reader has **19 passing real local TLS tests**, and the proxy has
**14 real local nested-TLS tests**. Direct peer/pinning tests use controlled sockets;
single-fetch tests use controlled phase dependencies. Local proxy tests route to
a test server and do not prove public routing or remote proxy compliance.
Overlapping runs are not additive totals, and local results do not establish CI.

Remaining M3 work includes public configuration validation/export boundaries,
aggregate fetch admission and caching, complete remote JWKS validation and
replacement checks, the recovery helper and Redis adapter, full network-verifier
integration, and the maintainer-run smoke. A successful transport result is
untrusted response bytes, not authenticated agent identity. Existing offline
exports and package versions remain unchanged.

### Freshness expectations before cache implementation

The separate [freshness fixtures](../tests/fixtures/m3-freshness/cases.json) pin
36 expectations before implementing reusable freshness. Their independent audit
passed 24 checks locally. This is fixture consistency and arithmetic validation,
not a working cache or network-authentication acceptance gate.

Under the approved fail-closed implementation discretion, ambiguous repeated
freshness fields and malformed explicit metadata grant no reusable freshness;
they never trigger the 60-second fallback. The initial date parser will accept
canonical IMF-fixdate only, including weekday/calendar consistency. Obsolete date
spellings sacrifice compatibility rather than permit parser repair to grant reuse.
When both max-age and s-maxage occur, the shorter lifetime applies. The 300-second
local cap applies before subtracting corrected initial age, not to the remaining
duration afterward. Response delay and subsequent monotonic residence count
against freshness; the exact expiry boundary is not fresh.

These are conservative implementation choices, not newly claimed maintainer
approvals or universal HTTP-cache semantics. They do not decide authentication
from a newly fetched non-reusable response. No-store/private responses cannot
persist a key set; nevertheless a successfully validated replacement must
invalidate older evidence. Full cache/admission coordination, replacement races,
and network-verifier integration remain unfinished.

Transport implementation was recorded in **d64b6f2** after its full local
regression. The freshness importer, manifest, independent audit, and fixture
workflow step are a separate pre-implementation delivery. No earlier fixture
bytes or production code were changed by this freshness preparation.

### Node 20 response-test compatibility correction

The maintainer reported three response-reader test failures on both Windows and
Ubuntu with Node 20. A local Node 20.20.2 diagnostic reproduced the cause in the
test server: calling setHeader before writeHead with a flat header array collapsed
repeated fields. The intended 2,100 occurrences became one before transmission;
repeated Cache-Control and encoding/media-type fields were also overwritten.

The test harness now skips its default Content-Type preset for the four raw-header
cases. Those cases supply their own complete header arrays, preserving repetitions
on the wire. Expected occurrence counts and rejection outcomes are unchanged.
Production code, byte limits, TLS checks, and pinned fixtures are unchanged.

Local Windows validation passed all 4,559 unit tests across 50 files on Node
20.20.2. The 19 response-reader tests also passed on Node 22, and core type checking
passed. These results do not establish that the corrected Ubuntu or remote CI
jobs have passed. No push or publication was performed.

### Maintainer-confirmed transport correction and continued M3 work

The maintainer confirmed green CI following **ac2dcf8** and authorized continued
M3 implementation. This confirmation supersedes the pending-CI status above for
that correction only; it does not establish success for subsequent changes.

The header-truncation finding and its security rationale are also recorded in
[the security document](security-context.md#m3-directory-response-header-completeness).
Silent count-based truncation can conceal encoding restrictions, duplicate fields,
or restrictive cache directives even when the response fits the header-byte
budget. The count ceiling is therefore derived from the byte ceiling while
retaining the parser's hard byte limit. The separate Node 20 test-server correction
preserves intended wire duplicates rather than weakening rejection expectations.

Continued work retains the approved 60-second fallback and negative-cache defaults,
300-second lifetime caps, bounded cache memory, one active fetch per origin and
sixteen globally, and bounded different-origin fetch starts. Complete validated
sets replace prior evidence atomically; removed keys must be checked again before
final authentication. Redis recovery and the full network verifier remain pending.

The requested maintainer-run smoke must demonstrate full verified acceptance after
a directory fetch and an unverified/unknown-key outcome when a host resolves to a
private destination. It must identify test-only local routing explicitly, preserve
TLS identity checks, and not introduce a production private-address override.
Controlled socket tests remain distinct from real transport and authentication
evidence. No push or publication is authorized.

### Malformed Cache-Control persistence amendment

Before committing the cache implementation, three new regression tests exposed
a persistence-policy gap: an unparseable directive list granted zero reusable
freshness but still permitted storage. All-or-nothing parsing could therefore
lose a no-store/private restriction in that same field. This is a retention
problem even though the evidence cannot currently grant fresh authentication.

The separate [security amendment](../tests/fixtures/m3-freshness-amendment/cases.json)
requires both no reuse and no persistence for malformed Cache-Control list syntax.
It explicitly supersedes only the persist expectation of the historical
unterminated-quoted-directive case. Historical fixture bytes and hashes remain
unchanged; the old audit records historical consistency, while the amendment
defines the stricter current expectation. Invalid Date/Age or numeric freshness
values remain separate cases, not silently reclassified by this amendment.

This narrowing follows approved fail-closed implementation discretion and adds
no authentication permission. A valid newer key set must still invalidate older
evidence when the new response cannot be retained. Malformed JWKS does not
constitute valid replacement evidence.

The historical and amendment audits passed 27 checks before applying the fix.
The amendment is committed separately before its implementation. The initial
cache, document validator, and freshness implementation remain work in progress;
three persistence regression tests are expected to fail until that fix lands.

### Internal document, freshness, and cache implementation checkpoint

Following the persistence amendment in **90821c6**, the internal document validator,
freshness calculator, and bounded directory cache are implemented. They are not
public exports and are not yet connected to a network verifier or fetch scheduler.

Remote documents reuse the existing bounded JWKS material/metadata validation
without creating local agent bindings. All entries are checked before replacement;
malformed entries reject the whole set. Existing approved unsupported-key policy
is preserved, so this is not a claim of complete WG conformance for skipped
algorithms. Remote failures expose only a fixed diagnostic, without attacker-chosen
labels, key components, or nested local-loader errors. Loading a known test key
does not grant permission to authenticate with it.

Positive freshness defaults to 60 seconds when explicit freshness is absent and
is capped at a 300-second total lifetime before response-age subtraction. Negative
backoff defaults to 60 seconds and cannot be configured above 300 seconds. Existing
restrictive metadata and monotonic age rules remain active. Malformed Cache-Control
list syntax now prohibits persistence under the separately pinned amendment.

Positive storage is bounded independently by 1,000 entries and 16 MiB of accounted
bytes. Accounting charges encoded document size, per-key and per-entry allowances,
and origin storage; it does not claim an exact JavaScript/native heap measurement.
FIFO eviction invalidates outstanding selections rather than extending evidence.
Negative state contains at most 1,000 origin records, never one record per claimed
key identifier. If live negative capacity is exhausted, one scalar global backoff
covers overflow instead of evicting live origin backoff. This fail-closed choice
can reduce availability for unrelated origins during a flood.

A successfully validated response atomically replaces the old complete set,
including empty sets. A valid replacement that cannot be persisted still
invalidates older evidence; malformed documents do not. Failed refresh backoff
does not mutate prior positive evidence or renew its lifetime. Final selection
checks are synchronous and identity-bound to this cache and its exact entry.
The initial conservative policy rejects every replaced generation, even when
the selected key remains in the new set. Removing and later reintroducing a key
cannot revive an old selection. The eventual verifier must call this check after
awaited work and before constructing success; that integration is still pending.

The cache has an independent monotonic reference, no verification-clock reset API,
and latches clock regression rather than rebasing. Cache-level asynchronous
replacement tests are not full replay-await or network-authentication tests.

Validation passed locally: 633 targeted tests on Node 20.20.2; full Node 22
workspace build/type checks, 5,192 unit tests, and 13 existing integration/consumer
tests. The historical freshness and amendment audits separately passed 27 checks.
These overlapping runs are not additive totals. No new remote CI result is
claimed. Fetch concurrency/rate/queue coordination, Redis recovery and adapter,
network-verifier integration, and the maintainer-run smoke remain unfinished.

### Internal fetch scheduler checkpoint

The internal scheduler implements one active job per canonical origin, at most
16 active workers, at most 64 queued jobs, and at most 32 starts in a sliding
one-second window. Each origin has a 30-second interval between starts, including
after worker failure. Live cooldown records are not evicted to admit new origins;
a defensive 1,000-record ceiling fails closed.

One hundred concurrent same-origin calls share one promise and one worker.
Coalesced callers inherit the original three-second deadline; queue residence
reduces the worker's remaining budget. Individual callers leaving do not cancel
the shared job. This bounded-completion choice avoids disrupting other callers,
but permits the admitted work to complete without interested callers.

A timeout rejects the result and signals cancellation, but an active slot and
origin ownership remain reserved until the worker actually settles. Cancellation
alone is not evidence that underlying work stopped. A permanently stuck worker
therefore reduces availability rather than allowing replacement work to exceed
the concurrency bound. Late completion cannot turn a rejected job into success.
Clock regression latches failure instead of rebasing deadlines or rate windows.

A targeted regression exposed reuse of a batch timestamp when an earlier worker
spent time in synchronous preparation. That shortened the next origin's cooldown.
Each dispatch now resamples the clock and rechecks expiry and the sliding window.
The strengthened regression failed before the fix and passed afterward.

The scheduler is NOT yet connected to the transport, directory cache, or verifier.
Its worker/clock injection is an internal test seam, not a public customization API.
Integration must admit origins before scheduling, perform only one cache commit
per completed shared fetch, include synchronous document validation in the total
deadline, and preserve final evidence/time/epoch checks. Workers must not commit
late response data independently of scheduler completion. Cross-profile sharing
and per-verification fetch budgets remain integration obligations.

Local Node 22 full workspace validation passed builds, type checks, 5,205 unit
tests across 54 files, and 13 existing integration/consumer tests. All 13 scheduler
tests also passed locally on Node 20.20.2. Scheduler tests use controlled workers,
clocks, and timers; they are not real-network or full authentication evidence.
No remote CI result for this checkpoint is claimed. Redis, recovery helper,
integrated discovery/verifier, public exports, and maintainer-run smoke remain
unfinished. No push or publication was performed.

### Approved thumbprint membership and refresh diagnostics revision

The maintainer confirmed that **90821c6**, **e5cd97d**, and **7d3a8d4** were
pushed and CI passed. Cache limits, negative backoff, scheduler limits, and the
malformed Cache-Control persistence restriction were approved.

The maintainer explicitly replaced the earlier conservative generation-equality
rule: final membership checks must require the originally selected RFC 7638
thumbprint in the current fresh, selectable set at the same origin. Neither cache
entry identity nor KeyObject identity is required. Removing and subsequently
reintroducing the same thumbprint before the final check may pass. Selection
ownership, freshness, signature time, epoch, cryptography, and replay gates remain
mandatory. A removed key produces unverified/unknown-key; consumed nonces are
never rolled back.

The [rotation expectations](../tests/fixtures/m3-rotation/cases.json) distinguish:
- (a) Retained thumbprint during a replay await: full network verification succeeds.
- (b) Removed thumbprint during a replay await: unverified/unknown-key.
- (c) Wrong selected material: invalid/key-id-mismatch at the defensive
  assertSelectedKeyIdentity gate, not lookup by a remote kid label.
- (c') A new WG document with kid/material mismatch is rejected in full.
  One sanitized refresh diagnostic reports invalid-jwks, the zero-based key index,
  and a fixed violated-rule description. Old evidence and its age remain unchanged.
  Verification may continue with the old set only while it is fresh and otherwise
  valid; once expired, the result is unverified/unknown-key.

The frozen request catalog has no directory-fetch-failed result: unknown-key
means no usable fresh key evidence; a separate refresh diagnostic explains the
invalid-jwks failure. This is not unsupported-discovery-type or a resource-limit
failure, and remote invalid-jwks is not an operator configuration exception.
Diagnostics identify the entry by bounded index, never echoing remote kid values,
key material, bodies, nonces, backend messages, or nested causes. Observer failures
must not change cache, replay, or verification outcomes.

The independent audit passed fourteen checks before implementation of this
revision. It validates fixture integrity, public thumbprints, and contract
consistency, not execution of the required full network-verifier race tests.
The fixtures and audit must be committed separately before implementation.
Historical fixture bytes are unchanged. No push or publication was performed.

### Integrated discovery service and thumbprint recheck checkpoint

Following the independent rotation contract in **785b46f**, final cache checks
now use the selected thumbprint in the current fresh selectable set at the same
origin. Cache ownership of the selection is still required; generation and
KeyObject equality are no longer required. The original selected key material
remains the verifier's cryptographic input. This implements the approved cache
gate, not yet the full network-verifier race acceptance tests.

The internal discovery service composes the owned transport, scheduler, complete
document validation, freshness calculation, and cache. Coalesced callers share
one validation/commit path and one completion diagnostic. Invocation-owned
single-fetch budgets also charge joining an existing fetch; fresh cache hits do
not spend that allowance. Public verifier integration must create one budget per
invocation and share it across every candidate.

A failed WG refresh reports invalid-jwks with a bounded key index and fixed rule
text, never the remote kid, body, key material, nonce, backend error, or cause.
Prior evidence and its age remain unchanged. Tests distinguish old fresh evidence
from expired evidence; the latter yields no usable key. Observer throws are
contained and synchronous observer reentry is refused. These tests use controlled
transport and do not substitute for the required full-verifier c-prime scenarios.

Configuration is snapshotted before DNS or queueing, rejecting ordinary accessors
and unknown fields. Proxy configuration is validated without first spreading it;
mutation during DNS cannot change the admitted proxy, directory CA, or allowlist.

Document preparation is separated from a cache-owned, single-use commit handle.
The original total deadline is checked after synchronous validation and before
commit. Abandoned or late preparations do not replace prior evidence. A regression
also caught restarting the transport budget at scheduler admission: the scheduler
now receives the service's original monotonic start, including time spent before
queue admission. Exact 1,999/2,000 ms cancellation boundaries cover a request whose
first 1,000 ms has already elapsed. Late worker completion cannot write cache data.

Local validation passed the Node 22 workspace build, type checks, 5,239 unit tests
across 55 files, and 13 existing integration/consumer tests. A separate Node 20.20.2
run passed 607 related tests. The rotation contract audit passed fourteen checks.
Overlapping runs are not additive totals, and no subsequent remote CI success is
claimed.

Remaining obligations include sharing scheduler limits across supported profile
partitions in the final API, full network-verifier identity/time/epoch/replay
integration and race tests, Redis recovery and its adapter, public exports and
consumers, and the maintainer-run smoke. The discovery service currently owns one
format/network-policy partition per instance; separate instances are not proof
of process-global admission bounds. Package versions and offline public exports
remain unchanged. No push or publication was performed.

### Recovery horizon helper implementation checkpoint

The internal recoveryHorizonSeconds helper now implements the previously approved
bound min(maxAgeSeconds, maxLifetimeSeconds) + 2 * clockSkewSeconds. The derivation
from the verifier's exclusive acceptance inequalities is included in source
comments. Existing time-policy validation is reused, and exact integer arithmetic
rejects an unrepresentable result with invalid-time-policy instead of clamping.

Defaults produce 360 seconds. Thirty helper tests cover the independently pinned
examples, the actual signature-time gate at elapsed 330/359/360/361 seconds,
accessor rejection, safe-integer boundaries, and unchanged normal nonce retention.
The helper neither connects to Redis nor starts quarantine. Its default policy
does not authorize an implicit Redis recovery horizon: adapter configuration must
still require the application's explicit value, including its deployment-wide
clock allowance. Redis millisecond and absolute-deadline bounds remain additional
adapter checks.

Final local Node 22 workspace validation passed builds, type checks, 5,269 unit
tests across 56 files, and 13 existing integration/consumer tests. All thirty
helper tests also passed locally on Node 20.20.2. The independent M3 contract audit
passed thirteen checks separately. These results do not demonstrate implemented
Redis quarantine or full network-verifier authentication.

The helper remains internal until the planned public entry/export integration.
The preceding discovery integration is recorded in **e9a4848**, following
rotation fixtures in **785b46f**. Remaining work includes shared admission across
profile partitions, the full network verifier and required rotation races,
Redis adapter/quarantine/eviction admission, public consumers, and the
maintainer-run smoke. Package versions and existing public exports are unchanged.
No push or publication was performed.

### Maintainer-confirmed discovery delivery and next implementation order

The maintainer confirmed push and green CI for **785b46f**, **e9a4848**, and
**87e9998**. The next delivery sequence is:
1. Full network verification and the pinned (a), (b), and (c-prime) race tests.
2. One security-context-associated fetch coordinator shared across profile partitions.
3. Redis replay adapter, Redis-persisted quarantine, eviction-policy inspection,
   explicit acknowledgement where inspection is denied/unsupported, and mandatory
   operator-supplied recovery horizon.
4. Public discovery exports and the maintainer-run three-scenario network smoke.

The original admission timestamp must cross service/scheduler/transport boundaries;
no layer may restart the discovery budget. The regression that passed 3,000 ms to
transport after 1,000 ms had already elapsed is fixed. Document validation is also
charged to the original deadline: preparation is side-effect-free, and a timed-out
preparation must never commit, replace prior evidence, or renew cache freshness.
The detailed rationale is recorded in
[the security document](security-context.md#m3-discovery-deadline-and-cache-commit-boundary).

The network verifier must not wrap a completed offline success and then attach
discovery evidence afterward. Discovery identity, replay admission, current
thumbprint membership, and final clock/epoch checks belong to one authentication
operation. Remote directory evidence must never be labeled local-configuration.

Redis integration tests must use a real Redis GitHub Actions service container
in a Linux job. Controlled backend tests may supplement but cannot replace that
gate. The eventual smoke must demonstrate successful verification after a pinned
local test-directory fetch, private-destination rejection with an unverified
result, and unknown-key after a second fetch confirms key removal. Test-only
local routing must be explicit; no production private-address override is added.
The assistant will not run the maintainer-owned smoke without authorization.

These requirements authorize continued implementation, not claims that these
remaining gates have passed. Stop after every three local commits; no push or
publication is performed by the assistant.

### Internal full network verifier and rotation race checkpoint

The internal network verifier now uses the same authentication lifecycle as the
offline verifier, rather than adding discovery after an offline success. The
shared engine preserves all-pairs parsing, tagged-candidate counting, exactly-one
ambiguity without replay consumption, invocation-local replay groups, aggregate
policy, and final context/time checks. Network candidates additionally check
current same-origin thumbprint membership before replay and after awaited replay
work. Remote identity uses directory-https, never local-configuration; this means
HTTPS origin/key association, not publisher-signed directory proof or authorization.

Network discovery is preceded by profile, component, coverage, metadata and
signature-time checks. Its completion rechecks the operation epoch/time before
cryptography and replay. An invocation owns one discovery budget across all its
candidates. Known test keys remain disallowed unless explicitly permitted.
Offline keys, manual bindings, and application transport injection are rejected
as network-verifier configuration fields. Internal test dependencies remain
outside public exports.

The independently pinned (a)/(b) races now execute full verification for both
profiles, with a real memory-store insertion held before its response while a
second directory fetch retains or removes the key. Retained thumbprints verify;
removed thumbprints yield unverified/unknown-key without rolling back the nonce.
Reintroduction permits key lookup but a repeated signed request remains replayed.
The two WG (c-prime) cases report one sanitized invalid-jwks refresh failure:
old fresh evidence still permits full authentication, while expired evidence
yields unverified/unknown-key without consuming replay.

Seven tests use actual local HTTPS directory responses and nested TLS CONNECT,
including private-address rejection before contacting the proxy. DNS answers
and the proxy's loopback routing are explicitly test-controlled. They prove the
tested authentication and local transport paths, not direct public-address
routing or public-network pinning. Twelve additional boundary tests use controlled
transport with real signatures and contexts, covering unsigned/expired input,
test-key denial, tampering, profile rejection, reset during discovery, one
acceptance among 100 identical requests, and expiry during replay consumption.

Local Node 22 full validation passed builds, type checks, 5,288 unit tests across
58 files, and 13 existing integration/consumer tests. The nineteen new network
tests also passed on local Node 20.20.2. No remote CI success is claimed for these
changes. The network verifier remains internal: context-associated shared
admission across profile partitions, Redis integration, public exports, and the
maintainer-run smoke are still pending.

### Security-context-associated shared discovery checkpoint

One internal discovery transport/scheduler is now associated with each owned
security context through a weak registry. Both profile partitions and compatible
verifier instances sharing that context use the same concurrency, queue, sliding
start-rate, and origin-cooldown state. Recreating a verifier or resetting the
verification clock does not allocate a new coordinator or renew directory age.
These are context-wide bounds, not process-wide or distributed limits across
independent contexts.

The registry rejects incompatible network trust configuration rather than silently
sharing responses across different CAs, proxies, address exceptions, or origin
admission policies. Cache configuration, observer identity, and internal test
dependencies must also match. Explicit versus omitted cache defaults are
conservatively distinct at this checkpoint. Separate trust domains require
separate security contexts. No configuration fingerprint is exposed in diagnostics.

Sharing transport alone was insufficient: a regression showed that a valid empty
refresh requested through one profile left a removed key usable in the other
profile's older cache. Each response now undergoes independent preparation for
both profile formats before any cache commit. After all preparations, the original
discovery deadline is checked again. Valid views commit synchronously without
observer delivery between them; a document invalid under one profile preserves
that profile's prior evidence and age. JOSE acceptance cannot bypass WG kid or
algorithm validation. An empty set valid under both profiles removes keys from
both caches, even if only one profile requested the refresh.

Response distribution is performed once per shared transport promise. The
transport does not retain an unbounded response history. A regression also
verifies that exhausting the deadline during the second profile's preparation
commits neither view and renews neither prior lifetime.

Tests exercise shared 16-active/64-queued/32-starts-per-second limits, one
same-origin transport operation across profiles, format isolation, cooldown and
freshness preservation through context reset, incompatible configuration rejection,
and cross-profile key removal. Two full verifiers sharing a context and nonce
produce one verified result and one replay rejection after a single shared fetch.

Local Node 22 validation passed builds, type checks, 5,303 unit tests across
59 files, and 13 existing integration/consumer tests. A separate local Node
20.20.2 run passed 51 related tests. These overlapping runs are not additive.
The new sharing tests use controlled transport and timing; the existing seven
full authentication race tests retain their documented real local TLS and
test-controlled routing boundary. No remote CI success is claimed for this work.

The earlier network-verifier implementation is recorded in **de12391**.
Redis adapter/quarantine/eviction admission, real Redis service-container CI,
public discovery exports, and the maintainer-run smoke remain unfinished.
No push or publication was performed.

### Internal Redis replay adapter and real-service CI checkpoint

The internal Redis adapter implements explicit mandatory recovery horizon,
noeviction setup admission with narrowly scoped acknowledgement, independent
Redis-time retention, shared quarantine, and atomic replay/quota decisions.
Normal retention remains the exact consume deadline minus dispatch time;
profile and signature label do not partition replay. No retries, offline
queueing, memory fallback, reset, or early-release API are introduced.

The initial representation is a bounded state document plus epoch and absolute
quarantine-until keys in one Cluster hash slot. Lua prepares the replacement
before one MSET writes all three keys. This avoids partially updated quota/expiry
indexes, at the cost of O(n) scans and document rewrites. Capacity and per-key
quota are capped at 10,000; encoded state is capped at 32 MiB. These bounds do not
establish full-capacity performance. Expiry is logical, and recovery keys do not
expire automatically. The security document records storage, privacy, operational
cost, and accepted residual-risk details.

Two deterministic-time regressions executed in real Redis exposed early
quarantine completion and early nonce expiry when observation time was rounded
up. Observation now rounds down; new deadlines round up. Expectations were not
weakened. The test-only script copies replace TIME, not other production logic;
no production clock-override option exists.

Local validation used a dedicated Redis 7.4.8 Docker container pinned to
sha256:8b81dd37ff027bec4e516d41acfbe9fe2460070dc6d4a4570a2ac5b9d59df065.
Twenty-two Redis integration tests passed, including four independent Node
processes issuing 100 identical consumes with exactly one acceptance and 99
replays, actual ACL restrictions, conflicting eviction policy, missing/corrupt
state, preserved quarantine across adapter recreation, and reply loss after a
real committed insertion. Two of those tests use deterministic TIME samples.
One-second live quarantine tests are test policy only; a separate test verifies
the real shared 360-second deadline without waiting six minutes.

An initial connection-per-command concurrency run returned no accepted reply;
later identical runs passed. The exact cause of that first failure was not
established. Concurrency tests now use a preconnected, bounded test RESP client
to separate connection-setup load from atomic consumption. The 100 ms adapter
deadline and exact one-acceptance expectation remain unchanged. The test client
is not shipped or presented as a production Redis client.

The multiprocess test initially exposed tsup declaration issues, then Node 20
Windows entry-path/output-extension differences. The test now invokes the existing
CLI with an explicit working directory and relative input, verifies the emitted
worker, and normalizes its CommonJS extension. Strict TypeScript checking was not
relaxed and no dependency was added.

The Node 22 workspace check passed builds, type checks, 5,355 tests and 13 existing
integration/consumer checks; 22 real-service tests were explicitly skipped in that
ordinary run and executed separately. Following the Windows test-runner fix,
Node 20.20.2 passed all 74 Redis-related checks: 52 controlled admission/input tests
and 22 real-service tests. These overlapping totals are not additive.

A dedicated Linux GitHub Actions job now uses the same digest-pinned Redis service
with Node 20/22/24, requires a valid service port, and executes the real suite.
Remote CI has not yet run for this delivery. Actual Redis restart/failover,
Cluster routing, replication rollback, full-capacity performance and OOM testing
remain unproven; ACL rejection is not a substitute for those tests.

Public exports and consumers, release metadata, and the maintainer-run three-case
network smoke remain pending. The adapter is internal and not security-reviewed.
No push or publication was performed.