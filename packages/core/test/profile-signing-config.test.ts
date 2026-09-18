import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CoveredComponent } from "../src/types.js";
import {
    resolveSigningConfiguration,
    signingFailure,
} from "../src/profiles/signing-config.js";
import type { SigningOptions } from "../src/profiles/signing-config.js";
import { SigningError } from "../src/profiles/signing-errors.js";

const privateKey = createPrivateKey(readFileSync(new URL(
    "../../../tests/fixtures/m2/generated/public-test-private.pem", import.meta.url,
)));
function options(): SigningOptions {
    return {
        privateKey,
        agentOrigin: "HTTPS://AGENT.EXAMPLE:443/",
        allowTestKeys: true,
    };
}

describe("signer configuration", () => {
    it("uses the approved WG, sig1, lifetime and resource defaults", () => {
        const config = resolveSigningConfiguration(options());
        expect(config.profile).toBe("ietf-wg-protocol-00");
        expect(config.label).toBe("sig1");
        expect(config.lifetimeSeconds).toBe(60);
        expect(config.agentHeader).toBe('sig1="https://agent.example"');
        expect(config.fieldTypes["signature-agent"]).toBe("dictionary");
        expect(config.profileLimits.generatedNonceBytes).toBe(32);
        expect(config.limits.maxSignatureBaseBytes).toBe(16384);
        expect(config.keyid).toBe("DR68nui99ukl-GUgfzQGaU3VwqRtArw-_DCN4LFtY84");
        expect(config.components.map((component) => component.name))
            .toEqual(["@method", "@target-uri", "signature-agent"]);
        expect(Object.isFrozen(config)).toBe(true);
    });

    it("requires explicit Cloudflare selection and keeps its agent field label-free", () => {
        const config = resolveSigningConfiguration({
            ...options(), profile: "cloudflare-docs-2026-07-01", label: "custom-agent",
        });
        expect(config.agentHeader).toBe('"https://agent.example"');
        expect(config.label).toBe("custom-agent");
        expect(config.components[2]!.parameters).toEqual([]);
        expect(config.fieldTypes["signature-agent"]).toBe("item");
    });

    it("rejects known test keys unless explicitly allowed", () => {
        expect(() => resolveSigningConfiguration({
            privateKey, agentOrigin: "https://agent.example",
        })).toThrow(expect.objectContaining({ code: "test-key-disallowed" }));
        const generated = generateKeyPairSync("ed25519");
        expect(() => resolveSigningConfiguration({
            privateKey: generated.privateKey, agentOrigin: "https://agent.example",
        })).not.toThrow();
    });

    it("rejects public, secret and non-Ed25519 signing material", () => {
        const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
        for (const key of [createPublicKey(privateKey), ec.privateKey, "private-key", null]) {
            expect(() => resolveSigningConfiguration({
                ...options(), privateKey: key,
            } as SigningOptions)).toThrow(expect.objectContaining({ code: "invalid-signing-key" }));
        }
    });

    it.each(["", "Sig1", "1sig", "sig one", "sig:one", "sigü"])(
        "rejects invalid SF label %s", (label) => {
            expect(() => resolveSigningConfiguration({ ...options(), label }))
                .toThrow(expect.objectContaining({ code: "invalid-label" }));
        },
    );

    it.each(["sig1", "*", "a_b.c-*"])("accepts SF key %s without another grammar", (label) => {
        expect(resolveSigningConfiguration({ ...options(), label }).label).toBe(label);
    });

    it("uses the common origin rejection and distinguishes URL budgets", () => {
        expect(() => resolveSigningConfiguration({
            ...options(), agentOrigin: "https://agent.example/path",
        })).toThrow(expect.objectContaining({ code: "invalid-agent-origin" }));
        expect(() => resolveSigningConfiguration({
            ...options(), limits: { maxAgentUrlBytes: 1 },
        })).toThrow(expect.objectContaining({ code: "resource-limit" }));
    });

    it("does not call providers during configuration", () => {
        let calls = 0;
        const config = resolveSigningConfiguration({
            ...options(),
            clock: () => { calls++; return 0; },
            nonceGenerator: () => { calls++; return "nonce"; },
        });
        expect(calls).toBe(0);
        expect(typeof config.clock).toBe("function");
        expect(typeof config.nonceGenerator).toBe("function");
    });

    it("owns additional component values and field types before callbacks", () => {
        const parameters: [string, { kind: "string"; value: string }][] = [
            ["key", { kind: "string", value: "entry" }],
        ];
        const extras: CoveredComponent[] = [{ name: "x-dict", parameters }];
        const types = { "x-dict": "dictionary" as const };
        const config = resolveSigningConfiguration({
            ...options(), additionalComponents: extras, structuredFieldTypes: types,
        });
        parameters[0]![1].value = "changed";
        extras.length = 0;
        delete (types as Partial<typeof types>)["x-dict"];
        expect(config.components[3]).toEqual({
            name: "x-dict", parameters: [["key", { kind: "string", value: "entry" }]],
        });
        expect(config.fieldTypes["x-dict"]).toBe("dictionary");
    });

    it("rejects unsupported components and contradictory agent field types", () => {
        expect(() => resolveSigningConfiguration({
            ...options(), additionalComponents: [{ name: "signature", parameters: [] }],
        })).toThrow(expect.objectContaining({ code: "unsupported-component" }));
        expect(() => resolveSigningConfiguration({
            ...options(), structuredFieldTypes: { "signature-agent": "item" },
        })).toThrow(expect.objectContaining({ code: "invalid-signing-options" }));
    });

    it("maps configuration errors into the signer-only error type", () => {
        for (const override of [
            { unknown: true },
            { clock: 42 },
            { nonceGenerator: "nonce" },
            { allowTestKeys: "yes" },
            { limits: { maxKeys: -1 } },
            { coreLimits: { maxSignatures: -1 } },
            { timePolicy: { signingLifetimeSeconds: 0 } },
        ]) {
            expect(() => resolveSigningConfiguration({
                ...options(), ...override,
            } as SigningOptions)).toThrow(expect.objectContaining({
                code: "invalid-signing-options",
            }));
        }
        expect(() => resolveSigningConfiguration({
            ...options(), profile: "future-profile",
        } as unknown as SigningOptions)).toThrow(expect.objectContaining({
            code: "unsupported-profile",
        }));
    });

    it("does not run top-level configuration getters", () => {
        let calls = 0;
        const value = Object.defineProperty(options(), "clock", {
            get() { calls++; return () => 0; },
        });
        expect(() => resolveSigningConfiguration(value)).toThrow(SigningError);
        expect(calls).toBe(0);
    });

    it("does not hide unexpected programming errors", () => {
        const bug = new Error("internal invariant");
        expect(() => signingFailure(bug)).toThrow(bug);
        const expected = new SigningError("invalid-request");
        expect(() => signingFailure(expected)).toThrow(expected);
    });
});