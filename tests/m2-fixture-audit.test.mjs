import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// Independent fixture audit: no agentsig imports, build output, network, or
// importer helpers. This checks data, NOT an M2 verifier/store implementation.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = "tests/fixtures/m2";
const read = (path) => readFileSync(resolve(root, directory, path));
const text = (path) => read(path).toString("utf8");
const json = (path) => JSON.parse(text(path));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const manifest = json("manifest.json");
const profiles = ["ietf-wg-protocol-00", "cloudflare-docs-2026-07-01"];
const wg = text("sources/wg-protocol-00.txt");
const cf = text("sources/cloudflare-2026-07-01.mdx");

// Normalize RFC publication wrapping only. Never trim signed fixture bytes.
function publishedSection(id, next) {
    const from = wg.indexOf(`\n${id}. `);
    const to = wg.indexOf(`\n${next} `, from + 1);
    assert(from >= 0 && to > from);
    return wg.slice(from + 1, to);
}
function unfold(text) {
    const lines = text.split("\n");
    let output = "";
    let continuation = false;
    for (let index = 0; index < lines.length; index++) {
        const line = continuation ? lines[index].replace(/^[ \t]+/, "") : lines[index];
        continuation = line.endsWith("\\");
        output += continuation ? line.slice(0, -1) : line;
        if (!continuation && index !== lines.length - 1) output += "\n";
    }
    assert.equal(continuation, false);
    return output;
}
function publishedBase(section) {
    const lines = section.split("\n");
    const start = lines.findIndex((line) => line.startsWith('"@authority"'));
    assert(start >= 0);
    const end = lines.findIndex((line, index) => index > start && line === "");
    assert(end > start);
    return Buffer.from(unfold(lines.slice(start, end).join("\n")));
}

test("M2 manifest covers every fixture; source hashes and licenses are pinned", () => {
    const paths = [];
    function walk(path = "") {
        for (const entry of readdirSync(resolve(root, directory, path), { withFileTypes: true })) {
            const next = path ? `${path}/${entry.name}` : entry.name;
            if (entry.isDirectory()) walk(next);
            else paths.push(next);
        }
    }
    walk();
    const pinned = manifest.files.map((file) => file.path);
    assert.equal(new Set(pinned).size, pinned.length);
    assert.deepEqual(paths.filter((path) => path !== "manifest.json").sort(), [...pinned].sort());
    for (const file of manifest.files) {
        assert(!file.path.includes("..") && !file.path.startsWith("/"));
        const bytes = read(file.path);
        assert.equal(bytes.length, file.bytes, file.path);
        assert.equal(hash(bytes), file.sha256, file.path);
        if (!file.path.endsWith(".bin")) assert(!bytes.includes(13), `CR in ${file.path}`);
    }
    assert.equal(hash(read("sources/wg-protocol-00.txt")),
        "3021fd94cdffdb2eb030dec68b1a5c968f2348502dd94c481e2085ec7ddd90a0");
    assert.equal(hash(read("sources/cloudflare-2026-07-01.mdx")),
        "c4aeeef723df97b020ecc4d9e680b77b5bfb6c214a6443b0fb7f00efd7e422f7");
    const cfBytes = read("sources/cloudflare-2026-07-01.mdx");
    assert.equal(createHash("sha1").update(`blob ${cfBytes.length}\0`).update(cfBytes).digest("hex"),
        "3914e02c768bd59a2a42ab82c0ea326517edb40d");
    assert.match(text("sources/cloudflare-LICENSE.txt"), /Attribution 4\.0 International/);
    assert.match(text("sources/IETF-NOTICE.txt"), /2024, 2026 IETF Trust/);
    assert.match(text("sources/IETF-NOTICE.txt"), /Redistribution and use/);
});

for (const [id, next, expectedBytes] of [
    ["E.2.1", "E.2.2.", 375], ["E.2.2", "E.2.3.", 349], ["E.2.3", "Appendix F.", 298],
]) {
    test(`WG ${id}: source → exact base/headers → published Ed25519 signature`, () => {
        const section = publishedSection(id, next);
        assert.equal(text(`published/wg-${id}/section.txt`), section);
        const base = read(`published/wg-${id}/base.txt`);
        assert.deepEqual(base, publishedBase(section));
        assert.equal(base.length, expectedBytes);
        assert.notEqual(base.at(-1), 10);
        const signatureLine = section.split("\n").find((line) => line.startsWith("Signature: "));
        assert(signatureLine);
        const encoded = signatureLine.slice(signatureLine.indexOf("=:") + 2, -1);
        const signature = read(`published/wg-${id}/signature.bin`);
        assert.deepEqual(signature, Buffer.from(encoded, "base64"));
        assert.equal(signature.length, 64);
        const start = section.indexOf("\nSignature-Input: ");
        const end = section.indexOf("\n", section.indexOf("\nSignature: ") + 1);
        assert.equal(text(`published/wg-${id}/signature-headers.txt`),
            unfold(section.slice(start + 1, end)));
        const publicKey = createPublicKey(read("published/rfc9421-public.pem"));
        assert.equal(verify(null, base, publicKey, signature), true);
        assert.equal(verify(null, Buffer.concat([base, Buffer.from("\n")]), publicKey, signature), false);
        const inventory = json("vector-inventory.json").find((entry) => entry.id === id);
        assert.equal(inventory.cryptoValid, true);
        assert.equal(inventory.m2Positive, false);
    });
}

test("WG E.2.1 is a crypto-valid agent-label-mismatch negative fixture", () => {
    const policy = json("policy-cases.json");
    const negative = policy.negativeVectorCases.find(
        (entry) => entry.id === "wg-E.2.1-agent-label-mismatch",
    );
    assert(negative);
    const section = text(negative.sectionFile);
    const label = section.match(/\nSignature-Input: ([a-z0-9-]+)=/)?.[1];
    const agentMember = section.match(/\nSignature-Agent: ([a-z0-9-]+)=/)?.[1];
    assert.equal(label, "sig2");
    assert.equal(agentMember, "agent2");
    assert.notEqual(label, agentMember);
    assert.equal(negative.signatureLabel, label);
    assert.equal(negative.agentMemberKey, agentMember);
    assert.match(text(negative.baseFile), /"signature-agent";key="agent2"/);
    assert.equal(verify(null, read(negative.baseFile),
        createPublicKey(read(negative.publicKeyFile)), read(negative.signatureFile)), true);
    assert.equal(negative.expectedCryptoValid, true);
    assert.equal(negative.expectedStatus, "invalid");
    assert.equal(negative.expectedCode, "agent-label-mismatch");
    assert.equal(negative.stage, "agent-label-binding-only");
    assert.equal(negative.fullVerifierFirstErrorAsserted, false);
    assert.equal(negative.sourceBytesModified, false);
});

test("WG directory vector inventory preserves its response body/digest without adding M2 body support", () => {
    const section = publishedSection("E.2.3", "Appendix F.");
    const bodyBlock = section.match(/^   (\{"keys":[\s\S]*?)\n\n/m);
    assert(bodyBlock);
    const body = unfold(bodyBlock[1]);
    const digest = createHash("sha256").update(body).digest("base64");
    assert.equal(digest, "CADMT2aBdV/rqQr/NIru64ERQkCobVvllA4V0fLFDu0=");
    assert.equal(JSON.parse(body).keys[0].crv, "Ed25519");
});

test("Cloudflare display fixture is exact; wire adaptation stays distinct and matches WG legacy example", () => {
    const section = cf.slice(cf.indexOf("### 4.4."));
    const from = section.indexOf("```txt\n") + "```txt\n".length;
    const to = section.indexOf("\n```", from);
    assert(from >= 7 && to > from);
    const displayed = section.slice(from, to);
    assert.equal(text("published/cloudflare/request-displayed.txt"), displayed);
    const lines = displayed.split("\n");
    const logicalLines = [];
    for (const line of lines) {
        if (line.startsWith(" ;")) logicalLines[logicalLines.length - 1] += line.slice(1);
        else logicalLines.push(line);
    }
    const wire = logicalLines.join("\n");
    assert.equal(text("published/cloudflare/request-headers.txt"), wire);
    assert.equal(logicalLines[0], 'Signature-Agent: "https://signature-agent.test"');
    assert.equal(logicalLines.slice(1).join("\n"), text("published/wg-E.2.2/signature-headers.txt"));
    assert.notEqual(displayed, wire);
});

for (const profile of profiles) {
    test(`${profile}: independently authored strict fixture and real test key`, () => {
        const input = json(`generated/${profile}/case.json`);
        const jwk = json("generated/jwks.json").keys[0];
        // RFC 7638 / RFC 8037 mandatory members, lexicographic order, no whitespace.
        const expectedThumbprintInput = `{"crv":"Ed25519","kty":"OKP","x":"${jwk.x}"}`;
        assert.equal(text("generated/thumbprint-input.txt"), expectedThumbprintInput);
        const keyid = createHash("sha256").update(expectedThumbprintInput).digest("base64url");
        assert.equal(jwk.kid, keyid);
        assert.equal(input.keyid, keyid);
        assert.equal(input.profile, profile);
        const privateKey = createPrivateKey(read("generated/public-test-private.pem"));
        const publicKey = createPublicKey(read("generated/public-test-public.pem"));
        assert.deepEqual(createPublicKey(privateKey).export({ type: "spki", format: "der" }),
            publicKey.export({ type: "spki", format: "der" }));
        assert.equal(publicKey.export({ format: "jwk" }).x, jwk.x);
        const isWg = profile === profiles[0];
        const component = isWg ? '"signature-agent";key="agent"' : '"signature-agent"';
        const parameters = `("@method" "@target-uri" ${component});created=1800000000;expires=1800000060;keyid="${keyid}";alg="ed25519";nonce="m2-public-test-nonce-0001";tag="web-bot-auth"`;
        const expectedBase = [
            '"@method": GET',
            '"@target-uri": https://merchant.example/items?sku=42',
            `${component}: "https://agent.example"`,
            `"@signature-params": ${parameters}`,
        ].join("\n");
        const base = read(`generated/${profile}/base.txt`);
        const signature = read(`generated/${profile}/signature.bin`);
        assert.deepEqual(base, Buffer.from(expectedBase));
        assert.equal(signature.length, 64);
        assert.equal(verify(null, base, publicKey, signature), true);
        assert.deepEqual(sign(null, base, privateKey), signature);
        const agent = isWg ? 'agent="https://agent.example"' : '"https://agent.example"';
        assert.equal(text(`generated/${profile}/headers.txt`), [
            `Signature-Agent: ${agent}`,
            `Signature-Input: agent=${parameters}`,
            `Signature: agent=:${signature.toString("base64")}:`,
        ].join("\n"));
        assert.equal(input.expected.identityKind, "key-thumbprint");
        // These expectations remain future M2 tests, not an implemented policy check.
        assert.equal(input.expected.reason, "nonce-consumed");
    });
}

test("policy data has a closed catalog and internally consistent approved defaults", () => {
    const policy = json("policy-cases.json");
    assert.equal(policy.productionImplementationExists, false);
    assert.deepEqual(
        ["signingLifetimeSeconds", "maxLifetimeSeconds", "maxAgeSeconds", "clockSkewSeconds",
            "capacity", "maxPerKey"].map((key) => policy.defaults[key]),
        [60, 300, 300, 30, 10000, 1000],
    );
    const catalog = policy.codeCatalog;
    const publicCodes = ["unsigned", "verified", "invalid", "unverified"]
        .flatMap((status) => catalog[status]);
    assert.equal(new Set(publicCodes).size, publicCodes.length);
    assert.deepEqual(["unsigned", "verified", "invalid", "unverified"]
        .map((status) => catalog[status].length), [2, 2, 20, 11]);
    assert.deepEqual(catalog.unsigned, ["no-signature", "no-web-bot-auth-candidate"]);
    assert(catalog.invalid.includes("ambiguous-signatures"));
    assert(catalog.invalid.includes("agent-binding-mismatch"));
    assert(catalog.invalid.includes("algorithm-mismatch"));
    assert(catalog.unverified.includes("unsupported-algorithm"));
    assert(catalog.unverified.includes("per-key-quota-exceeded"));
    assert(!publicCodes.includes("aggregate-policy-required"));
    assert(catalog.configurationErrors.includes("invalid-candidate-policy"));
    assert(!catalog.unverified.includes("replay-store-full"));
    const allCodes = new Set(Object.values(catalog).flat());
    function check(value) {
        if (!value || typeof value !== "object") return;
        for (const [key, child] of Object.entries(value)) {
            if (key === "expectedCode" || key === "expectedStoreOutcome") assert(allCodes.has(child), child);
            else if (key === "expectedStoreOutcomes") {
                for (const outcome of child) assert(catalog.storeOutcomes.includes(outcome), outcome);
            }
            else check(child);
        }
    }
    check(policy);
    for (const example of policy.timeContract.cases) {
        if (example.retainUntil === undefined) continue;
        assert.equal(example.retainUntil,
            Math.max(example.now, example.created) + policy.defaults.maxAgeSeconds + policy.defaults.clockSkewSeconds);
    }
    assert.equal(policy.replayCases.find((entry) => entry.id === "global-capacity").expectedStoreOutcome, "unavailable");
    assert.equal(policy.replayCases.find((entry) => entry.id === "per-key-quota").expectedCode, "per-key-quota-exceeded");
    const ambiguous = policy.candidateCases.find((entry) => entry.id === "multiple-default-invalid");
    assert.deepEqual(ambiguous.expectedResultLabels, ["a", "b"]);
    assert.equal(ambiguous.evaluateEveryCandidate, true);
    assert.equal(ambiguous.expectedCode, "ambiguous-signatures");
    assert.equal(ambiguous.expectedConsumeCalls, 0);
    assert.equal(ambiguous.publicPreReplayVerifiedAllowed, false);
    assert.equal(policy.candidateCases.find((entry) => entry.id === "no-matching-tag")
        .expectedStatus, "unsigned");
    const contract = policy.approvedCandidateAndStoreContract;
    assert.equal(contract.defaultAmbiguous.consumeNonces, false);
    assert.equal(contract.explicitMultiple.defaultAggregate, "all");
    assert.deepEqual(contract.explicitMultiple.allowedAggregates, ["all", "any"]);
    assert.equal(contract.explicitMultiple.earlySuccess, false);
    assert.equal(contract.sharedConsumption.atomicCallsPerGroup, 1);
    assert.equal(contract.sharedConsumption.shareAcrossSeparateRequests, false);
    assert.equal(contract.quota.boundary, "whole store instance across all scopes");
    assert.deepEqual(contract.storeDecisionOrder,
        ["expire-records", "replay", "per-key-quota", "global-capacity"]);
    assert.equal(contract.internalType, "CandidateEvaluation");
    assert.deepEqual(contract.externalStates, ["unsigned", "verified", "invalid", "unverified"]);
    const classifications = new Map(policy.classificationCases.map((entry) => [entry.id, entry]));
    assert.equal(classifications.get("known-declared-algorithm-contradicts-key").expectedCode,
        "algorithm-mismatch");
    assert.equal(classifications.get("unsupported-known-algorithm-without-selected-key-contradiction")
        .expectedCode, "unsupported-algorithm");
    assert.equal(classifications.get("existing-key-binding-disagrees").expectedCode,
        "agent-binding-mismatch");
    assert.equal(classifications.get("binding-required-but-not-configured").expectedCode,
        "agent-binding-missing");
});

for (const autocrlf of ["true", "input", "false"]) {
    test(`M2 fixture bytes survive Git index/checkout with core.autocrlf=${autocrlf}`, () => {
        mkdirSync(resolve(root, ".tmp"), { recursive: true });
        const scratch = mkdtempSync(resolve(root, ".tmp/m2-eol-"));
        const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
        Object.assign(env, {
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
            GIT_ATTR_NOSYSTEM: "1",
        });
        const git = (...args) => execFileSync("git", [
            "-c", `core.autocrlf=${autocrlf}`, "-c", "core.eol=crlf",
            "-c", "core.attributesFile=", "-C", scratch, ...args,
        ], { env, maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
        try {
            git("init", "-q");
            copyFileSync(resolve(root, ".gitattributes"), resolve(scratch, ".gitattributes"));
            const all = [...manifest.files, {
                path: "manifest.json", sha256: hash(read("manifest.json")),
            }];
            for (const file of all) {
                const path = resolve(scratch, directory, file.path);
                mkdirSync(dirname(path), { recursive: true });
                copyFileSync(resolve(root, directory, file.path), path);
            }
            git("add", "--", ".gitattributes", "tests");
            for (const file of all) {
                assert.equal(hash(git("show", `:${directory}/${file.path}`)), file.sha256);
                rmSync(resolve(scratch, directory, file.path));
            }
            git("checkout-index", "--all", "--force");
            for (const file of all) {
                assert.equal(hash(readFileSync(resolve(scratch, directory, file.path))), file.sha256);
            }
        } finally {
            rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
        }
    });
}

test("approved catalog is frozen without code additions, removals, or renames", () => {
    const policy = json("policy-cases.json");
    assert.equal(policy.catalogVersion, 1);
    assert.equal(policy.status, "approved-for-implementation");
    assert.equal(hash(Buffer.from(JSON.stringify(policy.codeCatalog))),
        "3f1ef66e027528802f3552627e87dcdde5b0124c5b78b511fadc73e14d1f7691");
    const boundary = json("boundary-cases.json");
    for (const [group, count] of Object.entries(boundary.catalogCounts)) {
        assert.equal(policy.codeCatalog[group].length, count, group);
    }
});

test("pre-implementation clock and resource boundary expectations are consistent", () => {
    const boundary = json("boundary-cases.json");
    assert.equal(boundary.limits.allConfigurable, true);
    assert.equal(boundary.limits.defaultsMustBeNamedAndFrozen, true);
    for (const example of boundary.limitCases) {
        const maximum = boundary.limits[example.limit];
        assert(Number.isSafeInteger(maximum));
        assert.equal(example.observed <= maximum, example.withinLimit, example.limit);
    }
    for (const example of boundary.nonceCases) {
        const valid = example.value.length >= 1 &&
            example.value.length <= boundary.limits.maxNonceBytes &&
            !/[^\x20-\x7e]/.test(example.value);
        assert.equal(valid, example.validSyntax, example.id);
    }

    const clock = boundary.clockContract;
    assert.equal(clock.maxClockDriftSeconds, 30);
    assert.equal(clock.driftThresholdIndependentOfSignatureSkew, true);
    assert.equal(clock.automaticRebase, false);
    for (const example of boundary.clockCases) {
        const effectiveMs = example.referenceWallMs +
            example.monotonicMs - example.referenceMonotonicMs;
        const regression = example.monotonicMs <
            (example.previousMonotonicMs ?? example.referenceMonotonicMs);
        const healthy = !regression &&
            Math.abs(example.wallMs - effectiveMs) <= clock.maxClockDriftSeconds * 1000;
        assert.equal(healthy, example.healthy, example.id);
        if (healthy) {
            assert.equal(Math.floor(effectiveMs / 1000), example.effectiveEpochSeconds);
        } else {
            assert.equal(example.expectedCode, "clock-unavailable");
        }
    }
    const reset = clock.operatorReset;
    assert.equal(reset.apiName, "resetClockReference");
    assert.equal(reset.automatic, false);
    assert.equal(reset.clearInMemoryReplayEntries, true);
    assert.equal(reset.clearPerKeyQuotaCounters, true);
    assert.equal(reset.oldEpochMayReturnVerified, false);
    assert.equal(reset.oldEpochExpectedCode, "clock-unavailable");
    assert.equal(reset.replayProtectionDiscontinuity, true);
    assert.equal(reset.emitExplicitResetEvent, true);
    // These assertions validate expectation data, not a working clock or store.
});

test("known-test-key boundary fixtures match independently computed thumbprints", () => {
    const boundary = json("boundary-cases.json");
    assert.equal(boundary.testKeys.length, 2);
    for (const example of boundary.testKeys) {
        const jwk = createPublicKey(read(example.publicKeyFile)).export({ format: "jwk" });
        const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
        assert.equal(createHash("sha256").update(canonical).digest("base64url"),
            example.thumbprint);
        assert.equal(example.defaultExpectedCode, "test-key-disallowed");
        assert.equal(example.explicitTestPermissionAllowsKeySelection, true);
    }
    for (const example of boundary.discoveryCases) {
        if (!example.supported) {
            assert.equal(example.expectedCode, "unsupported-discovery-type");
        }
    }
});