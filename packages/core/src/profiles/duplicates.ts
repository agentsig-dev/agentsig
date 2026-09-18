import { parseRaw } from "@agentsig/structured-fields";
import type {
    RawDictionary, RawMember, RawParameter,
} from "@agentsig/structured-fields";
import { SignatureError } from "../errors.js";
import { combineValues, fieldValues, requireAscii, validateHeaders } from "../headers.js";
import { checkLimit } from "../limits.js";
import { withSfErrors } from "../signature-input.js";
import type { HeaderFields, Limits } from "../types.js";
import { CandidateRejection } from "./codes.js";

type MalformedCode = "malformed-signature" | "malformed-agent";

/**
 * Internal diagnostic, not a new verification result or result-code variant.
 * Reflect only the bounded SF key, never its value or the complete header.
 */
export class DuplicateFieldRejection extends CandidateRejection {
    readonly repeatedName: string;

    constructor(reason: MalformedCode, repeatedName: string) {
        super({ status: "invalid", reason });
        this.repeatedName = repeatedName;
        // SF keys are ASCII and syntactically constrained. Still quote and
        // bound the displayed name to avoid log amplification.
        const shown = JSON.stringify(repeatedName.slice(0, 256));
        const suffix = repeatedName.length > 256 ? " [truncated]" : "";
        this.message = `Web Bot Auth candidate rejected: ${reason}; duplicate name ${shown}${suffix}`;
    }
}

function parameters(values: readonly RawParameter[], code: MalformedCode): void {
    const seen = new Set<string>();
    for (const parameter of values) {
        if (seen.has(parameter.key)) {
            throw new DuplicateFieldRejection(code, parameter.key);
        }
        seen.add(parameter.key);
    }
}

function member(value: RawMember, code: MalformedCode): void {
    parameters(value.parameters, code);
    if (value.kind === "inner-list") {
        for (const item of value.items) parameters(item.parameters, code);
    }
}

function dictionary(value: RawDictionary, code: MalformedCode): void {
    const seen = new Set<string>();
    for (const entry of value.entries) {
        // Signature label uniqueness is independently required by RFC 9421
        // §4. Dictionary member rejection for Signature-Agent is local policy.
        if (seen.has(entry.key)) {
            throw new DuplicateFieldRejection(code, entry.key);
        }
        seen.add(entry.key);
        member(entry.member, code);
    }
}

function screen<T>(code: MalformedCode, operation: () => T): T {
    try {
        return withSfErrors(operation);
    } catch (error) {
        if (error instanceof SignatureError) {
            throw new CandidateRejection(error.reason === "resource-limit"
                ? { status: "unverified", reason: "resource-limit" }
                : { status: "invalid", reason: code });
        }
        // Do not swallow configuration errors or unexpected implementation bugs.
        throw error;
    }
}

/**
 * Screen BEFORE semantic parsing/tag selection, so a repeated tag cannot hide
 * a Web Bot Auth candidate by overwriting it with another protocol's tag.
 *
 * RFC 9421 §§2.3/2.5 serialize parameter ordered sets but do not explicitly
 * reject repeated raw parameter names. RFC 9651 §4.2.3.2 keeps the last value.
 * Rejecting raw occurrences here is approved stricter M2 policy, preventing
 * parser differentials; M1 and the general SF parser remain unchanged.
 *
 * This is only screening: the caller must still use the M1 all-pairs parser to
 * validate signature shapes, types, counterparts and component identifiers.
 */
export function assertNoSignatureDuplicates(
    headers: HeaderFields,
    limits: Readonly<Limits>,
): void {
    screen("malformed-signature", () => {
        validateHeaders(headers, limits);
        const options = { limits: limits.structuredFields };
        let total = 0;
        for (const name of ["signature-input", "signature"]) {
            const values = fieldValues(headers, name);
            if (!values.length) continue;
            const text = requireAscii(combineValues(values, limits, "maxSignatureHeaderBytes"));
            total += text.length;
            checkLimit(limits, "maxSignatureHeaderBytes", total);
            const raw = parseRaw(text, "dictionary", options);
            checkLimit(limits, "maxSignatures", raw.root.entries.length);
            dictionary(raw.root, "malformed-signature");
        }
    });
}

/**
 * Screen a bounded, combined ASCII Signature-Agent field.
 * The wire prefix selects its grammar once; failure never triggers fallback.
 * Profile/URI/member-type checks are separate from raw duplicate screening.
 */
export function assertNoAgentDuplicates(text: string, limits: Readonly<Limits>): void {
    screen("malformed-agent", () => {
        checkLimit(limits, "maxMessageHeaderBytes", text.length);
        requireAscii(text);
        const options = { limits: limits.structuredFields };
        if (text.replace(/^[ \t]+/, "").startsWith('"')) {
            member(parseRaw(text, "item", options).root, "malformed-agent");
        } else {
            dictionary(parseRaw(text, "dictionary", options).root, "malformed-agent");
        }
    });
}