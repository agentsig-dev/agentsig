import { Buffer } from "node:buffer";
import { SfSerializationError } from "./errors.js";
import type { SerializationReason } from "./errors.js";
import { Budget } from "./limits.js";
import type { Field, Member, ProcessingOptions } from "./types.js";

function fail(reason: SerializationReason): never {
    throw new SfSerializationError(reason);
}

function record(value: unknown): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return fail("invalid-structure");
    }
    return value as Record<string, unknown>;
}

function array(value: unknown): readonly unknown[] {
    if (!Array.isArray(value)) return fail("invalid-structure");
    return value;
}

function pair(value: unknown): readonly [unknown, unknown] {
    const entry = array(value);
    if (entry.length !== 2) return fail("invalid-structure");
    return entry as readonly [unknown, unknown];
}

/**
 * RFC 9651 §4.1 canonical serialization.
 * An empty List/Dictionary returns ""; the HTTP adapter must omit the field.
 * This API accepts the semantic model, not a raw AST containing duplicates.
 */
export function serialize(
    field: Field,
    options: ProcessingOptions = {},
): string {
    const writer = new Writer(options);
    writer.field(field);
    return writer.finish();
}

/** Serialize a parameterized Item or Inner List (e.g. signature parameters). */
export function serializeMember(
    member: Member,
    options: ProcessingOptions = {},
): string {
    const writer = new Writer(options);
    writer.member(member);
    return writer.finish();
}

class Writer {
    private readonly budget: Budget;
    private readonly chunks: string[] = [];
    private length = 0;

    constructor(options: ProcessingOptions) {
        this.budget = new Budget(options.limits);
    }

    private reserve(length: number): void {
        this.budget.check("maxOutputBytes", this.length + length);
    }

    private append(value: string): void {
        this.reserve(value.length);
        this.length += value.length;
        this.chunks.push(value);
    }

    finish(): string {
        // Every ASCII byte was accounted for before appending; final join is bounded.
        return this.chunks.join("");
    }

    field(input: unknown): void {
        const field = record(input);
        if (field.kind === "item") {
            this.member(field);
        } else if (field.kind === "list") {
            const members = array(field.members);
            this.budget.check("maxMembers", members.length);
            for (let index = 0; index < members.length; index++) {
                if (index) this.append(", ");
                this.member(members[index]);
            }
        } else if (field.kind === "dictionary") {
            const entries = array(field.entries);
            this.budget.check("maxMembers", entries.length);
            const keys = new Set<string>();
            for (let index = 0; index < entries.length; index++) {
                const [key, value] = pair(entries[index]);
                if (index) this.append(", ");
                this.key(key, keys);
                const member = record(value);
                if (member.kind === "item") {
                    const bare = record(member.bare);
                    if (bare.kind === "boolean" && bare.value === true) {
                        this.budget.consumeOccurrence();
                        this.parameters(member.parameters);
                        continue;
                    }
                }
                this.append("=");
                this.member(member);
            }
        } else {
            fail("invalid-structure");
        }
    }

    member(input: unknown): void {
        this.budget.consumeOccurrence();
        const member = record(input);
        if (member.kind === "item") {
            this.bare(member.bare);
            this.parameters(member.parameters);
        } else if (member.kind === "inner-list") {
            const items = array(member.items);
            this.budget.check("maxInnerListItems", items.length);
            this.append("(");
            for (let index = 0; index < items.length; index++) {
                if (record(items[index]).kind !== "item") fail("invalid-structure");
                if (index) this.append(" ");
                this.member(items[index]);
            }
            this.append(")");
            this.parameters(member.parameters);
        } else {
            fail("invalid-structure");
        }
    }

    private key(input: unknown, seen: Set<string>): void {
        if (typeof input !== "string") fail("invalid-key");
        this.budget.check("maxKeyLength", input.length);
        if (!/^[a-z*][a-z0-9_.*-]*$/.test(input)) fail("invalid-key");
        // Duplicate keys are not valid semantic maps. Resolve them by parsing raw
        // input, rather than guessing which caller-supplied value was intended.
        if (seen.has(input)) fail("duplicate-key");
        this.reserve(input.length);
        seen.add(input);
        this.append(input);
    }

    private parameters(input: unknown): void {
        const parameters = array(input);
        this.budget.check("maxParameters", parameters.length);
        const keys = new Set<string>();
        for (const parameter of parameters) {
            this.budget.consumeOccurrence();
            const [key, value] = pair(parameter);
            this.append(";");
            this.key(key, keys);
            const bare = record(value);
            if (bare.kind === "boolean" && bare.value === true) continue;
            this.append("=");
            this.bare(bare);
        }
    }

    private integer(value: unknown): number {
        if (
            typeof value !== "number" ||
            !Number.isSafeInteger(value) ||
            Math.abs(value) > 999_999_999_999_999
        ) {
            return fail("invalid-number");
        }
        return value;
    }

    private bare(input: unknown): void {
        const bare = record(input);
        switch (bare.kind) {
            case "integer":
                this.append(String(this.integer(bare.value)));
                break;
            case "date":
                this.append("@" + String(this.integer(bare.epochSeconds)));
                break;
            case "decimal": {
                const value = this.integer(bare.thousandths);
                const magnitude = Math.abs(value);
                const whole = Math.floor(magnitude / 1000);
                const fraction = String(magnitude % 1000).padStart(3, "0").replace(/0+$/, "") || "0";
                this.append(`${value < 0 ? "-" : ""}${whole}.${fraction}`);
                break;
            }
            case "boolean":
                if (typeof bare.value !== "boolean") fail("invalid-boolean");
                this.append(bare.value ? "?1" : "?0");
                break;
            case "token":
                if (typeof bare.value !== "string") fail("invalid-token");
                this.budget.check("maxTokenLength", bare.value.length);
                if (!/^[A-Za-z*][A-Za-z0-9!#$%&'*+.^_`|~:/-]*$/.test(bare.value)) {
                    fail("invalid-token");
                }
                this.append(bare.value);
                break;
            case "string":
                this.string(bare.value);
                break;
            case "display-string":
                this.displayString(bare.value);
                break;
            case "bytes": {
                if (!(bare.value instanceof Uint8Array)) fail("invalid-bytes");
                const size = bare.value.byteLength;
                this.budget.check("maxDecodedBytes", size);
                // Reserve before allocating either the Buffer view or encoded string.
                this.reserve(2 + 4 * Math.ceil(size / 3));
                const bytes = Buffer.from(bare.value.buffer, bare.value.byteOffset, size);
                this.append(":" + bytes.toString("base64") + ":");
                break;
            }
            default:
                fail("invalid-structure");
        }
    }

    private string(input: unknown): void {
        if (typeof input !== "string") fail("invalid-string");
        this.budget.check("maxDecodedBytes", input.length);
        let encodedSize = 2;
        this.reserve(encodedSize + input.length);
        for (let index = 0; index < input.length; index++) {
            const code = input.charCodeAt(index);
            if (code < 32 || code > 126) fail("invalid-string");
            encodedSize += code === 34 || code === 92 ? 2 : 1;
            this.reserve(encodedSize);
        }
        // Validate and measure fully before constructing the escaped string.
        this.append('"' + input.replace(/["\\]/g, "\\$&") + '"');
    }

    private displayString(input: unknown): void {
        if (typeof input !== "string") fail("invalid-unicode");
        // UTF-8 byte length is never less than UTF-16 code-unit length for valid
        // scalar sequences. This cheap lower bound stops giant input early.
        this.budget.check("maxDecodedBytes", input.length);
        this.reserve(3 + input.length);
        let decodedSize = 0;
        let encodedSize = 3;
        for (let index = 0; index < input.length; index++) {
            const code = input.charCodeAt(index);
            let byteCount: number;
            if (code >= 0xd800 && code <= 0xdbff) {
                const low = input.charCodeAt(index + 1);
                if (!(low >= 0xdc00 && low <= 0xdfff)) fail("invalid-unicode");
                index++;
                byteCount = 4;
            } else if (code >= 0xdc00 && code <= 0xdfff) {
                fail("invalid-unicode");
            } else {
                byteCount = code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
            }
            decodedSize += byteCount;
            encodedSize += code >= 32 && code <= 126 && code !== 34 && code !== 37
                ? 1
                : byteCount * 3;
            this.budget.check("maxDecodedBytes", decodedSize);
            this.reserve(encodedSize);
        }
        // UTF-8 encoding cannot silently replace lone surrogates: checked above.
        const bytes = Buffer.from(input, "utf8");
        let output = '%"';
        for (const byte of bytes) {
            output += byte < 32 || byte > 126 || byte === 34 || byte === 37
                ? "%" + byte.toString(16).padStart(2, "0")
                : String.fromCharCode(byte);
        }
        this.append(output + '"');
    }
}