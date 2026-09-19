import { connect } from "node:net";
import type { RedisCommandClient } from "../src/redis/types.js";

type Reply = string | number | null | Reply[] | Error;

function parseReply(buffer: Buffer, offset = 0, depth = 0): { value: Reply; end: number } | undefined {
    if (depth > 8) throw new Error("Test Redis reply nesting exceeded");
    const end = buffer.indexOf("\r\n", offset);
    if (end < 0) return undefined;
    const kind = buffer.toString("ascii", offset, offset + 1);
    const text = buffer.toString("utf8", offset + 1, end);
    const next = end + 2;
    if (kind === "+") return { value: text, end: next };
    if (kind === "-") return { value: new Error(text), end: next };
    if (kind === ":") return { value: Number(text), end: next };
    const length = Number(text);
    if (!Number.isSafeInteger(length) || length < -1 || length > 33554432) {
        throw new Error("Invalid test Redis reply length");
    }
    if (kind === "$") {
        if (length === -1) return { value: null, end: next };
        if (buffer.length < next + length + 2) return undefined;
        if (buffer.toString("ascii", next + length, next + length + 2) !== "\r\n") {
            throw new Error("Invalid test Redis bulk terminator");
        }
        return { value: buffer.toString("utf8", next, next + length), end: next + length + 2 };
    }
    if (kind === "*") {
        if (length === -1) return { value: null, end: next };
        if (length > 100000) throw new Error("Test Redis array limit exceeded");
        const values: Reply[] = [];
        let cursor = next;
        for (let index = 0; index < length; index++) {
            const parsed = parseReply(buffer, cursor, depth + 1);
            if (!parsed) return undefined;
            values.push(parsed.value);
            cursor = parsed.end;
        }
        return { value: values, end: cursor };
    }
    throw new Error("Unexpected test Redis RESP type");
}

/**
 * TEST ONLY. Real TCP commands to a dedicated loopback Redis test service.
 * One connection per command: no offline queue, retry, pooling or reconnect.
 * This intentionally minimal RESP2 helper is not a production Redis client.
 * Do not use it with real credentials or export it from the package.
 */
export function createRedisTestClient(
    port: number,
    credentials?: { readonly username: string; readonly password: string },
): RedisCommandClient {
    return Object.freeze({
        automaticRetries: false as const,
        offlineQueue: false as const,
        isReady: true,
        sendCommand(arguments_: readonly string[]): Promise<unknown> {
            return new Promise((resolve, reject) => {
                const socket = connect({ host: "127.0.0.1", port });
                let pending = Buffer.alloc(0);
                let settled = false;
                let authenticated = credentials === undefined;
                const timer = setTimeout(() => finish(new Error("Test Redis command timeout")), 2000);
                function finish(error?: Error, value?: Reply): void {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    socket.destroy();
                    if (error) reject(error);
                    else resolve(value);
                }
                function send(args: readonly string[]): void {
                    const parts = [Buffer.from(`*${args.length}\r\n`)];
                    for (const argument of args) {
                        const bytes = Buffer.from(argument);
                        parts.push(Buffer.from(`$${bytes.length}\r\n`), bytes, Buffer.from("\r\n"));
                    }
                    socket.write(Buffer.concat(parts));
                }
                socket.on("error", (error) => finish(error));
                socket.once("close", () => {
                    if (!settled) finish(new Error("Test Redis connection closed before reply"));
                });
                socket.once("connect", () => {
                    if (credentials) send(["AUTH", credentials.username, credentials.password]);
                    else send(arguments_);
                });
                socket.on("data", (bytes: Buffer) => {
                    try {
                        if (pending.length + bytes.length > 33554432 + 65536) {
                            finish(new Error("Test Redis reply byte limit exceeded"));
                            return;
                        }
                        pending = Buffer.concat([pending, bytes]);
                        const parsed = parseReply(pending);
                        if (!parsed) return;
                        pending = pending.subarray(parsed.end);
                        if (parsed.value instanceof Error) { finish(parsed.value); return; }
                        if (!authenticated) {
                            if (parsed.value !== "OK") { finish(new Error("Test Redis AUTH failed")); return; }
                            authenticated = true;
                            send(arguments_);
                        } else {
                            finish(undefined, parsed.value);
                        }
                    } catch {
                        finish(new Error("Invalid test Redis reply"));
                    }
                });
            });
        },
    });
}

/**
 * TEST ONLY, preconnected RESP2 client for concurrency/multiprocess tests.
 * Commands are written immediately while connected. The bounded FIFO below
 * correlates in-flight replies; it is NOT an offline or retry queue.
 */
export async function connectRedisTestClient(port: number): Promise<RedisCommandClient & {
    close(): void;
}> {
    const socket = connect({ host: "127.0.0.1", port });
    socket.setNoDelay(true);
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            socket.destroy();
            reject(new Error("Test Redis connection timeout"));
        }, 2000);
        socket.once("error", (error) => { clearTimeout(timer); reject(error); });
        socket.once("connect", () => { clearTimeout(timer); resolve(); });
    });
    let ready = true;
    let buffer = Buffer.alloc(0);
    interface Pending {
        resolve(value: unknown): void;
        reject(error: Error): void;
        timer: ReturnType<typeof setTimeout>;
    }
    const pending: Pending[] = [];
    function close(error = new Error("Test Redis connection closed")): void {
        ready = false;
        socket.destroy();
        for (const entry of pending.splice(0)) {
            clearTimeout(entry.timer);
            entry.reject(error);
        }
    }
    socket.on("error", () => close(new Error("Test Redis connection failed")));
    socket.on("close", () => close());
    socket.on("data", (bytes: Buffer) => {
        try {
            if (buffer.length + bytes.length > 33554432 + 65536) {
                close(new Error("Test Redis reply byte limit exceeded"));
                return;
            }
            buffer = Buffer.concat([buffer, bytes]);
            while (buffer.length) {
                const reply = parseReply(buffer);
                if (!reply) return;
                buffer = buffer.subarray(reply.end);
                const entry = pending.shift();
                if (!entry) {
                    close(new Error("Unexpected test Redis reply"));
                    return;
                }
                clearTimeout(entry.timer);
                if (reply.value instanceof Error) entry.reject(reply.value);
                else entry.resolve(reply.value);
            }
        } catch {
            close(new Error("Invalid test Redis reply"));
        }
    });
    return Object.freeze({
        automaticRetries: false as const,
        offlineQueue: false as const,
        get isReady() { return ready && !socket.destroyed; },
        close() { close(); },
        sendCommand(args: readonly string[]): Promise<unknown> {
            if (!ready || socket.destroyed || pending.length >= 128) {
                return Promise.reject(new Error("Test Redis connection unavailable"));
            }
            return new Promise((resolve, reject) => {
                // If reply correlation becomes uncertain, fail every in-flight
                // command and close. Never reconnect or replay a command.
                const timer = setTimeout(() => close(new Error("Test Redis command timeout")), 2000);
                pending.push({ resolve, reject, timer });
                try {
                    const parts = [Buffer.from(`*${args.length}\r\n`)];
                    for (const argument of args) {
                        const bytes = Buffer.from(argument);
                        parts.push(Buffer.from(`$${bytes.length}\r\n`), bytes, Buffer.from("\r\n"));
                    }
                    socket.write(Buffer.concat(parts));
                } catch {
                    close(new Error("Test Redis write failed"));
                }
            });
        },
    });
}