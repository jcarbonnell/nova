declare const MAX_NOMINATION_EXP = 24;
/**
 * Convert internal indivisible units to formatted human-readable amount
 */
declare function formatAmount(units: string | number | bigint, fracDigits: number, precision?: number): string;
/**
 * Convert human readable amount to internal indivisible units.
 */
declare function parseAmount(amount: string, fracDigits: number): string;

export { MAX_NOMINATION_EXP, formatAmount, parseAmount };
