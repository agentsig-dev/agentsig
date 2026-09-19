import { SignatureError } from "../errors.js";
import type { ParsedSignature, RequestParts } from "../types.js";
import { parseAgentHeader } from "./agent-header.js";
import type { ParsedAgentHeader, WebBotAuthProfile } from "./agent-header.js";
import { coreRejection, rejectedCandidate } from "./candidate-evaluation.js";
import type { CandidateEvaluation } from "./candidate-evaluation.js";
import { consumeCandidateGroups } from "./candidate-replay.js";
import type { CandidateReplayOutcome, EligibleCandidate } from "./candidate-replay.js";
import { selectWebBotAuthCandidates } from "./candidates.js";
import { CandidateRejection } from "./codes.js";
import type { OperationLease } from "./operation-epochs.js";
import type { VerificationConfiguration } from "./verification-config.js";
import { snapshotVerificationRequest } from "./verification-request.js";
import type {
    CandidateResult, RejectedCandidate, VerificationResult, VerifiedCandidate,
} from "./verification-types.js";

type IdentityBase = { readonly thumbprint: string };
type EngineConfiguration = Pick<VerificationConfiguration,
    "context" | "controller" | "limits" | "coreLimits" | "scope" |
    "candidateMode" | "aggregate">;

/**
 * INTERNAL owned implementation strategies, never caller-provided policy hooks.
 * A fresh strategy belongs to one invocation (including its discovery budget).
 * checkEvidence must be synchronous and must not invoke application observers.
 */
export interface VerificationStrategy<Identity extends IdentityBase> {
    evaluate(
        request: RequestParts,
        signature: ParsedSignature,
        agent: ParsedAgentHeader,
        lease: OperationLease,
    ): Promise<CandidateEvaluation<Identity>>;
    checkEvidence(candidate: EligibleCandidate<Identity>): void;
}

function evidenceRejection<Identity extends IdentityBase>(
    candidate: EligibleCandidate<Identity>,
    strategy: VerificationStrategy<Identity>,
): RejectedCandidate | undefined {
    try {
        strategy.checkEvidence(candidate);
        return undefined;
    } catch (error) {
        if (!(error instanceof CandidateRejection)) throw error;
        return rejectedCandidate(candidate.label, error, candidate.profile);
    }
}

function finalize<Identity extends IdentityBase>(
    candidate: EligibleCandidate<Identity>,
    replay: CandidateReplayOutcome | undefined,
    now: number,
): CandidateResult<Identity> {
    try {
        candidate.time.check(candidate.metadata.created, candidate.metadata.expires, now);
        if (replay === undefined) throw new Error("Missing internal replay outcome");
        if (typeof replay !== "string") throw new CandidateRejection(replay);
        if ((candidate.metadata.nonce === undefined) !== (replay === "optional")) {
            throw new Error("Inconsistent internal replay outcome");
        }
        const common = {
            status: "verified" as const,
            label: candidate.label,
            profile: candidate.profile,
            identity: candidate.identity,
            claimedAgent: candidate.claimedAgent,
            coveredComponents: candidate.signature.input.components,
            verifiedAt: now,
        };
        return Object.freeze(replay === "accepted"
            ? { ...common, reason: "nonce-consumed", replayProtected: true }
            : { ...common, reason: "nonce-absent-optional", replayProtected: false });
    } catch (error) {
        if (!(error instanceof CandidateRejection)) throw error;
        return rejectedCandidate(candidate.label, error, candidate.profile);
    }
}

function aggregate<Identity extends IdentityBase>(
    candidates: readonly CandidateResult<Identity>[],
    rule: "all" | "any",
): VerificationResult<Identity> {
    const verified = candidates.filter(
        (candidate): candidate is VerifiedCandidate<Identity> => candidate.status === "verified",
    );
    const failed = candidates.find((candidate) => candidate.status !== "verified");
    if (verified.length && (rule === "any" || failed === undefined)) {
        const successes: readonly [VerifiedCandidate<Identity>, ...VerifiedCandidate<Identity>[]] =
            Object.freeze([verified[0]!, ...verified.slice(1)]);
        return Object.freeze({
            status: "verified",
            reason: verified.every((candidate) => candidate.replayProtected)
                ? "nonce-consumed" : "nonce-absent-optional",
            candidates, verifiedCandidates: successes,
        });
    }
    if (!failed) throw new Error("Empty internal candidate aggregate");
    const details = {
        ...(failed.message === undefined ? {} : { message: failed.message }), candidates,
    };
    return failed.status === "invalid"
        ? Object.freeze({ status: failed.status, reason: failed.reason, ...details })
        : Object.freeze({ status: failed.status, reason: failed.reason, ...details });
}

/** Shared authentication lifecycle; no transport code is imported by this engine. */
export function createVerificationEngine<Identity extends IdentityBase>(
    config: EngineConfiguration,
    createStrategy: () => VerificationStrategy<Identity>,
) {
    return Object.freeze({
        context: config.context,
        async verify(input: RequestParts): Promise<VerificationResult<Identity>> {
            let lease: OperationLease | undefined;
            let selected: readonly ParsedSignature[] = [];
            let profile: WebBotAuthProfile | undefined;
            const evaluations: CandidateEvaluation<Identity>[] = [];
            try {
                const request = snapshotVerificationRequest(input, config.coreLimits);
                const selection = selectWebBotAuthCandidates(
                    request.headers, config.coreLimits, config.limits.maxCandidates,
                );
                if (selection.kind === "unsigned") {
                    return Object.freeze({
                        status: "unsigned", reason: selection.reason,
                        candidates: Object.freeze([]) as readonly [],
                    });
                }
                selected = selection.candidates;
                lease = config.controller.beginOperation();
                const agent = parseAgentHeader(request, config.coreLimits);
                profile = agent.profile;
                const strategy = createStrategy();
                for (const signature of selected) {
                    evaluations.push(await strategy.evaluate(request, signature, agent, lease));
                }

                if (config.candidateMode === "exactly-one" && selected.length > 1) {
                    const now = config.controller.completeOperation(lease);
                    const ambiguity = new CandidateRejection({
                        status: "invalid", reason: "ambiguous-signatures",
                    });
                    const candidates = Object.freeze(evaluations.map((candidate): CandidateResult<Identity> => {
                        if (candidate.kind === "rejected") return candidate.result;
                        try {
                            candidate.time.check(candidate.metadata.created, candidate.metadata.expires, now);
                        } catch (error) {
                            if (!(error instanceof CandidateRejection)) throw error;
                            return rejectedCandidate(candidate.label, error, candidate.profile);
                        }
                        return rejectedCandidate(candidate.label, ambiguity, candidate.profile);
                    }));
                    return Object.freeze({ ...ambiguity.rejection, candidates });
                }

                // Reject lost evidence before replay admission, retaining every
                // candidate in the aggregate. No filtered candidate disappears.
                for (let index = 0; index < evaluations.length; index++) {
                    const candidate = evaluations[index]!;
                    if (candidate.kind !== "eligible") continue;
                    const rejection = evidenceRejection(candidate, strategy);
                    if (rejection) evaluations[index] = { kind: "rejected", result: rejection };
                }
                const eligible = evaluations.filter(
                    (candidate): candidate is EligibleCandidate<Identity> => candidate.kind === "eligible",
                );
                const replay = await consumeCandidateGroups(eligible, config, lease);

                // Recheck current evidence after ALL awaited replay groups.
                // Run owned evidence checks before the final context gate so a
                // trusted clock callback cannot reset an already retired lease.
                // Production evidence checks must not await or emit observers.
                const evidence = new Map<EligibleCandidate<Identity>, RejectedCandidate>();
                for (const candidate of eligible) {
                    const rejection = evidenceRejection(candidate, strategy);
                    if (rejection) evidence.set(candidate, rejection);
                }
                const now = config.controller.completeOperation(lease);
                // No awaits or application callbacks below this final gate.
                // Consumed nonces are never rolled back on evidence/time failure.
                const candidates = Object.freeze(evaluations.map((candidate): CandidateResult<Identity> =>
                    candidate.kind === "rejected" ? candidate.result
                        : evidence.get(candidate) ?? finalize(candidate, replay.get(candidate), now)));
                return aggregate(candidates, config.aggregate);
            } catch (error) {
                if (error instanceof SignatureError) {
                    error = new CandidateRejection(coreRejection(error.reason));
                }
                if (!(error instanceof CandidateRejection)) throw error;
                const failure = error;
                const candidates = Object.freeze(selected.map((signature, index): CandidateResult<Identity> => {
                    const evaluation = evaluations[index];
                    return evaluation?.kind === "rejected" ? evaluation.result
                        : rejectedCandidate(signature.input.label, failure, profile);
                }));
                const ambiguous = config.candidateMode === "exactly-one" && selected.length > 1;
                return Object.freeze({
                    ...(ambiguous
                        ? { status: "invalid" as const, reason: "ambiguous-signatures" as const }
                        : failure.rejection),
                    candidates,
                    message: ambiguous
                        ? "Multiple tagged candidates require an explicit multiple-candidate policy"
                        : failure.message,
                });
            } finally {
                if (lease !== undefined) config.controller.finishOperation(lease);
            }
        },
    });
}