import { SfSerializationError } from "./errors.js";
import { Budget } from "./limits.js";
import type { BareItem, ProcessingOptions } from "./types.js";

export type Decimal = Extract<BareItem, { readonly kind: "decimal" }>;

/**
 * Construct an SF decimal from exact base-10 text, not a JavaScript float.
 * Accepts an optional minus, digits, and an optional fractional component.
 * Exponents, plus signs, and whitespace are deliberately not accepted.
 *
 * This is a semantic input constructor, NOT the wire decimal parser:
 * RFC 9651 §4.2.4 rejects wire fractions longer than three digits, whereas
 * §4.1.5 permits broader serializer inputs and rounds ties to even.
 */
export function decimalFromString(
    input: string,
    options: ProcessingOptions = {},
): Decimal {
    if (typeof input !== "string") {
        throw new SfSerializationError("invalid-number");
    }
    const budget = new Budget(options.limits);
    // Valid decimal text is ASCII. Check length before scanning or allocating;
    // non-ASCII input is rejected below without allocating a UTF-8 copy.
    budget.check("maxInputBytes", input.length);

    const negative = input.startsWith("-");
    const start = negative ? 1 : 0;
    let position = start;
    let firstSignificant = -1;
    while (position < input.length) {
        const code = input.charCodeAt(position);
        if (code < 48 || code > 57) break;
        if (code !== 48 && firstSignificant === -1) firstSignificant = position;
        position++;
    }
    if (position === start) {
        throw new SfSerializationError("invalid-number");
    }
    const integerEnd = position;
    let fractionStart = input.length;
    if (position < input.length) {
        if (input.charCodeAt(position) !== 46) {
            throw new SfSerializationError("invalid-number");
        }
        position++;
        fractionStart = position;
        if (position === input.length) {
            throw new SfSerializationError("invalid-number");
        }
        for (; position < input.length; position++) {
            const code = input.charCodeAt(position);
            if (code < 48 || code > 57) {
                throw new SfSerializationError("invalid-number");
            }
        }
    }

    // Ignore insignificant leading zeroes, but never construct an unbounded
    // BigInt from hostile input. At most twelve integer digits are converted.
    const significantDigits =
        firstSignificant === -1 ? 0 : integerEnd - firstSignificant;
    if (significantDigits > 12) {
        throw new SfSerializationError("invalid-number");
    }
    const integer =
        firstSignificant === -1
            ? 0n
            : BigInt(input.slice(firstSignificant, integerEnd));

    const fractionalDigits = input.length - fractionStart;
    let fraction = 0;
    for (let digit = 0; digit < 3; digit++) {
        fraction *= 10;
        if (digit < fractionalDigits) {
            fraction += input.charCodeAt(fractionStart + digit) - 48;
        }
    }
    let magnitude = integer * 1000n + BigInt(fraction);

    if (fractionalDigits > 3) {
        const fourth = input.charCodeAt(fractionStart + 3) - 48;
        let nonzeroTail = false;
        if (fourth === 5) {
            for (let index = fractionStart + 4; index < input.length; index++) {
                if (input.charCodeAt(index) !== 48) {
                    nonzeroTail = true;
                    break;
                }
            }
        }
        // Work on absolute magnitude, making negative and positive ties symmetric.
        if (
            fourth > 5 ||
            (fourth === 5 && (nonzeroTail || magnitude % 2n !== 0n))
        ) {
            magnitude++;
        }
    }

    // RFC 9651 §4.1.5 checks the integer range AFTER rounding.
    if (magnitude > 999_999_999_999_999n) {
        throw new SfSerializationError("invalid-number");
    }

    // This range is below Number.MAX_SAFE_INTEGER; conversion is exact.
    // Negative zero has no separate semantic value, but raw AST preserves it.
    const thousandths = Number(magnitude);
    return {
        kind: "decimal",
        thousandths: negative && thousandths !== 0 ? -thousandths : thousandths,
    };
}