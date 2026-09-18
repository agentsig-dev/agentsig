import type { SignatureInput } from "../types.js";
import { WEB_BOT_AUTH_PROFILES } from "./agent-header.js";
import type { WebBotAuthProfile } from "./agent-header.js";
import { CandidateRejection } from "./codes.js";

export type ProfileSupportDiagnostic =
    | {
        readonly kind: "profile";
        readonly profile: string;
        readonly source: "agentsig-m2-profile-set";
    }
    | {
        readonly kind: "component";
        readonly profile: WebBotAuthProfile;
        readonly component: string;
        readonly parameter?: string;
        readonly source:
        | "agentsig-m2-local-countersignature-limit"
        | "cloudflare-docs-2026-07-01-limitations";
    };

function display(value: string): string {
    // Diagnostic-only bound; never truncate input used by signature processing.
    // Escape Unicode/control characters so untrusted names cannot alter logs.
    const quoted = JSON.stringify(value.slice(0, 256))
        .replace(/[\u007f-\uffff]/g, (character) =>
            `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
    return quoted + (value.length > 256 ? " [truncated]" : "");
}

/** Detailed rejection without adding a reason to the frozen result catalog. */
export class ProfileSupportRejection extends CandidateRejection {
    readonly diagnostic: Readonly<ProfileSupportDiagnostic>;

    constructor(diagnostic: ProfileSupportDiagnostic) {
        super({ status: "unverified", reason: "unsupported-profile" });
        this.diagnostic = Object.freeze({ ...diagnostic });
        const profile = display(diagnostic.profile);
        this.message = diagnostic.kind === "profile"
            ? `Unsupported profile ${profile}; source=${diagnostic.source} (unsupported-profile)`
            : `Unsupported component ${display(diagnostic.component)} in profile ${profile}` +
            (diagnostic.parameter === undefined
                ? "" : `; parameter=${display(diagnostic.parameter)}`) +
            `; source=${diagnostic.source} (unsupported-profile)`;
    }
}

export function assertSupportedProfile(profile: string): asserts profile is WebBotAuthProfile {
    if (!(WEB_BOT_AUTH_PROFILES as readonly string[]).includes(profile)) {
        throw new ProfileSupportRejection({
            kind: "profile", profile, source: "agentsig-m2-profile-set",
        });
    }
}

/**
 * Candidate-local support gate, after tag-based selection.
 *
 * NEVER filter a rejected candidate out of the original selection. Exactly-one
 * counts all tagged candidates before this gate; explicit all/any must retain
 * the per-label rejection and evaluate the other independent candidates.
 *
 * Covering Signature or Signature-Input is deliberately outside M2 in BOTH
 * profiles. WG §5.2.2 defines countersignature coverage requirements, but this
 * helper does not implement them or claim delegation. Revisit in a separate
 * milestone if M4 proxy deployment requires that functionality.
 *
 * Cloudflare exclusions come from the pinned 2026-07-01 document's Limitations
 * section (lines 235–248), corroborated for sf/bs by §4.1.
 * This is not general RFC component validation or required-coverage checking.
 * Both those gates and cryptographic verification remain necessary.
 */
export function assertSupportedComponents(input: SignatureInput, profile: string): void {
    assertSupportedProfile(profile);
    // Scan local exclusions first, independent of component ordering, so their
    // diagnostic is not masked by a Cloudflare parameter restriction.
    for (const component of input.components) {
        if (component.name === "signature" || component.name === "signature-input") {
            throw new ProfileSupportRejection({
                kind: "component", profile, component: component.name,
                source: "agentsig-m2-local-countersignature-limit",
            });
        }
    }
    if (profile !== "cloudflare-docs-2026-07-01") return;
    for (const component of input.components) {
        const parameter = component.parameters.find(([name]) =>
            name === "req" ||
            (name === "name" && component.name === "@query-param") ||
            (!component.name.startsWith("@") && ["sf", "bs", "key"].includes(name)),
        )?.[0];
        // The source literally lists @query-params and also explicitly denies
        // @query-param support under the name-parameter limitation. Preserve
        // both instead of silently "correcting" the source text.
        const excluded = ["@status", "@query-params", "@query-param"].includes(component.name);
        if (excluded || parameter !== undefined) {
            throw new ProfileSupportRejection({
                kind: "component", profile, component: component.name,
                ...(parameter === undefined ? {} : { parameter }),
                source: "cloudflare-docs-2026-07-01-limitations",
            });
        }
    }
}