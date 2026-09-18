import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cwd = resolve(root, "packages/core");

const assertions = `
(async () => {
  const fixture = name => readFileSync('test/fixtures/rfc9421/' + name);
  const headers = text => text.split('\\n').map(line => {
    const index = line.indexOf(': ');
    assert.ok(index > 0);
    return [line.slice(0, index), line.slice(index + 2)];
  });
  const [, ...requestLines] = fixture('request-head.txt').toString('ascii').split('\\n');
  const message = {
    kind: 'request',
    request: {
      method: 'POST',
      targetUri: 'https://example.com/foo?param=Value&Pet=dog',
      rawRequestTarget: '/foo?param=Value&Pet=dog',
      httpVersion: '1.1',
      headers: headers(requestLines.join('\\n')),
    },
  };
  const parsed = core.parseSignatureHeaders(
    headers(fixture('signature-headers.txt').toString('ascii')),
  );
  assert.equal(parsed.length, 1);
  assert.deepEqual(
    Buffer.from(core.createSignatureBase(message, parsed[0].input).bytes),
    fixture('signature-base.txt'),
  );
  const signed = await core.signHttpMessage(
    message, parsed[0].input, createPrivateKey(fixture('ed25519-private.pem')),
  );
  assert.deepEqual(
    Buffer.from('Signature-Input: ' + signed.signatureInput + '\\nSignature: ' + signed.signature),
    fixture('signature-headers.txt'),
  );
  const publicKey = createPublicKey(fixture('ed25519-public.pem'));
  const verified = await core.verifyHttpSignatureCryptography(message, parsed[0], publicKey);
  assert.equal(verified.status, 'signature-valid');
  parsed[0].signature[0] ^= 1;
  const rejected = await core.verifyHttpSignatureCryptography(message, parsed[0], publicKey);
  assert.deepEqual(rejected, { status: 'rejected', reason: 'signature-mismatch' });
  assert.equal(core.CORE_SF_LIMITS.maxInputBytes, 16384);
  assert.equal(Object.isFrozen(core.DEFAULT_CORE_LIMITS), true);
  assert.throws(
    () => core.createSignatureBase(message, parsed[0].input, {
      limits: { maxSignatureBaseBytes: 1 },
    }),
    core.SignatureLimitError,
  );
  process.stdout.write('core-consumer-ok');
})().catch(error => { console.error(error); process.exitCode = 1; });
`;

for (const format of ["module", "commonjs"]) {
    test(`built core package loads through ${format} exports`, () => {
        const imports = format === "module"
            ? `import assert from 'node:assert/strict';
         import { readFileSync } from 'node:fs';
         import { createPrivateKey, createPublicKey } from 'node:crypto';
         import * as core from '@agentsig/core';`
            : `const assert = require('node:assert/strict');
         const { readFileSync } = require('node:fs');
         const { createPrivateKey, createPublicKey } = require('node:crypto');
         const core = require('@agentsig/core');`;
        const output = execFileSync(
            process.execPath,
            [`--input-type=${format}`, "--eval", imports + assertions],
            { cwd, encoding: "utf8", timeout: 15_000 },
        );
        assert.equal(output, "core-consumer-ok");
    });
}