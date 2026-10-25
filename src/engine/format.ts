// Display formatting — see docs/rules.md §3.4–3.6.
// Display values are never fed back into calculations.

import { roundHalfUpRatio } from './money';

const MINUS = '−'; // "−", a real minus sign

function groupThousands(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

const SUBSCRIPT = '₀₁₂₃₄₅₆₇₈₉';

/** The power of ten a positive number starts with (0.00064 → -4, 1500 → 3), read from its exponent form so it is exact (no logarithm). */
function decimalExponent(x: number): number {
  return Number(x.toExponential().split('e')[1]);
}

/**
 * A price of a coin that costs a tiny fraction of a cent, from cents: 0.0000000064 → "$0.000000000064" (four significant digits at most,
 * no trailing zeros, at least two decimals). From a dollar up it is dollars and whole cents.
 */
export function formatFineCents(cents: number): string {
  if (!Number.isFinite(cents) || cents === 0) return '$0.00';
  const dollars = Math.abs(cents) / 100;
  if (dollars >= 1) return formatCents(Math.round(cents));
  const exponent = decimalExponent(dollars);
  let text = dollars.toFixed(Math.min(20, Math.max(2, 3 - exponent)));
  if (text.includes('.')) text = text.replace(/0+$/, '');
  const dot = text.indexOf('.');
  if (dot >= 0 && text.length - dot - 1 < 2) text = text.padEnd(dot + 3, '0');
  return `${cents < 0 ? MINUS : ''}$${text}`;
}

/**
 * A short price for the axis of a chart (dollars, no sign): 0.0000000064 cents → "0.0₁₀64" (nought point nought, ten more noughts, then 64).
 * Prices from a tenth of a cent up are written out. Display only.
 */
export function formatAxisPrice(cents: number): string {
  const dollars = Math.abs(cents) / 100;
  if (!Number.isFinite(dollars) || dollars === 0) return '0.00';
  if (dollars >= 0.001) return dollars >= 0.1 ? dollars.toFixed(dollars >= 1 ? 2 : 3).replace(/(\.\d\d)0$/, '$1') : dollars.toPrecision(3).replace(/0+$/, '');
  let exponent = decimalExponent(dollars);
  let digits = Math.round((dollars / 10 ** exponent) * 100);
  if (digits >= 1000) {
    digits = 100;
    exponent += 1;
  }
  const zeros = -exponent - 1;
  const subscript = String(zeros).replace(/\d/g, (d) => SUBSCRIPT[Number(d)] as string);
  return `0.0${subscript}${String(digits).replace(/0+$/, '')}`;
}

/** 253336 → "$2,533.36"; −1467 → "−$14.67". A price that is not a whole number of cents (a coin that costs a fraction of a cent) is written in full. */
export function formatCents(cents: number): string {
  if (!Number.isInteger(cents)) return formatFineCents(cents);
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const rest = abs % 100;
  const text = `$${groupThousands(dollars)}.${String(rest).padStart(2, '0')}`;
  return cents < 0 ? `${MINUS}${text}` : text;
}

/** Like formatCents but shows "+" for positive values (used for P&L). */
export function formatSignedCents(cents: number): string {
  return cents > 0 ? `+${formatCents(cents)}` : formatCents(cents);
}

/**
 * Percentage `part / whole × 100`, shown with 2 decimals.
 * The magnitude is rounded half-up, then the sign is applied (§3.4);
 * a value that rounds to zero has no sign.
 */
export function formatPercent(part: number, whole: number): string {
  // Prices that are fractions of a cent (a coin that costs a tiny amount) are not whole numbers: the same rule, on plain numbers.
  if (!Number.isSafeInteger(part) || !Number.isSafeInteger(whole)) {
    const h = whole > 0 ? Math.floor((Math.abs(part) * 10_000) / whole + 0.5) : 0;
    const t = `${Math.floor(h / 100)}.${String(h % 100).padStart(2, '0')}%`;
    return part < 0 && h > 0 ? `${MINUS}${t}` : t;
  }
  const hundredths = roundHalfUpRatio(Math.abs(part) * 10_000, whole);
  const text = `${Math.floor(hundredths / 100)}.${String(hundredths % 100).padStart(2, '0')}%`;
  return part < 0 && hundredths > 0 ? `${MINUS}${text}` : text;
}

/** Like formatPercent but shows "+" for positive values. */
export function formatSignedPercent(part: number, whole: number): string {
  const text = formatPercent(part, whole);
  return part > 0 && text !== '0.00%' ? `+${text}` : text;
}
