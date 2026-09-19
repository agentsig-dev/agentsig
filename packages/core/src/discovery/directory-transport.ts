import { performance } from "node:perf_hooks";
import { DirectoryDnsError } from "./dns-resolution.js";
import { DirectoryConnectionError } from "./pinned-tls.js";
import { fetchDirectoryOnce } from "./fetch-directory.js";
import type { DirectoryFetchOptions } from "./fetch-directory.js";
import type { DirectoryResponse } from "./directory-response.js";
import { snapshotDirectoryFetchOptions } from "./fetch-configuration.js";
import type { ResolvedDirectoryFetchOptions } from "./fetch-configuration.js";
import { DirectoryAdmissionError, DirectoryFetchScheduler } from "./fetch-scheduler.js";

/**
 * Owned synchronous cache preparation only, never an application observer.
 * Preparation must not mutate cache state. Returned commits must not await,
 * invoke observers, or perform additional document parsing.
 */
export type DirectoryResponseParticipant = (
    origin: string, response: DirectoryResponse,
) => () => void;

export type DirectoryTransportResult =
    | { readonly outcome: "response"; readonly response: DirectoryResponse }
    | { readonly outcome: "failed"; readonly reason: "address-denied" | "transport-failed" };

/**
 * INTERNAL transport coordinator. Share this object across profile partitions,
 * never a profile's parsed key set. One scheduler owns concurrency, queue,
 * sliding start rate, origin cooldown, cancellation and the original deadline.
 *
 * The context registry must enforce identical network trust configuration before
 * sharing this instance. A response fetched using another CA/proxy/address policy
 * is not automatically evidence for a stricter caller.
 */
export class DirectoryTransport {
    readonly network: Readonly<ResolvedDirectoryFetchOptions>;
    readonly clock: () => number;
    readonly #scheduler: DirectoryFetchScheduler<DirectoryTransportResult>;
    readonly #participants: DirectoryResponseParticipant[] = [];
    readonly #deliveries = new WeakMap<Promise<DirectoryTransportResult>, Promise<DirectoryTransportResult>>();
    #started = false;
    #lastTime = 0;
    #healthy = true;

    constructor(
        options: DirectoryFetchOptions = {},
        transport: typeof fetchDirectoryOnce = fetchDirectoryOnce,
        clock: () => number = () => performance.now(),
    ) {
        this.network = snapshotDirectoryFetchOptions(options);
        this.clock = clock;
        this.#scheduler = new DirectoryFetchScheduler(async (origin, signal, remaining) => {
            try {
                const response = await transport(origin, {
                    ...this.network, signal, totalMilliseconds: remaining,
                });
                return { outcome: "response", response } as const;
            } catch (error) {
                // Expose fixed owned classifications only; never retain the
                // original exception, remote body, or backend message.
                const denied = (error instanceof DirectoryDnsError ||
                    error instanceof DirectoryConnectionError) && error.reason === "address-denied";
                return {
                    outcome: "failed",
                    reason: denied ? "address-denied" : "transport-failed",
                } as const;
            }
        }, clock);
        Object.freeze(this);
    }

    register(participant: DirectoryResponseParticipant): void {
        // Registration is construction-only and bounded by the two profiles.
        // Do not let a later subscriber miss an already committed replacement.
        if (this.#started || this.#participants.length >= 2) {
            throw new Error("Directory response participants are already fixed");
        }
        this.#participants.push(participant);
    }

    #checkDeadline(startedAt: number): void {
        let now: number;
        try { now = this.clock(); } catch { now = NaN; }
        if (!this.#healthy || !Number.isFinite(now) || now < this.#lastTime ||
            now > Number.MAX_SAFE_INTEGER - 3000) {
            this.#healthy = false;
            throw new DirectoryAdmissionError("clock");
        }
        this.#lastTime = now;
        if (now < startedAt || now - startedAt >= 3000) {
            throw new DirectoryAdmissionError("deadline");
        }
    }

    run(origin: string, startedAt: number): Promise<DirectoryTransportResult> {
        this.#started = true;
        const pending = this.#scheduler.run(origin, startedAt);
        const existing = this.#deliveries.get(pending);
        if (existing) return existing;
        const delivery = pending.then((result) => {
            this.#checkDeadline(startedAt);
            if (result.outcome === "response") {
                // Each profile validates independently. No cache changes until
                // ALL preparations finish within the original shared deadline.
                const commits = this.#participants.map((prepare) =>
                    prepare(origin, result.response));
                this.#checkDeadline(startedAt);
                // No await or observer can expose a half-distributed response.
                for (const commit of commits) commit();
            }
            return result;
        });
        void delivery.catch(() => { });
        this.#deliveries.set(pending, delivery);
        return delivery;
    }

    get stats() {
        return this.#scheduler.stats;
    }
}