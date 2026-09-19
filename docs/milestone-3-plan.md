# M3 — network discovery and shared replay: decision proposal

Date: September 19, 2026.
Status: **source/fixture preparation and design only; security choices await approval**.

No production directory client, cache, or Redis adapter is implemented by this
delivery. Recommendations below are not defaults or implementation permission.
The pure RFC engine and accepted M2 offline API remain unchanged. The maintainer
confirmed that 0.1.1 is published, v0.1.1 is tagged, the repository is public, and
CI is green for commits 78dedf7 and 53b457e. That does not establish M3 CI success.

## 1. Source baseline and reproducibility

This plan deliberately uses the accepted WG protocol-00 and Cloudflare
documentation profile already pinned in M2. It does not silently upgrade a
profile or claim that these are the latest revisions.

| Source | Immutable identity | Local evidence |
| --- | --- | --- |
| WG protocol-00, September 1, 2026 | Full-text SHA-256 3021fd94cdffdb2eb030dec68b1a5c968f2348502dd94c481e2085ec7ddd90a0 | [§5.5](../tests/fixtures/m3/sources/wg-5.5.txt), [Appendix C](../tests/fixtures/m3/sources/wg-appendix-c.txt), [§4](../tests/fixtures/m3/sources/wg-4.txt), [§5.4](../tests/fixtures/m3/sources/wg-5.4.txt), [§§6.7–6.10](../tests/fixtures/m3/sources/wg-6.7-6.10.txt), [Appendix B](../tests/fixtures/m3/sources/wg-appendix-b.txt) |
| Cloudflare directory documentation | cloudflare-docs commit acfb1f2270b9473ae65a15674995e0b2f3b6ab0c; full-text SHA-256 c4aeeef723df97b020ecc4d9e680b77b5bfb6c214a6443b0fb7f00efd7e422f7 | [Exact directory excerpt](../tests/fixtures/m3/sources/cloudflare-directory.mdx), [CC BY 4.0](../tests/fixtures/m3/sources/cloudflare-docs-LICENSE.txt) |
| JSON collection linked by WG Appendix F.3 | cloudflare/web-bot-auth commit c07ecb6f3e82701f297dedb414237cc2e54a0948 | [F.3 excerpt](../tests/fixtures/m3/sources/wg-f.3.txt), [architecture vectors](../tests/fixtures/m3/cloudflare/web_bot_auth_architecture_v2.json), [Apache-2.0](../tests/fixtures/m3/cloudflare/LICENSE.txt) |
| Supplementary directory-response vector | Same Cloudflare implementation commit, separately identified | [Response vector](../tests/fixtures/m3/cloudflare/web_bot_auth_directory_response_v1.json) |

The [manifest](../tests/fixtures/m3/manifest.json) records byte lengths, SHA-256,
Git blob identities for upstream files, extraction markers, and license context.
WG excerpts retain pagination and exact source bytes. Their complete source
and IETF notices remain in the referenced M2 source tree. Cloudflare documentation
is CC BY 4.0; implementation JSON fixtures are Apache-2.0, not MIT.
The root implementation license includes Copyright 2025 Cloudflare, Inc.
The pinned complete Git tree and package declaration support the license review:
no closer test-data license or NOTICE file was found.

The importer reads previously downloaded, hash-checked files; it performs no
networking and executes no upstream generators. Research downloads are separate
from the prospective production fetch API. Existing fixtures are unchanged.

## 2. Compatibility findings that must not be hidden

1. **HTTP 200 versus conditional caching:** §5.5 requires status 200 and treats
   every other status as discovery failure. Informative Appendix C recommends
   validators and conditional requests, which can return 304. A cache-layer
   interpretation allowing 304 needs explicit approval and documentation.
2. **Redirects:** §5.5 prohibits automatic redirects. §6.7's recommendation to
   bound redirect depth does not override that prohibition.
3. **Response proof:** WG Appendix B permits directly resolved keys without
   a valid response proof. A proof, when relied on, requires signed request
   authority, Content-Digest validation against actual body bytes, and metadata.
   Cloudflare §2 requires a response signature for each usable key, but its
   displayed minimum covers authority and does not require a body digest.
   These are not interchangeable evidence standards.
4. **Fetch failure versus key removal:** §6.10 says failure is not new key
   evidence and must not evict cached state. A valid newer complete directory
   that omits a key replaces older evidence. Retaining stale data does not
   automatically authorize accepting it.
5. **Upstream JSON is not a WG-00 acceptance oracle:** four request vectors are
   cryptographically valid, but two omit Signature-Agent and two use signature
   label sig2 with agent member agent2. The latter Ed25519 vector exactly matches
   the preserved WG E.2.1 base, input, and signature. This is the existing
   [issue #135](https://github.com/webbotauth/draft-ietf-webbotauth-httpsig-protocol/issues/135)
   discrepancy, not a new byte mismatch.
6. **Local-policy differences:** all four JSON request examples omit M2 method
   and target-URI coverage and have very long lifetimes. Two use RSA, which the
   library does not implement. Published private keys are test-only. Independent
   RSA verification in the source audit adds no production algorithm support.
7. **Directory vector differences are valid:** the supplementary response uses
   the E.2.3 body/digest but different parameter order and an explicit algorithm
   parameter. Its base and signature therefore differ; both signatures verify.
   Label-only renaming is not the explanation. These are distinct valid vectors.

No fixture has been repaired to conceal a discrepancy. Cryptographic auditing
is not full authentication or evidence that a future network implementation works.

## 3. Architecture proposal and non-negotiable existing boundaries

Proposed separation: a network-specific core subpath supplies bounded discovery
and immutable URL/key evidence; the offline entry remains side-effect-free with
respect to networking. A future network verifier composes that evidence with
the existing signature, time, identity, and replay gates. Do not simply feed
remote keys into the manual-binding API and mislabel trust as local configuration.

Redis can initially be a separately reviewed adapter contract; a separate package
name/dependency requires approval before introduction. No adapter package is
created here.

Already approved boundaries remain: Ed25519-only production crypto, no access
authorization, no bot evasion, no test-key permission by default, no automatic
profile fallback, bounded parsing, no live replay eviction, and final clock/epoch
checks. Network failures must never manufacture verified identity. Additional
discovery diagnostics or trust-source variants require an approved API/catalog
proposal; the frozen M2 catalog cannot be expanded incidentally.

### Proposed verification sequence (subject to decisions below)

1. Snapshot and bound request data; parse all pairs, reject raw duplicates, select tags.
2. Resolve grammar and claims; check coverage, metadata, time, and candidate limits.
3. Apply local discovery authorization before any DNS or transport operation.
4. Resolve the exact directory URL/key pair through fresh evidence or bounded fetch.
5. Validate the entire new key set and optional/required proof policy before commit.
6. Verify candidate crypto/identity and recheck time after discovery waits.
7. Atomically consume replay only for eligible candidates; preserve M2 grouping.
8. Check epoch, time, and the approved evidence-generation rule before success.

Before crypto, the URL is attacker-controlled. Fetching cannot wait for crypto
when the key is unknown; admission limits and egress controls are therefore
essential rather than optional optimizations.

## 4. Decisions D1–D8: discovery and transport

Every row is **pending approval**. A is a recommendation, not a selected policy.

| ID | Option A — recommendation, benefits and costs | Option B — alternative, benefits and costs |
| --- | --- | --- |
| D1: discovery scope | Directory-only HTTPS origins using the reserved path; retain M2 origin/port/IP-literal rules. Small auditable surface; rejects direct JWKS/CIMD deployments. | Add explicit JWKS-URI/CIMD mechanisms. Broader compatibility; more URL identity, nested fetch, cycle, query, and SSRF obligations. No path-based inference in either option. |
| D2: fetch admission | Require an application-configured origin allow-list. Least egress exposure; requires onboarding and is not open discovery. | Explicit open-discovery mode for public origins, still address-filtered and budgeted. Supports unknown agents; exposes arbitrary-origin fetch and privacy/DoS costs. |
| D3: DNS answers | Reject the resolution if any returned A/AAAA candidate is forbidden; bound answer count and resolution time. Simple fail-closed mixed-answer handling; mixed public/private deployments fail. | Remove forbidden addresses and connect only to validated public answers. Better availability; more complex answer/fallback tests and residual resolver-path considerations. |
| D4: connection pinning | Owned Node HTTPS connector connects only to a validated address from that resolution, while preserving original host/SNI/certificate validation; no pool initially. Small inspectable path; more handshakes. | Owned pinned connector with bounded pooling, connection age and per-origin/network-policy partitioning. Lower latency; reuse and reconnection require explicit revalidation tests. A DNS precheck followed by ordinary unconstrained fetch is not an acceptable alternative. |
| D5: egress environment | No automatic environment proxy, custom dispatcher, alternate service discovery, or custom CA bypass. Predictable routing; enterprise proxy deployments unsupported. | Explicit trusted egress gateway/custom CA mode with separately reviewed validation contract. Enterprise compatibility; trust expands and client-side pinning may no longer establish the actual destination. |
| D6: redirects | Reject every 3xx without following Location, as WG §5.5 requires. Clear origin binding and reduced SSRF surface; migrated directories fail. | Defer redirect support until a new/explicitly divergent profile is approved. Supporting even one same-origin hop would not be strict WG-00; no silent compatibility toggle. |
| D7: response representation | Require the directory media type, valid UTF-8 JSON, entire-set validation; request identity encoding and reject compressed bodies. Simple bounded decoding; less server compatibility. | Support enumerated gzip/br encodings with encoded and decoded byte limits and CPU/deadline checks. Better compatibility; decompression bombs and digest representation need dedicated tests. |
| D8: conditional requests | Unconditional GET, only 200 produces new evidence. Follows literal §5.5; more bytes and no 304 optimization. | Explicit 304 cache-revalidation interpretation: only a matching stored representation and validators, never cold 304; apply HTTP metadata updates without inventing body/proof. Efficient; draft tension must be documented or clarified upstream. |

Address policy in either D3 option must exclude more than RFC1918 alone:
loopback, link-local, unspecified, multicast, unique-local, carrier-grade NAT,
documentation/reserved/non-global destinations, IPv4-mapped aliases, and local
deployment-denied ranges. A pinned IANA special-purpose classification and tests
are an implementation prerequisite; no new address registry is claimed pinned
by this delivery. Public addressing is not proof that an endpoint is harmless.
Network egress controls should reinforce the application checks.

DNS rebinding tests must prove the dialed address is the one approved; reconnection,
family fallback, and retries cannot initiate a fresh unvalidated lookup. Validate
the connected peer representation too; never disable TLS hostname checks by
substituting the IP as the authenticated hostname. Bound single-label/search-domain
resolution behavior explicitly. Custom resolver code is a trusted dependency,
not a sandbox. Fail closed on an address form the classifier cannot interpret.

## 5. Decisions D9–D16: evidence, cache, and rotation

| ID | Option A — recommendation, benefits and costs | Option B — alternative, benefits and costs |
| --- | --- | --- |
| D9: URL trust and proof | WG direct-TLS URL/key association only in M3; proof verification/redistribution deferred, explicitly no Cloudflare directory-onboarding claim. Smaller scope consistent with WG; no portable possession proof. | Add explicit proof-required mode with actual body-digest checking and per-selected-key signature/time/authority validation. Stronger evidence and closer to Cloudflare onboarding; expands M2 body/response scope and needs independent policy fixtures. Never call authority-only proof body-bound. |
| D10: fresh cache lifetime | Respect restrictive HTTP directives and calculated response age, with a local maximum of 300 s and no heuristic freshness when directives are absent. Bounded key-removal latency; more refetches. | Cap at 3,600 s and permit an explicit 60 s fallback for responses lacking freshness directives. Better availability; longer removal exposure and a local heuristic. |
| D11: stale acceptance | Retain expired entries for retry/diagnostics but never use them to produce verified URL identity. Fail closed, clear removal bound; directory outages reduce availability. | Explicit stale-if-error allowance up to 60 s beyond freshness, only for transient failures and previously trusted keys, never against no-store/must-revalidate or after confirmed removal/proof expiry. Better outage tolerance; extends compromised-key acceptance and needs public stale evidence flags. |
| D12: unknown key in a fresh set | One coalesced, rate-limited refresh per origin at most every 30 s, with a request fetch budget. Supports rotation; attackers can trigger bounded load. | Wait for normal expiration and do no miss-triggered refresh. Lower load; newly rotated keys temporarily remain unverified. |
| D13: negative cache/retry | Origin-level transient backoff starting at 5 s, capped at 60 s with jitter; no inline automatic retry; honor Retry-After as a do-not-retry-before signal. Low amplification; slower recovery. | At most one retry within the total deadline and origin budget, plus a bounded negative cache no longer than 300 s. Better transient recovery; extra traffic and latency. |
| D14: replacement and in-flight removal | Atomically replace complete validated sets, including empty sets; final evidence-generation recheck rejects candidates whose key was removed during awaits. Smaller removal race; legitimate in-flight work may fail. | Pin fresh evidence to invocation start through its deadline. Stable work snapshots; removal may take effect later by up to the invocation budget. Do not merge removed keys back into either option. |
| D15: key nbf/exp metadata | Reject malformed values when present and enforce configured key validity on every use with zero added key-expiry grace. Explicit bounds; these JWK fields need a documented local interpretation rather than an invented generic JWKS requirement. | Ignore unstandardized validity extensions and use set freshness plus signature time only. Less policy complexity; operator key dates do not constrain acceptance. |
| D16: fallback identity | Network discovery failure stays unverified; no automatic switch to cached keys from another URL or manual thumbprint trust. Clear trust mode; lower availability. | Separate explicit manual-key fallback returning thumbprint-only identity, never URL attribution. Controlled availability; caller must distinguish trust sources and avoid treating fallback as equivalent. |

HTTP freshness calculation must account for Date/Age, response delay, Expires,
max-age and applicable shared-cache directives instead of restarting TTL on every
read. no-store prevents persistent storage; no-cache requires revalidation before
reuse. Determine whether the resolver acts as a shared cache before interpreting
private/s-maxage. Proposed A: a context-local application cache, conservatively
declining storage of private responses; alternative B: explicit per-tenant cache
partitions with full private-cache semantics. This subchoice is also pending.

Monotonic elapsed time should drive cache durations; proposed A ties invalidation
to the shared context's health/epoch so reset marks entries untrusted until refetch.
Alternative B uses a separate cache monotonic clock and preserves evidence across
reset, with a separately proved time-domain contract. Neither can reset a stale
entry's age to zero. Persisted caches require additional restart-age rules.

A failed fetch does not replace good evidence. A malformed set is not authoritative
proof of key removal; an accepted newer set omitting a key is. Single-flight
refresh must prevent a late older response from overwriting newer evidence.
A cancelled request may detach from a coalesced fetch without cancelling other
waiters; proposed A cancels when the last waiter leaves, alternative B permits
bounded prefetch completion. Both are pending, with resource/availability costs.

Retry-After above five minutes may suppress further attempts longer without
being stored as an authoritative negative-key claim. Bound its representation,
never convert it into trust or silently retry earlier. New valid evidence clears
obsolete negative state. Unknown-key negative records must be bounded so random
thumbprints cannot fill memory.

All verifiers sharing replay state need compatible retention horizons. A consume
under a short policy must not expire while another verifier would still accept
the same signed request under a longer one. Proposed A requires one maximum
retention envelope for a shared context/Redis namespace; alternative B rejects
incompatible verifier policies at configuration time. Merely partitioning by
profile would violate accepted cross-profile replay protection. Approval and
regression fixtures are required before implementing either solution.

## 6. Resource profiles — D17 (choose explicitly)

These values are proposed application limits, not protocol requirements.
Phase limits are capped by the total deadline; no phase can restart the total.

| Resource | A: restrictive initial profile (recommended) | B: higher-availability profile |
| --- | ---: | ---: |
| Total discovery deadline, including admission queue, DNS, TLS, body | 3 s | 10 s |
| DNS deadline / address candidates | 1 s / 16 | 2 s / 32 |
| Connect + TLS deadline | 1 s | 3 s |
| Header deadline / body idle timeout | 1 s / 500 ms | 3 s / 2 s |
| Response headers | 16 KiB | 32 KiB |
| Encoded body / decoded body | 256 KiB / 256 KiB | 512 KiB / 1 MiB |
| JWKS entries, including unsupported/duplicates | 64 | 256 |
| Active fetches globally / per origin | 16 / 1 | 64 / 2 |
| Queued fetches | 64 | 256 |
| New fetch starts globally / per origin | 32/s / 1 per 30 s | 128/s / 1 per 5 s |
| Positive cache entries / accounted bytes | 1,000 / 16 MiB | 10,000 / 64 MiB |
| Negative/backoff entries | 1,000 | 5,000 |
| Network fetches per verification invocation | 1 | 2 |

A reduces attack amplification and memory/CPU cost but may reject slow legitimate
directories and multi-agent requests. B tolerates slower/larger deployments but
requires more resources. A lookup denied by budget must remain unverified, not
invalid crypto or verified. Multi-candidate evaluation must retain every candidate;
budget exhaustion cannot silently drop it from the count.

Count bytes while streaming before allocation/parsing; Content-Length is only
an early hint. Hard limits must apply even when it is absent or dishonest.
Abort closes the connection and releases counters/listeners; DNS work that cannot
be cancelled remains bounded and its late results must never dial.
Cache admission/eviction changes availability, not evidence freshness. Evicting
a directory entry may require refetch; it does not permit eviction of live
replay records. Never log complete nonces, private test material, or bodies.

## 7. Redis store contract — R1–R6 (all pending)

The [M2 replay interface](../packages/core/src/profiles/replay-store.ts) remains
the baseline: scope/key/nonce, dispatch-time seconds, retention deadline, four
outcomes, and no transmitted local epoch. Profile/label never partition replay.
An independent store is not cleared on local clock reset.

| ID | Option A — recommendation, benefits and costs | Option B — alternative, benefits and costs |
| --- | --- | --- |
| R1: atomicity/topology | One Redis primary/one Cluster hash slot per enforcement domain, atomic Lua/function checking expiry → replay → per-key quota → total capacity → insert. Preserves exact quotas; hot-slot/scaling cost. | Partition across shards with approved per-shard budgets. Scales better; cannot claim the existing exact global quota without a coordination protocol. Separate approval needed for changed semantics. |
| R2: time and retention | Redis server time for stored deadlines; TTL duration derived from the shared retention envelope and local dispatch difference, rounded up, never down. Avoids comparing unrelated epochs; Redis clock steps still require an operational safety contract. | Independent trusted retention service/clock with Redis as storage. Better controlled timing possible; additional infrastructure and adapter protocol. |
| R3: ambiguous completion | Timeout/connection loss returns unavailable and never falls back to memory or blind retry-as-success. Replay safety over availability; a committed but unacknowledged consume may block a legitimate retry. | Idempotency token per verification invocation with atomic stored outcome, distinct from nonce identity. Recoverable acknowledgement; extra state and proof that separate invocations cannot share acceptance. |
| R4: durability/failover | Dedicated noeviction deployment; fail closed after suspected history loss until a conservative quarantine horizon passes or state is restored. Honest guarantee; operational downtime and health integration. | Accept documented best-effort replay across failover/restart. Higher availability, but cannot advertise durable cross-failure replay prevention; would require explicit public guarantee/API approval. |
| R5: client/API packaging | Adapter accepts an application-owned compatible client; library owns bounded atomic operations and outcome mapping. No mandatory Redis client dependency; client behavior/version needs a tested contract. | Dedicated client dependency and package lifecycle. Easier supported configuration; heavier dependencies, connection ownership, and a new package-name approval. |
| R6: reset/admin operations | No normal clear/delete API; independent store survives local clock resets; administrative history loss requires explicit quarantine and observation. Safer default; less convenient operations. | Separate privileged destructive reset with distributed generation fencing. Managed recovery; significantly more complex multi-process protocol and replay discontinuity disclosure. |

Contract details requiring implementation fixtures:

- Key encoding is collision-free and includes the configured enforcement domain.
  Keep raw nonce data out of Redis key names and logs; choose keyed hashing or
  an injective encoded tuple explicitly. Hashing reduces exposure but cannot
  be described as mathematically collision-free encoding.
- Per-key quota spans scopes in the same store domain. Lua keys must share a
  Cluster slot. SET NX by itself is insufficient for exact per-key/global quotas.
- Never shorten, delete, or refresh a live record on replay. No live eviction.
  Global exhaustion maps to unavailable, not a new outcome without approval.
- Bound Lua work and expiry-index cleanup. A cleanup batch limit cannot silently
  miscount capacity and insert over quota; safe temporary unavailability is preferable.
- Redis script errors do not roll back writes already performed. Validate before
  mutation and design partial-failure states to fail closed, with fault-injection
  tests for OOM, script interruption, and missing indexes.
- A Redis TTL uses Redis wall time: a forward clock step can expire nonces early.
  “Independent” does not mean immune to clock jumps. Deployment health, quarantine,
  restoration, and the approved maximum horizon must cover this risk.
- AOF/replication acknowledgements reduce but do not eliminate loss under every
  failover model. Do not claim that WAIT alone gives durable linearizability.
- TLS/authentication, least-privilege ACLs, namespace isolation, bounded command
  timeout, and client retry disabling must be specified before production use.
  Suggested timeout A: 100 ms with no queue; alternative B: 500 ms with a bounded
  queue. Lower latency versus increased legitimate timeouts is an explicit choice.
- Old-epoch external writes may finish after local reset; they cannot yield local
  success. All in-flight operations recheck context health/epoch and signature time.
- Multi-process tests must show one acceptance per tuple, not merely one per process.

## 8. API and test gates before implementation

After decisions, propose types for network configuration, trusted discovery
evidence, cache diagnostics, proof policy, and Redis configuration. Keep
request-result catalogs separate from operational discovery diagnostics.
Options: A, a separate discovery outcome object composed by a new network API;
B, approved new verification codes with a catalog-version change. Neither is
implemented or approved here.

Fixture-first implementation order:

1. Approve the decision matrix and remaining subchoices; record exact policies.
2. Commit independent network and Redis failure/boundary scenarios separately.
3. Implement the owned connector and IP policy with deterministic test servers,
   DNS changes, TLS verification, redirects, mixed-address answers, and aborts.
4. Implement evidence/cache transitions: cold 304, Age/no-cache/no-store,
   failed refresh, empty valid set, removal races, stale expiry, proof expiry,
   negative-cache floods, single-flight cancellation, and reset.
5. Compose with the full verifier; test no nonce consumption before eligibility,
   no network downgrade, exact URL/key binding, and final epoch/evidence checks.
6. Implement Redis only after its deployment/atomicity contract is approved;
   test concurrent processes, quotas across scopes, TTL boundaries, failures,
   restart/failover, clock jumps, and retention-policy compatibility.
7. Run golden, fixture, ESM/CommonJS, type, Node/OS, and adversarial suites.
   A source audit is not a network security audit or live Cloudflare acceptance.

No production feature is authorized by copying upstream JSON. The next response
should select decision IDs/options or explicitly defer them. No push or publication
is performed by the assistant.