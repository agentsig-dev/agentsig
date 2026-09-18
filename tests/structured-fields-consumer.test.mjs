import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cwd = resolve(root, "packages/structured-fields");

// Package self-reference resolves the real exports map in a fresh Node process.
// No source aliases or test-runner transforms can conceal a broken entry point.
const assertions = `
  const field = sf.parse('a=1.0;b, c=("%22")', 'dictionary');
  assert.equal(sf.serialize(field), 'a=1.0;b, c=("%22")');
  assert.equal(field.entries[0][1].bare.kind, 'decimal');
  assert.equal(Object.isFrozen(sf.DEFAULT_LIMITS), true);
  assert.equal(sf.Budget, undefined);
  assert.equal(sf.decimalFromString('0.0025').thousandths, 2);
  const raw = sf.parseRaw('a=1,a=2', 'dictionary');
  assert.equal(raw.root.entries.length, 2);
  assert.equal(sf.parse(raw.source, 'dictionary').entries.length, 1);
  const bytes = sf.parse(':YWJj:', 'item').bare.value;
  assert.equal(bytes.constructor, Uint8Array);
  assert.deepEqual(Array.from(bytes), [97, 98, 99]);
  assert.throws(
    () => sf.parse('aa', 'item', { limits: { maxInputBytes: 1 } }),
    error => error instanceof sf.SfLimitError
      && error.limit === 'maxInputBytes'
      && error.maximum === 1
      && error.observed === 2,
  );
  assert.throws(() => sf.parse('?', 'item'), sf.SfSyntaxError);
  process.stdout.write('consumer-ok');
`;

for (const format of ["module", "commonjs"]) {
    test(`built Structured Fields package loads through ${format} exports`, () => {
        const imports = format === "module"
            ? `import assert from 'node:assert/strict';
         import * as sf from '@agentsig/structured-fields';`
            : `const assert = require('node:assert/strict');
         const sf = require('@agentsig/structured-fields');`;
        const output = execFileSync(
            process.execPath,
            [`--input-type=${format}`, "--eval", imports + assertions],
            { cwd, encoding: "utf8", timeout: 15_000 },
        );
        assert.equal(output, "consumer-ok");
    });
}