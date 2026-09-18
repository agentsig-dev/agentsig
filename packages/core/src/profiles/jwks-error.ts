import { ProfileConfigurationError } from "./codes.js";

/** Diagnostic context, not new members of the frozen result-code catalog. */
export interface JwksDiagnostic {
    readonly rule: string;
    readonly keyIndex?: number;
    readonly kid?: string;
}

/**
 * Only trusted local configuration errors use this diagnostic. Request results
 * must not reflect arbitrary remote metadata into logs.
 */
export class InvalidJwksError extends ProfileConfigurationError {
    readonly diagnostic: Readonly<JwksDiagnostic>;

    constructor(rule: string, keyIndex?: number, kid?: string) {
        super("invalid-jwks");
        this.diagnostic = Object.freeze({
            rule,
            ...(keyIndex === undefined ? {} : { keyIndex }),
            ...(kid === undefined ? {} : { kid }),
        });
        const location = keyIndex === undefined ? "JWKS" : `JWKS keys[${keyIndex}]`;
        const label = kid === undefined ? "" : ` kid=${displayKid(kid)}`;
        this.message = `${location}${label}: ${rule} (invalid-jwks)`;
    }
}

function displayKid(kid: string): string {
    // Diagnostic-only budget: does not restrict accepted JWK labels or change
    // selection. Explicit truncation prevents log amplification by a large kid.
    const maximumCodeUnits = 256;
    const shortened = kid.length > maximumCodeUnits;
    let shown = kid.slice(0, maximumCodeUnits);
    // Do not split a surrogate pair at the truncation boundary.
    if (shortened && /[\uD800-\uDBFF]$/.test(shown)) shown = shown.slice(0, -1);
    const escaped = JSON.stringify(shown).replace(
        /[\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
        (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
    return escaped + (shortened ? " [truncated]" : "");
}

/** Caller supplies an owned, bounded snapshot, not an object with accessors. */
export function invalidJwks(
    rule: string,
    keyIndex?: number,
    key?: Readonly<Record<string, unknown>>,
): never {
    const kid = key && Object.hasOwn(key, "kid") && typeof key.kid === "string"
        ? key.kid : undefined;
    throw new InvalidJwksError(rule, keyIndex, kid);
}