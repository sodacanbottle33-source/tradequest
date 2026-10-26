// Where things go on a practice chart (pure, so it can be tested without a browser). The drawing itself is src/shared/MiniChart.tsx.

import { priceRange } from './candles';
import type { LCandle } from './types';

export const CHART_W = 640;
export const CHART_H = 260;
export const AXIS_W = 62;
export const PAD_TOP = 14;
export const PAD_BOTTOM = 14;

export interface Geometry {
  readonly min: number;
  readonly max: number;
  readonly slot: number;
  readonly body: number;
  /** x of the middle of candle i. */
  x(i: number): number;
  /** y of a price. */
  y(price: number): number;
}

/** The scale for `count` candle slots; the price range comes from the candles and from extra prices (lines), with 6 % room above and below. */
export function geometryOf(candles: readonly LCandle[], count: number, extra: readonly number[] = []): Geometry {
  const r = priceRange(candles, extra);
  const room = (r.max - r.min) * 0.06;
  const min = r.min - room;
  const max = r.max + room;
  const plotW = CHART_W - AXIS_W;
  const slot = plotW / Math.max(1, count);
  const body = Math.max(2, slot * 0.62);
  const plotH = CHART_H - PAD_TOP - PAD_BOTTOM;
  return {
    min,
    max,
    slot,
    body,
    x: (i) => slot * i + slot / 2,
    y: (price) => PAD_TOP + ((max - price) / (max - min)) * plotH,
  };
}

/** Four evenly spaced prices for the grid lines and the labels on the right. */
export function gridPrices(g: Geometry): number[] {
  const out: number[] = [];
  for (let k = 0; k < 4; k += 1) out.push(g.min + ((g.max - g.min) * (k + 0.5)) / 4);
  return out;
}
