import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Independent authored expectations: no agentsig, Fetch Request, Headers, URL
// normalization, or Structured Fields serializer is used to derive goldens.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = resolve(root, "tests/fixtures/m4-fetch");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const files = [];
function put(path, data) {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
    const target = resolve(destination, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    files.push({ path, bytes: bytes.length, sha256: hash(bytes) });
}
function json(path, data) { put(path, JSON.stringify(data, null, 2) + "\n"); }

const privatePath = "tests/fixtures/m2/generated/public-test-private.pem";
const publicPath = "tests/fixtures/m2/generated/public-test-public.pem";
const privateKey = createPrivateKey(readFileSync(resolve(root, privatePath)));
const publicKey = createPublicKey(readFileSync(resolve(root, publicPath)));
assert(createPublicKey(privateKey).equals(publicKey));
const jwk = publicKey.export({ format: "jwk" });
const keyid = hash(Buffer.from(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x })));
const thumbprint = Buffer.from(keyid, "hex").toString("base64url");
assert.equal(thumbprint, "DR68nui99ukl-GUgfzQGaU3VwqRtArw-_DCN4LFtY84");

const inputs = [
    {
        name: "normalized-get",
        url: "HTTPS://MERCHANT.EXAMPLE:443/a/../items%2f?q=a+b&q=a%20b",
        init: { method: "get", headers: [["X-Zeta", "  last  "], ["X-Repeat", "one"], ["x-repeat", "two"]] },
        method: "GET",
        targetUri: "https://merchant.example/items%2f?q=a+b&q=a%20b",
        unsignedHeaders: [["x-repeat", "one, two"], ["x-zeta", "last"]],
        bodyPolicy: "reject",
        body: null,
    },
    {
        name: "identity-only-post",
        url: "https://merchant.example/payments?",
        init: { method: "post", headers: [["Content-Type", "application/json"]], body: '{"amount":42}' },
        method: "POST",
        targetUri: "https://merchant.example/payments?",
        unsignedHeaders: [["content-type", "application/json"]],
        bodyPolicy: "allow-unverified",
        body: '{"amount":42}',
    },
];
const vectors = [];
for (const profile of ["ietf-wg-protocol-00", "cloudflare-docs-2026-07-01"]) {
    for (const example of inputs) {
        const wg = profile === "ietf-wg-protocol-00";
        const nonce = "fetch-fixed-nonce";
        const agentComponent = wg ? '"signature-agent";key="sig1"' : '"signature-agent"';
        const components = `("@method" "@target-uri" ${agentComponent})`;
        const parameters = ';created=1800000000;expires=1800000060' +
            `;keyid="${thumbprint}";alg="ed25519";nonce="${nonce}";tag="web-bot-auth"`;
        const base = [
            `"@method": ${example.method}`,
            `"@target-uri": ${example.targetUri}`,
            `${agentComponent}: "https://agent.example"`,
            `"@signature-params": ${components}${parameters}`,
        ].join("\n");
        const signature = sign(null, Buffer.from(base), privateKey);
        assert(verify(null, Buffer.from(base), publicKey, signature));
        const headers = [
            ...example.unsignedHeaders,
            ["signature", `sig1=:${signature.toString("base64")}:`],
            ["signature-agent", wg ? 'sig1="https://agent.example"' : '"https://agent.example"'],
            ["signature-input", `sig1=${components}${parameters}`],
        ].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
        const id = `${profile}/${example.name}`;
        put(`${id}/base.txt`, base);
        put(`${id}/signature.bin`, signature);
        // Lowercase names, ordered Fetch header view, CRLF separators, no EOF CRLF.
        put(`${id}/headers.bin`, Buffer.from(headers.map(([name, value]) => `${name}: ${value}`).join("\r\n"), "ascii"));
        json(`${id}/case.json`, {
            id, profile,
            clockMilliseconds: 1800000000999.5, nonce,
            agentOrigin: "https://agent.example", allowTestKeys: true,
            bodyPolicy: example.bodyPolicy, input: example.url, init: example.init,
            expected: {
                method: example.method, url: example.targetUri, redirect: "manual",
                unsignedHeaders: example.unsignedHeaders,
                headers, body: example.body, signingCalls: 1, transportCalls: 1,
            },
        });
        vectors.push(id);
    }
}

json("contract.json", {
    formatVersion: 1,
    approvedOn: "2026-09-20",
    defaultTransport: "global fetch captured at factory creation",
    applicationTransport: "Explicit injected Fetch-compatible function is trusted application code",
    perInvocation: {
        request: "Fresh owned clean request; sign final serialized method/URL and stable headers",
        signingCalls: 1, transportCalls: 1, redirect: "manual",
        wrapperRetry: false, wrapperResign: false, exactlyOnceNetworkDelivery: false,
        native421: "Native Fetch may resend identical signed bytes after 421; no new nonce is issued by the wrapper",
    },
    collisions: {
        fields: ["signature", "signature-input", "signature-agent"],
        check: "Check input Request and init headers separately before overrides; even empty values reject",
        error: "SigningError", code: "existing-signature-headers",
        signingCalls: 0, transportCalls: 0,
    },
    body: {
        default: "reject",
        optIn: "allow-unverified",
        integrity: "unverified",
        readBufferHashRewindCloneOrTeeForReplay: false,
        usedOrLockedBody: "reject",
        explicitEmptyBody: "A non-null body still requires opt-in",
    },
    destination: {
        default: "https only",
        testOption: "allowHttpLoopbackForTests",
        literalHosts: ["127.0.0.1", "[::1]"],
        ports: "Absent default or decimal integer 1 through 65535",
        rawString: "Validate HTTP exception before URL normalization",
        preconstructed: "Validate serialized URL/Request address only; original spelling is unrecoverable",
        dnsLookupForException: false,
        discoveryPolicyChanged: false,
    },
    redirects: {
        explicitInitFollowOrError: "reject before signing",
        inheritedRequestMode: "Replace with manual on the owned request, including Request's default follow",
        response: "Return selected transport response without wrapper follow or retry",
    },
    forbiddenHeaders: [
        "host", ":authority", "connection", "keep-alive", "proxy-authenticate",
        "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade",
        "content-length",
    ],
    stableCoverage: "Do not guess transport-generated fields; unsupported absent additional coverage rejects through the existing signer",
    abort: {
        beforeSigning: "No signing or dispatch",
        afterSigningBeforeDispatch: "No dispatch",
        afterDispatch: "No proof that server did not receive request",
        diagnostic: "Fixed AbortError text, never caller abort reason",
    },
    errors: {
        frozenCatalogsChanged: false,
        wrapperValidation: "Fixed TypeError without raw input or cause",
        transportFailure: "Fixed TypeError without raw backend error or cause",
        signerFailure: "Preserve existing SigningError code without raw provider failures",
    },
    comparison: "Golden byte equality at the selected transport Request boundary; not TCP header ordering or transport-added headers",
});

json("negative-cases.json", {
    collisions: ["Signature", "Signature-Input", "Signature-Agent"].flatMap(name =>
        [name, name.toLowerCase(), name.toUpperCase()].flatMap(spelling =>
            ["", "already-present"].flatMap(value =>
                ["input-request-overridden", "init"].map(source => ({
                    source, name: spelling, value, code: "existing-signature-headers",
                    signingCalls: 0, transportCalls: 0,
                }))))),
    http: [
        ["http://127.0.0.1/", true],
        ["http://127.0.0.1:8080/", true],
        ["http://[::1]:8080/", true],
        ["http://localhost/", false],
        ["http://127.0.0.2/", false],
        ["http://127.1/", false],
        ["http://2130706433/", false],
        ["http://0x7f000001/", false],
        ["http://0177.0.0.1/", false],
        ["http://127.0.0.1.example/", false],
        ["http://[::ffff:127.0.0.1]/", false],
        ["http://[0:0:0:0:0:0:0:1]/", false],
        ["http://[::1%25lo]/", false],
        ["http://127.0.0.1:0/", false],
        ["http://127.0.0.1:65536/", false],
        ["http://user@127.0.0.1/", false],
        [" http://127.0.0.1/", false],
        ["http:\\\\127.0.0.1\\", false],
        ["http://10.0.0.1/", false],
    ].map(([input, allowedWithTestOption]) => ({ input, allowedWithTestOption, allowedByDefault: false })),
    transportResponses: [200, 301, 302, 307, 308, 401, 429, 500, 503].map(status => ({
        status, signingCalls: 1, selectedTransportCalls: 1, wrapperRetry: false,
    })),
    ownership: [
        "Reuse bodyless unsigned Request: fresh owned Request and fresh signer nonce each invocation",
        "Input/init header mutation while signing cannot change the owned send",
        "Signer descriptor mutation cannot change the owned send",
        "Body stream is never cloned or teed for replay",
        "Default transport is captured at factory creation, not looked up after signing",
    ],
});
const sources = [
    privatePath, publicPath,
    "tests/fixtures/m4-sources/manifest.json",
    "tests/fixtures/signing/manifest.json",
];
writeFileSync(resolve(destination, "manifest.json"), JSON.stringify({
    formatVersion: 1, license: "MIT; independently authored agentsig expectations",
    warning: "Public test key only. Never use fixed test keys, clocks or nonces in production.",
    sources: sources.map(path => ({ path, sha256: hash(readFileSync(resolve(root, path))) })),
    vectors, files,
}, null, 2) + "\n");
console.log(`Pinned ${files.length} fetch fixture files and ${vectors.length} independent golden vectors.`);