import { Buffer } from "node:buffer";
import { TextDecoder } from "node:util";
import { ProfileConfigurationError } from "./codes.js";

function invalid(): never {
    throw new ProfileConfigurationError("invalid-jwks");
}

/**
 * Load trusted local configuration, never request-supplied keys.
 * Text is bounded before JSON parsing. Object input is copied with incremental
 * JSON-byte accounting, not unbounded JSON.stringify or recursive traversal.
 * This budget limits the representation, not exact JavaScript heap overhead.
 */
export function snapshotJwksInput(input: unknown, maximumBytes: number): unknown {
    let remaining = maximumBytes;
    const charge = (bytes: number): void => {
        if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > remaining) invalid();
        remaining -= bytes;
    };

    if (typeof input === "string" || input instanceof Uint8Array) {
        // UTF-8 requires at least as many bytes as UTF-16 code units.
        if (input.length > maximumBytes) invalid();
        let source: string;
        if (typeof input === "string") {
            if (Buffer.byteLength(input, "utf8") > maximumBytes) invalid();
            source = input;
        } else {
            try {
                source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
                    .decode(input);
            } catch {
                return invalid();
            }
        }
        try {
            // RFC 7517 §5 permits last-member-wins JSON parsing for duplicates.
            // The resulting value is still structurally checked by the loader.
            return JSON.parse(source) as unknown;
        } catch {
            return invalid();
        }
    }

    function chargeString(value: string): void {
        // Count JSON quotes and escaping without allocating the encoded string.
        if (value.length > remaining) invalid();
        charge(2);
        for (let index = 0; index < value.length; index++) {
            const code = value.charCodeAt(index);
            if (code === 34 || code === 92 ||
                code === 8 || code === 9 || code === 10 || code === 12 || code === 13) {
                charge(2);
            } else if (code < 32) {
                charge(6);
            } else if (code >= 0xd800 && code <= 0xdbff) {
                const next = value.charCodeAt(index + 1);
                if (next >= 0xdc00 && next <= 0xdfff) {
                    charge(4);
                    index++;
                } else {
                    charge(6); // JSON escapes lone surrogates.
                }
            } else if (code >= 0xdc00 && code <= 0xdfff) {
                charge(6);
            } else {
                charge(code < 128 ? 1 : code < 2048 ? 2 : 3);
            }
        }
    }

    interface Frame {
        readonly source: object;
        readonly target: Record<string, unknown> | unknown[];
        readonly keys: readonly string[] | undefined;
        readonly length: number;
        position: number;
    }
    const stack: Frame[] = [];
    const ancestors = new Set<object>();

    function copy(value: unknown): unknown {
        if (value === null) {
            charge(4);
            return null;
        }
        if (typeof value === "string") {
            chargeString(value);
            return value;
        }
        if (typeof value === "boolean") {
            charge(value ? 4 : 5);
            return value;
        }
        if (typeof value === "number") {
            if (!Number.isFinite(value)) invalid();
            charge(String(value).length);
            return value;
        }
        if (typeof value !== "object" || ancestors.has(value)) return invalid();

        const isArray = Array.isArray(value);
        const prototype = Object.getPrototypeOf(value) as unknown;
        if (!isArray && prototype !== Object.prototype && prototype !== null) invalid();
        charge(2); // Brackets/braces, before allocating the result.
        let keys: string[] | undefined;
        let length: number;
        if (isArray) {
            length = value.length;
            // Every element requires at least one encoded byte and a separator.
            if (length > 0 && length + length - 1 > remaining) invalid();
        } else {
            keys = [];
            // Incrementally enumerate data fields rather than building a large
            // Object.entries/descriptor array before checking resource limits.
            for (const key in value) {
                if (!Object.hasOwn(value, key)) continue;
                chargeString(key);
                charge(keys.length === 0 ? 1 : 2); // Colon and possible comma.
                keys.push(key);
            }
            length = keys.length;
        }
        const target = isArray ? [] : Object.create(null) as Record<string, unknown>;
        ancestors.add(value);
        stack.push({ source: value, target, keys, length, position: 0 });
        return target;
    }

    const result = copy(input);
    while (stack.length) {
        const frame = stack[stack.length - 1]!;
        if (frame.position === frame.length) {
            ancestors.delete(frame.source);
            stack.pop();
            continue;
        }
        const position = frame.position++;
        const key = frame.keys ? frame.keys[position]! : String(position);
        const descriptor = Object.getOwnPropertyDescriptor(frame.source, key);
        if (!descriptor || !Object.hasOwn(descriptor, "value")) invalid();
        if (!frame.keys && position > 0) charge(1);
        const child = copy(descriptor.value as unknown);
        // Define a data property even for "__proto__"; do not invoke setters.
        Object.defineProperty(frame.target, key, {
            value: child, enumerable: true, configurable: true, writable: true,
        });
    }
    return result;
}