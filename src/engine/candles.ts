// Deterministic candle generator — see docs/rules.md §5.3–5.5.
// History and playable candles come from the SAME loop and formulas.

import {
  BODY_SIGMA,
  DRIFT,
  GAP_SIGMA,
  HISTORY_LENGTH,
  MAX_GAP,
  MAX_MOVE,
  MIN_PRICE,
  START_PRICE_MAX,
  START_PRICE_MIN,
  TOTAL_CANDLES,
  WICK_MAX,
} from './constants';
import { roundHalfUpFloat } from './money';
import { Mulberry32, normalZ, type RandomSource } from './rng';

export interface Candle {
  /** Global index 1..70 (1–10 history, 11–70 playable). */
  readonly index: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(Math.max(x, lo), hi);
}

/** Price-model settings for one stock. The defaults are the v1 constants (rules.md §2); market mode gives each stock its own. */
export interface CandleParams {
  /** Lowest / highest possible start price, in cents. */
  readonly startMin: number;
  readonly startMax: number;
  readonly drift: number;
  readonly bodySigma: number;
  readonly gapSigma: number;
  readonly maxMove: number;
  readonly maxGap: number;
  readonly wickMax: number;
}

export const V1_CANDLE_PARAMS: CandleParams = {
  startMin: START_PRICE_MIN,
  startMax: START_PRICE_MAX,
  drift: DRIFT,
  bodySigma: BODY_SIGMA,
  gapSigma: GAP_SIGMA,
  maxMove: MAX_MOVE,
  maxGap: MAX_GAP,
  wickMax: WICK_MAX,
};

/** Start price from one uniform draw (§5.3 step 1). */
export function startPriceFrom(u: number, min: number = START_PRICE_MIN, max: number = START_PRICE_MAX): number {
  return min + Math.floor(u * (max - min + 1));
}

export interface CandleStream {
  readonly startPrice: number;
  /** Generate the next candle. Always consumes exactly 26 draws. */
  next(): Candle;
}

/** Creates a stream: draws the start price immediately, then one candle per next() call. */
export function createCandleStream(rng: RandomSource, params: CandleParams = V1_CANDLE_PARAMS): CandleStream {
  const startPrice = startPriceFrom(rng.next(), params.startMin, params.startMax);
  let index = 0;
  let prevClose = 0;

  return {
    startPrice,
    next(): Candle {
      index += 1;
      // Fixed draw order: always all four, even when a value is unused (§5.3).
      const zGap = normalZ(rng);
      const zBody = normalZ(rng);
      const uUp = rng.next();
      const uDown = rng.next();

      let open: number;
      if (index === 1) {
        open = startPrice;
      } else {
        const gap = clamp(params.gapSigma * zGap, -params.maxGap, params.maxGap);
        open = Math.max(MIN_PRICE, roundHalfUpFloat(prevClose * (1 + gap)));
      }

      const ret = clamp(params.drift + params.bodySigma * zBody, -params.maxMove, params.maxMove);
      const close = Math.max(MIN_PRICE, roundHalfUpFloat(open * (1 + ret)));
      const high = roundHalfUpFloat(Math.max(open, close) * (1 + uUp * params.wickMax));
      const low = Math.max(MIN_PRICE, roundHalfUpFloat(Math.min(open, close) * (1 - uDown * params.wickMax)));

      prevClose = close;
      return { index, open, high, low, close };
    },
  };
}

/** Generates `count` candles from an RNG (default: a full round of 70). */
export function generateCandlesFromRng(
  rng: RandomSource,
  count: number = TOTAL_CANDLES,
  params: CandleParams = V1_CANDLE_PARAMS,
): Candle[] {
  const stream = createCandleStream(rng, params);
  const candles: Candle[] = [];
  for (let i = 0; i < count; i += 1) candles.push(stream.next());
  return candles;
}

/** All 70 candles for a seed. Same seed → same candles, always. */
export function generateCandles(seed: number): Candle[] {
  return generateCandlesFromRng(new Mulberry32(seed));
}

/** History candles are indices 1–10 (§4.1). */
export function isHistoryIndex(index: number): boolean {
  return index >= 1 && index <= HISTORY_LENGTH;
}

/** Round number for display: index − 10 (11 → 1, 70 → 60). 0 or less means history. */
export function roundNumber(index: number): number {
  return index - HISTORY_LENGTH;
}
