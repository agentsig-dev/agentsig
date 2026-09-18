import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = resolve(root, "tests/fixtures/profiles");
const read = (path) => readFileSync(resolve(directory, path));
const json = (path) => JSON.parse(read(path).toString("utf8"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const manifest = json("manifest.json");

test("component restrictions distinguish local scope from pinned Cloudflare limitations", () => {
    const matrix = json("component-restrictions.json");
    assert.equal(matrix.cases.length, 24);
    assert.equal(new Set(matrix.cases.map((entry) => entry.id)).size, 24);
    const reference = matrix.sources.cloudflare;
    const source = readFileSync(resolve(root, reference.path));
    assert.equal(hash(source), reference.sha256);
    assert.equal(reference.sha256,
        "c4aeeef723df97b020ecc4d9e680b77b5bfb6c214a6443b0fb7f00efd7e422f7");
    const text = source.toString("utf8");
    const section = text.slice(text.indexOf("## Limitations"), text.indexOf("## Troubleshooting"));
    for (const name of ["@query-params", "@status", "sf", "bs", "key", "req", "name", "@query-param"]) {
        assert(section.includes("`" + name + "`"), name);
    }
    let local = 0;
    let cloudflare = 0;
    for (const entry of matrix.cases) {
        assert.equal(entry.expected.status, "unverified");
        assert.equal(entry.expected.code, "unsupported-profile");
        const diagnostic = entry.expected.diagnostic;
        assert.equal(diagnostic.kind, "component");
        assert.equal(diagnostic.profile, entry.profile);
        assert(entry.component.startsWith('"' + diagnostic.component + '"'));
        if (diagnostic.source === "agentsig-m2-local-countersignature-limit") {
            local++;
            assert(["signature", "signature-input"].includes(diagnostic.component));
        } else {
            cloudflare++;
            assert.equal(diagnostic.source, "cloudflare-docs-2026-07-01-limitations");
            assert.equal(entry.profile, "cloudflare-docs-2026-07-01");
            if (diagnostic.parameter) assert(entry.component.includes(";" + diagnostic.parameter));
        }
    }
    assert.equal(local, 16);
    assert.equal(cloudflare, 8);
    assert.deepEqual(matrix.unknownProfileCase.expected, {
        status: "unverified", code: "unsupported-profile",
        diagnostic: {
            kind: "profile", profile: "future-profile", source: "agentsig-m2-profile-set",
        },
    });
});

test("rejected candidates remain counted and reported under every aggregate policy", () => {
    const matrix = json("rejected-candidate-counting.json");
    assert.equal(matrix.cases.length, 6);
    assert.equal(new Set(matrix.cases.map((entry) => entry.id)).size, 6);
    for (const entry of matrix.cases) {
        assert.equal(entry.candidates.filter((item) => item.tag === "web-bot-auth").length, 2);
        assert.equal(entry.candidates[0].covers, '"signature";key="inner"');
        assert.equal(entry.expected.selectedCount, 2);
        assert.deepEqual(entry.expected.evaluatedLabels, ["outer", "inner"]);
        assert.deepEqual(entry.expected.outer, {
            status: "unverified", code: "unsupported-profile",
        });
        assert.equal(entry.expected.topLevelVerified, entry.policy === "any");
        if (entry.policy === "exactly-one") {
            assert.equal(entry.expected.topLevelStatus, "invalid");
            assert.equal(entry.expected.topLevelCode, "ambiguous-signatures");
            assert.equal(entry.expected.consumeCalls, 0);
            assert.deepEqual(entry.expected.inner, {
                status: "invalid", code: "ambiguous-signatures",
            });
        } else {
            assert(["all", "any"].includes(entry.policy));
            assert.deepEqual(entry.expected.inner, {
                status: "verified", code: "nonce-consumed",
            });
            assert.equal(entry.prerequisites.length, 2);
        }
    }
    // These are authored expectations, not an aggregate verifier implementation.
    const catalog = JSON.parse(readFileSync(resolve(root,
        "tests/fixtures/m2/policy-cases.json"), "utf8")).codeCatalog;
    for (const entry of matrix.cases) {
        for (const result of [entry.expected.outer, entry.expected.inner]) {
            assert(catalog[result.status].includes(result.code));
        }
    }
});

test("required coverage expectations distinguish profiles and retain the approved minimum", () => {
    const matrix = json("coverage-cases.json");
    assert.equal(matrix.stage, "required-component-coverage-only");
    assert.equal(matrix.cases.length, 18);
    assert.equal(new Set(matrix.cases.map((entry) => entry.id)).size, 18);
    const positiveNames = ["required-components", "additional-authority", "different-order"];
    const negativeNames = [
        "missing-method", "missing-target-uri", "missing-agent",
        "authority-does-not-replace-target", "other-profile-agent-component",
        "wrong-agent-member",
    ];
    for (const profile of ["ietf-wg-protocol-00", "cloudflare-docs-2026-07-01"]) {
        const entries = matrix.cases.filter((entry) => entry.profile === profile);
        assert.equal(entries.length, 9);
        assert.deepEqual(entries.map((entry) => entry.id).sort(),
            [...positiveNames, ...negativeNames].map((name) => `${profile}-${name}`).sort());
        const agent = profile === "ietf-wg-protocol-00"
            ? '"signature-agent";key="agent"' : '"signature-agent"';
        for (const entry of entries) {
            assert.equal(entry.label, "agent");
            const complete = ['"@method"', '"@target-uri"', agent]
                .every((component) => entry.components.includes(component));
            const authoredPositive = positiveNames.some((name) => entry.id === `${profile}-${name}`);
            assert.equal(complete, authoredPositive, entry.id);
            assert.deepEqual(entry.expected, authoredPositive
                ? { sufficient: true }
                : { sufficient: false, status: "invalid", code: "insufficient-coverage" },
                entry.id);
        }
    }
    const policy = JSON.parse(readFileSync(resolve(root,
        "tests/fixtures/m2/policy-cases.json"), "utf8"));
    assert.deepEqual(policy.defaults.requiredComponents, [
        "@method", "@target-uri", "profile-specific-agent-component",
    ]);
    assert(policy.codeCatalog.invalid.includes("insufficient-coverage"));
});

test("profile manifest covers exact source and expectation bytes", () => {
    const paths = [];
    function walk(relative = "") {
        for (const entry of readdirSync(resolve(directory, relative), { withFileTypes: true })) {
            const path = relative ? `${relative}/${entry.name}` : entry.name;
            if (entry.isDirectory()) walk(path);
            else paths.push(path);
        }
    }
    walk();
    assert.equal(manifest.files.length, 10);
    assert.deepEqual(paths.filter((path) => path !== "manifest.json").sort(),
        manifest.files.map((entry) => entry.path).sort());
    assert.equal(new Set(manifest.files.map((entry) => entry.path)).size, 10);
    for (const entry of manifest.files) {
        assert(!entry.path.includes(".."));
        const bytes = read(entry.path);
        assert.equal(bytes.length, entry.bytes, entry.path);
        assert.equal(hash(bytes), entry.sha256, entry.path);
        assert(!bytes.includes(13), entry.path);
    }
});

test("RFC excerpts preserve source wording and distinguish the two repetition rules", () => {
    for (const entry of manifest.files.filter((item) => item.path.startsWith("sources/"))) {
        const source = readFileSync(resolve(root, entry.source.path));
        assert.equal(hash(source), entry.source.sha256);
        const text = source.toString("utf8");
        const excerpt = read(entry.path).toString("utf8");
        assert(text.includes(excerpt), entry.path);
        assert(excerpt.startsWith(entry.source.start), entry.path);
        assert(text.includes(excerpt + "\n" + entry.source.endExclusive), entry.path);
    }
    const base = read("sources/rfc9421-2.5.txt").toString("utf8").replace(/\s+/g, " ");
    assert(base.includes("If the component identifier (including its parameters) has already been added to the signature base, produce an error."));
    for (const name of ["dictionary", "parameters"]) {
        const text = read(`sources/rfc9651-${name}.txt`).toString("utf8").replace(/\s+/g, " ");
        assert(text.includes("last instance are ignored."));
    }
    // Source inspection is not proof of an absent requirement anywhere in RFCs.
    // The local policy rationale is explicitly scoped to the reviewed sections.
});

test("origin expectations bind alternate spellings to one identity", () => {
    const matrix = json("origin-cases.json");
    assert.equal(matrix.cases.length, 26);
    assert.equal(new Set(matrix.cases.map((entry) => entry.id)).size, 26);
    const accepted = matrix.cases.filter((entry) => entry.canonicalOrigin);
    assert.equal(accepted.length, 6);
    for (const entry of accepted) {
        assert.equal(entry.canonicalOrigin, "https://agent.example");
        // Independent corroboration of accepted spellings only. WHATWG URL is
        // deliberately NOT an oracle for strict rejection: it repairs inputs.
        assert.equal(new URL(entry.value).origin, entry.canonicalOrigin);
    }
    const rejected = matrix.cases.filter((entry) => !entry.canonicalOrigin);
    assert.equal(rejected.length, 20);
    for (const entry of rejected) {
        assert.equal(entry.requestCode, "malformed-agent");
        assert.equal(entry.configurationCode, "invalid-agent-binding");
    }
    for (const id of ["ipv4", "ipv6", "unicode-host", "other-port", "empty-host",
        "dot-path", "empty-query", "empty-fragment", "userinfo", "backslash"]) {
        assert(rejected.some((entry) => entry.id === id), id);
    }
});

test("duplicate fixtures pin raw occurrences and diagnostic names without a production parser", () => {
    const matrix = json("duplicate-cases.json");
    assert.equal(matrix.cases.length, 9);
    assert.equal(new Set(matrix.cases.map((entry) => entry.id)).size, 9);
    for (const entry of matrix.cases) {
        const headers = new Map(entry.headers);
        const { repeatedName, code, status } = entry.expected;
        assert.equal(status, "invalid");
        if (code === "malformed-agent") {
            assert.equal(repeatedName, "agent");
            const text = headers.get("signature-agent");
            assert.equal(text.split('agent="').length - 1, 2);
        } else {
            assert.equal(code, "malformed-signature");
            const text = headers.get("signature-input");
            assert.equal(text.split(`;${repeatedName}=`).length - 1, 2);
        }
    }
    assert(matrix.cases.some((entry) => entry.id === "signature-tag-identical"));
    assert(matrix.cases.some((entry) => entry.id === "component-identical-key"));
    assert(matrix.cases.some((entry) => entry.id === "agent-identical-member"));
});

test("local binding expectations never infer domain trust from manual JWKS alone", () => {
    const matrix = json("binding-cases.json");
    assert.equal(matrix.cases.length, 9);
    const plain = matrix.cases.find((entry) => entry.id === "manual-jwks-no-domain-trust");
    assert.equal(plain.expected.identityKind, "key-thumbprint");
    assert(!Object.hasOwn(plain.expected, "directoryUrl"));
    for (const entry of matrix.cases.filter((item) => item.expected.identityKind === "directory-url")) {
        assert.equal(new URL(entry.claim).origin, entry.expected.canonicalOrigin);
        assert.equal(new URL(entry.bindings[0].origin).origin, entry.expected.canonicalOrigin);
        assert.equal(entry.expected.directoryUrl,
            "https://agent.example/.well-known/http-message-signatures-directory");
        assert.equal(entry.expected.trustSource, "local-configuration");
    }
    assert.deepEqual(matrix.cases.find((entry) => entry.id === "required-binding-missing").expected,
        { status: "unverified", code: "agent-binding-missing" });
    assert.deepEqual(matrix.cases.find((entry) => entry.id === "existing-binding-mismatch").expected,
        { status: "invalid", code: "agent-binding-mismatch" });
    const catalog = JSON.parse(readFileSync(resolve(root, "tests/fixtures/m2/policy-cases.json"), "utf8"))
        .codeCatalog;
    for (const entry of matrix.cases.filter((item) => item.expected.code)) {
        assert(catalog[entry.expected.status].includes(entry.expected.code));
    }
});