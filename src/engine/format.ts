// Display formatting — see docs/rules.md §3.4–3.6.
// Display values are never fed back into calculations.

import { roundHalfUpRatio } from './money';

const MINUS = '−'; // "−", a real minus sign

function groupThousands(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 253336 → "$2,533.36"; −1467 → "−$14.67". */
export function formatCents(cents: number): string {
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
  const hundredths = roundHalfUpRatio(Math.abs(part) * 10_000, whole);
  const text = `${Math.floor(hundredths / 100)}.${String(hundredths % 100).padStart(2, '0')}%`;
  return part < 0 && hundredths > 0 ? `${MINUS}${text}` : text;
}

/** Like formatPercent but shows "+" for positive values. */
export function formatSignedPercent(part: number, whole: number): string {
  const text = formatPercent(part, whole);
  return part > 0 && text !== '0.00%' ? `+${text}` : text;
}
