import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, X509Certificate } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// Independent expectation audit: no production code or importer helpers.
// Arithmetic below checks authored expectations, not a working Redis adapter.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = resolve(root, "tests/fixtures/m3-contract");
const read = (path) => readFileSync(resolve(directory, path));
const json = (path) => JSON.parse(read(path));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const recovery = json("recovery-cases.json");
const fetchCache = json("fetch-cache-cases.json");
const redis = json("redis-cases.json");
const classifications = json("f3-classification-cases.json");

test("contract manifest covers every expectation and TLS fixture byte", () => {
    const manifest = json("manifest.json");
    const paths = [];
    function walk(path = "") {
        for (const entry of readdirSync(resolve(directory, path), { withFileTypes: true })) {
            const next = path ? `${path}/${entry.name}` : entry.name;
            if (entry.isDirectory()) walk(next);
            else paths.push(next);
        }
    }
    walk();
    assert.equal(manifest.productionImplementationExists, false);
    assert.equal(new Set(manifest.files.map((f) => f.path)).size, manifest.files.length);
    assert.deepEqual(paths.filter((p) => p !== "manifest.json").sort(),
        manifest.files.map((f) => f.path).sort());
    for (const file of manifest.files) {
        assert(!file.path.includes("..") && !file.path.startsWith("/"));
        const bytes = read(file.path);
        assert.equal(bytes.length, file.bytes, file.path);
        assert.equal(hash(bytes), file.sha256, file.path);
        assert(!bytes.includes(13), `CR in ${file.path}`);
    }
    for (const source of manifest.sources) {
        assert.equal(hash(readFileSync(resolve(root, source.path))), source.sha256, source.path);
    }
});

for (const fixture of recovery.helperCases) {
    test(`recovery bound: ${fixture.id}`, () => {
        const p = fixture.policy;
        const horizon = BigInt(Math.min(p.maxAgeSeconds, p.maxLifetimeSeconds)) +
            2n * BigInt(p.clockSkewSeconds);
        if (fixture.expectedConfigurationCode) {
            assert(horizon > BigInt(Number.MAX_SAFE_INTEGER));
            assert.equal(fixture.expectedConfigurationCode, "invalid-time-policy");
        } else {
            assert.equal(horizon, BigInt(fixture.expectedSeconds));
        }
    });
}

test("359/360/361 boundaries distinguish signature eligibility from quarantine completion", () => {
    const signature = recovery.signatureBoundary;
    const p = signature.policy;
    for (const row of signature.cases) {
        const now = signature.firstAcceptedAt + row.elapsedSeconds;
        const eligible = signature.created <= now + p.clockSkewSeconds &&
            signature.expires > signature.created &&
            signature.expires - signature.created <= p.maxLifetimeSeconds &&
            now < signature.expires + p.clockSkewSeconds &&
            now < signature.created + p.maxAgeSeconds + p.clockSkewSeconds;
        assert.equal(eligible, row.timeEligible);
    }
    assert.deepEqual(signature.cases.slice(1).map((row) => row.elapsedSeconds), [359, 360, 361]);
    const q = recovery.redisQuarantine;
    assert.equal(q.quarantineUntilRedisMilliseconds,
        q.detectedAtRedisMilliseconds + q.recoveryHorizonSeconds * 1000);
    for (const row of q.cases) {
        const blocked = q.detectedAtRedisMilliseconds + row.elapsedSeconds * 1000 <
            q.quarantineUntilRedisMilliseconds;
        assert.equal(blocked, row.expectedStoreOutcome === "unavailable");
    }
    assert.equal(q.manualEarlyRelease, "Not supported");
});

test("Redis admission never treats absent policy evidence or ambiguous completion as acceptance", () => {
    for (const row of recovery.configurationCases) {
        assert.equal(row.expectedConfigurationCode, "invalid-replay-policy");
        const horizon = row.input.recoveryHorizonSeconds;
        assert(!(typeof horizon === "number" && Number.isSafeInteger(horizon) && horizon > 0));
    }
    for (const row of recovery.evictionAdmissionCases) {
        const permitted = row.configGet === "noeviction" ||
            (row.configGet === "permission-denied" && row.acknowledgeEvictionPolicy === "noeviction");
        assert.equal(row.connectionAdmitted, permitted, row.id);
    }
    assert.equal(redis.contract.automaticCommandRetry, false);
    assert.equal(redis.contract.memoryFallback, false);
    assert.equal(redis.contract.operatorCatalogChanges, false);
    const lost = redis.failureCases.find((row) => row.id === "reply-lost-after-commit");
    assert.equal(lost.expectedOutcome, "unavailable");
    assert.equal(lost.laterIndependentInvocationOutcome, "replayed");
    assert.equal(recovery.acceptedResidualRisks.length, 3);
});

test("Redis duration conversion uses dispatch difference, not a shared absolute clock", () => {
    for (const row of redis.retentionCases) {
        const duration = (BigInt(row.retainUntilEpochSeconds) - BigInt(row.nowEpochSeconds)) * 1000n;
        if (row.expectedOutcome) {
            assert(duration <= 0n || duration > BigInt(Number.MAX_SAFE_INTEGER));
            assert.equal(row.expectedOutcome, "unavailable");
        } else {
            assert.equal(duration, BigInt(row.expectedDurationMilliseconds));
            assert.equal(BigInt(row.redisExecutionMilliseconds) + duration,
                BigInt(row.expectedRedisDeadlineMilliseconds));
        }
    }
    const concurrent = redis.consumeCases.find((row) => row.id === "concurrent-same-tuple");
    assert.equal(concurrent.expectedAccepted + concurrent.expectedReplayed, concurrent.simultaneousAttempts);
    assert.equal(concurrent.expectedAccepted, 1);
    assert.equal(redis.consumeCases.find((row) => row.id === "quota-spans-scopes").expectedOutcome,
        "per-key-quota-exceeded");
});

test("fetch/cache expectations preserve open-mode protections and bounded freshness", () => {
    assert.equal(fetchCache.admission.defaultMode, "allowlist");
    assert.equal(fetchCache.admission.openModeCannotDisableProtection, true);
    assert.equal(fetchCache.admission.tlsVerificationDisableOption, false);
    assert.equal(fetchCache.limits.perOriginConcurrentFetches, 1);
    assert.equal(fetchCache.limits.globalConcurrentFetches, 16);
    assert.equal(fetchCache.cachePolicy.defaultFreshnessSecondsWithoutExplicitFreshness, 60);
    assert.equal(fetchCache.cachePolicy.defaultNegativeSeconds, 60);
    assert.equal(fetchCache.cachePolicy.maximumConfiguredFreshnessSeconds, 300);
    assert.equal(fetchCache.cachePolicy.maximumConfiguredNegativeSeconds, 300);
    assert.equal(fetchCache.cachePolicy.staleAcceptance, false);
    assert.equal(fetchCache.cachePolicy.conditionalRequests, false);
    assert.equal(fetchCache.cachePolicy.acceptEncoding, "identity");
    for (const id of ["private-ip", "ipv6-literal-origin", "mapped-loopback-answer", "mixed-dns-answer"]) {
        const row = fetchCache.fetchCases.find((entry) => entry.id === id);
        assert.equal(row.connectionCalls, 0, id);
        assert.equal(row.discoveryAccepted, false, id);
    }
    const reset = fetchCache.cacheCases.find((row) => row.id === "clock-reset-keeps-cache-age");
    assert(reset.elapsedBeforeResetSeconds + reset.elapsedAfterResetSeconds >= reset.lifetimeSeconds);
    assert.equal(reset.entryDeletedByReset, false);
    assert.equal(reset.entryFreshAfterReset, false);
});

test("F.3 negatives preserve tag selection and upstream vector bytes", () => {
    const bytes = readFileSync(resolve(root, classifications.source));
    assert.equal(hash(bytes), classifications.sourceSha256);
    const vectors = JSON.parse(bytes);
    assert.equal(classifications.wg00PositiveAcceptanceVectors, false);
    for (const row of classifications.cases) {
        const vector = vectors[row.sourceIndex];
        assert(vector.signature_input.includes(';tag="web-bot-auth"'));
        assert.equal(row.selectedCandidateCount, 1);
        assert.equal(row.signatureLabel, vector.label);
        assert.equal(row.fullVerifierFirstErrorAsserted, false);
        assert.equal(row.networkFetches, 0);
        assert.equal(row.nonceConsumptions, 0);
        assert.equal(row.expectedStatus, "invalid");
        if (vector.signature_agent === undefined) {
            assert.equal(row.expectedReason, "malformed-agent");
        } else {
            assert.equal(row.expectedReason, "agent-label-mismatch");
            assert.notEqual(vector.label, vector.signature_agent_key);
        }
    }
});

test("TLS certificate is matching public test material for the named fixture host only", () => {
    const certificate = new X509Certificate(read("tls/server-cert.pem"));
    const publicKey = createPublicKey(createPrivateKey(read("tls/server-key.pem")));
    assert.deepEqual(certificate.publicKey.export({ type: "spki", format: "der" }),
        publicKey.export({ type: "spki", format: "der" }));
    assert.equal(certificate.checkHost("directory.agentsig.test"), "directory.agentsig.test");
    assert.equal(certificate.checkHost("wrong.agentsig.test"), undefined);
    assert.equal(certificate.verify(publicKey), true);
    assert.equal(certificate.fingerprint256,
        "74:CC:2C:57:68:06:2C:6B:39:AB:D8:CB:2A:C5:E6:3E:DE:C2:D7:96:06:92:62:89:B3:DF:88:B8:70:DC:1F:3E");
});