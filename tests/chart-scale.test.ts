// CHS-01 … CHS-10 — the price axis of the live chart and the candle caption (src/ui/chartScale.ts, labels.ts).
import { describe, expect, it } from 'vitest';
import { createTickMarket, liveCandlesAt, TICKERS } from '../src/engine';
import { niceStep, priceDomain } from '../src/ui/chartScale';
import { candleStateLabel } from '../src/ui/labels';

describe('Grid steps', () => {
  it('CHS-01: a nice step is 1, 2 or 5 times a power of ten, and at least as big as the target', () => {
    for (const target of [0.2, 1, 1.5, 3, 7, 12, 99, 100, 101, 250, 777, 1000, 4321, 123456]) {
      const step = niceStep(target);
      expect(step).toBeGreaterThanOrEqual(Math.max(target, 1));
      expect([1, 2, 5].includes(Number(String(step)[0])) && /^[125]0*$/.test(String(step))).toBe(true);
      expect(step).toBeLessThanOrEqual(Math.max(target, 1) * 2.5); // never wildly coarser than asked
    }
  });
});

describe('Price domain', () => {
  it('CHS-02: the domain contains every high and low it was given, with room to spare', () => {
    for (const seed of [1, 2, 3]) {
      const market = createTickMarket(seed);
      for (const ticker of TICKERS) {
        const candles = liveCandlesAt(market, ticker, 400);
        for (let from = 0; from < candles.length - 5; from += 7) {
          const slice = candles.slice(from, from + 20);
          const { lo, hi } = priceDomain(slice);
          expect(lo).toBeLessThan(Math.min(...slice.map((c) => c.low)));
          expect(hi).toBeGreaterThan(Math.max(...slice.map((c) => c.high)));
        }
      }
    }
  });

  it('CHS-03: the domain edges are multiples of the step, so grid lines land on round prices', () => {
    for (const lows of [[1000, 1010], [123, 456], [99_000, 101_000], [5, 9]]) {
      const { lo, hi, step } = priceDomain([{ low: lows[0]!, high: lows[1]! }]);
      expect(lo % step).toBe(0);
      expect(hi % step).toBe(0);
      expect((hi - lo) / step).toBeLessThanOrEqual(12);
      expect((hi - lo) / step).toBeGreaterThanOrEqual(3);
    }
  });

  it('CHS-04: a flat price still gets a usable, non-empty range', () => {
    const { lo, hi } = priceDomain([{ low: 2500, high: 2500 }]);
    expect(hi - lo).toBeGreaterThanOrEqual(10);
    expect(lo).toBeLessThan(2500);
    expect(hi).toBeGreaterThan(2500);
  });

  it('CHS-05: the range does not change when a new candle stays inside it (no needless re-scaling)', () => {
    const base = [{ low: 3400, high: 3600 }, { low: 3450, high: 3550 }];
    const a = priceDomain(base);
    const b = priceDomain([...base, { low: 3480, high: 3520 }]);
    expect(b).toEqual(a);
  });

  it('CHS-06: the range does grow when a candle goes outside it', () => {
    const base = [{ low: 3400, high: 3600 }];
    const a = priceDomain(base);
    const b = priceDomain([...base, { low: 3000, high: 3700 }]);
    expect(b.lo).toBeLessThan(a.lo);
    expect(b.hi).toBeGreaterThanOrEqual(a.hi);
  });

  it('CHS-07: no candles gives a harmless default', () => {
    expect(priceDomain([])).toEqual({ lo: 0, hi: 100, step: 20 });
  });
});

describe('Candle caption', () => {
  it('CHS-08: a forming candle says how many of its ticks have happened', () => {
    expect(candleStateLabel({ index: 12, ticks: 4, complete: false }, 10, 11)).toBe('forming, 4 of 10 ticks');
    expect(candleStateLabel({ index: 12, ticks: 0, complete: false }, 10, 11)).toBe('forming, 0 of 10 ticks');
  });

  it('CHS-09: a finished candle says it has 10 ticks, and whether it is from before the session', () => {
    expect(candleStateLabel({ index: 5, ticks: 10, complete: true }, 10, 11)).toBe('history, 10 ticks');
    expect(candleStateLabel({ index: 11, ticks: 10, complete: true }, 10, 11)).toBe('finished, 10 ticks');
  });
});
