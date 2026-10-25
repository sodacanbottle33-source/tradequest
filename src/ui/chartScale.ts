// Price-axis maths for the live chart, kept free of React so it can be unit-tested.
import type { LiveCandle } from '../engine';

/** A "nice" grid step (1, 2 or 5 × 10^k cents) near `target`. */
export function niceStep(target: number): number {
  const safe = Math.max(target, 1);
  let magnitude = 1;
  while (magnitude * 10 <= safe) magnitude *= 10;
  for (const m of [1, 2, 5, 10]) if (m * magnitude >= safe) return m * magnitude;
  return 10 * magnitude;
}

/** A "nice" grid step (1, 2 or 5 × a power of ten, which may be far below one cent) at least as big as `target`: for coins that cost a tiny fraction of a cent. */
export function niceStepFine(target: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(target));
  for (const m of [1, 2, 5, 10]) if (m * magnitude >= target * (1 - 1e-12)) return m * magnitude;
  return 10 * magnitude;
}

/** Price range for the visible candles, rounded outwards to grid lines so it only changes when it has to. */
export function priceDomain(candles: readonly Pick<LiveCandle, 'low' | 'high'>[]): { lo: number; hi: number; step: number } {
  let lo = Infinity;
  let hi = -Infinity;
  let fractional = false;
  for (const c of candles) {
    if (c.low < lo) lo = c.low;
    if (c.high > hi) hi = c.high;
    if (!Number.isInteger(c.low) || !Number.isInteger(c.high)) fractional = true;
  }
  if (!Number.isFinite(lo)) return { lo: 0, hi: 100, step: 20 };
  // A coin that costs a fraction of a cent has prices that are not whole cents (and are all below a dollar): the range is then worked out
  // from the price itself instead of from steps of cents, so a flat line of 0.0000000064 cents still gets a readable axis.
  if (fractional && hi < 100) {
    const span = Math.max(hi - lo, hi * 0.02);
    const pad = span * 0.12;
    const step = niceStepFine((span + 2 * pad) / 5);
    return { lo: Math.max(0, Math.floor((lo - pad) / step) * step), hi: Math.ceil((hi + pad) / step) * step, step };
  }
  const span = Math.max(hi - lo, 20);
  const pad = span * 0.12;
  const step = niceStep((span + 2 * pad) / 5);
  return { lo: Math.floor((lo - pad) / step) * step, hi: Math.ceil((hi + pad) / step) * step, step };
}

/** The grid prices of a domain, lowest first (counted, not added up, so tiny steps do not drift). */
export function gridPricesOf(lo: number, hi: number, step: number): number[] {
  const out: number[] = [];
  const count = Math.min(60, Math.round((hi - lo) / step));
  for (let i = 0; i <= count; i += 1) out.push(lo + i * step);
  return out;
}
