# Offline Web Bot Auth verification

Updated September 19, 2026. Signing/verifying integration for both pinned
profiles and ESM/CommonJS consumer tests passed locally. The maintainer also
confirmed core-m2 CI/fixture workflow success and the two-profile smoke test.
The package remains pre-release in maturity and is not independently
security-reviewed. No production-readiness or live Cloudflare acceptance
claim is made.

## Package entry and basic flow

The package is @agentsig/core; its profile subpath is @agentsig/core/profiles.
[Conditional exports](../packages/core/package.json) provide separate ESM/CommonJS
runtime and declaration paths. The pure RFC 9421 entry remains available.
The [public profile API](../packages/core/src/profiles.ts) does not export the
internal coordinator, operation leases, or pre-verification identity proposals.

1. Prepare trusted local public JWKS and an explicit application replay namespace.
2. Use [createSecurityContext()](../packages/core/src/profiles/security-context.ts:91)
   to create a long-lived shared context, or use the verifier's default
   memory-backed context.
3. Create the verifier once with
   [createOfflineVerifier()](../packages/core/src/profiles/verifier.ts:89).
   Do not recreate it for every request.
4. Pass the externally observed method, complete absolute target URI, and
   ordered header occurrences to
   [OfflineVerifier.verify()](../packages/core/src/profiles/verification-types.ts:106).
   Preserve the original values, including signature headers.
5. Evaluate the aggregate
   [VerificationResult](../packages/core/src/profiles/verification-types.ts:56)
   under the application's acceptance policy. Authentication does not grant
   authorization, reputation, or a rate-limit exemption.

Create a signer with
[createWebBotAuthSigner()](../packages/core/src/profiles/signer.ts:39).
The caller must append its three returned headers to the same, unchanged request.
The signer does not merge existing signature headers. See the
[signing contract](profile-signing.md).
[Executable consumer examples](../tests/profile-consumer.test.mjs) exercise the
flow using real package names in both module formats.

## Configuration and identity

[OfflineVerifierOptions](../packages/core/src/profiles/verification-types.ts:82)
accepts local JWKS, an explicit replay namespace, an optional shared context,
candidate policy, allowed profiles, per-profile time/nonce policies, and
explicit local identity bindings. Configuration errors are thrown during setup;
they are not evidence that a remote request is invalid.

Keys are loaded only from trusted local configuration. Incoming requests cannot
supply trusted key material. Unknown keys do not trigger network discovery.
[loadJwks()](../packages/core/src/profiles/jwks.ts:91) provides bounded public-key
loading and reporting; successful loading is not authentication. Generic JWKS
and WG directory formats are explicit alternatives:
[JWKS loading policies](jwks-loading.md).

Default success establishes only the verified key thumbprint. The signed agent
URL is separately reported as a claim, not proof of domain or operator ownership.
Directory URL identity requires explicit binding mode and a matching configured
thumbprint/origin relationship. Its trust source is local configuration, not
DNS, TLS, or a signed directory-response proof.

On key rotation, pass the same security context and replay namespace to the new
verifier. Separate contexts, processes, and workers do not share default memory
history. Recreating a context does not transfer old replay records.
Known public test keys are denied by default. Explicit test permission bypasses
only that denial, not other checks. The list does not cover every compromised key.

## Profiles and results

The signer defaults to WG-00; the Cloudflare documentation profile requires
explicit selection. The verifier recognizes both grammars by default, with an
optional narrower allowed-profile list. Header form selects one grammar;
failure never triggers a retry under the other profile.

Both profiles require method, complete target URI, and the profile-specific
agent component. Origin comparison never rewrites received signed bytes.
[Identity and coverage policies](profile-identity-policy.md) distinguish
protocol requirements from stricter local choices.

Candidates are selected by the protocol tag, not the signature label.
Raw duplicate screening and parsing of every signature pair precede selection.
A malformed unrelated pair rejects the whole request under the local M1
all-pairs contract.

The default policy requires exactly one candidate. All selected candidates are
evaluated when several are present; rejection does not remove a candidate from
the count. The aggregate is an ambiguity rejection, no nonce is consumed, and
pre-replay eligibility is never exposed as verified.
Explicit multiple-candidate mode defaults to requiring all candidates to succeed;
accepting any successful candidate requires a separate choice. Neither mode
returns early on success.

All candidate results remain in header order. A failed aggregate can contain a
successful candidate; that candidate's success does not substitute for aggregate
acceptance. Multiple successes are not reduced to a single operator identity.
If any successful candidate lacks a nonce, the success summary reports
nonce-less success; inspect each candidate's replay protection separately.
Unexpected programming errors are not hidden as generic rejections.

## Replay, time, and reset

Nonce presence is required by default. Optional mode relaxes only absence;
replay or store failure for a present nonce cannot become success.
Within one verification invocation, eligible candidates with the same
namespace/key/nonce tuple share one atomic consume outcome. Separate requests
never share acceptance. Profile and label do not partition replay protection.

Retention uses the healthy dispatch-time sample:
the greater of creation and consumption time, plus maximum age and skew.
A shared group uses the longest required deadline among its eligible members.
Time is checked before dispatch, after awaiting consumption, and at the final
result gate. A consumed nonce is never rolled back after expiry or reset.

The default memory limits are 10,000 records in total and 1,000 per key across
all namespaces. Live entries are never evicted. Global exhaustion returns a
store-unavailable result; per-key exhaustion has a distinct quota result.
These storage limits are not application rate limiting.

The [shared clock/replay context](security-context.md) combines monotonic
references, health checks, and operation epochs so stale pending work cannot
produce verified results.
**Explicit clock reset is destructive even while healthy: clearing memory can
allow a previously accepted, still-valid request again.**
There is no automatic reset. A previously dispatched independent-store operation
may be impossible to cancel; the old local verification still cannot succeed.

## Validation and limits

Completed M2 local Windows / Node 22 validation passed 4,284 unit tests,
13 integration tests, 60 additional independent fixture audits, and the M1 audit.
The [round-trip acceptance gate](../packages/core/test/profile-verifier-roundtrip.test.ts)
requires full verification and replay rejection for four golden signer outputs
across both profiles. For each profile, 100 concurrent identical requests
produced one acceptance and 99 replay rejections.
[Multiple-candidate tests](../packages/core/test/profile-verifier-multiple.test.ts)
cover shared consumption, ambiguity, aggregation, expiry, and reset races.

The maintainer confirmed remote core-m2 CI/fixture success and later confirmed
the smoke script's verified → replay-detected → signature-expired sequence for
both profiles. These confirmations do not establish CI success for later changes.

Network discovery, SSRF/DNS protection, directory caching, body-digest comparison,
countersignatures, framework adapters, and CLI functionality are outside M2.
No live Cloudflare test was run. The assistant did not push or publish packages.
The maintainer supplied the
[E.2.1 issue reference](https://github.com/webbotauth/draft-ietf-webbotauth-httpsig-protocol/issues/135);
original fixture bytes remain unchanged.

Changes to the separately frozen verification, signing, and operator catalogs
require approval and release notes. Fixture-audit success alone does not prove
complete protocol conformance.