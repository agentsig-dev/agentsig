# M2 origin, duplicate, and local identity policies

Updated September 19, 2026. The helpers and their targeted tests are implemented.
Full profile signing, offline verification, and profile package exports were
subsequently completed in M2. Internal helpers are not public authentication
entry points. Historical test counts below refer to their respective milestones.

## Origin acceptance and canonical identity

[Origin validation](../packages/core/src/profiles/agent-origin.ts) applies the
same local policy to both profiles:

- Accept HTTPS only, with a nonempty ASCII host.
- Normalize scheme and host case.
- Remove an explicit exact port 443; reject other ports.
- Accept one trailing slash, excluding it from the identity key.
- Reject paths, queries, fragments, and user information.
- Reject IPv4/IPv6 literals and alternative numeric spellings interpreted as IPs
  by the URL parser.
- Reject non-ASCII hosts; perform neither IDNA conversion nor DNS queries.
- Do not use the URL parser's input repair to establish an accepted identity.

For example, HTTPS://AGENT.EXAMPLE:443/ and https://agent.example both map to the
identity key https://agent.example.

**The canonical origin is for identity comparison only. Received signed header
values are never rewritten.** The size limit applies to the original input
before normalization. Passing these checks does not prove domain ownership.

[WG §5.5](../tests/fixtures/m2/sources/wg-protocol-00.txt:825) requires origin form
for directory discovery. Port and IP restrictions are narrower local M2 policy.
The [Cloudflare document](../tests/fixtures/m2/sources/cloudflare-2026-07-01.mdx:178)
requires an HTTPS URI and quoted form; origin-only acceptance is an explicitly
approved, stricter agentsig policy, not a Cloudflare requirement.

## Raw duplicate rejection

[Duplicate screening](../packages/core/src/profiles/duplicates.ts) examines raw
Structured Field occurrences before semantic parsing loses duplicates:

- Repeated signature metadata or component parameters: malformed-signature.
- Repeated signature-value parameters: malformed-signature.
- Repeated Signature-Agent Dictionary members or parameters: malformed-agent.
- Identical repeated values are also rejected.
- Reusing a parameter name on different members/components is not a duplicate.
- Diagnostics identify the repeated name, not its value or the entire header.
  Displayed names are bounded to 256 code units with an explicit truncation marker.

Signature screening precedes candidate tag selection so a repeated tag cannot
hide a candidate as another protocol. Budget failures retain resource-limit
rather than being misclassified as malformed syntax.

[RFC 9421 §2.3](../tests/fixtures/profiles/sources/rfc9421-2.3.txt) and
[§2.5](../tests/fixtures/profiles/sources/rfc9421-2.5.txt) do not explicitly impose
a separate raw parameter-name duplicate rejection rule. The rejection in §2.5
step 2.1 concerns a repeated complete component identifier including parameters.
Signature-label uniqueness is a separate requirement in RFC 9421 §4.

[RFC 9651 parameter parsing](../tests/fixtures/profiles/sources/rfc9651-parameters.txt)
and [Dictionary parsing](../tests/fixtures/profiles/sources/rfc9651-dictionary.txt)
retain the last value. M2 deliberately rejects more inputs to reduce the risk
of different parsers selecting different values. The M1 engine and general
Structured Fields package retain their existing behavior.

## Explicit local identity binding

The [binding helper](../packages/core/src/profiles/agent-bindings.ts) uses only
configured thumbprint–origin relationships. It snapshots inputs and deduplicates
equivalent spellings of the same key/canonical-origin pair. Resource budgets
count all input occurrences before deduplication.

Thumbprint mode does not derive domain identity from the signed URL claim.
In explicit binding mode, no association for the selected key produces
agent-binding-missing; an existing association with a different origin produces
agent-binding-mismatch. Another key's association with the same origin does not
establish trust for the selected key.

A matching URL identity proposal contains the canonical origin, its well-known
directory URL, and local-configuration trust source. It implies neither TLS or
directory proof nor an operator name. This is an internal proposal only: it must
not escape as verified until cryptography, time, test-key policy, and replay
checks pass. Updating key bindings does not automatically erase replay history.

## Original helper validation milestone

Source excerpts and 26 origin, nine duplicate, and nine binding expectations
were committed in **34b0d9a** before implementation.
The [independent audit](../tests/profile-fixture-audit.test.mjs) checks source and
manifest integrity plus expectation consistency without production code.

Local Windows / Node 22 results at that milestone: 48 origin, 18 duplicate, and
27 binding tests passed. Full regression passed 3,754 unit tests, nine integration
tests, 32 independent fixture audits, the M1 audit, and both packages' build/type
checks. At that point consumers covered M1 only; full verifier integration and
profile consumers were added later. These historical results are not a security
review or proof that a later commit passed remote CI.

## Candidate selection, header grammar, and component support

[Candidate selection](../packages/core/src/profiles/candidates.ts) first screens
raw duplicates, then parses every signature pair, and finally selects by the
protocol tag. A signature label is not a selector. A malformed pair does not
become unsigned traffic merely because it carries another protocol's tag.

[Agent-header parsing](../packages/core/src/profiles/agent-header.ts) selects
Dictionary or legacy String grammar once from the wire form. Parsing or
verification failure never triggers a retry with the other profile. In WG form,
each candidate uses only its own label's member claim. Unsupported discovery
types are neither inferred from URL paths nor resolved through network access.

[Required coverage](../packages/core/src/profiles/coverage.ts) demands method and
complete target URI in both profiles. WG additionally requires the agent member
matching the label; Cloudflare requires the entire agent header. Validity and
support of additional components remain separate checks.

[Component support](../packages/core/src/profiles/component-support.ts) rejects
coverage of Signature or Signature-Input in either profile as unsupported-profile.
Covering the entire field or an individual member makes no difference. This is
not a claim that WG forbids countersignatures: such coverage is outside M2's
documented local scope. Revisit it in a separate milestone if M4 proxy deployment
requires it.

Unsupported components and parameters in the pinned Cloudflare document also
produce unsupported-profile. Diagnostics distinguish an unsupported profile name
from an unsupported component within a recognized profile. They identify the
component, optional parameter, and either the Cloudflare Limitations source or
the local M2 restriction. Diagnostics do not add frozen catalog codes.

### Rejected candidates remain counted

Tag selection precedes component rejection. If one of two candidates covers the
other signature, both remain in the candidate count:

- Default exactly-one policy produces ambiguous-signatures and consumes no nonce.
- Explicit all/any policy retains the outer candidate's unsupported-profile result
  and evaluates the other independently.
- All cannot succeed; any succeeds only if the other candidate passes every
  identity, crypto, time, and replay gate.

Ignoring a rejected candidate would let additional signatures influence the
acceptance policy by disappearing from the count. Evaluation therefore never
refilters the selected candidate list.
[Counting fixtures](../tests/fixtures/profiles/rejected-candidate-counting.json)
pin this behavior. Full aggregate/replay integration is now separately exercised
by the [verifier tests](../packages/core/test/profile-verifier-multiple.test.ts).

### Coverage and support validation milestone

Coverage fixtures were committed in **37159c4**; component restrictions and
rejected-candidate counting fixtures in **5f017f1**, before implementation.

At that milestone, local Windows / Node 22 full regression passed 3,866 unit
tests, nine integration tests, and 35 independent fixture audits; builds and
type checks passed. [Crypto-chain tests](../packages/core/test/profile-crypto-chain.test.ts)
verify two independent signed examples and reject changes to method, target
query, or original agent value. Mapping to the same canonical origin does not
make different signed bytes equivalent.

Those helper/crypto checks do not replace the later full offline acceptance
gate. Current integration and delivery results are recorded in
[deferred work](deferred.md) and the [offline verifier guide](offline-verification.md).