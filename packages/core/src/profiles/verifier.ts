import { SignatureError } from "../errors.js";
import type { ParsedSignature, RequestParts } from "../types.js";
import { parseAgentHeader } from "./agent-header.js";
import type { WebBotAuthProfile } from "./agent-header.js";
import { coreRejection, evaluateCandidate, rejectedCandidate } from "./candidate-evaluation.js";
import type { CandidateEvaluation } from "./candidate-evaluation.js";
import { consumeCandidateGroups } from "./candidate-replay.js";
import type { CandidateReplayOutcome, EligibleCandidate } from "./candidate-replay.js";
import { selectWebBotAuthCandidates } from "./candidates.js";
import { CandidateRejection } from "./codes.js";
import type { OperationLease } from "./operation-epochs.js";
import { resolveVerificationConfiguration } from "./verification-config.js";
import { snapshotVerificationRequest } from "./verification-request.js";
import type {
    CandidateResult, OfflineVerifier, OfflineVerifierOptions,
    VerificationResult, VerifiedCandidate,
} from "./verification-types.js";

function finalizeCandidate(
    candidate: EligibleCandidate,
    replay: CandidateReplayOutcome | undefined,
    now: number,
): CandidateResult {
    try {
        candidate.time.check(candidate.metadata.created, candidate.metadata.expires, now);
        if (replay === undefined) throw new Error("Missing internal replay outcome");
        if (typeof replay !== "string") throw new CandidateRejection(replay);
        // Defensive invariant: optional absence must never excuse a present
        // nonce or substitute for an atomic accepted outcome.
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

function aggregate(
    candidates: readonly CandidateResult[],
    rule: "all" | "any",
): VerificationResult {
    const verified = candidates.filter(
        (candidate): candidate is VerifiedCandidate => candidate.status === "verified",
    );
    const failed = candidates.find((candidate) => candidate.status !== "verified");
    if (verified.length && (rule === "any" || failed === undefined)) {
        const successes: readonly [VerifiedCandidate, ...VerifiedCandidate[]] =
            Object.freeze([verified[0]!, ...verified.slice(1)]);
        return Object.freeze({
            status: "verified",
            // Conservative summary only. Replay guarantees remain explicit
            // on EACH successful candidate; never infer one shared identity.
            reason: verified.every((candidate) => candidate.replayProtected)
                ? "nonce-consumed" : "nonce-absent-optional",
            candidates,
            verifiedCandidates: successes,
        });
    }
    if (!failed) throw new Error("Empty internal candidate aggregate");
    const details = {
        ...(failed.message === undefined ? {} : { message: failed.message }),
        candidates,
    };
    // Narrow before constructing the result to preserve the catalog's
    // status/reason correlation without widening or asserting the union.
    return failed.status === "invalid"
        ? Object.freeze({ status: failed.status, reason: failed.reason, ...details })
        : Object.freeze({ status: failed.status, reason: failed.reason, ...details });
}

/**
 * Offline authentication using trusted local PUBLIC keys only.
 * No fetch, DNS, directory discovery, authorization or body-digest checking.
 * Keep this verifier/context long-lived: recreating memory loses replay history.
 */
export function createOfflineVerifier(options: OfflineVerifierOptions): OfflineVerifier {
    const config = resolveVerificationConfiguration(options);
    return Object.freeze({
        context: config.context,
        async verify(input: RequestParts): Promise<VerificationResult> {
            let lease: OperationLease | undefined;
            let selected: readonly ParsedSignature[] = [];
            let profile: WebBotAuthProfile | undefined;
            const evaluations: CandidateEvaluation[] = [];
            try {
                // Snapshot before the first provider callback, not just before
                // the first await. Header byte buffers must be invocation-owned.
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
                for (const signature of selected) {
                    evaluations.push(await evaluateCandidate(request, signature, agent, config, lease));
                }

                if (config.candidateMode === "exactly-one" && selected.length > 1) {
                    // Evaluate all, consume none, and expose no pre-replay success.
                    const now = config.controller.completeOperation(lease);
                    const ambiguity = new CandidateRejection({
                        status: "invalid", reason: "ambiguous-signatures",
                    });
                    const candidates = Object.freeze(evaluations.map((candidate): CandidateResult => {
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

                const eligible = evaluations.filter(
                    (candidate): candidate is EligibleCandidate => candidate.kind === "eligible",
                );
                const replay = await consumeCandidateGroups(eligible, config, lease);
                // FINAL gate. No await or application callback after this point.
                // A reset during ANY candidate/group await invalidates all prior
                // eligibility and accepted store outcomes from this invocation.
                const now = config.controller.completeOperation(lease);
                const candidates = Object.freeze(evaluations.map((candidate): CandidateResult =>
                    candidate.kind === "rejected" ? candidate.result
                        : finalizeCandidate(candidate, replay.get(candidate), now)));
                return aggregate(candidates, config.aggregate);
            } catch (error) {
                if (error instanceof SignatureError) {
                    error = new CandidateRejection(coreRejection(error.reason));
                }
                if (!(error instanceof CandidateRejection)) throw error;
                const failure = error;
                // Keep already established independent failures, but NEVER
                // publish an eligible/consumed candidate as verified on failure.
                const candidates = Object.freeze(selected.map((signature, index): CandidateResult => {
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