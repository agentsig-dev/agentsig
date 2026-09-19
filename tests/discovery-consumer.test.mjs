import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cwd = resolve(root, "packages/core");
const harnessUrl = new URL("./helpers/public-discovery-harness.mjs", import.meta.url).href;

const assertions = `
(async () => {
  const { startPublicDiscoveryHarness } = await import(${JSON.stringify(harnessUrl)});
  const h = await startPublicDiscoveryHarness();
  try {
    assert.deepEqual(Object.keys(discovery).sort(),
      ['createDirectoryAddressPolicy', 'createNetworkVerifier']);
    assert.deepEqual(Object.keys(redis).sort(),
      ['createRedisReplayStore', 'recoveryHorizonSeconds']);
    assert.equal(redis.recoveryHorizonSeconds(), 360);
    const privateKey = createPrivateKey(readFileSync('../../tests/fixtures/m2/generated/public-test-private.pem'));
    const context = profiles.createSecurityContext();
    const options = { scope: 'public-consumer', context, allowTestKeys: true,
      discovery: { network: h.network } };
    const verifier = discovery.createNetworkVerifier(options);
    assert.equal(verifier.context, context);
    // Reassociation must use the same context registry across package subpaths.
    assert.equal(discovery.createNetworkVerifier(options).context, context);
    const source = { method: 'GET', targetUri: 'https://merchant.example/items', headers: [] };
    for (const profile of profiles.WEB_BOT_AUTH_PROFILES) {
      const signer = profiles.createWebBotAuthSigner({
        privateKey, profile, agentOrigin: h.origin, allowTestKeys: true,
        nonceGenerator: () => 'public-consumer-' + profile,
      });
      const request = { ...source, headers: await signer.sign(source) };
      const result = await verifier.verify(request);
      assert.equal(result.status, 'verified');
      assert.equal(result.verifiedCandidates[0].identity.trustSource, 'directory-https');
      assert.equal(result.verifiedCandidates[0].identity.canonicalOrigin, h.origin);
      assert.equal((await verifier.verify(request)).reason, 'replay-detected');
    }
    assert.equal(h.requests, 1);
    assert.deepEqual(h.connectTargets, ['1.1.1.1:443']);
    assert.equal(context.memoryRecords, 2);
    h.setPrivateAnswer(true);
    const isolated = discovery.createNetworkVerifier({
      scope: 'private-destination', allowTestKeys: true, discovery: { network: h.network },
    });
    const signer = profiles.createWebBotAuthSigner({
      privateKey, agentOrigin: h.origin, allowTestKeys: true,
    });
    const denied = await isolated.verify({ ...source, headers: await signer.sign(source) });
    assert.equal(denied.status, 'unverified');
    assert.equal(denied.reason, 'unknown-key');
    assert.equal(h.requests, 1);
    assert.deepEqual(h.connectTargets, ['1.1.1.1:443']);
    assert.equal(isolated.context.memoryRecords, 0);

    assert.throws(() => discovery.createNetworkVerifier(options, {
      transport() { throw new Error('Must not execute'); },
    }), profiles.ProfileConfigurationError);
    assert.throws(() => discovery.createNetworkVerifier({
      ...options, transport() {},
    }), profiles.ProfileConfigurationError);
    let commands = 0;
    await assert.rejects(redis.createRedisReplayStore({
      namespace: 'consumer', client: {
        automaticRetries: false, offlineQueue: false, isReady: true,
        async sendCommand() { commands++; return null; },
      },
    }), profiles.ProfileConfigurationError);
    assert.equal(commands, 0);
    for (const path of [
      '@agentsig/core/discovery/network-verifier',
      '@agentsig/core/dist/discovery/network-verifier.js',
      '@agentsig/core/redis/replay-script',
    ]) {
      await assert.rejects(import(path), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
    }
    assert.equal(profiles.RESULT_CATALOG_VERSION, 1);
    process.stdout.write('discovery-consumer-ok');
  } finally {
    await h.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
`;

for (const format of ["module", "commonjs"]) {
    test(`discovery and Redis public exports work in a fresh ${format} process`, () => {
        const imports = format === "module"
            ? `import assert from 'node:assert/strict';
               import { readFileSync } from 'node:fs';
               import { createPrivateKey } from 'node:crypto';
               import * as profiles from '@agentsig/core/profiles';
               import * as discovery from '@agentsig/core/discovery';
               import * as redis from '@agentsig/core/redis';`
            : `const assert = require('node:assert/strict');
               const { readFileSync } = require('node:fs');
               const { createPrivateKey } = require('node:crypto');
               const profiles = require('@agentsig/core/profiles');
               const discovery = require('@agentsig/core/discovery');
               const redis = require('@agentsig/core/redis');`;
        const output = execFileSync(process.execPath, [
            `--input-type=${format}`, "--eval", imports + assertions,
        ], { cwd, encoding: "utf8", timeout: 20000 });
        assert.equal(output, "discovery-consumer-ok");
    });

    test(`discovery and Redis declarations resolve for ${format}`, () => {
        const directory = mkdtempSync(join(cwd, ".discovery-consumer-"));
        try {
            const filename = join(directory, format === "module" ? "consumer.mts" : "consumer.cts");
            writeFileSync(filename, `
import { createSecurityContext, type ReplayStore } from "@agentsig/core/profiles";
import {
  createNetworkVerifier, createDirectoryAddressPolicy,
  type NetworkVerificationResult, type DirectoryRefreshEvent,
} from "@agentsig/core/discovery";
import { createRedisReplayStore, recoveryHorizonSeconds, type RedisCommandClient } from "@agentsig/core/redis";
import type { RequestParts } from "@agentsig/core";
// @ts-expect-error Internal transport dependencies are not exported.
import { NetworkVerifierDependencies } from "@agentsig/core/discovery";
// @ts-expect-error Internal command/script access is not exported.
import { REDIS_REPLAY_SCRIPT } from "@agentsig/core/redis";
const context = createSecurityContext();
const verifier = createNetworkVerifier({
  scope: "consumer", context,
  discovery: {
    network: { allowedOrigins: ["https://agent.example"], policy: createDirectoryAddressPolicy([]) },
    onRefresh(event: Readonly<DirectoryRefreshEvent>) {
      if (event.outcome === "failed") {
        const rule: string | undefined = event.diagnostic?.rule;
        void rule;
      }
    },
  },
});
// @ts-expect-error No public transport injection argument.
createNetworkVerifier({ scope: "consumer" }, { transport() {} });
// @ts-expect-error No local key fallback in a network verifier.
createNetworkVerifier({ scope: "consumer", jwks: { keys: [] } });
async function use(request: RequestParts, client: RedisCommandClient): Promise<void> {
  const result: NetworkVerificationResult = await verifier.verify(request);
  if (result.status === "verified") {
    const trust: "directory-https" = result.verifiedCandidates[0].identity.trustSource;
    void trust;
  } else {
    // @ts-expect-error Failed results expose no successful identity collection.
    result.verifiedCandidates;
  }
  const store: ReplayStore = await createRedisReplayStore({
    client, namespace: "consumer", recoveryHorizonSeconds: recoveryHorizonSeconds(),
  });
  createSecurityContext({ store });
  // @ts-expect-error A recovery horizon is mandatory.
  await createRedisReplayStore({ client, namespace: "consumer" });
}
void use;
`, "utf8");
            execFileSync(process.execPath, [
                resolve(root, "node_modules/typescript/bin/tsc"),
                "--noEmit", "--strict", "--exactOptionalPropertyTypes",
                "--module", "NodeNext", "--moduleResolution", "NodeNext",
                "--target", "ES2022", "--types", "node", filename,
            ], { cwd, encoding: "utf8", timeout: 30000 });
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });
}