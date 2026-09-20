/** Node HTTP/1.1 mapping only; no implicit authentication or authorization. */
export {
    HTTP_MAPPING_ERROR_CODES,
    HTTP_MAPPING_ERROR_CATALOG_VERSION,
    HttpMappingError,
} from "./http/errors.js";
export type { HttpMappingErrorCode } from "./http/errors.js";
export { DEFAULT_HTTP_MAPPING_LIMITS } from "./http/configuration.js";
export { createNodeHttpMapper } from "./http/node-mapper.js";
export type { NodeHttpMapper } from "./http/node-mapper.js";
export type {
    HttpIngress,
    HttpMapperOptions,
    HttpMappingLimits,
    HttpMappingResult,
    MappedHttpRequest,
    ObservedClient,
    RejectedHttpMapping,
} from "./http/types.js";

export { createHttpAgentSig } from "./http/assessment.js";
export type {
    AgentSigContext,
    HttpAdapterEvent,
    HttpAdapterName,
    HttpAdapterOutcome,
    HttpAgentSig,
    HttpAgentSigOptions,
    HttpAssessment,
    HttpAuthorization,
    HttpPolicyDecision,
    HttpPolicyHook,
    HttpPolicyTools,
    HttpRequestVerifier,
    VerifiedHttpAssessment,
} from "./http/assessment-types.js";