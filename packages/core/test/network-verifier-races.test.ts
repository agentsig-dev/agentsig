import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { createNetworkVerifier } from "../src/discovery/network-verifier.js";
import type { DirectoryRefreshEvent } from "../src/discovery/directory-service.js";
import type { WebBotAuthProfile } from "../src/profiles/agent-header.js";
import { createOwnedMemoryReplayStore } from "../src/profiles/memory-replay-store.js";
import { createSecurityContext } from "../src/profiles/security-context.js";
import { createWebBotAuthSigner } from "../src/profiles/signer.js";
import type { RequestParts } from "../src/types.js";
import { directoryOrigin, startNetworkDirectory } from "./network-directory-harness.js";

const fixture = JSON.parse(readFileSync(new URL(
    "../../../tests/fixtures/m3-rotation/cases.json", import.meta.url,
), "utf8")) as {
    keys: Record<string, { jwk: Record<string, string>; thumbprint: string }>;
    policy: { profiles: WebBotAuthProfile[] };
    cases: {
        id: string; replacementKeys?: string[];
        refreshKeys?: { materialFrom: string; kidFrom: string }[];
        refreshAtElapsedSeconds?: number; finalAtElapsedSeconds?: number;
        expected: { status: string; reason: string };
        refreshExpected?: { reason: string; diagnostic: { keyIndex: number; rule: string } };
    }[];
};
const privateKey = createPrivateKey(readFileSync(new URL(
    "../../../tests/fixtures/m2/generated/public-test-private.pem", import.meta.url,
)));
const start = 1800000000;
function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((yes) => { resolve = yes; });
    return { promise, resolve };
}

async function harness(profile: WebBotAuthProfile) {
    const network = await startNetworkDirectory([fixture.keys.original!.jwk]);
    let elapsed = 0;
    let held = false;
    let consumes = 0;
    const entered = deferred();
    const release = deferred();
    const memory = createOwnedMemoryReplayStore();
    const context = createSecurityContext({
        wallClock: () => (start + elapsed) * 1000,
        monotonicClock: () => elapsed * 1000,
        store: {
            retentionClock: "process-clock",
            async consume(input) {
                consumes++;
                const outcome = await memory.store.consume(input);
                if (held) {
                    entered.resolve();
                    await release.promise;
                }
                return outcome;
            },
        },
    });
    const events: Readonly<DirectoryRefreshEvent>[] = [];
    const verifier = createNetworkVerifier({
        scope: "network-races", context, allowTestKeys: true,
        allowedProfiles: [profile],
        discovery: { network: network.network, onRefresh: (event) => { events.push(event); } },
    }, {
        discoveryClock: () => performance.now() + elapsed * 1000,
        async transport(origin, options) {
            const response = await network.transport(origin, options);
            // Translate actual transport samples into this test's accelerated
            // monotonic domain. TLS and response parsing are real; elapsed
            // policy time is controlled, not a 30/60-second wall-clock sleep.
            const offset = elapsed * 1000;
            return {
                ...response,
                requestStartedMonotonicMs: response.requestStartedMonotonicMs + offset,
                responseReceivedMonotonicMs: response.responseReceivedMonotonicMs + offset,
            };
        },
    });
    async function signed(nonce: string): Promise<RequestParts> {
        const request: RequestParts = {
            method: "GET", targetUri: "https://merchant.example/items?sku=42", headers: [],
        };
        const signer = createWebBotAuthSigner({
            privateKey, agentOrigin: directoryOrigin, profile, allowTestKeys: true,
            clock: () => (start + elapsed) * 1000, nonceGenerator: () => nonce,
        });
        return { ...request, headers: await signer.sign(request) };
    }
    return {
        network, verifier, context, events, memory, signed, entered,
        get consumes() { return consumes; },
        at(seconds: number) { elapsed = seconds; },
        hold() { held = true; },
        release() { held = false; release.resolve(); },
    };
}

describe("full network authentication races over real local HTTPS and test-routed CONNECT", () => {
    for (const profile of fixture.policy.profiles) {
        for (const id of ["a-key-remains-during-replay-await", "b-key-removed-during-replay-await"]) {
            const row = fixture.cases.find((entry) => entry.id === id)!;
            it(`${profile}: ${id}`, async () => {
                const h = await harness(profile);
                try {
                    expect(await h.verifier.refresh(directoryOrigin, profile))
                        .toMatchObject({ outcome: "completed", persisted: true });
                    h.at(30);
                    const request = await h.signed(id);
                    h.hold();
                    const pending = h.verifier.verify(request);
                    await h.entered.promise;
                    expect(h.memory.records).toBe(1); // Real insertion already happened.
                    h.network.setKeys(row.replacementKeys!.map((name) => fixture.keys[name]!.jwk));
                    expect(await h.verifier.refresh(directoryOrigin, profile))
                        .toMatchObject({ outcome: "completed", persisted: true });
                    h.release();
                    const result = await pending;
                    expect(result).toMatchObject(row.expected);
                    expect(h.consumes).toBe(1);
                    expect(h.memory.records).toBe(1); // No rollback on removal.
                    if (result.status === "verified") {
                        expect(result.verifiedCandidates[0].identity).toEqual({
                            identityKind: "directory-url",
                            thumbprint: fixture.keys.original!.thumbprint,
                            canonicalOrigin: directoryOrigin,
                            directoryUrl: `${directoryOrigin}/.well-known/http-message-signatures-directory`,
                            trustSource: "directory-https",
                        });
                    } else {
                        expect(result).not.toHaveProperty("verifiedCandidates");
                        // Reintroducing the key does not erase the consumed nonce.
                        h.at(60);
                        h.network.setKeys([fixture.keys.original!.jwk]);
                        await h.verifier.refresh(directoryOrigin, profile);
                    }
                    expect(await h.verifier.verify(request)).toMatchObject({
                        status: "invalid", reason: "replay-detected",
                    });
                    expect(h.context.inFlight).toBe(0);
                    expect(h.network.connectTargets.every((target) => target === "1.1.1.1:443")).toBe(true);
                    expect(h.network.requests.length).toBe(id.startsWith("a-") ? 2 : 3);
                } finally { h.release(); await h.network.close(); }
            });
        }
    }

    for (const row of fixture.cases.filter((entry) => entry.refreshExpected)) {
        it(row.id, async () => {
            const profile = "ietf-wg-protocol-00";
            const h = await harness(profile);
            try {
                await h.verifier.refresh(directoryOrigin, profile);
                h.events.length = 0;
                h.at(row.refreshAtElapsedSeconds!);
                const request = await h.signed(row.id);
                const oldFresh = row.finalAtElapsedSeconds! < 60;
                let pending: ReturnType<typeof h.verifier.verify> | undefined;
                if (oldFresh) {
                    h.hold();
                    pending = h.verifier.verify(request);
                    await h.entered.promise;
                }
                h.network.setKeys(row.refreshKeys!.map((entry) => ({
                    ...fixture.keys[entry.materialFrom]!.jwk,
                    kid: fixture.keys[entry.kidFrom]!.thumbprint,
                })));
                expect(await h.verifier.refresh(directoryOrigin, profile)).toEqual({
                    outcome: "failed", reason: row.refreshExpected!.reason,
                    diagnostic: row.refreshExpected!.diagnostic,
                });
                h.at(row.finalAtElapsedSeconds!);
                h.release();
                const result = await (pending ?? h.verifier.verify(request));
                expect(result).toMatchObject(row.expected);
                expect(h.events).toEqual([{
                    origin: directoryOrigin, outcome: "failed",
                    reason: row.refreshExpected!.reason,
                    diagnostic: row.refreshExpected!.diagnostic,
                }]);
                expect(h.network.requests).toHaveLength(2);
                expect(h.consumes).toBe(oldFresh ? 1 : 0);
                expect(h.context.inFlight).toBe(0);
                if (oldFresh) {
                    h.at(61);
                    expect(await h.verifier.verify(await h.signed("fresh-signature-expired-directory")))
                        .toMatchObject({ status: "unverified", reason: "unknown-key" });
                    expect(h.consumes).toBe(1);
                    expect(h.network.requests).toHaveLength(2);
                }
            } finally { h.release(); await h.network.close(); }
        });
    }

    it("rejects a controlled private DNS answer before CONNECT and returns unverified", async () => {
        const h = await harness("ietf-wg-protocol-00");
        try {
            h.network.setAddresses(["10.0.0.1"]);
            expect(await h.verifier.verify(await h.signed("private-destination")))
                .toMatchObject({ status: "unverified", reason: "unknown-key" });
            expect(h.network.dnsCalls).toBe(1);
            expect(h.network.connectTargets).toHaveLength(0);
            expect(h.network.requests).toHaveLength(0);
            expect(h.consumes).toBe(0);
            expect(h.events).toEqual([{
                origin: directoryOrigin, outcome: "failed", reason: "address-denied",
            }]);
        } finally { await h.network.close(); }
    });
});