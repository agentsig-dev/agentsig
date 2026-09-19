import { performance } from "node:perf_hooks";
import { canonicalAgentOrigin, configuredAgentOrigin } from "../profiles/agent-origin.js";
import { ProfileConfigurationError } from "../profiles/codes.js";
import {
    assertDirectoryAddressPolicy, defaultDirectoryAddressPolicy,
} from "./address-policy.js";
import type { DirectoryAddressPolicy } from "./address-policy.js";
import { resolveDirectoryAddresses } from "./dns-resolution.js";
import { connectPinnedDirectoryTls } from "./pinned-tls.js";
import { connectDirectoryThroughProxy } from "./proxy-tls.js";
import type { DirectoryHttpsProxy } from "./proxy-tls.js";
import { readDirectoryResponse } from "./directory-response.js";
import type { DirectoryResponse } from "./directory-response.js";

export class DirectoryFetchError extends Error {
    constructor(readonly reason: "origin-denied" | "total-timeout" | "aborted") {
        super(`Directory fetch rejected: ${reason}`);
        this.name = "DirectoryFetchError";
    }
}

export interface DirectoryFetchOptions {
    readonly mode?: "allowlist" | "open";
    readonly allowedOrigins?: readonly string[];
    readonly policy?: DirectoryAddressPolicy;
    readonly proxy?: DirectoryHttpsProxy;
    readonly ca?: string;
    readonly totalMilliseconds?: number;
    readonly signal?: AbortSignal;
}

/**
 * Internal test seam, not a public transport-injection option. Production entry
 * points must never forward request data or application overrides into it.
 */
export interface DirectoryFetchDependencies {
    readonly resolve: typeof resolveDirectoryAddresses;
    readonly direct: typeof connectPinnedDirectoryTls;
    readonly proxy: typeof connectDirectoryThroughProxy;
    readonly read: typeof readDirectoryResponse;
}
const production: DirectoryFetchDependencies = Object.freeze({
    resolve: resolveDirectoryAddresses,
    direct: connectPinnedDirectoryTls,
    proxy: connectDirectoryThroughProxy,
    read: readDirectoryResponse,
});

/**
 * One bounded fetch, without retries, pooling, caching or authentication claims.
 * Callers must also bound aggregate admission/queueing before invoking this.
 * A successful response is untrusted bytes until the entire JWKS is validated.
 */
export async function fetchDirectoryOnce(
    originInput: string,
    options: DirectoryFetchOptions = {},
    dependencies: DirectoryFetchDependencies = production,
): Promise<DirectoryResponse> {
    const started = performance.now();
    const total = options.totalMilliseconds ?? 3000;
    const mode = options.mode ?? "allowlist";
    const policy = options.policy ?? defaultDirectoryAddressPolicy;
    const signal = options.signal;
    const ca = options.ca;
    // Copy trusted configuration before the first asynchronous stage.
    const proxy = options.proxy === undefined ? undefined : Object.freeze({ ...options.proxy });
    if (!Number.isSafeInteger(total) || total <= 0 || total > 3000) {
        throw new ProfileConfigurationError("invalid-resource-limits");
    }
    if (mode !== "allowlist" && mode !== "open") {
        throw new ProfileConfigurationError("invalid-agent-binding");
    }
    assertDirectoryAddressPolicy(policy);
    if (ca !== undefined && (typeof ca !== "string" || !ca.length)) {
        throw new ProfileConfigurationError("invalid-key-configuration");
    }
    const suppliedOrigins = options.allowedOrigins ?? [];
    if (!Array.isArray(suppliedOrigins) || suppliedOrigins.length > 1000) {
        throw new ProfileConfigurationError("invalid-agent-binding");
    }
    const allowed = suppliedOrigins.map((value) => configuredAgentOrigin(value));
    const origin = canonicalAgentOrigin(originInput);
    if (mode === "allowlist" && !allowed.includes(origin)) {
        throw new DirectoryFetchError("origin-denied");
    }
    const hostname = new URL(origin).hostname;
    if (signal?.aborted) throw new DirectoryFetchError("aborted");

    const controller = new AbortController();
    let timedOut = false;
    let rejectStop!: (error: DirectoryFetchError) => void;
    const stopped = new Promise<never>((_, reject) => { rejectStop = reject; });
    // Install a handler even if admission already exhausted the budget before
    // the first race. Late phase results must never become unhandled rejections.
    void stopped.catch(() => { });
    const remaining = (): number => {
        if (signal?.aborted) throw new DirectoryFetchError("aborted");
        const value = Math.floor(total - (performance.now() - started));
        if (timedOut || value <= 0) throw new DirectoryFetchError("total-timeout");
        return value;
    };
    const stop = (reason: "aborted" | "total-timeout") => {
        if (controller.signal.aborted) return;
        if (reason === "total-timeout") timedOut = true;
        rejectStop(new DirectoryFetchError(reason));
        controller.abort();
    };
    const abort = () => stop("aborted");
    const timer = setTimeout(() => stop("total-timeout"), Math.max(1, total - (performance.now() - started)));
    signal?.addEventListener("abort", abort, { once: true });
    let socket: Awaited<ReturnType<typeof connectPinnedDirectoryTls>> | undefined;
    try {
        if (signal?.aborted) stop("aborted");
        const addresses = await Promise.race([
            dependencies.resolve(hostname, Math.min(1000, remaining()), 16, undefined, policy),
            stopped,
        ]);
        remaining();
        const selected = addresses[0];
        if (!selected) throw new Error("Validated DNS returned no directory address");
        const connectionOptions = {
            hostname, address: selected.address, family: selected.family, policy,
            timeoutMilliseconds: Math.min(1000, remaining()),
            signal: controller.signal,
            ...(ca === undefined ? {} : { ca }),
        };
        const connecting = proxy === undefined
            ? dependencies.direct(connectionOptions)
            : dependencies.proxy(connectionOptions, proxy);
        // If cancellation wins after a connector has resolved but before its
        // continuation is observed, destroy that late socket instead of leaking it.
        void connecting.then((stream) => {
            if (controller.signal.aborted) stream.destroy();
        }, () => { });
        socket = await Promise.race([connecting, stopped]);
        const response = await Promise.race([
            dependencies.read(socket, hostname, {
                remainingMilliseconds: remaining(),
                headersMilliseconds: 1000,
                bodyIdleMilliseconds: 500,
                maxHeaderBytes: 16384,
                maxBodyBytes: 262144,
                signal: controller.signal,
            }),
            stopped,
        ]);
        remaining(); // Final monotonic deadline check; timers may run late.
        return response;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        controller.abort();
        socket?.destroy();
        // DNS owns a <=1 s deadline and cancels its resolver independently.
        // An uncancellable late resolution cannot reach the dial stage here.
    }
}