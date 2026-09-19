import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Offline source import only. No production classifier or network access.
// Preserve registry bytes, including source whitespace. Never regenerate
// expected admission outcomes from the production implementation.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = resolve(root, "tests/fixtures/m3-address");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pins = [
    {
        family: "ipv4",
        sha256: "cf24e11f41b7d42c68debe2d18b97cac815084ec413ebb3b244f704028a16f20",
        retrievedAt: "2026-09-19T17:31:34.618Z",
    },
    {
        family: "ipv6",
        sha256: "c17f4380ba84fb2160dae82ebfd8bd155a5853cfab624ed3a9fd251638a8be02",
        retrievedAt: "2026-09-19T17:31:35.058Z",
    },
];
const files = [];
function put(path, bytes, provenance) {
    const output = resolve(destination, path);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, bytes);
    files.push({ path, bytes: bytes.length, sha256: hash(bytes), provenance });
}
for (const pin of pins) {
    const name = `iana-${pin.family}-special-registry`;
    const bytes = readFileSync(resolve(root, `.tmp/m3-address-research/${name}.xml`));
    assert.equal(hash(bytes), pin.sha256, name);
    put(`sources/${name}.xml`, bytes, {
        url: `https://www.iana.org/assignments/${name}/${name}.xml`,
        retrievedAt: pin.retrievedAt,
        registryUpdated: "2025-10-09",
        attribution: "Internet Assigned Numbers Authority (IANA)",
        transformation: "none",
        rights: "Original IANA registry data; not relicensed as agentsig MIT code",
    });
}
const casesPath = resolve(destination, "address-cases.json");
const casesBytes = Buffer.from(readFileSync(casesPath, "utf8").replace(/\r\n/g, "\n"));
const cases = JSON.parse(casesBytes);
assert.equal(cases.formatVersion, 1);
assert.equal(cases.status, "pre-implementation-expectations");
assert(cases.cases.length > 0);
assert.equal(new Set(cases.cases.map((entry) => entry.address)).size, cases.cases.length);
for (const entry of cases.cases) {
    assert.equal(typeof entry.address, "string");
    assert.equal(typeof entry.allowed, "boolean");
}
put("address-cases.json", casesBytes, {
    attribution: "agentsig independently authored local-policy expectations",
    license: "MIT",
    transformation: "Local editor CRLF converted to LF; no outcome changes",
});
writeFileSync(resolve(destination, "manifest.json"), JSON.stringify({
    formatVersion: 1,
    authoredOn: "2026-09-19",
    productionImplementationExists: false,
    warning: "Registry classification is not proof of reachability or safety under local routing.",
    policy: "Reject all pinned special-purpose prefixes, including globally reachable exceptions; reject IPv4 multicast; admit IPv6 only within 2000::/3 after exclusions.",
    sourceScope: "Special-purpose registries, not a complete allocation or route inventory",
    files,
}, null, 2) + "\n");
console.log(`M3 addresses: ${cases.cases.length} independent cases and two exact IANA snapshots pinned.`);