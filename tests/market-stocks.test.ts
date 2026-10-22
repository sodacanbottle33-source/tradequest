// MKT-01 … MKT-20 — the ten fictional stocks and their candles (docs/rules.md §12.2–12.3).
import { describe, expect, it } from 'vitest';
import {
  deriveSeed,
  generateCandlesFromRng,
  generateMarket,
  MARKET_ENGINE_VERSION,
  MARKET_START_CASH,
  MIN_PRICE,
  Mulberry32,
  stockByTicker,
  stockSeed,
  STOCKS,
  TICKERS,
  TOTAL_CANDLES,
  type Candle,
} from '../src/engine';

const SEEDS = Array.from({ length: 200 }, (_, i) => (i * 2654435761 + 7) >>> 0);
// Property tests do tens of thousands of actions; Vitest's default 5 s limit is too tight on slow machines.
const LONG_TEST = 60_000;

describe('The ten stocks (§12.2)', () => {
  it('MKT-01: there are exactly ten stocks with unique tickers, names and sensible fields', () => {
    expect(STOCKS).toHaveLength(10);
    expect(TICKERS).toHaveLength(10);
    expect(new Set(TICKERS).size).toBe(10);
    expect(new Set(STOCKS.map((s) => s.name)).size).toBe(10);
    for (const s of STOCKS) {
      expect(/^[A-Z]{4}$/.test(s.ticker)).toBe(true);
      expect(s.name.length).toBeGreaterThan(3);
      expect(s.sector.length).toBeGreaterThan(2);
    }
  });

  it('MKT-02: every stock has valid candle parameters', () => {
    for (const s of STOCKS) {
      expect(Number.isInteger(s.startMin)).toBe(true);
      expect(Number.isInteger(s.startMax)).toBe(true);
      expect(s.startMin).toBeGreaterThanOrEqual(MIN_PRICE * 5);
      expect(s.startMax).toBeGreaterThan(s.startMin);
      expect(s.bodySigma).toBeGreaterThan(0);
      expect(s.gapSigma).toBeGreaterThan(0);
      expect(s.maxMove).toBeGreaterThan(s.bodySigma);
      expect(s.maxGap).toBeGreaterThan(s.gapSigma);
      expect(s.wickMax).toBeGreaterThan(0);
      expect(s.wickMax).toBeLessThan(0.1);
      expect(s.drift).toBe(0);
    }
  });

  it('MKT-03: stockByTicker finds each stock and returns nothing for unknown tickers', () => {
    for (const s of STOCKS) expect(stockByTicker(s.ticker)).toBe(s);
    expect(stockByTicker('NOPE')).toBeUndefined();
    expect(stockByTicker('qlrx')).toBeUndefined();
    expect(stockByTicker('')).toBeUndefined();
  });

  it('MKT-04: the stocks differ in price level and volatility so they are worth choosing between', () => {
    const sigmas = STOCKS.map((s) => s.bodySigma);
    expect(Math.max(...sigmas) / Math.min(...sigmas)).toBeGreaterThan(5);
    const mids = STOCKS.map((s) => (s.startMin + s.startMax) / 2);
    expect(Math.max(...mids) / Math.min(...mids)).toBeGreaterThan(5);
    expect(new Set(STOCKS.map((s) => s.sector)).size).toBeGreaterThanOrEqual(8);
  });

  it('MKT-05: market mode has its own engine version and a $10,000 start', () => {
    expect(MARKET_ENGINE_VERSION).toBe(2);
    expect(MARKET_START_CASH).toBe(1_000_000);
  });
});

describe('Per-stock random streams (§12.3)', () => {
  it('MKT-06: deriveSeed is deterministic and returns an unsigned 32-bit integer', () => {
    for (const seed of [0, 1, 12345, 4294967295]) {
      for (let i = 0; i < 10; i += 1) {
        const a = deriveSeed(seed, i);
        expect(a).toBe(deriveSeed(seed, i));
        expect(Number.isInteger(a)).toBe(true);
        expect(a).toBeGreaterThanOrEqual(0);
        expect(a).toBeLessThanOrEqual(4294967295);
      }
    }
  });

  it('MKT-07: the ten streams of one seed are all different, and different seeds give different streams', () => {
    for (const seed of SEEDS.slice(0, 50)) {
      const derived = STOCKS.map((_, i) => deriveSeed(seed, i));
      expect(new Set(derived).size).toBe(10);
    }
    expect(deriveSeed(1, 0)).not.toBe(deriveSeed(2, 0));
    expect(deriveSeed(0, 0)).not.toBe(deriveSeed(0, 1));
  });

  it('MKT-08: stockSeed uses the position in the stock table', () => {
    STOCKS.forEach((_, i) => expect(stockSeed(777, i)).toBe(deriveSeed(777, i)));
  });

  it('MKT-09: deriveSeed rejects an invalid seed or stock index', () => {
    expect(() => deriveSeed(-1, 0)).toThrow();
    expect(() => deriveSeed(1.5, 0)).toThrow();
    expect(() => deriveSeed(4294967296, 0)).toThrow();
    expect(() => deriveSeed(1, -1)).toThrow();
    expect(() => deriveSeed(1, 0.5)).toThrow();
    expect(() => deriveSeed(1, 65536)).toThrow();
  });
});

describe('Generated markets (§12.3)', () => {
  it('MKT-10: a market has 70 correctly indexed candles for each of the ten stocks', () => {
    const market = generateMarket(12345);
    expect(Object.keys(market).sort()).toEqual([...TICKERS].sort());
    for (const ticker of TICKERS) {
      const list = market[ticker] ?? [];
      expect(list).toHaveLength(TOTAL_CANDLES);
      list.forEach((c, i) => expect(c.index).toBe(i + 1));
    }
  });

  it('MKT-11: the same seed always gives the same market; different seeds give different ones', () => {
    expect(generateMarket(98765)).toEqual(generateMarket(98765));
    expect(generateMarket(1)).not.toEqual(generateMarket(2));
  });

  it('MKT-12: each stock is generated from its own stream, so it never depends on the other stocks', () => {
    for (const seed of [0, 12345, 4294967295]) {
      const market = generateMarket(seed);
      STOCKS.forEach((stock, i) => {
        const alone = generateCandlesFromRng(new Mulberry32(deriveSeed(seed, i)), TOTAL_CANDLES, stock);
        expect(market[stock.ticker]).toEqual(alone);
      });
    }
  });

  it('MKT-13: each stock\'s stream uses exactly 1821 draws, like the single-stock engine', () => {
    STOCKS.forEach((stock, i) => {
      const rng = new Mulberry32(deriveSeed(12345, i));
      generateCandlesFromRng(rng, TOTAL_CANDLES, stock);
      expect(rng.draws).toBe(1821);
    });
  });

  it('MKT-14: every candle is valid: whole cents, high ≥ open/close ≥ low, nothing below the price floor', () => {
    for (const seed of SEEDS) {
      const market = generateMarket(seed);
      for (const ticker of TICKERS) {
        for (const c of market[ticker] ?? []) {
          const where = `seed ${seed} ${ticker} candle ${c.index}`;
          for (const v of [c.open, c.high, c.low, c.close]) {
            expect(Number.isSafeInteger(v) ? '' : `${where}: not an integer`).toBe('');
          }
          expect(c.high >= Math.max(c.open, c.close) ? '' : `${where}: high too low`).toBe('');
          expect(c.low <= Math.min(c.open, c.close) ? '' : `${where}: low too high`).toBe('');
          expect(c.low >= MIN_PRICE ? '' : `${where}: low below the floor`).toBe('');
        }
      }
    }
  }, LONG_TEST);

  it('MKT-15: each stock starts inside its own price range', () => {
    for (const seed of SEEDS) {
      const market = generateMarket(seed);
      for (const stock of STOCKS) {
        const first = market[stock.ticker]?.[0];
        const open = first?.open ?? -1;
        expect(open >= stock.startMin && open <= stock.startMax ? '' : `seed ${seed} ${stock.ticker}: ${open}`).toBe('');
      }
    }
  });

  it('MKT-16: gaps and candle bodies stay inside each stock\'s own limits', () => {
    for (const seed of SEEDS.slice(0, 100)) {
      const market = generateMarket(seed);
      for (const stock of STOCKS) {
        const list: readonly Candle[] = market[stock.ticker] ?? [];
        list.forEach((c, i) => {
          const where = `seed ${seed} ${stock.ticker} candle ${c.index}`;
          const body = Math.abs(c.close - c.open) / c.open;
          // +0.5 cent of rounding slack on either side.
          expect(body <= stock.maxMove + 1 / c.open ? '' : `${where}: body ${body}`).toBe('');
          const prev = list[i - 1];
          if (prev) {
            const gap = Math.abs(c.open - prev.close) / prev.close;
            expect(gap <= stock.maxGap + 1 / prev.close ? '' : `${where}: gap ${gap}`).toBe('');
          }
        });
      }
    }
  }, LONG_TEST);

  it('MKT-17: calmer stocks really move less, in the order of their volatility settings', () => {
    const spread = new Map<string, number>();
    for (const stock of STOCKS) {
      let sum = 0;
      let n = 0;
      for (const seed of SEEDS) {
        const list = generateMarket(seed)[stock.ticker] ?? [];
        for (let i = 1; i < list.length; i += 1) {
          const prev = list[i - 1];
          const cur = list[i];
          if (!prev || !cur) continue;
          const r = (cur.close - prev.close) / prev.close;
          sum += r * r;
          n += 1;
        }
      }
      spread.set(stock.ticker, Math.sqrt(sum / n));
    }
    const byCalm = [...STOCKS].sort((a, b) => a.bodySigma - b.bodySigma);
    for (let i = 1; i < byCalm.length; i += 1) {
      const calmer = byCalm[i - 1];
      const wilder = byCalm[i];
      if (!calmer || !wilder) continue;
      expect((spread.get(calmer.ticker) ?? 0) < (spread.get(wilder.ticker) ?? 0) ? '' : `${calmer.ticker} vs ${wilder.ticker}`).toBe('');
    }
    // The wildest stock is clearly wilder than the calmest.
    const calmest = spread.get(byCalm[0]?.ticker ?? '') ?? 1;
    const wildest = spread.get(byCalm[byCalm.length - 1]?.ticker ?? '') ?? 0;
    expect(wildest / calmest).toBeGreaterThan(4);
  }, LONG_TEST);

  it('MKT-18: no stock has a built-in tendency to rise or fall (average return is close to zero)', () => {
    for (const stock of STOCKS) {
      let sum = 0;
      let n = 0;
      for (const seed of SEEDS) {
        const list = generateMarket(seed)[stock.ticker] ?? [];
        for (let i = 1; i < list.length; i += 1) {
          const prev = list[i - 1];
          const cur = list[i];
          if (!prev || !cur) continue;
          sum += (cur.close - prev.close) / prev.close;
          n += 1;
        }
      }
      const mean = sum / n;
      expect(Math.abs(mean) < stock.bodySigma / 10 ? '' : `${stock.ticker}: mean return ${mean}`).toBe('');
    }
  }, LONG_TEST);

  it('MKT-19: the history (candles 1-10) has the same shape for every stock', () => {
    const market = generateMarket(2468);
    for (const ticker of TICKERS) {
      const history = (market[ticker] ?? []).slice(0, 10);
      expect(history).toHaveLength(10);
      history.forEach((c, i) => expect(c.index).toBe(i + 1));
    }
  });

  it('MKT-20: the single-stock candles of engine v1 are unchanged by the new per-stock parameters', () => {
    // generateCandlesFromRng with no parameters is the original engine; its golden test lives in candles.test.ts.
    const a = generateCandlesFromRng(new Mulberry32(12345));
    const b = generateCandlesFromRng(new Mulberry32(12345), TOTAL_CANDLES, {
      startMin: 2000,
      startMax: 5000,
      drift: 0,
      bodySigma: 0.015,
      gapSigma: 0.002,
      maxMove: 0.1,
      maxGap: 0.02,
      wickMax: 0.01,
    });
    expect(b).toEqual(a);
  });
});
