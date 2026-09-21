# M5 proposal: CLI, signed directory publication and static demonstration

Date: September 21, 2026.
Status: **proposal; decisions below require maintainer approval**.
This document does not authorize implementation, deployment, new profile behavior,
DNS changes, key generation, workflow execution or publication.

## Accepted baseline

The maintainer confirmed publication of core/fetch/hono/fastify/express 0.2.0,
successful clean-directory installation, green release CI, core-m4/v0.2.0 tags
and all eleven adapter smoke scenarios. Structured Fields remains 0.1.1.
This is release/milestone acceptance, not an independent security review.

Existing constraints remain:
- Production cryptography is Ed25519-only.
- Authentication is not authorization; no stealth or bot-evasion features.
- Verification, signing, operator and HTTP mapping catalogs remain separately
  frozen. New CLI/publisher codes require their own approval before fixtures.
- Existing -00 and Cloudflare documentation profiles do not silently change.
- Publisher-side signed directory responses are mandatory Cloudflare-profile M5
  work, as recorded in the [M3 plan](milestone-3-plan.md:13).
- Actual request-body integrity is separately mandatory before 1.0. Producing a
  directory response digest does not implement request-body verification.
- Fixture expectations precede implementation in separate commits; golden
  acceptance is exact byte equality, not just a local sign/verify round trip.
- No push, package publication, WG submission or deployment by the assistant.

The [WG discussion review](deferred.md#wg-discussion-review--september-21-2026)
records open #128, #133, #119, #126, #109 and #102. Proposals in those threads do
not replace the pinned specifications. In particular, neither Unencoded-Digest,
redirect delegation, DNSSEC/DANE nor label-matching relaxation is approved here.

## Deliverables and boundaries

### CLI package: agentsig

Proposed workspace package: packages/cli, npm package and executable name agentsig.
Reuse core and fetch through public entry points; do not duplicate signature
canonicalization, profile parsing, discovery, time or replay algorithms.
The executable targets supported Node versions and Windows/Linux. Framework
packages are not dependencies of the CLI.

Proposed commands (exact flags and exit codes await a contract):

| Command | Proposed responsibility | Must not imply |
| --- | --- | --- |
| keygen | Generate Ed25519 material into explicitly chosen local files; produce public thumbprint | Secure storage merely because generation succeeded |
| directory | Produce bounded public JWKS; optionally produce a signed response artifact for an explicit origin | Deployment, domain ownership, Cloudflare registration or proof validation by existing discovery |
| sign-request | Sign a final request description; optionally send only under the approved network policy | Body integrity, exactly-once execution or implicit retry |
| inspect | Parse bounded input and emit a sanitized structural summary; explicit verification only if selected | Authentication from parsing or cryptographic validity alone |

No private key/passphrase in command-line arguments, environment-variable values,
stdout, stderr, diagnostics, temporary artifacts or crash reports created by the
CLI. Accept paths or deliberately selected input descriptors instead. Public data
output and intentionally exported signatures must be distinguished from logs.
Even a signed request artifact may contain a replayable credential while valid:
write it only to an explicit destination, never echo its nonce in diagnostics.

For inspect, default output should include bounded counts, profile/state and
fixed diagnostics, not raw headers, bodies, nonce values or private key material.
Malformed input is never repaired into a verified result. Network discovery is
not triggered by default. An explicit verification mode must reuse the existing
verifier and identify its key/time/replay trust context and process lifetime.

### Publisher support

Use the existing [response signing primitive](../packages/core/src/crypto.ts:42),
not the request-profile signer. A shared publisher facility should produce exact
body bytes and matching headers before any framework-specific serving integration.
It must not automatically upgrade directory-https identity into portable proof.

Pinned source distinctions:
- [Cloudflare directory instructions](../tests/fixtures/m3/sources/cloudflare-directory.mdx:7)
  require HTTPS, the well-known endpoint, directory media type and one signature
  for each usable advertised key. The displayed signature is illustrative.
- [WG Appendix B](../tests/fixtures/m3/sources/wg-appendix-b.txt:24) additionally
  requires covered Content-Digest and actual body comparison when relying on proof.
- The authority component references the related request. It must come from
  explicit validated publication configuration, never an untrusted Host that
  can solicit signatures for another domain.

Source/commit/license pinning for RFC 9530 and any additional directory draft
sections must precede implementation. Existing fixtures remain unchanged.

### agentsig.dev static demonstration

Plan public assets and deployment instructions only until deployment is approved.
No domain control, hosting provider, TLS configuration or header-rewrite capability
is assumed established. Serve the exact well-known path and required response
headers over HTTPS without redirect, content rewriting or compression inconsistent
with the signed representation. Do not expose private signing material in the
repository, web root, build output, source maps or browser JavaScript.

The demo must identify itself as a demonstration, not an official registry,
production identity service, Cloudflare-approved bot, or arbitrary signing oracle.
A static directory alone does not generate client traffic or demonstrate successful
request authentication.

## Decisions requiring approval

All A/B/C choices below are **unapproved**. Recommendations are proposals only.

### D1 — Private key storage and platform permissions

**A — Encrypted PKCS#8 by default; verified owner-only storage (recommended).**
Create a new owner-only directory/file without overwrite. Prompt through a TTY
or use a deliberately selected secret input descriptor; never accept passphrase
arguments or environment values. Require POSIX owner/mode checks and explicit
Windows ACL enforcement/verification.
Benefit: at-rest protection plus a testable access boundary.
Cost: prompts complicate automation and Windows ACL support needs platform work.

**B — Unencrypted PKCS#8 with the same owner-only checks.**
Benefit: simple unattended use without passphrase management.
Cost: filesystem/backup compromise immediately exposes signing capability.

**C — M5 imports externally provisioned private keys on Windows; keygen there
fails explicitly until ACL enforcement is implemented.**
Benefit: no false claim that chmod(0600) establishes a Windows ACL boundary.
Cost: cross-platform keygen acceptance remains incomplete.

For every option: reject symlinks/reparse points and pre-existing outputs, require
a trusted parent directory, verify actual permissions rather than assuming them,
and fail closed if the platform cannot establish the selected guarantee. Define
atomic no-clobber creation and partial-failure cleanup before code. Two output
files cannot be claimed transactionally atomic merely because each rename is.
Do not claim memory zeroization of JavaScript strings or protection from a
privileged local attacker. No automatic insecure fallback.

### D2 — sign-request network authority

**A — Offline artifact default; explicit send with destination allowlist (recommended).**
Sending reuses fetch, HTTPS, manual redirects and no retries. Destinations come
from explicit local configuration; no implicit proxy environment or remote input
can broaden them. Local HTTP remains the already approved explicit test exception.
Benefit: accidental sends and arbitrary-origin traffic are avoided.
Cost: another configuration step; an origin allowlist alone is not SSRF protection.

**B — Explicit send to arbitrary HTTPS URLs, with a prominent egress trust boundary.**
Benefit: convenient diagnostic client.
Cost: wider SSRF/local-service exposure; fetch is not the discovery SSRF connector.

**C — Offline-only in M5.**
Benefit: no CLI network surface.
Cost: no end-to-end diagnostic send from the CLI.

If public-address destination filtering is required, approve its separate contract
rather than suggesting HTTPS/allowlisting proves numeric destination pinning.
Do not repurpose discovery's fixed directory-fetch API as a generic request client.
For body-bearing requests retain explicit identity-only opt-in; no payload-integrity
claim. Send results and transport errors never imply exactly-once application work.

### D3 — Publisher API and proof scope

**A — Shared additive core publisher subpath plus CLI (recommended).**
Produce owned body/header artifacts and a small serving contract; no runtime
framework dependency. Add a publisher-only error catalog after approval.
Benefit: one implementation reusable by CLI and applications.
Cost: new public API/type/packaging and separate error-catalog review.

**B — CLI-only internal publisher initially.**
Benefit: smaller public surface.
Cost: applications cannot safely reuse it without later API work.

**C — Include remote directory-proof consumption in M5 as well.**
Benefit: end-to-end proof support.
Cost: much larger trust/cache/time/redistribution contract and new evidence types.
Not recommended as implicit scope: current M3 discovery does not check proof.

Under A/B, an independent test-only verifier must validate generated proof,
including body digest, authority and time. Production proof verification is not
claimed just because those tests pass.

### D4 — Signed representation and supported key set

**A — Uncompressed UTF-8 JWKS, SHA-256 Content-Digest, one signature per advertised
Ed25519 key (recommended).**
Cover related-request authority, Content-Digest, Content-Type and response status;
include explicit created/expires, thumbprint keyid, algorithm and directory tag.
Specify ordering, labels, terminal newline and exact serialized body in fixtures.
Reject unsupported/private public-directory input and incomplete signer coverage;
derive public members deliberately from explicitly supplied signing keys.
Benefit: body-bound, deterministic publication with no unsigned advertised keys.
Cost: no heterogeneous-key export and no transform/compression flexibility.

**B — Cloudflare documented authority-only minimum.**
Benefit: smaller compatibility surface.
Cost: cannot claim the directory body is authenticated; does not satisfy WG
Appendix B proof requirements. Not recommended.

**C — Content-Digest plus Unencoded-Digest experimentation.**
Benefit: explores #126.
Cost: draft-dependent dual-representation rules; needs distinct source/algorithm
pinning and explicit profile semantics. Do not adopt as a silent replacement.

All modes must sign the final bytes actually served, never reserialize afterwards.
For rotation, decide availability of every advertised key's signer; no unnoticed
partial signing or reuse of mismatched kid/material. No automatic nbf/exp semantics.
The existing request-signing 60-second default is not silently reused as a
directory-publication default.

### D5 — Signature lifetime, caching and renewal

**A — Explicit short-lived publication: proposed 1-hour proof lifetime and at most
300-second cache lifetime, refresh artifact every 15 minutes (recommended starting
point, subject to deployment capability).**
Benefit: bounded proof age; caching fits existing discovery's local cap.
Cost: reliable renewal and a pre-expiry failure alarm are required.

**B — Explicit daily-scale publication: proposed 24-hour proof lifetime and
at most 300-second cache lifetime.**
Benefit: fewer signing/deployment events.
Cost: longer copied-proof/revocation exposure. The request-lifetime discussion in
#133 does not itself prescribe directory-proof lifetime.

**C — Per-request serving-time signatures rather than static signed artifacts.**
Benefit: naturally fresh timestamps and no scheduled artifact expiry.
Cost: signing key online at the serving boundary; conflicts with a purely static
deployment and requires a separately reviewed authority/DoS boundary.

Cache lifetime is not signature lifetime. Specify renewal failure, stale serving,
clock drift, expiry and rollback behavior. Do not rely on M3 to reject expired
publisher proof: current discovery does not validate that proof. Static hosting
must not advertise continuing proof validity after expiry; changing a website
banner is not expiry enforcement. Approval must identify how serving stops or
artifacts renew before the deadline.

### D6 — Static demo key custody and deployment

**A — Maintainer-operated offline signing; deploy public artifacts only (recommended
for the first demo).**
Use a dedicated non-production demo identity key held outside Git, explicit
canonical origin and atomic body/header deployment. Document manual renewal and
an independent expiry check. Do not deploy until D5's serving/renewal requirements
can actually be met.
Benefit: no private key on hosting or general CI workers.
Cost: manual operational responsibility; fixed response headers must be supported.

**B — Scheduled trusted workflow signs and deploys with a dedicated protected key
or signing service.**
Benefit: unattended renewal.
Cost: online signing authority and workflow/environment security become part of
the threat model. npm trusted publishing does not provide this signing key.

**C — Public JWKS-only static demo initially, with signed response publication
demonstrated locally and clearly marked unavailable on the website.**
Benefit: simplest safe public artifact.
Cost: the website cannot claim Cloudflare signed-directory readiness; it does not
waive the mandatory publisher implementation in M5.

Never use the published fixture private key for a real identity. A demo key is
still a signing credential. Do not claim author/agent identity from merely
serving a public key. The selected host must support the directory media type,
signature headers and exact bytes; test the served response, not just local files.

## Fixture-first work sequence after approval

1. Pin RFC 9530, directory response requirements and relevant upstream vectors
   by source/commit/hash/license; distinguish illustrative signatures from goldens.
2. Approve a separate CLI/publisher diagnostic and exit-status contract. Pin
   independent private/public file permission and no-clobber scenarios, with
   Windows ACL and POSIX expectations distinguished.
3. Commit literal body bytes, digest, multi-key response signature bases/headers,
   origin binding and expiry/cache boundary fixtures before publisher code.
4. Implement shared publisher functionality against those bytes; test missing
   signers, duplicate labels, key mismatch, tampered bodies, headers, authority,
   clocks and partial failure. No fixture regeneration to fit production output.
5. Implement keygen/directory/sign-request/inspect by composing public core APIs.
   Test fresh-process ESM/CJS/package bin consumers and fixed sanitized errors.
6. Test actual file creation/permissions and crash/partial-output handling on
   Windows/Linux; test actual TLS listeners and public-only artifact inventories.
7. Prepare agentsig.dev public artifacts and hosting instructions separately.
   Deployment, key provisioning, DNS and live acceptance stay maintainer-owned.

Proposed starting resource bounds, to be confirmed with the API contract:
64 keys, 256 KiB public directory body, 16 KiB response header budget, bounded
request/inspection input aligned with existing core limits, no unbounded stdin
read or body buffering. Validate final multi-signature header size before any
artifact publication; a key-count ceiling does not guarantee it fits 16 KiB.

## Acceptance and honest limits

- Exact independent golden byte equality and public key/thumbprint consistency.
- No private material in stdout/stderr, response artifacts, package files or Git;
  test secret-shaped inputs and backend failures without printing them on failure.
- Every selected supported OS establishes its documented file-security boundary,
  or explicitly rejects the operation before exposing key bytes.
- Per-key response signature verification plus actual body-digest comparison,
  explicit authority and time checks; crypto-only success is not full proof.
- CLI send tests distinguish signed transmission, remote verification and
  authorization. Redirect/421 behavior retains the published fetch limitations.
- Hosted demo evidence must identify actual HTTPS origin, header support,
  encoding, signature expiry and operational renewal, without leaking its key.
- Full build/type/consumer/fixture checks, package inventories and reviewer-approved
  docs. ATTW/publint results are separate checks, not inferred from consumers.
- No production readiness, live Cloudflare acceptance, IETF endorsement, universal
  SSRF defense or independent security audit implied by passing local tests.

Before 1.0, request-body verification, the fixed-group-to-independent-versioning
decision, and manual-triggered GitHub Actions trusted publishing with provenance
remain separate tracked obligations. M5 does not silently close those items.

No M5 implementation has started. Approval of D1-D6 and the subsequent error/API
contract is required before fixture generation or production changes.