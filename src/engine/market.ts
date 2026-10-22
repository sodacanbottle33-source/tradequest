// Market mode: the ten stocks' candles from one seed — see docs/rules.md §12.3.
// Each stock gets its own independent random stream (derived from the round seed and the stock's
// position in STOCKS), so one stock's candles never depend on another's.

import { generateCandlesFromRng, type Candle } from './candles';
import { Mulberry32, deriveSeed } from './rng';
import { STOCKS } from './stocks';

/** Market mode is identified by (MARKET_ENGINE_VERSION, seed). The v1 single-stock engine keeps ENGINE_VERSION = 1. */
export const MARKET_ENGINE_VERSION = 2;

/** Starting cash in market mode: $10,000.00 (integer cents). */
export const MARKET_START_CASH = 1_000_000;

/** Candles for every stock, keyed by ticker. INTERNAL — never hand this to the UI (see marketView.ts). */
export type MarketCandles = Readonly<Record<string, readonly Candle[]>>;

/** Seed of the random stream for the stock at position `stockIndex` in STOCKS. */
export function stockSeed(seed: number, stockIndex: number): number {
  return deriveSeed(seed, stockIndex);
}

/** All 70 candles of all ten stocks for a seed. Same seed → same market, always. */
export function generateMarket(seed: number): MarketCandles {
  const out: Record<string, readonly Candle[]> = {};
  STOCKS.forEach((stock, i) => {
    out[stock.ticker] = generateCandlesFromRng(new Mulberry32(stockSeed(seed, i)), undefined, stock);
  });
  return out;
}
