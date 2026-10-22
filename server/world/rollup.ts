// Folds 10-tick candles into hourly and daily candles, for every company at once. The partly built candles are part of the
// saved state, so a restart in the middle of an hour loses nothing.

import type { Candle } from '../../src/world';

export interface RollupState {
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  volume: number[];
  count: number[];
}

export class Rollup {
  readonly open: Float64Array;
  readonly high: Float64Array;
  readonly low: Float64Array;
  readonly close: Float64Array;
  readonly volume: Float64Array;
  readonly count: Int32Array;

  /** `perPeriod` = how many 10-tick candles make one candle of this rollup (360 = an hour, 8640 = a day). */
  constructor(
    readonly n: number,
    readonly perPeriod: number,
  ) {
    this.open = new Float64Array(n);
    this.high = new Float64Array(n);
    this.low = new Float64Array(n);
    this.close = new Float64Array(n);
    this.volume = new Float64Array(n);
    this.count = new Int32Array(n);
  }

  add(i: number, c: Candle): void {
    if ((this.count[i] as number) === 0) {
      this.open[i] = c.open;
      this.high[i] = c.high;
      this.low[i] = c.low;
      this.volume[i] = 0;
    } else {
      if (c.high > (this.high[i] as number)) this.high[i] = c.high;
      if (c.low < (this.low[i] as number)) this.low[i] = c.low;
    }
    this.close[i] = c.close;
    this.volume[i] = (this.volume[i] as number) + c.volume;
    this.count[i] = (this.count[i] as number) + 1;
  }

  /** True when the 10-tick candle with this number is the last one of its period. */
  isPeriodEnd(candleNo: number): boolean {
    return candleNo % this.perPeriod === 0;
  }

  /** Candles of the period that just ended (one per company that had data), and resets them. */
  flush(candleNo: number): { company: number; candle: Candle }[] {
    const idx = candleNo / this.perPeriod;
    const out: { company: number; candle: Candle }[] = [];
    for (let i = 0; i < this.n; i += 1) {
      if ((this.count[i] as number) === 0) continue;
      out.push({
        company: i,
        candle: { index: idx, open: this.open[i] as number, high: this.high[i] as number, low: this.low[i] as number, close: this.close[i] as number, volume: Math.round(this.volume[i] as number) },
      });
      this.count[i] = 0;
    }
    return out;
  }

  /** The candle being built for company i right now (null if nothing yet). */
  forming(i: number, candleNo: number): Candle | null {
    if ((this.count[i] as number) === 0) return null;
    return {
      index: Math.ceil(candleNo / this.perPeriod),
      open: this.open[i] as number,
      high: this.high[i] as number,
      low: this.low[i] as number,
      close: this.close[i] as number,
      volume: Math.round(this.volume[i] as number),
    };
  }

  /** A copy with room for more companies; the companies that exist keep their partly built candles (the new ones start empty). */
  grown(n: number): Rollup {
    if (n < this.n) throw new Error(`Cannot shrink a rollup from ${this.n} to ${n} companies`);
    const copy = new Rollup(n, this.perPeriod);
    copy.open.set(this.open);
    copy.high.set(this.high);
    copy.low.set(this.low);
    copy.close.set(this.close);
    copy.volume.set(this.volume);
    copy.count.set(this.count);
    return copy;
  }

  toState(): RollupState {
    return {
      open: Array.from(this.open),
      high: Array.from(this.high),
      low: Array.from(this.low),
      close: Array.from(this.close),
      volume: Array.from(this.volume),
      count: Array.from(this.count),
    };
  }

  loadState(state: RollupState): void {
    for (let i = 0; i < this.n; i += 1) {
      this.open[i] = state.open[i] ?? 0;
      this.high[i] = state.high[i] ?? 0;
      this.low[i] = state.low[i] ?? 0;
      this.close[i] = state.close[i] ?? 0;
      this.volume[i] = state.volume[i] ?? 0;
      this.count[i] = state.count[i] ?? 0;
    }
  }
}
