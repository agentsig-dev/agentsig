import { createRedisReplayStore } from "../src/redis/replay-store.js";
import { connectRedisTestClient } from "./redis-test-client.js";

// TEST ONLY IPC worker. Bundled into an isolated temporary directory by the
// parent test; never published. Each process owns its connection and adapter.
async function main(): Promise<void> {
    const port = Number(process.env.AGENTSIG_TEST_REDIS_PORT);
    const namespace = process.env.AGENTSIG_TEST_REDIS_NAMESPACE;
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !namespace || !process.send) {
        throw new Error("Missing dedicated Redis worker configuration");
    }
    const client = await connectRedisTestClient(port);
    const watchdog = setTimeout(() => {
        client.close();
        process.exit(1);
    }, 15000);
    try {
        const store = await createRedisReplayStore({
            client, namespace, recoveryHorizonSeconds: 1,
        });
        const start = new Promise<void>((resolve) => {
            process.once("message", (message) => {
                if (message === "consume") resolve();
                else process.exit(1);
            });
        });
        process.send({ type: "ready", pid: process.pid });
        await start;
        const input = {
            scope: "merchant-a",
            keyThumbprint: "DR68nui99ukl-GUgfzQGaU3VwqRtArw-_DCN4LFtY84",
            nonce: "real-redis-nonce",
            nowEpochSeconds: 1800000000,
            retainUntilEpochSeconds: 1800000330,
        };
        const results = await Promise.all(Array.from({ length: 25 }, () => store.consume(input)));
        await new Promise<void>((resolve, reject) => {
            process.send!({ type: "results", pid: process.pid, results },
                (error: Error | null) => error ? reject(error) : resolve());
        });
    } finally {
        clearTimeout(watchdog);
        client.close();
        process.disconnect?.();
    }
}

void main().catch(() => {
    // Fixed failure text only; never forward Redis errors or tuple data over IPC.
    process.stderr.write("Redis integration worker failed\n");
    process.exitCode = 1;
    process.disconnect?.();
});