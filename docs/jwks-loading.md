# M2 local JWKS loading contract

Updated September 19, 2026. The loader is implemented and exposed through the
[profile entry point](../packages/core/src/profiles.ts). Full offline verification
and profile consumers were subsequently completed in M2. Historical test counts
below describe the original loader milestone, not the current total.
No security review or production-readiness claim is made.

## Trust boundary

The [local loader](../packages/core/src/profiles/jwks.ts) accepts trusted
application configuration only. Public keys supplied by an incoming request
cannot replace that configuration. There is no network access, certificate
download, directory discovery, automatic refresh, or proof of domain ownership.

Objects, JSON text, and UTF-8 bytes are supported. Default budgets are 256 KiB
and 64 keys; unsupported and duplicate entries count toward the limits.
[Input snapshots](../packages/core/src/profiles/jwks-input.ts) isolate the loaded
view from subsequent caller mutation. The size budget bounds the JSON
representation, not exact JavaScript heap usage. Local configuration objects
are trusted code; this is not a sandbox for executable Proxies.

Keys are selected only by recomputed SHA-256 RFC 7638 thumbprints. Loading or
finding a key does not verify a signature, consume a nonce, check time, permit
a test key, or establish a URL identity.

## Two explicit input formats

| Format | Ed25519 algorithm metadata | Key label |
| --- | --- | --- |
| Default generic JWKS | Absent or exactly JOSE EdDSA | Optional opaque string; never used for selection |
| WG directory-00 | Absent or exactly HTTP ed25519 | If present, must equal the computed thumbprint |

There is no silent translation or automatic retry between formats. The WG key
label requirement comes from §5.5; the algorithm-name requirement comes from
§5.5.1. The [original excerpt](../tests/fixtures/jwks/wg-discovery-format-excerpt.txt)
is preserved verbatim. These sections impose no additional normative key-use
or key-operation restrictions; the example includes signature use.

## Approved usage policy A

The [local usage policy](../packages/core/src/profiles/jwks-usage.ts) is identical
for both formats. Ed25519 use must be absent or signature use. An absent
operation list is accepted; a present list must include verification and contain
only signing/verification operations.

Malformed metadata types, duplicate operations, and known use/operation
contradictions reject the entire load. Ed25519-specific restrictions do not
apply to the entire OKP family: X25519 and Ed448 are not rejected merely for
declaring encryption use. Structurally valid unsupported keys are reported and
skipped.

## Approved algorithm policy B for unsupported keys

[Algorithm classification](../packages/core/src/profiles/jwks-algorithm.ts) does
not implement additional cryptographic algorithms.

1. No algorithm metadata: report and skip the key.
2. Name in the selected format's pinned vocabulary: report and skip. No general
   key/algorithm compatibility check is performed for these skipped keys.
3. Name belonging to the opposite format: reject the entire load as a format error.
4. Name in neither vocabulary: skip with the unknown-algorithm-name load-report
   reason. This is not an addition to the frozen request result catalog.
5. Another key type/curve using the selected format's Ed25519 algorithm name:
   reject. Ed448 with JOSE EdDSA is valid under RFC 8037; rejecting it here is an
   explicitly approved, narrower local policy.
6. Symmetric keys are rejected from a public JWKS even if secret fields are absent.

WG §5.5.1 registry membership is enforced strictly for usable Ed25519 keys.
Unknown names on keys excluded from verification do not by themselves reject
the whole set, because pinned registries age. Successful loading therefore
does not prove full WG directory conformance of skipped entries.

Skipped key objects never enter the verification pool. Looking up their
thumbprints returns unsupported-algorithm; an unknown thumbprint returns
unknown-key. Neither result triggers network access.

## Errors and operator diagnostics

[Configuration errors](../packages/core/src/profiles/jwks-error.ts) retain the
frozen invalid-jwks code and include a zero-based key index, optional label,
and violated rule. Parsing or total-budget errors can occur before a key index
is available; those receive document-level diagnostics.

Displayed labels escape control characters and truncate after 256 UTF-16 code
units with an explicit marker. The raw label remains in the structured diagnostic
field: do not write that field directly to a terminal or line-oriented log.
Messages exclude key components, private material, and raw crypto backend errors.

## Sources, fixtures, and validation history

The [pinned name lists](../tests/fixtures/jwks/algorithm-lists.json) contain
31 JOSE names registered for the algorithm usage location in RFC 7518/8037;
content-encryption usage registrations are excluded. The HTTP vocabulary
contains six names from the IANA registry referenced by RFC 9421 §6.2.

The [IANA source](https://www.iana.org/assignments/http-message-signature/http-message-signature.xml)
was retrieved at 2026-09-18T20:36:24.390Z and reports an update date of 2026-07-20.
Original snapshot SHA-256:
bd4b0304e21e226fef189ed283a31392b5ffc99a37d00e9911dc011dcfb1523f.

Source bytes, including trailing whitespace on two lines, are preserved.
RFC documents retain their original license notices; the project MIT license
does not relicense them. The registry is attributed to IANA without implying
endorsement.

Fixtures were committed separately before the production loader:

- **ab8812f:** initial JWKS sources.
- **1fd6fd5:** usage policy.
- **45153ff:** algorithm vocabularies and the six rules.

The [independent audit](../tests/jwks-fixture-audit.test.mjs) imports no agentsig
code. It pins 32 basic, 54 usage, and 410 algorithm scenarios.
[Loader tests](../packages/core/test/profile-jwks.test.ts) exercise the fixture
matrix through object/text/byte input paths and add boundary checks.

At the original loader milestone, local Windows / Node 22 regression passed:
3,661 unit tests (including 625 profile tests), nine integration tests, 27
independent JWKS/M2 audits, the M1 fixture audit, and both packages' build/type
checks. Consumer tests at that time covered only M1; later M2 work added the
profile exports and full offline verifier. See the
[current delivery record](deferred.md) for subsequent results.