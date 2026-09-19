import assert from "node:assert/strict";
import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { createWebBotAuthSigner, createOfflineVerifier, createSecurityContext, WEB_BOT_AUTH_PROFILES } from "../packages/core/dist/profiles.js";
// Ön koşul: pnpm run build. Sabit saat, nonce ve yayımlanmış anahtar yalnızca test içindir.
const fixture = (name) => readFileSync(new URL(`../tests/fixtures/m2/generated/${name}`, import.meta.url));
const privateKey = createPrivateKey(fixture("public-test-private.pem"));
const jwks = JSON.parse(fixture("jwks.json").toString("utf8"));
const now = 1800000000000;
const request = { method: "GET", targetUri: "https://merchant.example/items?sku=42", headers: [] };
for (const profile of WEB_BOT_AUTH_PROFILES) {
    const context = createSecurityContext({ wallClock: () => now, monotonicClock: () => 0 }); // Profil başına ayrı bellek deposu.
    const verifier = createOfflineVerifier({ jwks, scope: "smoke", context, allowTestKeys: true });
    const signedRequest = async (ageSeconds) => {
        const signer = createWebBotAuthSigner({
            privateKey, profile, agentOrigin: "https://agent.example", allowTestKeys: true,
            clock: () => now - ageSeconds * 1000, nonceGenerator: () => `smoke-${ageSeconds}`,
        });
        const headers = await signer.sign(request); // Varsayılan ömür: 60 saniye.
        assert.deepEqual(headers.map(([name]) => name), ["Signature-Input", "Signature", "Signature-Agent"]);
        return { ...request, headers: [...request.headers, ...headers] };
    };
    const signed = await signedRequest(0);
    const first = await verifier.verify(signed);
    assert.equal(first.status, "verified");
    assert.equal(first.verifiedCandidates[0].replayProtected, true);
    console.log(`${profile}: ilk çağrı ${first.status} / ${first.reason}; replayProtected: ${first.verifiedCandidates[0].replayProtected}`);
    const replay = await verifier.verify(signed);
    assert.deepEqual([replay.status, replay.reason], ["invalid", "replay-detected"]);
    console.log(`${profile}: ikinci çağrı ${replay.status} / ${replay.reason}`);
    // expires geçmişte olduğundan expiry kontrolü yaş kontrolünden önce reddeder; yaş kontrolü birim testlerinde kapsanır.
    const expired = await verifier.verify(await signedRequest(600));
    assert.deepEqual([expired.status, expired.reason], ["invalid", "signature-expired"]);
    console.log(`${profile}: üçüncü çağrı ${expired.status} / ${expired.reason}`);
    assert.equal(context.memoryRecords, 1); // Retler yeni nonce tüketmemeli.
    assert.equal(context.inFlight, 0);
}