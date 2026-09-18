/** Stable categories without reflecting potentially sensitive field contents. */
export type SyntaxReason =
    | "non-ascii"
    | "unexpected-character"
    | "unexpected-end"
    | "trailing-data"
    | "invalid-key"
    | "invalid-number"
    | "invalid-escape"
    | "invalid-base64"
    | "invalid-utf8"
    | "invalid-boolean";

/** A wire parsing failure invalidates the entire field (RFC 9651 §4.2). */
export class SfSyntaxError extends Error {
    readonly code = "SF_INVALID_SYNTAX" as const;

    constructor(
        readonly reason: SyntaxReason,
        readonly offset: number,
    ) {
        // Report position and category only: HTTP fields may contain credentials.
        super(`Invalid Structured Field at offset ${offset}: ${reason}`);
        this.name = "SfSyntaxError";
    }
}

export type SerializationReason =
    | "invalid-structure"
    | "invalid-key"
    | "duplicate-key"
    | "invalid-number"
    | "invalid-string"
    | "invalid-token"
    | "invalid-bytes"
    | "invalid-boolean"
    | "invalid-unicode";

/** Invalid caller-supplied semantic data, distinct from malformed wire input. */
export class SfSerializationError extends Error {
    readonly code = "SF_INVALID_VALUE" as const;

    constructor(readonly reason: SerializationReason) {
        super(`Cannot serialize Structured Field: ${reason}`);
        this.name = "SfSerializationError";
    }
}