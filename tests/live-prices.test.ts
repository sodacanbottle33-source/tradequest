// LIV-01 … LIV-24 — tick prices of the ten stocks (docs/rules.md §13.1–13.2).
import { describe, expect, it } from 'vitest';
import {
  createTickMarket,
  createTickMarketFromPrices,
  deriveSeed,
  DRAWS_PER_TICK,
  LIVE_ENGINE_VERSION,
  LIVE_HISTORY_CANDLES,
  LIVE_HISTORY_TICKS,
  LIVE_START_CASH,
  MIN_PRICE,
  Mulberry32,
  normalZ,
  startPriceOf,
  stockByTicker,
  STOCKS,
  tickMaxMove,
  tickSigma,
  TICK_SIGMA_SCALE,
  TICKERS,
  TICKS_PER_CANDLE,
  uniformAt,
} from '../src/engine';

const SEEDS = Array.from({ length: 40 }, (_, i) => (i * 2654435761 + 11) >>> 0);
// Property tests do tens of thousands of draws; Vitest's default 5 s limit is too tight on slow machines.
const LONG_TEST = 60_000;

describe('Live mode constants (§13.1)', () => {
  it('LIV-01: ten ticks per candle, ten history candles, $1,000 start, engine version 3', () => {
    expect(TICKS_PER_CANDLE).toBe(10);
    expect(LIVE_HISTORY_CANDLES).toBe(10);
    expect(LIVE_HISTORY_TICKS).toBe(100);
    expect(LIVE_START_CASH).toBe(100_000);
    expect(LIVE_ENGINE_VERSION).toBe(3);
    expect(DRAWS_PER_TICK).toBe(12);
  });

  it('LIV-02: the square-root constant really is 1/√10', () => {
    expect(Math.abs(TICK_SIGMA_SCALE * TICK_SIGMA_SCALE - 0.1)).toBeLessThan(1e-15);
  });
});

describe('uniformAt — direct access to a random stream (§13.2)', () => {
  it('LIV-03: draw k equals the k-th output of the sequential generator, for many seeds and k up to 3000', () => {
    for (const seed of [0, 1, 12345, 4294967295, ...SEEDS.slice(0, 10)]) {
      const rng = new Mulberry32(seed);
      for (let k = 1; k <= 3000; k += 1) {
        const expected = rng.next();
        if (uniformAt(seed, k) !== expected) throw new Error(`seed ${seed} draw ${k}: ${uniformAt(seed, k)} vs ${expected}`);
      }
    }
  });

  it('LIV-04: draws can be read in any order and give the same numbers', () => {
    const forward = [1, 2, 3, 500, 40000].map((k) => uniformAt(777, k));
    const backward = [40000, 500, 3, 2, 1].map((k) => uniformAt(777, k)).reverse();
    expect(backward).toEqual(forward);
  });

  it('LIV-05: draws are in [0, 1) and reject bad arguments', () => {
    for (let k = 1; k <= 500; k += 1) {
      const u = uniformAt(99, k);
      expect(u >= 0 && u < 1).toBe(true);
    }
    expect(() => uniformAt(-1, 1)).toThrow();
    expect(() => uniformAt(1.5, 1)).toThrow();
    expect(() => uniformAt(4294967296, 1)).toThrow();
    expect(() => uniformAt(1, 0)).toThrow();
    expect(() => uniformAt(1, 1.5)).toThrow();
    expect(() => uniformAt(1, -2)).toThrow();
  });
});

/** The tick model written out once more in the test, with a plain sequential generator (§13.2). */
function sequentialSeries(seed: number, stockIndex: number, ticks: number): number[] {
  const spec = STOCKS[stockIndex]!;
  const rng = new Mulberry32(deriveSeed(seed, stockIndex));
  const out = [spec.startMin + Math.floor(rng.next() * (spec.startMax - spec.startMin + 1))];
  for (let n = 1; n <= ticks; n += 1) {
    const z = normalZ(rng);
    const sigma = spec.bodySigma * 0.31622776601683794;
    const limit = spec.maxMove * 0.5;
    const move = Math.min(Math.max(spec.drift + sigma * z, -limit), limit);
    out.push(Math.max(100, Math.floor((out[n - 1] ?? 0) * (1 + move) + 0.5)));
  }
  return out;
}

describe('Tick prices (§13.2)', () => {
  it('LIV-06: the market equals a plain sequential implementation of the formulas', () => {
    for (const seed of [12345, 0, 4294967295, ...SEEDS.slice(0, 5)]) {
      const market = createTickMarket(seed);
      STOCKS.forEach((stock, i) => {
        const expected = sequentialSeries(seed, i, 600);
        const got = expected.map((_, n) => market.priceAt(stock.ticker, n));
        expect(got).toEqual(expected);
      });
    }
  });

  it('LIV-07: the same seed gives the same prices; different seeds give different ones', () => {
    const a = createTickMarket(555);
    const b = createTickMarket(555);
    for (const t of TICKERS) for (let n = 0; n <= 300; n += 1) expect(a.priceAt(t, n)).toBe(b.priceAt(t, n));
    const c = createTickMarket(556);
    expect(TICKERS.some((t) => a.priceAt(t, 200) !== c.priceAt(t, 200))).toBe(true);
  });

  it('LIV-08: asking for a late tick first, or one tick at a time, gives identical prices (no hidden state)', () => {
    const jumpy = createTickMarket(2468);
    const steady = createTickMarket(2468);
    const late = TICKERS.map((t) => jumpy.priceAt(t, 900));
    for (let n = 0; n <= 900; n += 1) for (const t of TICKERS) steady.priceAt(t, n);
    expect(TICKERS.map((t) => steady.priceAt(t, 900))).toEqual(late);
    for (const t of TICKERS) for (const n of [0, 1, 99, 100, 450, 899]) expect(jumpy.priceAt(t, n)).toBe(steady.priceAt(t, n));
  });

  it('LIV-09: prices are whole cents, never below the floor, and tick 0 is inside the stock\'s start range', () => {
    for (const seed of SEEDS) {
      const market = createTickMarket(seed);
      for (const stock of STOCKS) {
        const first = market.priceAt(stock.ticker, 0);
        expect(first >= stock.startMin && first <= stock.startMax ? '' : `seed ${seed} ${stock.ticker}: ${first}`).toBe('');
        for (let n = 0; n <= 400; n += 1) {
          const p = market.priceAt(stock.ticker, n);
          if (!Number.isSafeInteger(p) || p < MIN_PRICE) throw new Error(`seed ${seed} ${stock.ticker} tick ${n}: ${p}`);
        }
      }
    }
  }, LONG_TEST);

  it('LIV-10: no single tick moves a price by more than half the stock\'s candle limit', () => {
    for (const seed of SEEDS.slice(0, 20)) {
      const market = createTickMarket(seed);
      for (const stock of STOCKS) {
        for (let n = 1; n <= 500; n += 1) {
          const prev = market.priceAt(stock.ticker, n - 1);
          const cur = market.priceAt(stock.ticker, n);
          const move = Math.abs(cur - prev) / prev;
          // +1 cent of rounding slack, plus the floor price can lift a price
          if (!(move <= tickMaxMove(stock) + 1 / prev || cur === MIN_PRICE)) throw new Error(`seed ${seed} ${stock.ticker} tick ${n}: ${move}`);
        }
      }
    }
  }, LONG_TEST);

  it('LIV-11: each stock has its own stream: its prices do not depend on the other stocks', () => {
    const market = createTickMarket(31337);
    STOCKS.forEach((stock, i) => {
      expect(Array.from({ length: 200 }, (_, n) => market.priceAt(stock.ticker, n))).toEqual(sequentialSeries(31337, i, 199));
    });
  });

  it('LIV-12: startPriceOf, tickSigma and tickMaxMove follow the formulas', () => {
    const qlrx = stockByTicker('QLRX')!;
    expect(tickSigma(qlrx)).toBe(0.015 * 0.31622776601683794);
    expect(tickMaxMove(qlrx)).toBe(0.05);
    const s = deriveSeed(12345, 0);
    expect(startPriceOf(qlrx, s)).toBe(qlrx.startMin + Math.floor(uniformAt(s, 1) * (qlrx.startMax - qlrx.startMin + 1)));
  });

  it('LIV-13: no built-in direction: the average tick return is close to zero for every stock', () => {
    for (const stock of STOCKS) {
      let sum = 0;
      let n = 0;
      for (const seed of SEEDS) {
        const market = createTickMarket(seed);
        for (let t = 1; t <= 300; t += 1) {
          const prev = market.priceAt(stock.ticker, t - 1);
          sum += (market.priceAt(stock.ticker, t) - prev) / prev;
          n += 1;
        }
      }
      const mean = sum / n;
      expect(Math.abs(mean) < tickSigma(stock) / 5 ? '' : `${stock.ticker}: mean tick return ${mean}`).toBe('');
    }
  }, LONG_TEST);

  it('LIV-14: calmer stocks really move less per tick, in the order of their settings', () => {
    const spread = new Map<string, number>();
    for (const stock of STOCKS) {
      let sum = 0;
      let n = 0;
      for (const seed of SEEDS) {
        const market = createTickMarket(seed);
        for (let t = 1; t <= 300; t += 1) {
          const prev = market.priceAt(stock.ticker, t - 1);
          const r = (market.priceAt(stock.ticker, t) - prev) / prev;
          sum += r * r;
          n += 1;
        }
      }
      spread.set(stock.ticker, Math.sqrt(sum / n));
    }
    const byCalm = [...STOCKS].sort((a, b) => a.bodySigma - b.bodySigma);
    for (let i = 1; i < byCalm.length; i += 1) {
      const calmer = byCalm[i - 1]!;
      const wilder = byCalm[i]!;
      expect((spread.get(calmer.ticker) ?? 0) < (spread.get(wilder.ticker) ?? 0) ? '' : `${calmer.ticker} vs ${wilder.ticker}`).toBe('');
    }
  }, LONG_TEST);

  it('LIV-15: ten ticks move a price about as much as the old one-candle body (σ per candle)', () => {
    for (const stock of STOCKS) {
      let sum = 0;
      let n = 0;
      for (const seed of SEEDS) {
        const market = createTickMarket(seed);
        for (let c = 0; c < 20; c += 1) {
          const a = market.priceAt(stock.ticker, c * 10);
          const b = market.priceAt(stock.ticker, c * 10 + 10);
          const r = (b - a) / a;
          sum += r * r;
          n += 1;
        }
      }
      const ratio = Math.sqrt(sum / n) / stock.bodySigma;
      expect(ratio > 0.85 && ratio < 1.15 ? '' : `${stock.ticker}: ratio ${ratio}`).toBe('');
    }
  }, LONG_TEST);
});

describe('Scripted markets and argument checks', () => {
  it('LIV-16: a scripted market returns exactly the prices it was given', () => {
    const prices = Object.fromEntries(TICKERS.map((t, i) => [t, [1000 + i, 1010 + i, 990 + i]]));
    const market = createTickMarketFromPrices(1, prices);
    expect(market.priceAt('QLRX', 0)).toBe(1000);
    expect(market.priceAt('NVRA', 1)).toBe(1011);
    expect(market.priceAt('VRDW', 2)).toBe(999);
    expect(market.lastScriptedTick).toBe(2);
  });

  it('LIV-17: a scripted market refuses a tick it has no price for, and refuses bad scripts', () => {
    const prices = Object.fromEntries(TICKERS.map((t) => [t, [1000, 1000]]));
    const market = createTickMarketFromPrices(1, prices);
    expect(() => market.priceAt('QLRX', 2)).toThrow();
    expect(() => createTickMarketFromPrices(1, { QLRX: [1000] })).toThrow();
    expect(() => createTickMarketFromPrices(1, { ...prices, QLRX: [0, 1] })).toThrow();
    expect(() => createTickMarketFromPrices(1, { ...prices, QLRX: [1000.5] })).toThrow();
    expect(createTickMarket(1).lastScriptedTick).toBeNull();
  });

  it('LIV-18: unknown tickers and bad ticks are refused', () => {
    const market = createTickMarket(1);
    expect(() => market.priceAt('NOPE', 0)).toThrow();
    expect(() => market.priceAt('QLRX', -1)).toThrow();
    expect(() => market.priceAt('QLRX', 1.5)).toThrow();
    expect(() => market.priceAt('QLRX', 20_000_000)).toThrow();
  });
});
