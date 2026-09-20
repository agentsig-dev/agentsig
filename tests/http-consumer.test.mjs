import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cwd = resolve(root, "packages/core");
const assertions = `
(async () => {
    assert.equal(http.HTTP_MAPPING_ERROR_CATALOG_VERSION, 1);
    assert.equal(http.HTTP_MAPPING_ERROR_CODES.length, 17);
    assert.equal(typeof http.createNodeHttpMapper, 'function');
    assert.equal('mapHttpSnapshot' in http, false);
    const mapper = http.createNodeHttpMapper({
        ingress: { allowedOrigins: ['http://merchant.example'] },
    });
    assert.deepEqual(mapper.map({}), { status: 'mapping-rejected', code: 'capture-missing' });
    let mapping;
    const server = mapper.createServer((request, response) => {
        mapping = mapper.map(request);
        request.url = '/rewritten';
        assert.deepEqual(mapper.map(request), mapping);
        response.end();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        await new Promise((resolve, reject) => {
            const request = get({
                host: '127.0.0.1', port: server.address().port,
                path: '/a/%2E/../b?x=+&x=%20', headers: { Host: 'merchant.example' },
                agent: false,
            }, response => { response.resume(); response.on('end', resolve); });
            request.on('error', reject);
        });
        assert.equal(mapping.status, 'mapped');
        assert.equal(mapping.request.targetUri, 'http://merchant.example/a/%2E/../b?x=+&x=%20');
        assert.equal(mapping.request.httpVersion, '1.1');
        for (const path of ['@agentsig/core/http/mapping', '@agentsig/core/dist/http/mapping.js']) {
            await assert.rejects(import(path), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
        }
        process.stdout.write('http-consumer-ok');
    } finally {
        server.closeAllConnections();
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
})().catch(() => { process.stderr.write('HTTP consumer failed'); process.exitCode = 1; });
`;

for (const format of ["module", "commonjs"]) {
    test(`HTTP public entry works in a fresh ${format} process`, () => {
        const imports = format === "module"
            ? `import assert from 'node:assert/strict';
               import { get } from 'node:http';
               import * as http from '@agentsig/core/http';`
            : `const assert = require('node:assert/strict');
               const { get } = require('node:http');
               const http = require('@agentsig/core/http');`;
        const output = execFileSync(process.execPath, [
            `--input-type=${format}`, "--eval", imports + assertions,
        ], { cwd, encoding: "utf8", timeout: 15000 });
        assert.equal(output, "http-consumer-ok");
    });

    test(`HTTP declarations resolve for ${format}`, () => {
        const directory = mkdtempSync(join(cwd, ".http-consumer-"));
        try {
            const filename = join(directory, format === "module" ? "consumer.mts" : "consumer.cts");
            writeFileSync(filename, `
import { createNodeHttpMapper, type HttpMappingResult, type ObservedClient } from "@agentsig/core/http";
// @ts-expect-error Internal descriptor mapper is not public capture proof.
import { mapHttpSnapshot } from "@agentsig/core/http";
// @ts-expect-error Internal raw snapshots are not part of the public API.
import type { HttpSnapshot } from "@agentsig/core/http";
const mapper = createNodeHttpMapper({ ingress: { allowedOrigins: ["https://merchant.example"] } });
mapper.createServer((request, response) => {
    const result: HttpMappingResult = mapper.map(request);
    if (result.status === "mapped") {
        const hint: ObservedClient | undefined = result.observedClient;
        if (hint) {
            const authenticated: false = hint.authenticated;
            void authenticated;
        }
        // @ts-expect-error Readonly request snapshot.
        result.request.targetUri = "https://forged.example";
    } else {
        // @ts-expect-error Mapping failures do not fabricate request parts.
        result.request;
    }
    // @ts-expect-error Mapping is not authentication.
    result.verifiedCandidates;
    response.end();
});
// @ts-expect-error Trusted ingress requires an explicit sanitizing assertion.
createNodeHttpMapper({ ingress: {
    mode: "trusted-ingress", family: "forwarded",
    allowedOrigins: ["https://merchant.example"], trustedPeers: ["127.0.0.1"],
} });
`, "utf8");
            execFileSync(process.execPath, [
                resolve(root, "node_modules/typescript/bin/tsc"),
                "--noEmit", "--strict", "--exactOptionalPropertyTypes",
                "--module", "NodeNext", "--moduleResolution", "NodeNext",
                "--target", "ES2022", "--types", "node", filename,
            ], { cwd, encoding: "utf8", timeout: 30000 });
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });
}