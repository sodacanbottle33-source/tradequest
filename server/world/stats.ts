// Rolling 24-hour statistics (change, volume, high, low) kept in memory, one slot per 10-tick candle of the last day, so the
// market overview never has to scan the database.

import { CANDLES_PER_DAY } from '../../src/world';

export class RollingStats {
  readonly window = CANDLES_PER_DAY;
  private readonly close: Float64Array;
  private readonly high: Float64Array;
  private readonly low: Float64Array;
  private readonly volume: Float64Array;
  /** Newest candle number stored (0 = none). */
  private last = 0;

  constructor(readonly n: number) {
    this.close = new Float64Array(n * this.window);
    this.high = new Float64Array(n * this.window);
    this.low = new Float64Array(n * this.window);
    this.volume = new Float64Array(n * this.window);
  }

  /** Stores company i's candle number `candleNo` (candles must arrive in order, one call per company per candle). */
  set(i: number, candleNo: number, c: { close: number; high: number; low: number; volume: number }): void {
    const slot = i * this.window + (candleNo % this.window);
    this.close[slot] = c.close;
    this.high[slot] = c.high;
    this.low[slot] = c.low;
    this.volume[slot] = c.volume;
    if (candleNo > this.last) this.last = candleNo;
  }

  /** Clears company i's slot for a candle it did not trade in (not listed yet), so old data never lingers. */
  clear(i: number, candleNo: number): void {
    const slot = i * this.window + (candleNo % this.window);
    this.close[slot] = 0;
    this.high[slot] = 0;
    this.low[slot] = 0;
    this.volume[slot] = 0;
    if (candleNo > this.last) this.last = candleNo;
  }

  get newest(): number {
    return this.last;
  }

  /** First candle number of the window. */
  private from(): number {
    return Math.max(1, this.last - this.window + 1);
  }

  /** Close of the oldest candle in the window (≈ 24 h ago), or 0 if the company had no candles yet. */
  open24h(i: number): number {
    for (let c = this.from(); c <= this.last; c += 1) {
      const v = this.close[i * this.window + (c % this.window)] as number;
      if (v > 0) return v;
    }
    return 0;
  }

  volume24h(i: number): number {
    let sum = 0;
    for (let c = this.from(); c <= this.last; c += 1) sum += this.volume[i * this.window + (c % this.window)] as number;
    return Math.round(sum);
  }

  range24h(i: number): { high: number; low: number } {
    let high = 0;
    let low = Infinity;
    for (let c = this.from(); c <= this.last; c += 1) {
      const slot = i * this.window + (c % this.window);
      const h = this.high[slot] as number;
      const l = this.low[slot] as number;
      if (h > high) high = h;
      if (l > 0 && l < low) low = l;
    }
    return { high, low: low === Infinity ? 0 : low };
  }

  /** A copy with room for more companies; the companies that exist keep exactly their numbers (the new ones start empty). */
  grown(n: number): RollingStats {
    if (n < this.n) throw new Error(`Cannot shrink the statistics from ${this.n} to ${n} companies`);
    const copy = new RollingStats(n);
    copy.close.set(this.close);
    copy.high.set(this.high);
    copy.low.set(this.low);
    copy.volume.set(this.volume);
    copy.last = this.last;
    return copy;
  }

  /** Clears everything (used before reloading from the database). */
  reset(): void {
    this.close.fill(0);
    this.high.fill(0);
    this.low.fill(0);
    this.volume.fill(0);
    this.last = 0;
  }
}
