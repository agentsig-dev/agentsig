import assert from "node:assert/strict";
import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { createWebBotAuthSigner, createOfflineVerifier, createSecurityContext, WEB_BOT_AUTH_PROFILES } from "../packages/core/dist/profiles.js";
// Prerequisite: pnpm run build. Fixed clocks, nonces, and the published key are for tests only.
const fixture = (name) => readFileSync(new URL(`../tests/fixtures/m2/generated/${name}`, import.meta.url));
const privateKey = createPrivateKey(fixture("public-test-private.pem"));
const jwks = JSON.parse(fixture("jwks.json").toString("utf8"));
const now = 1800000000000;
const request = { method: "GET", targetUri: "https://merchant.example/items?sku=42", headers: [] };
for (const profile of WEB_BOT_AUTH_PROFILES) {
    const context = createSecurityContext({ wallClock: () => now, monotonicClock: () => 0 }); // Separate memory store per profile.
    const verifier = createOfflineVerifier({ jwks, scope: "smoke", context, allowTestKeys: true });
    const signedRequest = async (ageSeconds) => {
        const signer = createWebBotAuthSigner({
            privateKey, profile, agentOrigin: "https://agent.example", allowTestKeys: true,
            clock: () => now - ageSeconds * 1000, nonceGenerator: () => `smoke-${ageSeconds}`,
        });
        const headers = await signer.sign(request); // Default lifetime: 60 seconds.
        assert.deepEqual(headers.map(([name]) => name), ["Signature-Input", "Signature", "Signature-Agent"]);
        return { ...request, headers: [...request.headers, ...headers] };
    };
    const signed = await signedRequest(0);
    const first = await verifier.verify(signed);
    assert.equal(first.status, "verified");
    assert.equal(first.verifiedCandidates[0].replayProtected, true);
    console.log(`${profile}: first call ${first.status} / ${first.reason}; replayProtected: ${first.verifiedCandidates[0].replayProtected}`);
    const replay = await verifier.verify(signed);
    assert.deepEqual([replay.status, replay.reason], ["invalid", "replay-detected"]);
    console.log(`${profile}: second call ${replay.status} / ${replay.reason}`);
    // Expiration is in the past, so expiry rejects before the age check; age checks are covered by unit tests.
    const expired = await verifier.verify(await signedRequest(600));
    assert.deepEqual([expired.status, expired.reason], ["invalid", "signature-expired"]);
    console.log(`${profile}: third call ${expired.status} / ${expired.reason}`);
    assert.equal(context.memoryRecords, 1); // Rejections must not consume a new nonce.
    assert.equal(context.inFlight, 0);
}