// WLQ — bid/ask, depth and execution (docs/world.md §6).
import { describe, expect, it } from 'vitest';
import {
  BOOK_LEVELS,
  IMPACT_RECOVERY_TICKS,
  MAX_ORDER_SHARES,
  buildCatalog,
  executeMarket,
  ladder,
  levelStep,
  liquidityLabel,
  maxAffordable,
  quoteOf,
  recoverConsumed,
  totalDepth,
  touchShares,
  type Level,
} from '../src/world';
import { Mulberry32 } from '../src/engine/rng';

const LONG = 60_000;
const catalog = buildCatalog(66);
const wide = buildCatalog(500); // includes mega-caps (the hand-written companies have none)
const levelsOf = (...pairs: [number, number][]): Level[] => pairs.map(([price, size]) => ({ price, size }));

describe('Quotes and the order book', () => {
  it('WLQ-01: bid < mid < ask, the spread is symmetric around mid and at least 2 cents', () => {
    for (const c of catalog) {
      for (const mid of [100, 437, 2500, 9999, 120_000]) {
        const q = quoteOf(c, mid, 1);
        expect(q.bid).toBeLessThan(q.mid);
        expect(q.ask).toBeGreaterThan(q.mid);
        expect(q.ask - q.mid).toBe(q.half);
        expect(q.mid - q.bid).toBe(q.half);
        expect(q.half).toBeGreaterThanOrEqual(1);
        expect(Number.isInteger(q.bid) && Number.isInteger(q.ask)).toBe(true);
      }
    }
  });

  it('WLQ-02: the spread widens with volatility and is wider for less liquid companies', () => {
    const calm = quoteOf({ spreadBps: 30 }, 10_000, 0.5);
    const wild = quoteOf({ spreadBps: 30 }, 10_000, 2.5);
    expect(wild.half).toBeGreaterThan(calm.half);
    const liquid = wide.find((c) => c.tier === 'mega');
    const thin = wide.find((c) => c.tier === 'micro');
    expect(quoteOf(thin!, 5000, 1).spreadBps).toBeGreaterThan(quoteOf(liquid!, 5000, 1).spreadBps);
  });

  it('WLQ-03: asks rise and bids fall level by level, sizes never shrink, and there are at most 20 levels', () => {
    for (const c of catalog) {
      const q = quoteOf(c, c.basePriceCents, 1);
      const asks = ladder(c, q, 1, 'buy');
      const bids = ladder(c, q, 1, 'sell');
      expect(asks.length).toBeLessThanOrEqual(BOOK_LEVELS);
      expect(asks[0]?.price).toBe(q.ask);
      expect(bids[0]?.price).toBe(q.bid);
      for (let k = 1; k < asks.length; k += 1) {
        expect(asks[k]!.price).toBeGreaterThan(asks[k - 1]!.price);
        expect(asks[k]!.size).toBeGreaterThanOrEqual(asks[k - 1]!.size);
      }
      for (let k = 1; k < bids.length; k += 1) {
        expect(bids[k]!.price).toBeLessThan(bids[k - 1]!.price);
        expect(bids[k]!.price).toBeGreaterThanOrEqual(1);
      }
      expect(levelStep(c, q.mid)).toBeGreaterThanOrEqual(1);
    }
  });

  it('WLQ-04: depth scales with liquidity and trading volume, and thins out when the stock is volatile', () => {
    const mega = wide.find((c) => c.tier === 'mega')!;
    const micro = wide.find((c) => c.tier === 'micro')!;
    const depthUsd = (c: typeof mega) => touchShares(c, 1) * c.basePriceCents;
    expect(depthUsd(mega)).toBeGreaterThan(depthUsd(micro) * 50);
    expect(touchShares(mega, 3)).toBeLessThan(touchShares(mega, 0.5));
    expect(touchShares({ avgDailyVolume: 1, liquidity: 0.1 }, 1)).toBe(1);
  });

  it('WLQ-05: liquidity labels follow the rating', () => {
    expect(liquidityLabel(0.95)).toBe('Very high');
    expect(liquidityLabel(0.7)).toBe('High');
    expect(liquidityLabel(0.5)).toBe('Medium');
    expect(liquidityLabel(0.3)).toBe('Low');
    expect(liquidityLabel(0.1)).toBe('Very low');
  });
});

describe('Executing orders', () => {
  it('WLQ-06: a buy walks up the ladder and pays each level its own price (hand-worked)', () => {
    const asks = levelsOf([101, 10], [102, 20], [103, 30]);
    const e = executeMarket(asks, 'buy', 25, 0, { mid: 100 });
    expect(e.filledQty).toBe(25);
    expect(e.unfilledQty).toBe(0);
    expect(e.totalCents).toBe(101 * 10 + 102 * 15);
    expect(e.avgPrice).toBeCloseTo(2540 / 25, 12);
    expect(e.parts).toEqual([
      { price: 101, qty: 10 },
      { price: 102, qty: 15 },
    ]);
    expect(e.firstPrice).toBe(101);
    expect(e.lastPrice).toBe(102);
    expect(e.spreadCostCents).toBe(25 * 1);
    expect(e.impactCostCents).toBe(2540 - 25 * 101);
    expect(e.note).toBe('');
    expect(e.consumedAfter).toBe(25);
  });

  it('WLQ-07: a sell walks down the bids (hand-worked)', () => {
    const bids = levelsOf([99, 10], [98, 20]);
    const e = executeMarket(bids, 'sell', 15, 0, { mid: 100 });
    expect(e.totalCents).toBe(99 * 10 + 98 * 5);
    expect(e.spreadCostCents).toBe(15);
    expect(e.impactCostCents).toBe(15 * 99 - (99 * 10 + 98 * 5));
    expect(e.slippageBps).toBeGreaterThan(0);
  });

  it('WLQ-08: orders larger than the book are partially filled and say why', () => {
    const asks = levelsOf([101, 10], [102, 20], [103, 30]);
    const e = executeMarket(asks, 'buy', 100, 0, { mid: 100 });
    expect(e.filledQty).toBe(60);
    expect(e.unfilledQty).toBe(40);
    expect(e.note).toBe('depth');
    expect(e.totalCents).toBe(101 * 10 + 102 * 20 + 103 * 30);
  });

  it('WLQ-09: depth the player already used up is skipped first', () => {
    const asks = levelsOf([101, 10], [102, 20], [103, 30]);
    const e = executeMarket(asks, 'buy', 5, 12, { mid: 100 });
    expect(e.parts).toEqual([{ price: 102, qty: 5 }]);
    expect(e.totalCents).toBe(510);
    expect(e.consumedAfter).toBe(17);
    const all = executeMarket(asks, 'buy', 5, 60, { mid: 100 });
    expect(all.filledQty).toBe(0);
    expect(all.note).toBe('depth');
    expect(all.avgPrice).toBe(0);
  });

  it('WLQ-10: a limit price stops the walk', () => {
    const asks = levelsOf([101, 10], [102, 20], [103, 30]);
    const buy = executeMarket(asks, 'buy', 25, 0, { limitPrice: 101, mid: 100 });
    expect(buy.filledQty).toBe(10);
    expect(buy.note).toBe('limit');
    const none = executeMarket(asks, 'buy', 25, 0, { limitPrice: 100, mid: 100 });
    expect(none.filledQty).toBe(0);
    const bids = levelsOf([99, 10], [98, 20]);
    const sell = executeMarket(bids, 'sell', 25, 0, { limitPrice: 99, mid: 100 });
    expect(sell.filledQty).toBe(10);
    expect(sell.note).toBe('limit');
  });

  it('WLQ-11: bad quantities are rejected', () => {
    const asks = levelsOf([101, 10]);
    for (const q of [0, -1, 1.5, NaN, MAX_ORDER_SHARES + 1]) expect(() => executeMarket(asks, 'buy', q, 0)).toThrow();
  });

  it('WLQ-12: buy then immediately sell the same shares always loses at least the full spread', () => {
    const rng = new Mulberry32(2026);
    for (let n = 0; n < 400; n += 1) {
      const c = catalog[Math.floor(rng.next() * catalog.length)]!;
      const mid = Math.max(100, Math.round(c.basePriceCents * (0.6 + rng.next())));
      const act = 0.5 + rng.next() * 2;
      const q = quoteOf(c, mid, act);
      const asks = ladder(c, q, act, 'buy');
      const bids = ladder(c, q, act, 'sell');
      const qty = 1 + Math.floor(rng.next() * Math.min(totalDepth(asks), totalDepth(bids)));
      const buy = executeMarket(asks, 'buy', qty, 0, { mid });
      const sell = executeMarket(bids, 'sell', buy.filledQty, 0, { mid });
      if (buy.filledQty === 0) continue;
      expect(sell.filledQty).toBe(buy.filledQty);
      expect(buy.totalCents - sell.totalCents).toBeGreaterThanOrEqual(buy.filledQty * (q.ask - q.bid));
    }
  }, LONG);

  it('WLQ-13: price impact grows with size — average price paid never falls for bigger buys, never rises for bigger sells', () => {
    const rng = new Mulberry32(7);
    for (let n = 0; n < 200; n += 1) {
      const c = catalog[Math.floor(rng.next() * catalog.length)]!;
      const q = quoteOf(c, c.basePriceCents, 1);
      const asks = ladder(c, q, 1, 'buy');
      const bids = ladder(c, q, 1, 'sell');
      let lastBuy = 0;
      let lastSell = Infinity;
      for (let k = 1; k <= 12; k += 1) {
        const qty = Math.max(1, Math.floor((totalDepth(asks) * k) / 12));
        const b = executeMarket(asks, 'buy', qty, 0);
        const s = executeMarket(bids, 'sell', qty, 0);
        if (b.filledQty > 0) {
          expect(b.avgPrice).toBeGreaterThanOrEqual(lastBuy - 1e-9);
          lastBuy = b.avgPrice;
        }
        if (s.filledQty > 0) {
          expect(s.avgPrice).toBeLessThanOrEqual(lastSell + 1e-9);
          lastSell = s.avgPrice;
        }
      }
    }
  }, LONG);

  it('WLQ-14: a $1,000 order in a large company is filled at the best price; the same dollars in a thin micro-cap walks the book', () => {
    const large = catalog.find((c) => c.tier === 'large')!;
    const micro = catalog.filter((c) => c.tier === 'micro').sort((a, b) => a.liquidity - b.liquidity)[0]!;
    const fill = (c: typeof large, dollars: number) => {
      const q = quoteOf(c, c.basePriceCents, 1);
      const asks = ladder(c, q, 1, 'buy');
      const qty = Math.max(1, Math.floor((dollars * 100) / q.ask));
      return { e: executeMarket(asks, 'buy', qty, 0, { mid: q.mid }), q };
    };
    const small = fill(large, 1000);
    expect(small.e.parts.length).toBe(1);
    expect(small.e.impactCostCents).toBe(0);
    const big = fill(micro, 200_000);
    expect(big.e.parts.length).toBeGreaterThan(3);
    expect(big.e.slippageBps).toBeGreaterThan(small.e.slippageBps);
  });

  it('WLQ-15: a huge order in a thin stock cannot be filled completely', () => {
    const micro = catalog.filter((c) => c.tier === 'micro').sort((a, b) => a.liquidity - b.liquidity)[0]!;
    const q = quoteOf(micro, micro.basePriceCents, 1);
    const asks = ladder(micro, q, 1, 'buy');
    const e = executeMarket(asks, 'buy', micro.floatShares, 0, { mid: q.mid });
    expect(e.unfilledQty).toBeGreaterThan(0);
    expect(e.note).toBe('depth');
    expect(e.filledQty).toBe(totalDepth(asks));
  });

  it('WLQ-16: buying twice in a row costs more the second time (your own used-up depth), and it recovers with time', () => {
    const c = catalog.find((x) => x.tier === 'small')!;
    const q = quoteOf(c, c.basePriceCents, 1);
    const asks = ladder(c, q, 1, 'buy');
    const qty = Math.max(1, Math.floor(totalDepth(asks) / 4));
    const first = executeMarket(asks, 'buy', qty, 0, { mid: q.mid });
    const second = executeMarket(asks, 'buy', qty, first.consumedAfter, { mid: q.mid });
    expect(second.avgPrice).toBeGreaterThan(first.avgPrice);
    const later = executeMarket(asks, 'buy', qty, recoverConsumed(first.consumedAfter, IMPACT_RECOVERY_TICKS * 8), { mid: q.mid });
    expect(later.avgPrice).toBeLessThan(second.avgPrice);
    expect(later.avgPrice).toBeCloseTo(first.avgPrice, 0);
  });

  it('WLQ-17: the cost splits exactly into spread and impact', () => {
    const rng = new Mulberry32(99);
    for (let n = 0; n < 300; n += 1) {
      const c = catalog[Math.floor(rng.next() * catalog.length)]!;
      const mid = Math.max(100, c.basePriceCents);
      const q = quoteOf(c, mid, 1);
      for (const side of ['buy', 'sell'] as const) {
        const levels = ladder(c, q, 1, side);
        const qty = 1 + Math.floor(rng.next() * totalDepth(levels));
        const e = executeMarket(levels, side, qty, 0, { mid });
        const against = side === 'buy' ? e.totalCents - e.filledQty * mid : e.filledQty * mid - e.totalCents;
        expect(e.spreadCostCents + e.impactCostCents).toBe(against);
        expect(Number.isSafeInteger(e.totalCents)).toBe(true);
        let sum = 0;
        let qtySum = 0;
        for (const p of e.parts) {
          sum += p.price * p.qty;
          qtySum += p.qty;
        }
        expect(sum).toBe(e.totalCents);
        expect(qtySum).toBe(e.filledQty);
      }
    }
  }, LONG);
});

describe('Affordability and recovery', () => {
  it('WLQ-18: maxAffordable is the largest quantity whose cost fits the cash (checked against brute force)', () => {
    const rng = new Mulberry32(31337);
    for (let n = 0; n < 300; n += 1) {
      const c = catalog[Math.floor(rng.next() * catalog.length)]!;
      const q = quoteOf(c, c.basePriceCents, 1);
      const asks = ladder(c, q, 1, 'buy');
      const consumed = Math.floor(rng.next() * totalDepth(asks) * 0.3);
      const cash = Math.floor(rng.next() * 4_000_000);
      const best = maxAffordable(asks, consumed, cash);
      expect(best.costCents).toBeLessThanOrEqual(cash);
      if (best.qty > 0) {
        const e = executeMarket(asks, 'buy', best.qty, consumed);
        expect(e.totalCents).toBe(best.costCents);
        expect(e.filledQty).toBe(best.qty);
      }
      // One more share must not fit (or not exist).
      const more = executeMarket(asks, 'buy', best.qty + 1, consumed);
      if (more.filledQty === best.qty + 1) expect(more.totalCents).toBeGreaterThan(cash);
    }
  }, LONG);

  it('WLQ-19: with zero cash nothing is affordable; bad cash is rejected', () => {
    const asks = levelsOf([101, 10]);
    expect(maxAffordable(asks, 0, 0)).toEqual({ qty: 0, costCents: 0 });
    expect(maxAffordable(asks, 0, 100)).toEqual({ qty: 0, costCents: 0 });
    expect(maxAffordable(asks, 0, 101)).toEqual({ qty: 1, costCents: 101 });
    expect(() => maxAffordable(asks, 0, -1)).toThrow();
    expect(() => maxAffordable(asks, 0, 1.5)).toThrow();
  });

  it('WLQ-20: used-up depth recovers with a half-life of about 5 minutes and is gone after ~100 minutes', () => {
    expect(recoverConsumed(1000, 0)).toBe(1000);
    expect(recoverConsumed(1000, IMPACT_RECOVERY_TICKS)).toBeGreaterThan(495);
    expect(recoverConsumed(1000, IMPACT_RECOVERY_TICKS)).toBeLessThan(505);
    expect(recoverConsumed(1000, IMPACT_RECOVERY_TICKS * 2)).toBeGreaterThan(245);
    expect(recoverConsumed(1000, IMPACT_RECOVERY_TICKS * 2)).toBeLessThan(255);
    expect(recoverConsumed(1000, IMPACT_RECOVERY_TICKS * 25)).toBe(0);
    expect(recoverConsumed(0, 50)).toBe(0);
    expect(recoverConsumed(-5, 50)).toBe(0);
    let last = Infinity;
    for (let t = 0; t < 3000; t += 100) {
      const v = recoverConsumed(5000, t);
      expect(v).toBeLessThanOrEqual(last);
      last = v;
    }
  });
});
