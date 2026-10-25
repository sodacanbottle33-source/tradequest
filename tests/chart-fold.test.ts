// The chart keeps every price of the forming candle (src/shared/candles.ts). The server's candles are loaded now and then (about once a
// minute); between loads each new tick is folded in. The old code folded only the LATEST price into the loaded candles, so a spike
// inside the forming 10-tick candle was missing from its wick until the next reload, and then the wick jumped.
import { describe, expect, it } from 'vitest';
import { foldMore, foldTick, missedTicks, type FoldState } from '../src/shared/candles';
import type { ServerCandle } from '../src/shared/types';

const done = (index: number, open: number, close: number): ServerCandle => ({ index, open, high: Math.max(open, close), low: Math.min(open, close), close, volume: 0, ticks: 10, complete: true });

// Loaded at tick 31 (the first tick of candle 4): candle 4 has just begun at 1000.
const loaded: ServerCandle[] = [done(2, 1000, 1010), done(3, 1010, 1000), { index: 4, open: 1000, high: 1000, low: 1000, close: 1000, volume: 0, ticks: 0, complete: false }];

describe('chart folding', () => {
  it('FOLD-1: a spike in the middle of the forming candle stays in its wick', () => {
    // ticks 31 … 36: 1000, 1005, 1090 (a spike), 1040, 1010, 1002
    const prices = [1000, 1005, 1090, 1040, 1010, 1002];
    let state: FoldState | null = null;
    prices.forEach((p, i) => {
      state = foldMore(state, loaded, 31 + i, p, 'c10');
    });
    const forming = (state as unknown as FoldState).candles.at(-1) as ServerCandle;
    expect(forming.index).toBe(4);
    expect(forming.high).toBe(1090);
    expect(forming.low).toBe(1000);
    expect(forming.close).toBe(1002);
    expect(forming.ticks).toBe(6);
    // the old way (only the latest price into the loaded candles) loses the spike
    const old = foldTick(loaded, 36, 1002, 'c10').at(-1) as ServerCandle;
    expect(old.high).toBe(1002);
  });

  it('FOLD-2: a low in the middle of a candle is kept too, also across the start of the next candle', () => {
    let state: FoldState | null = null;
    const feed = (tick: number, price: number): void => {
      state = foldMore(state, loaded, tick, price, 'c10');
    };
    for (let t = 31; t <= 40; t += 1) feed(t, t === 34 ? 960 : 1000); // candle 4: a dip to 960 at tick 34
    feed(41, 1003); // candle 5 begins
    feed(42, 1030);
    const candles = (state as unknown as FoldState).candles;
    const c4 = candles.find((c) => c.index === 4) as ServerCandle;
    const c5 = candles.at(-1) as ServerCandle;
    expect(c4.low).toBe(960);
    expect(c4.complete).toBe(true);
    expect(c5.index).toBe(5);
    expect(c5.open).toBe(1000); // a candle opens at the previous close
    expect(c5.high).toBe(1030);
    expect(c5.low).toBe(1000);
  });

  it('FOLD-3: after a reload (new loaded candles) folding starts again from the server\'s candles', () => {
    let state: FoldState | null = null;
    state = foldMore(state, loaded, 33, 1090, 'c10');
    // the server's own candles now say the high was 1095
    const reloaded: ServerCandle[] = [...loaded.slice(0, 2), { index: 4, open: 1000, high: 1095, low: 1000, close: 1050, volume: 5, ticks: 3, complete: false }];
    state = foldMore(state, reloaded, 34, 1060, 'c10');
    const c4 = state.candles.at(-1) as ServerCandle;
    expect(c4.high).toBe(1095);
    expect(c4.close).toBe(1060);
    expect(c4.volume).toBe(5);
  });

  it('FOLD-4: folding the same tick twice changes nothing', () => {
    const a = foldMore(null, loaded, 33, 1050, 'c10');
    const b = foldMore(a, loaded, 33, 1050, 'c10');
    expect(b.candles).toEqual(a.candles);
  });

  it('FOLD-5: when ticks were skipped the chart asks the server again; ordinary ticks do not', () => {
    expect(missedTicks(0, 100)).toBe(false); // nothing folded yet
    expect(missedTicks(100, 101)).toBe(false);
    expect(missedTicks(100, 100)).toBe(false);
    expect(missedTicks(100, 102)).toBe(true);
    expect(missedTicks(100, 160)).toBe(true);
  });
});
