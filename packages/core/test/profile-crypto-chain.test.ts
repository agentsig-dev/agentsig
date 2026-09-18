import { createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { verifyHttpSignatureCryptography } from "../src/crypto.js";
import { resolveCoreLimits } from "../src/limits.js";
import type { HeaderFields, RequestParts } from "../src/types.js";
import {
    parseAgentHeader, resolveAgentClaim, WEB_BOT_AUTH_PROFILES,
} from "../src/profiles/agent-header.js";
import type { WebBotAuthProfile } from "../src/profiles/agent-header.js";
import { selectWebBotAuthCandidates } from "../src/profiles/candidates.js";
import { assertRequiredCoverage } from "../src/profiles/coverage.js";
import { loadJwks } from "../src/profiles/jwks.js";
import { assertSupportedComponents } from "../src/profiles/component-support.js";

const root = new URL("../../../tests/fixtures/m2/", import.meta.url);
const limits = resolveCoreLimits();

function fixtureRequest(profile: WebBotAuthProfile): RequestParts {
    const text = readFileSync(new URL(`generated/${profile}/headers.txt`, root), "utf8");
    const headers: HeaderFields = text.split("\n").map((line) => {
        const colon = line.indexOf(":");
        return [line.slice(0, colon), line.slice(colon + 2)];
    });
    return { method: "GET", targetUri: "https://merchant.example/items?sku=42", headers };
}

const jwks = loadJwks(readFileSync(new URL("generated/jwks.json", root)));
const referenceKey = createPublicKey(readFileSync(
    new URL("generated/public-test-public.pem", root),
));

async function cryptographicChain(request: RequestParts) {
    const selection = selectWebBotAuthCandidates(request.headers);
    if (selection.kind !== "candidates" || selection.candidates.length !== 1) {
        throw new Error("Expected one fixture candidate");
    }
    const signature = selection.candidates[0]!;
    const header = parseAgentHeader(request, limits);
    const claim = resolveAgentClaim(header, signature.input.label);
    assertSupportedComponents(signature.input, header.profile);
    assertRequiredCoverage(signature.input, header.profile);
    const keyid = signature.input.parameters.find(([name]) => name === "keyid")?.[1];
    if (keyid?.kind !== "string") throw new Error("Missing fixture keyid");
    const selected = jwks.lookup(keyid.value);
    if (selected.status !== "found") throw new Error("Missing fixture public key");
    expect(selected.key.knownTestKey).toBe(true);
    expect(selected.key.publicKey.export({ type: "spki", format: "der" }))
        .toEqual(referenceKey.export({ type: "spki", format: "der" }));
    const crypto = await verifyHttpSignatureCryptography(
        { kind: "request", request }, signature, selected.key.publicKey,
        {
            structuredFieldTypes: {
                "signature-agent": header.profile === "ietf-wg-protocol-00" ? "dictionary" : "item",
            }
        },
    );
    return { claim, crypto };
}

describe("profile helpers → independent Ed25519 fixture, not full authentication", () => {
    for (const profile of WEB_BOT_AUTH_PROFILES) {
        describe(profile, () => {
            it("verifies published fixture bytes without using the agentsig signer", async () => {
                const result = await cryptographicChain(fixtureRequest(profile));
                expect(result.claim.profile).toBe(profile);
                expect(result.crypto.status).toBe("signature-valid");
                expect(result).not.toHaveProperty("replayProtected");
                expect(result).not.toHaveProperty("verified");
            });

            it("rejects a changed method even when required coverage remains present", async () => {
                const result = await cryptographicChain({
                    ...fixtureRequest(profile), method: "POST",
                });
                expect(result.crypto).toEqual({ status: "rejected", reason: "signature-mismatch" });
            });

            it("rejects a changed target query", async () => {
                const result = await cryptographicChain({
                    ...fixtureRequest(profile), targetUri: "https://merchant.example/items?sku=43",
                });
                expect(result.crypto).toEqual({ status: "rejected", reason: "signature-mismatch" });
            });

            it("does not substitute canonical identity into the signed agent value", async () => {
                const original = fixtureRequest(profile);
                const headers: HeaderFields = original.headers.map(([name, value]) => [
                    name,
                    name.toLowerCase() === "signature-agent"
                        ? (value as string).replace("https://agent.example", "HTTPS://AGENT.EXAMPLE:443/")
                        : value,
                ]);
                const result = await cryptographicChain({ ...original, headers });
                expect(result.claim.canonicalOrigin).toBe("https://agent.example");
                expect(result.claim.claimedUrl).toBe("HTTPS://AGENT.EXAMPLE:443/");
                // Same comparison identity, different signed bytes. Rewriting
                // the header to its canonical origin would wrongly accept it.
                expect(result.crypto).toEqual({ status: "rejected", reason: "signature-mismatch" });
            });
        });
    }
});