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

The [M3 proposal](milestone-3-plan.md) presents discovery, SSRF/DNS rebinding,
redirect, evidence/cache/stale, rotation, resource, and Redis decisions with
alternatives and costs. D1–D17, R1–R6, and the explicitly listed subchoices
remain pending approval. Recommendations are not selected defaults.

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

No old fixtures or production APIs are changed. The new fixture audit is wired
into CI, but M3 remote CI has not run. Network/Redis implementation requires
explicit security decisions and fixture-first implementation approval.
No push, publication, or upstream issue submission is performed.

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

The decision proposal is a separate documentation delivery. No M3 security
option is approved by committing it. Remote CI for these new commits remains
unconfirmed, and no push or publication was performed.