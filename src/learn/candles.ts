// Small candle helpers shared by the tutorial demos and the lesson generator. Only +, -, *, / and the basic Math functions are used,
// so the same input gives the same candles on every computer.

import type { LCandle } from './types';

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(Math.max(x, lo), hi);
}

/** Rounds to `decimals` decimal places (0 to 8) without Math.pow: the factor comes from a table. */
const FACTORS = [1, 10, 100, 1000, 10000, 100000, 1000000, 10000000, 100000000];
export function roundTo(x: number, decimals: number): number {
  const f = FACTORS[clamp(Math.floor(decimals), 0, 8)] as number;
  return Math.round(x * f) / f;
}

/**
 * Candles from a list of closing prices: every candle opens where the one before closed (the first one opens at `first`), and its
 * wicks stick out by a small fixed amount that depends only on the position, so a hand-written demo path always looks the same.
 */
export function candlesFromCloses(first: number, closes: readonly number[], decimals = 2): LCandle[] {
  const out: LCandle[] = [];
  let prev = first;
  closes.forEach((close, i) => {
    const wickUp = 1 + ((i * 37 + 11) % 7) / 200;
    const wickDown = 1 + ((i * 53 + 5) % 7) / 200;
    const hi = Math.max(prev, close) * wickUp;
    const lo = Math.min(prev, close) / wickDown;
    out.push({ o: roundTo(prev, decimals), h: roundTo(hi, decimals), l: roundTo(lo, decimals), c: roundTo(close, decimals) });
    prev = close;
  });
  return out;
}

/** The highest and lowest price of a list of candles (and of extra prices, for example lines). */
export function priceRange(candles: readonly LCandle[], extra: readonly number[] = []): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const c of candles) {
    if (c.l < min) min = c.l;
    if (c.h > max) max = c.h;
  }
  for (const p of extra) {
    if (p < min) min = p;
    if (p > max) max = p;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 };
  if (max - min < 1e-12) return { min: min - 0.5, max: max + 0.5 };
  return { min, max };
}

/** The biggest profit one buy then one later sell could have made on a list of closes (0 when the price only fell). */
export function bestLongGain(closes: readonly number[]): number {
  let low = Infinity;
  let best = 0;
  for (const c of closes) {
    if (c < low) low = c;
    else if (c - low > best) best = c - low;
  }
  return best;
}

/** The biggest profit one short then one later cover could have made (0 when the price only rose). */
export function bestShortGain(closes: readonly number[]): number {
  let high = -Infinity;
  let best = 0;
  for (const c of closes) {
    if (c > high) high = c;
    else if (high - c > best) best = high - c;
  }
  return best;
}
