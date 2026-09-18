import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import {
    copyFileSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
    readFileSync(resolve(root, "tests/fixtures/manifest.json")).toString("utf8"),
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const read = (path) => readFileSync(resolve(root, path));
const rfcRoot = "packages/core/test/fixtures/rfc9421/";

test("all pinned fixtures match their byte length and SHA-256", () => {
    const paths = new Set();
    for (const file of manifest.files) {
        assert(!paths.has(file.path), `Duplicate manifest entry: ${file.path}`);
        paths.add(file.path);
        const bytes = read(file.path);
        assert.equal(bytes.length, file.bytes, file.path);
        assert.equal(hash(bytes), file.sha256, file.path);
        if (!file.path.endsWith(".bin") && !file.path.endsWith(".der")) {
            assert.equal(bytes.includes(13), false, `Unexpected CR: ${file.path}`);
        }
    }
    assert(paths.has(`${rfcRoot}signature.bin`));
    assert(paths.has("packages/structured-fields/test/fixtures/httpwg/date.json"));
    assert(paths.has("packages/structured-fields/test/fixtures/httpwg/display-string.json"));
});

test("published RFC 9421 B.2.6 signature verifies without agentsig code", () => {
    const base = read(`${rfcRoot}signature-base.txt`);
    const signature = read(`${rfcRoot}signature.bin`);
    const publicKey = createPublicKey(read(`${rfcRoot}ed25519-public.pem`));
    const privateKey = read(`${rfcRoot}ed25519-private.pem`);
    assert.equal(base.length, 284);
    assert.equal(signature.length, 64);
    assert.notEqual(base.at(-1), 10, "Canonical base must not gain a final LF");
    assert.equal(verify(null, base, publicKey, signature), true);
    assert.deepEqual(
        createPublicKey(privateKey).export({ format: "der", type: "spki" }),
        publicKey.export({ format: "der", type: "spki" }),
    );

    // Negative controls ensure EOL/EOF corruption is observable, not normalized away.
    const crlf = Buffer.from(base.toString("utf8").replaceAll("\n", "\r\n"));
    assert.equal(verify(null, crlf, publicKey, signature), false);
    assert.equal(
        verify(null, Buffer.concat([base, Buffer.from("\n")]), publicKey, signature),
        false,
    );
});

for (const autocrlf of ["true", "input", "false"]) {
    test(`Git add/checkout preserves fixture bytes with core.autocrlf=${autocrlf}`, () => {
        const scratch = resolve(root, ".tmp");
        mkdirSync(scratch, { recursive: true });
        const work = mkdtempSync(resolve(scratch, "fixture-eol-"));
        // Isolate system/global Git settings and attributes; never modify user config.
        const env = {
            ...process.env,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
            GIT_ATTR_NOSYSTEM: "1",
        };
        for (const key of Object.keys(env)) {
            if (
                key === "GIT_DIR" ||
                key === "GIT_WORK_TREE" ||
                key === "GIT_INDEX_FILE" ||
                key === "GIT_COMMON_DIR" ||
                key === "GIT_CONFIG_PARAMETERS" ||
                key === "GIT_CONFIG_COUNT" ||
                key.startsWith("GIT_CONFIG_KEY_") ||
                key.startsWith("GIT_CONFIG_VALUE_")
            ) {
                delete env[key];
            }
        }
        const git = (...args) =>
            execFileSync(
                "git",
                [
                    "-c", `core.autocrlf=${autocrlf}`,
                    "-c", "core.eol=crlf",
                    "-c", "core.attributesFile=",
                    "-C", work,
                    ...args,
                ],
                { env, maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
            );
        try {
            git("init", "-q");
            copyFileSync(resolve(root, ".gitattributes"), resolve(work, ".gitattributes"));
            for (const file of manifest.files) {
                const destination = resolve(work, file.path);
                mkdirSync(dirname(destination), { recursive: true });
                copyFileSync(resolve(root, file.path), destination);
            }
            git("add", "--", ".gitattributes", "packages", "tests");
            for (const file of manifest.files) {
                const staged = git("show", `:${file.path}`);
                assert.equal(hash(staged), file.sha256, `Index bytes: ${file.path}`);
                rmSync(resolve(work, file.path));
            }
            git("checkout-index", "--all", "--force");
            for (const file of manifest.files) {
                const checkedOut = readFileSync(resolve(work, file.path));
                assert.equal(hash(checkedOut), file.sha256, `Checkout bytes: ${file.path}`);
            }
        } finally {
            // Remove only the uniquely allocated test directory.
            rmSync(work, { recursive: true, force: true, maxRetries: 3 });
        }
    });
}