// Test helpers: build rounds with exact, hand-chosen prices.

import {
  createRoundFromCandles,
  TOTAL_CANDLES,
  advance,
  type Candle,
  type RandomSource,
  type RoundState,
} from '../../src/engine';

type CandleOverride = Partial<Omit<Candle, 'index'>>;

/**
 * 70 flat candles at `price`, with optional overrides by global index.
 * high/low default to max/min of open and close so every candle stays valid.
 */
export function makeCandles(price: number, overrides: Record<number, CandleOverride> = {}): Candle[] {
  const candles: Candle[] = [];
  for (let index = 1; index <= TOTAL_CANDLES; index += 1) {
    const o = overrides[index] ?? {};
    const open = o.open ?? price;
    const close = o.close ?? price;
    candles.push({
      index,
      open,
      close,
      high: o.high ?? Math.max(open, close),
      low: o.low ?? Math.min(open, close),
    });
  }
  return candles;
}

export function makeRound(price: number, overrides: Record<number, CandleOverride> = {}, seed = 42): RoundState {
  return createRoundFromCandles(seed, makeCandles(price, overrides));
}

/** Advance until the newest visible candle is `k`. */
export function advanceTo(state: RoundState, k: number): RoundState {
  let s = state;
  while (s.k < k) {
    const next = advance(s);
    if (next === s) throw new Error(`Could not advance past ${s.k}`);
    s = next;
  }
  return s;
}

/** RNG stub: returns scripted values by 1-based draw position, `fallback` otherwise. Counts draws. */
export class ScriptedRng implements RandomSource {
  draws = 0;
  constructor(
    private readonly script: Record<number, number> = {},
    private readonly fallback = 0.5,
  ) {}
  next(): number {
    this.draws += 1;
    return this.script[this.draws] ?? this.fallback;
  }
}

/** Fills positions [from, from+count) of a script with one value. */
export function fill(script: Record<number, number>, from: number, count: number, value: number): void {
  for (let p = from; p < from + count; p += 1) script[p] = value;
}
