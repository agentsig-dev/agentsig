import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { BlockList, isIP } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// Independent contract audit; no production transport or importer imports.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = resolve(root, "tests/fixtures/m3-transport");
const read = (path) => readFileSync(resolve(directory, path));
const contract = JSON.parse(read("contract.json"));
const manifest = JSON.parse(read("manifest.json"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const exclusions = { ipv4: new BlockList(), ipv6: new BlockList() };
const records = new Map();
for (const family of ["ipv4", "ipv6"]) {
    const xml = readFileSync(resolve(root,
        `tests/fixtures/m3-address/sources/iana-${family}-special-registry.xml`), "utf8");
    // Extraction is limited to these hash-pinned documents, not arbitrary XML.
    for (const [, record] of xml.matchAll(/<record(?:\s[^>]*)?>([\s\S]*?)<\/record>/g)) {
        const field = record.match(/<address>([\s\S]*?)<\/address>/)?.[1];
        assert(field);
        const global = record.match(/<global>([\s\S]*?)<\/global>/)?.[1].trim();
        for (const prefix of field.replace(/<[^>]*>/g, "").trim().split(/\s*,\s*/)) {
            const [ip, bits] = prefix.split("/");
            exclusions[family].addSubnet(ip, Number(bits), family);
            records.set(prefix, { family, global });
        }
    }
}
exclusions.ipv4.addSubnet("224.0.0.0", 4, "ipv4");
const envelope = new BlockList();
envelope.addSubnet("2000::", 3, "ipv6");

test("transport manifest pins authored expectations and unchanged source references", () => {
    assert.equal(manifest.productionImplementationExists, false);
    assert.deepEqual(readdirSync(directory).sort(), ["contract.json", "manifest.json"]);
    assert.equal(manifest.files.length, 1);
    for (const file of manifest.files) {
        assert.equal(file.path, "contract.json");
        const bytes = read(file.path);
        assert.equal(bytes.length, file.bytes);
        assert.equal(hash(bytes), file.sha256);
    }
    for (const source of manifest.sources) {
        assert.equal(hash(readFileSync(resolve(root, source.path))), source.sha256, source.path);
    }
});

test("named exceptions are exact globally reachable non-transition registry entries", () => {
    assert.equal(contract.exceptions.catalog.length, 13);
    const ids = contract.exceptions.catalog.map((entry) => entry.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const entry of contract.exceptions.catalog) {
        const record = records.get(entry.prefix);
        assert(record, entry.prefix);
        assert.equal(record.global, "True", entry.prefix);
        assert(!["64:ff9b::/96", "2001::/32", "2002::/16",
            "::ffff:0:0/96"].includes(entry.prefix));
    }
    assert.deepEqual(contract.exceptions.default, []);
    assert.equal(contract.exceptions.originLiteralRestrictionUnchanged, true);
    assert.equal(contract.exceptions.mixedAnswerRuleUnchanged, true);
});

for (const row of contract.exceptions.cases) {
    test(`explicit exception expectation: ${row.address} / ${row.enabled.join(",")}`, () => {
        const number = isIP(row.address);
        assert(number === 4 || number === 6);
        const family = number === 4 ? "ipv4" : "ipv6";
        const enabled = new BlockList();
        for (const id of row.enabled) {
            const entry = contract.exceptions.catalog.find((item) => item.id === id);
            assert(entry, id);
            const [ip, bits] = entry.prefix.split("/");
            const record = records.get(entry.prefix);
            if (record.family === family) enabled.addSubnet(ip, Number(bits), family);
        }
        const baseline = (number === 4 || envelope.check(row.address, family)) &&
            !exclusions[family].check(row.address, family);
        assert.equal(baseline || enabled.check(row.address, family), row.allowed);
    });
}

test("arbitrary CIDRs, unknown exception names and duplicate declarations are invalid", () => {
    const names = new Set(contract.exceptions.catalog.map((entry) => entry.id));
    for (const input of contract.exceptions.invalidConfiguration) {
        assert(input.some((name) => !names.has(name)) || new Set(input).size !== input.length);
    }
});

test("proxy and direct contracts preserve numeric target pins and original TLS identity", () => {
    assert.equal(contract.directTransport.destinationPort, 443);
    assert.equal(contract.directTransport.tlsVerificationDisableOption, false);
    assert.equal(contract.directTransport.redirectFollowups, 0);
    assert.equal(contract.directTransport.acceptEncoding, "identity");
    assert.equal(contract.proxyTransport.connectAuthorityV4, "1.1.1.1:443");
    assert.equal(contract.proxyTransport.connectAuthorityV6, "[2606:4700:4700::1111]:443");
    for (const id of ["proxy-private-target", "proxy-mixed-target-answers"]) {
        const row = contract.transportCases.find((entry) => entry.id === id);
        assert.equal(row.proxyConnections, 0);
        assert.equal(row.accepted, false);
    }
    const mismatch = contract.transportCases.find((entry) => entry.id === "direct-peer-mismatch");
    assert.equal(mismatch.requestBytesSent, 0);
    assert.equal(mismatch.accepted, false);
    assert.match(contract.proxyTransport.trustedProxyBoundary, /cannot observe/);
    assert.match(contract.testBoundary, /not an exported private-address override/);
});