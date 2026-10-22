// What borrowing costs (docs/world.md §6.7): a leveraged long pays interest on its debt, a short pays a borrow fee out of the money from its sale,
// both only in Career, counted in whole cents, charged every minute and before any order that changes the position, also for the ticks the
// market replays after the server was off. And the market warns a player once when a position has lost three quarters of the cash he put in.
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../server/app';
import { Auth } from '../server/auth';
import { loadConfig } from '../server/config';
import { equityOf } from '../server/leverage';
import { Logger } from '../server/log';
import { ACCRUE_EVERY_TICKS, MARGIN_CALL_RESET, MARGIN_CALL_SHARE, MarginCosts, TICKS_PER_YEAR, WARN_EVERY_TICKS, accrue, borrowBps, costPerDay, interestBps } from '../server/margin';
import { MIGRATIONS, migrate } from '../server/schema';
import { Db } from '../server/sqlite';
import { OrderError, Trading, type OrderRequest } from '../server/trading';
import { Clock, makeRig, type Rig } from './helpers/server';

const LONG = 240_000;

/** The cost worked out a second way (whole numbers, no rounding but the final one): base × bps × ticks / (10 000 × ticks in a year). */
function owed(base: number, bps: number, ticks: number): number {
  return Number((BigInt(base) * BigInt(bps) * BigInt(ticks)) / (BigInt(10_000) * BigInt(TICKS_PER_YEAR)));
}

// ---- the pure rules -----------------------------------------------------------------------------------------------------------

describe('Margin: the rules', () => {
  it('MARGIN-1: the rates: 10 % a year on a stock, 40 % on a memecoin; a short pays 0.5 % up to 10.5 % by how thin the stock is, 40 % on a coin', () => {
    expect(TICKS_PER_YEAR).toBe(365 * 86_400);
    expect(interestBps({ sector: 'tech' })).toBe(1000);
    expect(interestBps({ sector: 'energy' })).toBe(1000);
    expect(interestBps({ sector: 'meme' })).toBe(4000);
    expect(borrowBps({ sector: 'tech', liquidity: 1 })).toBe(50);
    expect(borrowBps({ sector: 'tech', liquidity: 0 })).toBe(1050);
    expect(borrowBps({ sector: 'tech', liquidity: 0.5 })).toBe(550);
    // A silly liquidity is held to the range.
    expect(borrowBps({ sector: 'tech', liquidity: 7 })).toBe(50);
    expect(borrowBps({ sector: 'tech', liquidity: -3 })).toBe(1050);
    expect(borrowBps({ sector: 'meme', liquidity: 1 })).toBe(4000);
    expect(borrowBps({ sector: 'meme', liquidity: 0 })).toBe(4000);
    // The thinner, the dearer.
    let last = 0;
    for (let l = 1; l >= 0; l -= 0.1) {
      const bps = borrowBps({ sector: 'tech', liquidity: l });
      expect(bps).toBeGreaterThanOrEqual(last);
      last = bps;
    }
  });

  it('MARGIN-2: the cost is worked out to the cent with whole numbers; less than a cent is not charged and no time is used up', () => {
    // 5 256 000 cents at 10 % a year costs exactly one cent every 60 ticks.
    expect(accrue(5_256_000, 1000, 60)).toEqual({ due: 1, usedTicks: 60 });
    expect(accrue(5_256_000, 1000, 59)).toEqual({ due: 0, usedTicks: 0 });
    expect(accrue(5_256_000, 1000, 600)).toEqual({ due: 10, usedTicks: 600 });
    // $100 at 10 % for a day is 2.74 cents: two are charged, and the ticks that paid for them are 63 072 (the rest keeps counting).
    expect(accrue(10_000, 1000, 86_400)).toEqual({ due: 2, usedTicks: 63_072 });
    // Nothing owed, nothing charged.
    for (const [base, bps, ticks] of [
      [0, 1000, 86_400],
      [10_000, 0, 86_400],
      [10_000, 1000, 0],
      [-5, 1000, 86_400],
      [10_000, 1000, -9],
    ] as const) {
      expect(accrue(base, bps, ticks)).toEqual({ due: 0, usedTicks: 0 });
    }
    // Exact for very large numbers (no floating point).
    const big = accrue(Number.MAX_SAFE_INTEGER, 4000, 86_400);
    expect(big.due).toBe(owed(Number.MAX_SAFE_INTEGER, 4000, 86_400));
    expect(big.usedTicks).toBeLessThanOrEqual(86_400);
    // What is shown per day.
    expect(costPerDay(0, 1000)).toBe(0);
    expect(costPerDay(365_000, 1000)).toBe(100);
    expect(costPerDay(10_000, 0)).toBe(0);
  });

  it('MARGIN-3: charging in many small steps costs the same as charging once, to within a few cents (a cent here is never charged twice); time is never used twice', () => {
    for (const [base, bps, day] of [
      [5_256_000, 1000, 86_400],
      [123_456, 4000, 86_400 * 3],
      [987_654_321, 550, 86_400],
      [4_999, 1050, 86_400 * 30],
    ] as const) {
      const perTick = (base * bps) / (10_000 * TICKS_PER_YEAR); // cents of cost in one tick
      for (const step of [60, 61, 600, 3_600]) {
        let paid = 0;
        let events = 0;
        let from = 0;
        for (let t = step; t <= day; t += step) {
          const { due, usedTicks } = accrue(base, bps, t - from);
          expect(usedTicks).toBeLessThanOrEqual(t - from);
          if (due > 0) {
            expect(usedTicks).toBeGreaterThanOrEqual(1);
            paid += due;
            events += 1;
            from += usedTicks;
          }
        }
        // Each charge rounds the time it used to the nearest tick (at most half a tick of cost, either way); over many charges that is a random walk.
        // When one tick costs more than a cent (a loan of millions) the part of a cent that a tick cannot show is left out of each charge: under 1 %.
        const once = owed(base, bps, day);
        const bound = 1 + 3 * Math.sqrt(events) * perTick + perTick + (perTick > 1 ? events : 0);
        expect(Math.abs(once - paid)).toBeLessThanOrEqual(bound);
        expect(Math.abs(once - paid)).toBeLessThanOrEqual(once * 0.01 + 1);
      }
    }
  });
});

// ---- orders, with a real database and market ----------------------------------------------------------------------------------

const rigs: Rig[] = [];
afterEach(() => {
  while (rigs.length > 0) rigs.pop()?.cleanup();
});

interface PositionRow {
  shares: number;
  cost_cents: number;
  debt_cents: number;
  credit_cents: number;
  short: number;
  accrued_tick: number | null;
  charged_cents: number;
}

async function setup(count = 12, withObserver = true) {
  const rig = makeRig();
  rigs.push(rig);
  const { db, world } = rig.open({ companyCount: count });
  const auth = new Auth(db, rig.clock.now, '');
  const trading = new Trading(db, world, rig.clock.now);
  let changed = 0;
  const costs = new MarginCosts(db, world, () => {
    changed += 1;
  });
  trading.setMarginCosts(costs);
  if (withObserver) world.setStepObserver((t) => costs.step(t));
  const { user } = await auth.register('alice', 'correct horse', '127.0.0.1');
  const account = trading.careerAccountOf(user.id);
  let n = 0;
  const order = (partial: Partial<OrderRequest> & Pick<OrderRequest, 'side' | 'qty'>): OrderRequest => ({
    accountId: account.id,
    clientOrderId: `order-${String(++n).padStart(6, '0')}`,
    companyId: 0,
    ...partial,
  });
  const row = (accountId = account.id, companyId = 0): PositionRow =>
    db.get<PositionRow>('SELECT shares, cost_cents, debt_cents, credit_cents, short, accrued_tick, charged_cents FROM positions WHERE account_id = ? AND company_id = ?', accountId, companyId) as PositionRow;
  const cash = (): number => (db.get<{ cash_cents: number }>('SELECT cash_cents FROM accounts WHERE id = ?', account.id) as { cash_cents: number }).cash_cents;
  const run = (ticks: number): void => {
    world.advanceTo(world.sim.tick + ticks, Infinity);
  };
  /** A 50× long using `share` of what the cash allows (all of it: a debt of about $49 000). */
  const bigLong = (share = 1) => {
    const max = trading.estimate(account.id, 0, 'buy', 1, undefined, 50).maxQty;
    return trading.placeOrder(order({ side: 'buy', qty: Math.max(1, Math.floor(max * share)), leverage: 50 }));
  };
  const bigShort = (share = 1) => {
    const max = trading.estimate(account.id, 0, 'sell', 1, undefined, 50, true).maxQty;
    return trading.placeOrder(order({ side: 'sell', short: true, qty: Math.max(1, Math.floor(max * share)), leverage: 50 }));
  };
  return { rig, db, world, auth, trading, user, account, order, row, cash, run, costs, changes: () => changed, bigLong, bigShort };
}

describe('Margin: interest on a leveraged long', () => {
  it('MARGIN-4: a leveraged long pays interest on its debt every minute: the debt grows, the margin and the shares do not, and the sum is kept', async () => {
    const { world, row, run, bigLong, account, trading } = await setup();
    const out = bigLong();
    const start = world.sim.tick;
    const before = row();
    expect(before.accrued_tick).toBe(start);
    expect(before.charged_cents).toBe(0);
    expect(before.debt_cents).toBeGreaterThan(4_000_000);
    run(3_600);
    const after = row();
    const expected = owed(before.debt_cents, 1000, 3_600);
    expect(expected).toBeGreaterThanOrEqual(50);
    expect(Math.abs(after.charged_cents - expected)).toBeLessThanOrEqual(2);
    expect(after.debt_cents - before.debt_cents).toBe(after.charged_cents); // exactly what was charged went on the debt
    expect(after.cost_cents).toBe(before.cost_cents);
    expect(after.shares).toBe(before.shares);
    // The clock moved only as far as it has been paid for.
    expect(after.accrued_tick).toBeGreaterThan(start);
    expect(world.sim.tick - (after.accrued_tick as number)).toBeLessThan(ACCRUE_EVERY_TICKS + 70);
    // The player sees it.
    const p = trading.view(account.id).positions[0];
    expect(p).toMatchObject({ debtCents: after.debt_cents, chargedCents: after.charged_cents, rateBps: 1000 });
    expect(p?.costDayCents).toBe(costPerDay(after.debt_cents, 1000));
    expect(p?.liqPrice).toBe(Math.floor(after.debt_cents / after.shares));
    expect(out.trade.debtCents).toBe(before.debt_cents);
  }, LONG);

  it('MARGIN-5: charges come once a minute, never between; nothing is charged for a plain long (no debt)', async () => {
    const { world, row, run, bigLong, order, trading, db, account } = await setup();
    bigLong(0.7);
    const debt0 = row().debt_cents;
    const t0 = world.sim.tick;
    // Up to the next full minute: one step at most.
    const toMinute = ACCRUE_EVERY_TICKS - (t0 % ACCRUE_EVERY_TICKS);
    run(toMinute - 1);
    expect(row().debt_cents).toBe(debt0);
    run(1);
    const first = row().debt_cents;
    expect(first).toBeGreaterThanOrEqual(debt0);
    // A second company, plain 1× long: nothing is ever charged.
    trading.placeOrder(order({ side: 'buy', qty: 2, companyId: 1 }));
    run(7_200);
    const plain = db.get<PositionRow>('SELECT shares, cost_cents, debt_cents, credit_cents, short, accrued_tick, charged_cents FROM positions WHERE account_id = ? AND company_id = 1', account.id) as PositionRow;
    expect(plain.debt_cents).toBe(0);
    expect(plain.charged_cents).toBe(0);
    expect(row().debt_cents).toBeGreaterThan(first);
  }, LONG);

  it('MARGIN-6: a memecoin pays 40 % a year, four times a stock', async () => {
    const rig = makeRig();
    rigs.push(rig);
    const { db, world } = rig.open({ companyCount: 12, memecoins: true });
    const trading = new Trading(db, world, rig.clock.now);
    const costs = new MarginCosts(db, world, () => undefined);
    trading.setMarginCosts(costs);
    world.setStepObserver((t) => costs.step(t));
    const auth = new Auth(db, rig.clock.now, '');
    const { user } = await auth.register('alice', 'correct horse', '127.0.0.1');
    const account = trading.careerAccountOf(user.id);
    const coinId = world.companies.findIndex((c) => c.sector === 'meme');
    expect(coinId).toBeGreaterThan(-1);
    // The coin needs time to list; run until it trades.
    for (let i = 0; i < 40 && !world.sim.isListed(coinId); i += 1) world.advanceTo(world.sim.tick + 600, Infinity);
    expect(world.sim.isListed(coinId)).toBe(true);
    const max = trading.estimate(account.id, coinId, 'buy', 1, undefined, 50).maxQty;
    trading.placeOrder({ accountId: account.id, clientOrderId: 'coin-order-000001', companyId: coinId, side: 'buy', qty: max, leverage: 50 });
    const before = db.get<PositionRow>('SELECT shares, cost_cents, debt_cents, credit_cents, short, accrued_tick, charged_cents FROM positions WHERE account_id = ? AND company_id = ?', account.id, coinId) as PositionRow;
    world.advanceTo(world.sim.tick + 3_600, Infinity);
    const after = db.get<PositionRow>('SELECT shares, cost_cents, debt_cents, credit_cents, short, accrued_tick, charged_cents FROM positions WHERE account_id = ? AND company_id = ?', account.id, coinId) as PositionRow;
    expect(Math.abs(after.charged_cents - owed(before.debt_cents, 4000, 3_600))).toBeLessThanOrEqual(2);
    expect(trading.view(account.id).positions.find((p) => p.ticker === world.companies[coinId]?.ticker)?.rateBps).toBe(4000);
  }, LONG);

  it('MARGIN-7: an order settles first: a day later, a sell repays the debt with the interest on it, to the cent', async () => {
    const { world, trading, row, run, bigLong, order, cash, account } = await setup(12, false); // no minute step: only the order charges
    bigLong();
    const first = row();
    run(86_400);
    expect(row().debt_cents).toBe(first.debt_cents); // nobody charged it yet
    const tick = world.sim.tick;
    const interest = owed(first.debt_cents, 1000, tick - (first.accrued_tick as number));
    expect(interest).toBeGreaterThan(1_000); // a day on a $49 000 loan is $13
    const cashBefore = cash();
    const out = trading.placeOrder(order({ side: 'sell', qty: first.shares }));
    expect(out.trade.debtCents).toBe(first.debt_cents + interest);
    expect(cash()).toBe(cashBefore + Math.max(0, out.trade.totalCents - (first.debt_cents + interest)));
    expect(trading.view(account.id).positions).toEqual([]);
  }, LONG);

  it('MARGIN-8: a second buy charges what was owed first, and then starts a new count; the clock is stamped on the order', async () => {
    const { world, trading, row, run, bigLong, order } = await setup(12, false);
    bigLong(0.7);
    const first = row();
    run(86_400);
    const tick = world.sim.tick;
    trading.placeOrder(order({ side: 'buy', qty: 1 })); // 1×: adds no debt, but the old debt must be brought up to date
    const second = row();
    const interest = owed(first.debt_cents, 1000, tick - (first.accrued_tick as number));
    expect(second.debt_cents).toBe(first.debt_cents + interest);
    expect(second.charged_cents).toBe(interest);
    expect(second.accrued_tick).toBe(tick);
    expect(second.shares).toBe(first.shares + 1);
  }, LONG);

  it('MARGIN-9: interest raises the price at which the market closes the position, and the liquidator is told to look again', async () => {
    const { run, row, bigLong, changes, trading, account } = await setup();
    bigLong();
    const liqBefore = trading.view(account.id).positions[0]?.liqPrice as number;
    expect(changes()).toBe(0);
    run(86_400);
    const after = row();
    expect(changes()).toBeGreaterThan(0);
    const liqAfter = trading.view(account.id).positions[0]?.liqPrice as number;
    expect(liqAfter).toBe(Math.floor(after.debt_cents / after.shares));
    expect(liqAfter).toBeGreaterThanOrEqual(liqBefore);
    // With nothing borrowed the liquidator is not bothered.
    const none = await setup();
    none.run(3_600);
    expect(none.changes()).toBe(0);
  }, LONG);
});

describe('Margin: the borrow fee on a short', () => {
  it('MARGIN-10: a short pays a fee out of the money from its sale (its credit): the credit shrinks, the margin and shares do not', async () => {
    const { world, row, run, bigShort, trading, account } = await setup();
    const out = bigShort();
    const before = row();
    expect(before.short).toBe(1);
    expect(before.credit_cents).toBe(out.trade.totalCents);
    const company = world.companies[0] as { sector: string; liquidity: number };
    const bps = borrowBps(company);
    run(86_400);
    const after = row();
    const expected = owed(before.credit_cents, bps, 86_400);
    expect(expected).toBeGreaterThan(0);
    expect(Math.abs(after.charged_cents - expected)).toBeLessThanOrEqual(2);
    expect(before.credit_cents - after.credit_cents).toBe(after.charged_cents);
    expect(after.cost_cents).toBe(before.cost_cents);
    expect(after.shares).toBe(before.shares);
    expect(after.debt_cents).toBe(0);
    const p = trading.view(account.id).positions[0];
    expect(p).toMatchObject({ short: true, creditCents: after.credit_cents, chargedCents: after.charged_cents, rateBps: bps });
    // Less money held means the market closes the short sooner (at a lower price).
    expect(p?.liqPrice).toBe(Math.ceil((after.credit_cents + after.cost_cents) / after.shares));
  }, LONG);

  it('MARGIN-11: the fee never takes more than the money held, even after a very long time', async () => {
    const { db, world, row, bigShort, costs, account } = await setup();
    bigShort();
    const before = row();
    const paid = costs.settle(account.id, 0, world.sim.tick + 1_000 * TICKS_PER_YEAR);
    expect(paid).toBe(before.credit_cents);
    const after = row();
    expect(after.credit_cents).toBe(0);
    expect(after.charged_cents).toBe(before.credit_cents);
    expect(after.cost_cents).toBe(before.cost_cents);
    // A short with nothing held costs nothing more.
    expect(costs.settle(account.id, 0, world.sim.tick + 2_000 * TICKS_PER_YEAR)).toBe(0);
    expect(db.get('SELECT COUNT(*) AS n FROM positions')).toEqual({ n: 1 });
  }, LONG);

  it('MARGIN-12: covering after a day pays the fee first: what comes back is the money held, less the fee, less the cost of buying back', async () => {
    const { world, trading, row, run, bigShort, order, cash } = await setup(12, false);
    bigShort();
    const first = row();
    run(86_400);
    const tick = world.sim.tick;
    const fee = Math.min(first.credit_cents, owed(first.credit_cents, borrowBps(world.companies[0] as { sector: string; liquidity: number }), tick - (first.accrued_tick as number)));
    expect(fee).toBeGreaterThan(0);
    const cashBefore = cash();
    const out = trading.placeOrder(order({ side: 'buy', short: true, qty: first.shares }));
    const collateral = first.credit_cents - fee + first.cost_cents;
    expect(cash()).toBe(cashBefore + Math.max(0, collateral - out.trade.totalCents));
  }, LONG);
});

describe('Margin: who pays, and what the player is told', () => {
  it('MARGIN-13: a 1v1 match account pays nothing', async () => {
    const { trading, user, db, run, world } = await setup();
    const match = trading.createMatchAccount(user.id, 1, 100_000);
    const max = trading.estimate(match.id, 0, 'buy', 1, undefined, 50).maxQty;
    trading.placeOrder({ accountId: match.id, clientOrderId: 'match-order-000001', companyId: 0, side: 'buy', qty: max, leverage: 50 });
    const before = db.get<PositionRow>('SELECT shares, cost_cents, debt_cents, credit_cents, short, accrued_tick, charged_cents FROM positions WHERE account_id = ?', match.id) as PositionRow;
    expect(before.debt_cents).toBeGreaterThan(4_000_000);
    expect(before.accrued_tick).toBeNull();
    run(7_200);
    const after = db.get<PositionRow>('SELECT shares, cost_cents, debt_cents, credit_cents, short, accrued_tick, charged_cents FROM positions WHERE account_id = ?', match.id) as PositionRow;
    expect(after.debt_cents).toBe(before.debt_cents);
    expect(after.charged_cents).toBe(0);
    expect(after.accrued_tick).toBeNull();
    const view = trading.view(match.id).positions[0];
    expect(view).toMatchObject({ rateBps: 0, costDayCents: 0, chargedCents: 0 });
    // The estimate of a match order has no rate either.
    expect(trading.estimate(match.id, 0, 'buy', 10, undefined, 20)).toMatchObject({ rateBps: 0, costDayCents: 0 });
    void world;
  }, LONG);

  it('MARGIN-14: the estimate says what the order will cost to borrow, before it is placed', async () => {
    const { trading, account, world } = await setup();
    const company = world.companies[0] as { sector: string; liquidity: number };
    const buy = trading.estimate(account.id, 0, 'buy', 30, undefined, 10);
    expect(buy.debtCents).toBeGreaterThan(0);
    expect(buy.rateBps).toBe(1000);
    expect(buy.costDayCents).toBe(costPerDay(buy.debtCents, 1000));
    // 1× borrows nothing.
    expect(trading.estimate(account.id, 0, 'buy', 30, undefined, 1)).toMatchObject({ rateBps: 0, costDayCents: 0 });
    // A short always borrows shares, at any leverage.
    for (const lev of [1, 5]) {
      const short = trading.estimate(account.id, 0, 'sell', 30, undefined, lev, true);
      expect(short.rateBps).toBe(borrowBps(company));
      expect(short.costDayCents).toBe(costPerDay(short.creditCents, borrowBps(company)));
    }
    // Closing costs nothing new, and a visitor (no account) sees the same rates as a player.
    expect(trading.estimate(null, 0, 'buy', 30, undefined, 10).rateBps).toBe(1000);
  }, LONG);

  it('MARGIN-15: an order for a different company never charges another position, and a refused order charges nothing', async () => {
    const { world, trading, row, run, bigLong, order, rejects2 } = await setup2();
    bigLong(0.7);
    const first = row();
    run(86_400);
    // An order for another company: this position is not touched (it will be charged by the minute step or its own next order).
    trading.placeOrder(order({ side: 'buy', qty: 1, companyId: 1 }));
    expect(row().debt_cents).toBe(first.debt_cents);
    // A refused order for this position rolls the charge back with the rest.
    const err = rejects2(() => trading.placeOrder(order({ side: 'sell', qty: first.shares + 5 })));
    expect(err.code).toBe('insufficient_shares');
    expect(row().debt_cents).toBe(first.debt_cents);
    expect(row().charged_cents).toBe(0);
    expect(world.sim.tick).toBeGreaterThan(first.accrued_tick as number);
  }, LONG);
});

/** setup(), with the observer off (only orders charge) and a helper that checks an order is refused. */
async function setup2() {
  const s = await setup(12, false);
  const rejects2 = (fn: () => unknown): OrderError => {
    try {
      fn();
    } catch (e) {
      if (e instanceof OrderError) return e;
      throw e;
    }
    throw new Error('expected the order to be rejected');
  };
  return { ...s, rejects2 };
}

// ---- the margin call ----------------------------------------------------------------------------------------------------------

describe('Margin: the margin call', () => {
  /** A market whose prices the test controls. */
  function control(world: { companies: readonly { sector: string; liquidity: number }[]; sim: { price(i: number): number } }, prices: Map<number, number>, listed = true) {
    return { companies: world.companies, sim: { price: (i: number) => prices.get(i) ?? world.sim.price(i), isListed: () => listed } };
  }

  it('MARGIN-16: a long that has lost three quarters of its margin gets one warning with the numbers; checked every 5 ticks; it can warn again after a recovery', async () => {
    expect(MARGIN_CALL_SHARE).toBe(0.25);
    expect(MARGIN_CALL_RESET).toBe(0.5);
    expect(WARN_EVERY_TICKS).toBe(5);
    const { trading, db, world, order, account, row } = await setup(12, false);
    const prices = new Map<number, number>();
    const mc = new MarginCosts(db, control(world, prices), () => undefined);
    trading.placeOrder(order({ side: 'buy', qty: 40, leverage: 10 }));
    const p = row();
    const price = (equityShare: number): number => Math.ceil((p.debt_cents + equityShare * p.cost_cents) / p.shares);
    // Healthy: nothing.
    prices.set(0, price(1));
    expect(mc.warnings(1000)).toEqual([]);
    // 40 % left: still nothing.
    prices.set(0, price(0.4));
    expect(mc.warnings(1005)).toEqual([]);
    // 20 % left: a warning, but only on a tick that is a multiple of 5.
    prices.set(0, price(0.2));
    expect(mc.warnings(1007)).toEqual([]);
    const calls = mc.warnings(1010);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call).toMatchObject({ accountId: account.id, companyId: 0, short: false, shares: 40, priceCents: price(0.2), tick: 1010 });
    expect(call?.liqPriceCents).toBe(Math.floor(p.debt_cents / p.shares));
    expect(call?.leverage).toBeGreaterThan(9.9);
    expect(call?.leverage).toBeLessThanOrEqual(10);
    expect(call?.unrealizedCents).toBe(equityOf({ shares: 40, costCents: p.cost_cents, debtCents: p.debt_cents, short: false, creditCents: 0 }, price(0.2)) - p.cost_cents);
    expect(call?.unrealizedCents).toBeLessThan(0);
    // Once.
    expect(mc.warnings(1015)).toEqual([]);
    prices.set(0, price(0.1));
    expect(mc.warnings(1020)).toEqual([]);
    // Back above half: it is armed again (and says nothing while it is healthy), then a new fall warns again.
    prices.set(0, price(0.7));
    expect(mc.warnings(1025)).toEqual([]);
    prices.set(0, price(0.3)); // between 25 % and 50 % is not a call
    expect(mc.warnings(1030)).toEqual([]);
    prices.set(0, price(0.15));
    expect(mc.warnings(1035)).toHaveLength(1);
  }, LONG);

  it('MARGIN-17: a position with nothing left is not warned (the market closes it), and a plain 1× long never is', async () => {
    const { trading, db, world, order, row } = await setup(12, false);
    const prices = new Map<number, number>();
    const mc = new MarginCosts(db, control(world, prices), () => undefined);
    trading.placeOrder(order({ side: 'buy', qty: 40, leverage: 10 }));
    trading.placeOrder(order({ side: 'buy', qty: 5, companyId: 1 })); // 1×
    const p = row();
    prices.set(0, Math.floor(p.debt_cents / p.shares)); // wiped out
    prices.set(1, 1); // the 1× long is down 99 %
    expect(mc.warnings(2000)).toEqual([]);
    // A company that is not trading is left alone.
    prices.set(0, Math.ceil((p.debt_cents + 0.1 * p.cost_cents) / p.shares));
    const unlisted = new MarginCosts(db, control(world, prices, false), () => undefined);
    expect(unlisted.warnings(2005)).toEqual([]);
    expect(mc.warnings(2005)).toHaveLength(1);
  }, LONG);

  it('MARGIN-18: a short is warned when the price has risen enough to leave a quarter of its margin', async () => {
    const { trading, db, world, order, account, row } = await setup(12, false);
    const prices = new Map<number, number>();
    const mc = new MarginCosts(db, control(world, prices), () => undefined);
    trading.placeOrder(order({ side: 'sell', short: true, qty: 40, leverage: 10 }));
    const p = row();
    const collateral = p.credit_cents + p.cost_cents;
    const at = (equityShare: number): number => Math.floor((collateral - equityShare * p.cost_cents) / p.shares);
    prices.set(0, at(0.6));
    expect(mc.warnings(3000)).toEqual([]);
    prices.set(0, at(0.2));
    const calls = mc.warnings(3005);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ accountId: account.id, short: true, shares: 40, priceCents: at(0.2) });
    expect(calls[0]?.liqPriceCents).toBe(Math.ceil(collateral / p.shares));
    expect(mc.warnings(3010)).toEqual([]);
  }, LONG);

  it('MARGIN-19: a 1v1 match account is never warned', async () => {
    const { trading, db, world, user } = await setup(12, false);
    const prices = new Map<number, number>();
    const mc = new MarginCosts(db, control(world, prices), () => undefined);
    const match = trading.createMatchAccount(user.id, 1, 100_000);
    trading.placeOrder({ accountId: match.id, clientOrderId: 'match-order-000001', companyId: 0, side: 'buy', qty: 40, leverage: 10 });
    prices.set(0, 1);
    expect(mc.warnings(4000)).toEqual([]);
  }, LONG);
});

// ---- the database -------------------------------------------------------------------------------------------------------------

describe('Margin: the database', () => {
  it('MARGIN-20: schema 16 adds the clock and the sum; a position from before it starts paying from the first look, with no back charge', () => {
    expect(MIGRATIONS[MIGRATIONS.length - 1]?.version).toBeGreaterThanOrEqual(16);
    const db = new Db(':memory:');
    for (const m of MIGRATIONS) {
      if (m.version > 15) break;
      db.exec(m.sql);
      db.exec(`PRAGMA user_version = ${m.version}`);
    }
    db.exec("INSERT INTO users(username, display_name, pw_hash, role, created_ms) VALUES ('old', 'old', 'x', 'player', 1)");
    db.exec("INSERT INTO accounts(user_id, kind, cash_cents, start_cash_cents, created_ms) VALUES (1, 'career', 90000, 100000, 1)");
    // 5 256 000 cents of debt: at 10 % a year that is one cent every 60 ticks.
    db.exec('INSERT INTO positions(account_id, company_id, shares, cost_cents, debt_cents) VALUES (1, 0, 5, 105120, 5256000)');
    expect(migrate(db)).toEqual(MIGRATIONS.filter((m) => m.version > 15).map((m) => m.version));
    expect(db.get('SELECT accrued_tick, charged_cents FROM positions')).toEqual({ accrued_tick: null, charged_cents: 0 });
    expect(() => db.exec('UPDATE positions SET charged_cents = -1')).toThrow();

    const company = { sector: 'tech', liquidity: 0.5 };
    const costs = new MarginCosts(db, { companies: [company], sim: { price: () => 100_000, isListed: () => true } }, () => undefined);
    expect(costs.settle(1, 0, 1_000)).toBe(0); // the first look only starts the clock
    expect(db.get('SELECT accrued_tick, charged_cents, debt_cents FROM positions')).toEqual({ accrued_tick: 1_000, charged_cents: 0, debt_cents: 5_256_000 });
    expect(costs.settle(1, 0, 1_059)).toBe(0);
    expect(costs.settle(1, 0, 1_060)).toBe(1);
    expect(db.get('SELECT accrued_tick, charged_cents, debt_cents FROM positions')).toEqual({ accrued_tick: 1_060, charged_cents: 1, debt_cents: 5_256_001 });
    // A tick that is not later than the clock charges nothing.
    expect(costs.settle(1, 0, 1_060)).toBe(0);
    expect(costs.settle(1, 0, 900)).toBe(0);
    // step() only works on whole minutes.
    costs.step(1_100);
    expect(db.get('SELECT charged_cents FROM positions')).toEqual({ charged_cents: 1 });
    costs.step(1_200);
    expect(db.get<{ charged_cents: number }>('SELECT charged_cents FROM positions')?.charged_cents).toBe(3);
    db.close();
  });
});

// ---- the whole program: the web API, a restart, the live warning --------------------------------------------------------------

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
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'tq-margin-'));
  if (!options.dir) dirs.push(dir);
  const clock = options.clock ?? new Clock();
  const config = loadConfig({ TQ_DATA_DIR: dir, TQ_COMPANIES: '66', TQ_WARMUP_DAYS: '1', TQ_PORT: '8787', TQ_OWNER: 'boss' });
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
const market = async (r: Running) => (await call(r, '/api/market')).json.companies as any[];
const cheapLarge = async (r: Running) => (await market(r)).filter((c) => c.trading && c.tier === 'large').sort((a, b) => a.price - b.price)[0];
const sharesFor = (co: { price: number }): number => Math.max(1, Math.floor(80_000 / co.price));

describe('Margin: over the web API, with a restart', () => {
  it('MARGIN-21: the account shows the rate and what has been paid; a day later the debt has grown; a day with the server off is charged too, and the same', async () => {
    let r = await boot();
    const alice = await signUp(r, 'alice');
    advance(r, 60);
    const co = await cheapLarge(r);
    const n = sharesFor(co);
    // 2×: the market will not close it for a fall of less than half, so the day is only about interest.
    expect((await trade(r, alice, { ticker: co.ticker, qty: n, leverage: 2 })).status).toBe(201);
    const opened = (await account(r, alice)).positions[0];
    expect(opened).toMatchObject({ ticker: co.ticker, rateBps: 1000, chargedCents: 0 });
    expect(opened.debtCents).toBeGreaterThan(30_000);
    advance(r, 86_400);
    const day1 = (await account(r, alice)).positions[0];
    const expected1 = owed(opened.debtCents, 1000, 86_400);
    expect(expected1).toBeGreaterThan(5);
    expect(Math.abs(day1.chargedCents - expected1)).toBeLessThanOrEqual(2);
    expect(day1.debtCents - opened.debtCents).toBe(day1.chargedCents);
    expect(day1.costDayCents).toBe(costPerDay(day1.debtCents, 1000));

    // The server is off for a day: the minutes it missed are charged when it starts again.
    const clock = r.clock;
    const dir = r.dir;
    await stop(r);
    running.splice(running.indexOf(r), 1);
    clock.advanceSeconds(86_400);
    r = await boot({ dir, clock });
    expect(r.app.services.world.sim.tick).toBe(r.app.services.world.currentTick());
    const day2 = (await account(r, alice)).positions[0];
    expect(day2.shares).toBe(n);
    const expected2 = owed(day1.debtCents, 1000, 86_400);
    expect(Math.abs(day2.chargedCents - day1.chargedCents - expected2)).toBeLessThanOrEqual(2);
    expect(day2.debtCents - day1.debtCents).toBe(day2.chargedCents - day1.chargedCents);
  }, LONG);

  it('MARGIN-22: the live warning reaches only the player who owns the position, once, before the market closes it', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const bob = await signUp(r, 'bob');
    const boss = await signUp(r, 'boss');
    advance(r, 60);
    const co = await cheapLarge(r);
    const n = sharesFor(co);
    expect((await trade(r, alice, { ticker: co.ticker, qty: n, leverage: 10 })).status).toBe(201);
    expect((await trade(r, bob, { ticker: co.ticker, qty: n })).status).toBe(201);
    const aliceId = r.app.services.db.get<{ id: number }>("SELECT id FROM users WHERE username = 'alice'")!.id;
    const pos = (await account(r, alice)).positions[0];
    const got: { userId: number; data: any }[] = [];
    const publish = r.app.services.hub.publishTo.bind(r.app.services.hub);
    r.app.services.hub.publishTo = (userId: number, event: string, data: unknown) => {
      if (event === 'position') got.push({ userId, data });
      publish(userId, event, data);
    };
    // A fall of 8.8 % takes a 10× position from full margin to about an eighth of it; a wipe-out needs 10 %.
    expect((await post(r, '/api/admin/shock', boss, { ticker: co.ticker, percent: -8.8, style: 'crash', speed: 'slow' })).status).toBe(200);
    // The warning is only sent while the market is live (not while it catches up), so let the clock run in small steps like the real one.
    for (let i = 0; i < 2_000; i += 1) advance(r, 2);
    const calls = got.filter((g) => g.data.reason === 'margin_call');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.userId).toBe(aliceId);
    expect(calls[0]?.data).toMatchObject({ reason: 'margin_call', account: 'career', ticker: co.ticker, short: false, shares: n });
    expect(calls[0]?.data.realizedCents).toBeLessThan(0);
    expect(Math.abs(calls[0]?.data.liqPriceCents - Math.floor(pos.debtCents / n))).toBeLessThanOrEqual(2);
    // Nobody else heard about it, and when the market closes the position (or not), the warning came first.
    expect(got.filter((g) => g.userId !== aliceId)).toEqual([]);
    const reasons = got.map((g) => g.data.reason);
    if (reasons.includes('liquidated')) expect(reasons.indexOf('margin_call')).toBeLessThan(reasons.indexOf('liquidated'));
    expect((await account(r, bob)).positions[0]?.shares).toBe(n);
    expect(r.app.services.world.health().ok).toBe(true);
  }, LONG);

  it('MARGIN-23: the order form\'s preview over the web API carries the yearly rate and the cost per day (the form shows them from these numbers)', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    advance(r, 60);
    const co = await cheapLarge(r);
    const n = sharesFor(co);
    const est = async (q: string, cookie?: string) => (await call(r, `/api/market/${co.ticker}/estimate?${q}`, { cookie })).json;
    // A levered buy: interest on the debt it would take on.
    const buy = await est(`side=buy&qty=${n}&account=career&leverage=10`, alice);
    expect(buy.debtCents).toBeGreaterThan(0);
    expect(buy).toMatchObject({ rateBps: 1000, costDayCents: costPerDay(buy.debtCents, 1000) });
    // An unlevered buy borrows nothing.
    expect(await est(`side=buy&qty=${n}&account=career`, alice)).toMatchObject({ rateBps: 0, costDayCents: 0 });
    // A short sale: the borrow fee on the money from the sale (between the cheapest and the dearest stock rate).
    const sale = await est(`side=sell&qty=${n}&account=career&short=1`, alice);
    expect(sale.creditCents).toBeGreaterThan(0);
    expect(sale.rateBps).toBeGreaterThanOrEqual(50);
    expect(sale.rateBps).toBeLessThanOrEqual(1050);
    expect(sale.costDayCents).toBe(costPerDay(sale.creditCents, sale.rateBps));
    // Without signing in the numbers are the same; in a match nothing is charged (checked above on the rules).
    expect((await est(`side=buy&qty=${n}&leverage=10`)).rateBps).toBe(1000);
  }, LONG);
});
