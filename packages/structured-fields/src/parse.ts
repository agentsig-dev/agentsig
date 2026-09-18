import { parseRaw } from "./parser.js";
import type {
    BareItem,
    DictionaryEntry,
    Field,
    FieldByType,
    FieldType,
    Item,
    Member,
    Parameters,
    ProcessingOptions,
    RawField,
    RawItem,
    RawMember,
    RawParameter,
} from "./types.js";

function parameters(raw: readonly RawParameter[]): Parameters {
    // RFC 9651 §4.2.3.2: replacing a value must not move its original position.
    // Map also avoids prototype-key hazards from attacker-controlled keys.
    const values = new Map<string, BareItem>();
    for (const parameter of raw) {
        values.set(parameter.key, parameter.bare?.value ?? { kind: "boolean", value: true });
    }
    return Array.from(values);
}

function item(raw: RawItem): Item {
    return {
        kind: "item",
        bare: raw.bare?.value ?? { kind: "boolean", value: true },
        parameters: parameters(raw.parameters),
    };
}

function member(raw: RawMember): Member {
    if (raw.kind === "item") return item(raw);
    return {
        kind: "inner-list",
        items: raw.items.map(item),
        parameters: parameters(raw.parameters),
    };
}

/**
 * Internal only: input must have passed parseRaw's allocation and occurrence
 * budgets. Semantic conversion cannot increase member/parameter cardinality.
 * Do not expose this as an unchecked entry point for caller-constructed ASTs.
 */
function semantic(raw: RawField): Field {
    switch (raw.kind) {
        case "item":
            return item(raw);
        case "list":
            return { kind: "list", members: raw.members.map(member) };
        case "dictionary": {
            // Resolve duplicate raw entries BEFORE converting their members, avoiding
            // needless semantic allocations for values that are superseded.
            const last = new Map<string, RawMember>();
            for (const entry of raw.entries) last.set(entry.key, entry.member);
            const entries: DictionaryEntry[] = [];
            for (const [key, value] of last) entries.push([key, member(value)]);
            return { kind: "dictionary", entries };
        }
    }
}

/**
 * Parse a combined field value into the RFC 9651 semantic model.
 * Use parseRaw instead when duplicate occurrences or original spelling matter.
 * Wire syntax/limit errors propagate unchanged; no partially parsed value is
 * returned after failure. Arrays preserve index order; lookup helpers expose
 * key access without relying on JavaScript object property ordering.
 */
export function parse<T extends FieldType>(
    input: string | Uint8Array,
    fieldType: T,
    options: ProcessingOptions = {},
): FieldByType[T] {
    const raw = parseRaw(input, fieldType, options);
    return semantic(raw.root) as FieldByType[T];
}