# M2 shared security context: clocks, epochs, and resets

Updated September 19, 2026. The internal coordinator, bounded in-memory replay
store, shared context factory, and offline verifier integration are implemented.
Tests cover the real store, reset races, and failure injection with test doubles.
Profile ESM/CommonJS consumers and full round trips passed locally. The maintainer
subsequently confirmed green core-m2 CI and fixture workflows. These results do
not establish production readiness or constitute a security review.

See the [offline verification guide](offline-verification.md) for the public API.

## Signature time and clock health

The [pure time policy](../packages/core/src/profiles/time-policy.ts) accepts
caller-supplied integer Unix seconds and never reads a clock implicitly.
Creation time may be in the future only within the configured tolerance.
Expiration must follow creation and the lifetime must not exceed policy.
Both expiration plus tolerance and creation plus maximum age plus tolerance
are exclusive acceptance boundaries: equality is rejected. Comparisons use exact
integer arithmetic to avoid overflow. Passing the time gate is not authentication.

The [clock tracker](../packages/core/src/profiles/clock-tracker.ts) calculates
effective time from its initial wall-clock reference plus monotonic elapsed time.
Signature time is that value floored to integer seconds. A wall-clock difference
strictly greater than the default 30-second drift threshold makes the clock
unhealthy. This threshold is configured separately from signature clock skew.

Wall drift can recover against the original reference when it returns within
the threshold. Monotonic regression permanently invalidates the tracker and
requires an explicit reset. There is no automatic rebase or replay cleanup.
An unhealthy clock supplies no usable verification time and starts no store call.

## Shared epoch and operation boundary

The [internal coordinator](../packages/core/src/profiles/security-context-controller.ts)
owns the clock, [operation epochs](../packages/core/src/profiles/operation-epochs.ts),
and store access within one context. Verifiers sharing the context cannot reset
their clocks independently.

Epoch identifiers increase monotonically within the process. Each operation
holds a context-owned lease for the epoch in which it began. Epoch ownership and
clock health are checked before store dispatch and again after awaiting the store.

The final result path checks them again. The verifier uses that final clock
sample to recheck each eligible candidate's time window. No await or application
callback separates the final gate from construction of successful results.
Even if an earlier group's store consumption was accepted, a reset while a later
group is pending prevents the old invocation from returning a verified candidate.

Epoch identifiers are never sent to an external store. A lease from another
context or a finished epoch is rejected even if its numeric epoch matches.

## Explicit operator reset

The [operator error catalog](../packages/core/src/profiles/operator-errors.ts)
contains four separately frozen codes. It shares no error type or union with
the signing or verification catalogs.

| Error | Behavior |
| --- | --- |
| reset-unsupported-store | No retention declaration or safe owned-memory cleanup capability; preserve references, epoch, and records |
| reset-in-progress | Another reset is running or synchronous reentry occurred; the second call changes no state |
| reset-clock-unavailable | Initial replacement samples are invalid; preserve references and records without hiding the health failure |
| reset-failed | Epoch invalidation, cleanup, or activation failed; leave the context closed but retryable |

Reset order:

1. Check capability and whether a reset is already running.
2. Close the context to new verification work.
3. Validate fresh wall and monotonic samples.
4. Irreversibly invalidate the old epoch, then clear owned memory if required.
5. Check clock health again and activate the replacement reference and epoch.

If clock health fails while cleanup is pending, the new epoch is not activated.
The final check uses the prepared replacement reference; it does not silently
rebase to conceal the failure. Failure clears the busy state so another explicit
reset can retry. The old epoch is never resurrected.

**Reset also applies to a healthy clock. Clearing memory is destructive: a
previously consumed, still-valid signature may be accepted again.** Process
restart likewise loses in-memory replay history. Verification arriving during
reset does not wait for it; it receives a clock-unavailable rejection.

## Store retention-clock declarations

The [replay contract](../packages/core/src/profiles/replay-store.ts) distinguishes
three cases:

- **Process clock:** clear records and quota counters in context-owned memory.
  Merely declaring this on an external store does not grant cleanup authority.
- **Independent clock:** preserve store history and quotas; renew only the local epoch.
- **Undeclared:** normal consumption is allowed, but reset is rejected without
  changing references or store state.

Independent-store adapters must implement their own clock-domain translation,
atomicity, and TTL rounding. They derive retention duration from the supplied
deadline and dispatch time rather than compare absolute timestamps from
unrelated clocks. Redis and a distributed reset protocol are not implemented
in M2.

An external consume dispatched before reset may complete afterward; distributed
cancellation is not guaranteed. The old local operation cannot dispatch more
consumption or return verified. Its completed write may retain an unnecessary
record based on the old clock. Under the atomic store contract, which forbids
shortening or deleting an existing live record on replay, this can reduce
availability without weakening replay protection. The nonce might have been
accepted in another invocation, so do not claim that it was never accepted.

## Events and observer isolation

The [event schema](../packages/core/src/profiles/context-events.ts) includes
reset reason, old/new epochs, cleared record and quota-counter counts, invalidated
operation count, store declaration, and outcome. Clock-health events are emitted
only on transitions. Partial cleanup reports known actual counts; unknown counts
remain explicitly unknown. Events contain no keys, nonces, headers, or raw
infrastructure errors.

The [single synchronous observer](../packages/core/src/profiles/context-observer.ts)
is fixed at context creation; it cannot be replaced or removed. Each event is
delivered once, after state is finalized and before returning to the caller.
Failed reset attempts also produce events, except observer-originated reentry
that must not recursively produce more events.

Every synchronously thrown value is swallowed without retaining or logging it.
A read-only, saturating observer-error counter increments; there is no secondary
error hook. Observer errors do not change a completed reset's outcome.

Verification reentry from the observer's synchronous call stack is rejected as
clock-unavailable. Reset reentry is rejected as reset-in-progress. The guard is
cleared even after an exception and does not leak into deferred work. Observers
also cannot retire active leases or change invalidation accounting.

**Do not perform expensive work inside the hook. Synchronous work delays the
caller and reset.** Enqueue sanitized events into an application-owned bounded
logging queue instead. A separate consumer performs I/O and handles its own
asynchronous failures. Queue overflow policy belongs to the application.
Returned asynchronous work is neither awaited nor inspected; failures after
the synchronous callback returns are outside this catch boundary.
[Deferred-callback tests](../packages/core/test/profile-context-observer.test.ts)
exercise the stack-local guard.

## Validation history

Reset/epoch fixtures were committed in **b1c7bee** and observer fixtures in
**f9466af**, before their coordinator implementation.
The [independent audit](../tests/reset-fixture-audit.test.mjs) uses no production
code. [Coordinator tests](../packages/core/test/profile-security-context.test.ts)
exercise partial cleanup accounting, retries, clock changes, and reentry with
controlled test doubles.

The original coordinator milestone passed 102 targeted tests, 4,136 unit tests,
and 54 independent fixture audits on local Windows / Node 22. The subsequent
real-memory/factory milestone passed its 65 targeted tests.

Completed M2 regression passed 4,284 unit tests, 13 integration tests,
60 additional independent fixture audits, the M1 audit, and build/type checks.
Profile consumers exercise the actual package subpath, round trips, replay,
and explicit resets in separate ESM/CommonJS processes.
[Verifier race tests](../packages/core/test/profile-verifier-multiple.test.ts)
show that reset during a pending second group invalidates earlier acceptance
and that final time checks reject an earlier group whose signature has expired.

The maintainer confirmed core-m2 remote CI/fixture success. That confirmation
does not establish remote CI success for later changes. The assistant did not
push, publish, or submit the WG report.

## Real memory store and shared factory

The [memory store](../packages/core/src/profiles/memory-replay-store.ts) defaults
to 10,000 total records and 1,000 records per key thumbprint across all scopes.
Decision order is expiry cleanup, replay, per-key quota, global capacity, insertion.
Live records are never evicted to admit new ones. A replay neither shortens nor
extends the existing record's retention.

Atomicity is within one JavaScript execution agent: no await or application
callback separates checking and insertion. The key is an injective JSON encoding
of the scope/thumbprint/nonce tuple; profile and label are excluded.
There is no expiry timer. Cleanup runs only during consumption approved by the
context's clock-health checks. Reading counters does not delete records.
Separate processes and separate memory contexts do not share replay history.

The store applies the supplied retention deadline. The verifier uses the
coordinator's exact healthy dispatch-time sample for both eligibility and the
conservative retention calculation: the greater of creation and consumption
time, plus maximum age and skew. A shared nonce group uses the longest deadline
required by its eligible members. Preparation errors are not hidden as backend
failures and do not dispatch a consume. No preparation callback or epoch ID is
sent through the external store interface.
[Dispatch-time regression tests](../packages/core/test/profile-consume-preparation.test.ts)
cover this boundary. Store acceptance alone is not a verified request.

The [shared factory](../packages/core/src/profiles/security-context.ts) creates
the default memory backend and coordinator together. Its operator surface offers
reset and read-only status/counters, not raw consumption, store access, or cleanup
ports. Internal verifier access is associated with object identity; a copied
object is not a valid context.

Supplying an external store together with memory quota configuration is a
configuration error: unenforced quotas are not silently accepted. External
cleanup methods are never invoked. Independent-clock reset preserves history;
reset is rejected for undeclared stores or caller-owned process-clock stores.
External store counts are unknown rather than fabricated.

[Real-store integration tests](../packages/core/test/profile-memory-context.test.ts)
cover no consumption/cleanup while unhealthy, one acceptance among 100 concurrent
consumes, rejection of stale-epoch completions, and deliberate replay-history
loss on healthy reset. They do not replace the
[full round-trip acceptance gate](../packages/core/test/profile-verifier-roundtrip.test.ts),
which separately passed with the real signer, identity, time, and replay chain
for both profiles.

## Approved M3 Redis recovery contract — implementation pending

This section records the maintainer-approved contract, not a completed Redis
implementation. Independent contract fixtures and the local HTTPS test harness
do not establish production Redis or SSRF guarantees.

Normal nonce retention remains supplied by each consume call. The adapter
translates the supplied deadline minus dispatch time into a Redis-time duration;
it does not derive signature policy. Per-key quota covers all scopes in the
shared enforcement domain. Applications must supply retention sufficient for
all verifiers that can accept the same tuple. The store cannot infer or validate
those deployment-wide acceptance windows.

### Recovery horizon

Redis adapter configuration must explicitly supply recoveryHorizonSeconds.
There is no default. A missing, invalid, or unrepresentable horizon produces
invalid-replay-policy before the adapter becomes usable. Correct configuration
and restart are the recovery path for a configuration error; M3 adds no manual
early-release API and does not change the operator error catalog.

The internal [recoveryHorizonSeconds(policy) helper](../packages/core/src/profiles/recovery-horizon.ts)
now implements the single-clock bound below. It is not yet exported through a
public package entry. The Redis adapter and shared quarantine remain unimplemented;
this pure helper neither connects to Redis nor establishes recovery readiness.

- At first acceptance time T, creation C satisfies C <= T + skew.
- Every later accepted time N satisfies both N < C + maxAge + skew and
  N < expires + skew.
- Since expires <= C + maxLifetime, N < T + min(maxAge, maxLifetime) + 2 * skew.

Therefore the bound is min(maxAge, maxLifetime) + 2 * skew: **360 seconds**
with existing defaults. An imprecise 330-second quarantine would reopen a
30-second window for a maximally future-created signature. The helper uses exact
integer arithmetic and rejects overflow with invalid-time-policy rather than
clamping it. Existing time-policy configuration validation remains in force. The
[recovery fixtures](../tests/fixtures/m3-contract/recovery-cases.json) separately
pin signature eligibility and quarantine completion at 359, 360, and 361 seconds.

The application supplies the largest horizon of all verifiers sharing the
store, plus the distributed-clock allowance. The library cannot validate that
operator assertion. This helper does not replace normal conservative nonce
retention, and it does not make arbitrary Redis clock jumps or backward
verification-clock resets safe.

The [helper tests](../packages/core/test/profile-recovery-horizon.test.ts) passed
30 checks on local Node 20.20.2 and Node 22, including the pinned 359/360/361
signature-time boundaries and safe-integer overflow. These are not Redis
quarantine integration tests. Normal per-consume retention is unchanged.
Representable seconds from this helper do not guarantee representable Redis
milliseconds or absolute deadlines; the future adapter must validate those
additional bounds and still require an explicit operator-supplied horizon.

### Shared quarantine state

The epoch marker and quarantine-until key are stored in Redis. The deadline
is an absolute Redis timestamp measured from detection of missing history,
not an estimated earlier loss time. Initialization and consumption gates must
be atomic so all instances see the same recovery state.

One instance restarting does not shorten, extend, or restart an existing
quarantine. Missing or inconsistent recovery state starts a new quarantine.
During quarantine the store returns unavailable without admitting new nonces.
Completion only permits ordinary atomic store admission; the verifier must
still perform signature, identity, freshness, and final epoch checks.

### Eviction admission and accepted residual risk

At connection setup, inspect CONFIG GET maxmemory-policy and require noeviction.
A server-reported conflicting policy prevents use and raises
invalid-replay-policy. No usable adapter is returned.

If CONFIG inspection is denied or unsupported by a managed service, the
application may explicitly supply acknowledgeEvictionPolicy: "noeviction".
Without that declaration, admission is refused. The declaration must not
override a known server-policy mismatch or disguise a network failure.
Operators must keep the asserted policy true for the adapter's entire lifetime;
a one-time check is not continuous configuration attestation.

**Accepted residual risk:** manual DEL or replication rollback may remove nonce
records while preserving the epoch marker. The adapter cannot detect every
such partial loss. noeviction prevents eviction-driven loss but does not prove
that history is intact, durable, or linearizable. Neither marker presence nor
replication acknowledgements are a complete history-loss detector. Do not
advertise stronger replay guarantees than this deployment contract provides.

### Directory cache is a different clock domain

The approved M3 directory cache retains monotonic age measured from fetch.
An explicit verification-clock reset must neither clear the directory cache
nor renew its TTL. Expired evidence remains unusable for acceptance; a reset
does not make it fresh. Replay context reset retains its existing lease
invalidation and owned-memory cleanup behavior. Independent Redis history is
not cleared by a local verification-clock reset.

## M3 directory response header completeness

The internal [directory reader](../packages/core/src/discovery/directory-response.ts)
must inspect every received header occurrence within its byte budget. Node's
default response header-count ceiling can silently truncate rawHeaders without
rejecting the response. A local TLS regression demonstrated that 2,100 small
fields could hide a trailing Content-Encoding while remaining within 16 KiB.
The same mechanism could hide restrictive Cache-Control directives or duplicate
media-type fields. A byte limit alone therefore does not establish complete
application-level inspection.

Before sending the request, the reader sets maxHeadersCount to the configured
header-byte ceiling. Every field occupies more than one byte, so no section
within that byte budget can reach the count ceiling. The HTTP parser continues
to enforce maxHeaderSize; body and time budgets remain independent and active.
This does not increase the permitted header-byte budget or introduce an
unbounded-header mode. Raw occurrences remain available for duplicate rejection
and conservative freshness calculations.

A separate Node 20 test-server issue collapsed duplicate fields when setHeader
preceded writeHead with a flat array. Raw-header test cases now bypass that
preset, preserving the intended wire occurrences. Expected counts and rejection
outcomes were not relaxed; this test correction did not change production policy.
See the [response-reader regressions](../packages/core/test/discovery-directory-response.test.ts).

The maintainer confirmed green CI after correction **ac2dcf8**. Controlled socket
tests establish behavior under their simulated conditions, not real-network
destination pinning. Local TLS reader and nested-proxy tests establish their
specific transport paths, not full request authentication. The planned
maintainer-run network smoke must separately demonstrate full verification and
private-address rejection, explicitly identifying any test-only routing.
No production private-address bypass is authorized by that smoke requirement.

## M3 discovery deadline and cache commit boundary

The three-second discovery budget starts at service admission, not when DNS,
the scheduler, or the transport begins. The same monotonic start is carried
through queue admission; queueing and synchronous preparation consume the
original budget. Each transport phase receives only the remaining duration.
Starting a fresh budget at a layer boundary would permit aggregate work beyond
the configured limit even if each individual phase appeared bounded.

A regression demonstrated this boundary: after 1,000 ms elapsed before scheduler
admission, transport incorrectly received 3,000 ms instead of 2,000 ms.
The scheduler now accepts the original service start. Tests assert the remaining
budget and cancellation at 2,000 ms, with no cancellation at 1,999 ms.
Monotonic checks remain necessary because event-loop delays can postpone timers.

A transport response is not permission to update trusted cache evidence.
The service checks the original deadline after transport and again after
synchronous JSON/key validation. Validation produces an owned, single-use
preparation handle without changing the cache. Only a still-in-budget operation
may commit that handle, with no await or observer callback between the final
deadline check and the atomic replacement. An expired preparation is abandoned.

Consequently, a timed-out fetch cannot replace a key set, resurrect a removed
key, or renew prior evidence's freshness through a late completion. Failed
refresh backoff does not change the prior positive set or its original age.
Successfully validated, timely replacement still applies complete-set semantics;
a valid new set that prohibits persistence invalidates the older evidence.

Cancellation is not proof that underlying work has stopped. The scheduler keeps
active capacity and origin ownership until the worker actually settles, while
rejecting the timed-out result immediately. A stuck worker reduces availability
rather than permitting concurrency beyond the configured bound.

See the [discovery service tests](../packages/core/test/discovery-directory-service.test.ts)
and [scheduler tests](../packages/core/test/discovery-fetch-scheduler.test.ts).
These deadline and commit tests use controlled timing/transport dependencies;
they do not establish live-network authentication. The maintainer confirmed
push and green CI for **785b46f**, **e9a4848**, and **87e9998**. That confirmation
does not cover subsequent network-verifier or Redis implementation work.