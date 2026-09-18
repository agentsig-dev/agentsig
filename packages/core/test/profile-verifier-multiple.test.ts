import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { signHttpMessage } from "../src/crypto.js";
import type { Parameters, RequestParts, SignatureInput } from "../src/types.js";
import { createSecurityContext } from "../src/profiles/security-context.js";
import type { ReplayConsumeInput, ReplayStore } from "../src/profiles/replay-store.js";
import type { StoreOutcome } from "../src/profiles/codes.js";
import { createOfflineVerifier } from "../src/profiles/verifier.js";

const root = new URL("../../../tests/fixtures/m2/generated/", import.meta.url);
const privateKey = createPrivateKey(readFileSync(new URL("public-test-private.pem", root)));
const jwks = readFileSync(new URL("jwks.json", root));
const thumbprint = "DR68nui99ukl-GUgfzQGaU3VwqRtArw-_DCN4LFtY84";
const start = 1800000000;

interface Member {
    label: string;
    nonce?: string;
    corrupt?: boolean;
    counter?: boolean;
    created?: number;
    expires?: number;
}
async function signed(members: readonly Member[]): Promise<RequestParts> {
    const request: RequestParts = {
        method: "GET", targetUri: "https://merchant.example/items?sku=42",
        headers: [["Signature-Agent", members.map(({ label }) =>
            `${label}="https://agent.example"`).join(", ")]],
    };
    const patches = [];
    for (const member of members) {
        const parameters: Parameters = [
            ["created", { kind: "integer", value: member.created ?? start }],
            ["expires", { kind: "integer", value: member.expires ?? start + 60 }],
            ["keyid", { kind: "string", value: thumbprint }],
            ...(member.nonce === undefined ? [] : [
                ["nonce", { kind: "string", value: member.nonce }] as const,
            ]),
            ["tag", { kind: "string", value: "web-bot-auth" }],
        ];
        const input: SignatureInput = {
            label: member.label, parameters,
            components: [
                { name: "@method", parameters: [] },
                { name: "@target-uri", parameters: [] },
                {
                    name: "signature-agent", parameters: [
                        ["key", { kind: "string", value: member.label }],
                    ]
                },
            ],
        };
        const patch = await signHttpMessage(
            { kind: "request", request }, input, privateKey,
            { structuredFieldTypes: { "signature-agent": "dictionary" } },
        );
        // These mutations deliberately invalidate a candidate. The support
        // gate must reject countersignature coverage before cryptography.
        patches.push({
            signatureInput: member.counter
                ? patch.signatureInput.replace('("@method"', '("signature" "@method"')
                : patch.signatureInput,
            signature: member.corrupt
                ? `${member.label}=:${Buffer.alloc(64).toString("base64")}:`
                : patch.signature,
        });
    }
    return {
        ...request,
        headers: [
            ...request.headers,
            ["Signature-Input", patches.map((patch) => patch.signatureInput).join(", ")],
            ["Signature", patches.map((patch) => patch.signature).join(", ")],
        ],
    };
}

function harness(consume: ReplayStore["consume"] = async () => "accepted") {
    let elapsed = 0;
    const calls: Readonly<ReplayConsumeInput>[] = [];
    const context = createSecurityContext({
        wallClock: () => (start + elapsed) * 1000,
        monotonicClock: () => elapsed * 1000,
        store: {
            retentionClock: "independent",
            consume(input) { calls.push(input); return consume(input); },
        },
    });
    return {
        context, calls,
        options: { jwks, scope: "merchant", context, allowTestKeys: true },
        advance(seconds: number) { elapsed += seconds; },
    };
}

describe("offline verifier: approved multiple-candidate contracts", () => {
    it.each(["valid", "corrupt", "counter"] as const)(
        "default ambiguity counts every candidate and never consumes: %s", async (second) => {
            const h = harness();
            const request = await signed([
                { label: "a", nonce: "shared" },
                { label: "b", nonce: "shared", corrupt: second === "corrupt", counter: second === "counter" },
            ]);
            const result = await createOfflineVerifier(h.options).verify(request);
            expect(result).toMatchObject({ status: "invalid", reason: "ambiguous-signatures" });
            expect(result.candidates.map((candidate) => candidate.label)).toEqual(["a", "b"]);
            expect(result.candidates.map((candidate) => candidate.reason)).toEqual([
                "ambiguous-signatures",
                second === "valid" ? "ambiguous-signatures"
                    : second === "corrupt" ? "signature-mismatch" : "unsupported-profile",
            ]);
            expect(result.candidates.every((candidate) => candidate.status !== "verified")).toBe(true);
            expect(h.calls).toHaveLength(0);
            expect(h.context.inFlight).toBe(0);
        },
    );

    it.each(["all", "any"] as const)(
        "%s evaluates later failures and retains both results", async (aggregate) => {
            const h = harness();
            const request = await signed([
                { label: "a", nonce: "good" }, { label: "b", nonce: "bad", corrupt: true },
            ]);
            const result = await createOfflineVerifier({
                ...h.options, candidatePolicy: { mode: "multiple", aggregate },
            }).verify(request);
            expect(result.status).toBe(aggregate === "all" ? "invalid" : "verified");
            expect(result.candidates.map((candidate) => candidate.reason))
                .toEqual(["nonce-consumed", "signature-mismatch"]);
            expect(h.calls).toHaveLength(1);
            expect(h.calls[0]!.nonce).toBe("good");
            expect(result).not.toHaveProperty("identity");
        },
    );

    it("shares one atomic outcome within an invocation but not between invocations", async () => {
        const seen = new Set<string>();
        const h = harness(async (input) => {
            const key = JSON.stringify([input.scope, input.keyThumbprint, input.nonce]);
            if (seen.has(key)) return "replayed";
            seen.add(key);
            return "accepted";
        });
        const request = await signed([
            { label: "a", nonce: "shared" },
            { label: "b", nonce: "shared", created: start + 30, expires: start + 90 },
        ]);
        const verifier = createOfflineVerifier({
            ...h.options, candidatePolicy: { mode: "multiple" },
        });
        expect(await verifier.verify(request)).toMatchObject({ status: "verified" });
        expect(h.calls).toHaveLength(1);
        expect(h.calls[0]!.retainUntilEpochSeconds).toBe(start + 360);
        const replay = await verifier.verify(request);
        expect(replay.status).toBe("invalid");
        expect(replay.candidates.map((candidate) => candidate.reason))
            .toEqual(["replay-detected", "replay-detected"]);
        expect(h.calls).toHaveLength(2);
    });

    it("optional absence consumes nothing, but a present nonce still requires the store", async () => {
        const h = harness(async () => "replayed");
        const result = await createOfflineVerifier({
            ...h.options,
            candidatePolicy: { mode: "multiple", aggregate: "any" },
            profiles: { "ietf-wg-protocol-00": { noncePolicy: "optional" } },
        }).verify(await signed([{ label: "a" }, { label: "b", nonce: "used" }]));
        expect(result).toMatchObject({ status: "verified", reason: "nonce-absent-optional" });
        expect(result.candidates.map((candidate) => candidate.reason))
            .toEqual(["nonce-absent-optional", "replay-detected"]);
        expect(result.candidates[0]).toMatchObject({ replayProtected: false });
        expect(h.calls).toHaveLength(1);
    });

    it("reset during the second group invalidates the first accepted group as well", async () => {
        let release!: (outcome: StoreOutcome) => void;
        let dispatched!: () => void;
        const waiting = new Promise<void>((resolve) => { dispatched = resolve; });
        const pending = new Promise<StoreOutcome>((resolve) => { release = resolve; });
        const h = harness(async (input) => {
            if (input.nonce === "first") return "accepted";
            dispatched();
            return pending;
        });
        const verifier = createOfflineVerifier({
            ...h.options, candidatePolicy: { mode: "multiple", aggregate: "any" },
        });
        const resultPromise = verifier.verify(await signed([
            { label: "a", nonce: "first" }, { label: "b", nonce: "second" },
        ]));
        await waiting;
        await h.context.resetClockReference();
        release("accepted");
        const result = await resultPromise;
        expect(result).toMatchObject({ status: "unverified", reason: "clock-unavailable" });
        expect(result.candidates.map((candidate) => candidate.reason))
            .toEqual(["clock-unavailable", "clock-unavailable"]);
        expect(h.calls).toHaveLength(2);
        expect(h.context.inFlight).toBe(0);
    });

    it("final time check rejects an earlier accepted group that expires during a later group", async () => {
        const h = harness(async (input) => {
            if (input.nonce === "second") h.advance(90);
            return "accepted";
        });
        const result = await createOfflineVerifier({
            ...h.options, candidatePolicy: { mode: "multiple", aggregate: "any" },
        }).verify(await signed([
            { label: "a", nonce: "first" },
            { label: "b", nonce: "second", expires: start + 120 },
        ]));
        expect(result.status).toBe("verified");
        expect(result.candidates.map((candidate) => candidate.reason))
            .toEqual(["signature-expired", "nonce-consumed"]);
        expect(h.calls).toHaveLength(2);
        expect(h.context.inFlight).toBe(0);
    });
});