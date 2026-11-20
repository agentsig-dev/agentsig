import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));

// Project author metadata may be absent, a name, or an object containing only
// a name. Do not print rejected values: they could contain personal information.
function safeAuthor(author) {
    if (author === undefined) return true;
    const nameOnly = value => typeof value === "string" &&
        value.trim().length > 0 && !/[@<>\r\n]/.test(value);
    if (typeof author === "string") return nameOnly(author);
    return author !== null && typeof author === "object" && !Array.isArray(author) &&
        Object.keys(author).length === 1 && Object.hasOwn(author, "name") &&
        nameOnly(author.name);
}

test("project package authors contain names only, never email metadata", () => {
    const paths = execFileSync("git", [
        "ls-files", "--cached", "--others", "--exclude-standard", "-z",
        "--", "package.json", "**/package.json",
    ], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
    const owned = [...new Set(paths)].filter(path => !path.startsWith("tests/fixtures/"));
    assert(owned.includes("package.json"));
    for (const name of ["core", "fetch", "hono", "fastify", "express", "structured-fields"]) {
        assert(owned.includes(`packages/${name}/package.json`));
    }
    for (const path of owned) {
        const manifest = JSON.parse(readFileSync(new URL(path, new URL("../", import.meta.url))));
        assert(safeAuthor(manifest.author), `Author metadata must be name-only: ${path}`);
    }
    // Immutable upstream fixture manifests retain their original attribution.
    // npm account maintainer/_npmUser metadata is registry-owned, not author.
});

test("author policy catches string and object email forms without printing them", () => {
    for (const author of [undefined, "agentsig-dev", "Example Maintainer", { name: "agentsig-dev" }]) {
        assert(safeAuthor(author));
    }
    for (const author of [
        "Example <example@example.invalid>", "example@example.invalid",
        { name: "Example", email: "example@example.invalid" },
        { name: "Example", email: "" }, { name: "example@example.invalid" },
        { name: "Example", url: "https://example.invalid" }, null, [], "",
    ]) {
        assert.equal(safeAuthor(author), false, "Unsafe author representation must be rejected");
    }
});