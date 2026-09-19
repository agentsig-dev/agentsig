import { Buffer } from "node:buffer";
import { ProfileConfigurationError } from "../profiles/codes.js";
import type { DirectoryResponse } from "./directory-response.js";

export interface DirectoryFreshnessPolicy {
    readonly fallbackSeconds: number;
    readonly maximumLifetimeSeconds: number;
}

export interface DirectoryFreshness {
    /** Permission to retain evidence, not permission to authenticate from it. */
    readonly persist: boolean;
    readonly remainingAtReceiptMs: number;
    readonly receivedMonotonicMs: number;
}

export function resolveDirectoryFreshnessPolicy(
    input?: Partial<DirectoryFreshnessPolicy>,
): Readonly<DirectoryFreshnessPolicy> {
    const result = { fallbackSeconds: 60, maximumLifetimeSeconds: 300 };
    const invalid = (): never => {
        throw new ProfileConfigurationError("invalid-resource-limits");
    };
    if (input !== undefined) {
        if (!input || typeof input !== "object" || Array.isArray(input)) return invalid();
        for (const name of Reflect.ownKeys(input)) {
            if (name !== "fallbackSeconds" && name !== "maximumLifetimeSeconds") return invalid();
            const field = Object.getOwnPropertyDescriptor(input, name);
            if (!field || !Object.hasOwn(field, "value")) return invalid();
            const value: unknown = field.value;
            // Zero is an explicit fail-closed configuration, not an unlimited TTL.
            if (typeof value !== "number" || !Number.isSafeInteger(value) ||
                value < 0 || value > 300) return invalid();
            result[name] = value;
        }
    }
    return Object.freeze(result);
}

const token = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
const directive = new RegExp(
    `^(${token})(?:[ \\t]*=[ \\t]*(${token}|"(?:[\\x20-\\x21\\x23-\\x5b\\x5d-\\x7e]|\\\\[\\x20-\\x7e])*"))?$`,
);

interface Directive {
    readonly name: string;
    readonly value: string | undefined;
}

/** Split only outside quoted strings; commas inside extensions are not fields. */
function directives(value: string): readonly Directive[] | undefined {
    const parts: string[] = [];
    let start = 0;
    let quoted = false;
    let escaped = false;
    for (let index = 0; index < value.length; index++) {
        const char = value[index]!;
        if (escaped) { escaped = false; continue; }
        if (quoted && char === "\\") { escaped = true; continue; }
        if (char === '"') quoted = !quoted;
        if (char === "," && !quoted) {
            parts.push(value.slice(start, index));
            start = index + 1;
        }
    }
    if (quoted || escaped) return undefined;
    parts.push(value.slice(start));
    const result: Directive[] = [];
    for (const part of parts) {
        const text = part.replace(/^[ \t]+|[ \t]+$/g, "");
        // Empty list members are harmless HTTP list separators.
        if (!text) continue;
        const match = directive.exec(text);
        if (!match) return undefined;
        let argument = match[2];
        if (argument?.startsWith('"')) {
            argument = argument.slice(1, -1).replace(/\\([\x20-\x7e])/g, "$1");
        }
        result.push({ name: match[1]!.toLowerCase(), value: argument });
    }
    return result;
}

function deltaSeconds(value: string | undefined): number | undefined {
    if (value === undefined || !/^[0-9]+$/.test(value)) return undefined;
    const number = Number(value);
    // Excessive wire values cannot overflow into a fresh or negative duration.
    return Number.isSafeInteger(number) && number <= Number.MAX_SAFE_INTEGER / 1000
        ? number : undefined;
}

function httpDate(value: string): number | undefined {
    if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), [0-9]{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$/.test(value)) {
        return undefined;
    }
    const result = Date.parse(value);
    // Date.parse alone repairs invalid calendars and ignores wrong weekdays.
    return Number.isFinite(result) && new Date(result).toUTCString() === value
        ? result : undefined;
}

/**
 * Internal reusable-freshness calculation, not an authentication decision.
 * Never collapse occurrences before checking duplicate freshness metadata.
 * The response reader bounds wire bytes; this defensive budget also bounds
 * direct internal callers before parsing or constructing temporary collections.
 */
export function calculateDirectoryFreshness(
    response: Pick<DirectoryResponse, "headers" | "requestStartedMonotonicMs" |
        "responseReceivedMonotonicMs" | "responseReceivedWallMs">,
    overrides?: Partial<DirectoryFreshnessPolicy>,
): DirectoryFreshness {
    const policy = resolveDirectoryFreshnessPolicy(overrides);
    const received = response.responseReceivedMonotonicMs;
    let persist = true;
    let invalid = false;
    let revalidate = false;
    const finish = (remainingAtReceiptMs: number): DirectoryFreshness => Object.freeze({
        persist, remainingAtReceiptMs, receivedMonotonicMs: received,
    });
    if (response.headers.length > 16384) {
        persist = false;
        return finish(0);
    }
    let bytes = 0;
    const single = new Map<string, string>();
    const lifetimes: number[] = [];
    const seenLifetime = new Set<string>();
    for (const [rawName, value] of response.headers) {
        if (rawName.length + value.length > 16384) { persist = false; return finish(0); }
        bytes += Buffer.byteLength(rawName) + Buffer.byteLength(value) + 4;
        if (bytes > 16384) { persist = false; return finish(0); }
        const name = rawName.toLowerCase();
        if (name === "cache-control" || name === "pragma") {
            const parsed = directives(value);
            if (!parsed) {
                invalid = true;
                // An unparseable list cannot establish that no-store/private
                // is absent. The separately pinned persistence amendment
                // forbids retaining this response, not only reusing it.
                if (name === "cache-control") persist = false;
                continue;
            }
            for (const field of parsed) {
                if (field.name === "no-cache") revalidate = true;
                if (name === "pragma") continue;
                if (field.name === "no-store" || field.name === "private") persist = false;
                if (field.name !== "max-age" && field.name !== "s-maxage") continue;
                if (seenLifetime.has(field.name)) invalid = true;
                seenLifetime.add(field.name);
                const seconds = deltaSeconds(field.value);
                if (seconds === undefined) invalid = true;
                else lifetimes.push(seconds);
            }
        } else if (name === "date" || name === "age" || name === "expires") {
            if (single.has(name)) invalid = true;
            single.set(name, value);
        }
    }
    const date = single.has("date") ? httpDate(single.get("date")!) : undefined;
    const expires = single.has("expires") ? httpDate(single.get("expires")!) : undefined;
    const age = single.has("age") ? deltaSeconds(single.get("age")) : 0;
    if ((single.has("date") && date === undefined) ||
        (single.has("expires") && expires === undefined) || age === undefined) invalid = true;

    const started = response.requestStartedMonotonicMs;
    const wall = response.responseReceivedWallMs;
    if (![started, received, wall].every((value) =>
        Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER) ||
        started < 0 || received < started) invalid = true;
    if (invalid || revalidate || !persist) return finish(0);

    let lifetimeSeconds = policy.fallbackSeconds;
    if (lifetimes.length) lifetimeSeconds = Math.min(...lifetimes);
    else if (single.has("expires")) {
        // Do not infer an origin timestamp from an unrelated local wall clock.
        if (date === undefined || expires === undefined) return finish(0);
        lifetimeSeconds = Math.max(0, (expires - date) / 1000);
    }
    // Cap the lifetime BEFORE subtracting age, never restart TTL on cache read.
    const lifetimeMs = Math.min(lifetimeSeconds, policy.maximumLifetimeSeconds) * 1000;
    const apparentAgeMs = date === undefined ? 0 : Math.max(0, wall - date);
    const correctedAgeMs = age! * 1000 + (received - started);
    const initialAgeMs = Math.max(apparentAgeMs, correctedAgeMs);
    return finish(Math.max(0, lifetimeMs - initialAgeMs));
}

/** A reset of the verification clock never changes this monotonic reference. */
export function isDirectoryFresh(freshness: DirectoryFreshness, nowMonotonicMs: number): boolean {
    const elapsed = nowMonotonicMs - freshness.receivedMonotonicMs;
    return freshness.persist && Number.isFinite(nowMonotonicMs) &&
        Number.isFinite(elapsed) && elapsed >= 0 &&
        Number.isFinite(freshness.remainingAtReceiptMs) &&
        freshness.remainingAtReceiptMs > 0 &&
        freshness.remainingAtReceiptMs <= 300000 &&
        elapsed < freshness.remainingAtReceiptMs;
}