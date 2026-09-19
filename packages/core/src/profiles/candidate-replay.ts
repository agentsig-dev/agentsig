import type { CandidateEvaluation } from "./candidate-evaluation.js";
import type { LocalIdentityProposal } from "./agent-bindings.js";
import { CandidateRejection } from "./codes.js";
import type { ProfileRejection, StoreOutcome } from "./codes.js";
import type { OperationLease } from "./operation-epochs.js";
import type { VerificationConfiguration } from "./verification-config.js";

export type EligibleCandidate<
    Identity extends { readonly thumbprint: string } = LocalIdentityProposal,
> = Extract<CandidateEvaluation<Identity>, { readonly kind: "eligible" }>;

/** Internal outcomes only; accepted storage is not a verified request. */
export type CandidateReplayOutcome = "accepted" | "optional" | ProfileRejection;

function storeRejection(outcome: Exclude<StoreOutcome, "accepted">): ProfileRejection {
    switch (outcome) {
        case "replayed": return { status: "invalid", reason: "replay-detected" };
        case "unavailable": return { status: "unverified", reason: "replay-store-unavailable" };
        case "per-key-quota-exceeded":
            return { status: "unverified", reason: "per-key-quota-exceeded" };
    }
}

/**
 * Invocation-local grouping only. Never cache an accepted outcome on a verifier
 * or context: another request must perform its own atomic consume and replay.
 * Exactly-one ambiguity MUST bypass this function entirely.
 *
 * No public success is constructed here. The caller must perform a FINAL
 * epoch/health and per-candidate time check after all groups have completed.
 */
export async function consumeCandidateGroups<
    Candidate extends EligibleCandidate<{ readonly thumbprint: string }>,
>(
    candidates: readonly Candidate[],
    config: Pick<VerificationConfiguration, "scope" | "controller">,
    lease: OperationLease,
): Promise<ReadonlyMap<Candidate, CandidateReplayOutcome>> {
    const outcomes = new Map<Candidate, CandidateReplayOutcome>();
    const groups = new Map<string, Candidate[]>();
    for (const candidate of candidates) {
        const nonce = candidate.metadata.nonce;
        if (nonce === undefined) {
            // Metadata has already enforced the candidate's nonce policy.
            outcomes.set(candidate, "optional");
            continue;
        }
        // JSON tuples avoid delimiter collisions. Labels/profiles deliberately
        // do not partition replay protection.
        const key = JSON.stringify([config.scope, candidate.identity.thumbprint, nonce]);
        const existing = groups.get(key);
        if (existing) existing.push(candidate);
        else groups.set(key, [candidate]);
    }

    for (const group of groups.values()) {
        const ready: Candidate[] = [];
        try {
            const outcome = await config.controller.consume(lease, (now) => {
                let retainUntil = 0;
                let lastFailure: CandidateRejection | undefined;
                for (const candidate of group) {
                    try {
                        // An earlier group's await may have exhausted this
                        // member's window. Recheck before touching the store.
                        candidate.time.check(
                            candidate.metadata.created, candidate.metadata.expires, now,
                        );
                        const deadline = candidate.time.retainUntil(candidate.metadata.created, now);
                        retainUntil = Math.max(retainUntil, deadline);
                        ready.push(candidate);
                    } catch (error) {
                        if (!(error instanceof CandidateRejection)) throw error;
                        outcomes.set(candidate, error.rejection);
                        lastFailure = error;
                    }
                }
                if (!ready.length) {
                    // Every member already has its own rejection. Throw before
                    // dispatch; do not invent a consume for an empty group.
                    if (!lastFailure) throw new Error("Empty internal replay group");
                    throw lastFailure;
                }
                const first = ready[0]!;
                return {
                    scope: config.scope,
                    keyThumbprint: first.identity.thumbprint,
                    nonce: first.metadata.nonce!,
                    retainUntilEpochSeconds: retainUntil,
                };
            });
            // Store dispatch can suspend. Retention is not rolled back on
            // expiry/reset; deleting it could reopen another replay window.
            const now = config.controller.now(lease);
            for (const candidate of ready) {
                try {
                    candidate.time.check(
                        candidate.metadata.created, candidate.metadata.expires, now,
                    );
                    outcomes.set(candidate, outcome === "accepted"
                        ? "accepted" : storeRejection(outcome));
                } catch (error) {
                    if (!(error instanceof CandidateRejection)) throw error;
                    outcomes.set(candidate, error.rejection);
                }
            }
        } catch (error) {
            if (!(error instanceof CandidateRejection)) throw error;
            for (const candidate of group) {
                // Keep independent member failures; the final epoch gate will
                // prevent any prior group's acceptance after a reset.
                if (!outcomes.has(candidate)) outcomes.set(candidate, error.rejection);
            }
        }
    }
    return outcomes;
}