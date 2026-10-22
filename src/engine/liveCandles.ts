// Live market mode: candlesticks built from ticks — see docs/rules.md §13.4.
// A candle is exactly TICKS_PER_CANDLE ticks long. Candle n covers ticks (n−1)·10+1 … n·10 and OPENS at the
// price of tick (n−1)·10 (the price the previous candle closed at; candle 1 opens at the stock's first price).
// While the candle is forming, high/low/close follow every tick; after its 10th tick it is final.

import type { TickMarket } from './ticks';
import { TICKS_PER_CANDLE } from './ticks';

export type CandleDirection = 'up' | 'down' | 'flat';

export interface LiveCandle {
  /** 1-based candle number. */
  readonly index: number;
  /** Tick whose price is the open: (index − 1) · 10. */
  readonly openTick: number;
  /** Ticks that have happened inside this candle so far: 0 … 10. */
  readonly ticks: number;
  /** True once all 10 ticks have happened. A complete candle never changes again. */
  readonly complete: boolean;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  /** Price at the newest tick of this candle (the final close once complete). */
  readonly close: number;
  /** up: close > open (green) · down: close < open (red) · flat: equal (neutral). */
  readonly direction: CandleDirection;
}

export function candleDirection(open: number, close: number): CandleDirection {
  if (close > open) return 'up';
  if (close < open) return 'down';
  return 'flat';
}

/** The candle a tick belongs to as its newest tick (a tick that is a multiple of 10 closes a candle; the NEXT candle is the forming one). */
export function formingCandleIndex(tick: number): number {
  return Math.floor(tick / TICKS_PER_CANDLE) + 1;
}

/** Ticks already inside the forming candle at `tick`: 0 … 9. */
export function ticksIntoCandle(tick: number): number {
  return tick % TICKS_PER_CANDLE;
}

/** Candle `index` as it looks at `currentTick`. Throws if that candle has not begun yet. */
export function buildLiveCandle(market: TickMarket, ticker: string, index: number, currentTick: number): LiveCandle {
  if (!Number.isInteger(index) || index < 1) throw new Error(`Bad candle number ${index}`);
  const openTick = (index - 1) * TICKS_PER_CANDLE;
  if (currentTick < openTick) throw new Error(`Candle ${index} has not begun at tick ${currentTick}`);
  const lastTick = Math.min(currentTick, openTick + TICKS_PER_CANDLE);
  const open = market.priceAt(ticker, openTick);
  let high = open;
  let low = open;
  let close = open;
  for (let t = openTick + 1; t <= lastTick; t += 1) {
    const p = market.priceAt(ticker, t);
    if (p > high) high = p;
    if (p < low) low = p;
    close = p;
  }
  const ticks = lastTick - openTick;
  return { index, openTick, ticks, complete: ticks === TICKS_PER_CANDLE, open, high, low, close, direction: candleDirection(open, close) };
}

// Finished candles never change, so they are built once per market and reused.
const finished = new WeakMap<TickMarket, Map<string, LiveCandle[]>>();

function finishedCandles(market: TickMarket, ticker: string, count: number): LiveCandle[] {
  let byTicker = finished.get(market);
  if (!byTicker) {
    byTicker = new Map();
    finished.set(market, byTicker);
  }
  let list = byTicker.get(ticker);
  if (!list) {
    list = [];
    byTicker.set(ticker, list);
  }
  while (list.length < count) {
    const index = list.length + 1;
    list.push(buildLiveCandle(market, ticker, index, index * TICKS_PER_CANDLE));
  }
  return list;
}

/**
 * Every candle of a stock up to `tick`: all finished candles, then the one still forming (which has 0–9 ticks).
 * Nothing after `tick` is ever included.
 */
export function liveCandlesAt(market: TickMarket, ticker: string, tick: number): LiveCandle[] {
  const done = Math.floor(tick / TICKS_PER_CANDLE);
  return [...finishedCandles(market, ticker, done).slice(0, done), buildLiveCandle(market, ticker, done + 1, tick)];
}
