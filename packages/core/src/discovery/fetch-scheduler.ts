import { performance } from "node:perf_hooks";
import { configuredAgentOrigin } from "../profiles/agent-origin.js";

/** Internal operational diagnostics, not additions to the verifier catalog. */
export class DirectoryAdmissionError extends Error {
    constructor(readonly reason: "capacity" | "origin-rate" | "deadline" | "clock" | "fetch-failed") {
        super(`Directory admission rejected: ${reason}`);
        this.name = "DirectoryAdmissionError";
    }
}

interface Job<T> {
    readonly origin: string;
    readonly started: number;
    readonly controller: AbortController;
    readonly promise: Promise<T>;
    readonly resolve: (value: T) => void;
    readonly reject: (error: DirectoryAdmissionError) => void;
    timer: ReturnType<typeof setTimeout> | undefined;
    active: boolean;
    settled: boolean;
}

/**
 * INTERNAL scheduler, scoped to one discovery service/network-policy partition.
 * The worker and clock are owned implementation dependencies, never public
 * transport overrides. Admission/allowlist checks must precede run().
 *
 * Workers must honor cancellation and must not mutate cache state themselves.
 * Consumers may commit only a successfully returned value, with an additional
 * final deadline check around synchronous document validation at integration.
 *
 * Coalesced callers share bounded completion; an individual caller leaving does
 * not cancel other callers. The original three-second deadline is never renewed.
 * There is no per-caller listener array or automatic retry.
 */
export class DirectoryFetchScheduler<T> {
    readonly #worker: (origin: string, signal: AbortSignal, remainingMilliseconds: number) => Promise<T>;
    readonly #clock: () => number;
    readonly #jobs = new Map<string, Job<T>>();
    readonly #queue: Job<T>[] = [];
    readonly #originStarts = new Map<string, number>();
    readonly #starts: number[] = [];
    #active = 0;
    #lastTime = 0;
    #healthy = true;
    #wake: ReturnType<typeof setTimeout> | undefined;

    constructor(
        worker: (origin: string, signal: AbortSignal, remainingMilliseconds: number) => Promise<T>,
        clock: () => number = () => performance.now(),
    ) {
        this.#worker = worker;
        this.#clock = clock;
    }

    #now(): number | undefined {
        if (!this.#healthy) return undefined;
        let now: number;
        try { now = this.#clock(); } catch { now = NaN; }
        if (!Number.isFinite(now) || now < this.#lastTime ||
            now > Number.MAX_SAFE_INTEGER - 30000) {
            this.#healthy = false;
            if (this.#wake !== undefined) clearTimeout(this.#wake);
            this.#wake = undefined;
            for (const job of this.#jobs.values()) this.#fail(job, "clock");
            return undefined;
        }
        this.#lastTime = now;
        return now;
    }

    #prune(now: number): void {
        while (this.#starts.length && now - this.#starts[0]! >= 1000) this.#starts.shift();
        for (const [origin, started] of this.#originStarts) {
            if (now - started >= 30000) this.#originStarts.delete(origin);
        }
    }

    run(originInput: string): Promise<T> {
        const origin = configuredAgentOrigin(originInput);
        const now = this.#now();
        if (now === undefined) return Promise.reject(new DirectoryAdmissionError("clock"));
        const existing = this.#jobs.get(origin);
        if (existing) {
            if (!existing.settled && now - existing.started >= 3000) this.#fail(existing, "deadline");
            return existing.promise;
        }
        this.#prune(now);
        if (this.#originStarts.has(origin)) {
            return Promise.reject(new DirectoryAdmissionError("origin-rate"));
        }
        // Never evict live cooldown records to admit attacker-chosen origins.
        // 32 starts/s over 30 s normally needs at most 960 records; the defensive
        // 1,000-record cap still fails closed under unforeseen scheduling patterns.
        if (this.#originStarts.size >= 1000 ||
            (this.#queue.length >= 64 && (this.#active >= 16 || this.#starts.length >= 32))) {
            return Promise.reject(new DirectoryAdmissionError("capacity"));
        }
        let resolve!: (value: T) => void;
        let reject!: (error: DirectoryAdmissionError) => void;
        const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
        // The owned job can expire before a caller attaches a handler.
        void promise.catch(() => { });
        const job: Job<T> = {
            origin, started: now, controller: new AbortController(), promise,
            resolve, reject, timer: undefined, active: false, settled: false,
        };
        this.#jobs.set(origin, job);
        this.#queue.push(job);
        job.timer = setTimeout(() => {
            this.#fail(job, "deadline");
            this.#pump();
        }, 3000);
        this.#pump();
        return promise;
    }

    #fail(job: Job<T>, reason: DirectoryAdmissionError["reason"]): void {
        if (job.settled) return;
        job.settled = true;
        if (job.timer !== undefined) clearTimeout(job.timer);
        job.reject(new DirectoryAdmissionError(reason));
        job.controller.abort();
        if (!job.active) {
            const index = this.#queue.indexOf(job);
            if (index >= 0) this.#queue.splice(index, 1);
            this.#jobs.delete(job.origin);
        }
        // Active slots and origin ownership remain until the actual worker
        // settles. Abort alone is not proof that underlying I/O has stopped.
    }

    #pump(): void {
        if (this.#wake !== undefined) clearTimeout(this.#wake);
        this.#wake = undefined;
        for (; ;) {
            // A worker can spend time synchronously before its first await.
            // Reusing the previous dispatch's sample would shorten the next
            // origin's cooldown and misdate its sliding-window start record.
            const now = this.#now();
            if (now === undefined) return;
            this.#prune(now);
            for (const job of [...this.#queue]) {
                if (now - job.started >= 3000) this.#fail(job, "deadline");
            }
            if (!this.#queue.length || this.#active >= 16) return;
            if (this.#starts.length >= 32) {
                this.#wake = setTimeout(() => this.#pump(),
                    Math.max(1, Math.ceil(this.#starts[0]! + 1000 - now)));
                return;
            }
            if (this.#originStarts.size >= 1000) {
                this.#fail(this.#queue[0]!, "capacity");
                continue;
            }
            const job = this.#queue.shift()!;
            job.active = true;
            this.#active++;
            this.#starts.push(now);
            this.#originStarts.set(job.origin, now);
            void this.#execute(job);
        }
    }

    async #execute(job: Job<T>): Promise<void> {
        try {
            const now = this.#now();
            if (now === undefined || job.settled) return;
            const remaining = Math.floor(3000 - (now - job.started));
            if (remaining <= 0) { this.#fail(job, "deadline"); return; }
            const value = await this.#worker(job.origin, job.controller.signal, remaining);
            const completed = this.#now();
            if (job.settled) return;
            if (completed === undefined) { this.#fail(job, "clock"); return; }
            if (completed - job.started >= 3000) { this.#fail(job, "deadline"); return; }
            job.settled = true;
            if (job.timer !== undefined) clearTimeout(job.timer);
            job.resolve(value);
        } catch {
            // Do not propagate arbitrary transport errors, body data or labels.
            this.#fail(job, "fetch-failed");
        } finally {
            this.#active--;
            this.#jobs.delete(job.origin);
            this.#pump();
        }
    }

    get stats(): Readonly<{
        active: number; queued: number; trackedOrigins: number; recentStarts: number;
    }> {
        return Object.freeze({
            active: this.#active, queued: this.#queue.length,
            trackedOrigins: this.#originStarts.size, recentStarts: this.#starts.length,
        });
    }
}