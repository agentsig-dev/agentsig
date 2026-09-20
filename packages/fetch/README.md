# @agentsig/fetch

> **Status: 0.2.0 versioned locally; publication pending; not security-reviewed.**

Explicit signed Fetch for Node 20+, with an exact @agentsig/core 0.2.0 dependency.
The coordinated Changeset has been consumed and the maintainer has accepted M4.
Publication remains pending. No production-readiness or live Cloudflare acceptance
claim. ESM, CommonJS and declarations are provided.

## Installation

After the maintainer publishes the coordinated release:

```sh
npm install @agentsig/fetch@0.2.0 @agentsig/core@0.2.0
```

Until then, use the built repository workspace. Installing published core 0.1.1
does not provide the new HTTP/adapters APIs. Keep key management and signer
configuration application-owned; the wrapper never generates or persists keys.

## Ten-line local example

This example uses an injected in-process transport, not a network service.
Expected output: 204. The ephemeral key is for demonstration only.

```js
import { generateKeyPairSync } from "node:crypto";
import { createWebBotAuthSigner } from "@agentsig/core/profiles";
import { createSignedFetch } from "@agentsig/fetch";
const { privateKey } = generateKeyPairSync("ed25519");
const signer = createWebBotAuthSigner({ privateKey, agentOrigin: "https://agent.example" });
const send = createSignedFetch({
  signer,
  fetch: async request => new Response(null, { status: request.headers.has("signature") ? 204 : 400 }),
});
console.log((await send("https://merchant.example/items")).status);
```

Omit the fetch option to use native global fetch, captured when the factory is
created. The factory also captures the signer callable. Changing global fetch
later does not change an existing wrapper's selected transport.

## Request contract

Each invocation constructs a fresh owned Request, signs its final serialized
method, URL and stable header view, attaches the three signature headers, then
invokes the selected transport once. Fetch normalization happens before signing:
method case, URL serialization and header joining can differ from raw input.
This is deliberately different from lossless inbound Node mapping.

Signature, Signature-Input and Signature-Agent are checked separately in the
input Request and init headers before override merging. Even empty existing
values reject with SigningError code existing-signature-headers. No stripping,
merging or silent re-signing of an already signed request occurs. Reusing a clean
bodyless Request explicitly creates another owned request and another signature;
never configure a fixed nonce in production.

Redirect mode is always manual. Explicit init redirect follow/error options
reject; an input Request's inherited redirect mode is replaced on the owned
request. Responses, including same-origin redirects, 401, 429 and server errors,
are returned without wrapper follow, retry or re-signing.

Caller Host/authority, Content-Length and hop-by-hop/proxy transport headers reject
even if init headers would hide them. No-cors rejects because it may silently
filter signature headers. Unknown init fields, including dispatcher, reject.
For a dispatcher use an explicitly injected transport instead. Additional signer
coverage must refer to stable final Request fields, not guessed headers the
transport might add. Native Fetch's automatic headers are not promised covered.

## Bodies and cancellation

Bodies are rejected by default, including non-null empty bodies. Explicit
bodyPolicy: "allow-unverified" forwards identity-only traffic. There is **no body
integrity verification**, digest comparison, wrapper buffering/hashing, rewind,
clone or tee for replay. Standard Request construction owns/proxies input streams;
used or locked bodies reject and cannot be reused for another send. Streaming init
bodies require duplex: "half". Signed Content-Digest alone does not establish
integrity of payload bytes or payment instructions.

Cancellation before signing performs no signing or dispatch. Cancellation after
signing but before transport performs no dispatch. Abort errors use fixed text,
never the caller's reason. After dispatch, an abort or transport failure cannot
prove that the server did not receive or execute the request. Wrapper validation,
unexpected signer failures and transport errors are sanitized without raw input
or nested causes. Known SigningError codes are retained in a fresh safe error.

## Limits and trust

HTTPS is required by default. allowHttpLoopbackForTests: true permits plaintext
only for exact 127.0.0.1 and [::1] literals, with an absent default or valid decimal
port 1–65535. Localhost/DNS names, other loopback addresses, shortened/integer/hex
IPv4 aliases, mapped IPv6 and zone IDs reject. Raw strings are checked before URL
normalization. A preconstructed URL/Request exposes only its serialized address:
the original spelling is unrecoverable and is not attested. The exception performs
no DNS lookup and does not change directory discovery SSRF policy.

This is not a general SSRF-safe client: applications must control HTTPS destinations
and egress. A trusted injected function can retry, follow redirects, mutate requests
or ignore TLS. The wrapper supplies manual mode but cannot attest custom behavior.
The default native transport and injected transport tests are separate evidence.

**One signing operation plus one selected fetch invocation is not a guarantee of
one network transmission or exactly-once delivery.** Native Fetch can resend after
HTTP 421. A real local test observed the same signature being sent twice: initial
verification succeeded, then replay protection rejected the resend. No fresh nonce
was issued. A later replay rejection is not proof an earlier operation did not occur.

Inbound adapters support HTTP/1.1 only; this wrapper does not implement HTTP/2
signature mapping or promise control of native/custom transport negotiation.
Fragments, URL credentials, backslash repair and whitespace-bearing URL strings
are rejected rather than silently stripped. URL length is capped at 16 KiB before
construction; signer resource limits remain independently active.

## Evidence

Independent golden fixtures precede implementation and compare exact outgoing
header bytes for both profiles. Native loopback tests cover redirects, status
failures, body forwarding and 421/replay behavior. Injected tests cover ownership,
collisions, cancellation and no wrapper retry. ESM/CommonJS consumers exercise
public exports and real offline verification. These are not the maintainer-owned
adapter smoke, remote CI, live Cloudflare acceptance or a security audit.

MIT. Public test keys, fixture files and source tests are not shipped.