import { createNetworkVerifier as createInternalNetworkVerifier } from "./discovery/network-verifier.js";
import type { NetworkVerifier, NetworkVerifierOptions } from "./discovery/network-verifier.js";
import { ProfileConfigurationError } from "./profiles/codes.js";
import type { VerificationResult, VerifiedCandidate } from "./profiles/verification-types.js";
import type { DiscoveredIdentity } from "./discovery/network-candidate.js";

/**
 * Public directory discovery and full request authentication.
 * Test transports, clocks, raw responses and key-provider injection are not API.
 * Keep the verifier and its security context long-lived.
 */
export function createNetworkVerifier(options: NetworkVerifierOptions): NetworkVerifier {
    if (arguments.length !== 1) {
        throw new ProfileConfigurationError("invalid-candidate-policy");
    }
    return createInternalNetworkVerifier(options);
}

export type { NetworkVerifier, NetworkVerifierOptions };
export type { DiscoveredIdentity };
export type NetworkVerificationResult = VerificationResult<DiscoveredIdentity>;
export type NetworkVerifiedCandidate = VerifiedCandidate<DiscoveredIdentity>;
export type {
    DirectoryRefreshEvent, DirectoryRefreshResult,
} from "./discovery/directory-service.js";
export type { DirectoryDocumentDiagnostic } from "./discovery/directory-document.js";
export type { DirectoryCacheOptions } from "./discovery/directory-cache.js";
export type { DirectoryHttpsProxy } from "./discovery/proxy-tls.js";
export { createDirectoryAddressPolicy } from "./discovery/address-policy.js";
export type {
    DirectoryAddressException, DirectoryAddressPolicy,
} from "./discovery/address-policy.js";