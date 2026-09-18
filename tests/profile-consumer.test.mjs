import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cwd = resolve(root, "packages/core");

const assertions = `
(async () => {
  const fixture = name => readFileSync('../../tests/fixtures/m2/generated/' + name);
  const privateKey = createPrivateKey(fixture('public-test-private.pem'));
  const jwks = fixture('jwks.json');
  for (const profile of api.WEB_BOT_AUTH_PROFILES) {
    const context = api.createSecurityContext({
      wallClock: () => 1800000000000,
      monotonicClock: () => 0,
    });
    const signer = api.createWebBotAuthSigner({
      privateKey, profile, agentOrigin: 'https://agent.example',
      allowTestKeys: true,
      clock: () => 1800000000000,
      nonceGenerator: () => 'consumer-test-nonce',
    });
    const verifier = api.createOfflineVerifier({
      jwks, scope: 'consumer', context, allowTestKeys: true,
    });
    const source = {
      method: 'GET', targetUri: 'https://merchant.example/items?sku=42', headers: [],
    };
    const headers = await signer.sign(source);
    const request = { ...source, headers };
    const result = await verifier.verify(request);
    assert.equal(result.status, 'verified');
    assert.equal(result.reason, 'nonce-consumed');
    assert.equal(result.verifiedCandidates.length, 1);
    assert.equal(result.verifiedCandidates[0].profile, profile);
    assert.equal(result.verifiedCandidates[0].replayProtected, true);
    assert.equal(result.verifiedCandidates[0].identity.identityKind, 'key-thumbprint');
    assert.equal(context.memoryRecords, 1);
    assert.equal((await verifier.verify(request)).reason, 'replay-detected');
    assert.equal(context.inFlight, 0);
    const denied = api.createOfflineVerifier({ jwks, scope: 'consumer', context });
    assert.equal((await denied.verify(request)).reason, 'test-key-disallowed');
    const event = await context.resetClockReference();
    assert.equal(event.outcome, 'success');
    assert.equal(event.clearedRecords, 1);
    assert.equal((await verifier.verify(request)).status, 'verified');
  }
  for (const name of [
    'CandidateRejection', 'evaluateCandidate', 'consumeCandidateGroups',
    'securityContextInternals', 'createSecurityContextController',
    'createOperationEpochs', 'createOwnedMemoryReplayStore',
  ]) assert.equal(Object.hasOwn(api, name), false, name);
  await assert.rejects(
    import('@agentsig/core/dist/profiles/security-context-controller.js'),
    { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' },
  );
  assert.equal(api.RESULT_CATALOG_VERSION, 1);
  assert.equal(Object.isFrozen(api.RESULT_CODES), true);
  assert.throws(
    () => api.createOfflineVerifier({ jwks, scope: '' }),
    api.ProfileConfigurationError,
  );
  process.stdout.write('profile-consumer-ok');
})().catch(error => { console.error(error); process.exitCode = 1; });
`;

for (const format of ["module", "commonjs"]) {
    test(`profile subpath authenticates in a fresh ${format} process`, () => {
        const imports = format === "module"
            ? `import assert from 'node:assert/strict';
               import { readFileSync } from 'node:fs';
               import { createPrivateKey } from 'node:crypto';
               import * as api from '@agentsig/core/profiles';`
            : `const assert = require('node:assert/strict');
               const { readFileSync } = require('node:fs');
               const { createPrivateKey } = require('node:crypto');
               const api = require('@agentsig/core/profiles');`;
        const output = execFileSync(process.execPath, [
            `--input-type=${format}`, "--eval", imports + assertions,
        ], { cwd, encoding: "utf8", timeout: 20_000 });
        assert.equal(output, "profile-consumer-ok");
    });

    test(`profile declarations resolve for a ${format} TypeScript consumer`, () => {
        // Place temporary consumers inside the package scope so package
        // self-reference uses real conditional exports, never a TS paths alias.
        const directory = mkdtempSync(join(cwd, ".profile-consumer-"));
        try {
            const filename = join(directory, format === "module" ? "consumer.mts" : "consumer.cts");
            writeFileSync(filename, `
import { createPrivateKey } from "node:crypto";
import {
  createOfflineVerifier, createSecurityContext, createWebBotAuthSigner,
  type VerificationResult, type VerifiedCandidate, type ReplayStore,
} from "@agentsig/core/profiles";
import type { RequestParts } from "@agentsig/core";
// @ts-expect-error Internal capabilities are deliberately not exported.
import { securityContextInternals } from "@agentsig/core/profiles";

const store: ReplayStore = {
  retentionClock: "independent",
  async consume(input) {
    const deadline: number = input.retainUntilEpochSeconds;
    return deadline > input.nowEpochSeconds ? "accepted" : "unavailable";
  },
};
const context = createSecurityContext({ store });
const verifier = createOfflineVerifier({ jwks: { keys: [] }, scope: "consumer", context });
const signer = createWebBotAuthSigner({
  privateKey: createPrivateKey("test-only-not-executed"),
  agentOrigin: "https://agent.example",
});
async function use(request: RequestParts): Promise<void> {
  const headers = await signer.sign(request);
  const result: VerificationResult = await verifier.verify({ ...request, headers });
  if (result.status === "verified") {
    const first: VerifiedCandidate = result.verifiedCandidates[0];
    const identity: string = first.identity.thumbprint;
    if (first.reason === "nonce-consumed") {
      const replay: true = first.replayProtected;
      void replay;
    }
    void identity;
  } else {
    // @ts-expect-error A failed/unsigned aggregate exposes no successful identity.
    result.verifiedCandidates;
  }
}
void use;
`, "utf8");
            execFileSync(process.execPath, [
                resolve(root, "node_modules/typescript/bin/tsc"),
                "--noEmit", "--strict", "--exactOptionalPropertyTypes",
                "--module", "NodeNext", "--moduleResolution", "NodeNext",
                "--target", "ES2022", "--types", "node", filename,
            ], { cwd, encoding: "utf8", timeout: 30_000 });
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });
}