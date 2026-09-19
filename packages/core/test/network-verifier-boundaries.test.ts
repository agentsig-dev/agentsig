import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { RequestParts } from "../src/types.js";
import { createNetworkVerifier } from "../src/discovery/network-verifier.js";
import type { DirectoryResponse } from "../src/discovery/directory-response.js";
import type { fetchDirectoryOnce } from "../src/discovery/fetch-directory.js";
import { createSecurityContext } from "../src/profiles/security-context.js";
import { createWebBotAuthSigner } from "../src/profiles/signer.js";
import { createOwnedMemoryReplayStore } from "../src/profiles/memory-replay-store.js";
import type { WebBotAuthProfile } from "../src/profiles/agent-header.js";

const root = new URL("../../../tests/fixtures/m2/generated/", import.meta.url);
const privateKey = createPrivateKey(readFileSync(new URL("public-test-private.pem", root)));
const publicSet = readFileSync(new URL("jwks.json", root));
const origin = "https://directory.agentsig.test";
const start = 1800000000;

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((yes) => { resolve = yes; });
    return { promise, resolve };
}

function harness() {
    let elapsed = 0;
    const context = createSecurityContext({
        wallClock: () => (start + elapsed) * 1000,
        monotonicClock: () => elapsed * 1000,
    });
    const response = (): DirectoryResponse => ({
        body: Uint8Array.from(publicSet), headers: [],
        requestStartedMonotonicMs: elapsed * 1000,
        responseReceivedMonotonicMs: elapsed * 1000,
        responseReceivedWallMs: (start + elapsed) * 1000,
    });
    const transport = vi.fn<typeof fetchDirectoryOnce>(async () => response());
    const options = {
        context, scope: "network-boundaries", allowTestKeys: true,
        discovery: { network: { allowedOrigins: [origin] } },
    };
    const dependencies = { transport, discoveryClock: () => elapsed * 1000 };
    async function signed(
        nonce: string,
        profile: WebBotAuthProfile = "ietf-wg-protocol-00",
    ): Promise<RequestParts> {
        const request: RequestParts = {
            method: "GET", targetUri: "https://merchant.example/items", headers: [],
        };
        const signer = createWebBotAuthSigner({
            privateKey, agentOrigin: origin, allowTestKeys: true, profile,
            clock: () => (start + elapsed) * 1000, nonceGenerator: () => nonce,
        });
        return { ...request, headers: await signer.sign(request) };
    }
    return {
        context, options, dependencies, transport, response, signed,
        advance(seconds: number) { elapsed += seconds; },
    };
}

// Real signatures and security contexts; controlled transport responses.
// These tests complement, not replace, the real local TLS race tests.
describe("network verification boundary regressions", () => {
    it("does not discover keys for unsigned input", async () => {
        const h = harness();
        const result = await createNetworkVerifier(h.options, h.dependencies).verify({
            method: "GET", targetUri: "https://merchant.example/items", headers: [],
        });
        expect(result).toMatchObject({ status: "unsigned", reason: "no-signature" });
        expect(h.transport).not.toHaveBeenCalled();
        expect(h.context.memoryRecords).toBe(0);
    });

    it("checks signature time before discovery", async () => {
        const h = harness();
        const request = await h.signed("expired");
        h.advance(90);
        expect(await createNetworkVerifier(h.options, h.dependencies).verify(request))
            .toMatchObject({ status: "invalid", reason: "signature-expired" });
        expect(h.transport).not.toHaveBeenCalled();
        expect(h.context.memoryRecords).toBe(0);
    });

    it("does not consume on test-key denial", async () => {
        const h = harness();
        expect(await createNetworkVerifier({
            ...h.options, allowTestKeys: false,
        }, h.dependencies).verify(await h.signed("test-key")))
            .toMatchObject({ status: "unverified", reason: "test-key-disallowed" });
        expect(h.transport).toHaveBeenCalledTimes(1);
        expect(h.context.memoryRecords).toBe(0);
        expect(h.context.inFlight).toBe(0);
    });

    it("rejects corrupted signed request bytes without consuming", async () => {
        const h = harness();
        const request = await h.signed("corrupt");
        expect(await createNetworkVerifier(h.options, h.dependencies).verify({
            ...request, method: "POST",
        })).toMatchObject({ status: "invalid", reason: "signature-mismatch" });
        expect(h.context.memoryRecords).toBe(0);
    });

    it("blocks a disallowed profile before discovery", async () => {
        const h = harness();
        expect(await createNetworkVerifier({
            ...h.options, allowedProfiles: ["ietf-wg-protocol-00"],
        }, h.dependencies).verify(await h.signed("other-profile", "cloudflare-docs-2026-07-01")))
            .toMatchObject({ status: "unverified", reason: "profile-disallowed" });
        expect(h.transport).not.toHaveBeenCalled();
        expect(h.context.memoryRecords).toBe(0);
    });

    it("rejects old-epoch discovery completion after reset without consuming", async () => {
        const h = harness();
        const entered = deferred<void>();
        const pending = deferred<DirectoryResponse>();
        h.transport.mockImplementation(() => { entered.resolve(); return pending.promise; });
        const verifier = createNetworkVerifier(h.options, h.dependencies);
        const verifying = verifier.verify(await h.signed("reset-during-fetch"));
        await entered.promise;
        await h.context.resetClockReference();
        pending.resolve(h.response());
        expect(await verifying).toMatchObject({ status: "unverified", reason: "clock-unavailable" });
        expect(h.context.memoryRecords).toBe(0);
        expect(h.context.inFlight).toBe(0);
    });

    it("allows one of 100 identical requests and rejects 99 replays after one shared fetch", async () => {
        const h = harness();
        const verifier = createNetworkVerifier(h.options, h.dependencies);
        const request = await h.signed("concurrent");
        const results = await Promise.all(Array.from({ length: 100 }, () => verifier.verify(request)));
        expect(results.filter((result) => result.status === "verified")).toHaveLength(1);
        expect(results.filter((result) => result.reason === "replay-detected")).toHaveLength(99);
        expect(h.transport).toHaveBeenCalledTimes(1);
        expect(h.context.memoryRecords).toBe(1);
        expect(h.context.inFlight).toBe(0);
    });

    it("rejects expiry during replay without rolling back the real insertion", async () => {
        const h = harness();
        const memory = createOwnedMemoryReplayStore();
        let elapsed = 0;
        const entered = deferred<void>();
        const release = deferred<void>();
        const context = createSecurityContext({
            wallClock: () => (start + elapsed) * 1000,
            monotonicClock: () => elapsed * 1000,
            store: {
                retentionClock: "process-clock",
                async consume(input) {
                    const outcome = await memory.store.consume(input);
                    entered.resolve();
                    await release.promise;
                    return outcome;
                },
            },
        });
        const verifier = createNetworkVerifier({ ...h.options, context }, h.dependencies);
        const verifying = verifier.verify(await h.signed("expiry-during-replay"));
        await entered.promise;
        elapsed = 90; // Discovery clock stays fresh to isolate signature expiry.
        release.resolve();
        expect(await verifying).toMatchObject({ status: "invalid", reason: "signature-expired" });
        expect(memory.records).toBe(1);
        expect(context.inFlight).toBe(0);
    });

    it.each(["jwks", "bindings", "identityMode", "transport"])(
        "does not accept offline trust or transport injection in public options: %s", (field) => {
            const h = harness();
            expect(() => createNetworkVerifier({
                ...h.options, [field]: {},
            }, h.dependencies)).toThrow(expect.objectContaining({ code: "invalid-candidate-policy" }));
            expect(h.transport).not.toHaveBeenCalled();
        },
    );
});