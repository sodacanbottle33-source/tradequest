// ACC-01 … ACC-12 and PNL-01 … PNL-11 — test-cases.md §7–8, plus the worked example (rules.md §7.7).
import { describe, expect, it } from 'vitest';
import {
  advance,
  applyBuy,
  applySell,
  averageEntry,
  equity,
  formatCents,
  formatPercent,
  getView,
  initialAccount,
  MIN_PRICE,
  Mulberry32,
  positionValue,
  START_CASH,
  submitOrder,
  unrealizedPnl,
  type Account,
} from '../src/engine';
import { makeRound } from './helpers/rounds';

const buy = (a: Account, q: number, p: number) => applyBuy(a, q, p).account;

describe('Cash, shares and cost basis (§7.2–7.3)', () => {
  const a1 = buy(initialAccount(), 10, 2500);
  const a2 = buy(a1, 5, 2600);
  const sell3 = applySell(a2, 4, 2650);
  const sell4 = applySell(sell3.account, 11, 2400);

  it('ACC-01: BUY 10 @ 2500', () => {
    expect(a1).toEqual({ cash: 75000, shares: 10, costBasis: 25000, realizedPnl: 0 });
  });

  it('ACC-02: then BUY 5 @ 2600', () => {
    expect(a2).toEqual({ cash: 62000, shares: 15, costBasis: 38000, realizedPnl: 0 });
  });

  it('ACC-03: then SELL 4 @ 2650', () => {
    expect(sell3.proceeds).toBe(10600);
    expect(sell3.removedBasis).toBe(10133);
    expect(sell3.tradePnl).toBe(467);
    expect(sell3.account).toEqual({ cash: 72600, shares: 11, costBasis: 27867, realizedPnl: 467 });
  });

  it('ACC-04: then SELL 11 @ 2400', () => {
    expect(sell4.removedBasis).toBe(27867);
    expect(sell4.tradePnl).toBe(-1467);
    expect(sell4.account).toEqual({ cash: 99000, shares: 0, costBasis: 0, realizedPnl: -1000 });
  });

  it('ACC-05 / ACC-06: half-cent case rounds up first, leaving no leftover cents', () => {
    const start: Account = { cash: 0, shares: 2, costBasis: 1001, realizedPnl: 0 };
    const first = applySell(start, 1, 500);
    expect(first.removedBasis).toBe(501);
    expect(first.account.costBasis).toBe(500);
    const second = applySell(first.account, 1, 500);
    expect(second.removedBasis).toBe(500);
    expect(second.account.costBasis).toBe(0);
  });

  it('ACC-07: a full close always zeroes the cost basis exactly', () => {
    const rng = new Mulberry32(77);
    for (let i = 0; i < 5000; i += 1) {
      const shares = 1 + Math.floor(rng.next() * 5000);
      const costBasis = Math.floor(rng.next() * 50_000_000);
      const r = applySell({ cash: 0, shares, costBasis, realizedPnl: 0 }, shares, 1 + Math.floor(rng.next() * 9000));
      expect(r.removedBasis).toBe(costBasis);
      expect(r.account.costBasis).toBe(0);
    }
  });

  it('ACC-08: buy then sell at the same price → P&L 0, cash back to start', () => {
    const r = applySell(buy(initialAccount(), 7, 3123), 7, 3123);
    expect(r.tradePnl).toBe(0);
    expect(r.account.cash).toBe(START_CASH);
  });

  it('ACC-09: selling at a loss gives negative P&L', () => {
    const r = applySell(buy(initialAccount(), 10, 3000), 10, 2900);
    expect(r.tradePnl).toBe(-1000);
    expect(r.account.realizedPnl).toBe(-1000);
  });

  it('ACC-10: buy 7 @ 3333, sell 1 seven times → removed bases sum to 23331', () => {
    let a = buy(initialAccount(), 7, 3333);
    let removed = 0;
    for (let i = 0; i < 7; i += 1) {
      const r = applySell(a, 1, 3333);
      removed += r.removedBasis;
      a = r.account;
    }
    expect(removed).toBe(23331);
    expect(a.costBasis).toBe(0);
  });

  it('ACC-11: trade records have the right fields (worked example through a round)', () => {
    const s = advance(submitOrder(makeRound(2500), 'BUY', '10'));
    expect(s.trades[0]).toEqual({
      id: 1,
      type: 'player',
      side: 'BUY',
      candleIndex: 11,
      quantity: 10,
      price: 2500,
      amount: 25000,
      tradePnl: null,
      cashAfter: 75000,
      sharesAfter: 10,
    });
    const s2 = advance(submitOrder(s, 'SELL', '4'));
    expect(s2.trades[1]).toEqual({
      id: 2,
      type: 'player',
      side: 'SELL',
      candleIndex: 12,
      quantity: 4,
      price: 2500,
      amount: 10000,
      tradePnl: 0,
      cashAfter: 85000,
      sharesAfter: 6,
    });
  });

  it('ACC-12: after spending all cash, BUY 1 is rejected and cash stays 0', () => {
    const s = advance(submitOrder(makeRound(2500), 'BUY', '40'));
    const after = submitOrder(s, 'BUY', '1');
    expect(after.pending).toBeNull();
    expect(after.account.cash).toBe(0);
  });

  it('applyBuy/applySell refuse invalid fills', () => {
    expect(() => applyBuy(initialAccount(), 41, 2500)).toThrow();
    expect(() => applySell(initialAccount(), 1, 2500)).toThrow();
    expect(() => applyBuy(initialAccount(), 1.5, 2500)).toThrow();
  });
});

describe('P&L, average entry and equity (§7.4)', () => {
  it('PNL-01: no position → unrealized 0, no average entry, equity = cash', () => {
    const a = initialAccount();
    expect(unrealizedPnl(a, 2500)).toBe(0);
    expect(averageEntry(a)).toBeNull();
    expect(equity(a, 2500)).toBe(a.cash);
  });

  it('PNL-02: 15 shares, basis 38000, mark 2700', () => {
    const a: Account = { cash: 62000, shares: 15, costBasis: 38000, realizedPnl: 0 };
    expect(unrealizedPnl(a, 2700)).toBe(2500);
    expect(positionValue(a, 2700)).toBe(40500);
  });

  it('PNL-03 / PNL-04: average entry display', () => {
    expect(averageEntry({ cash: 0, shares: 15, costBasis: 38000, realizedPnl: 0 })).toBe(2533);
    expect(formatCents(2533)).toBe('$25.33');
    expect(averageEntry({ cash: 0, shares: 11, costBasis: 27867, realizedPnl: 0 })).toBe(2533);
  });

  it('PNL-05: average entry is never used in calculations', () => {
    // Same account values, so every derived value is identical regardless of how the average would round.
    const a: Account = { cash: 62000, shares: 15, costBasis: 38000, realizedPnl: 0 };
    const avg = averageEntry(a)!;
    expect(avg * a.shares).not.toBe(a.costBasis); // rounding would have changed the basis…
    expect(unrealizedPnl(a, 2700)).toBe(15 * 2700 - 38000); // …but the calculation uses costBasis
    expect(applySell(a, 4, 2650).removedBasis).toBe(10133);
  });

  it('PNL-06: equity at start is 100000 and return is 0.00%', () => {
    const v = getView(makeRound(2500));
    expect(v.account.equity).toBe(100000);
    expect(v.account.totalReturn).toBe(0);
    expect(formatPercent(v.account.totalReturn, START_CASH)).toBe('0.00%');
  });

  it('PNL-07 + worked example (rules.md §7.7) through a real round', () => {
    let s = makeRound(2500, {
      11: { open: 2500, close: 2500 },
      12: { open: 2600, close: 2700 },
      13: { open: 2650, close: 2650 },
      14: { open: 2400, close: 2400 },
    });
    s = advance(submitOrder(s, 'BUY', '10')); // k = 11
    expect(s.account).toEqual({ cash: 75000, shares: 10, costBasis: 25000, realizedPnl: 0 });
    s = advance(submitOrder(s, 'BUY', '5')); // k = 12
    let v = getView(s);
    expect(v.account.averageEntry).toBe(2533);
    expect(v.account.unrealizedPnl).toBe(2500);
    expect(v.account.equity).toBe(102500);
    s = advance(submitOrder(s, 'SELL', '4')); // k = 13
    v = getView(s);
    expect(s.account).toEqual({ cash: 72600, shares: 11, costBasis: 27867, realizedPnl: 467 });
    expect(v.account.unrealizedPnl).toBe(1283);
    expect(v.account.equity).toBe(101750);
    expect(v.account.equity).toBe(START_CASH + s.account.realizedPnl + v.account.unrealizedPnl);
    s = advance(submitOrder(s, 'SELL', '11')); // k = 14
    expect(s.account).toEqual({ cash: 99000, shares: 0, costBasis: 0, realizedPnl: -1000 });
    expect(s.trades[3]!.tradePnl).toBe(-1467);
    expect(getView(s).account.equity).toBe(99000);
  });

  it('PNL-10: with no trade, unrealized P&L changes only through the mark price', () => {
    let s = advance(submitOrder(makeRound(2500, { 12: { close: 2550 } }), 'BUY', '10'));
    const before = getView(s).account;
    s = advance(s);
    const after = getView(s).account;
    expect(after.cash).toBe(before.cash);
    expect(after.costBasis).toBe(before.costBasis);
    expect(after.unrealizedPnl - before.unrealizedPnl).toBe(10 * (2550 - 2500));
  });

  it('PNL-11: values stay valid integers ≥ 0 at the MIN_PRICE floor', () => {
    const s = advance(advance(submitOrder(makeRound(MIN_PRICE), 'BUY', '1000')));
    const v = getView(s);
    expect(v.account.cash).toBe(0);
    for (const x of [v.account.positionValue, v.account.equity, v.account.costBasis, v.markPrice]) {
      expect(Number.isSafeInteger(x) && x >= 0).toBe(true);
    }
  });
});
