import type { Limits } from "./limits.js";

/** Explicit tags prevent string/token and integer/decimal confusion. */
export type BareItem =
    | { readonly kind: "integer"; readonly value: number }
    | { readonly kind: "decimal"; readonly thousandths: number }
    | { readonly kind: "string"; readonly value: string }
    | { readonly kind: "token"; readonly value: string }
    | { readonly kind: "bytes"; readonly value: Uint8Array }
    | { readonly kind: "boolean"; readonly value: boolean }
    | { readonly kind: "date"; readonly epochSeconds: number }
    | { readonly kind: "display-string"; readonly value: string };

export type FieldType = "item" | "list" | "dictionary";

/**
 * Semantic parameters have unique keys in first-occurrence order.
 * RFC 9651 §4.2.3.2 replaces a duplicate's value without moving its position.
 * Ordered tuples expose index access; getParameter supplies key access.
 */
export type Parameter = readonly [key: string, value: BareItem];
export type Parameters = readonly Parameter[];

export interface Item {
    readonly kind: "item";
    readonly bare: BareItem;
    readonly parameters: Parameters;
}

export interface InnerList {
    readonly kind: "inner-list";
    readonly items: readonly Item[];
    readonly parameters: Parameters;
}

export type Member = Item | InnerList;

export interface List {
    readonly kind: "list";
    readonly members: readonly Member[];
}

export type DictionaryEntry = readonly [key: string, member: Member];

export interface Dictionary {
    readonly kind: "dictionary";
    readonly entries: readonly DictionaryEntry[];
}

export type Field = Item | List | Dictionary;

export interface FieldByType {
    readonly item: Item;
    readonly list: List;
    readonly dictionary: Dictionary;
}

/**
 * Half-open offsets into RawDocument.source, after field-line combination.
 * Accepted wire input is ASCII, so character offsets equal byte offsets.
 */
export interface Span {
    readonly start: number;
    readonly end: number;
}

export interface RawBareItem extends Span {
    readonly value: BareItem;
}

export interface RawParameter extends Span {
    readonly key: string;
    readonly keySpan: Span;
    /** Undefined means implicit Boolean true, not an absent parameter. */
    readonly bare?: RawBareItem;
}

export interface RawItem extends Span {
    readonly kind: "item";
    /** Only a Dictionary's implicit Boolean true may omit the bare item. */
    readonly bare?: RawBareItem;
    readonly parameters: readonly RawParameter[];
}

export interface RawInnerList extends Span {
    readonly kind: "inner-list";
    readonly items: readonly RawItem[];
    readonly parameters: readonly RawParameter[];
}

export type RawMember = RawItem | RawInnerList;

export interface RawList extends Span {
    readonly kind: "list";
    readonly members: readonly RawMember[];
}

export interface RawDictionaryEntry extends Span {
    readonly key: string;
    readonly keySpan: Span;
    readonly implicit: boolean;
    readonly member: RawMember;
}

export interface RawDictionary extends Span {
    readonly kind: "dictionary";
    /** All occurrences survive, including duplicate keys. */
    readonly entries: readonly RawDictionaryEntry[];
}

export type RawField = RawItem | RawList | RawDictionary;

export interface RawFieldByType {
    readonly item: RawItem;
    readonly list: RawList;
    readonly dictionary: RawDictionary;
}

export interface RawDocument<T extends FieldType = FieldType> {
    readonly fieldType: T;
    /** Original combined ASCII text, including whitespace and numeric spelling. */
    readonly source: string;
    readonly root: RawFieldByType[T];
}

export interface ProcessingOptions {
    readonly limits?: Partial<Limits>;
}

/** Lookup is case-sensitive; SF keys are already constrained to lowercase. */
export function getParameter(parameters: Parameters, key: string): BareItem | undefined {
    return parameters.find(([name]) => name === key)?.[1];
}

/** Lookup does not reorder or mutate the semantic Dictionary. */
export function getMember(dictionary: Dictionary, key: string): Member | undefined {
    return dictionary.entries.find(([name]) => name === key)?.[1];
}