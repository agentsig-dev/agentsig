# WG E.2.1 discrepancy report

The report text below was prepared for the maintainer to submit.
The maintainer subsequently supplied this issue reference:
https://github.com/webbotauth/draft-ietf-webbotauth-httpsig-protocol/issues/135

Current issue repository: https://github.com/webbotauth/draft-ietf-webbotauth-httpsig-protocol
Historical draft repository examined during research:
https://github.com/thibmeu/http-message-signatures-directory

The assistant did not submit the report. This reference does not establish
the issue's current resolution status or authorize changing pinned fixtures.

## Subject

draft-ietf-webbotauth-httpsig-protocol-00: label/member mismatch in Appendix E.2.1

## Message

While checking the Ed25519 vector in Appendix E.2.1 of
draft-ietf-webbotauth-httpsig-protocol-00, we noticed that Signature-Input
and Signature use the label sig2, while Signature-Agent uses the member
key agent2. The covered Signature-Agent component also selects agent2.

This appears inconsistent with Section 5.2.1's requirement to cover the
Signature-Agent member keyed to the signature label.

The published signature is cryptographically valid: we independently
verified the published 375-byte signature base and 64-byte Ed25519
signature using the RFC 9421 Appendix B.1.4 public key. The observation
concerns profile label binding, not a cryptographic failure.

A minimal correction would be to change the labels in Signature-Input
and Signature from sig2 to agent2, and update the accompanying prose.
Those labels are not included in the signature base, so this should
preserve the published base and signature bytes.

Alternatively, if sig2 is the intended label, change the Signature-Agent
member and its covered key parameter to sig2, update the signature base,
and recompute the signature.

Could you confirm which naming is intended?

Reference:
https://www.ietf.org/archive/id/draft-ietf-webbotauth-httpsig-protocol-00.html#appendix-E.2.1

## Local test record

The original [vector section](../tests/fixtures/m2/published/wg-E.2.1/section.txt),
[signature base](../tests/fixtures/m2/published/wg-E.2.1/base.txt), and
[signature bytes](../tests/fixtures/m2/published/wg-E.2.1/signature.bin) remain unchanged.
The [policy fixture](../tests/fixtures/m2/policy-cases.json) expects
agent-label-mismatch only at the label-binding stage. Other coverage and time
policy failures also exist, so the fixture does not assert the full verifier's
first rejection reason.

This report makes no general conformance claim for other appendices or draft
versions. Any future corrected vector must be separately sourced and recorded;
it must not silently replace the original published bytes.