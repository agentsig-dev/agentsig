import assert from "node:assert/strict";
import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import {
    createSecurityContext, createWebBotAuthSigner,
} from "../packages/core/dist/profiles.js";
import { createNetworkVerifier } from "../packages/core/dist/discovery.js";
import { startPublicDiscoveryHarness } from "../tests/helpers/public-discovery-harness.mjs";

// Maintainer-run only. Prerequisite: pnpm run build. No Redis or external DNS.
// Run as a standalone process: the repository harness temporarily controls this
// process's Resolver prototype and restores it in close(). It never changes OS
// DNS, the system trust store, or production private-address/TLS policy.
// The explicitly trusted test proxy routes CONNECT 1.1.1.1:443 to loopback.
// This exercises real nested TLS and full authentication, NOT public routing
// or direct observation of the directory's remote peer.
const privateKey = createPrivateKey(readFileSync(new URL(
    "../tests/fixtures/m2/generated/public-test-private.pem", import.meta.url,
)));
const profile = "ietf-wg-protocol-00";
const source = {
    method: "GET", targetUri: "https://merchant.example/items?sku=42", headers: [],
};
const h = await startPublicDiscoveryHarness();
try {
    console.log("TEST ONLY: controlled DNS; explicit local HTTPS CONNECT proxy; real directory TLS.");
    console.log("Numeric target 1.1.1.1:443 is test-routed to loopback, not the public Internet.");
    const context = createSecurityContext();
    const verifier = createNetworkVerifier({
        scope: "smoke-fetch", context, allowTestKeys: true,
        discovery: { network: h.network },
    });
    const sign = async (nonce) => {
        const signer = createWebBotAuthSigner({
            privateKey, profile, agentOrigin: h.origin, allowTestKeys: true,
            nonceGenerator: () => nonce,
        });
        return { ...source, headers: await signer.sign(source) };
    };

    const first = await verifier.verify(await sign("smoke-fetch-initial"));
    assert.equal(first.status, "verified");
    assert.equal(first.verifiedCandidates[0].identity.trustSource, "directory-https");
    assert.equal(first.verifiedCandidates[0].identity.canonicalOrigin, h.origin);
    assert.equal(first.verifiedCandidates[0].replayProtected, true);
    assert.equal(context.memoryRecords, 1);
    assert.equal(h.requests, 1);
    assert.deepEqual(h.connectTargets, ["1.1.1.1:443"]);
    console.log("1: verified / nonce-consumed; one directory GET; CONNECT pin 1.1.1.1:443.");

    // A separate cold context cannot satisfy this scenario from the first cache.
    h.setPrivateAnswer(true);
    const events = [];
    const deniedVerifier = createNetworkVerifier({
        scope: "smoke-private-destination", allowTestKeys: true,
        discovery: { network: h.network, onRefresh: event => events.push(event) },
    });
    const denied = await deniedVerifier.verify(await sign("smoke-fetch-private"));
    assert.equal(denied.status, "unverified");
    assert.equal(denied.reason, "unknown-key");
    assert.equal(events.length, 1);
    assert.equal(events[0].outcome, "failed");
    assert.equal(events[0].reason, "address-denied");
    assert.equal(deniedVerifier.context.memoryRecords, 0);
    assert.equal(h.requests, 1);
    assert.deepEqual(h.connectTargets, ["1.1.1.1:443"]);
    console.log("2: private DNS answer 10.0.0.1 rejected before CONNECT/GET; unverified / unknown-key.");
    h.setPrivateAnswer(false);

    h.removeKeys();
    // Preserve the real production 30-second origin-start cooldown. No clock
    // injection, reset, verifier recreation, or rate-policy bypass for rotation.
    console.log("Waiting 30.1 seconds for the production origin cooldown before the second GET...");
    await delay(30100);
    const refresh = await verifier.refresh(h.origin, profile);
    assert.equal(refresh.outcome, "completed");
    assert.equal(refresh.persisted, true);
    assert.equal(h.requests, 2);
    assert.deepEqual(h.connectTargets, ["1.1.1.1:443", "1.1.1.1:443"]);
    // Sign after waiting, with a new nonce: neither expiry nor replay masks removal.
    const removed = await verifier.verify(await sign("smoke-fetch-removed"));
    assert.equal(removed.status, "unverified");
    assert.equal(removed.reason, "unknown-key");
    assert.equal(h.requests, 2);
    assert.equal(context.memoryRecords, 1);
    assert.equal(context.inFlight, 0);
    assert.equal(deniedVerifier.context.inFlight, 0);
    console.log("3: second GET replaced the directory with an empty set; unverified / unknown-key.");
    console.log("PASS: all three scenarios; memory replay only; no Redis, public routing, or Cloudflare claim.");
} finally {
    await h.close();
}