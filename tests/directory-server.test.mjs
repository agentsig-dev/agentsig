import assert from "node:assert/strict";
import { request } from "node:https";
import { gunzipSync } from "node:zlib";
import { test } from "node:test";
import {
    startDirectoryServer, directoryTestCertificate, directoryTestHostname,
} from "./helpers/directory-server.mjs";

// Harness checks only. Explicit loopback dialing here does not test or bypass
// the future production resolver's public-address admission policy.
function get(server, overrides = {}) {
    return new Promise((resolve, reject) => {
        const operation = request({
            hostname: server.address,
            port: server.port,
            path: server.path,
            method: "GET",
            servername: directoryTestHostname,
            ca: directoryTestCertificate,
            rejectUnauthorized: true,
            agent: false,
            headers: { Host: directoryTestHostname, "Accept-Encoding": "identity" },
            ...overrides,
        });
        const deadline = setTimeout(() => operation.destroy(new Error("Test deadline exceeded")), 3000);
        const fail = (error) => { clearTimeout(deadline); reject(error); };
        operation.once("error", fail);
        operation.once("timeout", () => operation.destroy(new Error("Test idle timeout")));
        operation.once("response", (response) => {
            const authorized = response.socket.authorized;
            const chunks = [];
            let size = 0;
            response.on("data", (chunk) => {
                size += chunk.length;
                if (size > 1048576) {
                    operation.destroy(new Error("Test reader budget exceeded"));
                    return;
                }
                chunks.push(chunk);
            });
            response.once("error", fail);
            response.once("end", () => {
                clearTimeout(deadline);
                resolve({
                    status: response.statusCode,
                    headers: response.headers,
                    body: Buffer.concat(chunks),
                    authorized,
                });
            });
        });
        operation.end();
    });
}

test("local directory serves public JWKS with explicit CA and hostname validation", async (t) => {
    const server = await startDirectoryServer();
    t.after(() => server.close());
    const response = await get(server);
    assert.equal(response.status, 200);
    assert.equal(response.authorized, true);
    assert.equal(response.headers["content-type"], "application/http-message-signatures-directory+json");
    const jwks = JSON.parse(response.body);
    assert.equal(jwks.keys[0].crv, "Ed25519");
    assert.equal(Object.hasOwn(jwks.keys[0], "d"), false);
    assert.equal(server.requests, 1);
});

test("TLS rejects an untrusted certificate and a wrong authenticated hostname", async (t) => {
    const server = await startDirectoryServer();
    t.after(() => server.close());
    await assert.rejects(get(server, { ca: [] }));
    await assert.rejects(get(server, { servername: "wrong.agentsig.test" }), {
        code: "ERR_TLS_CERT_ALTNAME_INVALID",
    });
    assert.equal(server.requests, 0);
});

test("redirect and 304 scenarios do not generate follow-up requests", async (t) => {
    const server = await startDirectoryServer();
    t.after(() => server.close());
    server.setMode("redirect");
    const redirect = await get(server);
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.location, "https://internal.example/");
    assert.equal(server.requests, 1);
    server.setMode("not-modified");
    assert.equal((await get(server)).status, 304);
    assert.equal(server.requests, 2);
});

test("oversize and compressed modes generate their declared wire conditions", async (t) => {
    const server = await startDirectoryServer();
    t.after(() => server.close());
    server.setMode("large");
    const large = await get(server);
    assert(large.body.length > 262144);
    assert.equal(large.headers["content-length"], undefined);
    server.setMode("compressed");
    const compressed = await get(server);
    assert.equal(compressed.headers["content-encoding"], "gzip");
    assert.equal(JSON.parse(gunzipSync(compressed.body)).keys[0].crv, "Ed25519");
    // Acceptance above is by this diagnostic reader, not a production client.
    // The production contract requires rejecting compressed responses.
});

test("slow mode exposes an idle interval and client destruction permits teardown", async (t) => {
    const server = await startDirectoryServer();
    t.after(() => server.close());
    server.setMode("slow");
    await assert.rejects(get(server, { timeout: 100 }), {
        message: "Test idle timeout",
    });
});

test("directory rotation and malformed-key scenarios are independently controllable", async (t) => {
    const server = await startDirectoryServer();
    t.after(() => server.close());
    server.setMode("empty");
    assert.deepEqual(JSON.parse((await get(server)).body), { keys: [] });
    server.setMode("too-many-keys");
    assert.equal(JSON.parse((await get(server)).body).keys.length, 65);
    server.setMode("private-key");
    assert.equal(JSON.parse((await get(server)).body).keys[0].kty, "oct");
    server.setMode("malformed");
    const malformed = await get(server);
    assert.throws(() => JSON.parse(malformed.body));
    server.setMode("valid");
    server.setBody('{"keys":[]}');
    server.setCacheControl("max-age=0");
    const rotated = await get(server);
    assert.deepEqual(JSON.parse(rotated.body), { keys: [] });
    assert.equal(rotated.headers["cache-control"], "max-age=0");
    await server.close();
    await server.close();
});