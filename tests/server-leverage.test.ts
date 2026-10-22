// Leverage (docs/world.md §6.1): a buy can use 1× to 50×. The player pays only the margin (the value divided by the leverage) out of
// his cash; the rest is a debt on the position. Selling repays the debt out of the proceeds. When the shares are worth no more than the
// debt, the market closes the position at once (liquidation) and the margin is lost, never more. Checked here: the money maths to the
// cent, the refusals, the estimate, liquidation by the market (also for a crash that happened while the server was off), the owner's
// tools, 1v1 accounts, and the upgrade of an old database.
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../server/app';
import { Auth } from '../server/auth';
import { loadConfig } from '../server/config';
import { MAX_LEVERAGE, OPEN_COST_LIMIT, debtShare, isLeverage, isLiquidated, liquidationPrice, marginOf, maxLeverageFor } from '../server/leverage';
import { Liquidator, type LiquidationWorld } from '../server/liquidation';
import { Logger } from '../server/log';
import { MIGRATIONS, migrate } from '../server/schema';
import { Db } from '../server/sqlite';
import { OrderError, Trading, type OrderRequest } from '../server/trading';
import { Clock, makeRig, type Rig } from './helpers/server';

const LONG = 240_000;

// ---- the pure rules -----------------------------------------------------------------------------------------------------------

describe('Leverage: the rules', () => {
  it('LEV-1: only whole numbers from 1 to 50 are a leverage', () => {
    expect(MAX_LEVERAGE).toBe(50);
    for (const ok of [1, 2, 10, 49, 50]) expect(isLeverage(ok)).toBe(true);
    for (const bad of [0, -1, 51, 100, 1.5, 2.0000001, Number.NaN, Number.POSITIVE_INFINITY, '10', null, undefined]) expect(isLeverage(bad)).toBe(false);
  });

  it('LEV-2: the margin is the value divided by the leverage, rounded UP to a whole cent, so the debt never exceeds value − margin', () => {
    expect(marginOf(10_000, 1)).toBe(10_000);
    expect(marginOf(10_000, 10)).toBe(1_000);
    expect(marginOf(10_001, 10)).toBe(1_001);
    expect(marginOf(10_000, 50)).toBe(200);
    expect(marginOf(1, 50)).toBe(1);
    expect(marginOf(3_480, 7)).toBe(498); // 497.14… up
    // Exact for very large values (BigInt, no floating point).
    expect(marginOf(Number.MAX_SAFE_INTEGER, 50)).toBe(Math.ceil(Number.MAX_SAFE_INTEGER / 50));
    for (const total of [1, 7, 99, 1234, 99_999, 4_321_987]) {
      for (let l = 1; l <= 50; l += 1) {
        const margin = marginOf(total, l);
        expect(margin).toBeGreaterThanOrEqual(total / l);
        expect(margin).toBeLessThan(total / l + 1);
        expect(margin).toBeLessThanOrEqual(total);
      }
    }
  });

  it('LEV-3: a position is wiped out when its shares are worth no more than its debt', () => {
    expect(isLiquidated(100, 10, 1_000)).toBe(true); // exactly equal
    expect(isLiquidated(101, 10, 1_000)).toBe(false);
    expect(isLiquidated(99, 10, 1_000)).toBe(true);
    expect(isLiquidated(1, 10, 0)).toBe(false); // no debt: never
    expect(isLiquidated(0, 10, 5)).toBe(true);
    expect(liquidationPrice(10, 1_000)).toBe(100);
    expect(liquidationPrice(10, 1_009)).toBe(100); // 100.9 → the highest whole-cent price at which it is wiped out
    expect(liquidationPrice(10, 0)).toBe(0);
    for (const price of [99, 100]) expect(isLiquidated(price, 10, 1_009)).toBe(true);
    expect(isLiquidated(101, 10, 1_009)).toBe(false);
  });

  it('LEV-4: selling part of a position repays that part of the debt (rounded down), and all of it when all shares go', () => {
    expect(debtShare(900, 10, 30)).toBe(300);
    expect(debtShare(1_000, 10, 30)).toBe(333);
    expect(debtShare(1_000, 30, 30)).toBe(1_000);
    expect(debtShare(1_000, 31, 30)).toBe(1_000);
    expect(debtShare(0, 10, 30)).toBe(0);
    let left = 1_000;
    let held = 30;
    for (const sold of [7, 11, 12]) {
      left -= debtShare(left, sold, held);
      held -= sold;
    }
    expect(held).toBe(0);
    expect(left).toBe(0);
  });

  it('LEV-5: the highest leverage for an order shrinks as the cost of opening it grows, and is never below 1', () => {
    const mid = 1_000;
    // No opening cost: any leverage.
    expect(maxLeverageFor(100 * mid, 100, mid, null)).toBe(50);
    // The opening cost may use at most half the margin. 1 000 on 101 000: margin at 50× is 2 020 ≥ 2 000 → still 50×.
    expect(OPEN_COST_LIMIT).toBe(0.5);
    expect(maxLeverageFor(101_000, 100, mid, null)).toBe(50);
    // 2 000 on 102 000: the margin must be at least 4 000, which is 25× (4 080) but not 26× (3 924).
    expect(maxLeverageFor(102_000, 100, mid, null)).toBe(25);
    let last = 50;
    for (const cost of [0, 500, 1_000, 2_000, 5_000, 10_000, 40_000, 90_000]) {
      const max = maxLeverageFor(100_000 + cost, 100, mid, null);
      expect(max).toBeLessThanOrEqual(last);
      expect(max).toBeGreaterThanOrEqual(1);
      last = max;
    }
    expect(maxLeverageFor(300_000, 100, mid, null)).toBe(1);
    // A position that is already deep in debt cannot take more at a leverage that would wipe the combined position out at once.
    expect(maxLeverageFor(10_000, 10, mid, { shares: 100, debtCents: 105_000 })).toBe(1);
  });
});

// ---- orders, with a real database and market ----------------------------------------------------------------------------------

const rigs: Rig[] = [];
afterEach(() => {
  while (rigs.length > 0) rigs.pop()?.cleanup();
});

async function setup(count = 12) {
  const rig = makeRig();
  rigs.push(rig);
  const { db, world } = rig.open({ companyCount: count });
  const auth = new Auth(db, rig.clock.now, '');
  const trading = new Trading(db, world, rig.clock.now);
  const { user } = await auth.register('alice', 'correct horse', '127.0.0.1');
  const account = trading.careerAccountOf(user.id);
  let n = 0;
  const order = (partial: Partial<OrderRequest> & Pick<OrderRequest, 'side' | 'qty'>): OrderRequest => ({
    accountId: account.id,
    clientOrderId: `order-${String(++n).padStart(6, '0')}`,
    companyId: 0,
    ...partial,
  });
  const rejects = (fn: () => unknown): OrderError => {
    try {
      fn();
    } catch (e) {
      if (e instanceof OrderError) return e;
      throw e;
    }
    throw new Error('expected the order to be rejected');
  };
  const position = (companyId = 0) => db.get<{ shares: number; cost_cents: number; debt_cents: number }>('SELECT shares, cost_cents, debt_cents FROM positions WHERE account_id = ? AND company_id = ?', account.id, companyId);
  const cash = (): number => (db.get<{ cash_cents: number }>('SELECT cash_cents FROM accounts WHERE id = ?', account.id) as { cash_cents: number }).cash_cents;
  return { rig, db, world, auth, trading, user, account, order, rejects, position, cash };
}

describe('Leverage: buying and selling', () => {
  it('LEV-6: a leveraged buy takes only the margin from cash and puts the rest on the position as debt', async () => {
    const { trading, account, order, position, cash, db } = await setup();
    const out = trading.placeOrder(order({ side: 'buy', qty: 20, leverage: 10 }));
    const total = out.trade.totalCents;
    const margin = marginOf(total, 10);
    expect(cash()).toBe(100_000 - margin);
    expect(position()).toEqual({ shares: 20, cost_cents: margin, debt_cents: total - margin });
    expect(out.trade.leverage).toBe(10);
    expect(out.trade.debtCents).toBe(total - margin);
    const row = db.get<{ leverage: number; debt_cents: number; forced: number }>('SELECT leverage, debt_cents, forced FROM trades WHERE account_id = ?', account.id);
    expect(row).toEqual({ leverage: 10, debt_cents: total - margin, forced: 0 });

    const v = trading.view(account.id);
    const p = v.positions[0];
    expect(p).toMatchObject({ shares: 20, costCents: margin, debtCents: total - margin, leverage: Math.round((total / margin) * 10) / 10 });
    expect(p?.avgCostCents).toBe(Math.round(total / 20)); // what a share cost in all
    expect(p?.liqPrice).toBe(Math.floor((total - margin) / 20));
    // What counts is the value minus the debt: the player is down only by what the spread cost him.
    expect(p?.equityCents).toBe((p?.valueCents as number) - (total - margin));
    expect(v.netWorthCents).toBe(cash() + (p?.equityCents as number));
    expect(v.profitCents).toBe((p?.valueCents as number) - total);
    expect(p?.unrealizedCents).toBe((p?.equityCents as number) - margin);
  }, LONG);

  it('LEV-7: 1× is an ordinary buy: no debt, nothing different from before leverage existed', async () => {
    const { trading, order, position, cash } = await setup();
    const out = trading.placeOrder(order({ side: 'buy', qty: 5, leverage: 1 }));
    expect(cash()).toBe(100_000 - out.trade.totalCents);
    expect(position()).toEqual({ shares: 5, cost_cents: out.trade.totalCents, debt_cents: 0 });
    const plain = trading.placeOrder(order({ side: 'buy', qty: 5 }));
    expect(plain.trade.leverage).toBe(1);
    expect(plain.trade.debtCents).toBe(0);
  }, LONG);

  it('LEV-8: selling everything repays the debt out of the proceeds; the player keeps the rest; realized profit is what he got minus what he put in', async () => {
    const { trading, order, position, cash } = await setup();
    const buy = trading.placeOrder(order({ side: 'buy', qty: 20, leverage: 10 }));
    const margin = marginOf(buy.trade.totalCents, 10);
    const debt = buy.trade.totalCents - margin;
    const cashBefore = cash();
    const sell = trading.placeOrder(order({ side: 'sell', qty: 20 }));
    expect(position()).toBeUndefined();
    expect(cash()).toBe(cashBefore + sell.trade.totalCents - debt);
    expect(sell.trade.realizedCents).toBe(sell.trade.totalCents - debt - margin);
    expect(sell.trade.debtCents).toBe(debt);
    // The whole round trip cost the spread and nothing else (there is no interest and no fee).
    expect(cash()).toBe(100_000 - buy.trade.totalCents + sell.trade.totalCents);
  }, LONG);

  it('LEV-9: selling part of a position repays that part of the debt; the rest keeps its debt; the cents always add up', async () => {
    const { trading, order, position, cash } = await setup();
    const buy = trading.placeOrder(order({ side: 'buy', qty: 30, leverage: 5 }));
    const margin = marginOf(buy.trade.totalCents, 5);
    const debt0 = buy.trade.totalCents - margin;
    let proceeds = 0;
    let repaid = 0;
    let realized = 0;
    for (const qty of [10, 7]) {
      const before = position() as { shares: number; cost_cents: number; debt_cents: number };
      const s = trading.placeOrder(order({ side: 'sell', qty }));
      const part = debtShare(before.debt_cents, qty, before.shares);
      expect(s.trade.debtCents).toBe(part);
      const after = position() as { shares: number; cost_cents: number; debt_cents: number };
      expect(after.shares).toBe(before.shares - qty);
      expect(after.debt_cents).toBe(before.debt_cents - part);
      proceeds += s.trade.totalCents;
      repaid += part;
      realized += s.trade.realizedCents;
    }
    const last = trading.placeOrder(order({ side: 'sell', qty: 13 }));
    proceeds += last.trade.totalCents;
    repaid += last.trade.debtCents;
    realized += last.trade.realizedCents;
    expect(position()).toBeUndefined();
    expect(repaid).toBe(debt0); // every cent of debt was repaid exactly once
    expect(cash()).toBe(100_000 - margin + proceeds - repaid);
    expect(realized).toBe(proceeds - repaid - margin);
  }, LONG);

  it('LEV-10: a second buy adds its margin and its debt to the position; the liquidation price follows the combined position', async () => {
    const { trading, order, position, account } = await setup();
    const a = trading.placeOrder(order({ side: 'buy', qty: 10, leverage: 20 }));
    const b = trading.placeOrder(order({ side: 'buy', qty: 10, leverage: 2 }));
    const ma = marginOf(a.trade.totalCents, 20);
    const mb = marginOf(b.trade.totalCents, 2);
    const p = position();
    expect(p).toEqual({ shares: 20, cost_cents: ma + mb, debt_cents: a.trade.totalCents - ma + (b.trade.totalCents - mb) });
    const view = trading.view(account.id).positions[0];
    expect(view?.liqPrice).toBe(Math.floor((p?.debt_cents as number) / 20));
  }, LONG);

  it('LEV-11: the cash must cover the MARGIN (not the whole value); at 50× $1,000 buys up to $50,000 of shares; one more share is refused with the count that works', async () => {
    const { trading, order, rejects, cash, position, account } = await setup();
    // At 1× this cash buys far fewer shares than at 50×.
    const plainMax = trading.estimate(account.id, 0, 'buy', 1, undefined, 1).maxQty;
    const levMax = trading.estimate(account.id, 0, 'buy', 1, undefined, 50).maxQty;
    expect(levMax).toBeGreaterThan(plainMax * 40);
    const err = rejects(() => trading.placeOrder(order({ side: 'buy', qty: levMax + 5, leverage: 50 })));
    expect(err.code).toBe('insufficient_cash');
    expect(err.message).toMatch(/50x/);
    expect(err.details.maxQty).toBe(levMax);
    expect(cash()).toBe(100_000); // nothing happened
    expect(position()).toBeUndefined();
    const ok = trading.placeOrder(order({ side: 'buy', qty: levMax, leverage: 50 }));
    expect(ok.trade.filled).toBe(levMax);
    expect(cash()).toBeLessThanOrEqual(100);
    expect(cash()).toBeGreaterThanOrEqual(0);
    expect(position()?.debt_cents).toBe(ok.trade.totalCents - marginOf(ok.trade.totalCents, 50));
  }, LONG);

  it('LEV-12: a leverage that is not a whole number from 1 to 50 is refused and changes nothing; on a sell the leverage field is ignored', async () => {
    const { trading, order, rejects, cash, account } = await setup();
    for (const bad of [0, -2, 51, 1000, 2.5, Number.NaN]) {
      expect(rejects(() => trading.placeOrder(order({ side: 'buy', qty: 1, leverage: bad }))).code).toBe('bad_request');
      expect(() => trading.estimate(account.id, 0, 'buy', 1, undefined, bad)).toThrow(/leverage/i);
    }
    expect(cash()).toBe(100_000);
    trading.placeOrder(order({ side: 'buy', qty: 4 }));
    const sold = trading.placeOrder(order({ side: 'sell', qty: 4, leverage: 40 }));
    expect(sold.trade.leverage).toBe(1);
    expect(sold.trade.debtCents).toBe(0);
  }, LONG);

  it('LEV-13: an order whose opening cost (thin book) would eat more than half its margin is refused for that leverage, with the highest one that works; the refusal changes nothing', async () => {
    const { trading, order, rejects, db, account, world, position } = await setup();
    // Plenty of cash, so that the margin is never the problem.
    db.run('UPDATE accounts SET cash_cents = 50000000000 WHERE id = ?', account.id);
    let found: { companyId: number; qty: number; max: number } | null = null;
    for (let c = 0; c < world.companies.length && !found; c += 1) {
      if (!world.sim.isListed(c)) continue;
      for (const qty of [3_000, 10_000, 30_000]) {
        let e;
        try {
          e = trading.estimate(account.id, c, 'buy', qty, undefined, 1);
        } catch {
          continue;
        }
        if (e.maxLeverage >= 2 && e.maxLeverage <= 49) {
          found = { companyId: c, qty, max: e.maxLeverage };
          break;
        }
      }
    }
    expect(found).not.toBeNull();
    const { companyId, qty, max } = found as { companyId: number; qty: number; max: number };
    const cashBefore = (db.get<{ cash_cents: number }>('SELECT cash_cents FROM accounts WHERE id = ?', account.id) as { cash_cents: number }).cash_cents;
    const err = rejects(() => trading.placeOrder(order({ side: 'buy', qty, companyId, leverage: max + 1 })));
    expect(err.code).toBe('leverage_too_high');
    expect(err.details.maxLeverage).toBe(max);
    expect(err.details.leverage).toBe(max + 1);
    expect(err.message).toContain(`${max}x`);
    expect(position(companyId)).toBeUndefined();
    expect((db.get<{ cash_cents: number }>('SELECT cash_cents FROM accounts WHERE id = ?', account.id) as { cash_cents: number }).cash_cents).toBe(cashBefore);
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM trades WHERE account_id = ?', account.id)?.n).toBe(0);
    // The leverage the server named works, and the same order at 1× is never refused for this reason.
    expect(trading.placeOrder(order({ side: 'buy', qty, companyId, leverage: max })).trade.leverage).toBe(max);
    expect(trading.placeOrder(order({ side: 'buy', qty: 5, companyId })).trade.leverage).toBe(1);
  }, LONG);

  it('LEV-14: the estimate shows the margin, the debt, the liquidation price and the highest allowed leverage; for a sell it shows the debt repaid and what is kept', async () => {
    const { trading, account, order } = await setup();
    const e = trading.estimate(account.id, 0, 'buy', 20, undefined, 8);
    expect(e.leverage).toBe(8);
    expect(e.netCents).toBe(marginOf(e.totalCents, 8));
    expect(e.debtCents).toBe(e.totalCents - e.netCents);
    expect(e.liqPrice).toBe(Math.floor(e.debtCents / 20));
    expect(e.liqPrice).toBeLessThan(e.mid);
    expect(e.maxLeverage).toBeGreaterThanOrEqual(8);
    // Without leverage: net = total, no debt, nothing to be wiped out.
    const plain = trading.estimate(account.id, 0, 'buy', 20);
    expect(plain).toMatchObject({ leverage: 1, netCents: plain.totalCents, debtCents: 0, liqPrice: 0 });
    // The estimate never changes anything.
    expect(trading.view(account.id).cashCents).toBe(100_000);

    trading.placeOrder(order({ side: 'buy', qty: 20, leverage: 8 }));
    const sell = trading.estimate(account.id, 0, 'sell', 20);
    const held = trading.view(account.id).positions[0];
    expect(sell.debtCents).toBe(held?.debtCents);
    expect(sell.netCents).toBe(Math.max(0, sell.totalCents - sell.debtCents));
    const half = trading.estimate(account.id, 0, 'sell', 10);
    expect(half.debtCents).toBe(debtShare(held?.debtCents as number, 10, 20));
  }, LONG);

  it('LEV-15: a duplicate order id is not applied twice, with leverage as without', async () => {
    const { trading, order, position, cash } = await setup();
    const req = order({ side: 'buy', qty: 10, leverage: 10 });
    const first = trading.placeOrder(req);
    const again = trading.placeOrder(req);
    expect(first.duplicate).toBe(false);
    expect(again.duplicate).toBe(true);
    expect(again.trade.leverage).toBe(10);
    expect(position()?.shares).toBe(10);
    expect(cash()).toBe(100_000 - marginOf(first.trade.totalCents, 10));
  }, LONG);

  it('LEV-16: a 1v1 match account can use leverage too; it is valued at the mid price minus the debt', async () => {
    const { trading, user, world, rig } = await setup();
    const acc = trading.createMatchAccount(user.id, 1, 100_000);
    const out = trading.placeOrder({ accountId: acc.id, clientOrderId: 'match-order-000001', companyId: 0, side: 'buy', qty: 30, leverage: 25 });
    const margin = marginOf(out.trade.totalCents, 25);
    const v = trading.view(acc.id);
    expect(v.valuation).toBe('mid');
    expect(v.cashCents).toBe(100_000 - margin);
    const mid = world.sim.price(0);
    expect(v.positions[0]?.valueCents).toBe(mid * 30);
    expect(v.positions[0]?.equityCents).toBe(mid * 30 - (out.trade.totalCents - margin));
    expect(v.netWorthCents).toBe(v.cashCents + (v.positions[0]?.equityCents as number));
    void rig;
  }, LONG);
});

// ---- liquidation by the market ------------------------------------------------------------------------------------------------

describe('Leverage: liquidation', () => {
  /** A market whose prices the test controls; everything else comes from the real one. */
  function control(world: { companies: LiquidationWorld['companies']; msOfTick(t: number): number; sim: { price(i: number): number } }, prices: Map<number, number>): LiquidationWorld {
    return { sim: { price: (i: number) => prices.get(i) ?? world.sim.price(i), isListed: () => true }, companies: world.companies, msOfTick: (t: number) => world.msOfTick(t) };
  }

  it('LEV-17: the position is closed at the tick where shares × price ≤ debt: the margin is lost, nothing else; the trade list says why', async () => {
    const { trading, db, world, order, account, position, cash } = await setup();
    const prices = new Map<number, number>();
    const log = new Logger({ sink: null });
    const liq = new Liquidator({ db, world: control(world, prices), log });
    trading.setLeverageListener(() => liq.markDirty());
    const buy = trading.placeOrder(order({ side: 'buy', qty: 40, leverage: 20 }));
    const margin = marginOf(buy.trade.totalCents, 20);
    const debt = buy.trade.totalCents - margin;
    const level = Math.floor(debt / 40);
    const cashAfterBuy = cash();

    // Above the line: nothing happens, however many ticks pass.
    prices.set(0, level + 1);
    for (let t = 1000; t < 1010; t += 1) liq.step(t);
    expect(position()?.shares).toBe(40);
    expect(liq.closed).toBe(0);

    // At the line (shares × price = debt, or just under it): closed.
    prices.set(0, level);
    liq.step(1010);
    expect(position()).toBeUndefined();
    expect(liq.closed).toBe(1);
    expect(cash()).toBe(cashAfterBuy); // no cash comes back
    const v = trading.view(account.id);
    expect(v.positions).toEqual([]);
    expect(v.netWorthCents).toBe(cashAfterBuy);
    expect(v.profitCents).toBe(cashAfterBuy - 100_000); // exactly the margin is gone
    expect(v.realizedCents).toBe(-margin);

    const last = trading.trades(account.id, 5)[0];
    expect(last).toMatchObject({ side: 'sell', ticker: world.companies[0]?.ticker, filled: 40, liquidated: true, debtCents: debt, realizedCents: -margin, tick: 1010 });
    expect(last?.createdMs).toBe(world.msOfTick(1010));
    // It happens once.
    liq.step(1011);
    expect(liq.closed).toBe(1);
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM trades WHERE forced = 1')?.n).toBe(1);
  }, LONG);

  it('LEV-18: only the positions that are wiped out go: the same stock at lower leverage stays, other stocks stay, and every other account stays', async () => {
    const { trading, db, world, auth } = await setup();
    const bob = await auth.register('bob', 'correct horse', '127.0.0.2');
    const carol = await auth.register('carol', 'correct horse', '127.0.0.3');
    const accB = trading.careerAccountOf(bob.user.id);
    const accC = trading.careerAccountOf(carol.user.id);
    const prices = new Map<number, number>();
    const liq = new Liquidator({ db, world: control(world, prices), log: new Logger({ sink: null }) });
    trading.setLeverageListener(() => liq.markDirty());
    const mk = (accountId: number, companyId: number, leverage: number, n: number) =>
      trading.placeOrder({ accountId, clientOrderId: `o-${accountId}-${companyId}-${leverage}-${n}`.padEnd(14, 'x'), companyId, side: 'buy', qty: 10, leverage });
    const high = mk(accB.id, 0, 40, 1); // bob: 40× in company 0
    mk(accC.id, 0, 4, 2); // carol: 4× in company 0
    mk(accB.id, 1, 40, 3); // bob: 40× in company 1
    const highLevel = Math.floor((high.trade.totalCents - marginOf(high.trade.totalCents, 40)) / 10);
    prices.set(0, highLevel); // only 40× in company 0 is wiped out
    prices.set(1, 100_000_000); // company 1 is far above anything
    liq.step(500);
    const left = db.all<{ account_id: number; company_id: number }>('SELECT account_id, company_id FROM positions ORDER BY account_id, company_id');
    expect(left).toEqual([
      { account_id: accB.id, company_id: 1 },
      { account_id: accC.id, company_id: 0 },
    ]);
    expect(liq.closed).toBe(1);
  }, LONG);

  it('LEV-19: a position bought after the liquidator last looked is noticed (the trade tells it), and a position that is sold is forgotten', async () => {
    const { trading, db, world, order, position } = await setup();
    const prices = new Map<number, number>([[0, 100_000]]);
    const liq = new Liquidator({ db, world: control(world, prices), log: new Logger({ sink: null }) });
    trading.setLeverageListener(() => liq.markDirty());
    liq.step(10); // an empty table
    const buy = trading.placeOrder(order({ side: 'buy', qty: 25, leverage: 30 }));
    const level = Math.floor((buy.trade.totalCents - marginOf(buy.trade.totalCents, 30)) / 25);
    prices.set(0, level);
    liq.step(11);
    expect(position()).toBeUndefined();

    // Sold by the player before the price falls: nothing left to close.
    trading.placeOrder(order({ side: 'buy', qty: 25, leverage: 30 }));
    trading.placeOrder(order({ side: 'sell', qty: 25 }));
    prices.set(0, 1);
    liq.step(12);
    expect(liq.closed).toBe(1);
  }, LONG);

  it('LEV-20: when the program starts, the table is built from the database: a position from an earlier run is watched too', async () => {
    const { trading, db, world, order, position } = await setup();
    const buy = trading.placeOrder(order({ side: 'buy', qty: 25, leverage: 30 }));
    const level = Math.floor((buy.trade.totalCents - marginOf(buy.trade.totalCents, 30)) / 25);
    const prices = new Map<number, number>([[0, level]]);
    const liq = new Liquidator({ db, world: control(world, prices), log: new Logger({ sink: null }) }); // never told about the trade
    liq.step(77);
    expect(position()).toBeUndefined();
  }, LONG);

  it('LEV-21: a stock that is not listed (no price) is left alone; the position is closed once it trades again', async () => {
    const { trading, db, world, order, position } = await setup();
    const buy = trading.placeOrder(order({ side: 'buy', qty: 25, leverage: 30 }));
    const level = Math.floor((buy.trade.totalCents - marginOf(buy.trade.totalCents, 30)) / 25);
    const prices = new Map<number, number>([[0, level]]);
    const unlisted: LiquidationWorld = { ...control(world, prices), sim: { price: (i: number) => prices.get(i) ?? 0, isListed: () => false } };
    const liq = new Liquidator({ db, world: unlisted, log: new Logger({ sink: null }) });
    liq.step(5);
    expect(position()?.shares).toBe(25);
    const live = new Liquidator({ db, world: control(world, prices), log: new Logger({ sink: null }) });
    live.step(6);
    expect(position()).toBeUndefined();
  }, LONG);

  it('LEV-22: 1v1: a position is only closed while its match is live and up to the last tick; after that it is left exactly as it was', async () => {
    const { trading, db, world, user } = await setup();
    const startTick = 1_000;
    const endTick = startTick + 180;
    db.run(
      "INSERT INTO matches(id, state, created_ms, start_tick, end_tick, duration_ticks, start_cash_cents) VALUES (1, 'live', 0, ?, ?, 180, 100000)",
      startTick,
      endTick,
    );
    const acc = trading.createMatchAccount(user.id, 1, 100_000);
    const buy = trading.placeOrder({ accountId: acc.id, clientOrderId: 'match-order-000001', companyId: 0, side: 'buy', qty: 25, leverage: 30 });
    const level = Math.floor((buy.trade.totalCents - marginOf(buy.trade.totalCents, 30)) / 25);
    const prices = new Map<number, number>([[0, level]]);
    const liq = new Liquidator({ db, world: control(world, prices), log: new Logger({ sink: null }) });
    liq.step(endTick + 1); // after the last tick: left alone, however far the price fell
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM positions WHERE account_id = ?', acc.id)?.n).toBe(1);
    liq.step(endTick); // at the last tick it counts (the score would be zero for it anyway)
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM positions WHERE account_id = ?', acc.id)?.n).toBe(0);

    // A finished match is never touched.
    db.run("INSERT INTO matches(id, state, created_ms, start_tick, end_tick, duration_ticks, start_cash_cents, outcome, settled_ms) VALUES (2, 'finished', 0, ?, ?, 180, 100000, 'tie', 1)", startTick, endTick);
    const done = trading.createMatchAccount(user.id, 2, 100_000);
    db.run('INSERT INTO positions(account_id, company_id, shares, cost_cents, debt_cents) VALUES (?, 0, 10, 100, 100000)', done.id);
    prices.set(0, 1);
    const again = new Liquidator({ db, world: control(world, prices), log: new Logger({ sink: null }) });
    again.step(endTick - 5);
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM positions WHERE account_id = ?', done.id)?.n).toBe(1);
  }, LONG);

  it('LEV-23: the owner taking shares from a leveraged position takes the matching part of the debt with them', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const boss = await signUp(r, 'boss');
    advance(r, 60);
    const co = await cheapLarge(r);
    const bought = await trade(r, alice, { ticker: co.ticker, qty: 40, leverage: 10 });
    expect(bought.status).toBe(201);
    const pos = (await account(r, alice)).positions[0];
    const taken = await post(r, '/api/admin/shares', boss, { username: 'alice', ticker: co.ticker, qty: -10 });
    expect(taken.status).toBe(200);
    const after = (await account(r, alice)).positions[0];
    expect(after.shares).toBe(30);
    expect(after.debtCents).toBe(pos.debtCents - debtShare(pos.debtCents, 10, 40));
    // Taking the rest removes the position and its debt together.
    expect((await post(r, '/api/admin/shares', boss, { username: 'alice', ticker: co.ticker, qty: -30 })).status).toBe(200);
    expect((await account(r, alice)).positions).toEqual([]);
    expect(r.app.services.db.all('SELECT * FROM positions WHERE debt_cents > 0')).toEqual([]);
  }, LONG);
});

// ---- the whole program: orders over the web API, a real crash, a restart -----------------------------------------------------

interface Running {
  app: App;
  server: Server;
  base: string;
  dir: string;
  clock: Clock;
}
const running: Running[] = [];
const dirs: string[] = [];
afterEach(async () => {
  while (running.length > 0) await stop(running.pop() as Running);
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

async function stop(r: Running): Promise<void> {
  await new Promise<void>((done) => {
    r.server.closeAllConnections?.();
    r.server.close(() => done());
  });
  try {
    r.app.close();
  } catch {
    // already closed by the test
  }
}

async function boot(options: { dir?: string; clock?: Clock } = {}): Promise<Running> {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'tq-lev-'));
  if (!options.dir) dirs.push(dir);
  const clock = options.clock ?? new Clock();
  const config = loadConfig({ TQ_DATA_DIR: dir, TQ_COMPANIES: '66', TQ_WARMUP_DAYS: '1', TQ_PORT: '8787', TQ_OWNER: 'boss' });
  // No automatic pauses: a crash of this size would pause trading, and this test is about what happens to the positions.
  const app = createApp({ config, log: new Logger({ sink: null, now: clock.now }), worldSeed: 777, now: clock.now, flowGain: 0, autoPauses: false });
  const server = createServer(app.handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const r = { app, server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, dir, clock };
  running.push(r);
  return r;
}

function advance(r: Running, seconds: number): void {
  r.clock.advanceSeconds(seconds);
  const w = r.app.services.world;
  for (let i = 0; i < 400_000 && w.sim.tick < w.currentTick(); i += 1) w.pump();
  expect(w.sim.tick).toBe(w.currentTick());
}

async function call(r: Running, path: string, init: { method?: string; body?: unknown; cookie?: string } = {}) {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  if (init.cookie) headers.Cookie = init.cookie;
  const res = await fetch(r.base + path, { method: init.method ?? 'GET', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

async function signUp(r: Running, name: string): Promise<string> {
  const res = await fetch(r.base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: name, password: 'a-good-password' }) });
  expect(res.status).toBe(201);
  return (res.headers.get('set-cookie') ?? '').split(';')[0] as string;
}

let counter = 0;
const rid = (): string => `req-${(counter += 1).toString().padStart(8, '0')}`;
const post = (r: Running, path: string, cookie: string | undefined, body: Record<string, unknown>) => call(r, path, { method: 'POST', cookie, body: { requestId: rid(), ...body } });
let orderNo = 0;
const trade = (r: Running, cookie: string, body: Record<string, unknown> = {}) =>
  call(r, '/api/orders', { method: 'POST', cookie, body: { account: 'career', ticker: 'ZRLX', side: 'buy', qty: 10, clientOrderId: `order-${(orderNo += 1)}-abcdef`, ...body } });
const account = async (r: Running, cookie: string) => (await call(r, '/api/account?account=career', { cookie })).json;
const tradesOf = async (r: Running, cookie: string) => (await call(r, '/api/account/trades?account=career&limit=20', { cookie })).json.trades as any[];
const market = async (r: Running) => (await call(r, '/api/market')).json.companies as any[];
const cheapLarge = async (r: Running) => (await market(r)).filter((c) => c.trading && c.tier === 'large').sort((a, b) => a.price - b.price)[0];
/** A number of shares that costs about $800, so that a Career account ($1,000) can buy them without leverage too. */
const sharesFor = (co: { price: number }): number => Math.max(1, Math.floor(80_000 / co.price));

describe('Leverage: over the web API, with a real crash', () => {
  it('LEV-24: the order and estimate routes take a leverage; a bad one is a 400 with a clear message; the account shows debt, equity and the liquidation price', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    advance(r, 30);
    const co = await cheapLarge(r);
    const est = await call(r, `/api/market/${co.ticker}/estimate?side=buy&qty=20&account=career&leverage=10`, { cookie: alice });
    expect(est.status).toBe(200);
    expect(est.json).toMatchObject({ leverage: 10, filledQty: 20 });
    expect(est.json.netCents).toBe(Math.ceil(est.json.totalCents / 10));
    expect(est.json.debtCents).toBe(est.json.totalCents - est.json.netCents);
    expect(est.json.maxLeverage).toBeGreaterThanOrEqual(10);
    for (const bad of ['0', '51', 'x', '2.5']) {
      const res = await call(r, `/api/market/${co.ticker}/estimate?side=buy&qty=20&account=career&leverage=${bad}`, { cookie: alice });
      expect(res.status).toBe(400);
    }
    expect((await trade(r, alice, { ticker: co.ticker, qty: 5, leverage: 100 })).status).toBe(400);
    expect((await trade(r, alice, { ticker: co.ticker, qty: 5, leverage: 'ten' })).status).toBe(400);
    expect((await account(r, alice)).positions).toEqual([]);

    const bought = await trade(r, alice, { ticker: co.ticker, qty: 20, leverage: 10 });
    expect(bought.status).toBe(201);
    expect(bought.json.trade).toMatchObject({ leverage: 10, filled: 20 });
    const acc = await account(r, alice);
    const p = acc.positions[0];
    expect(p).toMatchObject({ ticker: co.ticker, shares: 20, debtCents: bought.json.trade.debtCents });
    expect(typeof p.leverage).toBe('number');
    expect(p.liqPrice).toBe(Math.floor(p.debtCents / 20));
    expect(p.equityCents).toBe(p.valueCents - p.debtCents);
    expect(acc.cashCents).toBe(100_000 - Math.ceil(bought.json.trade.totalCents / 10));
    expect(acc.netWorthCents).toBe(acc.cashCents + p.equityCents);
    const list = await tradesOf(r, alice);
    expect(list[0]).toMatchObject({ side: 'buy', leverage: 10, liquidated: false });
  }, LONG);

  it('LEV-25: a crash wipes the position out: the margin is lost, the rest of the account is untouched, and the trade list says Liquidated', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const bob = await signUp(r, 'bob');
    const boss = await signUp(r, 'boss');
    advance(r, 60);
    const co = await cheapLarge(r);
    // Alice at 20× (wiped out by about −5 %), Bob at 1× in the same stock (he only loses what the price loses).
    const n = sharesFor(co);
    const a = await trade(r, alice, { ticker: co.ticker, qty: n, leverage: 20 });
    const b = await trade(r, bob, { ticker: co.ticker, qty: n });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const aliceCash = (await account(r, alice)).cashCents;
    const margin = Math.ceil(a.json.trade.totalCents / 20);
    expect(aliceCash).toBe(100_000 - margin);
    expect((await post(r, '/api/admin/shock', boss, { ticker: co.ticker, percent: -60, style: 'crash', speed: 'fast' })).status).toBe(200);
    advance(r, 120);
    const acc = await account(r, alice);
    expect(acc.positions).toEqual([]);
    expect(acc.cashCents).toBe(aliceCash);
    expect(acc.netWorthCents).toBe(aliceCash);
    expect(acc.profitCents).toBe(-margin);
    const last = (await tradesOf(r, alice))[0];
    expect(last).toMatchObject({ side: 'sell', liquidated: true, filled: n, realizedCents: -margin });
    // Bob keeps his shares.
    expect((await account(r, bob)).positions[0]?.shares).toBe(n);
    expect(r.app.services.liquidator.closed).toBe(1);
    // The market is alive and health is fine.
    expect(r.app.services.world.health().ok).toBe(true);
  }, LONG);

  it('LEV-26: a crash that happens while the server is off still wipes the position out when it starts again, at the tick it happened', async () => {
    let r = await boot();
    const alice = await signUp(r, 'alice');
    const boss = await signUp(r, 'boss');
    advance(r, 60);
    const co = await cheapLarge(r);
    const a = await trade(r, alice, { ticker: co.ticker, qty: sharesFor(co), leverage: 25 });
    expect(a.status).toBe(201);
    const margin = Math.ceil(a.json.trade.totalCents / 25);
    expect((await post(r, '/api/admin/shock', boss, { ticker: co.ticker, percent: -60, style: 'crash', speed: 'fast' })).status).toBe(200);
    const stoppedAt = r.app.services.world.sim.tick;
    const clock = r.clock;
    const dir = r.dir;
    await stop(r);
    running.splice(running.indexOf(r), 1);
    // The server is off for ten minutes; the crash happens (and the price comes back a little) in that time.
    clock.advanceSeconds(600);
    r = await boot({ dir, clock });
    const w = r.app.services.world;
    expect(w.sim.tick).toBe(w.currentTick());
    const acc = await account(r, alice);
    expect(acc.positions).toEqual([]);
    expect(acc.profitCents).toBe(-margin);
    const last = (await tradesOf(r, alice))[0];
    expect(last.liquidated).toBe(true);
    // It was closed at a tick during the downtime, not at the moment the server started again.
    expect(last.tick).toBeGreaterThan(stoppedAt);
    expect(last.tick).toBeLessThan(w.sim.tick - 60);
    expect(last.createdMs).toBe(w.msOfTick(last.tick));
    expect(last.createdMs).toBeLessThan(clock.now());
  }, LONG);
});

// ---- the database --------------------------------------------------------------------------------------------------------------

describe('Leverage: the database', () => {
  it('LEV-27: schema 11 adds the debt and leverage columns; old rows get "no leverage, no debt"', () => {
    const db = new Db(':memory:');
    // The database as it was before leverage (schema 10) with a player, a position and a trade in it.
    for (const m of MIGRATIONS) {
      if (m.version > 10) break;
      db.exec(m.sql);
      db.exec(`PRAGMA user_version = ${m.version}`);
    }
    db.exec("INSERT INTO users(username, display_name, pw_hash, role, created_ms) VALUES ('old', 'old', 'x', 'player', 1)");
    db.exec("INSERT INTO accounts(user_id, kind, cash_cents, start_cash_cents, created_ms) VALUES (1, 'career', 90000, 100000, 1)");
    db.exec('INSERT INTO positions(account_id, company_id, shares, cost_cents) VALUES (1, 0, 5, 10000)');
    db.exec("INSERT INTO trades(account_id, client_order_id, company_id, side, requested, filled, total_cents, mid_cents, spread_cents, impact_cents, realized_cents, tick, created_ms, result_json) VALUES (1, 'old-order-0001', 0, 'buy', 5, 5, 10000, 2000, 0, 0, 0, 1, 1, '{}')");
    expect(migrate(db).filter((v) => v <= 15)).toEqual([11, 12, 13, 14, 15]); // (later versions follow in the same go) 12 (memecoins, shorts, stops), 13 (the memecoin fee), 14 (launches) and 15 (1v1 bots) are applied on top of 11 in the same go
    expect(db.get('SELECT shares, cost_cents, debt_cents FROM positions')).toEqual({ shares: 5, cost_cents: 10_000, debt_cents: 0 });
    expect(db.get('SELECT leverage, debt_cents, forced FROM trades')).toEqual({ leverage: 1, debt_cents: 0, forced: 0 });
    // The database refuses a leverage outside 1–50 and a negative debt.
    expect(() => db.exec("UPDATE trades SET leverage = 51")).toThrow();
    expect(() => db.exec("UPDATE trades SET leverage = 0")).toThrow();
    expect(() => db.exec('UPDATE positions SET debt_cents = -1')).toThrow();
    db.close();
  });
});

