import { performance } from "node:perf_hooks";
import { canonicalAgentOrigin } from "../profiles/agent-origin.js";
import { ProfileConfigurationError } from "../profiles/codes.js";
import { createObserverDelivery } from "../profiles/context-observer.js";
import type { ObserverDelivery } from "../profiles/context-observer.js";
import type { JwksFormat } from "../profiles/jwks-algorithm.js";
import { validateProfileKeyId } from "../profiles/metadata.js";
import { DirectoryCache } from "./directory-cache.js";
import type { DirectoryCacheOptions, DirectoryKeySelection } from "./directory-cache.js";
import { DirectoryDocumentError } from "./directory-document.js";
import type { DirectoryDocumentDiagnostic } from "./directory-document.js";
import { DirectoryTransport } from "./directory-transport.js";
import type { DirectoryResponse } from "./directory-response.js";
import { fetchDirectoryOnce } from "./fetch-directory.js";
import type { DirectoryFetchOptions } from "./fetch-directory.js";
import { snapshotDirectoryFetchOptions } from "./fetch-configuration.js";
import type { ResolvedDirectoryFetchOptions } from "./fetch-configuration.js";
import { DirectoryAdmissionError } from "./fetch-scheduler.js";

type RefreshFailure =
    | "invalid-jwks" | "address-denied" | "transport-failed" | "deadline"
    | "clock" | "origin-denied" | "backoff" | "capacity" | "origin-rate";

export type DirectoryRefreshResult =
    | { readonly outcome: "completed"; readonly persisted: boolean }
    | {
        readonly outcome: "failed";
        readonly reason: RefreshFailure;
        readonly diagnostic?: Readonly<DirectoryDocumentDiagnostic>;
    };

export type DirectoryRefreshEvent = DirectoryRefreshResult & {
    readonly origin: string;
};

export interface DirectoryServiceOptions {
    readonly format: JwksFormat;
    readonly network?: Omit<DirectoryFetchOptions, "signal" | "totalMilliseconds">;
    readonly cache?: DirectoryCacheOptions;
    /** Synchronous, fixed observer. Enqueue asynchronous logging outside this callback. */
    readonly onRefresh?: (event: Readonly<DirectoryRefreshEvent>) => void;
}

export type DirectoryResolution =
    | { readonly status: "found"; readonly selection: DirectoryKeySelection }
    | {
        readonly status: "missing";
        readonly reason: "unknown-key" | "unsupported-algorithm" | "resource-limit";
    };

/** Invocation-owned capability shared by ALL candidates and profile partitions. */
export interface DirectoryFetchBudget { readonly maximumFetches: 1 }
const budgets = new WeakMap<DirectoryFetchBudget, boolean>();

export function createDirectoryFetchBudget(): DirectoryFetchBudget {
    const budget: DirectoryFetchBudget = Object.freeze({ maximumFetches: 1 });
    budgets.set(budget, false);
    return budget;
}

function spend(budget: DirectoryFetchBudget): boolean {
    if (budgets.get(budget) !== false) return false;
    budgets.set(budget, true);
    return true;
}

function failed(reason: RefreshFailure, diagnostic?: Readonly<DirectoryDocumentDiagnostic>): DirectoryRefreshResult {
    return Object.freeze({
        outcome: "failed", reason,
        ...(diagnostic === undefined ? {} : { diagnostic }),
    });
}

/**
 * INTERNAL integrated discovery service. No public response/clock/transport
 * injection: constructor dependencies below are exclusively internal test seams.
 * Each instance owns a format-specific validated cache. The context registry
 * supplies one shared transport after checking network-policy compatibility.
 * Standalone internal instances retain their own transport for isolated tests.
 */
export class DirectoryService {
    readonly #network: Readonly<ResolvedDirectoryFetchOptions>;
    readonly #cache: DirectoryCache;
    readonly #transport: DirectoryTransport;
    readonly #observer: ObserverDelivery<DirectoryRefreshEvent>;
    readonly #clock: () => number;
    readonly #pending = new Map<string, Promise<DirectoryRefreshResult>>();
    readonly #appliedResponses = new WeakMap<DirectoryResponse, DirectoryRefreshResult>();
    #lastTime = 0;
    #healthy = true;

    constructor(
        options: DirectoryServiceOptions,
        transport: typeof fetchDirectoryOnce = fetchDirectoryOnce,
        clock: () => number = () => performance.now(),
        sharedTransport?: DirectoryTransport,
    ) {
        // Snapshot top-level data without invoking ordinary accessors.
        if (!options || typeof options !== "object" || Array.isArray(options)) {
            throw new ProfileConfigurationError("invalid-agent-binding");
        }
        const own: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
        for (const name of Reflect.ownKeys(options)) {
            const property = Object.getOwnPropertyDescriptor(options, name);
            if (typeof name !== "string" || !["format", "network", "cache", "onRefresh"].includes(name) ||
                !property || !Object.hasOwn(property, "value")) {
                throw new ProfileConfigurationError("invalid-agent-binding");
            }
            own[name] = property.value as unknown;
        }
        if (own.onRefresh !== undefined && typeof own.onRefresh !== "function") {
            throw new ProfileConfigurationError("invalid-agent-binding");
        }
        // The service owns per-fetch cancellation and the fixed total deadline.
        if (own.network && typeof own.network === "object" &&
            (Object.hasOwn(own.network, "signal") || Object.hasOwn(own.network, "totalMilliseconds"))) {
            throw new ProfileConfigurationError("invalid-agent-binding");
        }
        this.#network = snapshotDirectoryFetchOptions(own.network as DirectoryFetchOptions | undefined);
        // Shared transport and cache must use the same monotonic time domain;
        // verification-clock resets must never rebase it.
        this.#clock = sharedTransport?.clock ?? clock;
        this.#cache = new DirectoryCache(own.format as JwksFormat,
            own.cache as DirectoryCacheOptions | undefined, this.#clock);
        this.#observer = createObserverDelivery(
            own.onRefresh as DirectoryServiceOptions["onRefresh"],
        );
        // This argument is internal only. The context registry establishes
        // compatibility before allowing a service to share response bytes.
        this.#transport = sharedTransport ?? new DirectoryTransport(this.#network, transport, this.#clock);
        this.#transport.register((origin, response) => {
            // Preparation never changes evidence. The shared transport checks
            // its original deadline after EVERY profile has finished parsing.
            try {
                const ticket = this.#cache.prepare(response);
                return () => {
                    const persisted = this.#cache.commit(origin, ticket);
                    this.#appliedResponses.set(response,
                        Object.freeze({ outcome: "completed", persisted }));
                };
            } catch (error) {
                if (!(error instanceof DirectoryDocumentError)) throw error;
                const result = failed("invalid-jwks", error.diagnostic);
                return () => {
                    // Invalid under this profile does not constitute removal
                    // evidence, even if another profile accepts the same bytes.
                    this.#cache.recordFailure(origin);
                    this.#appliedResponses.set(response, result);
                };
            }
        });
    }

    #now(): number | undefined {
        if (!this.#healthy) return undefined;
        let now: number;
        try { now = this.#clock(); } catch { now = NaN; }
        if (!Number.isFinite(now) || now < this.#lastTime || now > Number.MAX_SAFE_INTEGER - 3000) {
            this.#healthy = false;
            return undefined;
        }
        this.#lastTime = now;
        return now;
    }

    #admitted(origin: string): boolean {
        return this.#network.mode === "open" || this.#network.allowedOrigins.includes(origin);
    }

    /** Explicit refresh remains subject to the same admission/backoff/rate limits. */
    refresh(originInput: string): Promise<DirectoryRefreshResult> {
        const origin = canonicalAgentOrigin(originInput);
        if (this.#observer.delivering) return Promise.resolve(failed("capacity"));
        if (!this.#admitted(origin)) return Promise.resolve(failed("origin-denied"));
        const started = this.#now();
        if (started === undefined) return Promise.resolve(failed("clock"));
        const existing = this.#pending.get(origin);
        if (existing) return existing;
        if (this.#cache.fetchBlocked(origin)) return Promise.resolve(failed("backoff"));
        if (this.#pending.size >= 80) return Promise.resolve(failed("capacity"));

        // Register ownership before invoking even an internal transport worker.
        // All callers share validation, cache commit, and exactly one event.
        const task = Promise.resolve().then(() => this.#refresh(origin, started)).finally(() => {
            this.#pending.delete(origin);
        });
        this.#pending.set(origin, task);
        return task;
    }

    async #refresh(origin: string, started: number): Promise<DirectoryRefreshResult> {
        let result: DirectoryRefreshResult;
        let recordFailure = false;
        try {
            const before = this.#now();
            if (before === undefined || before - started >= 3000) {
                return failed(before === undefined ? "clock" : "deadline");
            }
            const fetched = await this.#transport.run(origin, started);
            const received = this.#now();
            if (received === undefined || received - started >= 3000) {
                result = failed(received === undefined ? "clock" : "deadline");
                recordFailure = true;
            } else if (fetched.outcome === "failed") {
                result = failed(fetched.reason);
                recordFailure = true;
            } else {
                // The shared transport has already prepared all profile views,
                // checked its deadline and committed each valid view once.
                // Never parse/commit again for a coalesced caller.
                const applied = this.#appliedResponses.get(fetched.response);
                if (!applied) throw new Error("Missing directory response application");
                result = applied;
            }
        } catch (error) {
            if (error instanceof DirectoryDocumentError) {
                result = failed("invalid-jwks", error.diagnostic);
                recordFailure = true;
            } else if (error instanceof DirectoryAdmissionError) {
                result = failed(error.reason === "fetch-failed" ? "transport-failed" : error.reason);
                recordFailure = error.reason === "deadline" || error.reason === "fetch-failed";
            } else {
                // Internal transport/parser faults remain failures, never evidence.
                result = failed("transport-failed");
                recordFailure = true;
            }
        }
        if (recordFailure) this.#cache.recordFailure(origin);
        // State is final before observer delivery. Throwing cannot roll it back.
        this.#observer.emit(Object.freeze({ ...result, origin }));
        return result;
    }

    async resolve(originInput: string, thumbprint: string, budget: DirectoryFetchBudget): Promise<DirectoryResolution> {
        const origin = canonicalAgentOrigin(originInput);
        validateProfileKeyId(thumbprint);
        if (this.#observer.delivering) return { status: "missing", reason: "resource-limit" };
        if (!this.#admitted(origin) || this.#now() === undefined) {
            return { status: "missing", reason: "unknown-key" };
        }
        const cached = this.#cache.lookup(origin, thumbprint);
        if (cached.status === "found" || cached.reason === "unsupported-algorithm") return cached;
        if (this.#cache.fetchBlocked(origin)) return { status: "missing", reason: "unknown-key" };
        // Joining someone else's fetch also spends this invocation's allowance:
        // a caller cannot use coalescing to request arbitrarily many origins.
        if (!spend(budget)) return { status: "missing", reason: "resource-limit" };
        const refresh = await this.refresh(origin);
        const current = this.#cache.lookup(origin, thumbprint);
        if (current.status === "found" || current.reason === "unsupported-algorithm") return current;
        return {
            status: "missing",
            reason: refresh.outcome === "failed" && refresh.reason === "capacity"
                ? "resource-limit" : "unknown-key",
        };
    }

    /** Synchronous final membership gate; never invokes the observer or fetches. */
    recheck(selection: DirectoryKeySelection): boolean {
        return !this.#observer.delivering && this.#now() !== undefined &&
            this.#admitted(selection.origin) && this.#cache.recheck(selection);
    }

    get stats() {
        return Object.freeze({
            ...this.#cache.stats, ...this.#transport.stats,
            pendingRefreshes: this.#pending.size,
            observerErrorCount: this.#observer.observerErrorCount,
        });
    }
}