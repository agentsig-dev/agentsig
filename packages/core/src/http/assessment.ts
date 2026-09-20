import type { IncomingMessage } from "node:http";
import { performance } from "node:perf_hooks";
import type { VerificationResult, VerifiedIdentity } from "../profiles/verification-types.js";
import { configurationRecord } from "./configuration.js";
import { invalidHttpConfiguration } from "./errors.js";
import { assertNodeHttpMapper } from "./node-mapper.js";
import type {
    AgentSigContext, HttpAdapterEvent, HttpAdapterName, HttpAdapterOutcome,
    HttpAgentSig, HttpAgentSigOptions, HttpAssessment, HttpAuthorization,
    HttpPolicyDecision, HttpPolicyHook, HttpPolicyTools, HttpRequestVerifier, VerifiedHttpAssessment,
} from "./assessment-types.js";
import type { NodeHttpMapper } from "./node-mapper.js";

interface Configuration<I extends { readonly thumbprint: string }> {
    readonly mapper: NodeHttpMapper;
    readonly verifier: HttpRequestVerifier<I>;
    readonly verify: HttpRequestVerifier<I>["verify"];
    readonly mode: "observe" | "enforce";
    readonly policy: HttpPolicyHook<I> | undefined;
    readonly observer: ((event: Readonly<HttpAdapterEvent>) => void) | undefined;
    readonly bodyPolicy: "reject" | "allow-unverified";
    readonly timeout: number;
    readonly mappingStatus: number;
    readonly denyStatus: number;
    readonly rateStatus: number;
}
interface RequestState<I extends { readonly thumbprint: string }> {
    readonly config: Configuration<I>;
    readonly adapter: HttpAdapterName;
    readonly promise: Promise<HttpAdapterOutcome<I>>;
    outcome?: HttpAdapterOutcome<I>;
}
interface Decision {
    readonly kind: "allow-verified" | "allow-anonymous" | "deny" | "rate-limit";
    readonly retryAfterSeconds?: number;
}

const requests = new WeakMap<object, {
    readonly config: object;
    readonly adapter: HttpAdapterName;
    readonly state: unknown;
}>();
const integrations = new WeakSet<object>();

function integrationError(): never {
    // Deliberately no request data, original thrown value, or cause.
    throw new Error("HTTP integration failed");
}

/**
 * Own plain result data without invoking ordinary getters or retaining external
 * mutable references. Typed arrays are copied, not falsely claimed to be frozen.
 * Used independently for private state and each application-visible view.
 */
function ownedCopy<T>(value: T): T {
    let remaining = 1_048_576;
    const ancestors = new Set<object>();
    const charge = (size: number): void => {
        remaining -= size;
        if (remaining < 0) integrationError();
    };
    function visit(item: unknown, depth: number): unknown {
        if (depth > 32) return integrationError();
        if (item === null || typeof item === "boolean" || typeof item === "undefined") {
            charge(8);
            return item;
        }
        if (typeof item === "string") { charge(item.length * 2 + 8); return item; }
        if (typeof item === "number") {
            if (!Number.isFinite(item)) return integrationError();
            charge(8);
            return item;
        }
        if (typeof item !== "object" || ancestors.has(item)) return integrationError();
        charge(32);
        if (item instanceof Uint8Array) {
            charge(item.byteLength);
            return Uint8Array.from(item);
        }
        const array = Array.isArray(item);
        const prototype: unknown = Object.getPrototypeOf(item);
        if (!array && prototype !== Object.prototype && prototype !== null) return integrationError();
        if (array && item.length > remaining / 8) return integrationError();
        ancestors.add(item);
        const result: Record<string, unknown> | unknown[] = array ? [] : {};
        for (const key in item) {
            if (!Object.hasOwn(item, key)) continue;
            charge(key.length * 2 + 16);
            const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
            if (!Object.hasOwn(descriptor, "value")) return integrationError();
            Object.defineProperty(result, key, {
                value: visit(descriptor.value as unknown, depth + 1),
                enumerable: true, writable: false, configurable: false,
            });
        }
        ancestors.delete(item);
        return Object.freeze(result);
    }
    return visit(value, 0) as T;
}

function resolve<I extends { readonly thumbprint: string }>(options: HttpAgentSigOptions<I>): Configuration<I> {
    const input = configurationRecord(options, [
        "mapper", "verifier", "mode", "policy", "bodyPolicy", "onEvent",
        "policyTimeoutMilliseconds", "mappingFailureStatus", "denyStatus", "rateLimitStatus",
    ]);
    const mapper = input.mapper as NodeHttpMapper;
    assertNodeHttpMapper(mapper);
    const verifier = input.verifier as HttpRequestVerifier<I>;
    // Verifiers are explicitly trusted application implementations, not remote
    // data. Snapshot the callable once while preserving its receiver.
    if (!verifier || typeof verifier !== "object") return invalidHttpConfiguration();
    const verify = verifier.verify;
    if (typeof verify !== "function") return invalidHttpConfiguration();
    if (input.mode !== "observe" && input.mode !== "enforce") return invalidHttpConfiguration();
    if (input.onEvent !== undefined && typeof input.onEvent !== "function") return invalidHttpConfiguration();
    if (input.mode === "observe") {
        if (["policy", "bodyPolicy", "policyTimeoutMilliseconds", "mappingFailureStatus",
            "denyStatus", "rateLimitStatus"].some(key => Object.hasOwn(input, key))) {
            return invalidHttpConfiguration();
        }
    } else if (typeof input.policy !== "function") return invalidHttpConfiguration();
    const bodyPolicy = input.bodyPolicy ?? "reject";
    if (bodyPolicy !== "reject" && bodyPolicy !== "allow-unverified") return invalidHttpConfiguration();
    const timeout = input.policyTimeoutMilliseconds ?? 1000;
    if (typeof timeout !== "number" || !Number.isSafeInteger(timeout) ||
        timeout < 1 || timeout > 2_147_483_647) return invalidHttpConfiguration();
    function status(value: unknown, fallback: number): number {
        if (value === undefined) return fallback;
        if (typeof value !== "number" || !Number.isInteger(value) || value < 400 || value > 599) {
            return invalidHttpConfiguration();
        }
        return value;
    }
    return Object.freeze({
        mapper, verifier, verify, mode: input.mode,
        policy: input.policy as HttpPolicyHook<I> | undefined,
        observer: input.onEvent as Configuration<I>["observer"],
        bodyPolicy, timeout,
        mappingStatus: status(input.mappingFailureStatus, 400),
        denyStatus: status(input.denyStatus, 401),
        rateStatus: status(input.rateLimitStatus, 429),
    });
}

function compatible(first: object, second: object): boolean {
    const keys = Object.keys(first);
    return keys.length === Object.keys(second).length && keys.every(key =>
        Object.getOwnPropertyDescriptor(first, key)?.value ===
        Object.getOwnPropertyDescriptor(second, key)?.value);
}

/** Type erasure is confined to this private registry, after exact owner matching. */
function existingState<I extends { readonly thumbprint: string }>(
    request: IncomingMessage, config: Configuration<I>, adapter?: HttpAdapterName,
): RequestState<I> | undefined {
    const entry = requests.get(request);
    if (!entry) return undefined;
    if (!compatible(entry.config, config) || (adapter !== undefined && entry.adapter !== adapter)) {
        return integrationError();
    }
    // Matching includes verifier object/callable and policy identity. A different
    // identity provider cannot reinterpret a prior request's completed evidence.
    return entry.state as RequestState<I>;
}

async function evaluate<I extends { readonly thumbprint: string }>(
    request: IncomingMessage, adapter: HttpAdapterName, config: Configuration<I>,
): Promise<HttpAdapterOutcome<I>> {
    const emit = (event: HttpAdapterEvent): void => {
        try { config.observer?.(Object.freeze(event)); } catch { /* Never retain observer errors. */ }
    };
    const eventBase = { adapter, ingress: config.mapper.ingressMode };
    const mapping = config.mapper.map(request);
    let assessment: HttpAssessment<I>;
    if (mapping.status === "mapping-rejected") {
        assessment = Object.freeze({ ...mapping, bodyIntegrity: "unverified" });
        emit({ type: "mapping-rejected", code: mapping.code, ...eventBase });
    } else {
        let verification: VerificationResult<I>;
        try {
            // A separate copy prevents the verifier from changing policy's bound target.
            verification = ownedCopy(await config.verify.call(config.verifier, ownedCopy(mapping.request)));
            if (!verification || !["verified", "unsigned", "invalid", "unverified"].includes(verification.status) ||
                !Array.isArray(verification.candidates) ||
                (verification.status === "verified" &&
                    (!Array.isArray(verification.verifiedCandidates) ||
                        verification.verifiedCandidates.length === 0 ||
                        verification.verifiedCandidates.some(candidate => candidate.status !== "verified")))) {
                return integrationError();
            }
        } catch {
            emit({ type: "verification-error", ...eventBase });
            return integrationError();
        }
        assessment = ownedCopy({ ...mapping, verification, bodyIntegrity: "unverified" as const });
    }

    const finish = (
        authorization: HttpAuthorization, action: "continue" | "respond",
        responseStatus?: number, retryAfterSeconds?: number,
    ): HttpAdapterOutcome<I> => Object.freeze({
        context: Object.freeze({ assessment, authorization: Object.freeze(authorization) }),
        action,
        ...(responseStatus === undefined ? {} : { responseStatus }),
        ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    });
    if (config.mode === "observe") return finish({ status: "not-evaluated" }, "continue");

    const denyStatus = assessment.status === "mapping-rejected" ? config.mappingStatus : config.denyStatus;
    const bodyRejected = assessment.status === "mapped" && assessment.bodyPresent && config.bodyPolicy === "reject";
    const eligibleVerified = assessment.status === "mapped" && assessment.verification.status === "verified";
    const view = ownedCopy(assessment);
    const decisions = new WeakMap<object, Decision>();
    let active = true;
    const controller = new AbortController();
    const token = (decision: Decision): HttpPolicyDecision => {
        if (!active) return integrationError();
        const handle = Object.freeze({});
        decisions.set(handle, Object.freeze(decision));
        return handle as HttpPolicyDecision;
    };
    const tools: HttpPolicyTools<I> = Object.freeze({
        signal: controller.signal,
        allowVerified(candidate: VerifiedHttpAssessment<I>) {
            if (candidate !== view || !eligibleVerified || bodyRejected) return integrationError();
            return token({ kind: "allow-verified" });
        },
        allowAnonymous() { return token({ kind: "allow-anonymous" }); },
        deny() { return token({ kind: "deny" }); },
        rateLimit(retryAfterSeconds?: number) {
            if (retryAfterSeconds !== undefined && (!Number.isSafeInteger(retryAfterSeconds) ||
                retryAfterSeconds < 0 || retryAfterSeconds > 2_147_483_647)) return integrationError();
            return token({
                kind: "rate-limit",
                ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
            });
        },
    });

    type Result = { value: unknown } | { failure: "error" | "timeout" };
    const started = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<Result>(resolve => {
        timer = setTimeout(() => resolve({ failure: "timeout" }), config.timeout);
    });
    const work = Promise.resolve().then(() => config.policy!(view, tools)).then(
        value => ({ value }) as Result,
        () => ({ failure: "error" }) as Result,
    );
    const result = await Promise.race([work, timeout]);
    active = false;
    clearTimeout(timer);
    // Synchronous callback work and event-loop delay count against the same budget.
    const timedOut = performance.now() - started >= config.timeout;
    if (timedOut || "failure" in result) {
        if (timedOut || ("failure" in result && result.failure === "timeout")) controller.abort();
        emit({ type: "policy-denied", reason: timedOut ? "timeout" : "failure" in result ? result.failure : "error", ...eventBase });
        return finish({ status: "denied" }, "respond", denyStatus);
    }
    const selected = result.value !== null && typeof result.value === "object"
        ? decisions.get(result.value) : undefined;
    if (!selected) {
        emit({ type: "policy-denied", reason: "invalid-decision", ...eventBase });
        return finish({ status: "denied" }, "respond", denyStatus);
    }
    if (selected.kind === "rate-limit") {
        return finish({
            status: "rate-limited",
            ...(selected.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: selected.retryAfterSeconds }),
        }, "respond", config.rateStatus, selected.retryAfterSeconds);
    }
    if (bodyRejected) {
        emit({ type: "policy-denied", reason: "body-unverified", ...eventBase });
        return finish({ status: "denied" }, "respond", denyStatus);
    }
    if (assessment.status === "mapping-rejected" || selected.kind === "deny") {
        return finish({ status: "denied" }, "respond", denyStatus);
    }
    if (selected.kind === "allow-verified" && !eligibleVerified) return integrationError();
    return finish({
        status: "allowed", basis: selected.kind === "allow-verified" ? "verified-identity" : "anonymous",
    }, "continue");
}

export function assertHttpAgentSig(value: HttpAgentSig): void {
    if (!value || !integrations.has(value)) return invalidHttpConfiguration();
}

/** Shared across adapters; owns authentication invocation and policy, not crypto. */
export function createHttpAgentSig<I extends { readonly thumbprint: string } = VerifiedIdentity>(
    options: HttpAgentSigOptions<I>,
): HttpAgentSig<I> {
    const config = resolve(options);
    const integration: HttpAgentSig<I> = Object.freeze({
        mapper: config.mapper,
        assess(request: IncomingMessage, adapter: HttpAdapterName): Promise<HttpAdapterOutcome<I>> {
            if (!request || typeof request !== "object" ||
                !["express", "fastify", "hono"].includes(adapter)) return integrationError();
            let state = existingState(request, config, adapter);
            if (!state) {
                // Register before any observer, verifier or policy callback executes.
                const promise = Promise.resolve().then(() => evaluate(request, adapter, config));
                state = { config, adapter, promise };
                requests.set(request, { config, adapter, state });
                const current = state;
                void promise.then(outcome => { current.outcome = outcome; }, () => { });
            }
            return state.promise.then(outcome => ownedCopy(outcome));
        },
        get(request: IncomingMessage): AgentSigContext<I> {
            const state = existingState(request, config);
            if (!state?.outcome) return integrationError();
            return ownedCopy(state.outcome.context);
        },
    });
    integrations.add(integration);
    return integration;
}