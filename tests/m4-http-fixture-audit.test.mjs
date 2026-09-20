import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Independent data audit. Never import the mapper, frameworks or retained upstream code.
const root = new URL("./fixtures/m4-http/", import.meta.url);
const read = path => readFileSync(new URL(path, root));
const json = path => JSON.parse(read(path));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const manifest = json("manifest.json");
const contract = json("contract.json");
const cases = json("mapping-cases.json");
const frameworks = json("frameworks.json");
const codes = [
    "capture-missing", "capture-incomplete", "http2-unsupported",
    "request-unsupported", "request-malformed", "headers-malformed",
    "host-missing", "host-ambiguous", "ingress-peer-untrusted",
    "ingress-https-required", "forwarding-missing", "forwarding-malformed",
    "forwarding-chain-rejected", "forwarding-families-mixed",
    "forwarding-port-inconsistent", "origin-disallowed", "resource-limit",
];
const inputFor = entry => ({
    ...cases.defaults, ...entry.input,
    ingress: cases.ingressPolicies[entry.policy ?? "direct"],
});
const valueBytes = value => typeof value === "string"
    ? Buffer.from(value, "ascii") : Buffer.from(value.bytesHex, "hex");

test("M4 mapping manifest pins independent expectations and their source baseline", () => {
    assert.equal(hash(read("manifest.json")),
        "2f06312e8c4c5b99935a6cb6add0ea37cb73aa44acdd90656e191844424a1ef2");
    assert.deepEqual(readdirSync(root).sort(),
        ["manifest.json", ...manifest.files.map(file => file.path)].sort());
    for (const file of manifest.files) {
        const bytes = read(file.path);
        assert.equal(bytes.length, file.bytes, file.path);
        assert.equal(hash(bytes), file.sha256, file.path);
    }
    for (const source of manifest.sources) assert.equal(hash(read(source.path)), source.sha256);
    assert.equal(cases.positive.length, 20);
    assert.equal(cases.negative.length, 58);
    const ids = [...cases.positive, ...cases.negative, ...cases.largeCases, ...cases.parserCases]
        .map(entry => entry.id);
    assert.equal(new Set(ids).size, ids.length);
});

test("the separately approved 17-code mapping catalog is closed and fully represented", () => {
    assert.equal(contract.catalog.version, 1);
    assert.deepEqual(contract.catalog.codes, codes);
    assert.equal(contract.catalog.sharedTypeWithVerificationSigningOrOperatorCatalog, false);
    assert.deepEqual([...new Set(cases.negative.map(entry => entry.code))].sort(), [...codes].sort());
});

for (const entry of cases.positive) {
    test(`literal wire bytes match independent HeaderFields and RequestParts: ${entry.id}`, () => {
        const input = inputFor(entry);
        const expected = entry.expected;
        const [head] = entry.wireLatin1.split("\r\n\r\n");
        const lines = head.split("\r\n");
        assert.equal(lines.shift(), `${input.method} ${input.url} HTTP/1.1`);
        const fields = lines.map(line => {
            const colon = line.indexOf(":");
            assert(colon > 0);
            assert.equal(line[colon + 1], " ");
            return [line.slice(0, colon), line.slice(colon + 2)];
        });
        assert.deepEqual(fields.flat(), input.rawHeaders);
        assert.equal(expected.status, "mapped");
        assert.equal(expected.request.method, input.method);
        assert.equal(expected.request.rawRequestTarget, input.url);
        assert.equal(expected.request.httpVersion, "1.1");
        assert.equal(expected.request.headers.length, fields.length);
        for (let index = 0; index < fields.length; index++) {
            const [name, value] = fields[index];
            const [expectedName, expectedValue] = expected.request.headers[index];
            assert.equal(name, expectedName);
            assert.deepEqual(Buffer.from(value, "latin1"), valueBytes(expectedValue));
            assert.equal(typeof expectedValue === "string", !/[^\x00-\x7f]/.test(value));
        }
        // Lexical decomposition, not WHATWG path/query serialization.
        const target = /^(https?):\/\/([^/]+)(\/.*)$/.exec(expected.request.targetUri);
        assert(target);
        assert.equal(target[3], input.url);
        assert.equal(expected.internalAuthority, fields.find(([name]) => name.toLowerCase() === "host")[1]);
        assert.equal(expected.targetSource, input.ingress.mode === "direct" ? "direct" : "trusted-ingress");
        if (input.ingress.mode === "direct") {
            assert.equal(target[1], input.encrypted ? "https" : "http");
            assert.equal(target[2], expected.internalAuthority);
            assert.equal(Object.hasOwn(expected, "observedClient"), false);
        } else {
            assert.equal(target[1], "https");
        }
        if (expected.observedClient) {
            assert.equal(expected.observedClient.source, "trusted-ingress");
            assert.equal(expected.observedClient.authenticated, false);
            assert(contract.observedClient.kinds.includes(expected.observedClient.kind));
        }
    });
}

test("all three framework descriptors consume the same immutable expected outputs", () => {
    assert.equal(frameworks.sharedCases, "mapping-cases.json");
    assert.deepEqual(frameworks.frameworks.map(item => item.adapter), ["express", "fastify", "hono"]);
    for (const item of frameworks.frameworks) {
        assert(item.captureBoundary.includes("before"));
        assert(item.forbiddenFallback.length > 0);
        assert.equal(Object.hasOwn(item, "expectedOverrides"), false);
    }
    assert.deepEqual(frameworks.frameworks[0].versions, ["4.22.3", "5.2.1"]);
});

test("mapping rejection, observation and enforcement never fabricate authentication", () => {
    assert.equal(contract.mappingFailure.verifierCalls, 0);
    assert.equal(contract.mappingFailure.discoveryCalls, 0);
    assert.equal(contract.mappingFailure.replayConsumes, 0);
    assert.equal(contract.mappingFailure.defaultResponseStatus, 400);
    assert.equal(contract.policy.defaultDenyStatusAfterSuccessfulMapping, 401);
    assert.equal(contract.mappingFailure.responseBodyIncludesReason, false);
    assert.deepEqual(contract.mappingFailure.observerFields, ["code", "adapter", "ingress"]);
    for (const entry of frameworks.failureModes) {
        assert.equal(entry.verifierCalls, 0);
        assert.equal(entry.observerCalls, 1);
        if (entry.mode === "observe") {
            assert.equal(entry.downstreamCalls, 1);
            assert.equal(entry.authorization, "not-evaluated");
            assert.equal(entry.responseStatus, null);
        } else {
            assert.equal(entry.downstreamCalls, 0);
            assert.equal(entry.responseStatus, entry.policy === "rate-limit" ? 429 : 400);
        }
    }
});

test("late Host occurrence fits the byte budget and must not be hidden by a count limit", () => {
    const { recipe, expected } = cases.largeCases[0];
    const fields = [recipe.first, ...Array.from({ length: recipe.count }, () => recipe.repeat), recipe.last];
    const bytes = fields.reduce((sum, [name, value]) => sum + name.length + value.length + 4, 0);
    assert(bytes < 16_384);
    assert(fields.length > 2_000);
    assert.equal(expected.code, "host-ambiguous");
});

test("parser rejections remain separate from mapper results and observers", () => {
    assert.equal(contract.parserRejection.adapterClaimsToObserve, false);
    for (const entry of cases.parserCases) {
        assert.equal(entry.captureCalls, 0);
        assert.equal(entry.expectedDefaultStatus, 400);
        assert.equal(Object.hasOwn(entry, "code"), false);
    }
    const source = read("../m4-sources/node-v22.23.2/lib/_http_server.js").toString("utf8");
    assert.match(source, /this\.server\.emit\('clientError', e, this\)/);
    assert.match(source, /case 'HPE_HEADER_OVERFLOW':/);
});

for (const autocrlf of ["false", "true", "input"]) {
    test(`mapping fixture bytes survive Git staging and checkout: ${autocrlf}`, () => {
        const directory = mkdtempSync(join(tmpdir(), "agentsig-m4-http-"));
        const git = (...args) => execFileSync("git", args, {
            cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
        });
        try {
            cpSync(new URL("../.gitattributes", import.meta.url), join(directory, ".gitattributes"));
            const relative = "tests/fixtures/m4-http";
            cpSync(root, join(directory, relative), { recursive: true });
            git("init", "--quiet");
            git("config", "core.autocrlf", autocrlf);
            git("add", ".");
            for (const name of readdirSync(root)) {
                const staged = execFileSync("git", ["show", `:${relative}/${name}`], { cwd: directory });
                assert(staged.equals(read(name)), `Staged fixture bytes differ: ${name}`);
            }
            rmSync(join(directory, relative), { recursive: true });
            git("checkout-index", "--all", "--force");
            for (const name of readdirSync(root)) {
                assert(readFileSync(join(directory, relative, name)).equals(read(name)),
                    `Checked-out fixture bytes differ: ${name}`);
            }
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });
}