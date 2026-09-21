# Draft: WG Appendix F implementation listing issue

Status: maintainer-review draft, not submitted by the assistant.
Intended destination:
https://github.com/webbotauth/draft-ietf-webbotauth-httpsig-protocol/issues/new

## Suggested title

Appendix F.1/F.2: consider listing agentsig's Node.js client and server integrations

## Suggested body

Would the editors consider adding agentsig to the informative implementation
list in Appendix F? The section names below refer to the pinned WG protocol-00
document (F.1 Clients and F.2 Servers); please adjust placement if they have moved.

Repository: https://github.com/agentsig-dev/agentsig
License: MIT
Runtime: Node.js; ESM and CommonJS
Release: 0.2.0 for core and the client/framework packages

### Proposed F.1 client entry

**agentsig** — independent Node.js implementation. The @agentsig/fetch package
constructs a clean outgoing request and signs its final serialized method, URL
and stable headers using the core Web Bot Auth signer. It defaults to the pinned
WG protocol-00 profile; the separate Cloudflare documentation profile is explicit.
Redirects are manual and there is no wrapper retry or re-signing loop.

- https://www.npmjs.com/package/@agentsig/fetch
- https://github.com/agentsig-dev/agentsig/tree/main/packages/fetch

### Proposed F.2 server entry

**agentsig** — Node HTTP/1.1 integrations for Hono, Fastify and Express, sharing
an RFC 9421 Ed25519 engine, pinned profile verification and replay enforcement.
They capture request information before framework conversion/rewrites and keep
signature verification separate from application authorization.

- https://www.npmjs.com/package/@agentsig/hono
- https://www.npmjs.com/package/@agentsig/fastify
- https://www.npmjs.com/package/@agentsig/express
- https://github.com/agentsig-dev/agentsig/tree/main/packages/core

The core supports trusted local public-JWKS verification, bounded HTTPS directory
discovery, explicit origin admission, memory replay and an optional Redis adapter.
The framework packages do not implement their own cryptography or discovery.

### Compatibility and limits

The compatibility matrix, pinned source identities and local-policy differences
are documented here:

https://github.com/agentsig-dev/agentsig#protocol-compatibility

This is not a claim of complete protocol conformance. In particular:

- The shipped ietf-wg-protocol-00 profile applies Section 5.2.1 label/member
  matching strictly. E.2.1 is retained unchanged as a negative profile fixture.
- We reported the example discrepancy in
  [#135](https://github.com/webbotauth/draft-ietf-webbotauth-httpsig-protocol/issues/135)
  and contributed an independent-implementation comment to
  [#128](https://github.com/webbotauth/draft-ietf-webbotauth-httpsig-protocol/issues/128).
  A Section 5.2.2-only interpretation, if adopted in a later revision, would
  be reviewed as a new pinned profile rather than a silent -00 behavior change.
- Local defaults require method and complete target-URI coverage, required
  nonces, short signature lifetimes and explicit trust configuration.
- Discovery supports the directory mechanism, not arbitrary jwks_uri/CIMD or
  DNSSEC/DANE mechanisms. It rejects redirects and stale acceptance.
- Publisher-side signed directory response generation and portable proof
  verification are not implemented in 0.2.0. The former is planned M5 work,
  mandatory for our separate pinned Cloudflare documentation profile.
- Actual request-body digest verification is not implemented. Signature validity
  is not payload integrity; enforcement rejects framed bodies by default unless
  identity-only acceptance is explicitly selected.
- Production crypto is Ed25519-only. The adapters are Node HTTP/1.1 only, including
  Hono through its Node bridge; HTTP/2, upgrades and trailer signatures are outside
  that scope. Hono has a documented conversion restriction for certain valid
  expanded IPv6 Host spellings.
- One signed Fetch invocation is not exactly-once wire delivery; native Fetch
  can resend the same signature after HTTP 421.
- Redis durability, failover and deployment trust limitations remain explicit.

Independent pinned vectors and byte-equality checks are supplemented by local TLS,
full verification/replay tests, and a maintainer-run eleven-scenario adapter smoke.
The release CI and clean-directory installation were confirmed by the maintainer.
These results do not constitute an independent security audit, public-network
routing proof, live Cloudflare acceptance, or an IETF endorsement.

The request is for an informative implementation listing only. We can keep the
entry concise and leave the detailed compatibility matrix in the repository.