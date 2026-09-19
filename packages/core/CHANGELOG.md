# @agentsig/core

## 0.1.0

### Minor Changes

- 17b98d3: Prepare the initial 0.1.0 release. Pre-release quality; not security-reviewed.

  - @agentsig/structured-fields provides lossless RFC 9651 parsing, canonical serialization, resource limits, and ESM/CommonJS declarations without runtime dependencies.
  - @agentsig/core provides the RFC 9421 Ed25519 engine and a separate offline Web Bot Auth profile API, backed by trusted local public JWKS, explicit identity bindings, time policies, and atomic in-memory replay protection.
  - Both pinned profiles have independent golden fixtures and full signer/verifier round-trip tests. Profile consumers are tested through ESM/CommonJS exports and their TypeScript declarations.
  - No network discovery, directory cache, framework adapters, CLI, body-digest verification, or live Cloudflare acceptance is included.
  - In-memory replay history is process-local and is lost on restart or explicit destructive clock reset. Authentication does not grant authorization or rate-limit exemption.
  - Version preparation does not publish either package.

### Patch Changes

- Updated dependencies [17b98d3]
  - @agentsig/structured-fields@0.1.0
