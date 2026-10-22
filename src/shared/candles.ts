// Turns the server's candles into the shape the chart draws, and keeps the forming candle moving with every tick.
// The server owns the finished candles; the browser only folds the few ticks of the candle that is still forming.
import type { LiveCandle } from '../engine';
import type { Resolution, ServerCandle } from './types';

export const CANDLE_TICKS: Record<Resolution, number> = { c10: 10, h1: 3600, d1: 86_400 };

/** The server candle that holds a tick: candle n covers ticks (n−1)·size + 1 … n·size. */
export function candleIndexOf(tick: number, res: Resolution): number {
  return Math.max(1, Math.ceil(tick / CANDLE_TICKS[res]));
}

/** Keeps a list of candles up to date as ticks arrive. Returns the same array when nothing changed. */
export function foldTick(candles: readonly ServerCandle[], tick: number, price: number, res: Resolution): readonly ServerCandle[] {
  if (candles.length === 0 || price <= 0) return candles;
  const size = CANDLE_TICKS[res];
  const index = candleIndexOf(tick, res);
  const last = candles[candles.length - 1] as ServerCandle;
  if (index < last.index) return candles;
  const ticks = tick - (index - 1) * size;
  if (index === last.index) {
    if (last.close === price && last.ticks === ticks) return candles;
    const next: ServerCandle = { ...last, high: Math.max(last.high, price), low: Math.min(last.low, price), close: price, ticks, complete: ticks >= size };
    return [...candles.slice(0, -1), next];
  }
  // One or more candles have passed since the last one we know about: close the old one and open a new one from its close.
  const open = last.close;
  const done: ServerCandle = { ...last, ticks: size, complete: true };
  const fresh: ServerCandle = { index, open, high: Math.max(open, price), low: Math.min(open, price), close: price, volume: 0, ticks, complete: ticks >= size };
  return [...candles.slice(0, -1), done, fresh];
}

/** Server candles → the chart's numbering (first candle is 1, no gaps). */
export function toChartCandles(candles: readonly ServerCandle[], res: Resolution): { candles: LiveCandle[]; first: number } {
  const size = CANDLE_TICKS[res];
  const first = candles[0]?.index ?? 1;
  const out: LiveCandle[] = candles.map((c, i) => ({
    index: i + 1,
    openTick: (c.index - 1) * size,
    ticks: c.ticks ?? size,
    complete: c.complete ?? true,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    direction: c.close > c.open ? 'up' : c.close < c.open ? 'down' : 'flat',
  }));
  return { candles: out, first };
}
