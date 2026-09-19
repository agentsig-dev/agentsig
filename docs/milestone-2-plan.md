# M2 — offline Web Bot Auth profiles

Updated September 19, 2026. **The offline verifier and profile exports are
implemented; the full local round-trip acceptance gate passed.** The maintainer
confirmed green core-m2 CI/fixture workflows and subsequently accepted the
two-profile smoke test.

Verification catalog version 1 is frozen. Code additions, removals, and renames
require separate approval and release notes. Historical proposals and
alternatives below are retained as design history, not outstanding approval.

Current contracts:
[JWKS loading](jwks-loading.md),
[profile identity](profile-identity-policy.md),
[signing](profile-signing.md),
[clock/replay context](security-context.md), and
[offline verification](offline-verification.md).

Completed M2 local validation passed 4,284 unit tests, 13 integration tests,
60 additional independent fixture audits, and the M1 audit. Four independent
golden signer outputs passed full offline verification across both profiles.
These results do not imply complete protocol conformance, a security review,
or remote CI success for later changes.

Repository: https://github.com/agentsig-dev/agentsig
npm scope: @agentsig.

## 1. Scope

M2 builds on the pure M1 engine through the separate @agentsig/core/profiles
entry point. No new npm package is required. ESM/CommonJS runtime exports and
declarations were tested through real package consumers.

M2 includes two pinned profiles, profile signing/verification, time policy,
manually supplied public JWKS, an atomic replay interface, bounded memory
storage, and closed result codes.

Network access, DNS, directory fetching/caching, redirects, automatic JWKS
refresh, framework adapters, a fetch wrapper, CLI, and live Cloudflare testing
are outside this milestone. Push and publication remain maintainer operations.

## 2. Approved decisions

- Default signer profile: **ietf-wg-protocol-00**.
- Explicit compatibility signer profile: **cloudflare-docs-2026-07-01**.
- No automatic downgrade or silent retry.
- The verifier recognizes both wire forms and reports each candidate's profile.
- A malformed header or failed signature is not retried under another profile.
- Both profiles require a nonce by default; optional policy must be explicit.
- Default signing lifetime: 60 seconds; maximum lifetime and age: 300 seconds;
  signature clock skew: 30 seconds.
- Policies are configurable per profile and are not protocol requirements.
- Only Ed25519 through Node's built-in cryptography; no clock/network/store side
  effects are added to the pure M1 entry.
- Independent fixtures and expected outputs precede implementations in separate
  commits.

## 3. Profile rules and source gate

| Profile | Source behavior | Pinned reference |
| --- | --- | --- |
| ietf-wg-protocol-00 | Signature-Agent Dictionary; signed member matching the signature label; authority or target-URI minimum coverage; required metadata | [WG-00 §§5.2–5.5, September 1, 2026](https://www.ietf.org/archive/id/draft-ietf-webbotauth-httpsig-protocol-00.html#section-5.2) |
| cloudflare-docs-2026-07-01 | Quoted Structured String; entire agent header covered; documented Cloudflare rules | [Cloudflare §4, documentation date July 1, 2026](https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/#4-after-verification-sign-your-requests) |

The source gate requires the WG text, real vectors where available, and an
immutable Cloudflare commit/snapshot with license and SHA-256 provenance.
A source that cannot be tied to the named date must not silently be labeled as
that historical source. Illustrative signatures are not cryptographic golden
vectors. Independently authored agentsig fixtures are labeled as such and
verified using Node cryptography without production code.

Parsing discovery metadata does not imply network discovery. The approved M2
choice supports only WG directory discovery, including its default when type
is absent, and the Cloudflare legacy String form. Other discovery types are
explicitly unsupported; URLs are not guessed or fetched.

Historical alternative: accept JWKS-URI/CIMD only through explicit local
bindings. That would require broader identity semantics and URL-normalization
fixtures, even without downloading any document. It was not selected for M2.

## 4. Offline keys and identity

JWKS comes only from trusted application configuration, never from incoming
request key material. Configuration is snapshotted, validated, and exposed as
an immutable loaded view; caller mutation does not silently change selected keys.

Selection uses the recomputed SHA-256 JWK thumbprint, not a URL or arbitrary key
label. Usable verification keys are public OKP/Ed25519 with canonical base64url
and 32-byte public material. Private fields are rejected. Recognized,
structurally valid unsupported keys may be reported and skipped under the
approved loading policy; malformed entries reject the entire set.

Usage and operation metadata must satisfy the approved policy. JOSE JWK algorithm
names and HTTP signature algorithm names are different vocabularies. See the
[source-backed loading matrix](jwks-loading.md) rather than assuming aliases.

Two identity modes are approved:

- **Default key identity:** a manually supplied JWKS establishes a verified key
  thumbprint. The signed Signature-Agent URL remains a claim, not a verified
  domain or operator.
- **Explicit local binding:** the application configures key-thumbprint/origin
  associations and selects URL-binding mode. Success reports local configuration
  as its trust source, not live TLS or protocol directory proof.

Finding the same key at another URL does not automatically establish a binding.
Operator names are application data, not inferred from cryptography.

Static rotation creates a new verifier/key snapshot while retaining the shared
security context and replay namespace. Rotating keys must not itself delete
previously accepted nonces.

## 5. Time policy and retention

Signed timestamps are safe integer Unix seconds within the SF Integer range.
Creation, expiration, and key identity are required. A validation phase uses one
healthy clock sample. Approved acceptance inequalities are:

- Creation is at most current time plus skew.
- Expiration is strictly after creation.
- Lifetime is at most the configured maximum lifetime.
- Current time is strictly before expiration plus skew.
- Current time is strictly before creation plus maximum age plus skew.

End boundaries are exclusive so a record expiring at the boundary cannot
reopen an accepted replay window. Comparisons and retention arithmetic must not
silently overflow or clamp values.

Approved conservative retention is the greater of consumption time and creation
time, plus maximum age and skew. It is not a fixed 330-second TTL. With default
limits, a creation time accepted 30 seconds into the future may require retention
until 360 seconds after initial consumption.

Historical alternatives, not selected:

- Apply skew only to future creation and never extend expiration: tighter expiry,
  but more rejection under distributed clock differences.
- Retain only until the earlier of expiration and creation plus maximum age,
  plus skew: lower memory use, but requires compatible policies across verifiers.

The verifier rechecks time after awaiting replay consumption and at the final
result gate. A signature that expires during the await is not accepted.
Consumed nonces are not rolled back; availability is sacrificed rather than
reopening replay windows.

Clock health uses an initial wall reference plus monotonic elapsed time, with
an independently configurable 30-second drift threshold. This policy was
approved and implemented. Signature skew and clock-health thresholds are
different settings. There is no automatic rebase.

Wall drift can recover against the original reference; monotonic regression
requires explicit reset. Explicit reset can destroy memory history and reopen
a replay window. See the [context contract](security-context.md).
Restart and separate processes do not preserve/share default memory history.

## 6. Atomic replay interface and bounded memory

The [store contract](../packages/core/src/profiles/replay-store.ts) receives
scope, verified key thumbprint, nonce, healthy dispatch time, and conservative
retention deadline. It returns one of accepted, replayed, unavailable, or
per-key-quota-exceeded through a Promise.

Global capacity exhaustion returns unavailable; there is no separate capacity
code. Per-key quota is distinct and is not treated as a backend malfunction.
Checking and inserting must be one atomic operation, not separate queries.

Scope is an explicit application trust namespace, never derived from a claim.
The storage key is an injective encoding of scope/key-thumbprint/nonce. Profile
and signature label do not partition protection. Related verifiers must share
the intended security context and scope.

The quota is per verified key thumbprint across the whole store, including all
scopes. Decision order is expiry cleanup, replay, per-key quota, global capacity,
then insertion. Eligible candidates in one invocation sharing the same tuple
share one consume outcome; separate invocations never share acceptance.

The flow is bounded parsing, profile/coverage checks, trusted key selection,
identity/crypto/time eligibility, atomic consumption, and post-await/final
time and epoch checks. Failed crypto or identity binding consumes nothing.
Optional-nonce mode relaxes only absence; a present replay, store failure, or
capacity failure cannot become a success.

Memory check-and-insert contains no await. Capacity is bounded; expired entries
are cleaned, but live entries are not LRU-evicted. Defaults are 10,000 total
records and 1,000 per key. These quotas are not complete DoS protection:
multiple trusted keys and cryptographic CPU costs remain application concerns.

An observer of a valid request can race its first use. Nonce checks do not prove
that the immediate sender is the private-key holder and do not themselves bind
the body, method, or path; signature coverage is a separate requirement.

Approved configurable secondary defaults:

| Budget | Default |
| --- | ---: |
| Received nonce | 1–256 printable ASCII bytes |
| Generated nonce | 32 random bytes, unpadded base64url |
| Local JWKS | 256 KiB / 64 keys |
| Selected profile candidates | 16 |
| Local scope | 1–256 ASCII bytes |
| Agent bindings | 64 |
| Agent URL | 2,048 ASCII bytes |

These are local budgets, not protocol MUST requirements. Valid nonce syntax
does not establish entropy. Separate core limits remain in force.

## 7. Closed result model

The initial uppercase/free-text proposal was superseded by the
[frozen lowercase catalog](m2-fixture-review.md) and
[machine-readable policy fixture](../tests/fixtures/m2/policy-cases.json).
The [implemented result types](../packages/core/src/profiles/verification-types.ts)
retain exactly four external states: unsigned, verified, invalid, and unverified.

Verified identity exists only on a successful candidate. An untrusted agent claim
is never placed in a verified-identity field on rejection. Configuration errors
and store outcomes are separate closed contracts. A failed aggregate can contain
a successful candidate without granting aggregate acceptance.

Important classifications:

| Boundary | Result |
| --- | --- |
| No matching protocol tag after valid parsing | unsigned / no-web-bot-auth-candidate |
| Default multiple-candidate ambiguity | invalid / ambiguous-signatures |
| Global exhaustion or backend failure | unverified / replay-store-unavailable |
| Per-key quota | unverified / per-key-quota-exceeded |
| Required local binding absent | unverified / agent-binding-missing |
| Existing key binding disagrees with signed URL | invalid / agent-binding-mismatch |
| Known HTTP algorithm contradicts selected trusted key | invalid / algorithm-mismatch |
| Unsupported algorithm without established contradiction | unverified / unsupported-algorithm |
| Invalid aggregate configuration | thrown invalid-candidate-policy |

### Approved metadata classification

| Gate | Passing case | Failure |
| --- | --- | --- |
| Wire/SF type | Expected metadata types | Wrong type: whole-request malformed-signature |
| Required metadata | Creation, expiration, and key identity present | missing-required-parameter |
| Profile key-identity representation | Canonical unpadded base64url decoding to 32 bytes | invalid-parameter with a fixed violated-rule diagnostic |
| Local lookup | Recomputed thumbprint found | unknown-key |
| Selected-key binding | Recomputed selected public-key thumbprint agrees | key-id-mismatch; defensive and not expected on the normal loader path |

Both profiles have positive and negative examples for each gate in the
[metadata fixtures](../tests/fixtures/metadata/cases.json).
A missing or different tag does not select a candidate. Missing required nonce
and present invalid nonce remain nonce-required and nonce-invalid.

Thumbprint requirements come from
[WG §5.2](../tests/fixtures/metadata/sources/wg-5.2.txt) and
[Cloudflare §4.2](../tests/fixtures/metadata/sources/cloudflare-4.2.mdx), not generic
RFC 9421 key-identifier syntax.
[RFC 9421 §3.2](../tests/fixtures/metadata/sources/rfc9421-3.2.txt) steps 1–3 require
parsing and failure of the relevant signature on invalid input. Rejecting the
whole call for any malformed pair is the retained local M1 all-pairs contract,
not a claim that RFC 9421 unconditionally rejects every unrelated signature.

Unexpected programming errors propagate rather than becoming ordinary invalid
results. Success reports profile, label, covered components, key identity,
verification time, and trust source. It is not authorization.

### Candidate selection and aggregation

Select by tag equal to web-bot-auth, never by label name. Evaluate every selected
candidate and preserve results in header order, including rejected ones.
Default exactly-one policy rejects multiple candidates without nonce consumption;
otherwise-eligible internal results are mapped to ambiguity, not public success.

Explicit multiple mode defaults to all; any is an explicit alternative.
Both evaluate all candidates with no first-success shortcut. Rejection never
removes a candidate from the count. CandidateEvaluation remains internal.

## 8. Security approval history

| Decision | Approved outcome | Boundary |
| --- | --- | --- |
| JWKS identity | Default thumbprint; URL only with explicit local binding | No TLS/directory proof implied |
| Required coverage | Method + complete target URI + profile agent component | Stricter than protocol minimum |
| Body | No body-digest comparison in M2 | Archiving a directory-response vector adds no feature |
| Time and retention | 60/300/300/30 defaults and conservative retention | Exact boundaries pinned before implementation |
| Capacity | 10,000 global; 1,000 per key across scopes; no live eviction | Expire → replay → quota → capacity |
| Multiple signatures | Tag selection, every candidate retained, exactly-one by default | Explicit all/any; shared consume only within one invocation |
| Public test keys | Deny known fixture thumbprints by default | Explicit test override only |
| Discovery | Directory form only in WG; legacy String for Cloudflare | No network fallback |
| Clock recovery | Monotonic-reference health with explicit destructive reset | No automatic rebase |

Historical alternatives remain in the [fixture review](m2-fixture-review.md).
Choosing another security behavior requires explicit approval, not a silent
reinterpretation of these records.

## 9. Fixture-first sequence and acceptance gates

The approved implementation sequence was:

1. Approve security decisions and API boundaries.
2. Commit pinned profile sources, independent wire/base/signature expectations,
   real-vector versus illustrative-example distinctions, licenses, and hashes.
3. Record time boundaries, JWKS negatives, and replay event sequences as data,
   without deriving expected values from production code.
4. Extend independent audits; leave M1 fixture bytes unchanged.
5. Implement profile codecs, thumbprints, and bounded local JWKS validation.
6. Implement configurable time policy with injected clocks.
7. Implement atomic replay and bounded memory.
8. Integrate the closed result model and offline verifier.
9. Run M1 regressions, fixture/negative/property tests, and real ESM/CommonJS
   consumers; report actual local versus remote CI results.

Required coverage includes no downgrade, profile-specific grammar, label/member
mismatch, exact timestamp boundaries, clock anomalies, future-created retention,
one acceptance among concurrent identical requests, no consumption for rejected
crypto/identity, optional-nonce reporting, capacity/backend failures, scope/key
separation, cross-profile replay protection, public-only JWKS, and prevention
of automatic URL identity inference. Unknown keys must not fall back to fetching.

## 10. Historical source delivery and subsequent completion

The first M2 delivery contained source snapshots and independent fixtures, not a
verifier, time policy, or replay implementation. All three WG E.2 Ed25519 vectors
were independently verified. E.2.1's sig2/agent2 mismatch was preserved, with
cryptographic validity distinguished from profile/M2 policy acceptance.

Cloudflare was pinned at **acfb1f2270b9473ae65a15674995e0b2f3b6ab0c**.
SSRF, DNS rebinding, HTTP caching, and automatic rotation decisions were deferred
to a later network milestone. E.2.1 is a label-binding-stage negative fixture,
not an assertion about the full verifier's first failure amid other violations.

The maintainer supplied
[upstream issue #135](https://github.com/webbotauth/draft-ietf-webbotauth-httpsig-protocol/issues/135);
the [report text](wg-e2-1-report-draft.md) is retained. No resolution is assumed.

Subsequent approvals froze the catalogs and policies. Helpers, signer,
clock/reset coordination, real memory storage, full verification, and profile
exports were implemented. Independent fixture audits and actual integration
tests remain separate evidence; neither substitutes for the other.

Network source excerpts and Appendix F.3 JSON vectors requested for M3 will be
pinned and reviewed separately after the current documentation patch is delivered.
No network policy is selected by this translation.