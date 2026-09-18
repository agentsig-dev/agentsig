import {
    parse,
    parseRaw,
    serialize,
    serializeMember,
    SfConfigurationError,
    SfLimitError,
    SfSerializationError,
    SfSyntaxError,
} from "@agentsig/structured-fields";
import type { InnerList, Parameters } from "@agentsig/structured-fields";
import {
    SignatureConfigurationError,
    SignatureError,
    SignatureLimitError,
} from "./errors.js";
import { combineValues, fieldValues, isFieldName, requireAscii, validateHeaders } from "./headers.js";
import { checkLimit, resolveCoreLimits } from "./limits.js";
import type {
    HeaderFields, Limits, LimitOverrides, ParsedSignature, SignatureInput,
} from "./types.js";

/** Translate expected SF failures; do not hide unrelated programming errors. */
export function withSfErrors<T>(operation: () => T): T {
    try {
        return operation();
    } catch (error) {
        if (error instanceof SfLimitError) {
            throw new SignatureLimitError(
                `structuredFields.${error.limit}`, error.maximum, error.observed,
            );
        }
        if (error instanceof SfSyntaxError || error instanceof SfSerializationError) {
            throw new SignatureError("malformed");
        }
        if (error instanceof SfConfigurationError) throw new SignatureConfigurationError();
        throw error;
    }
}

function validateParameters(parameters: Parameters, limits: Readonly<Limits>): void {
    if (!Array.isArray(parameters)) throw new SignatureError("malformed");
    checkLimit(limits, "maxParameters", parameters.length);
    for (const pair of parameters) {
        if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string") {
            throw new SignatureError("malformed");
        }
        const value = pair[1];
        if (value === null || typeof value !== "object") throw new SignatureError("malformed");
        // Signature metadata and component identifiers use RFC 8941, not the
        // Date/Display String additions of RFC 9651 (§2.4 of RFC 9651).
        if (value.kind === "date" || value.kind === "display-string") {
            throw new SignatureError("unsupported");
        }
    }
}

export function signatureInnerList(
    input: SignatureInput,
    limits: Readonly<Limits>,
): InnerList {
    if (
        input === null || typeof input !== "object" ||
        typeof input.label !== "string" ||
        !Array.isArray(input.components)
    ) throw new SignatureError("malformed");

    checkLimit(limits, "maxComponentsPerSignature", input.components.length);
    validateParameters(input.parameters, limits);
    for (const [name, value] of input.parameters) {
        if (name === "created" || name === "expires") {
            if (value.kind !== "integer") throw new SignatureError("malformed");
        } else if (["nonce", "alg", "keyid", "tag"].includes(name)) {
            if (value.kind !== "string") throw new SignatureError("malformed");
        }
        // Unknown metadata remains signed, with no invented policy interpretation.
        // Unknown component parameters are different: base generation rejects them.
    }
    const items = input.components.map((component) => {
        if (
            component === null || typeof component !== "object" ||
            typeof component.name !== "string"
        ) throw new SignatureError("malformed");
        const name = component.name;
        if (
            name !== name.toLowerCase() ||
            (name.startsWith("@")
                ? !/^@[a-z][a-z0-9-]*$/.test(name)
                : !isFieldName(name))
        ) throw new SignatureError("malformed");
        if (name === "@signature-params") throw new SignatureError("malformed");
        validateParameters(component.parameters, limits);
        return {
            kind: "item" as const,
            bare: { kind: "string" as const, value: name },
            parameters: component.parameters,
        };
    });
    const inner: InnerList = { kind: "inner-list", items, parameters: input.parameters };
    // Serializer validates all caller-supplied values, keys, numeric ranges,
    // duplicate semantic parameters, and the label before any cryptographic use.
    withSfErrors(() => serialize({
        kind: "dictionary", entries: [[input.label, inner]],
    }, { limits: limits.structuredFields }));
    return inner;
}

export function signatureParameters(input: SignatureInput, limits: Readonly<Limits>): string {
    const inner = signatureInnerList(input, limits);
    return withSfErrors(() => serializeMember(inner, { limits: limits.structuredFields }));
}

/**
 * Parse all signature pairs in Signature-Input order. Missing counterpart
 * labels fail this all-pairs API rather than silently disappearing.
 * Empty unsigned header sections return an empty array.
 */
export function parseSignatureHeaders(
    headers: HeaderFields,
    overrides: LimitOverrides = {},
): readonly ParsedSignature[] {
    const limits = resolveCoreLimits(overrides);
    validateHeaders(headers, limits);
    const inputs = fieldValues(headers, "signature-input");
    const signatures = fieldValues(headers, "signature");
    if (!inputs.length && !signatures.length) return [];
    if (!inputs.length || !signatures.length) throw new SignatureError("malformed");

    const inputText = requireAscii(combineValues(inputs, limits, "maxSignatureHeaderBytes"));
    const signatureText = requireAscii(combineValues(signatures, limits, "maxSignatureHeaderBytes"));
    checkLimit(limits, "maxSignatureHeaderBytes", inputText.length + signatureText.length);

    return withSfErrors(() => {
        const options = { limits: limits.structuredFields };
        const rawInput = parseRaw(inputText, "dictionary", options);
        const rawSignature = parseRaw(signatureText, "dictionary", options);
        for (const raw of [rawInput, rawSignature]) {
            checkLimit(limits, "maxSignatures", raw.root.entries.length);
            const labels = new Set<string>();
            for (const entry of raw.root.entries) {
                // RFC 9421 §§4.1–4.2 require globally unique labels even across lines.
                if (labels.has(entry.key)) throw new SignatureError("malformed");
                labels.add(entry.key);
            }
        }
        const inputDictionary = parse(inputText, "dictionary", options);
        const signatureDictionary = parse(signatureText, "dictionary", options);
        const values = new Map(signatureDictionary.entries);
        if (values.size !== inputDictionary.entries.length) throw new SignatureError("malformed");

        const result: ParsedSignature[] = [];
        for (const [label, member] of inputDictionary.entries) {
            const signature = values.get(label);
            if (
                member.kind !== "inner-list" ||
                signature?.kind !== "item" ||
                signature.bare.kind !== "bytes"
            ) throw new SignatureError("malformed");
            // Parameters on Signature values have no defined semantics in this API.
            // Validate their SF version without treating them as signature metadata.
            validateParameters(signature.parameters, limits);
            const input: SignatureInput = {
                label,
                components: member.items.map((item) => {
                    if (item.bare.kind !== "string") throw new SignatureError("malformed");
                    return { name: item.bare.value, parameters: item.parameters };
                }),
                parameters: member.parameters,
            };
            signatureInnerList(input, limits);
            result.push({ input, signature: signature.bare.value });
        }
        return result;
    });
}