import { evaluateCandidate } from "./candidate-evaluation.js";
import { resolveVerificationConfiguration } from "./verification-config.js";
import { createVerificationEngine } from "./verification-engine.js";
import type { OfflineVerifier, OfflineVerifierOptions } from "./verification-types.js";

/**
 * Offline authentication using trusted local PUBLIC keys only.
 * No fetch, DNS, directory discovery, authorization or body-digest checking.
 * Keep this verifier/context long-lived: recreating memory loses replay history.
 */
export function createOfflineVerifier(options: OfflineVerifierOptions): OfflineVerifier {
    const config = resolveVerificationConfiguration(options);
    return createVerificationEngine(config, () => ({
        evaluate(request, signature, agent, lease) {
            return evaluateCandidate(request, signature, agent, config, lease);
        },
        checkEvidence() {
            // Local keys and bindings are immutable configuration snapshots.
            // There is no remote cache membership or freshness to recheck here.
        },
    }));
}