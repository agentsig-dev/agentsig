import { Buffer } from "node:buffer";
import { TextDecoder } from "node:util";
import { SfSyntaxError } from "./errors.js";
import type { SyntaxReason } from "./errors.js";
import { Budget } from "./limits.js";
import type {
    BareItem, FieldType, ProcessingOptions, RawBareItem, RawDictionary,
    RawDictionaryEntry, RawDocument, RawField, RawFieldByType, RawInnerList,
    RawItem, RawList, RawMember, RawParameter, Span,
} from "./types.js";

const digit = (code: number): boolean => code >= 48 && code <= 57;
const alpha = (code: number): boolean =>
    (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
const keyFirst = (code: number): boolean =>
    (code >= 97 && code <= 122) || code === 42;
const keyRest = (code: number): boolean =>
    keyFirst(code) || digit(code) || code === 95 || code === 45 || code === 46;
const tokenRest = (code: number): boolean =>
    alpha(code) || digit(code) || "!#$%&'*+-.^_`|~:/".includes(String.fromCharCode(code));
const hex = (code: number): boolean =>
    digit(code) || (code >= 97 && code <= 102);

/**
 * Parse one combined field value (RFC 9651 §4.2).
 * HTTP adapters must combine all matching field lines, in order, with ", ".
 * A single byte array avoids silently masking non-ASCII bytes with ASCII decoding.
 */
export function parseRaw<T extends FieldType>(
    input: string | Uint8Array,
    fieldType: T,
    options: ProcessingOptions = {},
): RawDocument<T> {
    const budget = new Budget(options.limits);
    if (typeof input !== "string" && !(input instanceof Uint8Array)) {
        throw new TypeError("Expected a string or Uint8Array field value");
    }
    budget.check("maxInputBytes", input.length);
    for (let index = 0; index < input.length; index++) {
        const code = typeof input === "string" ? input.charCodeAt(index) : input[index]!;
        if (code > 127) throw new SfSyntaxError("non-ascii", index);
    }
    const source = typeof input === "string" ? input : Buffer.from(input).toString("latin1");
    const parser = new Parser(source, budget);
    const root = parser.field(fieldType);
    return { fieldType, source, root: root as RawFieldByType[T] };
}

class Parser {
    private position = 0;

    constructor(
        private readonly source: string,
        private readonly budget: Budget,
    ) { }

    private code(): number {
        return this.source.charCodeAt(this.position);
    }

    private fail(reason: SyntaxReason, offset = this.position): never {
        throw new SfSyntaxError(reason, offset);
    }

    private spaces(allowTab = false): void {
        while (this.code() === 32 || (allowTab && this.code() === 9)) this.position++;
    }

    field(type: FieldType): RawField {
        this.spaces();
        let root: RawField;
        if (type === "dictionary") root = this.dictionary();
        else if (type === "list") root = this.list();
        else if (type === "item") root = this.item();
        else throw new TypeError("Unknown Structured Field type");
        this.spaces();
        if (this.position !== this.source.length) this.fail("trailing-data");
        return root;
    }

    private separator(): boolean {
        this.spaces(true);
        if (this.position === this.source.length) return false;
        if (this.code() !== 44) this.fail("unexpected-character");
        this.position++;
        this.spaces(true);
        if (this.position === this.source.length) this.fail("unexpected-end");
        return true;
    }

    private list(): RawList {
        const start = this.position;
        const members: RawMember[] = [];
        while (this.position < this.source.length) {
            this.budget.check("maxMembers", members.length + 1);
            members.push(this.member());
            if (!this.separator()) break;
        }
        return { kind: "list", start, end: this.position, members };
    }

    private dictionary(): RawDictionary {
        const start = this.position;
        const entries: RawDictionaryEntry[] = [];
        while (this.position < this.source.length) {
            // Count raw occurrences, not unique keys, before parsing the next member.
            this.budget.check("maxMembers", entries.length + 1);
            const entryStart = this.position;
            const { key, span: keySpan } = this.key();
            let member: RawMember;
            const implicit = this.code() !== 61;
            if (!implicit) {
                this.position++;
                member = this.member();
            } else {
                this.budget.consumeOccurrence();
                const memberStart = this.position;
                const parameters = this.parameters();
                member = {
                    kind: "item", start: memberStart, end: this.position, parameters,
                };
            }
            entries.push({
                key, keySpan, implicit, member, start: entryStart, end: this.position,
            });
            if (!this.separator()) break;
        }
        return { kind: "dictionary", start, end: this.position, entries };
    }

    private member(): RawMember {
        return this.code() === 40 ? this.innerList() : this.item();
    }

    private innerList(): RawInnerList {
        this.budget.consumeOccurrence();
        const start = this.position++;
        const items: RawItem[] = [];
        while (this.position < this.source.length) {
            this.spaces();
            if (this.code() === 41) {
                this.position++;
                const parameters = this.parameters();
                return { kind: "inner-list", start, end: this.position, items, parameters };
            }
            this.budget.check("maxInnerListItems", items.length + 1);
            items.push(this.item());
            if (this.code() !== 32 && this.code() !== 41) this.fail("unexpected-character");
        }
        return this.fail("unexpected-end");
    }

    private item(): RawItem {
        this.budget.consumeOccurrence();
        const start = this.position;
        const bare = this.bare();
        const parameters = this.parameters();
        return { kind: "item", start, end: this.position, bare, parameters };
    }

    private parameters(): RawParameter[] {
        const parameters: RawParameter[] = [];
        while (this.code() === 59) {
            this.budget.check("maxParameters", parameters.length + 1);
            this.budget.consumeOccurrence();
            const start = this.position++;
            this.spaces();
            const { key, span: keySpan } = this.key();
            if (this.code() === 61) {
                this.position++;
                const bare = this.bare();
                parameters.push({ key, keySpan, bare, start, end: this.position });
            } else {
                parameters.push({ key, keySpan, start, end: this.position });
            }
        }
        return parameters;
    }

    private key(): { key: string; span: Span } {
        const start = this.position;
        if (!keyFirst(this.code())) this.fail("invalid-key");
        while (keyRest(this.code())) {
            this.budget.check("maxKeyLength", this.position - start + 1);
            this.position++;
        }
        return {
            key: this.source.slice(start, this.position),
            span: { start, end: this.position },
        };
    }

    private bare(): RawBareItem {
        const start = this.position;
        const code = this.code();
        let value: BareItem;
        if (digit(code) || code === 45) value = this.number();
        else if (code === 34) value = { kind: "string", value: this.string() };
        else if (alpha(code) || code === 42) value = { kind: "token", value: this.token() };
        else if (code === 58) value = { kind: "bytes", value: this.bytes() };
        else if (code === 63) {
            this.position++;
            if (this.code() !== 48 && this.code() !== 49) this.fail("invalid-boolean");
            value = { kind: "boolean", value: this.code() === 49 };
            this.position++;
        } else if (code === 64) {
            this.position++;
            const numeric = this.number();
            if (numeric.kind !== "integer") this.fail("invalid-number", start);
            value = { kind: "date", epochSeconds: numeric.value };
        } else if (code === 37) {
            value = { kind: "display-string", value: this.displayString() };
        } else {
            return this.fail(this.position === this.source.length ? "unexpected-end" : "unexpected-character");
        }
        return { start, end: this.position, value };
    }

    private number(): Extract<BareItem, { kind: "integer" | "decimal" }> {
        const start = this.position;
        const negative = this.code() === 45;
        if (negative) this.position++;
        const integerStart = this.position;
        if (!digit(this.code())) this.fail("invalid-number");
        let integer = 0;
        while (digit(this.code())) {
            if (this.position - integerStart >= 15) this.fail("invalid-number");
            integer = integer * 10 + this.code() - 48;
            this.position++;
        }
        const signed = (value: number): number => negative && value !== 0 ? -value : value;
        if (this.code() !== 46) return { kind: "integer", value: signed(integer) };
        if (this.position - integerStart > 12) this.fail("invalid-number", start);
        this.position++;
        const fractionStart = this.position;
        let fraction = 0;
        while (digit(this.code())) {
            if (this.position - fractionStart >= 3) this.fail("invalid-number");
            fraction = fraction * 10 + this.code() - 48;
            this.position++;
        }
        const digits = this.position - fractionStart;
        if (digits === 0) this.fail("invalid-number");
        // Integer arithmetic is exact in the allowed range; never parseFloat wire data.
        const thousandths = integer * 1000 + fraction * 10 ** (3 - digits);
        return { kind: "decimal", thousandths: signed(thousandths) };
    }

    private token(): string {
        const start = this.position;
        while (this.position < this.source.length && tokenRest(this.code())) {
            this.budget.check("maxTokenLength", this.position - start + 1);
            this.position++;
        }
        return this.source.slice(start, this.position);
    }

    private string(): string {
        this.position++;
        let output = "";
        while (this.position < this.source.length) {
            let code = this.code();
            this.position++;
            if (code === 34) return output;
            if (code === 92) {
                code = this.code();
                if (code !== 34 && code !== 92) this.fail("invalid-escape");
                this.position++;
            } else if (code < 32 || code > 126) {
                this.fail("unexpected-character", this.position - 1);
            }
            this.budget.check("maxDecodedBytes", output.length + 1);
            output += String.fromCharCode(code);
        }
        return this.fail("unexpected-end");
    }

    private bytes(): Uint8Array {
        this.position++;
        const start = this.position;
        let contentLength = 0;
        let padding = 0;
        while (this.position < this.source.length && this.code() !== 58) {
            const code = this.code();
            if (code === 61) {
                padding++;
                if (padding > 2) this.fail("invalid-base64");
            } else {
                if (padding || !(alpha(code) || digit(code) || code === 43 || code === 47)) {
                    this.fail("invalid-base64");
                }
                contentLength++;
                this.budget.check("maxDecodedBytes", Math.floor(contentLength * 6 / 8));
            }
            this.position++;
        }
        if (this.code() !== 58) this.fail("unexpected-end");
        const remainder = contentLength % 4;
        const expectedPadding = (4 - remainder) % 4;
        if (remainder === 1 || padding > expectedPadding) this.fail("invalid-base64", start);
        const text = this.source.slice(start, this.position);
        this.position++;
        // §4.2.7: accept missing padding and nonzero pad bits. Reject nonalphabet
        // input ourselves because Node's base64 decoder otherwise ignores garbage.
        // The decoded size was checked above before either allocation. Return an
        // owned, plain Uint8Array so the public model does not expose Buffer's
        // prototype, JSON behavior, or a shared Node allocation pool.
        return Uint8Array.from(Buffer.from(text, "base64"));
    }

    private displayString(): string {
        this.position++;
        if (this.code() !== 34) this.fail("unexpected-character");
        this.position++;
        const bytes: number[] = [];
        while (this.position < this.source.length) {
            let code = this.code();
            this.position++;
            if (code === 34) {
                // fatal rejects invalid UTF-8; ignoreBOM preserves a leading U+FEFF.
                try {
                    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
                        .decode(Uint8Array.from(bytes));
                } catch {
                    return this.fail("invalid-utf8");
                }
            }
            if (code < 32 || code > 126) this.fail("unexpected-character", this.position - 1);
            if (code === 37) {
                const first = this.code();
                const second = this.source.charCodeAt(this.position + 1);
                if (!hex(first) || !hex(second)) this.fail("invalid-escape");
                const nibble = (value: number): number => value <= 57 ? value - 48 : value - 87;
                code = nibble(first) * 16 + nibble(second);
                this.position += 2;
            }
            this.budget.check("maxDecodedBytes", bytes.length + 1);
            bytes.push(code);
        }
        return this.fail("unexpected-end");
    }
}