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

/** Price range for the visible candles, rounded outwards to grid lines so it only changes when it has to. */
export function priceDomain(candles: readonly Pick<LiveCandle, 'low' | 'high'>[]): { lo: number; hi: number; step: number } {
  let lo = Infinity;
  let hi = -Infinity;
  for (const c of candles) {
    if (c.low < lo) lo = c.low;
    if (c.high > hi) hi = c.high;
  }
  if (!Number.isFinite(lo)) return { lo: 0, hi: 100, step: 20 };
  const span = Math.max(hi - lo, 20);
  const pad = span * 0.12;
  const step = niceStep((span + 2 * pad) / 5);
  return { lo: Math.floor((lo - pad) / step) * step, hi: Math.ceil((hi + pad) / step) * step, step };
}
