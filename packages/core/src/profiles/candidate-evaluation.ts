import { verifyHttpSignatureCryptography } from "../crypto.js";
import { SignatureError } from "../errors.js";
import type { ParsedSignature, RejectionReason, RequestParts } from "../types.js";
import type { LocalIdentityProposal } from "./agent-bindings.js";
import { resolveAgentClaim } from "./agent-header.js";
import type { ParsedAgentHeader, WebBotAuthProfile } from "./agent-header.js";
import { CandidateRejection, ProfileConfigurationError } from "./codes.js";
import type { ProfileRejection } from "./codes.js";
import { assertSupportedComponents } from "./component-support.js";
import { assertRequiredCoverage } from "./coverage.js";
import { HTTP_SIGNATURE_ALGORITHM_NAMES } from "./jwks-algorithm.js";
import { assertSelectedKeyIdentity, readCandidateMetadata } from "./metadata.js";
import type { CandidateMetadata } from "./metadata.js";
import type { OperationLease } from "./operation-epochs.js";
import type { SignatureTimePolicy } from "./time-policy.js";
import type { VerificationConfiguration } from "./verification-config.js";
import type { RejectedCandidate } from "./verification-types.js";

/** Internal eligibility only: NEVER export through the public package entry. */
export type CandidateEvaluation<
    Identity extends { readonly thumbprint: string } = LocalIdentityProposal,
> =
    | { readonly kind: "rejected"; readonly result: RejectedCandidate }
    | {
        readonly kind: "eligible";
        readonly label: string;
        readonly profile: WebBotAuthProfile;
        readonly signature: ParsedSignature;
        readonly metadata: CandidateMetadata;
        readonly identity: Identity;
        readonly claimedAgent: string;
        readonly time: SignatureTimePolicy;
    };

/** Map expected M1 failures only; configuration/programming errors propagate. */
export function coreRejection(reason: RejectionReason): ProfileRejection {
    switch (reason) {
        case "resource-limit":
            return { status: "unverified", reason: "resource-limit" };
        case "unsupported":
            return { status: "unverified", reason: "unsupported-profile" };
        case "missing-component":
            return { status: "invalid", reason: "insufficient-coverage" };
        case "algorithm-mismatch":
        case "signature-mismatch":
            return { status: "invalid", reason };
        case "malformed":
            return { status: "invalid", reason: "malformed-signature" };
        case "invalid-key":
            // Loaded keys are trusted configuration, not remote request data.
            throw new ProfileConfigurationError("invalid-key-configuration");
    }
}

export function rejectedCandidate(
    label: string,
    error: CandidateRejection,
    profile?: WebBotAuthProfile,
): RejectedCandidate {
    return Object.freeze({
        ...error.rejection,
        label,
        ...(profile === undefined ? {} : { profile }),
        // All callers pass internal expected rejections with sanitized messages.
        // Backend exceptions never enter this diagnostic path.
        message: error.message,
    });
}

/**
 * Evaluate every selected candidate independently, including candidates that
 * will count toward exactly-one ambiguity. No store dispatch or public success.
 * A failed candidate remains present in the original selection/order.
 */
export async function evaluateCandidate(
    request: RequestParts,
    signature: ParsedSignature,
    agent: ParsedAgentHeader,
    config: VerificationConfiguration,
    lease: OperationLease,
): Promise<CandidateEvaluation> {
    const { label } = signature.input;
    const { profile } = agent;
    try {
        if (!config.allowedProfiles.includes(profile)) {
            throw new CandidateRejection({ status: "unverified", reason: "profile-disallowed" });
        }
        assertSupportedComponents(signature.input, profile);
        const claim = resolveAgentClaim(agent, label, config.limits.maxAgentUrlBytes);
        assertRequiredCoverage(signature.input, profile);
        const policy = config.profiles[profile];
        const metadata = readCandidateMetadata(
            signature.input.parameters, policy.noncePolicy, config.limits.maxNonceBytes,
        );
        const selected = config.jwks.lookup(metadata.keyid);
        const algorithm = metadata.algorithm;
        if (algorithm !== undefined && algorithm !== "ed25519") {
            const known = (HTTP_SIGNATURE_ALGORITHM_NAMES as readonly string[]).includes(algorithm);
            // A recognized HTTP algorithm contradicting a selected trusted
            // Ed25519 key takes precedence over unsupported-algorithm.
            // Unknown/JOSE names are never aliases for HTTP ed25519.
            throw new CandidateRejection(selected.status === "found" && known
                ? { status: "invalid", reason: "algorithm-mismatch" }
                : { status: "unverified", reason: "unsupported-algorithm" });
        }
        if (selected.status !== "found") throw new CandidateRejection(selected);
        const thumbprint = assertSelectedKeyIdentity(metadata.keyid, selected.key.publicKey);
        if (selected.key.knownTestKey && !config.allowTestKeys) {
            throw new CandidateRejection({ status: "unverified", reason: "test-key-disallowed" });
        }
        const identity = config.bindings.proposeIdentity(
            thumbprint, claim.claimedUrl, config.requireBinding,
        );
        policy.time.check(metadata.created, metadata.expires, config.controller.now(lease));
        const crypto = await verifyHttpSignatureCryptography(
            { kind: "request", request }, signature, selected.key.publicKey,
            {
                limits: config.coreLimits,
                structuredFieldTypes: {
                    ...config.fieldTypes,
                    "signature-agent": profile === "ietf-wg-protocol-00" ? "dictionary" : "item",
                },
            },
        );
        // The primitive currently runs synchronously, but its Promise boundary
        // still permits reset/mutation elsewhere before continuation.
        const now = config.controller.now(lease);
        if (crypto.status === "rejected") throw new CandidateRejection(coreRejection(crypto.reason));
        policy.time.check(metadata.created, metadata.expires, now);
        return Object.freeze({
            kind: "eligible", label, profile, signature, metadata,
            identity, claimedAgent: claim.claimedUrl, time: policy.time,
        });
    } catch (error) {
        if (error instanceof SignatureError) {
            error = new CandidateRejection(coreRejection(error.reason));
        }
        if (!(error instanceof CandidateRejection)) throw error;
        return Object.freeze({
            kind: "rejected",
            result: rejectedCandidate(label, error, profile),
        });
    }
}