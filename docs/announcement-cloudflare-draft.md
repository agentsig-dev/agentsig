# Draft: Cloudflare web-bot-auth discussion

Status: maintainer-review draft, not submitted by the assistant.
Intended destination: https://github.com/cloudflare/web-bot-auth/discussions
Confirm the repository's available discussion categories before posting.

## Suggested title

agentsig 0.2.0: independent Node.js implementation with pinned profile compatibility

## Suggested body

We have published agentsig 0.2.0, an independent MIT-licensed Node.js implementation
of HTTP Message Signatures and selected Web Bot Auth functionality:

https://github.com/agentsig-dev/agentsig

The implementation includes:

- An Ed25519 RFC 9421 engine and a separate RFC 9651 Structured Fields package.
- Signing and verification for the pinned IETF WG protocol-00 profile and an
  explicitly selected Cloudflare documentation profile.
- Offline public-JWKS verification and bounded HTTPS directory discovery, with
  destination restrictions, explicit proxy configuration and cache/key rotation.
- Memory replay protection and an optional Redis replay adapter.
- A signed Fetch wrapper and Node HTTP/1.1 integrations for Hono, Fastify and
  Express, with separate authentication and application authorization.

The profile comparison and implementation limits are recorded here:

https://github.com/agentsig-dev/agentsig#protocol-compatibility

The Cloudflare profile name, cloudflare-docs-2026-07-01, identifies our pinned
documentation snapshot; it is not a Cloudflare-issued compatibility certification.
It uses the quoted Structured String Signature-Agent form, rather than the WG
Dictionary form. There is no automatic fallback between the two grammars.

Our local policies require method and complete target-URI coverage and enable
nonce protection by default. These are stricter local choices, not claims about
what Cloudflare requires or how its service handles replay.

Important limitations:

- Publisher-side signed directory response generation is not implemented in
  0.2.0. It is mandatory planned M5 work for our Cloudflare profile. Current
  discovery establishes HTTPS origin/key association, not portable signed proof.
- Actual body-digest verification is not implemented. Signing a digest header
  alone does not establish payload integrity; adapters reject framed bodies by
  default in enforcement unless identity-only acceptance is explicitly selected.
- Production cryptography is Ed25519-only. Inbound adapters do not support HTTP/2,
  upgrades or trailer signatures. Hono's Node conversion has additional documented
  limits, including some expanded IPv6 Host spellings.
- Manual redirects and one Fetch invocation do not guarantee exactly-once network
  delivery; native Fetch may resend an identical signed request after HTTP 421.
- No live Cloudflare acceptance, Verified Bot approval, independent security audit,
  official endorsement or production-readiness claim is made. Redis failover,
  durability and deployment-specific trust limits remain documented.

The test suite uses independently sourced/pinned vectors and exact byte
comparisons, plus local TLS listener and full verification/replay tests. The
maintainer has also run the eleven-scenario adapter smoke successfully. Those
results do not substitute for interoperability testing against Cloudflare services.

We reported the E.2.1 signature-label/member discrepancy in WG issue #135 and
provided an implementation data point in #128:

https://github.com/webbotauth/draft-ietf-webbotauth-httpsig-protocol/issues/135
https://github.com/webbotauth/draft-ietf-webbotauth-httpsig-protocol/issues/128

The shipped WG -00 profile retains strict Section 5.2.1 matching and the published
example remains an unchanged negative fixture. If a later WG revision adopts
Section 5.2.2-only covered-member attribution, we will review it as a separately
pinned profile rather than silently changing the current one.

This is an implementation notice and a source of reproducible compatibility
findings, not a request to treat agentsig as an official reference implementation.