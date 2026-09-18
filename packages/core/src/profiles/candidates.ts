import { getParameter } from "@agentsig/structured-fields";
import { SignatureError } from "../errors.js";
import { resolveCoreLimits } from "../limits.js";
import { parseSignatureHeaders } from "../signature-input.js";
import type { HeaderFields, LimitOverrides, ParsedSignature } from "../types.js";
import { CandidateRejection, ProfileConfigurationError } from "./codes.js";
import type { UnsignedCode } from "./codes.js";
import { DEFAULT_PROFILE_LIMITS } from "./defaults.js";
import { assertNoSignatureDuplicates } from "./duplicates.js";

/**
 * Internal parsing outcome, NOT VerificationResult or CandidateEvaluation.
 * Selected candidates still require profile, coverage, identity, cryptography,
 * time and replay evaluation before any verified result is possible.
 */
export type CandidateSelection =
    | { readonly kind: "unsigned"; readonly reason: UnsignedCode }
    | {
        readonly kind: "candidates";
        readonly signatures: readonly ParsedSignature[];
        readonly candidates: readonly ParsedSignature[];
    };

/**
 * Parse every pair before filtering by protocol tag. Invalid unrelated pairs
 * cannot disappear by using a different label or tag (M1 all-pairs contract).
 * Raw duplicate screening precedes semantic parsing so repeated tag values
 * cannot conceal a Web Bot Auth candidate through last-value-wins behavior.
 *
 * Do not enforce exactly-one here: the verifier must evaluate every selected
 * candidate before applying the approved aggregate policy, with no replay
 * consumption in the default ambiguous-multiple path.
 */
export function selectWebBotAuthCandidates(
    headers: HeaderFields,
    overrides?: LimitOverrides,
    maxCandidates: number = DEFAULT_PROFILE_LIMITS.maxCandidates,
): CandidateSelection {
    if (!Number.isSafeInteger(maxCandidates) || maxCandidates < 0) {
        throw new ProfileConfigurationError("invalid-resource-limits");
    }
    const limits = resolveCoreLimits(overrides);
    let signatures: readonly ParsedSignature[];
    try {
        assertNoSignatureDuplicates(headers, limits);
        signatures = parseSignatureHeaders(headers, limits);
    } catch (error) {
        if (error instanceof SignatureError) {
            throw new CandidateRejection(error.reason === "resource-limit"
                ? { status: "unverified", reason: "resource-limit" }
                : { status: "invalid", reason: "malformed-signature" });
        }
        // Preserve duplicate-name diagnostics and configuration errors.
        // Unexpected implementation exceptions must remain visible.
        throw error;
    }
    if (!signatures.length) {
        return { kind: "unsigned", reason: "no-signature" };
    }
    const candidates: ParsedSignature[] = [];
    for (const signature of signatures) {
        const tag = getParameter(signature.input.parameters, "tag");
        if (tag?.kind !== "string" || tag.value !== "web-bot-auth") continue;
        // Check before growing the selected collection. Core parser budgets
        // independently bound all signatures, including non-WBA signatures.
        if (candidates.length >= maxCandidates) {
            throw new CandidateRejection({ status: "unverified", reason: "resource-limit" });
        }
        candidates.push(signature);
    }
    if (!candidates.length) {
        return { kind: "unsigned", reason: "no-web-bot-auth-candidate" };
    }
    return { kind: "candidates", signatures, candidates };
}