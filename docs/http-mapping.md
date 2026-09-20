# Node HTTP/1.1 request mapping

This M4 API, versioned in @agentsig/core 0.2.0 with publication pending, follows
independent fixtures committed in 45b8803. It is not available in published 0.1.1
and is not security-reviewed. The maintainer accepted M4 after its adapter smoke
passed; that acceptance is separate from publication and security review.

## Owned capture

Import createNodeHttpMapper from @agentsig/core/http. Supply an explicit
ingress.allowedOrigins array, then create a server through the mapper before
listening. The mapper captures and maps synchronously before dispatching the
application listener. map(request) returns a detached view of that owned result,
not a new interpretation of mutable framework properties.

The mapper creates HTTP or HTTPS servers through createServer(listener) and
createSecureServer(listener, tlsOptions). It does not attach to an arbitrary
already-running server or accept a caller's assertion that raw capture is complete.
Use the owned listener boundary when integrating a framework; middleware placed
after rewrites is not an equivalent installation.

```js
import { createNodeHttpMapper } from "@agentsig/core/http";

const mapper = createNodeHttpMapper({
    ingress: { allowedOrigins: ["https://merchant.example"] },
});
const server = mapper.createSecureServer((request, response) => {
    const mapping = mapper.map(request);
    // Mapping alone does not authenticate, authorize, or block this request.
    response.statusCode = mapping.status === "mapped" ? 204 : 400;
    response.end();
}, applicationTlsOptions);
```

The application owns TLS keys/certificates and server lifecycle. The TLS options
are deliberately limited to key/cert/ca/pfx/passphrase, cipher/version controls,
requestCert/rejectUnauthorized, honorCipherOrder, secureOptions and sessionTimeout.
Unknown options reject setup. ALPN is fixed to HTTP/1.1; this is not an HTTP/2
server bridge. Explicit HTTP/2 descriptors passed to map produce http2-unsupported.

Parser maxHeaderSize and maxHeadersCount are fixed together before connections
arrive; a count equal to the byte ceiling cannot hide an in-budget occurrence.
The strict parser and duplicate-header settings are fixed as well. Limits default
to 16,384 bytes for headers and assembled target URI; configurable positive integer
ceilings cannot exceed 1 MiB. Configuration origin/peer lists are limited to 1,024
entries of at most 2,048 code units each. Setup errors use fixed TypeError text,
not the request mapping catalog.

An incoming request absent from this mapper's private association produces
capture-missing. Dispatch without an owned socket produces capture-incomplete.
Repeated map calls neither recapture nor perform verification. Re-emitting an
already captured request event does not dispatch application processing again.
Application JavaScript is not a sandbox: manually bypassing or replacing listeners
can bypass a middleware library and is outside its guarantee.

## Mapping and immutable ownership

Only origin-form HTTP/1.1 request targets are supported. Absolute-, authority-
and asterisk-form requests are not repaired into origin-form. A leading double
slash remains a path. HTTP/2 and other unsupported versions are rejected explicitly.

Ordered field names and occurrences are preserved. ASCII field values are strings;
Node Latin-1 obs-text values become owned Uint8Array values. map returns new byte
arrays, so a caller mutating a returned view cannot change the private mapping.
Readonly objects/arrays do not make JavaScript typed-array elements immutable.

The capture boundary is after Node HTTP parsing, not a packet sniffer: wire syntax
rejected or transformed by Node cannot be reconstructed. Tests distinguish parser
rejection from mapping failure. HTTP trailers are not used as signature evidence.

Every request needs exactly one valid Host, including behind trusted ingress.
The local Host is retained separately as internalAuthority and in the original
headers. External authority comes from transport/Host in direct mode or the
explicit selected ingress family. It is never copied from signature metadata.

Comparison uses lowercase host and effective port, with IPv6 numeric
canonicalization for identity comparison only. Preserve external authority, path
and query spelling for the targetUri and rawRequestTarget. No URL parser repair,
userinfo, IDNA conversion, numeric IPv4 aliases or guessed port is accepted.
Explicitly allowed IP literals and non-default ports are valid request targets;
this does not change agent-origin identity or directory SSRF policies.

bodyPresent reports HTTP/1.1 framing, not payload integrity. Transfer-Encoding or
nonzero Content-Length counts independently of method. No body is read, buffered,
drained or hashed. Signed digest fields do not prove body integrity. Enforcement
and bodyIntegrity: "unverified" belong to the subsequent policy integration.

## Explicit trusted ingress

Direct mode ignores all forwarding claims for trust while retaining raw fields.
Its scheme comes from TLS, not a forwarded protocol getter.

Trusted ingress requires mode: "trusted-ingress", family: "forwarded" or
"x-forwarded", explicit trustedPeers IP/CIDR rules, allowedOrigins, and
sanitizingIngress: true. This last field is the operator's assertion that ingress
strips client-supplied recognized fields and replaces them unambiguously, not
attestation of infrastructure. The external protocol must be exactly https.
A peer outside the configured set never falls back to direct mode.

Peer comparison is family-specific. An IPv4 trust rule does not implicitly admit
an OS-reported mapped IPv6 peer; explicitly configure the required IPv6 rule if
that representation is used. No DNS peer rules or inherited framework trust-proxy
configuration exists. Loopback trusts other local processes able to connect,
not a particular proxy process. Deployment ACLs and isolation remain necessary.

Forwarded accepts one field and one element, required host/proto, optional for/by,
case-insensitive parameter names, token/quoted-string values and RFC node grammar.
Unknown or repeated parameters, empty pairs and trailing semicolons reject.
Quoted escapes are decoded for validation without rewriting the original header.
The deliberately narrower empty-pair policy sacrifices compatibility, not trust.

X-Forwarded-Host/Proto are required once; For/Port are optional once. For must be
one canonical numeric IP without a port. IPv6 hints use the URL platform's canonical
lowercase/compressed spelling. No comma chains are accepted. Port is one to five
decimal digits representing 1 through 65535; it must equal the explicit Host port
or 443 for a portless host. A matching Port never adds ":443" to a portless target.

The selected family rejects the presence of the unselected recognized family.
Only X-Forwarded-Host/Proto/Port/For participate. Other X-Forwarded-* fields and
X-Real-IP are retained but ignored for trust, including Server/Prefix/Path/Ssl.

observedClient is an optional unauthenticated hint from validated for, never by.
It distinguishes ip/unknown/obfuscated, preserves the decoded address and optional
port string, and always says source: "trusted-ingress", authenticated: false.
The mapper does not use that hint for authorization or rate limiting.

## Failure boundary and rollout

Mapping failure has status mapping-rejected and a code from the separately frozen
seventeen-code HTTP catalog. It has no fabricated verification result or request.
The mapper never invokes a verifier, discovery, replay, policy or observer.

The approved adapter contract requires one sanitized mapping event per owned
assessment: code, adapter and ingress mode only. In observe mode, publish mapping
failure, skip verification and continue with authorization not-evaluated. Count
and investigate mapping failures before moving to enforcement. Observation is not
protection. In enforce mode, policy receives mapping failure but can only deny or
rate-limit; continuation decisions become deny. Mapping denial defaults to 400,
ordinary policy denial after mapping to 401, and rate-limit to 429. Default bodies
contain no reasons. These adapter behaviors are not implemented by mapping alone.

Node parser rejection can precede application capture. Without an application
clientError handler, ordinary malformed requests receive 400 where safely possible
and the socket closes; header overflow uses 431 and other special cases exist.
Installing clientError changes error-handling ownership. Adapters cannot claim to
observe rejected requests that never reached capture. Do not log rawPacket, raw
parser errors, incoming headers or nonces.

Local mapper tests include actual loopback TCP, fragmented late duplicate fields,
TLS with explicit test-certificate/hostname validation, and actual peer admission.
They do not prove framework acceptance, complete signature verification, public
network behavior or a security audit. Fresh ESM/CommonJS consumers check exports,
declarations and inaccessible deep implementation paths. Remote CI for this
implementation is not established by earlier source-checkpoint CI.

## Shared assessment and thin adapters

The subsequent createHttpAgentSig implementation coordinates an application-owned
long-lived verifier, mapping, policy and sanitized observer delivery. It does not
reimplement cryptography, discovery, profile grammar, clock health or replay.
The mapper-only API above remains separate and does not invoke these operations.

Construct the coordinator with mapper, verifier and explicit mode. Enforce requires
policy; observe rejects policy/enforcement-only configuration rather than ignoring
it. Policies receive an owned assessment and invocation-bound decision tools.
allowVerified requires the exact current policy assessment and verified aggregate;
a successful candidate inside a failed aggregate cannot grant that decision.
allowAnonymous remains explicit and never changes the authentication result.
Mapping failure cannot authorize continuation in enforcement.

The coordinator privately registers work before invoking any verifier, observer or
policy callback. Compatible instances on one incoming request share verification
and policy work. Compatibility includes mapper, verifier object/callable, policy,
observer and effective policy settings. Conflicting instances reject without
another verification or nonce consumption. Separate incoming requests do not share
acceptance. Getters require completed owned state and return detached readonly
views; modifying public context slots or returned byte arrays cannot forge it.

Policy tools cease issuing decisions after settlement or timeout. The one-second
default deadline includes synchronous callback time, with a monotonic final check.
The timeout signals cancellation but does not prove application work stopped, and
JavaScript timers cannot preempt blocking synchronous work. No process-global
policy-work bound is claimed. Replay consumption is not rolled back by denial,
timeout, conversion failure or an ambiguous response.

Observer callbacks are synchronous and receive fixed event schemas, never original
exceptions. Throws are contained; returned/deferred asynchronous work is outside
that synchronous exception boundary. Applications must own their logging queues.
Unexpected verifier errors yield a fixed integration failure, not a fabricated
unverified result. Supplied verifiers are trusted application components; the
coordinator does not attest an arbitrary verifier implementation's claims.

Assessment copies use a bounded plain-data representation: a 1 MiB accounting
budget and depth 32, with no ordinary getters invoked. This is not exact heap
measurement. A larger/malformed custom result fails closed as an integration error,
rather than truncating evidence or introducing a verification catalog code.

The framework adapters publish native views, enact empty responses and call the
same coordinator. Integration errors return empty 500 responses. Frameworks remain
peer dependencies only of their adapters. Current peer ranges intentionally name
only reviewed/tested releases: Express 4.22.3 or 5.2.1, Fastify 5.12.5, and Hono
4.13.8 with @hono/node-server 2.1.1. Core and the four integration packages are
versioned at 0.2.0, with publication pending. Each integration depends on exactly
@agentsig/core 0.2.0; workspace linking remains a development installation detail.

Hono assesses before Node-to-Fetch conversion, then privately binds the converted
request to its original incoming request. Observation can continue only when Hono
can convert it. A valid expanded IPv6 Host can pass mapping and fail Hono's
hostname check; the adapter returns empty 400, emits framework-conversion-failed
with only the mapping status/code, and publishes no Hono context. Enforcement
rejection does not invoke conversion. The mapping catalog is unchanged.
Express/Fastify have no corresponding Node-to-Fetch conversion step.

See the adapter guides for installation and scope:
[Express](../packages/express/README.md), [Fastify](../packages/fastify/README.md),
and [Hono](../packages/hono/README.md). Application/framework error handlers and
arbitrary application response streams remain application responsibilities;
agentsig does not promise to sanitize all framework-generated logging.