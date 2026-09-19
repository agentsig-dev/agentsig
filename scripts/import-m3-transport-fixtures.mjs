import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Offline fixture registration only. No production imports, network requests,
// or generation of expected outcomes from a transport implementation.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = resolve(root, "tests/fixtures/m3-transport");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sourcePins = [
    {
        path: "tests/fixtures/m3-address/sources/iana-ipv4-special-registry.xml",
        sha256: "cf24e11f41b7d42c68debe2d18b97cac815084ec413ebb3b244f704028a16f20",
    },
    {
        path: "tests/fixtures/m3-address/sources/iana-ipv6-special-registry.xml",
        sha256: "c17f4380ba84fb2160dae82ebfd8bd155a5853cfab624ed3a9fd251638a8be02",
    },
];
for (const pin of sourcePins) {
    assert.equal(hash(readFileSync(resolve(root, pin.path))), pin.sha256, pin.path);
}
const oldManifest = JSON.parse(readFileSync(
    resolve(root, "tests/fixtures/m3-contract/manifest.json"), "utf8",
));
const oldEntry = oldManifest.files.find((entry) => entry.path === "fetch-cache-cases.json");
assert(oldEntry);
const contractSource = "tests/fixtures/m3-contract/fetch-cache-cases.json";
assert.equal(hash(readFileSync(resolve(root, contractSource))), oldEntry.sha256);
sourcePins.push({ path: contractSource, sha256: oldEntry.sha256 });

const path = "contract.json";
const bytes = Buffer.from(readFileSync(resolve(destination, path), "utf8").replace(/\r\n/g, "\n"));
const contract = JSON.parse(bytes);
assert.equal(contract.formatVersion, 1);
assert.equal(contract.status, "pre-implementation-expectations");
assert.equal(new Set(contract.exceptions.catalog.map((entry) => entry.id)).size,
    contract.exceptions.catalog.length);
assert.deepEqual(contract.sources, sourcePins.map((pin) => pin.path));
// Normalize editor EOLs for our authored text only. Never rewrite upstream XML.
writeFileSync(resolve(destination, path), bytes);
writeFileSync(resolve(destination, "manifest.json"), JSON.stringify({
    formatVersion: 1,
    authoredOn: "2026-09-19",
    productionImplementationExists: false,
    scope: "Explicit named address exceptions and pinned HTTPS/proxy transport expectations",
    compatibility: "Default admission remains unchanged; exceptions do not permit private or transition destinations",
    files: [{
        path,
        bytes: bytes.length,
        sha256: hash(bytes),
        provenance: "Independently authored before implementation following explicit maintainer approval",
        license: "MIT",
    }],
    sources: sourcePins,
}, null, 2) + "\n");
console.log("M3 transport contract pinned; all referenced source hashes verified.");