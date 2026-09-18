import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { HeaderFields, RequestParts } from "../src/types.js";
import { WEB_BOT_AUTH_PROFILES } from "../src/profiles/agent-header.js";
import type { WebBotAuthProfile } from "../src/profiles/agent-header.js";
import { createSecurityContext } from "../src/profiles/security-context.js";
import type { SecurityContextOptions } from "../src/profiles/security-context.js";
import { createOfflineVerifier } from "../src/profiles/verifier.js";
import type { OfflineVerifierOptions } from "../src/profiles/verification-types.js";

const root = new URL("../../../tests/fixtures/m2/generated/", import.meta.url);
const jwks = readFileSync(new URL("jwks.json", root));
const thumbprint = "DR68nui99ukl-GUgfzQGaU3VwqRtArw-_DCN4LFtY84";
const start = 1800000000;

function request(profile: WebBotAuthProfile = "ietf-wg-protocol-00"): RequestParts {
    return {
        method: "GET", targetUri: "https://merchant.example/items?sku=42",
        headers: readFileSync(new URL(`${profile}/headers.txt`, root), "utf8")
            .split("\n").map((line) => {
                const colon = line.indexOf(":");
                return [line.slice(0, colon), line.slice(colon + 2)] as const;
            }),
    };
}

function change(source: RequestParts, field: string, edit: (value: string) => string): RequestParts {
    return {
        ...source,
        headers: source.headers.map(([name, value]) => [
            name, name.toLowerCase() === field ? edit(String(value)) : value,
        ] as const),
    };
}

function harness(
    overrides: Partial<OfflineVerifierOptions> = {},
    contextOptions: SecurityContextOptions = {},
) {
    let elapsed = 0;
    let drift = 0;
    const context = createSecurityContext({
        ...contextOptions,
        wallClock: () => (start + elapsed) * 1000 + drift,
        monotonicClock: () => elapsed * 1000,
    });
    const verifier = createOfflineVerifier({
        jwks, scope: "merchant", context, allowTestKeys: true, ...overrides,
    });
    return {
        verifier, context,
        advance(seconds: number) { elapsed += seconds; },
        setDrift(milliseconds: number) { drift = milliseconds; },
    };
}

describe("offline verifier rejection gates leave replay memory untouched", () => {
    for (const profile of WEB_BOT_AUTH_PROFILES) {
        describe(profile, () => {
            it.each([
                {
                    name: "changed method", edit: (r: RequestParts) => ({ ...r, method: "POST" }),
                    reason: "signature-mismatch"
                },
                {
                    name: "changed target", edit: (r: RequestParts) => ({ ...r, targetUri: r.targetUri + "0" }),
                    reason: "signature-mismatch"
                },
                {
                    name: "missing expires", edit: (r: RequestParts) =>
                        change(r, "signature-input", (s) => s.replace(/;expires=\d+/, "")),
                    reason: "missing-required-parameter"
                },
                {
                    name: "wrong expires type", edit: (r: RequestParts) =>
                        change(r, "signature-input", (s) => s.replace(/;expires=\d+/, ';expires="1800000060"')),
                    reason: "malformed-signature"
                },
                {
                    name: "bad keyid encoding", edit: (r: RequestParts) =>
                        change(r, "signature-input", (s) => s.replace(thumbprint, "not-a-thumbprint")),
                    reason: "invalid-parameter"
                },
                {
                    name: "unknown canonical keyid", edit: (r: RequestParts) =>
                        change(r, "signature-input", (s) => s.replace(thumbprint, "A".repeat(43))),
                    reason: "unknown-key"
                },
                {
                    name: "missing nonce", edit: (r: RequestParts) =>
                        change(r, "signature-input", (s) => s.replace(/;nonce="[^"]*"/, "")),
                    reason: "nonce-required"
                },
                {
                    name: "empty nonce", edit: (r: RequestParts) =>
                        change(r, "signature-input", (s) => s.replace(/;nonce="[^"]*"/, ';nonce=""')),
                    reason: "nonce-invalid"
                },
                {
                    name: "known algorithm contradiction", edit: (r: RequestParts) =>
                        change(r, "signature-input", (s) => s.replace(/;alg="[^"]*"/, "") + ';alg="rsa-pss-sha512"'),
                    reason: "algorithm-mismatch"
                },
                {
                    name: "JOSE name is not an HTTP alias", edit: (r: RequestParts) =>
                        change(r, "signature-input", (s) => s.replace(/;alg="[^"]*"/, "") + ';alg="EdDSA"'),
                    reason: "unsupported-algorithm"
                },
                {
                    name: "canonical identity cannot rewrite signed bytes", edit: (r: RequestParts) =>
                        change(r, "signature-agent", (s) => s.replace("https://agent.example", "HTTPS://AGENT.EXAMPLE:443/")),
                    reason: "signature-mismatch"
                },
            ])("$name", async ({ edit, reason }) => {
                const h = harness();
                const result = await h.verifier.verify(edit(request(profile)));
                expect(result.reason).toBe(reason);
                expect(result.status).not.toBe("verified");
                expect(result.candidates).toHaveLength(1 === Number(reason === "malformed-signature") ? 0 : 1);
                expect(h.context.memoryRecords).toBe(0);
                expect(h.context.inFlight).toBe(0);
            });

            it("requires explicit matching local binding for directory identity", async () => {
                for (const [bindings, reason] of [
                    [[], "agent-binding-missing"],
                    [[{ thumbprint, origin: "https://different.example" }], "agent-binding-mismatch"],
                ] as const) {
                    const h = harness({ identityMode: "directory-url", bindings });
                    expect(await h.verifier.verify(request(profile))).toMatchObject({ reason });
                    expect(h.context.memoryRecords).toBe(0);
                }
            });

            it("rejects expiry before consuming and refuses unhealthy clock cleanup", async () => {
                const expired = harness();
                expired.advance(90);
                expect(await expired.verifier.verify(request(profile))).toMatchObject({
                    status: "invalid", reason: "signature-expired",
                });
                expect(expired.context.memoryRecords).toBe(0);

                const h = harness();
                expect((await h.verifier.verify(request(profile))).status).toBe("verified");
                h.setDrift(30001);
                expect(await h.verifier.verify(request(profile))).toMatchObject({
                    status: "unverified", reason: "clock-unavailable",
                });
                expect(h.context.memoryRecords).toBe(1);
                expect(h.context.inFlight).toBe(0);
            });
        });
    }

    it("does not partition replay memory by profile", async () => {
        const h = harness();
        expect((await h.verifier.verify(request(WEB_BOT_AUTH_PROFILES[0]))).status).toBe("verified");
        expect(await h.verifier.verify(request(WEB_BOT_AUTH_PROFILES[1]))).toMatchObject({
            status: "invalid", reason: "replay-detected",
        });
        expect(h.context.memoryRecords).toBe(1);
    });

    it.each([
        { capacity: 0, maxPerKey: 1, reason: "replay-store-unavailable" },
        { capacity: 1, maxPerKey: 0, reason: "per-key-quota-exceeded" },
        { capacity: 0, maxPerKey: 0, reason: "per-key-quota-exceeded" },
    ])("preserves capacity/quota distinction: $reason", async ({ capacity, maxPerKey, reason }) => {
        const h = harness({}, { replayPolicy: { capacity, maxPerKey } });
        expect(await h.verifier.verify(request())).toMatchObject({ status: "unverified", reason });
        expect(h.context.memoryRecords).toBe(0);
    });

    it("distinguishes unsigned traffic from malformed unrelated pairs", async () => {
        const h = harness();
        expect(await h.verifier.verify({ ...request(), headers: [] })).toMatchObject({
            status: "unsigned", reason: "no-signature",
        });
        const unrelated = change(request(), "signature-input", (s) => s.replace("web-bot-auth", "other"));
        expect(await h.verifier.verify(unrelated)).toMatchObject({
            status: "unsigned", reason: "no-web-bot-auth-candidate",
        });
        const headers: HeaderFields = [
            ...request().headers,
            ["Signature-Input", 'other=("@method");created="wrong";tag="other"'],
            ["Signature", "other=:AA==:"],
        ];
        expect(await h.verifier.verify({ ...request(), headers })).toMatchObject({
            status: "invalid", reason: "malformed-signature", candidates: [],
        });
        expect(h.context.memoryRecords).toBe(0);
    });

    it("requires allow-list membership without retrying the other grammar", async () => {
        const h = harness({ allowedProfiles: ["ietf-wg-protocol-00"] });
        expect(await h.verifier.verify(request("cloudflare-docs-2026-07-01"))).toMatchObject({
            status: "unverified", reason: "profile-disallowed",
        });
        expect(h.context.memoryRecords).toBe(0);
    });
});