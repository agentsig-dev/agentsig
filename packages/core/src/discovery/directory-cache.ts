import { performance } from "node:perf_hooks";
import { configuredAgentOrigin } from "../profiles/agent-origin.js";
import { ProfileConfigurationError } from "../profiles/codes.js";
import type { LoadedVerificationKey } from "../profiles/jwks.js";
import type { JwksFormat } from "../profiles/jwks-algorithm.js";
import { parseDirectoryDocument } from "./directory-document.js";
import type { DirectoryDocument } from "./directory-document.js";
import type { DirectoryResponse } from "./directory-response.js";
import {
    calculateDirectoryFreshness, isDirectoryFresh, resolveDirectoryFreshnessPolicy,
} from "./freshness.js";
import type { DirectoryFreshness, DirectoryFreshnessPolicy } from "./freshness.js";

export interface DirectoryCacheOptions extends Partial<DirectoryFreshnessPolicy> {
    readonly negativeSeconds?: number;
    readonly maxPositiveEntries?: number;
    readonly maxPositiveAccountedBytes?: number;
    readonly maxNegativeEntries?: number;
}

export interface DirectoryKeySelection {
    readonly origin: string;
    readonly key: LoadedVerificationKey;
}

/** Opaque internal preparation handle; only its owning cache may commit it. */
export interface PreparedDirectoryEntry {
    readonly prepared: true;
}

interface Entry {
    readonly document: DirectoryDocument;
    readonly freshness: DirectoryFreshness;
    readonly accountedBytes: number;
}

export type DirectoryCacheLookup =
    | { readonly status: "found"; readonly selection: DirectoryKeySelection }
    | { readonly status: "missing"; readonly reason: "unknown-key" | "unsupported-algorithm" };

const ceilings = {
    negativeSeconds: 300,
    maxPositiveEntries: 1000,
    maxPositiveAccountedBytes: 16777216,
    maxNegativeEntries: 1000,
} as const;

function configuration(input: DirectoryCacheOptions) {
    const invalid = (): never => {
        throw new ProfileConfigurationError("invalid-resource-limits");
    };
    if (!input || typeof input !== "object" || Array.isArray(input)) return invalid();
    const result = {
        negativeSeconds: 60, maxPositiveEntries: 1000,
        maxPositiveAccountedBytes: 16777216, maxNegativeEntries: 1000,
    };
    const freshness: Partial<Record<keyof DirectoryFreshnessPolicy, number>> = {};
    for (const name of Reflect.ownKeys(input)) {
        const field = Object.getOwnPropertyDescriptor(input, name);
        if (!field || !Object.hasOwn(field, "value")) return invalid();
        const value: unknown = field.value;
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return invalid();
        if (name === "fallbackSeconds" || name === "maximumLifetimeSeconds") {
            freshness[name] = value;
        } else {
            if (typeof name !== "string" || !Object.hasOwn(ceilings, name)) return invalid();
            const key = name as keyof typeof ceilings;
            if (value > ceilings[key]) return invalid();
            result[key] = value;
        }
    }
    return Object.freeze({ ...result, freshness: resolveDirectoryFreshnessPolicy(freshness) });
}

/**
 * INTERNAL, one trusted format/network-policy partition per instance.
 * No public arbitrary clock, response, or document injection is exposed.
 * The coordinator owns serial fetches per origin; this class does not establish
 * transport provenance or reorder concurrently fetched responses.
 */
export class DirectoryCache {
    readonly #format: JwksFormat;
    readonly #options: ReturnType<typeof configuration>;
    readonly #clock: () => number;
    readonly #positive = new Map<string, Entry>();
    readonly #negative = new Map<string, number>();
    readonly #prepared = new WeakMap<PreparedDirectoryEntry, {
        readonly document: DirectoryDocument; readonly freshness: DirectoryFreshness;
    }>();
    readonly #selections = new WeakMap<DirectoryKeySelection, {
        readonly origin: string; readonly thumbprint: string;
    }>();
    #bytes = 0;
    #lastTime = 0;
    #healthy = true;
    #overflowUntil = 0;

    constructor(
        format: JwksFormat,
        options: DirectoryCacheOptions = {},
        clock: () => number = () => performance.now(),
    ) {
        if (format !== "jwks" && format !== "wg-directory-00") {
            throw new ProfileConfigurationError("invalid-agent-binding");
        }
        this.#format = format;
        this.#options = configuration(options);
        this.#clock = clock;
    }

    #now(): number | undefined {
        if (!this.#healthy) return undefined;
        let now: number;
        try { now = this.#clock(); } catch { this.#healthy = false; return undefined; }
        if (!Number.isFinite(now) || now < this.#lastTime || now > Number.MAX_SAFE_INTEGER) {
            // Never rebase on regression: old evidence must not regain lifetime.
            this.#healthy = false;
            return undefined;
        }
        this.#lastTime = now;
        return now;
    }

    #remove(origin: string): void {
        const entry = this.#positive.get(origin);
        if (entry) {
            this.#bytes -= entry.accountedBytes;
            this.#positive.delete(origin);
        }
    }

    /**
     * Validate without changing cache state. The discovery coordinator checks
     * its original total deadline AFTER this synchronous parsing/import work
     * and BEFORE committing. A parsed document alone is not transport evidence.
     */
    prepare(response: DirectoryResponse): PreparedDirectoryEntry {
        const document = parseDirectoryDocument(response.body, this.#format);
        const freshness = calculateDirectoryFreshness(response, this.#options.freshness);
        const ticket: PreparedDirectoryEntry = Object.freeze({ prepared: true });
        this.#prepared.set(ticket, { document, freshness });
        return ticket;
    }

    replace(originInput: string, response: DirectoryResponse): boolean {
        const origin = configuredAgentOrigin(originInput);
        return this.commit(origin, this.prepare(response));
    }

    /**
     * Internal single-use commit. The coordinator serializes fetches per origin
     * and must check its deadline immediately before calling this method.
     * No await/callback separates removing the old set from its replacement.
     * Returns persistence only, not authentication or even key presence.
     */
    commit(originInput: string, ticket: PreparedDirectoryEntry): boolean {
        const origin = configuredAgentOrigin(originInput);
        const prepared = this.#prepared.get(ticket);
        if (!prepared) throw new Error("Invalid or consumed directory preparation");
        this.#prepared.delete(ticket);
        const { document, freshness } = prepared;
        const now = this.#now();
        if (now === undefined) return false;
        // A valid newer set is authoritative removal evidence even if no-store,
        // already stale, or too large for this cache. Never retain the older set
        // as a usable fallback merely because the replacement cannot be retained.
        this.#remove(origin);
        this.#negative.delete(origin);
        const accountedBytes = document.accountedBytes + origin.length * 2 + 256;
        if (!freshness.persist || this.#options.maxPositiveEntries === 0 ||
            accountedBytes > this.#options.maxPositiveAccountedBytes ||
            freshness.receivedMonotonicMs > now) return false;

        // FIFO eviction affects availability only. Final checks require current
        // fresh evidence; eviction alone is not a permanent key revocation.
        while (this.#positive.size >= this.#options.maxPositiveEntries ||
            this.#bytes + accountedBytes > this.#options.maxPositiveAccountedBytes) {
            const oldest = this.#positive.keys().next().value as string | undefined;
            if (oldest === undefined) return false;
            this.#remove(oldest);
        }
        this.#positive.set(origin, Object.freeze({ document, freshness, accountedBytes }));
        this.#bytes += accountedBytes;
        return true;
    }

    lookup(originInput: string, thumbprint: string): DirectoryCacheLookup {
        const origin = configuredAgentOrigin(originInput);
        const now = this.#now();
        const entry = this.#positive.get(origin);
        if (now === undefined || !entry || !isDirectoryFresh(entry.freshness, now)) {
            return { status: "missing", reason: "unknown-key" };
        }
        const result = entry.document.jwks.lookup(thumbprint);
        if (result.status !== "found") return { status: "missing", reason: result.reason };
        const selection = Object.freeze({ origin, key: result.key });
        this.#selections.set(selection, { origin, thumbprint: result.key.thumbprint });
        return Object.freeze({ status: "found", selection });
    }

    /** Call synchronously at the final verifier gate, after every awaited phase. */
    recheck(selection: DirectoryKeySelection): boolean {
        const selected = this.#selections.get(selection);
        const now = this.#now();
        if (!selected || now === undefined) return false;
        const current = this.#positive.get(selected.origin);
        // RFC 7638 identifies key material, not cache generations or KeyObjects.
        // Refreshing a set that retains the selected key must not reject an
        // otherwise valid request. Reintroduction may likewise pass, but only
        // with current fresh, fully validated evidence at this same origin.
        // Signature identity, crypto, time and replay remain verifier obligations.
        if (!current || !isDirectoryFresh(current.freshness, now)) return false;
        const key = current.document.jwks.lookup(selected.thumbprint);
        return key.status === "found" && key.key.thumbprint === selected.thumbprint;
    }

    /** Operational backoff only; does not erase evidence or label crypto invalid. */
    recordFailure(originInput: string): void {
        const origin = configuredAgentOrigin(originInput);
        const now = this.#now();
        if (now === undefined) return;
        this.#pruneNegative(now);
        const duration = this.#options.negativeSeconds * 1000;
        if (duration === 0) return;
        const deadline = now + duration;
        if (!Number.isFinite(deadline) || deadline > Number.MAX_SAFE_INTEGER) {
            this.#healthy = false;
            return;
        }
        if (this.#negative.has(origin) ||
            this.#negative.size < this.#options.maxNegativeEntries) {
            this.#negative.set(origin, Math.max(deadline, this.#negative.get(origin) ?? 0));
        } else {
            // Do not evict a live backoff and let a random-origin flood reopen it.
            // A bounded scalar global backoff trades availability for protection.
            this.#overflowUntil = Math.max(this.#overflowUntil, deadline);
        }
    }

    #pruneNegative(now: number): void {
        for (const [origin, deadline] of this.#negative) {
            if (now >= deadline) this.#negative.delete(origin);
        }
    }

    fetchBlocked(originInput: string): boolean {
        const origin = configuredAgentOrigin(originInput);
        const now = this.#now();
        if (now === undefined) return true;
        this.#pruneNegative(now);
        return now < this.#overflowUntil || now < (this.#negative.get(origin) ?? 0);
    }

    get stats(): Readonly<{
        positiveEntries: number; positiveAccountedBytes: number; negativeEntries: number;
    }> {
        return Object.freeze({
            positiveEntries: this.#positive.size,
            positiveAccountedBytes: this.#bytes,
            negativeEntries: this.#negative.size,
        });
    }
}