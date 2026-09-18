/** Per-operation budgets; these are local resource policies, not RFC maxima. */
export interface Limits {
    readonly maxInputBytes: number;
    readonly maxOutputBytes: number;
    readonly maxMembers: number;
    readonly maxInnerListItems: number;
    readonly maxParameters: number;
    readonly maxKeyLength: number;
    readonly maxTokenLength: number;
    readonly maxDecodedBytes: number;
    readonly maxTotalOccurrences: number;
}

/**
 * Finite defaults bound attacker-controlled work (RFC 9651 §6).
 * Aggregate budgets may reject input even when every individual limit passes.
 */
export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({
    maxInputBytes: 1_048_576,
    maxOutputBytes: 1_048_576,
    maxMembers: 1_024,
    maxInnerListItems: 256,
    maxParameters: 256,
    maxKeyLength: 1_024,
    maxTokenLength: 8_192,
    maxDecodedBytes: 65_536,
    maxTotalOccurrences: 65_536,
});

export type LimitName = keyof Limits;

/** Resource exhaustion is distinguishable from invalid wire syntax. */
export class SfLimitError extends Error {
    readonly code = "SF_LIMIT_EXCEEDED" as const;

    constructor(
        readonly limit: LimitName,
        readonly maximum: number,
        readonly observed: number,
    ) {
        // Do not include untrusted field contents in errors or logs.
        super(`${limit} exceeded: observed ${observed}, maximum ${maximum}`);
        this.name = "SfLimitError";
    }
}

/** Invalid configuration is a caller error, not a malformed HTTP field. */
export class SfConfigurationError extends Error {
    readonly code = "SF_INVALID_LIMITS" as const;

    constructor(readonly option: string) {
        super(`Invalid resource limit configuration: ${option}`);
        this.name = "SfConfigurationError";
    }
}

/**
 * Resolve per-call overrides without mutating defaults or the caller's object.
 * Zero is allowed for intentionally disabled capabilities; Infinity is not.
 */
export function resolveLimits(overrides: Partial<Limits> = {}): Readonly<Limits> {
    if (overrides === null || typeof overrides !== "object" || Array.isArray(overrides)) {
        throw new SfConfigurationError("limits");
    }
    for (const key of Reflect.ownKeys(overrides)) {
        if (typeof key !== "string" || !Object.hasOwn(DEFAULT_LIMITS, key)) {
            throw new SfConfigurationError(String(key));
        }
    }
    const resolved = { ...DEFAULT_LIMITS, ...overrides };
    for (const key of Object.keys(DEFAULT_LIMITS) as LimitName[]) {
        const value = resolved[key];
        if (!Number.isSafeInteger(value) || value < 0) {
            throw new SfConfigurationError(key);
        }
    }
    return Object.freeze(resolved);
}

/** Internal operation-local accounting shared by parsing and serialization. */
export class Budget {
    readonly limits: Readonly<Limits>;
    private occurrences = 0;

    constructor(overrides?: Partial<Limits>) {
        this.limits = resolveLimits(overrides);
    }

    /** Call before allocating, appending, decoding, or joining growing data. */
    check(limit: LimitName, observed: number): void {
        if (!Number.isSafeInteger(observed) || observed < 0) {
            throw new SfConfigurationError(`observed:${limit}`);
        }
        const maximum = this.limits[limit];
        if (observed > maximum) {
            throw new SfLimitError(limit, maximum, observed);
        }
    }

    /**
     * Count each Item, Inner List, and parameter occurrence before constructing it.
     * Dictionary keys belong to their member, rather than adding another count.
     * Count duplicates before semantic last-value-wins processing: otherwise a
     * repeated key could bypass resource accounting while expanding the raw AST.
     */
    consumeOccurrence(): void {
        const next = this.occurrences + 1;
        this.check("maxTotalOccurrences", next);
        this.occurrences = next;
    }
}