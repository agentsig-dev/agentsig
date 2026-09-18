// scripts/audit-fixtures.mjs
// RFC 9421 B.2.6 fixture'larını motordan bağımsız doğrular.
// Sadece node:crypto kullanır; @agentsig/* paketlerine dokunmaz.

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

// RFC 8792 tek ters bölü katlamasını aç: "\" + satır sonu + baştaki boşluklar silinir
const unfold = (text) => text.replace(/\\\r?\n[ \t]*/g, "");
const read = (p) => readFileSync(p, "utf8");
const hasCR = (buf) => buf.includes(0x0d);

// ---------- 1. Dosyalar var mı ----------
section("1. Fixture dosyaları");
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
    existsSync(p) ? ok(f) : fail(`${f} eksik`);
    files[k] = p;
}
existsSync(RFC) ? ok("tests/fixtures/sources/rfc9421.txt") : fail("RFC kaynak metni eksik");
if (failures) { console.log(`\n${failures} hata, devam edilemiyor.`); process.exit(1); }

// ---------- 2. Satır sonları ----------
section("2. Satır sonları (LF zorunlu)");
for (const f of ["reqHead", "base", "headers", "privPem", "pubPem"]) {
    const buf = readFileSync(files[f]);
    hasCR(buf) ? fail(`${files[f]} içinde CR var (CRLF sızıntısı)`) : ok(`${f}: sadece LF`);
}

// ---------- 3. RFC metninden sig-b26 değerlerini çek ----------
section("3. RFC 9421 metni → sig-b26");
const rfcText = unfold(read(RFC));
const rfcInputs = [...rfcText.matchAll(/Signature-Input:\s*sig-b26=([^\n]+)/g)].map((m) => m[1].trim());
const rfcSigs = [...rfcText.matchAll(/Signature:\s*sig-b26=:([A-Za-z0-9+/=]+):/g)].map((m) => m[1]);

if (rfcInputs.length === 0) fail("RFC metninde Signature-Input sig-b26 bulunamadı");
else if (new Set(rfcInputs).size > 1) fail("RFC metninde birden fazla farklı sig-b26 Signature-Input var");
else ok(`Signature-Input bulundu (${rfcInputs.length} oluşum, tutarlı)`);

if (rfcSigs.length === 0) fail("RFC metninde Signature sig-b26 bulunamadı");
else if (new Set(rfcSigs).size > 1) fail("RFC metninde birden fazla farklı sig-b26 Signature var");
else ok(`Signature bulundu (${rfcSigs.length} oluşum, tutarlı)`);

const rfcInput = rfcInputs[0];
const rfcSigB64 = rfcSigs[0];

// ---------- 4. signature-headers.txt ile karşılaştır ----------
section("4. signature-headers.txt ↔ RFC");
const hdrText = unfold(read(files.headers));
const fxInput = hdrText.match(/Signature-Input:\s*sig-b26=([^\n]+)/)?.[1]?.trim();
const fxSigB64 = hdrText.match(/Signature:\s*sig-b26=:([A-Za-z0-9+/=]+):/)?.[1];

fxInput ? ok("Signature-Input ayrıştırıldı") : fail("signature-headers.txt içinde Signature-Input yok");
fxSigB64 ? ok("Signature ayrıştırıldı") : fail("signature-headers.txt içinde Signature yok");
if (fxInput && rfcInput) fxInput === rfcInput ? ok("Signature-Input RFC ile birebir") : fail(`Signature-Input farklı\n    fixture: ${fxInput}\n    rfc:     ${rfcInput}`);
if (fxSigB64 && rfcSigB64) fxSigB64 === rfcSigB64 ? ok("Signature base64 RFC ile birebir") : fail("Signature base64 RFC'den farklı");

// ---------- 5. signature.bin ----------
section("5. signature.bin");
const sigBin = readFileSync(files.sig);
sigBin.length === 64 ? ok("64 bayt (Ed25519)") : fail(`${sigBin.length} bayt, 64 bekleniyordu`);
if (rfcSigB64) {
    const rfcBytes = Buffer.from(rfcSigB64, "base64");
    rfcBytes.equals(sigBin) ? ok("signature.bin = RFC base64 baytları") : fail("signature.bin RFC baytlarıyla eşleşmiyor");
}

// ---------- 6. signature-base.txt ----------
section("6. signature-base.txt");
const baseBuf = readFileSync(files.base);
const hadTrailingLF = baseBuf.length && baseBuf[baseBuf.length - 1] === 0x0a;
const baseText = baseBuf.toString("utf8").replace(/\n$/, ""); // tek sondaki LF'i at
const baseLines = baseText.split("\n");
baseLines.length === 7 ? ok("7 satır (6 bileşen + @signature-params)") : fail(`${baseLines.length} satır, 7 bekleniyordu`);
console.log(`  ℹ dosya sonunda LF ${hadTrailingLF ? "VAR" : "YOK"} (imzalanan baytlarda olmamalı; aşağıdaki kripto testi bunu doğrular)`);

const last = baseLines[baseLines.length - 1];
const spPrefix = '"@signature-params": ';
if (!last.startsWith(spPrefix)) fail(`son satır "@signature-params" ile başlamıyor: ${last}`);
else {
    const spValue = last.slice(spPrefix.length);
    spValue === rfcInput ? ok("@signature-params değeri = RFC Signature-Input değeri") : fail(`@signature-params RFC ile farklı\n    base: ${spValue}\n    rfc:  ${rfcInput}`);
    /created=1618884473/.test(spValue) ? ok("created=1618884473") : fail("created değeri beklenen değil");
    /keyid="test-key-ed25519"/.test(spValue) ? ok('keyid="test-key-ed25519"') : fail("keyid beklenen değil");
}

const expectedComponents = ['"date"', '"@method"', '"@path"', '"@authority"', '"content-type"', '"content-length"'];
expectedComponents.forEach((c, i) => {
    baseLines[i]?.startsWith(c + ": ") ? ok(`satır ${i + 1}: ${c}`) : fail(`satır ${i + 1} ${c} ile başlamıyor: ${baseLines[i]}`);
});

// ---------- 7. Anahtarlar ----------
section("7. Anahtarlar (B.1.4)");
let pubKey, privKey;
try {
    pubKey = createPublicKey(read(files.pubPem));
    pubKey.asymmetricKeyType === "ed25519" ? ok("public.pem: ed25519") : fail(`public.pem tipi ${pubKey.asymmetricKeyType}`);
} catch (e) { fail(`public.pem okunamadı: ${e.message}`); }
try {
    privKey = createPrivateKey(read(files.privPem));
    privKey.asymmetricKeyType === "ed25519" ? ok("private.pem: ed25519") : fail(`private.pem tipi ${privKey.asymmetricKeyType}`);
} catch (e) { fail(`private.pem okunamadı: ${e.message}`); }

if (pubKey && privKey) {
    const derivedPub = createPublicKey(privKey).export({ type: "spki", format: "der" });
    const filePub = pubKey.export({ type: "spki", format: "der" });
    derivedPub.equals(filePub) ? ok("private.pem'den türeyen public = public.pem") : fail("private/public PEM çifti uyumsuz");
}
try {
    const jwk = JSON.parse(read(files.privJwk));
    const jwkKey = createPrivateKey({ key: jwk, format: "jwk" });
    const jwkPub = createPublicKey(jwkKey).export({ type: "spki", format: "der" });
    pubKey && jwkPub.equals(pubKey.export({ type: "spki", format: "der" })) ? ok("JWK private → public = public.pem") : fail("JWK anahtarı PEM ile uyumsuz");
    jwk.kid === "test-key-ed25519" ? ok(`JWK kid=${jwk.kid}`) : console.log(`  ℹ JWK kid: ${jwk.kid ?? "(yok)"}`);
} catch (e) { fail(`JWK okunamadı: ${e.message}`); }

// ---------- 8. Kriptografik doğrulama (motordan bağımsız) ----------
section("8. Kriptografi: node:crypto ile doğrulama");
if (pubKey && privKey) {
    const msg = Buffer.from(baseText, "utf8");
    const valid = verify(null, msg, pubKey, sigBin);
    valid ? ok("signature.bin, signature-base.txt üzerinde public.pem ile GEÇERLİ") : fail("imza doğrulanamadı: base metni, imza veya anahtar uyumsuz");

    // Ed25519 deterministik: aynı anahtar + aynı mesaj = aynı imza
    const resigned = sign(null, msg, privKey);
    resigned.equals(sigBin) ? ok("private.pem ile yeniden imzalama = signature.bin (deterministik eşleşme)") : fail("yeniden imzalama farklı bayt üretti");

    // Tersini de göster: sondaki LF eklenirse imza bozulmalı
    if (hadTrailingLF) {
        const withLF = verify(null, baseBuf, pubKey, sigBin);
        withLF ? fail("sondaki LF ile de doğrulandı — bu olmamalı, kontrol et") : ok("sondaki LF dahil edilirse imza bozuluyor (beklenen)");
    }
}

// ---------- 9. Fixture commit'inde uygulama kodu yok ----------
section(`9. Commit ${FIXTURE_COMMIT}: uygulama kodu içermiyor mu`);
try {
    const names = execSync(`git show --name-only --format= ${FIXTURE_COMMIT}`, { cwd: ROOT, encoding: "utf8" })
        .split("\n").filter(Boolean);
    const srcFiles = names.filter((n) => /^packages\/[^/]+\/src\//.test(n) || /\.(ts|tsx)$/.test(n) && !/\/test\//.test(n) && !/fixtures/.test(n));
    srcFiles.length === 0 ? ok(`${names.length} dosya, hiçbiri src/ veya uygulama .ts değil`) : fail(`uygulama kodu bulundu:\n    ${srcFiles.join("\n    ")}`);
    const hasSources = names.some((n) => n.includes("tests/fixtures/sources/rfc9421.txt"));
    hasSources ? ok("RFC kaynak metni bu commit'te pinlenmiş") : fail("RFC kaynak metni bu commit'te yok");
} catch (e) { fail(`git komutu çalışmadı: ${e.message.split("\n")[0]}`); }

// ---------- Sonuç ----------
console.log(`\n${"─".repeat(50)}`);
if (failures === 0) console.log("TAMAM: tüm kontroller geçti. Fixture zemini sağlam.");
else console.log(`HATA: ${failures} kontrol başarısız. Push etmeden önce düzelt.`);
process.exit(failures ? 1 : 0);