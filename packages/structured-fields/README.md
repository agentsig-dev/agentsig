# @agentsig/structured-fields

[![npm](https://img.shields.io/npm/v/@agentsig/structured-fields.svg)](https://www.npmjs.com/package/@agentsig/structured-fields)

> **Status: pre-release; RFC 9651 parser/serializer only; not security-reviewed**

RFC 9651 Structured Fields parsing and canonical serialization for Node 20+.
No runtime dependencies. ESM, CommonJS, and declarations for both formats are
provided.

This package is parsing infrastructure, not an HTTP signature verifier. It does
not provide cryptography, authentication, authorization, or network discovery.
It has not undergone an independent security review. “Pre-release” describes
maturity, not a SemVer prerelease suffix.

## Install

```sh
npm install @agentsig/structured-fields
```

Use a supported Node release that still receives security updates.

## Quick start

This ten-line ESM example parses a Dictionary, serializes its semantic model,
and obtains the raw syntax tree separately. No keys or network access are needed.

```js
import assert from "node:assert/strict";
import { parse, parseRaw, serialize } from "@agentsig/structured-fields";
const wire = 'agent="https://agent.example";type=directory';
const field = parse(wire, "dictionary");
const canonical = serialize(field);
assert.equal(canonical, wire);
const raw = parseRaw(wire, "dictionary");
assert.equal(raw.root.kind, "dictionary");
console.log(canonical);
console.log(raw.root.kind);
```

Expected output:

```text
agent="https://agent.example";type=directory
dictionary
```

CommonJS consumers can load the same package through its require export.

## API

| Operation | Contract |
| --- | --- |
| parse | Converts a combined ASCII field value into the RFC semantic model |
| parseRaw | Preserves original text, positions, and duplicate occurrences |
| serialize | Produces canonical ASCII from a semantic model |
| serializeMember | Serializes an item or inner list with parameters |
| decimalFromString | Rounds decimal text to three places using exact arithmetic and ties-to-even |
| getParameter | Looks up a parameter in the ordered model |
| getMember | Looks up a Dictionary member |

Supply the field type explicitly. Input is one combined field value, not a full
HTTP header line. The HTTP adapter must combine occurrences of the same field in
received order using comma and space, where appropriate for that field.
Header names are not part of the parser input.

Input can be a string or a byte array. Non-ASCII wire input is rejected.
An empty List or Dictionary serializes to an empty string. An HTTP adapter
should omit an empty structured field rather than assume that an empty header
and an absent header have identical semantics.

## Raw syntax and semantic model

The model distinguishes integers, decimals, tokens, strings, byte sequences,
booleans, dates, and Display Strings.

The raw AST preserves the original combined input, half-open source spans,
whitespace, numeric spelling, and repeated members/parameters. For ASCII input,
character offsets and byte offsets coincide. Spans refer to the combined value,
not to separate HTTP header lines.

The semantic model follows RFC 9651 duplicate handling: the last value wins,
while the key's first position is retained. The serializer accepts a semantic
model and rejects duplicate semantic keys supplied directly by callers.
Inspecting raw duplicates is separate from canonicalizing their semantic value.

Byte values are returned as independent standard byte arrays. Readonly types do
not provide deep runtime immutability. If callers mutate a result, they must not
reuse it across a trust boundary without validation.

Expected decimal/integer distinctions are preserved without relying on binary
floating-point serialization. General RFC 9651 support does not imply that
every type is valid in every protocol: RFC 9421 signature fields impose their
own RFC 8941-based type restrictions.

## Resource budgets

Named defaults are frozen. Each operation accepts partial limit overrides
without mutating the defaults.

| Resource | Default |
| --- | ---: |
| ASCII input | 1 MiB |
| Canonical output | 1 MiB |
| List/Dictionary member occurrences | 1,024 |
| Items per inner list | 256 |
| Parameters per item/inner list | 256 |
| Key length | 1,024 characters |
| Token length | 8,192 characters |
| One decoded string/byte value | 64 KiB |
| Total occurrences per operation | 65,536 |

Every item, inner list, and parameter contributes to the total occurrence
budget. A Dictionary key is not counted separately from its member. Duplicates
are counted before semantic resolution, so repeating a key cannot evade limits.
The total budget can reject a value that satisfies every individual limit.

Checks precede growing allocations. These limits are not exact JavaScript heap
measurements: raw trees, semantic models, and temporary encodings also consume
memory. Zero can intentionally disable a resource; negative, fractional, or
unbounded limits are rejected.

Budgets are local application policy, not RFC maxima. Lower configured limits
can fall below the standard's minimum parser capabilities; acceptance of every
otherwise valid field is not promised.

## Errors and security boundaries

| Error | Meaning |
| --- | --- |
| SfSyntaxError | Invalid wire syntax; the field is rejected |
| SfSerializationError | Invalid semantic serialization input |
| SfLimitError | Resource limit, maximum, and observed size |
| SfConfigurationError | Invalid budget configuration |

Errors do not include incoming field contents. Malformed UTF-8 in Display
Strings is rejected, not repaired with replacement characters. Display String
contents are neither Unicode-normalized nor made safe for display or logging;
applications must escape them for their destination.

Parsing a field proves neither its authenticity nor its suitability for a
specific HTTP protocol. Consumers must enforce their own field types, duplicate
policy, signature coverage, identity, and authorization requirements.

## Tests and provenance

From a repository checkout:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
pnpm --filter @agentsig/structured-fields test
```

The package-local command runs the Structured Fields tests. The repository's
full check also validates types and ESM/CommonJS consumers.

The official HTTP WG Structured Fields test suite is pinned to a specific commit.
Upstream fixtures and licenses remain unchanged. Tests do not derive expected
canonical output from the production parser. Seeded property tests, negative
cases, budget boundaries, and fresh-process consumers supplement the upstream
suite. Passing tests is not a security review.

See [fixture provenance](https://github.com/agentsig-dev/agentsig/blob/main/docs/fixture-provenance.md)
for source hashes, licenses, and byte-preservation checks.

## License

Project code is MIT licensed. Third-party fixtures retain their own source
licenses and are not included in the npm package.