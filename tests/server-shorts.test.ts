// Short selling and stop-loss / take-profit (docs/world.md §6.2, §6.3). A short sells shares the player does not own: the money from the
// sale is held on the position (the "credit") next to a margin of his own cash (the sale value divided by the leverage, 1× to 50×);
// buying the shares back ("covering") returns what is left of that collateral. When the price rises until buying back would cost the
// whole collateral, the market closes the short by itself and the margin is lost, never more. A stop-loss / take-profit is a price at
// which the market closes the whole position by itself, as an ordinary market order. Checked here: the pure rules, the money maths to
// the cent, the refusals, the estimates, the liquidation of shorts, stops and takes (also across a restart), 1v1 accounts, the
// owner's tools and the web API.
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../server/app';
import { Auth } from '../server/auth';
import { loadConfig } from '../server/config';
import { collateralOf, debtShare, equityOf, isShortLiquidated, marginOf, maxShortLeverageFor, shortLiquidationPrice } from '../server/leverage';
import { Liquidator, type LiquidationWorld, type PositionClosed } from '../server/liquidation';
import { Logger } from '../server/log';
import { OrderError, Trading, type OrderRequest } from '../server/trading';
import { Clock, makeRig, type Rig } from './helpers/server';

const LONG = 240_000;

// ---- the pure rules -----------------------------------------------------------------------------------------------------------

describe('Short selling: the rules', () => {
  it('SHORT-1: collateral = credit + margin; a short is wiped out when buying back costs the whole collateral; the liquidation price rounds UP', () => {
    expect(collateralOf(1_000, 200)).toBe(1_200);
    expect(isShortLiquidated(100, 10, 1_000)).toBe(true); // exactly equal
    expect(isShortLiquidated(99, 10, 1_000)).toBe(false);
    expect(isShortLiquidated(101, 10, 1_000)).toBe(true);
    expect(isShortLiquidated(1_000_000, 0, 1_000)).toBe(false); // nothing owed
    expect(isShortLiquidated(1_000_000, 10, 0)).toBe(false); // no collateral: not a position
    expect(shortLiquidationPrice(10, 1_000)).toBe(100);
    expect(shortLiquidationPrice(10, 1_001)).toBe(101); // 100.1 → the lowest whole-cent price at which it is wiped out
    expect(shortLiquidationPrice(0, 1_000)).toBe(0);
    expect(isShortLiquidated(100, 10, 1_001)).toBe(false);
    expect(isShortLiquidated(101, 10, 1_001)).toBe(true);
    // Exact for very large numbers (BigInt).
    expect(shortLiquidationPrice(3, Number.MAX_SAFE_INTEGER)).toBe(Math.ceil(Number.MAX_SAFE_INTEGER / 3));
  });

  it('SHORT-2: equity is what is left, never below nothing: a long\'s shares minus its debt, a short\'s collateral minus the cost of buying back', () => {
    const long = { shares: 10, costCents: 200, debtCents: 800, short: false, creditCents: 0 };
    expect(equityOf(long, 150)).toBe(700);
    expect(equityOf(long, 80)).toBe(0);
    expect(equityOf(long, 10)).toBe(0);
    const short = { shares: 10, costCents: 200, debtCents: 0, short: true, creditCents: 1_000 };
    expect(equityOf(short, 100)).toBe(200); // price unchanged: the margin
    expect(equityOf(short, 80)).toBe(400); // price down 20: +200
    expect(equityOf(short, 119)).toBe(10);
    expect(equityOf(short, 120)).toBe(0);
    expect(equityOf(short, 500)).toBe(0);
  });

  it('SHORT-3: the highest leverage of a short shrinks as the cost of opening it grows, and is never below 1', () => {
    const mid = 1_000;
    expect(maxShortLeverageFor(100 * mid, 100, mid, null)).toBe(50);
    // 2 000 below the market value: the margin must be at least 4 000; 24× gives 4 084, 25× only 3 920.
    expect(maxShortLeverageFor(98_000, 100, mid, null)).toBe(24);
    let last = 50;
    for (const cost of [0, 500, 1_000, 2_000, 5_000, 10_000, 40_000]) {
      const max = maxShortLeverageFor(100_000 - cost, 100, mid, null);
      expect(max).toBeLessThanOrEqual(last);
      expect(max).toBeGreaterThanOrEqual(1);
      last = max;
    }
    // A short that is already deep under water cannot take more.
    expect(maxShortLeverageFor(10_000, 10, mid, { shares: 100, collateralCents: 90_000 })).toBe(1);
  });
});

// ---- orders, with a real database and market ----------------------------------------------------------------------------------

const rigs: Rig[] = [];
afterEach(() => {
  while (rigs.length > 0) rigs.pop()?.cleanup();
});

interface PosRow {
  shares: number;
  cost_cents: number;
  debt_cents: number;
  short: number;
  credit_cents: number;
  stop_cents: number;
  take_cents: number;
}

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
  const position = (companyId = 0) =>
    db.get<PosRow>('SELECT shares, cost_cents, debt_cents, short, credit_cents, stop_cents, take_cents FROM positions WHERE account_id = ? AND company_id = ?', account.id, companyId);
  const cash = (): number => (db.get<{ cash_cents: number }>('SELECT cash_cents FROM accounts WHERE id = ?', account.id) as { cash_cents: number }).cash_cents;
  return { rig, db, world, auth, trading, user, account, order, rejects, position, cash };
}

describe('Short selling: opening and covering', () => {
  it('SHORT-4: a 1× short holds the sale money and the same amount of his own cash; the account page shows a short at the ask', async () => {
    const { trading, account, order, position, cash } = await setup();
    const out = trading.placeOrder(order({ side: 'sell', short: true, qty: 20 }));
    const total = out.trade.totalCents;
    expect(cash()).toBe(100_000 - total);
    expect(position()).toEqual({ shares: 20, cost_cents: total, debt_cents: 0, short: 1, credit_cents: total, stop_cents: 0, take_cents: 0 });
    expect(out.trade).toMatchObject({ side: 'sell', short: true, leverage: 1, realizedCents: 0, auto: '', liquidated: false, filled: 20 });

    const v = trading.view(account.id);
    const p = v.positions[0];
    expect(p).toMatchObject({ short: true, shares: 20, creditCents: total, costCents: total, debtCents: 0, stopCents: 0, takeCents: 0, leverage: 1 });
    expect(p?.markCents).toBe(p?.ask); // what it costs to buy the shares back
    expect(p?.valueCents).toBe((p?.ask as number) * 20);
    expect(p?.equityCents).toBe(2 * total - (p?.valueCents as number));
    expect(p?.liqPrice).toBe(Math.ceil((2 * total) / 20)); // the price doubles
    expect(p?.avgCostCents).toBe(Math.round(total / 20)); // what it was sold for
    expect(p?.unrealizedCents).toBe((p?.equityCents as number) - total);
    expect(v.netWorthCents).toBe(cash() + (p?.equityCents as number));
    // The player is down only by the spread: sold at the bid, valued at the ask.
    expect(v.profitCents).toBe(total - (p?.valueCents as number));
    expect(v.profitCents).toBeLessThanOrEqual(0);
  }, LONG);

  it('SHORT-5: a leveraged short puts up only the margin; covering returns the collateral minus the cost; the round trip costs the spread and nothing else', async () => {
    const { trading, order, position, cash } = await setup();
    const open = trading.placeOrder(order({ side: 'sell', short: true, qty: 20, leverage: 10 }));
    const credit = open.trade.totalCents;
    const margin = marginOf(credit, 10);
    expect(cash()).toBe(100_000 - margin);
    expect(position()).toMatchObject({ shares: 20, cost_cents: margin, credit_cents: credit, short: 1 });
    expect(open.trade.leverage).toBe(10);

    const cashBefore = cash();
    const cover = trading.placeOrder(order({ side: 'buy', short: true, qty: 20 }));
    const back = Math.max(0, credit + margin - cover.trade.totalCents);
    expect(cash()).toBe(cashBefore + back);
    expect(cover.trade).toMatchObject({ side: 'buy', short: true, realizedCents: back - margin, filled: 20 });
    expect(position()).toBeUndefined();
    // Sold at the bid, bought back at the ask: the whole difference is the spread.
    expect(cash()).toBe(100_000 + credit - cover.trade.totalCents);
    expect(cover.trade.realizedCents).toBe(credit - cover.trade.totalCents);
  }, LONG);

  it('SHORT-6: covering part of a short gives back the matching part of the collateral; the rest keeps its share; every cent is accounted for', async () => {
    const { trading, order, position, cash } = await setup();
    const open = trading.placeOrder(order({ side: 'sell', short: true, qty: 30, leverage: 5 }));
    const margin = marginOf(open.trade.totalCents, 5);
    let realized = 0;
    for (const qty of [10, 7, 13]) {
      const before = position() as PosRow;
      const cashBefore = cash();
      const c = trading.placeOrder(order({ side: 'buy', short: true, qty }));
      const costPart = debtShare(before.cost_cents, qty, before.shares);
      const creditPart = debtShare(before.credit_cents, qty, before.shares);
      const back = Math.max(0, creditPart + costPart - c.trade.totalCents);
      expect(cash()).toBe(cashBefore + back);
      expect(c.trade.realizedCents).toBe(back - costPart);
      realized += c.trade.realizedCents;
      const after = position();
      if (before.shares - qty === 0) expect(after).toBeUndefined();
      else expect(after).toMatchObject({ shares: before.shares - qty, cost_cents: before.cost_cents - costPart, credit_cents: before.credit_cents - creditPart, short: 1 });
    }
    expect(position()).toBeUndefined();
    expect(cash() - 100_000).toBe(realized); // everything the account gained or lost is in the realized figures
    expect(margin).toBeGreaterThan(0);
  }, LONG);

  it('SHORT-7: a second short sale adds its credit and margin to the position; the liquidation price follows the combined position', async () => {
    const { trading, order, position, account } = await setup();
    const a = trading.placeOrder(order({ side: 'sell', short: true, qty: 10, leverage: 20 }));
    const b = trading.placeOrder(order({ side: 'sell', short: true, qty: 10, leverage: 2 }));
    const ma = marginOf(a.trade.totalCents, 20);
    const mb = marginOf(b.trade.totalCents, 2);
    const p = position() as PosRow;
    expect(p).toMatchObject({ shares: 20, cost_cents: ma + mb, credit_cents: a.trade.totalCents + b.trade.totalCents, short: 1 });
    expect(trading.view(account.id).positions[0]?.liqPrice).toBe(shortLiquidationPrice(20, p.credit_cents + p.cost_cents));
  }, LONG);

  it('SHORT-8: a player is long or short in a company, never both; every wrong-side order is refused with a sentence that says what to do, and changes nothing', async () => {
    const { trading, order, rejects, position, cash, account } = await setup();
    trading.placeOrder(order({ side: 'buy', qty: 5 }));
    const cashLong = cash();
    const e1 = rejects(() => trading.placeOrder(order({ side: 'sell', short: true, qty: 5 })));
    expect(e1.code).toBe('position_conflict');
    expect(e1.message).toMatch(/Sell them before you short/);
    expect(rejects(() => trading.placeOrder(order({ side: 'buy', short: true, qty: 5 }))).code).toBe('insufficient_shares'); // nothing short to cover
    expect(() => trading.estimate(account.id, 0, 'sell', 5, undefined, 1, true)).toThrow(/Sell them before you short/);
    expect(position()).toMatchObject({ shares: 5, short: 0 });
    expect(cash()).toBe(cashLong);
    trading.placeOrder(order({ side: 'sell', qty: 5 }));

    trading.placeOrder(order({ side: 'sell', short: true, qty: 6 }));
    const cashShort = cash();
    const e2 = rejects(() => trading.placeOrder(order({ side: 'buy', qty: 1 })));
    expect(e2.code).toBe('position_conflict');
    expect(e2.message).toMatch(/Cover/);
    const e3 = rejects(() => trading.placeOrder(order({ side: 'sell', qty: 1 })));
    expect(e3.code).toBe('insufficient_shares');
    expect(e3.message).toMatch(/Cover/);
    const e4 = rejects(() => trading.placeOrder(order({ side: 'buy', short: true, qty: 7 })));
    expect(e4.code).toBe('insufficient_shares');
    expect(e4.details.held).toBe(6);
    expect(rejects(() => trading.placeOrder(order({ side: 'buy', short: 'yes' as unknown as boolean, qty: 1 }))).code).toBe('bad_request');
    expect(() => trading.estimate(account.id, 0, 'buy', 1)).toThrow(/Cover/);
    expect(position()).toMatchObject({ shares: 6, short: 1 });
    expect(cash()).toBe(cashShort);
  }, LONG);

  it('SHORT-9: the margin must be covered by cash; at 50× $1,000 shorts up to $50,000 of shares; one more share is refused with the count that works', async () => {
    const { trading, order, rejects, cash, position, account } = await setup();
    const plainMax = trading.estimate(account.id, 0, 'sell', 1, undefined, 1, true).maxQty;
    const levMax = trading.estimate(account.id, 0, 'sell', 1, undefined, 50, true).maxQty;
    expect(plainMax).toBeGreaterThan(0);
    expect(levMax).toBeGreaterThan(plainMax * 20);
    const err = rejects(() => trading.placeOrder(order({ side: 'sell', short: true, qty: levMax + 5, leverage: 50 })));
    expect(err.code).toBe('insufficient_cash');
    expect(err.message).toMatch(/50x/);
    expect(err.details.maxQty).toBe(levMax);
    expect(cash()).toBe(100_000);
    expect(position()).toBeUndefined();
    const ok = trading.placeOrder(order({ side: 'sell', short: true, qty: levMax, leverage: 50 }));
    expect(ok.trade.filled).toBe(levMax);
    expect(cash()).toBeLessThanOrEqual(1_000);
    expect(cash()).toBeGreaterThanOrEqual(0);
  }, LONG);

  it('SHORT-10: a short whose opening cost (thin book) would eat more than half its margin is refused for that leverage, with the highest one that works', async () => {
    const { trading, order, rejects, db, account, world, position } = await setup();
    db.run('UPDATE accounts SET cash_cents = 50000000000 WHERE id = ?', account.id);
    let found: { companyId: number; qty: number; max: number } | null = null;
    for (let c = 0; c < world.companies.length && !found; c += 1) {
      if (!world.sim.isListed(c)) continue;
      for (const qty of [3_000, 10_000, 30_000]) {
        let e;
        try {
          e = trading.estimate(account.id, c, 'sell', qty, undefined, 1, true);
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
    const err = rejects(() => trading.placeOrder(order({ side: 'sell', short: true, qty, companyId, leverage: max + 1 })));
    expect(err.code).toBe('leverage_too_high');
    expect(err.details.maxLeverage).toBe(max);
    expect(err.message).toContain(`${max}x`);
    expect(position(companyId)).toBeUndefined();
    expect((db.get<{ cash_cents: number }>('SELECT cash_cents FROM accounts WHERE id = ?', account.id) as { cash_cents: number }).cash_cents).toBe(cashBefore);
    expect(trading.placeOrder(order({ side: 'sell', short: true, qty, companyId, leverage: max })).trade.leverage).toBe(max);
  }, LONG);

  it('SHORT-11: the estimate shows the margin, the money held, the liquidation price and the highest leverage; for a cover it shows what comes back; it never changes anything', async () => {
    const { trading, account, order } = await setup();
    const e = trading.estimate(account.id, 0, 'sell', 20, undefined, 8, true);
    expect(e).toMatchObject({ short: true, leverage: 8, creditCents: e.totalCents, netCents: marginOf(e.totalCents, 8), debtCents: 0 });
    expect(e.liqPrice).toBe(shortLiquidationPrice(20, e.totalCents + e.netCents));
    expect(e.liqPrice).toBeGreaterThan(e.mid);
    expect(e.maxLeverage).toBeGreaterThanOrEqual(8);
    expect(trading.view(account.id).cashCents).toBe(100_000);

    trading.placeOrder(order({ side: 'sell', short: true, qty: 20, leverage: 8 }));
    const held = trading.view(account.id).positions[0];
    const cover = trading.estimate(account.id, 0, 'buy', 20, undefined, 1, true);
    expect(cover.maxQty).toBe(20);
    expect(cover.netCents).toBe(Math.max(0, (held?.creditCents as number) + (held?.costCents as number) - cover.totalCents));
    const half = trading.estimate(account.id, 0, 'buy', 10, undefined, 1, true);
    expect(half.netCents).toBe(Math.max(0, debtShare((held?.creditCents as number) + (held?.costCents as number), 10, 20) - half.totalCents));
    // A short flag on the other side is a different order: selling more short.
    expect(trading.estimate(account.id, 0, 'sell', 5, undefined, 1, true).short).toBe(true);
  }, LONG);

  it('SHORT-12: a duplicate order id is not applied twice for a short either', async () => {
    const { trading, order, position, cash } = await setup();
    const req = order({ side: 'sell', short: true, qty: 10, leverage: 10 });
    const first = trading.placeOrder(req);
    const again = trading.placeOrder(req);
    expect(first.duplicate).toBe(false);
    expect(again.duplicate).toBe(true);
    expect(again.trade.short).toBe(true);
    expect(position()?.shares).toBe(10);
    expect(cash()).toBe(100_000 - marginOf(first.trade.totalCents, 10));
  }, LONG);

  it('SHORT-13: a 1v1 match account can short too; it is valued at the mid price: collateral minus the cost of buying back', async () => {
    const { trading, user, world } = await setup();
    const acc = trading.createMatchAccount(user.id, 1, 100_000);
    const out = trading.placeOrder({ accountId: acc.id, clientOrderId: 'match-order-000001', companyId: 0, side: 'sell', short: true, qty: 30, leverage: 25 });
    const margin = marginOf(out.trade.totalCents, 25);
    const v = trading.view(acc.id);
    expect(v.valuation).toBe('mid');
    expect(v.cashCents).toBe(100_000 - margin);
    const mid = world.sim.price(0);
    const p = v.positions[0];
    expect(p?.short).toBe(true);
    expect(p?.valueCents).toBe(mid * 30);
    expect(p?.equityCents).toBe(Math.max(0, out.trade.totalCents + margin - mid * 30));
    expect(v.netWorthCents).toBe(v.cashCents + (p?.equityCents as number));
  }, LONG);
});

// ---- stop-loss and take-profit: setting them -------------------------------------------------------------------------------------

describe('Stop-loss and take-profit: setting them', () => {
  it('EXIT-1: an order that opens a position can carry both prices; they are saved on the position and shown on the account', async () => {
    const { trading, order, position, account } = await setup();
    const mid = trading.estimate(account.id, 0, 'buy', 1).mid;
    const stop = Math.floor(mid * 0.9);
    const take = Math.ceil(mid * 1.2);
    trading.placeOrder(order({ side: 'buy', qty: 5, stopPrice: stop, takePrice: take }));
    expect(position()).toMatchObject({ shares: 5, stop_cents: stop, take_cents: take });
    expect(trading.view(account.id).positions[0]).toMatchObject({ stopCents: stop, takeCents: take });
    // Adding to the position without prices keeps them; adding with a new stop changes only the stop.
    trading.placeOrder(order({ side: 'buy', qty: 1 }));
    expect(position()).toMatchObject({ shares: 6, stop_cents: stop, take_cents: take });
    trading.placeOrder(order({ side: 'buy', qty: 1, stopPrice: stop - 1 }));
    expect(position()).toMatchObject({ shares: 7, stop_cents: stop - 1, take_cents: take });
  }, LONG);

  it('EXIT-2: the prices must be on the right side of the market price, for a long and for a short; a bad one refuses the whole order', async () => {
    const { trading, order, rejects, position, cash, account } = await setup();
    const mid = trading.estimate(account.id, 0, 'buy', 1).mid;
    for (const bad of [{ stopPrice: mid + 50 }, { stopPrice: mid }, { takePrice: mid - 50 }, { takePrice: mid }]) {
      const err = rejects(() => trading.placeOrder(order({ side: 'buy', qty: 5, ...bad })));
      expect(err.code).toBe('bad_exit');
    }
    expect(position()).toBeUndefined();
    expect(cash()).toBe(100_000);
    for (const bad of [{ stopPrice: mid - 50 }, { stopPrice: mid }, { takePrice: mid + 50 }, { takePrice: mid }, { takePrice: 99 }]) {
      const err = rejects(() => trading.placeOrder(order({ side: 'sell', short: true, qty: 5, ...bad })));
      expect(err.code).toBe('bad_exit');
    }
    expect(position()).toBeUndefined();
    expect(cash()).toBe(100_000);
    for (const bad of [0, -5, 1.5, Number.NaN]) {
      expect(rejects(() => trading.placeOrder(order({ side: 'buy', qty: 1, stopPrice: bad }))).code).toBe('bad_request');
    }
    // A short may have a stop above and a take below.
    trading.placeOrder(order({ side: 'sell', short: true, qty: 5, stopPrice: mid + 50, takePrice: mid - 50 }));
    expect(position()).toMatchObject({ short: 1, stop_cents: mid + 50, take_cents: mid - 50 });
  }, LONG);

  it('EXIT-3: an order that closes a position cannot carry prices; a stop at or beyond the liquidation price is refused because the market closes the position there anyway', async () => {
    const { trading, order, rejects, account } = await setup();
    trading.placeOrder(order({ side: 'buy', qty: 5 }));
    expect(rejects(() => trading.placeOrder(order({ side: 'sell', qty: 1, stopPrice: 5 }))).code).toBe('bad_request');
    trading.placeOrder(order({ side: 'sell', qty: 5 }));

    const open = trading.placeOrder(order({ side: 'buy', qty: 20, leverage: 10 }));
    const liq = trading.view(account.id).positions[0]?.liqPrice as number;
    expect(liq).toBeGreaterThan(0);
    const err = rejects(() => trading.setExits(account.id, 0, { stopPrice: liq }));
    expect(err.code).toBe('bad_exit');
    expect(err.message).toMatch(/anyway/);
    expect(rejects(() => trading.setExits(account.id, 0, { stopPrice: liq - 5 })).code).toBe('bad_exit');
    const ok = trading.setExits(account.id, 0, { stopPrice: liq + 1 });
    expect(ok.positions[0]?.stopCents).toBe(liq + 1);
    void open;

    trading.placeOrder(order({ side: 'sell', qty: 20 }));
    trading.placeOrder(order({ side: 'sell', short: true, qty: 20, leverage: 10 }));
    const sliq = trading.view(account.id).positions[0]?.liqPrice as number;
    expect(rejects(() => trading.setExits(account.id, 0, { stopPrice: sliq })).code).toBe('bad_exit');
    expect(trading.setExits(account.id, 0, { stopPrice: sliq - 1 }).positions[0]?.stopCents).toBe(sliq - 1);
  }, LONG);

  it('EXIT-4: prices can be set, changed and removed on an open position; only what is given is checked; no position means nothing to protect', async () => {
    const { trading, order, rejects, position, account } = await setup();
    expect(rejects(() => trading.setExits(account.id, 0, { stopPrice: 100 })).code).toBe('insufficient_shares');
    const mid = trading.estimate(account.id, 0, 'buy', 1).mid;
    trading.placeOrder(order({ side: 'buy', qty: 5 }));
    trading.setExits(account.id, 0, { stopPrice: mid - 10, takePrice: mid + 10 });
    expect(position()).toMatchObject({ stop_cents: mid - 10, take_cents: mid + 10 });
    trading.setExits(account.id, 0, { takePrice: mid + 20 }); // the stop is left alone
    expect(position()).toMatchObject({ stop_cents: mid - 10, take_cents: mid + 20 });
    trading.setExits(account.id, 0, { stopPrice: null }); // removed
    expect(position()).toMatchObject({ stop_cents: 0, take_cents: mid + 20 });
    trading.setExits(account.id, 0, { takePrice: null });
    expect(position()).toMatchObject({ stop_cents: 0, take_cents: 0 });
    for (const bad of [0, -3, 2.5, 'ten' as unknown as number]) {
      expect(rejects(() => trading.setExits(account.id, 0, { stopPrice: bad })).code).toBe('bad_request');
    }
    expect(rejects(() => trading.setExits(account.id, 99, { stopPrice: 100 })).code).toBe('unknown_company');
    // Closing the position takes its prices with it.
    trading.setExits(account.id, 0, { stopPrice: mid - 10 });
    trading.placeOrder(order({ side: 'sell', qty: 5 }));
    expect(position()).toBeUndefined();
  }, LONG);
});

// ---- the liquidator: shorts, stops and takes with prices the test controls ---------------------------------------------------------

describe('Short selling and stops: the market closes positions', () => {
  /** A market whose prices the test controls; everything else comes from the real one. */
  function control(world: { companies: LiquidationWorld['companies']; msOfTick(t: number): number; sim: { price(i: number): number } }, prices: Map<number, number>): LiquidationWorld {
    return { sim: { price: (i: number) => prices.get(i) ?? world.sim.price(i), isListed: () => true }, companies: world.companies, msOfTick: (t: number) => world.msOfTick(t) };
  }

  it('SHORT-14: a short is closed at the tick where buying back costs the whole collateral: the margin is lost, nothing else; the trade is a forced purchase', async () => {
    const { trading, db, world, order, account, position, cash } = await setup();
    const prices = new Map<number, number>();
    const events: PositionClosed[] = [];
    const liq = new Liquidator({ db, world: control(world, prices), log: new Logger({ sink: null }), onClosed: (e) => events.push(...e) });
    trading.setLeverageListener(() => liq.markDirty());
    const open = trading.placeOrder(order({ side: 'sell', short: true, qty: 40, leverage: 20 }));
    const margin = marginOf(open.trade.totalCents, 20);
    const level = shortLiquidationPrice(40, open.trade.totalCents + margin);
    const cashAfter = cash();

    prices.set(0, level - 1); // one cent below the line: nothing happens
    for (let t = 1000; t < 1010; t += 1) liq.step(t);
    expect(position()?.shares).toBe(40);
    expect(liq.closed).toBe(0);

    prices.set(0, level);
    liq.step(1010);
    expect(position()).toBeUndefined();
    expect(liq.closed).toBe(1);
    expect(cash()).toBe(cashAfter); // nothing comes back
    const v = trading.view(account.id);
    expect(v.netWorthCents).toBe(cashAfter);
    expect(v.profitCents).toBe(cashAfter - 100_000);
    expect(v.realizedCents).toBe(-margin);
    const last = trading.trades(account.id, 5)[0];
    expect(last).toMatchObject({ side: 'buy', short: true, filled: 40, liquidated: true, realizedCents: -margin, tick: 1010, auto: '' });
    expect(events).toEqual([{ accountId: account.id, companyId: 0, reason: 'liquidated', short: true, shares: 40, priceCents: level, realizedCents: -margin, tick: 1010 }]);
    liq.step(1011);
    expect(liq.closed).toBe(1);
  }, LONG);

  it('SHORT-15: longs and shorts in the same stock do not disturb each other: a rise wipes out only the short, a fall only the leveraged long', async () => {
    const { trading, db, world, auth } = await setup();
    const bob = await auth.register('bob', 'correct horse', '127.0.0.2');
    const carol = await auth.register('carol', 'correct horse', '127.0.0.3');
    const accA = trading.careerAccountOf((await auth.register('dave', 'correct horse', '127.0.0.4')).user.id);
    const accB = trading.careerAccountOf(bob.user.id);
    const accC = trading.careerAccountOf(carol.user.id);
    const prices = new Map<number, number>();
    const liq = new Liquidator({ db, world: control(world, prices), log: new Logger({ sink: null }) });
    trading.setLeverageListener(() => liq.markDirty());
    const mk = (accountId: number, side: 'buy' | 'sell', short: boolean, leverage: number, tag: string) =>
      trading.placeOrder({ accountId, clientOrderId: `o-${tag}-${accountId}`.padEnd(14, 'x'), companyId: 0, side, short, qty: 10, leverage });
    const s = mk(accB.id, 'sell', true, 40, 'a'); // bob: 40× short
    const l = mk(accC.id, 'buy', false, 40, 'b'); // carol: 40× long
    mk(accA.id, 'sell', true, 2, 'c'); // dave: 2× short, survives a small rise
    const shortLevel = shortLiquidationPrice(10, s.trade.totalCents + marginOf(s.trade.totalCents, 40));
    const longLevel = Math.floor((l.trade.totalCents - marginOf(l.trade.totalCents, 40)) / 10);
    expect(shortLevel).toBeGreaterThan(longLevel);
    prices.set(0, shortLevel);
    liq.step(500);
    const left = (): number[] => db.all<{ account_id: number }>('SELECT account_id FROM positions ORDER BY account_id').map((r) => r.account_id);
    expect(left()).toEqual([accC.id, accA.id].sort((x, y) => x - y)); // bob's 40× short is gone; carol's long and dave's 2× short stay
    prices.set(0, longLevel);
    liq.step(501);
    expect(left()).toEqual([accA.id]); // carol's 40× long is gone; dave's small short stays
    expect(liq.closed).toBe(2);
  }, LONG);

  it('EXIT-5: a stop-loss / take-profit hands the position to the exit handler at the right price: long stops below, takes above; short stops above, takes below; the stop wins a tie', async () => {
    const { trading, db, world, order } = await setup();
    const prices = new Map<number, number>([[0, 10_000]]);
    const calls: string[] = [];
    const liq = new Liquidator({ db, world: control(world, prices), log: new Logger({ sink: null }) });
    liq.setExitHandler((_accountId, _companyId, kind, tick) => {
      calls.push(`${kind}@${tick}`);
      return null; // pretend trading could not take the order
    });
    trading.setLeverageListener(() => liq.markDirty());
    const mid = trading.estimate(null, 0, 'buy', 1).mid;
    trading.placeOrder(order({ side: 'buy', qty: 5, stopPrice: mid - 100, takePrice: mid + 100 }));
    prices.set(0, mid - 99);
    liq.step(1);
    prices.set(0, mid + 99);
    liq.step(2);
    expect(calls).toEqual([]); // inside the band: nothing
    prices.set(0, mid - 100);
    liq.step(3);
    prices.set(0, mid + 100);
    liq.step(4);
    expect(calls).toEqual(['stop@3', 'take@4']); // it asked, was told "not now", and asks again at the next tick
    liq.step(5);
    expect(calls).toEqual(['stop@3', 'take@4', 'take@5']);

    trading.placeOrder(order({ side: 'sell', qty: 5 }));
    calls.length = 0;
    trading.placeOrder(order({ side: 'sell', short: true, qty: 5, stopPrice: mid + 100, takePrice: mid - 100 }));
    prices.set(0, mid + 100);
    liq.step(6);
    prices.set(0, mid - 100);
    liq.step(7);
    expect(calls).toEqual(['stop@6', 'take@7']);
  }, LONG);

  it('EXIT-6: a stop that fires closes the whole position as an ordinary market order: the trade says "stop", it pays the spread, and the player is told', async () => {
    const { trading, db, world, order, account, position, cash } = await setup();
    const prices = new Map<number, number>();
    const events: PositionClosed[] = [];
    const liq = new Liquidator({ db, world: control(world, prices), log: new Logger({ sink: null }), onClosed: (e) => events.push(...e) });
    liq.setExitHandler((a, c, kind, tick) => trading.closeByExit(a, c, kind, tick));
    trading.setLeverageListener(() => liq.markDirty());
    const mid = trading.estimate(account.id, 0, 'buy', 1).mid;
    const buy = trading.placeOrder(order({ side: 'buy', qty: 25, stopPrice: mid - 30 }));
    const cashAfterBuy = cash();
    prices.set(0, mid - 30);
    liq.step(2_000);
    expect(position()).toBeUndefined();
    expect(liq.exited).toBe(1);
    expect(liq.closed).toBe(0);
    const last = trading.trades(account.id, 5)[0];
    // The market sold at its own book prices (the real market's price, which the test did not move), not at the stop price.
    expect(last).toMatchObject({ side: 'sell', short: false, filled: 25, auto: 'stop', liquidated: false, clientOrderId: 'auto-stop-0-2000' });
    expect(cash()).toBe(cashAfterBuy + last!.totalCents);
    expect(last?.realizedCents).toBe(last!.totalCents - buy.trade.totalCents);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ accountId: account.id, reason: 'stop', short: false, shares: 25, realizedCents: last?.realizedCents, tick: 2_000 });
    liq.step(2_001); // once
    expect(liq.exited).toBe(1);
  }, LONG);

  it('EXIT-7: a take-profit on a short covers it; a short\'s take pays the collateral back minus the cost, and the trade says "take"', async () => {
    const { trading, db, world, order, account, position, cash } = await setup();
    const prices = new Map<number, number>();
    const liq = new Liquidator({ db, world: control(world, prices), log: new Logger({ sink: null }) });
    liq.setExitHandler((a, c, kind, tick) => trading.closeByExit(a, c, kind, tick));
    trading.setLeverageListener(() => liq.markDirty());
    const mid = trading.estimate(account.id, 0, 'buy', 1).mid;
    const open = trading.placeOrder(order({ side: 'sell', short: true, qty: 25, leverage: 5, takePrice: mid - 30 }));
    const margin = marginOf(open.trade.totalCents, 5);
    const cashAfter = cash();
    prices.set(0, mid - 30);
    liq.step(3_000);
    expect(position()).toBeUndefined();
    const last = trading.trades(account.id, 5)[0];
    expect(last).toMatchObject({ side: 'buy', short: true, filled: 25, auto: 'take' });
    const back = Math.max(0, open.trade.totalCents + margin - last!.totalCents);
    expect(cash()).toBe(cashAfter + back);
    expect(last?.realizedCents).toBe(back - margin);
  }, LONG);

  it('EXIT-8: a stop that cannot trade right now (trading halted) stays on the position and fires at the first tick it can', async () => {
    const { trading, db, world, order, account, position } = await setup();
    const prices = new Map<number, number>();
    const liq = new Liquidator({ db, world: control(world, prices), log: new Logger({ sink: null }) });
    liq.setExitHandler((a, c, kind, tick) => trading.closeByExit(a, c, kind, tick));
    trading.setLeverageListener(() => liq.markDirty());
    const mid = trading.estimate(account.id, 0, 'buy', 1).mid;
    trading.placeOrder(order({ side: 'buy', qty: 25, stopPrice: mid - 30 }));
    let halted = true;
    trading.setHalts({ isHalted: () => halted, isHaltedItself: () => halted, allPaused: () => null, reasonOf: () => 'test', autoPauseOf: () => null } as never);
    prices.set(0, mid - 30);
    liq.step(10);
    liq.step(11);
    expect(position()?.shares).toBe(25);
    expect(liq.exited).toBe(0);
    halted = false;
    liq.step(12);
    expect(position()).toBeUndefined();
    expect(liq.exited).toBe(1);
    expect(trading.trades(account.id, 1)[0]?.tick).toBe(world.sim.tick);
  }, LONG);

  it('EXIT-9: 1v1: stops work in a live match and are left alone after its last tick', async () => {
    const { trading, db, world, user } = await setup();
    db.run("INSERT INTO matches(id, state, created_ms, start_tick, end_tick, duration_ticks, start_cash_cents) VALUES (1, 'live', 0, 1000, 1180, 180, 100000)");
    const acc = trading.createMatchAccount(user.id, 1, 100_000);
    const prices = new Map<number, number>();
    const liq = new Liquidator({ db, world: control(world, prices), log: new Logger({ sink: null }) });
    const seen: string[] = [];
    liq.setExitHandler((_a, _c, kind, tick) => {
      seen.push(`${kind}@${tick}`);
      return null;
    });
    const mid = world.sim.price(0);
    trading.placeOrder({ accountId: acc.id, clientOrderId: 'match-order-000001', companyId: 0, side: 'buy', qty: 5, stopPrice: mid - 10 });
    prices.set(0, mid - 10);
    liq.step(1181); // after the last tick: left alone
    expect(seen).toEqual([]);
    liq.step(1180);
    expect(seen).toEqual(['stop@1180']);
  }, LONG);
});

// ---- the whole program: orders over the web API, real crashes and spikes, a restart --------------------------------------------

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
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'tq-short-'));
  if (!options.dir) dirs.push(dir);
  const clock = options.clock ?? new Clock();
  const config = loadConfig({ TQ_DATA_DIR: dir, TQ_COMPANIES: '66', TQ_WARMUP_DAYS: '1', TQ_PORT: '8787', TQ_OWNER: 'boss' });
  // No automatic pauses: a crash of this size would pause trading, and these tests are about what happens to the positions.
  const app = createApp({ config, log: new Logger({ sink: null, now: clock.now }), worldSeed: 777, now: clock.now, flowGain: 0, autoPauses: false });
  const server = createServer(app.handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const r = { app, server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, dir, clock };
  running.push(r);
  return r;
}

/** Moves the clock forward and lets the market catch up in steps of 10 seconds, as the live timer does (an order is only taken while the market is within 30 ticks of the clock). */
function advance(r: Running, seconds: number): void {
  const w = r.app.services.world;
  for (let left = seconds; left > 0; left -= 10) {
    r.clock.advanceSeconds(Math.min(10, left));
    for (let i = 0; i < 400_000 && w.sim.tick < w.currentTick(); i += 1) w.pump();
  }
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
const sharesFor = (co: { price: number }): number => Math.max(1, Math.floor(80_000 / co.price));

describe('Short selling and stops: over the web API, with real crashes and spikes', () => {
  it('SHORT-16: the order and estimate routes take short, stopPrice and takePrice; bad values are a 400 with a clear message; the exits route changes an open position', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    advance(r, 30);
    const co = await cheapLarge(r);
    const est = await call(r, `/api/market/${co.ticker}/estimate?side=sell&qty=20&account=career&leverage=10&short=1`, { cookie: alice });
    expect(est.status).toBe(200);
    expect(est.json).toMatchObject({ short: true, leverage: 10, filledQty: 20 });
    expect(est.json.netCents).toBe(Math.ceil(est.json.totalCents / 10));
    expect(est.json.creditCents).toBe(est.json.totalCents);
    expect(est.json.liqPrice).toBeGreaterThan(est.json.mid);
    expect((await call(r, `/api/market/${co.ticker}/estimate?side=sell&qty=20&short=2`, { cookie: alice })).status).toBe(400);
    expect((await trade(r, alice, { ticker: co.ticker, side: 'sell', qty: 5, short: 'yes' })).status).toBe(400);
    expect((await trade(r, alice, { ticker: co.ticker, side: 'sell', qty: 5, short: true, stopPrice: 'high' })).status).toBe(400);
    const wrong = await trade(r, alice, { ticker: co.ticker, side: 'sell', qty: 5, short: true, stopPrice: Math.floor(co.price / 2) });
    expect(wrong.status).toBe(400);
    expect(wrong.json.error?.code ?? wrong.json.code).toBe('bad_exit');
    expect((await account(r, alice)).positions).toEqual([]);

    const shorted = await trade(r, alice, { ticker: co.ticker, side: 'sell', qty: 20, short: true, leverage: 10, stopPrice: Math.ceil(co.price * 1.05), takePrice: Math.floor(co.price * 0.9) });
    expect(shorted.status).toBe(201);
    expect(shorted.json.trade).toMatchObject({ side: 'sell', short: true, leverage: 10, filled: 20 });
    let acc = await account(r, alice);
    const p = acc.positions[0];
    expect(p).toMatchObject({ ticker: co.ticker, short: true, shares: 20, stopCents: Math.ceil(co.price * 1.05), takeCents: Math.floor(co.price * 0.9) });
    expect(p.creditCents).toBe(shorted.json.trade.totalCents);
    expect(acc.netWorthCents).toBe(acc.cashCents + p.equityCents);

    const changed = await call(r, '/api/positions/exits', { method: 'POST', cookie: alice, body: { ticker: co.ticker, stopPrice: null, takePrice: Math.floor(co.price * 0.8) } });
    expect(changed.status).toBe(200);
    expect(changed.json.account.positions[0]).toMatchObject({ stopCents: 0, takeCents: Math.floor(co.price * 0.8) });
    const bad = await call(r, '/api/positions/exits', { method: 'POST', cookie: alice, body: { ticker: co.ticker, takePrice: co.price * 2 } });
    expect(bad.status).toBe(400);
    expect((await call(r, '/api/positions/exits', { method: 'POST', body: { ticker: co.ticker, takePrice: 5 } })).status).toBe(401);
    expect((await call(r, '/api/positions/exits', { method: 'POST', cookie: alice, body: { ticker: 'NOPE', takePrice: 5 } })).status).toBe(404);
    acc = await account(r, alice);
    expect(acc.positions[0].takeCents).toBe(Math.floor(co.price * 0.8));
    const list = await tradesOf(r, alice);
    expect(list[0]).toMatchObject({ side: 'sell', short: true, auto: '' });
  }, LONG);

  it('SHORT-17: a spike wipes out the short: the margin is lost, the rest of the account is untouched, and the trade list says Liquidated; the player is sent a live notice', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const bob = await signUp(r, 'bob');
    const boss = await signUp(r, 'boss');
    advance(r, 60);
    const co = await cheapLarge(r);
    const n = sharesFor(co);
    const a = await trade(r, alice, { ticker: co.ticker, side: 'sell', short: true, qty: n, leverage: 20 });
    const b = await trade(r, bob, { ticker: co.ticker, side: 'buy', qty: n }); // a long in the same stock, which a rise only helps
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const aliceCash = (await account(r, alice)).cashCents;
    const margin = Math.ceil(a.json.trade.totalCents / 20);
    expect(aliceCash).toBe(100_000 - margin);

    // Listen to alice's live stream for the notice.
    const aliceId = r.app.services.db.get<{ id: number }>("SELECT id FROM users WHERE username = 'alice'")!.id;
    const got: any[] = [];
    const publish = r.app.services.hub.publishTo.bind(r.app.services.hub);
    r.app.services.hub.publishTo = (userId: number, event: string, data: unknown) => {
      if (event === 'position') got.push({ userId, data });
      publish(userId, event, data);
    };

    expect((await post(r, '/api/admin/shock', boss, { ticker: co.ticker, percent: 60, style: 'pump', speed: 'fast' })).status).toBe(200);
    advance(r, 400);
    const acc = await account(r, alice);
    expect(acc.positions).toEqual([]);
    expect(acc.cashCents).toBe(aliceCash);
    expect(acc.profitCents).toBe(-margin);
    const last = (await tradesOf(r, alice))[0];
    expect(last).toMatchObject({ side: 'buy', short: true, liquidated: true, filled: n, realizedCents: -margin });
    expect((await account(r, bob)).positions[0]?.shares).toBe(n);
    expect(r.app.services.liquidator.closed).toBe(1);
    // The spike may first have been announced as a margin call (margin.ts); the one notice about the closing is the liquidation.
    const closing = got.filter((g) => g.data.reason !== 'margin_call');
    expect(closing).toHaveLength(1);
    expect(closing[0].userId).toBe(aliceId);
    expect(closing[0].data).toMatchObject({ reason: 'liquidated', account: 'career', ticker: co.ticker, short: true, shares: n, realizedCents: -margin });
    for (const g of got.filter((x) => x.data.reason === 'margin_call')) expect(g).toMatchObject({ userId: aliceId, data: { short: true, ticker: co.ticker } });
    expect(got.filter((g) => g.data.reason === 'margin_call').length).toBeLessThanOrEqual(1);
    expect(r.app.services.world.health().ok).toBe(true);
  }, LONG);

  it('EXIT-10: a crash fires the stop-loss and a rally fires the take-profit, each as a market order at the market price of that moment, with a live notice; a short is the other way round', async () => {
    const r = await boot();
    const [alice, bob, carol, dave] = [await signUp(r, 'alice'), await signUp(r, 'bob'), await signUp(r, 'carol'), await signUp(r, 'dave')];
    const boss = await signUp(r, 'boss');
    advance(r, 60);
    const [c1, c2] = (await market(r)).filter((c) => c.trading && c.tier === 'large').sort((x, y) => x.price - y.price);
    const n = sharesFor(c1);
    const m = sharesFor(c2);
    const stopA = Math.floor(c1.price * 0.9);
    // alice: long c1 with a stop at −10 %; bob: long c1 with a take at +10 % (both in the same stock, so the crash only fires alice's stop)
    expect((await trade(r, alice, { ticker: c1.ticker, qty: n, stopPrice: stopA })).status).toBe(201);
    expect((await trade(r, bob, { ticker: c1.ticker, qty: n, takePrice: Math.ceil(c1.price * 1.1) })).status).toBe(201);
    // carol: short c2 with a stop at +10 %; dave: short c2 with a take at −10 %
    expect((await trade(r, carol, { ticker: c2.ticker, side: 'sell', short: true, qty: m, stopPrice: Math.ceil(c2.price * 1.1) })).status).toBe(201);
    expect((await trade(r, dave, { ticker: c2.ticker, side: 'sell', short: true, qty: m, takePrice: Math.floor(c2.price * 0.9) })).status).toBe(201);
    const notices: any[] = [];
    const publish = r.app.services.hub.publishTo.bind(r.app.services.hub);
    r.app.services.hub.publishTo = (userId: number, event: string, data: unknown) => {
      if (event === 'position') notices.push(data);
      publish(userId, event, data);
    };

    expect((await post(r, '/api/admin/shock', boss, { ticker: c1.ticker, percent: -40, style: 'crash', speed: 'fast' })).status).toBe(200);
    expect((await post(r, '/api/admin/shock', boss, { ticker: c2.ticker, percent: 40, style: 'pump', speed: 'fast' })).status).toBe(200);
    advance(r, 400);

    // c1 crashed: alice's stop fired, bob (long with a take above) still holds. c2 rose: carol's stop fired, dave (short with a take below) still holds.
    expect((await account(r, alice)).positions).toEqual([]);
    expect((await account(r, bob)).positions[0]).toMatchObject({ shares: n, takeCents: Math.ceil(c1.price * 1.1) });
    expect((await account(r, carol)).positions).toEqual([]);
    expect((await account(r, dave)).positions[0]).toMatchObject({ shares: m, short: true });
    const ta = (await tradesOf(r, alice))[0];
    expect(ta).toMatchObject({ side: 'sell', short: false, auto: 'stop', liquidated: false, filled: n });
    expect(ta.avgPrice).toBeLessThanOrEqual(stopA + 1); // sold at or below the stop: a fast crash gaps through it
    const tc = (await tradesOf(r, carol))[0];
    expect(tc).toMatchObject({ side: 'buy', short: true, auto: 'stop', filled: m });
    expect(tc.avgPrice).toBeGreaterThanOrEqual(Math.ceil(c2.price * 1.1) - 1);
    expect(notices.map((x) => `${x.reason}:${x.ticker}:${x.short}`).sort()).toEqual([`stop:${c1.ticker}:false`, `stop:${c2.ticker}:true`].sort());
    expect(r.app.services.liquidator.exited).toBe(2);
    expect(r.app.services.liquidator.closed).toBe(0);

    // Now the other way: c1 rallies (bob's take fires), c2 crashes (dave's take fires).
    expect((await post(r, '/api/admin/shock', boss, { ticker: c1.ticker, percent: 250, style: 'pump', speed: 'fast' })).status).toBe(200);
    expect((await post(r, '/api/admin/shock', boss, { ticker: c2.ticker, percent: -55, style: 'crash', speed: 'fast' })).status).toBe(200);
    advance(r, 500);
    expect((await account(r, bob)).positions).toEqual([]);
    expect((await account(r, dave)).positions).toEqual([]);
    expect((await tradesOf(r, bob))[0]).toMatchObject({ side: 'sell', auto: 'take', short: false });
    expect((await tradesOf(r, dave))[0]).toMatchObject({ side: 'buy', auto: 'take', short: true });
    expect(r.app.services.liquidator.exited).toBe(4);
  }, LONG);

  it('EXIT-11: a stop that is hit while the server is off fires as soon as the server is up and the market has caught up, at the market price of that moment (never at a price from the past)', async () => {
    let r = await boot();
    const alice = await signUp(r, 'alice');
    const boss = await signUp(r, 'boss');
    advance(r, 60);
    const co = await cheapLarge(r);
    const n = sharesFor(co);
    expect((await trade(r, alice, { ticker: co.ticker, qty: n, stopPrice: Math.floor(co.price * 0.9) })).status).toBe(201);
    expect((await post(r, '/api/admin/shock', boss, { ticker: co.ticker, percent: -60, style: 'crash', speed: 'fast' })).status).toBe(200);
    const clock = r.clock;
    const dir = r.dir;
    await stop(r);
    running.splice(running.indexOf(r), 1);
    clock.advanceSeconds(900); // the crash happens (and is over) while the server is off
    r = await boot({ dir, clock });
    const w = r.app.services.world;
    expect(w.sim.tick).toBe(w.currentTick());
    advance(r, 20);
    const acc = await account(r, alice);
    expect(acc.positions).toEqual([]);
    const last = (await tradesOf(r, alice))[0];
    expect(last).toMatchObject({ side: 'sell', auto: 'stop', filled: n });
    // It was a market order at the time the market was caught up, not at a replayed tick of the crash.
    expect(last.tick).toBeGreaterThanOrEqual(w.sim.tick - 60);
  }, LONG);

  it('SHORT-18: the owner cannot give or take shares of a short position', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const boss = await signUp(r, 'boss');
    advance(r, 60);
    const co = await cheapLarge(r);
    expect((await trade(r, alice, { ticker: co.ticker, side: 'sell', short: true, qty: 10 })).status).toBe(201);
    const refused = await post(r, '/api/admin/shares', boss, { username: 'alice', ticker: co.ticker, qty: -5 });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.json)).toMatch(/short/);
    expect((await post(r, '/api/admin/shares', boss, { username: 'alice', ticker: co.ticker, qty: 5 })).status).toBe(400);
    expect((await account(r, alice)).positions[0]).toMatchObject({ shares: 10, short: true });
  }, LONG);
});
