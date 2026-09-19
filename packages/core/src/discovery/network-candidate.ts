import { verifyHttpSignatureCryptography } from "../crypto.js";
import { SignatureError } from "../errors.js";
import { resolveAgentClaim } from "../profiles/agent-header.js";
import type { WebBotAuthProfile } from "../profiles/agent-header.js";
import { coreRejection, rejectedCandidate } from "../profiles/candidate-evaluation.js";
import type { CandidateEvaluation } from "../profiles/candidate-evaluation.js";
import type { EligibleCandidate } from "../profiles/candidate-replay.js";
import { CandidateRejection } from "../profiles/codes.js";
import { assertSupportedComponents } from "../profiles/component-support.js";
import { assertRequiredCoverage } from "../profiles/coverage.js";
import { assertSelectedKeyIdentity, readCandidateMetadata } from "../profiles/metadata.js";
import type { VerificationConfiguration } from "../profiles/verification-config.js";
import type { VerificationStrategy } from "../profiles/verification-engine.js";
import type { DirectoryKeySelection } from "./directory-cache.js";
import { createDirectoryFetchBudget } from "./directory-service.js";
import type { DirectoryService } from "./directory-service.js";

/**
 * Direct HTTPS origin/key association, not a local binding or publisher-signed
 * directory proof. Only the final authentication engine may expose this identity.
 */
export interface DiscoveredIdentity {
    readonly identityKind: "directory-url";
    readonly thumbprint: string;
    readonly canonicalOrigin: string;
    readonly directoryUrl: string;
    readonly trustSource: "directory-https";
}

type NetworkEvaluation = CandidateEvaluation<DiscoveredIdentity>;

/**
 * INTERNAL invocation-owned strategy. Services are owned discovery partitions,
 * not application key providers. One budget spans all selected candidates.
 * No remote keys are inserted into the offline local-binding configuration.
 */
export function createNetworkStrategy(
    config: VerificationConfiguration,
    serviceFor: (profile: WebBotAuthProfile) => DirectoryService,
): VerificationStrategy<DiscoveredIdentity> {
    const budget = createDirectoryFetchBudget();
    const evidence = new WeakMap<EligibleCandidate<DiscoveredIdentity>, {
        readonly service: DirectoryService;
        readonly selection: DirectoryKeySelection;
    }>();

    return {
        async evaluate(request, signature, agent, lease): Promise<NetworkEvaluation> {
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
                // Reject unusable requests before attacker-directed discovery.
                // No remote algorithm name changes the crypto backend or key lookup.
                if (metadata.algorithm !== undefined && metadata.algorithm !== "ed25519") {
                    throw new CandidateRejection({ status: "unverified", reason: "unsupported-algorithm" });
                }
                policy.time.check(metadata.created, metadata.expires, config.controller.now(lease));

                const service = serviceFor(profile);
                const resolved = await service.resolve(claim.canonicalOrigin, metadata.keyid, budget);
                // A reset or expired request during discovery cannot dispatch replay.
                const now = config.controller.now(lease);
                policy.time.check(metadata.created, metadata.expires, now);
                if (resolved.status !== "found") {
                    throw new CandidateRejection({ status: "unverified", reason: resolved.reason });
                }
                const selected = resolved.selection;
                const thumbprint = assertSelectedKeyIdentity(metadata.keyid, selected.key.publicKey);
                if (selected.key.knownTestKey && !config.allowTestKeys) {
                    throw new CandidateRejection({ status: "unverified", reason: "test-key-disallowed" });
                }
                if (selected.origin !== claim.canonicalOrigin || !service.recheck(selected)) {
                    throw new CandidateRejection({ status: "unverified", reason: "unknown-key" });
                }
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
                const afterCrypto = config.controller.now(lease);
                if (crypto.status === "rejected") {
                    throw new CandidateRejection(coreRejection(crypto.reason));
                }
                policy.time.check(metadata.created, metadata.expires, afterCrypto);
                if (!service.recheck(selected)) {
                    throw new CandidateRejection({ status: "unverified", reason: "unknown-key" });
                }
                const identity: DiscoveredIdentity = Object.freeze({
                    identityKind: "directory-url",
                    thumbprint,
                    canonicalOrigin: claim.canonicalOrigin,
                    directoryUrl: `${claim.canonicalOrigin}/.well-known/http-message-signatures-directory`,
                    trustSource: "directory-https",
                });
                const candidate: EligibleCandidate<DiscoveredIdentity> = Object.freeze({
                    kind: "eligible", label, profile, signature, metadata, identity,
                    claimedAgent: claim.claimedUrl, time: policy.time,
                });
                evidence.set(candidate, { service, selection: selected });
                return candidate;
            } catch (error) {
                if (error instanceof SignatureError) {
                    error = new CandidateRejection(coreRejection(error.reason));
                }
                if (!(error instanceof CandidateRejection)) throw error;
                return Object.freeze({
                    kind: "rejected", result: rejectedCandidate(label, error, profile),
                });
            }
        },
        checkEvidence(candidate): void {
            const selected = evidence.get(candidate);
            if (!selected || !selected.service.recheck(selected.selection)) {
                throw new CandidateRejection({ status: "unverified", reason: "unknown-key" });
            }
        },
    };
}