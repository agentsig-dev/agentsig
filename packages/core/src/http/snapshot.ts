import { isFieldName } from "../headers.js";
import { rejectMapping } from "./errors.js";
import type { HttpMappingLimits, HttpSnapshot } from "./types.js";

function ownValue(source: object, name: string): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(source, name);
    if (!descriptor) return undefined;
    if (!Object.hasOwn(descriptor, "value")) return rejectMapping("request-malformed");
    return descriptor.value as unknown;
}

/**
 * Internal descriptor validation, not public evidence of listener placement or
 * header completeness. The capture owner establishes those properties separately.
 * No body, normalized headers, framework getters or application callbacks are read.
 */
export function snapshotHttpRequest(input: unknown, limits: Readonly<HttpMappingLimits>): HttpSnapshot {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        return rejectMapping("request-malformed");
    }
    const httpVersion = ownValue(input, "httpVersion");
    if (httpVersion === "2" || httpVersion === "2.0") return rejectMapping("http2-unsupported");
    if (httpVersion !== "1.1") return rejectMapping("request-unsupported");

    const method = ownValue(input, "method");
    const url = ownValue(input, "url");
    if (typeof method !== "string" || typeof url !== "string") {
        return rejectMapping("request-malformed");
    }
    if (method.length > limits.maxHeaderBytes || url.length > limits.maxTargetUriBytes) {
        return rejectMapping("resource-limit");
    }
    if (!isFieldName(method) || !url) return rejectMapping("request-malformed");
    if (method === "CONNECT" || !url.startsWith("/")) return rejectMapping("request-unsupported");
    if (!/^\/[A-Za-z0-9\-._~:/?[\]@!$&'()*+,;=%]*$/.test(url) ||
        /%(?![0-9a-fA-F]{2})/.test(url)) return rejectMapping("request-malformed");

    const raw = ownValue(input, "rawHeaders");
    if (!Array.isArray(raw) || raw.length % 2 !== 0) return rejectMapping("headers-malformed");
    // Each occurrence costs at least the colon/space/CRLF allowance.
    if (raw.length / 2 > Math.floor(limits.maxHeaderBytes / 4)) {
        return rejectMapping("resource-limit");
    }
    const headers: string[] = [];
    let total = 0;
    for (let index = 0; index < raw.length; index += 2) {
        const nameDescriptor = Object.getOwnPropertyDescriptor(raw, String(index));
        const valueDescriptor = Object.getOwnPropertyDescriptor(raw, String(index + 1));
        if (!nameDescriptor || !valueDescriptor ||
            !Object.hasOwn(nameDescriptor, "value") || !Object.hasOwn(valueDescriptor, "value")) {
            return rejectMapping("headers-malformed");
        }
        const name: unknown = nameDescriptor.value;
        const value: unknown = valueDescriptor.value;
        if (typeof name !== "string" || typeof value !== "string") {
            return rejectMapping("headers-malformed");
        }
        total += name.length + value.length + 4;
        if (total > limits.maxHeaderBytes) return rejectMapping("resource-limit");
        if (!isFieldName(name) || /[^\t\x20-\x7e\x80-\xff]/.test(value)) {
            return rejectMapping("headers-malformed");
        }
        headers.push(name, value);
    }

    const peerAddress = ownValue(input, "peerAddress");
    const encrypted = ownValue(input, "encrypted");
    if ((peerAddress !== undefined && (typeof peerAddress !== "string" || peerAddress.length > 128)) ||
        typeof encrypted !== "boolean") return rejectMapping("request-malformed");

    return Object.freeze({
        method, url, httpVersion, rawHeaders: Object.freeze(headers), peerAddress, encrypted,
    });
}