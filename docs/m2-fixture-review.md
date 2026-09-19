# M2 fixture delivery and implementation approval record

Updated September 19, 2026. **This document preserves the historical
pre-implementation fixture review.** Statements about proposals below describe
that stage, not outstanding implementation approval.

The maintainer subsequently approved catalog version 1, all four option-A
policies, and explicit operator clock reset. Offline verification, time/replay
integration, and the ESM/CommonJS profile entry are implemented. The full
two-profile round-trip gate passed locally. See the
[current verifier guide](offline-verification.md).

The maintainer confirmed remote CI success for the earlier fixture deliveries
and for core-m2. Those results do not establish CI success for later local work.
Push and publication remain maintainer operations.

The E.2.1 discrepancy is referenced in
[protocol issue #135](https://github.com/webbotauth/draft-ietf-webbotauth-httpsig-protocol/issues/135),
supplied by the maintainer. The [report text](wg-e2-1-report-draft.md) is retained.
The assistant did not submit the issue; its resolution status is not assumed.

## Source pinning and attribution

| Source | Pin | License |
| --- | --- | --- |
| Thibault Meunier / Sandor Major, HTTP Message Signatures for automated traffic | draft-ietf-webbotauth-httpsig-protocol-00, 2026-09-01; SHA-256 3021fd94cdffdb2eb030dec68b1a5c968f2348502dd94c481e2085ec7ddd90a0 | Full text retains IETF Trust terms; extracted code components retain Revised BSD notices |
| Cloudflare and contributors, Web Bot Auth | Commit acfb1f2270b9473ae65a15674995e0b2f3b6ab0c, documentation date 2026-07-01; SHA-256 c4aeeef723df97b020ecc4d9e680b77b5bfb6c214a6443b0fb7f00efd7e422f7 | CC BY 4.0 |
| Independently authored agentsig cryptographic and policy data | Fixture commits, per-file hashes and byte lengths | MIT; all included private keys are public test material |

Original sources and notices:

- [IETF WG-00](https://www.ietf.org/archive/id/draft-ietf-webbotauth-httpsig-protocol-00.txt)
- [Immutable Cloudflare source](https://github.com/cloudflare/cloudflare-docs/blob/acfb1f2270b9473ae65a15674995e0b2f3b6ab0c/src/content/docs/bots/reference/bot-verification/web-bot-auth.mdx)
- [Cloudflare CC BY 4.0 license](../tests/fixtures/m2/sources/cloudflare-LICENSE.txt)
- [IETF attribution and Revised BSD notice](../tests/fixtures/m2/sources/IETF-NOTICE.txt)
- [File manifest](../tests/fixtures/m2/manifest.json)

Cloudflare material is not relicensed. The source body is preserved unchanged;
the §4.4 code block is also extracted separately. Its display fixture preserves
the block content. A separate header fixture joins only indented metadata
continuation lines. These transformations are recorded in the manifest.
No IETF/Cloudflare endorsement or affiliation is implied; warranty disclaimers
remain intact.

## Vector inventory

**WG-00 contains real cryptographic vectors.** The published 64-byte Ed25519
signatures in E.2.1, E.2.2, and E.2.3 were independently verified with the
RFC 9421 B.1.4 public key, without the agentsig engine.

| Data | Independent crypto result | M2 interpretation |
| --- | --- | --- |
| WG E.2.1 | Valid; 375-byte base | sig2 label differs from agent2 member. Method/target coverage is also missing and lifetime exceeds M2 policy. Original bytes remain unchanged; not a positive M2 acceptance vector. |
| WG E.2.2 | Valid; 349-byte base | Legacy String format; missing method/target coverage and long lifetime. Not the new WG signer form or default M2 acceptance. |
| WG E.2.3 | Valid; 298-byte base; published body digest matches | Directory response archived for crypto inventory only. No M2 body-digest or directory verification feature is inferred. |
| Cloudflare §4.4 | Exact display retained; joined signature headers match WG E.2.2 | Documentation serialization fixture, not a positive M2 acceptance fixture. Without authoritative target/key context it is not a complete HTTP request. |
| Cloudflare §2 | Present in source snapshot; explicitly illustrative | Not used as a cryptographic golden vector. Do not incorrectly extend this warning to §4.4. |
| WG E.1 RSA examples | Inventoried, not cryptographically executed | Outside Ed25519 scope |
| Two agentsig profile fixtures | Signed with a separate real test key; independent verification and deterministic resigning match | Method, target URI, correct agent coverage, and 60-second lifetime. Subsequent full-verifier tests separately confirmed acceptance. |

The [vector inventory](../tests/fixtures/m2/vector-inventory.json) and
[policy expectations](../tests/fixtures/m2/policy-cases.json) are separate.
The deterministic test key is public and unsuitable for production.

Both generated profiles use the same nonce. Each positive expectation assumes
a **separate clean store**. Sequential verification against the same context
must reject the second request as replay; profile name must not partition the
replay key.

The E.2.1 issue reference does not justify replacing its published signature,
base, or header bytes. Any corrected upstream vector requires separate provenance.

## Independent audit versus implementation tests

The [M2 audit](../tests/m2-fixture-audit.test.mjs) uses only Node standard modules.
It performs no network access and imports neither agentsig nor import-script
helpers. It checks source/fixture equality, manifest coverage, thumbprints,
key/header/signature consistency, and three Git line-ending settings.

The original fixture delivery passed 12 audit tests locally on Windows / Node 22.
Later revisions added E.2.1 label-binding and approved policy-boundary checks.
A passing fixture audit proves expectation consistency, not execution of the
production verifier, concurrent replay store, or quota implementation.

The following expectations were committed before their implementations and
subsequently exercised through dedicated tests:

- One acceptance and 99 replays among 100 concurrent identical requests.
- No consumption after invalid crypto or failed identity binding.
- Global exhaustion mapped to unavailable; separate per-key quota outcome.
- No live-entry eviction.
- Explicitly unprotected optional-nonce success.
- Tag-based candidate selection, independent of label names.
- Results for all selected candidates, with default aggregate ambiguity rejection.
- Future-created timestamps, exact time boundaries, and conservative retention.

Current delivery results are recorded in [deferred work](deferred.md).

## Frozen closed code catalog

The following sets match the
[machine-readable catalog](../tests/fixtures/m2/policy-cases.json).
This pre-implementation contract was subsequently **approved and frozen as
version 1**. Adding, removing, or renaming codes requires separate approval and
release notes. Reason codes are not arbitrary text; bounded diagnostics may
be supplied separately. Candidate labels exist for correlation, not selection.

### Unsigned — two codes

- no-signature
- no-web-bot-auth-candidate

The second applies only after successful signature-header parsing finds no
matching tag. Malformed or partial headers never become unsigned traffic.

### Verified — two codes

- nonce-consumed — replay-protected success.
- nonce-absent-optional — explicit optional policy, without replay protection.

### Invalid — 20 codes

- malformed-signature
- malformed-agent
- ambiguous-signatures
- ambiguous-profile
- agent-label-mismatch
- agent-binding-mismatch
- missing-required-parameter
- invalid-parameter
- invalid-time-range
- created-in-future
- signature-expired
- signature-too-old
- lifetime-exceeded
- insufficient-coverage
- key-id-mismatch
- algorithm-mismatch
- signature-mismatch
- nonce-required
- nonce-invalid
- replay-detected

### Unverified — 11 codes

- unsupported-profile
- unsupported-algorithm
- unsupported-discovery-type
- profile-disallowed
- unknown-key
- agent-binding-missing
- resource-limit
- replay-store-unavailable
- per-key-quota-exceeded
- clock-unavailable
- test-key-disallowed

Unverified means authentication was not completed; it does not mean every
reason is an infrastructure malfunction. Per-key quota therefore has its own
code. Global exhaustion and store failure both map to unavailable at the store
boundary; there is no separate full/capacity code. Rejected candidates carry no
verified identity.

### Classification distinctions

- **agent-binding-missing:** required local URL binding is absent. Plain
  thumbprint mode does not require a binding.
- **agent-binding-mismatch:** an association exists for the selected key but
  disagrees with the signed origin; invalid, with no nonce consumption.
- **algorithm-mismatch:** a known HTTP algorithm contradicts selected trusted
  key material. Selected Ed25519 plus declared RSA-PSS is invalid without a
  crypto attempt.
- **unsupported-algorithm:** an unsupported or unknown algorithm with no
  established selected-key contradiction. Known contradictions take precedence;
  compatibility of unknown names is never guessed. Invalid static JWKS remains
  a separate configuration error.
- **aggregate-policy-required was removed before freezing.** Explicit multiple
  mode defaults to all. Invalid modes, aggregate rules, or contradictory
  configuration produce invalid-candidate-policy.

### Configuration errors — eight codes

- invalid-jwks
- invalid-key-configuration
- invalid-agent-binding
- invalid-time-policy
- invalid-replay-policy
- invalid-resource-limits
- invalid-clock-configuration
- invalid-candidate-policy

These are setup errors, not request results. Unexpected programming errors are
not converted to ordinary invalid outcomes.

### Atomic store outcomes — four codes

- accepted
- replayed
- unavailable
- per-key-quota-exceeded

There are 35 verification reason codes, eight configuration codes, and four
store outcomes. Identical spelling across contracts does not merge those
contracts. Verified identity is a key thumbprint or, with explicit binding,
a directory URL whose trust source is local configuration, not TLS/directory proof.

## Six approved candidate/store decisions

1. Default multiple-candidate rejection evaluates every candidate's crypto,
   identity, and time gates; consumes no nonce; returns ambiguous-signatures.
2. Explicit multiple mode defaults to all; any requires explicit selection.
   Neither returns early on success.
3. Eligible candidates sharing scope/key/nonce within one invocation share a
   single atomic consume. Separate requests never share acceptance.
4. Per-key quota spans the entire store instance across all scopes.
5. Store decision order: expire → replay → per-key quota → global capacity.
6. Candidate eligibility is internal only. Public results remain unsigned,
   verified, invalid, or unverified. Pre-replay success never leaks as verified.

Every selected label retains a result. In the default ambiguous case,
otherwise-eligible candidates receive ambiguous-signatures because replay was
not completed. Independently rejected candidates retain their actual reasons.
The internal evaluation object is not exported.

## Historical four options — option A was subsequently approved

These alternatives preserve the original decision record. All four A options
were approved before implementation, and boundary fixtures were committed
separately. Additional reset/failure details appear in the
[security context contract](security-context.md).

| Decision | Approved A | Benefits / costs | Historical B alternative |
| --- | --- | --- | --- |
| Clock anomalies | Initial wall reference plus monotonic elapsed time; clock-unavailable for absolute drift over a separate configurable 30-second threshold, invalid samples, or monotonic regression | Verification time does not silently move backward; forward wall jumps cannot mass-expire records. Requires monotonic timing and synchronization; drift can reduce availability. | Wall clock with a previous-time high-water mark, rejecting every backward step; simpler but sensitive to small NTP adjustments, while forward jumps still require protection. |
| Discovery types | WG directory (default when absent) and Cloudflare legacy String only; reject other discovery types explicitly | Small offline scope; does not accept otherwise legitimate JWKS-URI/CIMD candidates | Explicit local JWKS-URI/CIMD associations without networking; broader identity semantics and URL/fixture work |
| Test keys | Deny RFC B.1.4 and repository M2 public test-key thumbprints by default; explicit test override | Reduces accidental production use; cannot detect every compromised/public key | Leave enforcement entirely to applications; fewer special cases but greater example-key misuse risk |
| Secondary limits | JWKS 256 KiB / 64 keys; 16 candidates; nonce 1–256 printable ASCII bytes; generated nonce 32 random bytes in unpadded base64url; scope 1–256 ASCII bytes; 64 bindings; 2,048 ASCII bytes per URL | Bounded resource exposure; can reject large otherwise-valid inputs; syntax does not prove nonce entropy | 1 MiB / 256 keys / 64 candidates / 1,024-byte nonce and scope / 256 bindings / 8,192-byte URLs; greater compatibility and resource costs |

Clock option A performs no nonce consumption or expiry cleanup while unhealthy.
Recovery uses the original reference; wall drift returning within the threshold
can recover with valid monotonic samples. No automatic rebase/reset or store
clear occurs. Monotonic regression requires explicit operator intervention.
Verifiers sharing a context share its clock domain. Restart loses memory history.

JWKS text limits apply before parsing. Object inputs use bounded traversal rather
than unbounded serialization followed by a size check. Core's separate 16 KiB
budgets remain in force; raising profile limits does not widen them.
Missing required binding is unverified; an existing mismatched binding is invalid.
Secondary limits are configurable local budgets, not protocol MUST requirements.

## Execution and scope boundaries

Run the independent audit with the root fixture-audit commands or directly
through the [audit test](../tests/m2-fixture-audit.test.mjs).

The [import script](../scripts/import-m2-fixtures.mjs) uses previously downloaded,
hash-checked sources. Reimported files must be deterministic. The audit does not
reuse import helpers. The original M1 manifest and pinned bytes remain unchanged.

This review is a historical source/approval record, not permission to add network
features. The planned M3 source excerpts and Appendix F.3 JSON vectors require
their own commit/license pinning and discrepancy review in the next stage.