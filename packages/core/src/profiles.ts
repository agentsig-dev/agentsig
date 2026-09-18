/**
 * Public Web Bot Auth profile API, separate from the pure RFC 9421 entry.
 * Offline only: no discovery, network access, authorization or body validation.
 * Export deliberately; internal eligibility and context capabilities stay private.
 */
export { createWebBotAuthSigner } from "./profiles/signer.js";
export type { SignedRequestHeaders, WebBotAuthSigner } from "./profiles/signer.js";
export type { SigningOptions } from "./profiles/signing-config.js";
export type { SigningClock, SigningNonceGenerator } from "./profiles/signing-providers.js";
export { SigningError } from "./profiles/signing-errors.js";

export { createOfflineVerifier } from "./profiles/verifier.js";
export type {
    CandidatePolicy,
    CandidateResult,
    OfflineVerifier,
    OfflineVerifierOptions,
    RejectedCandidate,
    VerificationProfilePolicy,
    VerificationResult,
    VerifiedCandidate,
    VerifiedIdentity,
} from "./profiles/verification-types.js";

export { createSecurityContext } from "./profiles/security-context.js";
export type { SecurityContext, SecurityContextOptions } from "./profiles/security-context.js";
export type { ReplayConsumeInput, ReplayStore } from "./profiles/replay-store.js";
export type { ContextObserver } from "./profiles/context-observer.js";
export type {
    ClockHealthEvent, ClockResetEvent, ResetReason, SecurityContextEvent,
} from "./profiles/context-events.js";
export { OperatorError } from "./profiles/operator-errors.js";
export type { OperatorErrorCode } from "./profiles/operator-errors.js";

export { loadJwks } from "./profiles/jwks.js";
export type {
    JwksLookup, LoadedJwks, LoadedVerificationKey, LoadJwksOptions, SkippedJwk,
} from "./profiles/jwks.js";
export { InvalidJwksError } from "./profiles/jwks-error.js";
export type { JwksFormat, SkippedKeyReason } from "./profiles/jwks-algorithm.js";
export type { AgentBinding } from "./profiles/agent-bindings.js";
export type { NoncePolicy } from "./profiles/metadata.js";
export type { ClockPolicy, ProfileLimits, ReplayPolicy, TimePolicy } from "./profiles/defaults.js";
export { WEB_BOT_AUTH_PROFILES } from "./profiles/agent-header.js";
export type { WebBotAuthProfile } from "./profiles/agent-header.js";

export { ProfileConfigurationError, RESULT_CATALOG_VERSION, RESULT_CODES } from "./profiles/codes.js";
export type {
    ConfigurationCode, InvalidCode, ProfileRejection,
    StoreOutcome, UnsignedCode, UnverifiedCode, VerifiedCode,
} from "./profiles/codes.js";