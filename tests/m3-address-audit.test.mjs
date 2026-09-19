import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { BlockList, isIP } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// Independent source/expectation audit. No production classifier or importer
// imports. Node BlockList supplies CIDR comparisons independently of agentsig.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = resolve(root, "tests/fixtures/m3-address");
const read = (path) => readFileSync(resolve(directory, path));
const json = (path) => JSON.parse(read(path));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const manifest = json("manifest.json");
const expectations = json("address-cases.json");
const sources = [
    ["ipv4", "cf24e11f41b7d42c68debe2d18b97cac815084ec413ebb3b244f704028a16f20"],
    ["ipv6", "c17f4380ba84fb2160dae82ebfd8bd155a5853cfab624ed3a9fd251638a8be02"],
];
const exclusions = { ipv4: new BlockList(), ipv6: new BlockList() };
// Node BlockList matches IPv4 against IPv4-mapped IPv6 ranges. Keep address
// families separate: rejecting mapped DNS answers must not reject native IPv4.
const specialRecords = [];
for (const [family, expectedHash] of sources) {
    const bytes = read(`sources/iana-${family}-special-registry.xml`);
    assert.equal(hash(bytes), expectedHash);
    const xml = bytes.toString("utf8");
    // This extracts the known, hash-pinned IANA document shape only. It is not
    // a general XML parser and never processes runtime network input.
    const records = [...xml.matchAll(/<record(?:\s[^>]*)?>([\s\S]*?)<\/record>/g)];
    assert(records.length > 0);
    for (const [, record] of records) {
        const address = record.match(/<address>([\s\S]*?)<\/address>/)?.[1];
        assert(address);
        const prefixes = address.replace(/<[^>]*>/g, "").trim().split(/\s*,\s*/);
        for (const prefix of prefixes) {
            const [ip, length] = prefix.split("/");
            assert.equal(isIP(ip), family === "ipv4" ? 4 : 6);
            assert(/^\d+$/.test(length));
            exclusions[family].addSubnet(ip, Number(length), family);
            specialRecords.push({ prefix, family });
        }
    }
}
exclusions.ipv4.addSubnet("224.0.0.0", 4, "ipv4");
const envelope = new BlockList();
envelope.addSubnet("2000::", 3, "ipv6");

test("address manifest pins the complete independent dataset and exact IANA bytes", () => {
    const actual = [];
    function walk(path = "") {
        for (const entry of readdirSync(resolve(directory, path), { withFileTypes: true })) {
            const next = path ? `${path}/${entry.name}` : entry.name;
            if (entry.isDirectory()) walk(next);
            else actual.push(next);
        }
    }
    walk();
    assert.equal(manifest.productionImplementationExists, false);
    assert.equal(manifest.files.length, 3);
    assert.deepEqual(actual.filter((path) => path !== "manifest.json").sort(),
        manifest.files.map((entry) => entry.path).sort());
    for (const entry of manifest.files) {
        assert(!entry.path.includes("..") && !entry.path.startsWith("/"));
        const bytes = read(entry.path);
        assert.equal(bytes.length, entry.bytes, entry.path);
        assert.equal(hash(bytes), entry.sha256, entry.path);
    }
    assert.equal(expectations.cases.length, 92);
    assert.equal(new Set(expectations.cases.map((entry) => entry.address)).size, 92);
});

test("local exclusions intentionally include globally reachable special-purpose exceptions", () => {
    for (const [family] of sources) {
        const xml = read(`sources/iana-${family}-special-registry.xml`).toString("utf8");
        assert.match(xml, /<updated>2025-10-09<\/updated>/);
        assert.match(xml, /<global>True<\/global>/);
        assert.match(xml, /not guaranteed routability/);
    }
    assert(specialRecords.some((entry) => entry.prefix === "192.0.0.9/32"));
    assert(specialRecords.some((entry) => entry.prefix === "2001:1::1/128"));
    assert(exclusions.ipv4.check("192.0.0.9", "ipv4"));
    assert(exclusions.ipv6.check("2001:1::1", "ipv6"));
});

for (const entry of expectations.cases) {
    test(`independent address expectation: ${JSON.stringify(entry.address)}`, () => {
        const familyNumber = isIP(entry.address);
        const strict = familyNumber !== 0 &&
            !/[\s%/[\]]/.test(entry.address);
        let admitted = false;
        if (strict) {
            const family = familyNumber === 4 ? "ipv4" : "ipv6";
            admitted = (familyNumber === 4 || envelope.check(entry.address, "ipv6")) &&
                !exclusions[family].check(entry.address, family);
        }
        assert.equal(admitted, entry.allowed, entry.reason ?? entry.address);
    });
}