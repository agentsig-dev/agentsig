import type { CoveredComponent, SignatureInput } from "../types.js";
import type { WebBotAuthProfile } from "./agent-header.js";
import { CandidateRejection } from "./codes.js";

function bareComponent(component: CoveredComponent, name: string): boolean {
    return component.name === name && component.parameters.length === 0;
}

function matchingAgentMember(component: CoveredComponent, label: string): boolean {
    if (component.name !== "signature-agent") return false;
    let matchingKey = false;
    const seen = new Set<string>();
    for (const [name, value] of component.parameters) {
        // Do not allow req/tr/bs or an unknown parameter to masquerade as the
        // required current-request Dictionary member. Raw duplicate screening
        // runs earlier; this also protects internal caller-constructed inputs.
        if (seen.has(name)) return false;
        seen.add(name);
        if (name === "key") {
            if (value.kind !== "string" || value.value !== label) return false;
            matchingKey = true;
        } else if (name === "sf") {
            // RFC 9421 permits sf with key: key selection still covers the
            // same member using strict Structured Field serialization.
            if (value.kind !== "boolean" || value.value !== true) return false;
        } else {
            return false;
        }
    }
    return matchingKey;
}

/**
 * Approved M2 minimum: method + complete target URI + profile-specific agent.
 * This is stricter than WG's authority-or-target minimum and Cloudflare's
 * recommendation. Authority, path or query alone cannot replace target-uri.
 *
 * Call after signature parsing, raw duplicate screening and agent-label
 * resolution. A missing corresponding agent member is agent-label-mismatch
 * at that earlier gate; failure to cover it here is insufficient-coverage.
 *
 * This checks only REQUIRED coverage. It does not validate every additional
 * component, implement WG countersignature rules, compare a digest to a body,
 * or establish cryptographic validity, identity, freshness or replay safety.
 * Core canonicalization and further profile checks remain mandatory.
 */
export function assertRequiredCoverage(
    input: SignatureInput,
    profile: WebBotAuthProfile,
): void {
    const components = input.components;
    const method = components.some((component) => bareComponent(component, "@method"));
    const target = components.some((component) => bareComponent(component, "@target-uri"));
    const agent = components.some((component) =>
        profile === "ietf-wg-protocol-00"
            ? matchingAgentMember(component, input.label)
            : bareComponent(component, "signature-agent"));
    if (!method || !target || !agent) {
        throw new CandidateRejection({
            status: "invalid", reason: "insufficient-coverage",
        });
    }
}