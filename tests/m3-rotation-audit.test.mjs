import assert from "node:assert/strict";
import { createHash, createPublicKey } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// Independent contract audit. No production or importer helpers are loaded.
// Full-verifier expectations remain acceptance gates, not executed verification.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = resolve(root, "tests/fixtures/m3-rotation");
const read = (path) => readFileSync(resolve(directory, path));
const contract = JSON.parse(read("cases.json"));
const manifest = JSON.parse(read("manifest.json"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const thumbprint = (jwk) => createHash("sha256").update(JSON.stringify({
    crv: jwk.crv, kty: jwk.kty, x: jwk.x,
})).digest("base64url");

test("rotation manifest pins every authored byte and unchanged source reference", () => {
    assert.deepEqual(readdirSync(directory).sort(), ["cases.json", "manifest.json"]);
    assert.equal(manifest.files.length, 1);
    const file = manifest.files[0];
    assert.equal(file.path, "cases.json");
    const bytes = read(file.path);
    assert.equal(bytes.length, file.bytes);
    assert.equal(hash(bytes), file.sha256);
    assert(!bytes.includes(13));
    assert.deepEqual(contract.sources, manifest.sources.map((source) => source.path));
    for (const source of manifest.sources) {
        assert.equal(hash(readFileSync(resolve(root, source.path))), source.sha256, source.path);
    }
    const ids = [...contract.cases, ...contract.membershipCases].map((row) => row.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(ids.length, 11);
});

for (const [name, material] of Object.entries(contract.keys)) {
    test(`independent RFC 7638 public-key identity: ${name}`, () => {
        assert.equal(thumbprint(material.jwk), material.thumbprint);
        const key = createPublicKey({ key: material.jwk, format: "jwk" });
        assert.equal(key.asymmetricKeyType, "ed25519");
        assert.equal(thumbprint(key.export({ format: "jwk" })), material.thumbprint);
        assert(!Object.hasOwn(material.jwk, "d"));
    });
}

for (const row of contract.membershipCases) {
    test(`current fresh same-origin membership: ${row.id}`, () => {
        const selected = contract.keys.original.thumbprint;
        const current = row.currentKeys.map((name) => thumbprint(contract.keys[name].jwk));
        assert.equal(row.sameOrigin && row.fresh && current.includes(selected), row.pass);
    });
}

test("retained and removed keys require full-verifier races, not cache-only success", () => {
    for (const id of ["a-key-remains-during-replay-await", "b-key-removed-during-replay-await"]) {
        const row = contract.cases.find((entry) => entry.id === id);
        assert.equal(row.boundary, "full-network-verifier");
        assert.equal(row.currentSetFresh, true);
        assert.equal(row.allOtherVerificationGatesPass, true);
        assert.equal(row.replayConsumptions, 1);
        const retained = row.replacementKeys.includes("original");
        assert.deepEqual(row.expected, retained
            ? { status: "verified", reason: "nonce-consumed" }
            : { status: "unverified", reason: "unknown-key" });
        if (!retained) assert.equal(row.rollbackConsumedNonce, false);
    }
    assert.equal(contract.policy.generationEqualityRequired, false);
    assert.equal(contract.policy.keyObjectEqualityRequired, false);
    assert.equal(contract.policy.selectionMustBelongToCache, true);
    assert.equal(contract.policy.nonceRollbackAllowed, false);
});

test("selected-key mismatch stays separate from ordinary thumbprint lookup", () => {
    const row = contract.cases.find((entry) => entry.id === "c-same-keyid-different-selected-material");
    assert.equal(row.boundary, "assertSelectedKeyIdentity");
    assert.notEqual(contract.keys[row.signedKeyIdFrom].thumbprint,
        thumbprint(contract.keys[row.selectedMaterialFrom].jwk));
    assert.deepEqual(row.expected, { status: "invalid", reason: "key-id-mismatch" });
    assert.equal(row.normalLookupByKidPermitted, false);
    assert.equal(row.fullVerifierAcceptanceAsserted, false);
});

for (const row of contract.cases.filter((entry) => entry.id.startsWith("c-prime-"))) {
    test(`invalid WG refresh preserves evidence without extending freshness: ${row.id}`, () => {
        const badIndex = row.refreshKeys.findIndex((entry) =>
            thumbprint(contract.keys[entry.materialFrom].jwk) !==
            contract.keys[entry.kidFrom].thumbprint);
        assert.equal(badIndex, 1);
        assert.deepEqual(row.refreshExpected.diagnostic, {
            keyIndex: badIndex, rule: "kid must equal the RFC 7638 thumbprint",
        });
        assert.equal(row.refreshExpected.reason, "invalid-jwks");
        assert.equal(row.refreshExpected.observerEvents, 1);
        assert.equal(row.refreshExpected.entireNewSetRejected, true);
        assert.equal(row.refreshExpected.priorEvidenceUnchanged, true);
        assert.equal(row.refreshExpected.priorFreshnessExtended, false);
        const fresh = row.finalAtElapsedSeconds < row.initialFreshnessSeconds;
        assert.deepEqual(row.expected, fresh
            ? { status: "verified", reason: "nonce-consumed" }
            : { status: "unverified", reason: "unknown-key" });
        // Fresh request timestamps isolate cache expiry from signature expiry.
        assert.equal(row.finalAtElapsedSeconds - row.requestSignedAtElapsedSeconds, 1);
        if (!fresh) assert.equal(row.replayConsumptions, 0);
    });
}

test("refresh diagnostics do not expand the request catalog or reflect remote values", () => {
    assert.equal(contract.policy.catalogVersion, 1);
    assert.equal(contract.diagnostics.separateFromVerificationCatalog, true);
    assert.equal(contract.diagnostics.remoteDocumentFailureIsNotOperatorConfigurationFailure, true);
    for (const field of ["kid", "body", "publicKey", "privateKey", "nonce", "cause", "backendMessage"]) {
        assert(contract.diagnostics.forbiddenFields.includes(field));
    }
    assert.match(contract.diagnostics.unknownKeyRationale, /no usable fresh key evidence/);
});