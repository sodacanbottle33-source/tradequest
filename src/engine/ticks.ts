// Live market mode: the price of every stock at every tick — see docs/rules.md §13.2–13.3.
// A tick is one market update. The market is a pure function of (seed, ticker, tick): the same seed always
// gives the same prices, in whatever order or at whatever speed they are looked at.

import { MIN_PRICE } from './constants';
import { roundHalfUpFloat } from './money';
import { deriveSeed, uniformAt } from './rng';
import { STOCKS, TICKERS, type StockSpec } from './stocks';

/** Live mode has its own version: any change to the tick formulas, draw order, stock table or start cash bumps it. */
export const LIVE_ENGINE_VERSION = 3;

/** Every candlestick covers exactly this many ticks. */
export const TICKS_PER_CANDLE = 10;
/** Candles already on the chart when a session starts (context only). */
export const LIVE_HISTORY_CANDLES = 10;
export const LIVE_HISTORY_TICKS = LIVE_HISTORY_CANDLES * TICKS_PER_CANDLE; // 100
/** Starting cash of a live session: $1,000.00 (integer cents). */
export const LIVE_START_CASH = 100_000;

/** 1 / √10 written out, so the engine needs no square-root function. Candle-sized volatility is spread over 10 ticks. */
export const TICK_SIGMA_SCALE = 0.31622776601683794;
/** Uniform draws used per tick (a normal-ish number is the sum of 12 uniforms, rules.md §5.2). */
export const DRAWS_PER_TICK = 12;
/** Safety limit so a bug can never ask for an absurd tick. */
export const MAX_TICK = 10_000_000;

/** Standard deviation of one tick's return for a stock. */
export function tickSigma(spec: StockSpec): number {
  return spec.bodySigma * TICK_SIGMA_SCALE;
}

/** Largest allowed single-tick move (a fraction). */
export function tickMaxMove(spec: StockSpec): number {
  return spec.maxMove * 0.5;
}

/** First price of a stock (tick 0): uses draw 1 of its stream. */
export function startPriceOf(spec: StockSpec, streamSeed: number): number {
  const u = uniformAt(streamSeed, 1);
  return spec.startMin + Math.floor(u * (spec.startMax - spec.startMin + 1));
}

/** Price at `tick` (≥ 1) given the price one tick earlier. Tick n uses draws 2+12(n−1) … 13+12(n−1) of the stream. */
export function nextPriceOf(spec: StockSpec, streamSeed: number, tick: number, previous: number): number {
  const first = 2 + DRAWS_PER_TICK * (tick - 1);
  let sum = 0;
  for (let j = 0; j < DRAWS_PER_TICK; j += 1) sum += uniformAt(streamSeed, first + j);
  const z = sum - 6;
  const limit = tickMaxMove(spec);
  const move = Math.min(Math.max(spec.drift + tickSigma(spec) * z, -limit), limit);
  return Math.max(MIN_PRICE, roundHalfUpFloat(previous * (1 + move)));
}

function checkTick(tick: number): void {
  if (!Number.isInteger(tick) || tick < 0 || tick > MAX_TICK) throw new Error(`Bad tick ${tick}`);
}

/**
 * The prices of all ten stocks. Prices are computed on demand and remembered; remembering never changes a
 * value, so asking for tick 500 first or tick 1 first gives identical results. INTERNAL: the UI must only
 * ever receive prices up to the current tick, through getLiveView().
 */
export class TickMarket {
  readonly seed: number;
  private readonly series = new Map<string, number[]>();
  private readonly streams = new Map<string, number>();
  private readonly fixed: boolean;

  constructor(seed: number, scriptedPrices?: Readonly<Record<string, readonly number[]>>) {
    this.seed = seed;
    this.fixed = scriptedPrices !== undefined;
    STOCKS.forEach((spec, i) => {
      if (scriptedPrices) {
        const list = scriptedPrices[spec.ticker];
        if (!list || list.length < 1) throw new Error(`Missing prices for ${spec.ticker}`);
        list.forEach((p, n) => {
          if (!Number.isSafeInteger(p) || p < 1) throw new Error(`${spec.ticker} tick ${n}: bad price ${p}`);
        });
        this.series.set(spec.ticker, [...list]);
      } else {
        const streamSeed = deriveSeed(seed, i);
        this.streams.set(spec.ticker, streamSeed);
        this.series.set(spec.ticker, [startPriceOf(spec, streamSeed)]);
      }
    });
  }

  /** Price (cents) of `ticker` at `tick`. Tick 0 is the first price. */
  priceAt(ticker: string, tick: number): number {
    checkTick(tick);
    const list = this.series.get(ticker);
    if (!list) throw new Error(`Unknown stock ${ticker}`);
    if (tick >= list.length) {
      if (this.fixed) throw new Error(`${ticker} has prices only up to tick ${list.length - 1}, asked for ${tick}`);
      const spec = STOCKS.find((s) => s.ticker === ticker);
      const streamSeed = this.streams.get(ticker);
      if (!spec || streamSeed === undefined) throw new Error(`Unknown stock ${ticker}`);
      while (list.length <= tick) list.push(nextPriceOf(spec, streamSeed, list.length, list[list.length - 1] ?? spec.startMin));
    }
    const price = list[tick];
    if (price === undefined) throw new Error(`No price for ${ticker} at tick ${tick}`);
    return price;
  }

  /** Last tick that exists (scripted markets only have a limited number of ticks; generated ones are unlimited). */
  get lastScriptedTick(): number | null {
    if (!this.fixed) return null;
    return Math.min(...TICKERS.map((t) => (this.series.get(t)?.length ?? 1) - 1));
  }
}

/** A market for a seed. */
export function createTickMarket(seed: number): TickMarket {
  return new TickMarket(seed);
}

/** A market with exactly the given prices per ticker (index = tick). Used by tests that need hand-chosen numbers. */
export function createTickMarketFromPrices(seed: number, prices: Readonly<Record<string, readonly number[]>>): TickMarket {
  return new TickMarket(seed, prices);
}
