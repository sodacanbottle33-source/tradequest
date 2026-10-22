// LIC-01 … LIC-16 — candlesticks built from ticks (docs/rules.md §13.3).
import { describe, expect, it } from 'vitest';
import {
  advanceLive,
  buildLiveCandle,
  candleDirection,
  createLiveSession,
  createTickMarket,
  formingCandleIndex,
  getLiveView,
  liveCandlesAt,
  skipToCandleEnd,
  TICKERS,
  ticksIntoCandle,
  type LiveCandle,
} from '../src/engine';
import { assertNoFutureLive, makeTickMarket } from './helpers/live';

const LONG_TEST = 60_000;

/**
 * An independent "recorder" that works exactly as the product spec describes: when a candle begins, remember its
 * opening price; on every tick update high, low and close; after 10 ticks finalise it and start the next one.
 * It is fed the market's tick prices one at a time and never looks ahead.
 */
class Recorder {
  readonly done: LiveCandle[] = [];
  current: { index: number; openTick: number; open: number; high: number; low: number; close: number; ticks: number };

  constructor(startPrice: number) {
    this.current = { index: 1, openTick: 0, open: startPrice, high: startPrice, low: startPrice, close: startPrice, ticks: 0 };
  }

  tick(price: number): void {
    const c = this.current;
    c.ticks += 1;
    c.close = price;
    if (price > c.high) c.high = price;
    if (price < c.low) c.low = price;
    if (c.ticks === 10) {
      this.done.push({ ...c, complete: true, direction: candleDirection(c.open, c.close) });
      this.current = { index: c.index + 1, openTick: c.openTick + 10, open: price, high: price, low: price, close: price, ticks: 0 };
    }
  }

  all(): LiveCandle[] {
    const c = this.current;
    return [...this.done, { ...c, complete: false, direction: candleDirection(c.open, c.close) }];
  }
}

const fields = (c: LiveCandle) => [c.index, c.openTick, c.ticks, c.complete, c.open, c.high, c.low, c.close, c.direction];

describe('Candles form from ticks (§13.3)', () => {
  it('LIC-01: at every tick, every stock\'s candles equal what a tick-by-tick recorder produced', () => {
    for (const seed of [12345, 1, 4294967295, 777]) {
      const market = createTickMarket(seed);
      for (const ticker of TICKERS) {
        const rec = new Recorder(market.priceAt(ticker, 0));
        for (let t = 0; t <= 450; t += 1) {
          if (t > 0) rec.tick(market.priceAt(ticker, t));
          if (t % 3 === 0 || t % 10 === 0 || t % 10 === 9) {
            const mine = liveCandlesAt(market, ticker, t).map(fields);
            if (JSON.stringify(mine) !== JSON.stringify(rec.all().map(fields))) throw new Error(`seed ${seed} ${ticker} tick ${t} differs`);
          }
        }
      }
    }
  }, LONG_TEST);

  it('LIC-02: every finished candle contains exactly 10 ticks; the forming one contains tick-mod-10', () => {
    const market = createTickMarket(2026);
    for (const ticker of TICKERS) {
      for (let t = 0; t <= 300; t += 1) {
        const candles = liveCandlesAt(market, ticker, t);
        candles.forEach((c, i) => {
          const last = i === candles.length - 1;
          if (last) {
            expect(c.ticks).toBe(t % 10);
            expect(c.complete).toBe(false);
          } else {
            expect(c.ticks).toBe(10);
            expect(c.complete).toBe(true);
          }
        });
        expect(candles.length).toBe(Math.floor(t / 10) + 1);
      }
    }
  }, LONG_TEST);

  it('LIC-03: a candle opens at the previous candle\'s close; candle 1 opens at the stock\'s first price', () => {
    for (const seed of [5, 6, 7]) {
      const market = createTickMarket(seed);
      for (const ticker of TICKERS) {
        const candles = liveCandlesAt(market, ticker, 400);
        expect(candles[0]?.open).toBe(market.priceAt(ticker, 0));
        for (let i = 1; i < candles.length; i += 1) expect(candles[i]?.open).toBe(candles[i - 1]?.close);
      }
    }
  });

  it('LIC-04: high and low are the extremes of the candle\'s ticks and contain open and close', () => {
    const market = createTickMarket(99);
    for (const ticker of TICKERS) {
      for (const c of liveCandlesAt(market, ticker, 500)) {
        const prices = Array.from({ length: c.ticks + 1 }, (_, i) => market.priceAt(ticker, c.openTick + i));
        expect(c.high).toBe(Math.max(...prices));
        expect(c.low).toBe(Math.min(...prices));
        expect(c.high >= Math.max(c.open, c.close)).toBe(true);
        expect(c.low <= Math.min(c.open, c.close)).toBe(true);
        expect(c.open).toBe(prices[0]);
        expect(c.close).toBe(prices[prices.length - 1]);
      }
    }
  });

  it('LIC-05: a hand-worked candle: open 1000, ticks 1010 995 1040 1020 1020 980 1000 1005 1030 1015', () => {
    const script = [1000, 1010, 995, 1040, 1020, 1020, 980, 1000, 1005, 1030, 1015];
    const market = makeTickMarket({ QLRX: script });
    const c = buildLiveCandle(market, 'QLRX', 1, 10);
    expect(c).toEqual({ index: 1, openTick: 0, ticks: 10, complete: true, open: 1000, high: 1040, low: 980, close: 1015, direction: 'up' });
    const partial = buildLiveCandle(market, 'QLRX', 1, 2);
    expect(partial).toEqual({ index: 1, openTick: 0, ticks: 2, complete: false, open: 1000, high: 1010, low: 995, close: 995, direction: 'down' });
  });

  it('LIC-06: colours: up when close > open, down when close < open, flat when equal', () => {
    expect(candleDirection(1000, 1001)).toBe('up');
    expect(candleDirection(1000, 999)).toBe('down');
    expect(candleDirection(1000, 1000)).toBe('flat');
    // Flat even though the price moved in between.
    const market = makeTickMarket({ QLRX: [1000, 1100, 900, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000] });
    const c = buildLiveCandle(market, 'QLRX', 1, 10);
    expect(c.direction).toBe('flat');
    expect(c.high).toBe(1100);
    expect(c.low).toBe(900);
    // A forming candle changes colour with the price.
    const swing = makeTickMarket({ QLRX: [1000, 1050, 950, 1000] });
    expect(buildLiveCandle(swing, 'QLRX', 1, 1).direction).toBe('up');
    expect(buildLiveCandle(swing, 'QLRX', 1, 2).direction).toBe('down');
    expect(buildLiveCandle(swing, 'QLRX', 1, 3).direction).toBe('flat');
  });

  it('LIC-07: the colour stored on every candle matches its open and close', () => {
    const market = createTickMarket(31);
    for (const ticker of TICKERS) {
      for (const c of liveCandlesAt(market, ticker, 600)) {
        expect(c.direction).toBe(c.close > c.open ? 'up' : c.close < c.open ? 'down' : 'flat');
      }
    }
  });

  it('LIC-08: right after a candle\'s 10th tick the next candle exists at once, with 0 ticks and open = high = low = close', () => {
    const market = createTickMarket(8);
    const at = liveCandlesAt(market, 'NVRA', 120);
    const last = at[at.length - 1]!;
    expect(last).toMatchObject({ index: 13, ticks: 0, complete: false, direction: 'flat' });
    expect(new Set([last.open, last.high, last.low, last.close]).size).toBe(1);
    expect(at[at.length - 2]).toMatchObject({ index: 12, ticks: 10, complete: true });
  });

  it('LIC-09: finished candles never change as the market moves on', () => {
    const market = createTickMarket(4242);
    for (const ticker of TICKERS) {
      const earlier = liveCandlesAt(market, ticker, 155);
      const later = liveCandlesAt(market, ticker, 400);
      earlier.slice(0, -1).forEach((c, i) => expect(later[i]).toEqual(c));
    }
  });

  it('LIC-10: the forming candle changes on every tick and only its close/high/low can change', () => {
    const market = createTickMarket(11);
    let previous = liveCandlesAt(market, 'HLQN', 200).at(-1)!;
    for (let t = 201; t <= 209; t += 1) {
      const now = liveCandlesAt(market, 'HLQN', t).at(-1)!;
      expect(now.index).toBe(previous.index);
      expect(now.open).toBe(previous.open);
      expect(now.ticks).toBe(previous.ticks + 1);
      expect(now.high).toBeGreaterThanOrEqual(previous.high);
      expect(now.low).toBeLessThanOrEqual(previous.low);
      expect(now.close).toBe(market.priceAt('HLQN', t));
      previous = now;
    }
  });

  it('LIC-11: new candles form automatically — advancing 10 ticks adds exactly one candle', () => {
    let s = createLiveSession(1234);
    expect(getLiveView(s).stocks[0]?.candles).toHaveLength(11);
    for (let i = 0; i < 6; i += 1) {
      const before = getLiveView(s).stocks[0]!.candles.length;
      s = advanceLive(s, 10);
      expect(getLiveView(s).stocks[0]!.candles.length).toBe(before + 1);
    }
    s = advanceLive(s, 4);
    expect(getLiveView(s).stocks[0]!.candles.length).toBe(getLiveView(advanceLive(s, 5)).stocks[0]!.candles.length);
    expect(getLiveView(advanceLive(s, 6)).stocks[0]!.candles.length).toBe(getLiveView(s).stocks[0]!.candles.length + 1);
  });

  it('LIC-12: forming candle number and ticks-into-candle helpers', () => {
    expect(formingCandleIndex(100)).toBe(11);
    expect(formingCandleIndex(109)).toBe(11);
    expect(formingCandleIndex(110)).toBe(12);
    expect(ticksIntoCandle(100)).toBe(0);
    expect(ticksIntoCandle(107)).toBe(7);
    expect(ticksIntoCandle(110)).toBe(0);
  });

  it('LIC-13: a session opens with ten finished history candles and an empty forming one', () => {
    const view = getLiveView(createLiveSession(77));
    for (const stock of view.stocks) {
      expect(stock.candles).toHaveLength(11);
      expect(stock.candles.slice(0, 10).every((c) => c.complete && c.ticks === 10)).toBe(true);
      expect(stock.candles[10]).toMatchObject({ index: 11, ticks: 0, complete: false });
    }
    expect(view.candleIndex).toBe(11);
    expect(view.ticksIntoCandle).toBe(0);
  });

  it('LIC-14: the view\'s newest candle always closes at the stock\'s current price', () => {
    let s = createLiveSession(5150);
    for (let i = 0; i < 80; i += 1) {
      s = i % 9 === 8 ? skipToCandleEnd(s) : advanceLive(s);
      const view = getLiveView(s);
      for (const stock of view.stocks) {
        expect(stock.candles.at(-1)?.close).toBe(stock.price);
        expect(stock.candles.at(-1)?.index).toBe(view.candleIndex);
      }
    }
  });

  it('LIC-15: the view reveals nothing after the current tick, at any tick', () => {
    let s = createLiveSession(808);
    for (let i = 0; i < 60; i += 1) {
      s = advanceLive(s, 1 + (i % 7));
      assertNoFutureLive(getLiveView(s), s);
    }
  });

  it('LIC-16: buildLiveCandle refuses a candle that has not begun and bad numbers', () => {
    const market = createTickMarket(3);
    expect(() => buildLiveCandle(market, 'QLRX', 5, 39)).toThrow();
    expect(() => buildLiveCandle(market, 'QLRX', 0, 10)).toThrow();
    expect(() => buildLiveCandle(market, 'QLRX', 1.5, 10)).toThrow();
    expect(buildLiveCandle(market, 'QLRX', 5, 40).ticks).toBe(0);
  });
});
