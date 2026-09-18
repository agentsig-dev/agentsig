import { getMember, getParameter, parse } from "@agentsig/structured-fields";
import type { Dictionary, Item } from "@agentsig/structured-fields";
import { SignatureError } from "../errors.js";
import { combineValues, fieldValues, requireAscii, validateHeaders } from "../headers.js";
import { withSfErrors } from "../signature-input.js";
import type { Limits, RequestParts } from "../types.js";
import { canonicalAgentOrigin } from "./agent-origin.js";
import { CandidateRejection } from "./codes.js";
import { DEFAULT_PROFILE_LIMITS } from "./defaults.js";
import { assertNoAgentDuplicates } from "./duplicates.js";

export const WEB_BOT_AUTH_PROFILES = Object.freeze([
    "ietf-wg-protocol-00",
    "cloudflare-docs-2026-07-01",
] as const);
export type WebBotAuthProfile = typeof WEB_BOT_AUTH_PROFILES[number];

/** Internal parsed data, not authenticated identity or verification success. */
export type ParsedAgentHeader =
    | {
        readonly profile: "ietf-wg-protocol-00";
        readonly field: Dictionary;
    }
    | {
        readonly profile: "cloudflare-docs-2026-07-01";
        readonly field: Item;
    };

export interface AgentClaim {
    readonly profile: WebBotAuthProfile;
    readonly label: string;
    /** Exact decoded SF string, not rewritten for signature canonicalization. */
    readonly claimedUrl: string;
    /** Local identity comparison only; never substituted into signed headers. */
    readonly canonicalOrigin: string;
}

function malformed(): never {
    throw new CandidateRejection({ status: "invalid", reason: "malformed-agent" });
}

function agentErrors<T>(operation: () => T): T {
    try {
        return withSfErrors(operation);
    } catch (error) {
        if (error instanceof SignatureError) {
            throw new CandidateRejection(error.reason === "resource-limit"
                ? { status: "unverified", reason: "resource-limit" }
                : { status: "invalid", reason: "malformed-agent" });
        }
        throw error;
    }
}

/**
 * Call after successful signature parsing and WBA candidate selection.
 * Missing/malformed agent metadata must not invalidate unrelated unsigned
 * traffic merely because it happens to include a Signature-Agent header.
 *
 * WG-00 §5.2.1 distinguishes forms by the first character. Select the grammar
 * once: never retry a legacy grammar after a Dictionary parse/verification
 * failure. All SF operations use explicitly resolved core budgets.
 */
export function parseAgentHeader(
    request: RequestParts,
    limits: Readonly<Limits>,
): ParsedAgentHeader {
    return agentErrors(() => {
        validateHeaders(request.headers, limits);
        const occurrences = fieldValues(request.headers, "signature-agent", request.httpVersion);
        if (!occurrences.length) return malformed();
        const text = requireAscii(combineValues(occurrences, limits));
        if (!text.length) return malformed();
        assertNoAgentDuplicates(text, limits);
        const options = { limits: limits.structuredFields };
        if (text.startsWith('"')) {
            const field = parse(text, "item", options);
            if (field.bare.kind !== "string") return malformed();
            return { profile: "cloudflare-docs-2026-07-01", field };
        }
        const field = parse(text, "dictionary", options);
        if (!field.entries.length) return malformed();
        return { profile: "ietf-wg-protocol-00", field };
    });
}

/**
 * Resolve only the member associated with this candidate. Independently
 * evaluate other candidates; one member never supplies another label's claim.
 * This checks no signature coverage or cryptography. Those are separate gates.
 */
export function resolveAgentClaim(
    header: ParsedAgentHeader,
    label: string,
    maximumUrlBytes: number = DEFAULT_PROFILE_LIMITS.maxAgentUrlBytes,
): AgentClaim {
    let selected: Item;
    if (header.profile === "ietf-wg-protocol-00") {
        const member = getMember(header.field, label);
        if (!member) {
            throw new CandidateRejection({ status: "invalid", reason: "agent-label-mismatch" });
        }
        if (member.kind !== "item") return malformed();
        selected = member;
        if (selected.bare.kind !== "string") return malformed();
        const discovery = getParameter(selected.parameters, "type");
        if (discovery !== undefined) {
            if (discovery.kind !== "token") return malformed();
            if (discovery.value !== "directory") {
                // WG §5.2.1: unsupported discovery members are ignored, not
                // guessed from their URL. Do not apply directory-origin rules
                // to jwks_uri/cimd URLs or attempt any network discovery.
                throw new CandidateRejection({
                    status: "unverified", reason: "unsupported-discovery-type",
                });
            }
        }
    } else {
        selected = header.field;
    }
    if (selected.bare.kind !== "string") return malformed();
    const claimedUrl = selected.bare.value;
    return Object.freeze({
        profile: header.profile,
        label,
        claimedUrl,
        canonicalOrigin: canonicalAgentOrigin(claimedUrl, maximumUrlBytes),
    });
}