# M2 profile signer

Updated September 19, 2026. The signer, golden tests, profile package entry,
and full offline verifier integration are implemented. Local acceptance tests
passed; the maintainer subsequently confirmed the core-m2 CI/fixture workflows.
This is not a security-review or production-readiness claim.
The [offline verification guide](offline-verification.md) describes the current
API and trust boundaries.

## Contract

The [signer factory](../packages/core/src/profiles/signer.ts) creates a signer
from trusted local configuration. Each call receives a clean request descriptor
and returns three immutable, ordered name/value tuples with canonical names:
Signature-Input, Signature, and Signature-Agent. Applying these headers to the
request is the caller's responsibility.

The default profile is WG-00, the default label is sig1, and the signing lifetime
is 60 seconds. The Cloudflare documentation profile requires explicit selection;
there is no automatic downgrade or retry. In WG form, the agent Dictionary
member key equals the signature label. The Cloudflare agent header is a single
String and therefore does not contain the label.

Required coverage is method, complete target URI, and the profile-specific agent
component. Additional components cannot remove this coverage. Body integrity is
not checked: covering Content-Digest does not compare its value with body bytes.

The signer uses the [shared origin validation](../packages/core/src/profiles/agent-origin.ts).
It generates a new agent header containing the canonical origin. The verifier,
in contrast, never rewrites an incoming signed header.

## Existing headers and mutation

Signing rejects a request if any Signature, Signature-Input, or Signature-Agent
header is already present. Name matching is case-insensitive; an empty value
still counts as an existing field. There is no merging or silent overwrite.
This local M2 signer boundary does not remove the verifier's independent
multiple-candidate support.

The [request snapshot](../packages/core/src/profiles/signing-request.ts) is
created before invoking providers. The original request, header array, tuples,
and byte arrays are not mutated. A provider that changes the original request
through a closure cannot change the owned signing input. The caller must apply
the returned headers to the same request and preserve it until transmission.

## Clock and nonce providers

The [synchronous provider contract](../packages/core/src/profiles/signing-providers.ts)
uses a clock returning Unix milliseconds and a nonce generator returning text.
The default clock is the platform wall clock. The default nonce is 32
cryptographically random bytes encoded as unpadded base64url.

Clock output must be a finite, nonnegative number. Creation time is the floor
of milliseconds divided by 1,000; expiration adds the configured lifetime.
Both timestamps must fit the SF Integer range. This wall-clock provider does
not replace the verifier's monotonic-reference clock-health mechanism.

The [shared nonce helper](../packages/core/src/profiles/nonce.ts) enforces the
default length of 1–256 printable ASCII bytes. Space, quotation marks, and
backslashes are valid. Values are neither trimmed nor normalized. The signer
serializes the nonce as an SF String rather than concatenating provider output
into raw header syntax.

**Fixed clocks and deterministic nonce providers are for tests. Production use
can generate stale timestamps or repeated nonces.** The default generator uses
a cryptographically secure random source on every call, with no deterministic
fallback. Valid nonce syntax does not prove entropy.

Asynchronous provider results are neither accepted nor awaited. Remote signing
services require a future, separate signing-provider interface. A Promise-based
signing API does not mean that current cryptography runs on a worker.

## Separate closed error catalog

[Signing errors](../packages/core/src/profiles/signing-errors.ts) use one class,
a stable code, and an empty immutable details object. The catalog contains
13 codes:

- existing-signature-headers
- invalid-signing-key
- test-key-disallowed
- invalid-agent-origin
- invalid-label
- unsupported-profile
- unsupported-component
- invalid-request
- invalid-signing-options
- clock-unavailable
- nonce-generation-failed
- resource-limit
- signing-failed

Catalog version 1 is frozen. Changes require separate approval and release notes.
It is not a shared type/union with verification errors. Identically spelled codes
do not imply identical error boundaries.

Raw provider errors, nonce values, and key material are not included in messages,
details, or cause chains. Crypto failures are mapped only at the crypto-call
boundary; unexpected programming errors are not hidden behind a generic code.
Known public test keys are denied by default. Explicit test permission does not
disable other security checks.

## Golden criteria and completed integration

Fixtures were committed in **bb54838** before implementation.
The [independent fixture audit](../tests/signing-fixture-audit.test.mjs) verifies
four signatures and complete header bytes without agentsig code.
[Production signer tests](../packages/core/test/profile-signer.test.ts) require
byte equality for both profiles with ordinary and escaped nonces. A round trip
through our own signer is not the independent golden oracle.

At the original signer milestone, local Windows / Node 22 validation passed
168 targeted tests, 4,034 unit tests, nine integration tests, 44 independent
fixture audits, and the M1 audit. These counts belong to that historical delivery.

**The full offline verifier round-trip acceptance gate subsequently passed.**
[Round-trip tests](../packages/core/test/profile-verifier-roundtrip.test.ts)
exercise all four independent golden outputs across both profiles, requiring
full verified results and replay rejection on the second use. Success includes
local identity binding, time checks, and nonce consumption in the real memory
store. Pure cryptographic validity is not counted as a substitute; independent
golden byte equality remains a separate requirement.

[Profile consumer tests](../tests/profile-consumer.test.mjs) use the real package
subpath in separate ESM/CommonJS processes. They exercise signing, verification,
replay rejection, both declaration formats, and exclusion of internal capabilities.

The completed M2 local regression passed 4,284 unit tests, 13 integration tests,
60 additional independent fixture audits, the M1 audit, and both packages'
build/type checks. The maintainer confirmed green core-m2 remote CI and fixture
workflows; this does not establish remote CI success for later documentation
or release-preparation commits. The assistant did not push, publish, or submit
the WG report.