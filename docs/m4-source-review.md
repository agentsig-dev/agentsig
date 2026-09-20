# M4 framework and transport source review

Reviewed September 20, 2026. This is the first M4 source-fixture checkpoint,
before mapping expectations or production implementation. Source inspection is
not framework acceptance, a security audit, or evidence of live authentication.

## Pinned inventory

The [source manifest](../tests/fixtures/m4-sources/manifest.json) records 85 files
with byte lengths, SHA-256 digests, source URLs, and transformations. Original
source and license bytes are retained unchanged. Registry metadata, archive
inventories, and Git reference chains are evidence, not executable dependencies.

| Source | Release commit | License |
| --- | --- | --- |
| Express 4.22.3 | 899b52494e74327905c16164decdc6e51f803af8 | MIT |
| Express 5.2.1 | dbac741a49a5a64336b70c06e85c2e2706e36336 | MIT |
| Router 2.2.0 (Express 5 routing) | e6d6b609fc355e558174ccd5b1db646f739fe88c | MIT |
| Fastify 5.12.5 | ba235fdcd9a83a4c7ccf793f7b2596a8f65389b6 | MIT |
| Hono 4.13.8 | 098e11912ab244c5c33931de007f04dc8e3c2929 | MIT |
| @hono/node-server 2.1.1 | 73c03adfb01928fcd5f5b20faebd5d692f83fc93 | MIT |
| Undici 6.28.0 npm archive | 01a912e49a50c48009ed2639d2a457a6ec26752a | MIT, including Fetch notice |
| Node v20.20.2, bundled Undici 6.24.1 | 3626fea570e44896ad99aaf3bf6e59def5adede5 | Retained Node and Undici notices |
| Node v22.23.2, bundled Undici 6.28.0 | aa4c77582be995286fc6e00aaf530dc7ade102a9 | Retained Node and Undici notices |
| Node v24.21.0, bundled Undici 7.29.1 | 955266bfdd854cd280dffd47548673914484e4c0 | Retained Node and Undici notices |

RFC 7239 is pinned by publication number, original text hash and retained IETF
notices, not an invented Git commit. Its grammar does not establish proxy trust.

All seven npm archives were downloaded again, checked against their recorded
SHA-512 integrity values, and every retained archive member compared byte for
byte. Existing Node source files and RFC 7239 were also compared with fresh
downloads from their recorded URLs. No upstream JavaScript or package lifecycle
script was executed. Temporary archives are not committed.

Six npm registry records include gitHead matching the retained release-tag chain.
The Hono Node record omits gitHead. Its retained registry provenance payload binds
the same archive SHA-512 to the commit in the table and the v2.1.1 workflow ref;
the Git tag independently points to that commit. This checks payload consistency,
not Sigstore signature, certificate, transparency-log, or local PGP verification.
A release commit does not prove reproducible compilation of npm distribution files.

## Capture findings and implementation obligations

- Express 4's [router](../tests/fixtures/m4-sources/express-4.22.3/lib/router/index.js:173)
  and Express 5's [Router dependency](../tests/fixtures/m4-sources/router-2.2.0/index.js:184)
  initialize originalUrl from the current URL and strip mounted prefixes later.
  Capture at the Node listener before dispatch to either application. originalUrl
  is not proof that no earlier middleware rewrote the request.
- Fastify [rewrites before routing](../tests/fixtures/m4-sources/fastify-5.12.5/fastify.js:805).
  Its [server factory](../tests/fixtures/m4-sources/fastify-5.12.5/lib/server.js:312)
  receives the HTTP handler, allowing an outer capture boundary. onRequest alone
  is too late to establish the pre-rewrite target. Injection tests do not exercise
  this real listener boundary and cannot replace it.
- Hono Node [materializes headers](../tests/fixtures/m4-sources/hono-node-server-2.1.1/dist/index.mjs:49),
  [normalizes URLs](../tests/fixtures/m4-sources/hono-node-server-2.1.1/dist/index.mjs:171),
  and [passes incoming/outgoing bindings](../tests/fixtures/m4-sources/hono-node-server-2.1.1/dist/index.mjs:1023)
  with the converted request. Wrap the Node listener before conversion, then
  privately associate that exact converted request with the captured incoming
  request before Hono dispatch. Fetch headers/URL alone cannot recover lost bytes.
- Hono Node [replaces global Request/Response by default](../tests/fixtures/m4-sources/hono-node-server-2.1.1/dist/index.mjs:994).
  Its explicit overrideGlobalObjects option and separate cleanup/error behavior
  must be considered in the later integration contract; this checkpoint does not
  silently approve an integration configuration.
  [Response error handling](../tests/fixtures/m4-sources/hono-node-server-2.1.1/dist/index.mjs:865)
  can log raw errors and emit error text. agentsig failures must be contained and
  sanitized before reaching such paths. Upstream body cleanup is not body integrity.
- All three pinned Node releases retain the count-limited parser collection path.
  [Node 22 collection](../tests/fixtures/m4-sources/node-v22.23.2/lib/_http_common.js:60)
  and [server setup](../tests/fixtures/m4-sources/node-v22.23.2/lib/_http_server.js:727)
  show why rawHeaders alone cannot establish completeness. Configure compatible
  byte/count bounds before accepting connections; account for the count's bit-shift
  representation. Do not attempt to repair a truncated snapshot afterward.
- Node HTTP/1.1 capture remains the approved boundary. Source-level support for
  HTTP/2 in a framework does not authorize an agentsig HTTP/2 translation.

These exact framework versions are candidates for the next listener tests.
No broad major-version peer range is established by inspecting one release.
Start validation with the exact versions above; expand peer ranges only after
source review and tests justify them. Both Express majors remain candidates.
No framework dependency was installed and no package manifest/version was changed.

## Native Fetch is not exactly-once delivery

The selected Fetch source in each pinned Node release contains manual redirect
handling and a separate HTTP 421 resend path. Node 24's bundled Undici 7.29.1
retains that distinction. Node 20's bundled package version is 6.24.1 even though
its selected Fetch source file is byte-identical to the retained npm 6.28.0 file;
one identical file does not make the whole distributions equivalent.

The [approved plan](milestone-4-plan.md#source-review-finding-native-fetch-can-resend-after-http-421)
records the earlier unsigned Node 22 probe. That probe was not repeated here.
The guarantee remains one wrapper signing operation and one selected transport
invocation, not one wire transmission or visibility of every intermediate response.
Signed replay consequences, TLS behavior and injected transports need separate tests.

## Inherited-work corrections and validation

The inherited 68-file manifest and 12-test audit passed locally on Windows /
Node 22.23.2. Five retained Hono distribution files were nevertheless ignored by
Git. Narrow ignore exceptions now include them in ordinary staging. Byte-preserving
attributes cover this source directory, including embedded CR bytes in upstream
distribution code; earlier fixture attributes and source bytes are unchanged.

Seventeen added evidence files complete the seven npm Git reference chains,
Hono Node registry provenance, and Node 24 source/notice set. Nothing was deleted.
The expanded independent audit passes 17 tests locally on Windows / Node 22.23.2,
including real staging and checkout under autocrlf false, true and input. It
executes no retained upstream code and requires no framework installation.

The fixture workflow now includes this audit on its existing Node 20/22/24 and
Windows/Linux matrix. Remote CI, local Node 20/24 execution, framework listeners,
cryptographic acceptance, and a security audit are not claimed by this checkpoint.
The next separate commit must pin independently authored identical raw-request
mapping expectations for all three frameworks before any mapper implementation.

Final source-only regression also passed the independent RFC audit and all 252
combined fixture audit/integrity tests on local Windows / Node 22.23.2, with no
failures or skips. This total includes the 17 M4 checks; the runs are not additive.
Build, production unit tests and real Redis tests were not rerun for this
source-only change.