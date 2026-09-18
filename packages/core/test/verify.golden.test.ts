import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyHttpSignatureCryptography } from "../src/index.js";
import {
    fixtureBytes,
    rfcParsedSignature,
    rfcRequest,
    rfcSignatureInput,
} from "./rfc9421-fixture.js";

describe("verification golden — RFC 9421 B.2.6", () => {
    const publicKey = createPublicKey(fixtureBytes("ed25519-public.pem"));

    it("verifies published bytes without our signing or header-parsing functions", async () => {
        const result = await verifyHttpSignatureCryptography(
            rfcRequest(), rfcParsedSignature(), publicKey,
        );
        expect(result).toEqual({
            status: "signature-valid",
            input: rfcSignatureInput(),
        });
        // The 2021 timestamp deliberately remains unchanged: this is cryptography,
        // not freshness validation, trusted identity, or application authorization.
    });

    it("rejects a changed covered method", async () => {
        const message = rfcRequest();
        if (message.kind !== "request") throw new Error("Invalid test setup");
        const changed = {
            ...message,
            request: { ...message.request, method: "GET" },
        };
        await expect(verifyHttpSignatureCryptography(changed, rfcParsedSignature(), publicKey))
            .resolves.toEqual({ status: "rejected", reason: "signature-mismatch" });
    });

    it("rejects a changed signature byte", async () => {
        const signature = rfcParsedSignature();
        signature.signature[0] = signature.signature[0]! ^ 1;
        await expect(verifyHttpSignatureCryptography(rfcRequest(), signature, publicKey))
            .resolves.toEqual({ status: "rejected", reason: "signature-mismatch" });
    });

    it("rejects the wrong Ed25519 public key", async () => {
        const otherKey = generateKeyPairSync("ed25519").publicKey;
        await expect(verifyHttpSignatureCryptography(rfcRequest(), rfcParsedSignature(), otherKey))
            .resolves.toEqual({ status: "rejected", reason: "signature-mismatch" });
    });

    it.each([0, 63, 65])("rejects an Ed25519 signature of %i bytes", async (length) => {
        const signature = { ...rfcParsedSignature(), signature: new Uint8Array(length) };
        await expect(verifyHttpSignatureCryptography(rfcRequest(), signature, publicKey))
            .resolves.toMatchObject({ status: "rejected" });
    });

    it("rejects a key from an unsupported curve", async () => {
        const otherKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey;
        await expect(verifyHttpSignatureCryptography(rfcRequest(), rfcParsedSignature(), otherKey))
            .resolves.toEqual({ status: "rejected", reason: "invalid-key" });
    });

    it("rejects an explicit algorithm conflicting with Ed25519", async () => {
        const signature = rfcParsedSignature();
        const changed = {
            ...signature,
            input: {
                ...signature.input,
                parameters: [
                    ...signature.input.parameters,
                    ["alg", { kind: "string", value: "rsa-pss-sha512" }] as const,
                ],
            },
        };
        await expect(verifyHttpSignatureCryptography(rfcRequest(), changed, publicKey))
            .resolves.toEqual({ status: "rejected", reason: "algorithm-mismatch" });
    });
});