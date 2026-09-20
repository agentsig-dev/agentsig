import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
for (const adapter of ["express", "fastify", "hono"]) {
    const cwd = resolve(root, "packages", adapter);
    for (const format of ["module", "commonjs"]) {
        test(`${adapter}: public ${format} consumer uses one core ownership registry`, () => {
            const imports = format === "module"
                ? `import assert from "node:assert/strict";
                   import * as adapter from "@agentsig/${adapter}";
                   import { createNodeHttpMapper } from "@agentsig/core/http";`
                : `const assert = require("node:assert/strict");
                   const adapter = require("@agentsig/${adapter}");
                   const { createNodeHttpMapper } = require("@agentsig/core/http");`;
            const body = `
(async () => {
    const mapper = createNodeHttpMapper({ ingress: { allowedOrigins: ["http://merchant.example"] } });
    const options = { mapper, mode: "observe",
        verifier: { async verify() { return { status: "unsigned", reason: "no-signature", candidates: [] }; } } };
    assert.equal(typeof adapter.getAgentSig, "function");
    ${adapter === "fastify"
                    ? `const factory = ${format === "module" ? '(await import("fastify")).default' : 'require("fastify")'};
           const app = factory({ serverFactory: listener => mapper.createServer(listener) });
           await adapter.agentSigPlugin(app, options);
           await app.ready();
           await app.close();`
                    : adapter === "express"
                        ? `assert.equal(typeof adapter.agentSig(options), "function");`
                        : `const bridge = adapter.agentSig(options);
               assert.equal(typeof bridge.middleware, "function");
               assert.equal(typeof bridge.createServer, "function");`}
    process.stdout.write("adapter-consumer-ok");
})().catch(() => { process.stderr.write("Adapter consumer failed"); process.exitCode = 1; });
`;
            const output = execFileSync(process.execPath, [
                `--input-type=${format}`, "--eval", imports + body,
            ], { cwd, encoding: "utf8", timeout: 15000 });
            assert.equal(output, "adapter-consumer-ok");
        });

        test(`${adapter}: ${format} declarations preserve context and policy boundaries`, () => {
            const directory = mkdtempSync(join(cwd, ".adapter-consumer-"));
            try {
                const filename = join(directory, format === "module" ? "consumer.mts" : "consumer.cts");
                const setup = adapter === "express"
                    ? `import express from "express";
                       import { agentSig, getAgentSig } from "@agentsig/express";
                       const app = express();
                       app.use(agentSig(options));
                       app.get("/", (req, res) => {
                           const context = getAgentSig(req);
                           // @ts-expect-error Readonly native context slot.
                           req.agentsig = context;
                           res.end();
                       });`
                    : adapter === "fastify"
                        ? `import Fastify from "fastify";
                           import { agentSigPlugin, getAgentSig } from "@agentsig/fastify";
                           const app = Fastify({ serverFactory: listener => mapper.createServer(listener) });
                           void agentSigPlugin(app, options);
                           app.get("/", async req => {
                               const context = getAgentSig(req);
                               // @ts-expect-error Readonly native context slot.
                               req.agentsig = context;
                               return "";
                           });`
                        : `import { Hono } from "hono";
                           import { agentSig, getAgentSig } from "@agentsig/hono";
                           const app = new Hono();
                           const bridge = agentSig(options);
                           app.use("*", bridge.middleware);
                           app.get("/", c => {
                               const context = getAgentSig(c);
                               // @ts-expect-error Readonly assessment.
                               context.authorization = { status: "allowed", basis: "anonymous" };
                               return c.body(null, 204);
                           });
                           bridge.createServer(app);`;
                writeFileSync(filename, `
import { createNodeHttpMapper, type HttpAgentSigOptions } from "@agentsig/core/http";
const mapper = createNodeHttpMapper({ ingress: { allowedOrigins: ["http://merchant.example"] } });
const options: HttpAgentSigOptions = {
    mapper, mode: "enforce",
    verifier: { async verify() { return { status: "unsigned", reason: "no-signature", candidates: [] }; } },
    policy(assessment, tools) {
        if (assessment.status === "mapping-rejected") {
            // @ts-expect-error Mapping rejection is not a fabricated verification result.
            assessment.verification;
        }
        // @ts-expect-error General assessment is not owned verified aggregate evidence.
        tools.allowVerified(assessment);
        return tools.deny();
    },
};
${setup}
`, "utf8");
                execFileSync(process.execPath, [
                    resolve(root, "node_modules/typescript/bin/tsc"),
                    "--noEmit", "--strict", "--exactOptionalPropertyTypes",
                    "--module", "NodeNext", "--moduleResolution", "NodeNext",
                    "--target", "ES2022", "--lib", "ES2022,DOM,DOM.Iterable",
                    "--types", "node", filename,
                ], { cwd, encoding: "utf8", timeout: 30000 });
            } finally {
                rmSync(directory, { recursive: true, force: true });
            }
        });
    }
}