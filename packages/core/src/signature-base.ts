import { Buffer } from "node:buffer";
import {
    parse,
    serialize,
    serializeMember,
} from "@agentsig/structured-fields";
import type { FieldType, Item } from "@agentsig/structured-fields";
import { SignatureConfigurationError, SignatureError } from "./errors.js";
import { combineValues, fieldValues, requireAscii, validateHeaders } from "./headers.js";
import { checkLimit, resolveCoreLimits } from "./limits.js";
import { signatureParameters, withSfErrors } from "./signature-input.js";
import { requestComponent } from "./uri.js";
import type {
    CanonicalizationOptions, CoveredComponent, HeaderFields, HttpMessage,
    Limits, RequestParts, SignatureBase, SignatureInput,
} from "./types.js";

interface ComponentFlags {
    readonly req: boolean;
    readonly sf: boolean;
    readonly bs: boolean;
    readonly key?: string;
    readonly name?: string;
}

function componentFlags(component: CoveredComponent): ComponentFlags {
    let req = false;
    let sf = false;
    let bs = false;
    let key: string | undefined;
    let name: string | undefined;
    for (const [parameter, value] of component.parameters) {
        if (parameter === "tr") throw new SignatureError("unsupported");
        if (parameter === "req" || parameter === "sf" || parameter === "bs") {
            if (value.kind !== "boolean" || value.value !== true) {
                throw new SignatureError("malformed");
            }
            if (parameter === "req") req = true;
            if (parameter === "sf") sf = true;
            if (parameter === "bs") bs = true;
        } else if (parameter === "key" || parameter === "name") {
            if (value.kind !== "string") throw new SignatureError("malformed");
            if (parameter === "key") key = value.value;
            else name = value.value;
        } else {
            // RFC 9421 §2.5: ignoring unknown component parameters changes coverage.
            throw new SignatureError("unsupported");
        }
    }
    const derived = component.name.startsWith("@");
    if (derived && (sf || bs || key !== undefined)) throw new SignatureError("malformed");
    if ((!derived || component.name !== "@query-param") && name !== undefined) {
        throw new SignatureError("malformed");
    }
    if (component.name === "@query-param" && name === undefined) {
        throw new SignatureError("malformed");
    }
    if (bs && (sf || key !== undefined)) throw new SignatureError("malformed");
    return {
        req, sf, bs,
        ...(key === undefined ? {} : { key }),
        ...(name === undefined ? {} : { name }),
    };
}

const BUILTIN_FIELD_TYPES: Readonly<Record<string, FieldType>> = Object.freeze({
    "signature-input": "dictionary",
    signature: "dictionary",
    "content-digest": "dictionary",
});

function fieldType(name: string, options: CanonicalizationOptions): FieldType | undefined {
    const configured = options.structuredFieldTypes;
    if (configured && Object.hasOwn(configured, name)) {
        const value = configured[name];
        if (value !== "item" && value !== "list" && value !== "dictionary") {
            throw new SignatureConfigurationError();
        }
        return value;
    }
    return Object.hasOwn(BUILTIN_FIELD_TYPES, name) ? BUILTIN_FIELD_TYPES[name] : undefined;
}

function headerComponent(
    headers: HeaderFields,
    version: RequestParts["httpVersion"],
    component: CoveredComponent,
    flags: ComponentFlags,
    limits: Readonly<Limits>,
    options: CanonicalizationOptions,
): string {
    const values = fieldValues(headers, component.name, version);
    if (!values.length) throw new SignatureError("missing-component");
    const sfOptions = { limits: limits.structuredFields };
    if (flags.bs) {
        // Bound base64 expansion before constructing encoded member values.
        let size = 0;
        for (let index = 0; index < values.length; index++) {
            size += 2 + 4 * Math.ceil(values[index]!.length / 3) + (index ? 2 : 0);
            checkLimit(limits, "maxSignatureBaseBytes", size);
        }
        return withSfErrors(() => serialize({
            kind: "list",
            members: values.map((value): Item => ({
                kind: "item",
                bare: { kind: "bytes", value: Buffer.from(value, "latin1") },
                parameters: [],
            })),
        }, sfOptions));
    }
    const combined = requireAscii(combineValues(values, limits));
    if (!flags.sf && flags.key === undefined) return combined;

    const type = fieldType(component.name, options);
    if (!type) throw new SignatureError("unsupported");
    if (flags.key !== undefined && type !== "dictionary") {
        throw new SignatureError("malformed");
    }
    return withSfErrors(() => {
        const parsed = parse(combined, type, sfOptions);
        if (flags.key !== undefined) {
            if (parsed.kind !== "dictionary") throw new SignatureError("malformed");
            const selected = parsed.entries.find(([key]) => key === flags.key)?.[1];
            if (!selected) throw new SignatureError("missing-component");
            return serializeMember(selected, sfOptions);
        }
        return serialize(parsed, sfOptions);
    });
}

/** RFC 9421 §2.5. Pure canonicalization: no clock, trust, network, or body policy. */
export function createSignatureBase(
    message: HttpMessage,
    input: SignatureInput,
    options: CanonicalizationOptions = {},
): SignatureBase {
    const limits = resolveCoreLimits(options.limits);
    const parameters = signatureParameters(input, limits);
    if (!message || (message.kind !== "request" && message.kind !== "response")) {
        throw new SignatureError("malformed");
    }
    const headers = message.kind === "request" ? message.request?.headers : message.headers;
    validateHeaders(headers, limits);
    if (message.kind === "response" && message.request) {
        validateHeaders(message.request.headers, limits);
    }

    const lines: string[] = [];
    let length = 0;
    const seen = new Set<string>();
    for (const component of input.components) {
        const identifier = withSfErrors(() => serializeMember({
            kind: "item",
            bare: { kind: "string", value: component.name },
            parameters: component.parameters,
        }, { limits: limits.structuredFields }));
        if (seen.has(identifier)) throw new SignatureError("malformed");
        seen.add(identifier);
        const flags = componentFlags(component);
        if (flags.req && message.kind === "request") throw new SignatureError("malformed");
        const request = message.kind === "request" ? message.request : message.request;
        if (flags.req && !request) throw new SignatureError("missing-component");
        let value: string;
        if (component.name.startsWith("@")) {
            if (component.name === "@status") {
                if (message.kind !== "response" || flags.req) throw new SignatureError("malformed");
                if (!Number.isInteger(message.status) || message.status < 100 || message.status > 599) {
                    throw new SignatureError("malformed");
                }
                value = String(message.status);
            } else {
                if (message.kind === "response" && !flags.req) throw new SignatureError("missing-component");
                if (!request) throw new SignatureError("missing-component");
                value = requestComponent(request, component.name, flags.name, limits);
            }
        } else {
            const section = flags.req ? request!.headers : headers;
            const version = flags.req
                ? request!.httpVersion
                : message.kind === "request" ? message.request.httpVersion : message.httpVersion;
            value = headerComponent(section, version, component, flags, limits, options);
        }
        requireAscii(value);
        if (/[\r\n]/.test(value)) throw new SignatureError("malformed");
        length += identifier.length + 2 + value.length + 1;
        checkLimit(limits, "maxSignatureBaseBytes", length);
        lines.push(`${identifier}: ${value}\n`);
    }
    const prefix = '"@signature-params": ';
    checkLimit(limits, "maxSignatureBaseBytes", length + prefix.length + parameters.length);
    lines.push(prefix + parameters);
    const text = requireAscii(lines.join(""));
    // No terminal newline. ASCII is a subset of UTF-8, with identical bytes.
    return { text, bytes: Uint8Array.from(Buffer.from(text, "utf8")) };
}