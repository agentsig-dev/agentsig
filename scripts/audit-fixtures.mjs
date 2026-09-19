// scripts/audit-fixtures.mjs
// Verify RFC 9421 B.2.6 fixtures independently of the engine.
// Use only node:crypto for cryptography; do not import @agentsig/* packages.

import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { createPublicKey, createPrivateKey, sign, verify } from "node:crypto";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const FX = resolve(ROOT, "packages/core/test/fixtures/rfc9421");
const RFC = resolve(ROOT, "tests/fixtures/sources/rfc9421.txt");
const FIXTURE_COMMIT = process.argv[2] ?? "c51777e";

let failures = 0;
const ok = (msg) => console.log(`  ✔ ${msg}`);
const fail = (msg) => { failures++; console.log(`  ✘ ${msg}`); };
const section = (t) => console.log(`\n${t}`);

// Unfold RFC 8792 single-backslash folds: remove backslash, newline, and leading whitespace.
const unfold = (text) => text.replace(/\\\r?\n[ \t]*/g, "");
const read = (p) => readFileSync(p, "utf8");
const hasCR = (buf) => buf.includes(0x0d);

// ---------- 1. File existence ----------
section("1. Fixture files");
const files = {
    reqHead: "request-head.txt",
    base: "signature-base.txt",
    headers: "signature-headers.txt",
    sig: "signature.bin",
    privPem: "ed25519-private.pem",
    pubPem: "ed25519-public.pem",
    privJwk: "ed25519-private.jwk.json",
};
for (const [k, f] of Object.entries(files)) {
    const p = resolve(FX, f);
    existsSync(p) ? ok(f) : fail(`${f} missing`);
    files[k] = p;
}
existsSync(RFC) ? ok("tests/fixtures/sources/rfc9421.txt") : fail("RFC source text missing");
if (failures) { console.log(`\n${failures} errors; cannot continue.`); process.exit(1); }

// ---------- 2. Line endings ----------
section("2. Line endings (LF required)");
for (const f of ["reqHead", "base", "headers", "privPem", "pubPem"]) {
    const buf = readFileSync(files[f]);
    hasCR(buf) ? fail(`${files[f]} contains CR (CRLF contamination)`) : ok(`${f}: LF only`);
}

// ---------- 3. Extract sig-b26 values from RFC text ----------
section("3. RFC 9421 text → sig-b26");
const rfcText = unfold(read(RFC));
const rfcInputs = [...rfcText.matchAll(/Signature-Input:\s*sig-b26=([^\n]+)/g)].map((m) => m[1].trim());
const rfcSigs = [...rfcText.matchAll(/Signature:\s*sig-b26=:([A-Za-z0-9+/=]+):/g)].map((m) => m[1]);

if (rfcInputs.length === 0) fail("Signature-Input sig-b26 not found in RFC text");
else if (new Set(rfcInputs).size > 1) fail("RFC text contains distinct sig-b26 Signature-Input values");
else ok(`Signature-Input found (${rfcInputs.length} occurrences, consistent)`);

if (rfcSigs.length === 0) fail("Signature sig-b26 not found in RFC text");
else if (new Set(rfcSigs).size > 1) fail("RFC text contains distinct sig-b26 Signature values");
else ok(`Signature found (${rfcSigs.length} occurrences, consistent)`);

const rfcInput = rfcInputs[0];
const rfcSigB64 = rfcSigs[0];

// ---------- 4. Compare with signature-headers.txt ----------
section("4. signature-headers.txt ↔ RFC");
const hdrText = unfold(read(files.headers));
const fxInput = hdrText.match(/Signature-Input:\s*sig-b26=([^\n]+)/)?.[1]?.trim();
const fxSigB64 = hdrText.match(/Signature:\s*sig-b26=:([A-Za-z0-9+/=]+):/)?.[1];

fxInput ? ok("Signature-Input parsed") : fail("Signature-Input missing from signature-headers.txt");
fxSigB64 ? ok("Signature parsed") : fail("Signature missing from signature-headers.txt");
if (fxInput && rfcInput) fxInput === rfcInput ? ok("Signature-Input matches RFC exactly") : fail(`Signature-Input differs\n    fixture: ${fxInput}\n    rfc:     ${rfcInput}`);
if (fxSigB64 && rfcSigB64) fxSigB64 === rfcSigB64 ? ok("Signature base64 matches RFC exactly") : fail("Signature base64 differs from RFC");

// ---------- 5. signature.bin ----------
section("5. signature.bin");
const sigBin = readFileSync(files.sig);
sigBin.length === 64 ? ok("64 bytes (Ed25519)") : fail(`${sigBin.length} bytes; expected 64`);
if (rfcSigB64) {
    const rfcBytes = Buffer.from(rfcSigB64, "base64");
    rfcBytes.equals(sigBin) ? ok("signature.bin = RFC base64 bytes") : fail("signature.bin does not match RFC bytes");
}

// ---------- 6. signature-base.txt ----------
section("6. signature-base.txt");
const baseBuf = readFileSync(files.base);
const hadTrailingLF = baseBuf.length && baseBuf[baseBuf.length - 1] === 0x0a;
const baseText = baseBuf.toString("utf8").replace(/\n$/, ""); // Remove a single trailing LF.
const baseLines = baseText.split("\n");
baseLines.length === 7 ? ok("7 lines (6 components + @signature-params)") : fail(`${baseLines.length} lines; expected 7`);
console.log(`  ℹ trailing LF ${hadTrailingLF ? "PRESENT" : "ABSENT"} (must not be in signed bytes; the crypto check below verifies this)`);

const last = baseLines[baseLines.length - 1];
const spPrefix = '"@signature-params": ';
if (!last.startsWith(spPrefix)) fail(`last line does not start with "@signature-params": ${last}`);
else {
    const spValue = last.slice(spPrefix.length);
    spValue === rfcInput ? ok("@signature-params value = RFC Signature-Input value") : fail(`@signature-params differs from RFC\n    base: ${spValue}\n    rfc:  ${rfcInput}`);
    /created=1618884473/.test(spValue) ? ok("created=1618884473") : fail("unexpected created value");
    /keyid="test-key-ed25519"/.test(spValue) ? ok('keyid="test-key-ed25519"') : fail("unexpected keyid");
}

const expectedComponents = ['"date"', '"@method"', '"@path"', '"@authority"', '"content-type"', '"content-length"'];
expectedComponents.forEach((c, i) => {
    baseLines[i]?.startsWith(c + ": ") ? ok(`line ${i + 1}: ${c}`) : fail(`line ${i + 1} does not start with ${c}: ${baseLines[i]}`);
});

// ---------- 7. Keys ----------
section("7. Keys (B.1.4)");
let pubKey, privKey;
try {
    pubKey = createPublicKey(read(files.pubPem));
    pubKey.asymmetricKeyType === "ed25519" ? ok("public.pem: ed25519") : fail(`public.pem type: ${pubKey.asymmetricKeyType}`);
} catch (e) { fail(`could not read public.pem: ${e.message}`); }
try {
    privKey = createPrivateKey(read(files.privPem));
    privKey.asymmetricKeyType === "ed25519" ? ok("private.pem: ed25519") : fail(`private.pem type: ${privKey.asymmetricKeyType}`);
} catch (e) { fail(`could not read private.pem: ${e.message}`); }

if (pubKey && privKey) {
    const derivedPub = createPublicKey(privKey).export({ type: "spki", format: "der" });
    const filePub = pubKey.export({ type: "spki", format: "der" });
    derivedPub.equals(filePub) ? ok("public key derived from private.pem = public.pem") : fail("private/public PEM pair mismatch");
}
try {
    const jwk = JSON.parse(read(files.privJwk));
    const jwkKey = createPrivateKey({ key: jwk, format: "jwk" });
    const jwkPub = createPublicKey(jwkKey).export({ type: "spki", format: "der" });
    pubKey && jwkPub.equals(pubKey.export({ type: "spki", format: "der" })) ? ok("JWK private → public = public.pem") : fail("JWK key does not match PEM");
    jwk.kid === "test-key-ed25519" ? ok(`JWK kid=${jwk.kid}`) : console.log(`  ℹ JWK kid: ${jwk.kid ?? "(absent)"}`);
} catch (e) { fail(`could not read JWK: ${e.message}`); }

// ---------- 8. Cryptographic verification (engine-independent) ----------
section("8. Cryptography: verification with node:crypto");
if (pubKey && privKey) {
    const msg = Buffer.from(baseText, "utf8");
    const valid = verify(null, msg, pubKey, sigBin);
    valid ? ok("signature.bin is VALID over signature-base.txt with public.pem") : fail("signature verification failed: base, signature, or key mismatch");

    // Ed25519 is deterministic: same key + same message = same signature.
    const resigned = sign(null, msg, privKey);
    resigned.equals(sigBin) ? ok("resigning with private.pem = signature.bin (deterministic match)") : fail("resigning produced different bytes");

    // Also check that including a trailing LF invalidates the signature.
    if (hadTrailingLF) {
        const withLF = verify(null, baseBuf, pubKey, sigBin);
        withLF ? fail("verification also passed with trailing LF — unexpected; investigate") : ok("including trailing LF invalidates the signature (expected)");
    }
}

// ---------- 9. Fixture commit contains no implementation ----------
section(`9. Commit ${FIXTURE_COMMIT}: no implementation code`);
try {
    const names = execSync(`git show --name-only --format= ${FIXTURE_COMMIT}`, { cwd: ROOT, encoding: "utf8" })
        .split("\n").filter(Boolean);
    const srcFiles = names.filter((n) => /^packages\/[^/]+\/src\//.test(n) || /\.(ts|tsx)$/.test(n) && !/\/test\//.test(n) && !/fixtures/.test(n));
    srcFiles.length === 0 ? ok(`${names.length} files; none are src/ or implementation .ts files`) : fail(`implementation code found:\n    ${srcFiles.join("\n    ")}`);
    const hasSources = names.some((n) => n.includes("tests/fixtures/sources/rfc9421.txt"));
    hasSources ? ok("RFC source text is pinned in this commit") : fail("RFC source text missing from this commit");
} catch (e) { fail(`git command failed: ${e.message.split("\n")[0]}`); }

// ---------- Result ----------
console.log(`\n${"─".repeat(50)}`);
if (failures === 0) console.log("PASS: all checks passed. Fixture baseline is intact.");
else console.log(`FAIL: ${failures} checks failed. Fix before pushing.`);
process.exit(failures ? 1 : 0);