import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { RequestParts } from "../src/types.js";
import { WEB_BOT_AUTH_PROFILES } from "../src/profiles/agent-header.js";
import type { WebBotAuthProfile } from "../src/profiles/agent-header.js";
import { createSecurityContext } from "../src/profiles/security-context.js";
import { createWebBotAuthSigner } from "../src/profiles/signer.js";
import { createOfflineVerifier } from "../src/profiles/verifier.js";

const root = new URL("../../../tests/fixtures/signing/", import.meta.url);
const m2 = new URL("../../../tests/fixtures/m2/generated/", import.meta.url);
const privateKey = createPrivateKey(readFileSync(new URL("public-test-private.pem", m2)));
const jwks = readFileSync(new URL("jwks.json", m2));
const thumbprint = "DR68nui99ukl-GUgfzQGaU3VwqRtArw-_DCN4LFtY84";
const manifest = JSON.parse(readFileSync(new URL("manifest.json", root), "utf8")) as {
    vectors: string[];
};
interface Golden {
    profile: WebBotAuthProfile;
    label: string;
    agentOrigin: string;
    request: RequestParts;
    clockMilliseconds: number;
    nonce: string;
    lifetimeSeconds: number;
    expectedHeaders: [string, string][];
}
function context() {
    return createSecurityContext({
        wallClock: () => 1800000000000,
        monotonicClock: () => 0,
    });
}
function fixtureRequest(profile: WebBotAuthProfile): RequestParts {
    const text = readFileSync(new URL(`${profile}/headers.txt`, m2), "utf8");
    return {
        method: "GET",
        targetUri: "https://merchant.example/items?sku=42",
        headers: text.split("\n").map((line) => {
            const colon = line.indexOf(":");
            return [line.slice(0, colon), line.slice(colon + 2)] as const;
        }),
    };
}

describe("full offline authentication of independently committed fixtures", () => {
    for (const profile of WEB_BOT_AUTH_PROFILES) {
        it(`${profile}: verifies once, rejects replay, establishes only key identity`, async () => {
            const security = context();
            const verifier = createOfflineVerifier({
                jwks, scope: "merchant", context: security, allowTestKeys: true,
            });
            const request = fixtureRequest(profile);
            const result = await verifier.verify(request);
            expect(result.status).toBe("verified");
            if (result.status !== "verified") throw new Error("Expected full verification");
            expect(result.verifiedCandidates).toHaveLength(1);
            expect(result.verifiedCandidates[0]).toMatchObject({
                status: "verified", profile, reason: "nonce-consumed",
                replayProtected: true, verifiedAt: 1800000000,
                identity: { identityKind: "key-thumbprint", thumbprint },
            });
            expect(result.verifiedCandidates[0].identity).not.toHaveProperty("directoryUrl");
            expect(security.memoryRecords).toBe(1);
            expect(await verifier.verify(request)).toMatchObject({
                status: "invalid", reason: "replay-detected",
            });
            expect(security.inFlight).toBe(0);
        });

        it(`${profile}: denies public test keys by default without consuming`, async () => {
            const security = context();
            const verifier = createOfflineVerifier({ jwks, scope: "merchant", context: security });
            expect(await verifier.verify(fixtureRequest(profile))).toMatchObject({
                status: "unverified", reason: "test-key-disallowed",
            });
            expect(security.memoryRecords).toBe(0);
            expect(security.inFlight).toBe(0);
        });

        it(`${profile}: 100 concurrent identical requests yield one acceptance and 99 replays`, async () => {
            const security = context();
            const verifier = createOfflineVerifier({
                jwks, scope: "merchant", context: security, allowTestKeys: true,
            });
            const request = fixtureRequest(profile);
            const results = await Promise.all(Array.from({ length: 100 }, () => verifier.verify(request)));
            expect(results.filter((result) => result.status === "verified")).toHaveLength(1);
            expect(results.filter((result) =>
                result.status === "invalid" && result.reason === "replay-detected")).toHaveLength(99);
            expect(security.memoryRecords).toBe(1);
            expect(security.inFlight).toBe(0);
        });
    }
});

describe("M2 acceptance gate: signer → offline verifier → verified", () => {
    for (const id of manifest.vectors) {
        it(id, async () => {
            const fixture = JSON.parse(readFileSync(new URL(`${id}/case.json`, root), "utf8")) as Golden;
            const signer = createWebBotAuthSigner({
                privateKey, allowTestKeys: true,
                profile: fixture.profile, label: fixture.label,
                agentOrigin: fixture.agentOrigin,
                clock: () => fixture.clockMilliseconds,
                nonceGenerator: () => fixture.nonce,
                timePolicy: { signingLifetimeSeconds: fixture.lifetimeSeconds },
            });
            const headers = await signer.sign(fixture.request);
            // Independent bytes remain the oracle; round trip is additional.
            expect(headers).toEqual(fixture.expectedHeaders);
            const security = context();
            const verifier = createOfflineVerifier({
                jwks, scope: "roundtrip", context: security, allowTestKeys: true,
                identityMode: "directory-url",
                bindings: [{ thumbprint, origin: fixture.agentOrigin }],
            });
            const request = { ...fixture.request, headers: [...fixture.request.headers, ...headers] };
            const result = await verifier.verify(request);
            expect(result.status).toBe("verified");
            if (result.status !== "verified") throw new Error("Full round trip failed");
            expect(result.verifiedCandidates[0]).toMatchObject({
                status: "verified", label: fixture.label, profile: fixture.profile,
                reason: "nonce-consumed", replayProtected: true,
                identity: {
                    identityKind: "directory-url", thumbprint,
                    trustSource: "local-configuration",
                },
            });
            expect(security.memoryRecords).toBe(1);
            expect(await verifier.verify(request)).toMatchObject({
                status: "invalid", reason: "replay-detected",
            });
            expect(security.inFlight).toBe(0);
        });
    }
});