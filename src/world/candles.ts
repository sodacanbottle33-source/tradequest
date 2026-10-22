// Candlesticks of the persistent world. A candle is exactly 10 ticks (rules.md §13.4, same convention as live mode):
// candle n covers ticks 10(n−1)+1 … 10n and OPENS at the price of tick 10(n−1). Hourly and daily candles are built from
// the 10-tick candles by folding, so a larger candle always agrees exactly with the smaller ones inside it.

import { CANDLES_PER_DAY, CANDLES_PER_HOUR, TICKS_PER_CANDLE } from './params';

export type CandleMove = 'up' | 'down' | 'flat';

export interface Candle {
  /** 1-based number within its resolution. */
  readonly index: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  /** Shares traded (whole shares). */
  readonly volume: number;
}

export function moveOf(open: number, close: number): CandleMove {
  return close > open ? 'up' : close < open ? 'down' : 'flat';
}

/** Collects the ticks of one forming 10-tick candle. */
export class CandleBuilder {
  index = 0;
  open = 0;
  high = 0;
  low = 0;
  close = 0;
  volume = 0;
  ticks = 0;

  /** Starts candle `index` at `openPrice` (the previous candle's close). */
  begin(index: number, openPrice: number): void {
    this.index = index;
    this.open = openPrice;
    this.high = openPrice;
    this.low = openPrice;
    this.close = openPrice;
    this.volume = 0;
    this.ticks = 0;
  }

  /** Adds one tick. Returns true when this tick completed the candle. */
  add(price: number, volume: number): boolean {
    if (this.ticks >= TICKS_PER_CANDLE) throw new Error('Candle is already complete');
    if (price > this.high) this.high = price;
    if (price < this.low) this.low = price;
    this.close = price;
    this.volume += volume;
    this.ticks += 1;
    return this.ticks === TICKS_PER_CANDLE;
  }

  /** The candle as it stands (final once 10 ticks have been added). Volume is rounded to whole shares here. */
  toCandle(): Candle {
    return { index: this.index, open: this.open, high: this.high, low: this.low, close: this.close, volume: Math.round(this.volume) };
  }
}

/** Folds consecutive smaller candles into one larger candle. */
export function fold(index: number, parts: readonly Candle[]): Candle {
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (!first || !last) throw new Error('Cannot fold zero candles');
  let high = first.high;
  let low = first.low;
  let volume = 0;
  for (const p of parts) {
    if (p.high > high) high = p.high;
    if (p.low < low) low = p.low;
    volume += p.volume;
  }
  return { index, open: first.open, high, low, close: last.close, volume };
}

/** Which hourly / daily candle a 10-tick candle belongs to, and whether it is the last one of it. */
export function hourlyPosition(candleIndex: number): { hour: number; last: boolean } {
  return { hour: Math.ceil(candleIndex / CANDLES_PER_HOUR), last: candleIndex % CANDLES_PER_HOUR === 0 };
}

export function dailyPosition(candleIndex: number): { day: number; last: boolean } {
  return { day: Math.ceil(candleIndex / CANDLES_PER_DAY), last: candleIndex % CANDLES_PER_DAY === 0 };
}
