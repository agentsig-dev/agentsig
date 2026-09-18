import { createPrivateKey, createPublicKey } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signHttpMessage } from "../src/index.js";
import { fixtureBytes, rfcRequest, rfcSignatureInput } from "./rfc9421-fixture.js";

describe("signing golden — RFC 9421 B.1.4 and B.2.6", () => {
    it("reproduces published header bytes without using our parser or verifier", async () => {
        const key = createPrivateKey(fixtureBytes("ed25519-private.pem"));
        const result = await signHttpMessage(rfcRequest(), rfcSignatureInput(), key);
        expect(result.label).toBe("sig-b26");
        const headers = Buffer.from(
            `Signature-Input: ${result.signatureInput}\nSignature: ${result.signature}`,
            "ascii",
        );
        expect(headers).toEqual(fixtureBytes("signature-headers.txt"));
    });

    it("produces the same deterministic signature for the same inputs", async () => {
        const key = createPrivateKey(fixtureBytes("ed25519-private.pem"));
        const first = await signHttpMessage(rfcRequest(), rfcSignatureInput(), key);
        const second = await signHttpMessage(rfcRequest(), rfcSignatureInput(), key);
        expect(second).toEqual(first);
        // Determinism alone is insufficient: both must match the external vector.
        expect(Buffer.from(`Signature-Input: ${second.signatureInput}\nSignature: ${second.signature}`))
            .toEqual(fixtureBytes("signature-headers.txt"));
    });

    it("does not mutate the message or signature-input descriptor", async () => {
        const message = rfcRequest();
        const input = rfcSignatureInput();
        const originalMessage = structuredClone(message);
        const originalInput = structuredClone(input);
        await signHttpMessage(message, input, createPrivateKey(fixtureBytes("ed25519-private.pem")));
        expect(message).toEqual(originalMessage);
        expect(input).toEqual(originalInput);
    });

    it("rejects a public key supplied for signing", async () => {
        const key = createPublicKey(fixtureBytes("ed25519-public.pem"));
        await expect(signHttpMessage(rfcRequest(), rfcSignatureInput(), key))
            .rejects.toMatchObject({ reason: "invalid-key" });
    });
});