import {
    resolveLimits as resolveSfLimits,
    SfConfigurationError,
} from "@agentsig/structured-fields";
import type { Limits as SfLimits } from "@agentsig/structured-fields";
import { SignatureConfigurationError, SignatureLimitError } from "./errors.js";
import type { Limits, LimitOverrides } from "./types.js";

/**
 * Node's default HTTP header limit is 16 KiB. Use that as an explicit,
 * deterministic starting budget, not the potentially CLI-overridden runtime
 * setting. This is local policy, not a maximum imposed by RFC 9421.
 *
 * All SF values are explicit: changes to the SF package's defaults must not
 * silently widen the core's attack surface. Cardinality limits retain the
 * already approved SF values; protocol profiles can narrow them later.
 */
export const CORE_SF_LIMITS: Readonly<SfLimits> = Object.freeze({
    maxInputBytes: 16_384,
    maxOutputBytes: 16_384,
    maxMembers: 1_024,
    maxInnerListItems: 256,
    maxParameters: 256,
    maxKeyLength: 1_024,
    maxTokenLength: 8_192,
    maxDecodedBytes: 16_384,
    maxTotalOccurrences: 65_536,
});

export const DEFAULT_CORE_LIMITS: Readonly<Limits> = Object.freeze({
    maxSignatureHeaderBytes: 16_384,
    maxSignatures: 1_024,
    maxComponentsPerSignature: 256,
    maxParameters: 256,
    maxMessageHeaderBytes: 16_384,
    maxTargetUriBytes: 16_384,
    maxSignatureBaseBytes: 16_384,
    structuredFields: CORE_SF_LIMITS,
});

export type CoreLimitName = Exclude<keyof Limits, "structuredFields">;

export function resolveCoreLimits(
    overrides: LimitOverrides = {},
): Readonly<Limits> {
    if (overrides === null || typeof overrides !== "object" || Array.isArray(overrides)) {
        throw new SignatureConfigurationError();
    }
    for (const key of Reflect.ownKeys(overrides)) {
        if (typeof key !== "string" || !Object.hasOwn(DEFAULT_CORE_LIMITS, key)) {
            throw new SignatureConfigurationError();
        }
    }

    const resolved = { ...DEFAULT_CORE_LIMITS, ...overrides };
    for (const key of Object.keys(DEFAULT_CORE_LIMITS)) {
        if (key === "structuredFields") continue;
        const value = resolved[key as CoreLimitName];
        if (!Number.isSafeInteger(value) || value < 0) {
            throw new SignatureConfigurationError();
        }
    }

    const sfOverrides = overrides.structuredFields;
    if (
        sfOverrides !== undefined &&
        (sfOverrides === null || typeof sfOverrides !== "object" || Array.isArray(sfOverrides))
    ) {
        throw new SignatureConfigurationError();
    }
    try {
        return Object.freeze({
            ...resolved,
            structuredFields: resolveSfLimits({ ...CORE_SF_LIMITS, ...sfOverrides }),
        });
    } catch (error) {
        if (error instanceof SfConfigurationError) {
            throw new SignatureConfigurationError();
        }
        throw error;
    }
}

/** Check before growing allocations; never truncate signed data to fit. */
export function checkLimit(
    limits: Readonly<Limits>,
    limit: CoreLimitName,
    observed: number,
): void {
    if (!Number.isSafeInteger(observed) || observed < 0) {
        throw new SignatureConfigurationError();
    }
    if (observed > limits[limit]) {
        throw new SignatureLimitError(limit, limits[limit], observed);
    }
}