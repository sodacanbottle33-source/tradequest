// The memecoin trading fee (docs/world.md §6.6, server/fees.ts). Only memecoin orders pay one (0.5 % of the order's value, rounded up to a
// whole cent), only in Career, and on every kind of order: buy, sell, short, cover and the closing the market does by itself when a
// stop-loss or take-profit is reached. Opening pays it on top of the margin, closing pays it out of what comes back (never more than
// that). The market's own liquidation pays none. Checked here: the rounding, the money to the cent for every kind of order, the
// estimates and "how many can I afford", the refusals, 1v1 accounts, stocks, duplicates, the new database column and the web API.
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CURATED } from '../src/world';
import { createApp, type App } from '../server/app';
import { Auth } from '../server/auth';
import { loadConfig } from '../server/config';
import { MEME_FEE_BPS, feeOf } from '../server/fees';
import { marginOf, shortLiquidationPrice } from '../server/leverage';
import { Liquidator, type LiquidationWorld } from '../server/liquidation';
import { Logger } from '../server/log';
import { MIGRATIONS, migrate } from '../server/schema';
import { Db } from '../server/sqlite';
import { OrderError, Trading, type OrderRequest } from '../server/trading';
import { Clock, makeRig, type Rig } from './helpers/server';

const LONG = 240_000;
const START = 100_000; // a Career account starts with $1,000

describe('The fee itself', () => {
  it('FEE-1: 0.5 % of the order value, rounded UP to a whole cent, exact for huge orders; no value or no rate means no fee', () => {
    expect(MEME_FEE_BPS).toBe(50);
    expect(feeOf(100_000, 50)).toBe(500); // $1,000 → $5.00
    expect(feeOf(1, 50)).toBe(1); // any real order pays at least a cent
    expect(feeOf(199, 50)).toBe(1); // 0.995 → 1
    expect(feeOf(200, 50)).toBe(1); // exactly 1.00
    expect(feeOf(201, 50)).toBe(2); // 1.005 → 2 (up)
    expect(feeOf(12_345, 50)).toBe(62); // 61.725 → 62
    expect(feeOf(0, 50)).toBe(0);
    expect(feeOf(-5, 50)).toBe(0);
    expect(feeOf(100_000, 0)).toBe(0);
    expect(feeOf(100_000, 10_000)).toBe(100_000); // 100 %
    // Exact with BigInt however large: 0.5 % of 9 007 199 254 740 991 cents.
    expect(feeOf(Number.MAX_SAFE_INTEGER, 50)).toBe(Number((BigInt(Number.MAX_SAFE_INTEGER) * BigInt(50) + BigInt(9_999)) / BigInt(10_000)));
  });

  it('FEE-2: a fee rate that is not a whole number of basis points from 0 to 10000 is refused when the program starts', () => {
    const rig = makeRig();
    rigs.push(rig);
    const { db, world } = rig.open({ companyCount: 12 });
    for (const bad of [-1, 0.5, 10_001, Number.NaN]) expect(() => new Trading(db, world, rig.clock.now, bad)).toThrow(/basis points/);
    expect(() => new Trading(db, world, rig.clock.now, 0)).not.toThrow();
  });
});

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
}

/** A world with the thirty coins listed and one registered player. The market does not move between orders (the clock stands still). */
async function setup(feeBps?: number) {
  const rig = makeRig();
  rigs.push(rig);
  const { db, world } = rig.open({ companyCount: CURATED.length, memecoins: true, warmupDays: 1 });
  for (let step = 0; step < 4; step += 1) {
    rig.clock.advanceSeconds(300);
    world.advanceTo(world.currentTick(), Infinity);
  }
  const auth = new Auth(db, rig.clock.now, '');
  const trading = new Trading(db, world, rig.clock.now, feeBps);
  const { user } = await auth.register('alice', 'correct horse', '127.0.0.1');
  const account = trading.careerAccountOf(user.id);
  const coin = CURATED.length; // the first coin
  expect(world.companies[coin]?.sector).toBe('meme');
  expect(world.sim.isListed(coin)).toBe(true);
  let n = 0;
  const order = (partial: Partial<OrderRequest> & Pick<OrderRequest, 'side' | 'qty'>): OrderRequest => ({
    accountId: account.id,
    clientOrderId: `order-${String(++n).padStart(6, '0')}`,
    companyId: coin,
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
  const position = (companyId = coin) =>
    db.get<PosRow>('SELECT shares, cost_cents, debt_cents, short, credit_cents FROM positions WHERE account_id = ? AND company_id = ?', account.id, companyId);
  const cash = (): number => (db.get<{ cash_cents: number }>('SELECT cash_cents FROM accounts WHERE id = ?', account.id) as { cash_cents: number }).cash_cents;
  const mid = world.sim.price(coin);
  /** About $300 worth of the coin. */
  const qty = Math.max(2, Math.floor(30_000 / mid));
  return { rig, db, world, auth, trading, user, account, coin, order, rejects, position, cash, mid, qty };
}

describe('Memecoin orders pay the fee', () => {
  it('FEE-3: a plain buy pays the shares plus the fee on top; the position costs the shares only; the fee is a loss the moment it is paid', async () => {
    const { trading, account, order, position, cash, qty } = await setup();
    const out = trading.placeOrder(order({ side: 'buy', qty }));
    const total = out.trade.totalCents;
    const fee = feeOf(total, 50);
    expect(fee).toBeGreaterThan(0);
    expect(out.trade.feeCents).toBe(fee);
    expect(cash()).toBe(START - total - fee);
    expect(position()).toMatchObject({ shares: out.trade.filled, cost_cents: total, debt_cents: 0, short: 0, credit_cents: 0 });
    expect(out.trade.realizedCents).toBe(-fee);
    const v = trading.view(account.id);
    expect(v.realizedCents).toBe(-fee);
    // Net worth is cash plus what the shares could be sold for: down by the fee and the spread.
    expect(v.profitCents).toBe(v.netWorthCents - START);
    expect(v.profitCents).toBe(v.realizedCents + (v.positions[0]?.unrealizedCents as number));
  }, LONG);

  it('FEE-4: a sell pays the fee out of the proceeds; the whole round trip costs the spread plus the two fees, and every cent is in the realized figures', async () => {
    const { trading, account, order, position, cash, qty } = await setup();
    const buy = trading.placeOrder(order({ side: 'buy', qty }));
    const held = position()?.shares as number;
    const before = cash();
    const sell = trading.placeOrder(order({ side: 'sell', qty: held }));
    const feeBuy = feeOf(buy.trade.totalCents, 50);
    const feeSell = feeOf(sell.trade.totalCents, 50);
    expect(sell.trade.feeCents).toBe(feeSell);
    expect(cash()).toBe(before + sell.trade.totalCents - feeSell);
    expect(sell.trade.realizedCents).toBe(sell.trade.totalCents - feeSell - buy.trade.totalCents);
    expect(position()).toBeUndefined();
    expect(cash()).toBe(START - buy.trade.totalCents - feeBuy + sell.trade.totalCents - feeSell);
    expect(trading.view(account.id).realizedCents).toBe(cash() - START);
    expect(trading.trades(account.id, 5).map((t) => t.feeCents)).toEqual([feeSell, feeBuy]);
  }, LONG);

  it('FEE-5: a partial sell pays the fee of the part sold; the rest of the position is untouched', async () => {
    const { trading, order, position, cash, qty } = await setup();
    trading.placeOrder(order({ side: 'buy', qty: qty * 2 }));
    const before = position() as PosRow;
    const half = Math.floor(before.shares / 2);
    const cashBefore = cash();
    const sell = trading.placeOrder(order({ side: 'sell', qty: half }));
    const removed = Number((BigInt(before.cost_cents) * BigInt(half)) / BigInt(before.shares));
    expect(sell.trade.feeCents).toBe(feeOf(sell.trade.totalCents, 50));
    expect(cash()).toBe(cashBefore + sell.trade.totalCents - sell.trade.feeCents);
    expect(sell.trade.realizedCents).toBe(sell.trade.totalCents - sell.trade.feeCents - removed);
    expect(position()).toMatchObject({ shares: before.shares - half, cost_cents: before.cost_cents - removed });
  }, LONG);

  it('FEE-6: with leverage the fee is on the VALUE of the order, not on the margin; selling repays the debt first and pays the fee out of what is left', async () => {
    const { trading, order, position, cash, qty } = await setup();
    const buy = trading.placeOrder(order({ side: 'buy', qty, leverage: 10 }));
    const total = buy.trade.totalCents;
    const margin = marginOf(total, 10);
    const fee = feeOf(total, 50);
    expect(buy.trade.feeCents).toBe(fee);
    expect(fee).toBeGreaterThan(feeOf(margin, 50) * 9); // ten times the margin's fee, give or take rounding
    expect(cash()).toBe(START - margin - fee);
    expect(position()).toMatchObject({ cost_cents: margin, debt_cents: total - margin });
    const before = cash();
    const sell = trading.placeOrder(order({ side: 'sell', qty: position()?.shares as number }));
    const proceeds = Math.max(0, sell.trade.totalCents - (total - margin));
    const sellFee = Math.min(feeOf(sell.trade.totalCents, 50), proceeds);
    expect(sell.trade.feeCents).toBe(sellFee);
    expect(cash()).toBe(before + proceeds - sellFee);
    expect(sell.trade.realizedCents).toBe(proceeds - sellFee - margin);
    expect(position()).toBeUndefined();
  }, LONG);

  it('FEE-7: a short pays the fee on top of the margin when it opens, and out of what comes back when it is covered', async () => {
    const { trading, account, order, position, cash, qty } = await setup();
    const open = trading.placeOrder(order({ side: 'sell', short: true, qty, leverage: 5 }));
    const credit = open.trade.totalCents;
    const margin = marginOf(credit, 5);
    const openFee = feeOf(credit, 50);
    expect(open.trade).toMatchObject({ feeCents: openFee, realizedCents: -openFee, short: true });
    expect(cash()).toBe(START - margin - openFee);
    expect(position()).toMatchObject({ cost_cents: margin, credit_cents: credit, short: 1 });
    const before = cash();
    const cover = trading.placeOrder(order({ side: 'buy', short: true, qty: position()?.shares as number }));
    const back = Math.max(0, credit + margin - cover.trade.totalCents);
    const coverFee = Math.min(feeOf(cover.trade.totalCents, 50), back);
    expect(cover.trade.feeCents).toBe(coverFee);
    expect(cash()).toBe(before + back - coverFee);
    expect(cover.trade.realizedCents).toBe(back - coverFee - margin);
    expect(position()).toBeUndefined();
    expect(trading.view(account.id).realizedCents).toBe(cash() - START);
  }, LONG);

  it('FEE-8: a position that comes back with nothing pays no fee; one that comes back with less than the fee pays only what comes back', async () => {
    const { trading, db, account, order, position, cash, qty, coin } = await setup();
    trading.placeOrder(order({ side: 'buy', qty, leverage: 10 }));
    const shares = position()?.shares as number;
    const sellTotal = trading.estimate(account.id, coin, 'sell', shares).totalCents;
    // Debt almost as large as the sale: 1 cent is left after the debt, and the fee (more than 1 cent) can take only that.
    db.run('UPDATE positions SET debt_cents = ? WHERE account_id = ? AND company_id = ?', sellTotal - 1, account.id, coin);
    const est = trading.estimate(account.id, coin, 'sell', shares);
    expect(est).toMatchObject({ feeCents: 1, netCents: 0, feeBps: 50 });
    const before = cash();
    const sell = trading.placeOrder(order({ side: 'sell', qty: shares }));
    expect(sell.trade.feeCents).toBe(1);
    expect(cash()).toBe(before);
    // Underwater: nothing comes back, so no fee.
    trading.placeOrder(order({ side: 'buy', qty, leverage: 10 }));
    const s2 = position()?.shares as number;
    const lost = position()?.cost_cents as number;
    db.run('UPDATE positions SET debt_cents = ? WHERE account_id = ? AND company_id = ?', 10_000_000, account.id, coin);
    const cash2 = cash();
    const sell2 = trading.placeOrder(order({ side: 'sell', qty: s2 }));
    expect(sell2.trade.feeCents).toBe(0);
    expect(cash()).toBe(cash2);
    expect(sell2.trade.realizedCents).toBe(-lost); // the margin is gone, and no fee on top of that
  }, LONG);

  it('FEE-9: the closing the market does by itself at a stop-loss or take-profit pays the fee like an ordinary sale', async () => {
    const { trading, account, order, position, cash, qty, coin, world } = await setup();
    trading.placeOrder(order({ side: 'buy', qty }));
    const shares = position()?.shares as number;
    const costBefore = position()?.cost_cents as number;
    const before = cash();
    const t = trading.closeByExit(account.id, coin, 'stop', world.sim.tick) as NonNullable<ReturnType<Trading['closeByExit']>>;
    expect(t).toMatchObject({ auto: 'stop', side: 'sell', filled: shares });
    expect(t.feeCents).toBe(feeOf(t.totalCents, 50));
    expect(t.feeCents).toBeGreaterThan(0);
    expect(cash()).toBe(before + t.totalCents - t.feeCents);
    expect(t.realizedCents).toBe(t.totalCents - t.feeCents - costBefore);
    // Same for a take-profit on a short.
    trading.placeOrder(order({ side: 'sell', short: true, qty, leverage: 3 }));
    const credit = (position() as PosRow).credit_cents;
    const margin = (position() as PosRow).cost_cents;
    const before2 = cash();
    const c = trading.closeByExit(account.id, coin, 'take', world.sim.tick) as NonNullable<ReturnType<Trading['closeByExit']>>;
    const back = Math.max(0, credit + margin - c.totalCents);
    expect(c).toMatchObject({ auto: 'take', side: 'buy', short: true });
    expect(c.feeCents).toBe(Math.min(feeOf(c.totalCents, 50), back));
    expect(cash()).toBe(before2 + back - c.feeCents);
  }, LONG);

  it('FEE-10: the market closing a wiped-out position (liquidation) carries no fee', async () => {
    const { trading, db, world, order, account, position, cash, coin, qty } = await setup();
    const prices = new Map<number, number>();
    const control: LiquidationWorld = { sim: { price: (i: number) => prices.get(i) ?? world.sim.price(i), isListed: () => true }, companies: world.companies, msOfTick: (t: number) => world.msOfTick(t) };
    const liq = new Liquidator({ db, world: control, log: new Logger({ sink: null }) });
    trading.setLeverageListener(() => liq.markDirty());
    const open = trading.placeOrder(order({ side: 'sell', short: true, qty, leverage: 20 }));
    const margin = marginOf(open.trade.totalCents, 20);
    const openFee = feeOf(open.trade.totalCents, 50);
    const level = shortLiquidationPrice(position()?.shares as number, open.trade.totalCents + margin);
    const cashAfter = cash();
    prices.set(coin, level);
    liq.step(world.sim.tick + 5);
    expect(position()).toBeUndefined();
    expect(cash()).toBe(cashAfter); // nothing comes back, and nothing more is taken
    const last = trading.trades(account.id, 1)[0];
    expect(last).toMatchObject({ liquidated: true, feeCents: 0, realizedCents: -margin });
    expect(trading.view(account.id).realizedCents).toBe(-openFee - margin);
  }, LONG);
});

describe('Estimates and refusals count the fee', () => {
  it('FEE-11: the estimate shows the fee and the rate; opening: net = margin + fee; closing: net = what comes back − fee; nothing changes', async () => {
    const { trading, db, account, order, position, cash, qty, coin } = await setup();
    const rows = () => JSON.stringify([db.all('SELECT * FROM positions'), db.all('SELECT * FROM trades'), cash()]);
    const snapshot = rows();
    const buy = trading.estimate(account.id, coin, 'buy', qty);
    expect(buy.feeBps).toBe(50);
    expect(buy.feeCents).toBe(feeOf(buy.totalCents, 50));
    expect(buy.netCents).toBe(buy.totalCents + buy.feeCents);
    const lev = trading.estimate(account.id, coin, 'buy', qty, undefined, 10);
    expect(lev.feeCents).toBe(feeOf(lev.totalCents, 50));
    expect(lev.netCents).toBe(marginOf(lev.totalCents, 10) + lev.feeCents);
    const short = trading.estimate(account.id, coin, 'sell', qty, undefined, 4, true);
    expect(short.netCents).toBe(marginOf(short.totalCents, 4) + short.feeCents);
    expect(short.feeCents).toBe(feeOf(short.totalCents, 50));
    expect(rows()).toBe(snapshot);
    // Closing.
    trading.placeOrder(order({ side: 'buy', qty }));
    const sell = trading.estimate(account.id, coin, 'sell', position()?.shares as number);
    expect(sell.netCents).toBe(sell.totalCents - sell.feeCents);
    expect(sell.feeCents).toBe(feeOf(sell.totalCents, 50));
  }, LONG);

  it('FEE-12: "how many can I afford" counts the fee: the most it names can be bought, one more cannot', async () => {
    const { trading, account, order, coin, cash, rejects } = await setup();
    const big = trading.estimate(account.id, coin, 'buy', 1_000_000);
    expect(big.maxQty).toBeGreaterThan(0);
    const atMax = trading.estimate(account.id, coin, 'buy', big.maxQty);
    expect(atMax.netCents).toBeLessThanOrEqual(cash());
    const over = trading.estimate(account.id, coin, 'buy', big.maxQty + 1);
    expect(over.netCents).toBeGreaterThan(cash());
    // And the same for a leveraged buy and a short.
    for (const lev of [5, 50]) {
      const b = trading.estimate(account.id, coin, 'buy', 1_000_000, undefined, lev);
      if (b.maxQty > 0) expect(trading.estimate(account.id, coin, 'buy', b.maxQty, undefined, lev).netCents).toBeLessThanOrEqual(cash());
      expect(trading.estimate(account.id, coin, 'buy', b.maxQty + 1, undefined, lev).netCents).toBeGreaterThan(cash());
      const s = trading.estimate(account.id, coin, 'sell', 1_000_000, undefined, lev, true);
      if (s.maxQty > 0) expect(trading.estimate(account.id, coin, 'sell', s.maxQty, undefined, lev, true).netCents).toBeLessThanOrEqual(cash());
      expect(trading.estimate(account.id, coin, 'sell', s.maxQty + 1, undefined, lev, true).netCents).toBeGreaterThan(cash());
    }
    // The most the estimate names can really be bought with the whole account.
    const done = trading.placeOrder(order({ side: 'buy', qty: big.maxQty }));
    expect(cash()).toBeGreaterThanOrEqual(0);
    expect(cash()).toBe(START - done.trade.totalCents - done.trade.feeCents);
    expect(rejects(() => trading.placeOrder(order({ side: 'buy', qty: big.maxQty + 50 }))).code).toBe('insufficient_cash');
  }, LONG);

  it('FEE-13: a buy the cash covers without the fee but not with it is refused, naming the fee and the real maximum; nothing changes', async () => {
    const { trading, db, account, order, coin, cash, rejects } = await setup();
    // Leave exactly the price of the shares: the fee is what is missing.
    const q = trading.estimate(account.id, coin, 'buy', 40);
    expect(q.filledQty).toBe(40);
    db.run('UPDATE accounts SET cash_cents = ? WHERE id = ?', q.totalCents, account.id);
    const err = rejects(() => trading.placeOrder(order({ side: 'buy', qty: 40 })));
    expect(err.code).toBe('insufficient_cash');
    expect(err.message).toContain('including a fee of');
    expect(err.details).toMatchObject({ cost: q.totalCents + q.feeCents, fee: q.feeCents, cash: q.totalCents });
    expect((err.details as { maxQty: number }).maxQty).toBeLessThan(40);
    expect(cash()).toBe(q.totalCents);
    expect(db.get('SELECT COUNT(*) AS n FROM trades')).toEqual({ n: 0 });
    // The same for a short.
    const s = trading.estimate(account.id, coin, 'sell', 40, undefined, 1, true);
    db.run('UPDATE accounts SET cash_cents = ? WHERE id = ?', s.totalCents, account.id);
    const err2 = rejects(() => trading.placeOrder(order({ side: 'sell', short: true, qty: 40 })));
    expect(err2.code).toBe('insufficient_cash');
    expect(err2.message).toContain('plus a fee of');
  }, LONG);

  it('FEE-14: the fee does not change the leverage rules: the highest leverage and the liquidation price are the same with and without it', async () => {
    const free = await setup(0);
    const paid = await setup();
    const a = free.trading.estimate(free.account.id, free.coin, 'buy', free.qty, undefined, 25);
    const b = paid.trading.estimate(paid.account.id, paid.coin, 'buy', paid.qty, undefined, 25);
    expect(b.maxLeverage).toBe(a.maxLeverage);
    expect(b.liqPrice).toBe(a.liqPrice);
    expect(b.totalCents).toBe(a.totalCents);
    expect(a.feeCents).toBe(0);
    expect(b.feeCents).toBeGreaterThan(0);
  }, LONG);
});

describe('Who pays the fee', () => {
  it('FEE-15: with no stock rate given stocks pay none (the game gives 0.1 %, tests/server-fees.test.ts); a 1v1 match account pays none, not even for a coin', async () => {
    const { trading, db, order, user, cash, account, position, qty } = await setup();
    const stock = trading.placeOrder(order({ companyId: 0, side: 'buy', qty: 5 }));
    expect(stock.trade.feeCents).toBe(0);
    expect(trading.estimate(account.id, 0, 'buy', 5)).toMatchObject({ feeCents: 0, feeBps: 0 });
    expect(position(0)?.shares).toBe(5);
    expect(cash()).toBe(START - stock.trade.totalCents);
    expect(stock.trade.realizedCents).toBe(0);
    // A match account.
    db.run("INSERT INTO matches(id, state, created_ms, start_tick, end_tick, duration_ticks, start_cash_cents) VALUES (1, 'live', 0, 1000, 1180, 180, 100000)");
    const acc = trading.createMatchAccount(user.id, 1, 100_000);
    const est = trading.estimate(acc.id, CURATED.length, 'buy', qty);
    expect(est).toMatchObject({ feeCents: 0, feeBps: 0 });
    const out = trading.placeOrder({ accountId: acc.id, clientOrderId: 'match-order-000001', companyId: CURATED.length, side: 'buy', qty });
    expect(out.trade.feeCents).toBe(0);
    expect(trading.view(acc.id).cashCents).toBe(100_000 - out.trade.totalCents);
  }, LONG);

  it('FEE-16: with the rate set to 0 nothing is charged anywhere', async () => {
    const { trading, order, cash, qty, position } = await setup(0);
    const buy = trading.placeOrder(order({ side: 'buy', qty }));
    expect(buy.trade.feeCents).toBe(0);
    expect(cash()).toBe(START - buy.trade.totalCents);
    const sell = trading.placeOrder(order({ side: 'sell', qty: position()?.shares as number }));
    expect(sell.trade.feeCents).toBe(0);
    expect(cash()).toBe(START - buy.trade.totalCents + sell.trade.totalCents);
  }, LONG);

  it('FEE-17: the same order id twice charges the fee once and returns the first result', async () => {
    const { trading, order, cash, qty } = await setup();
    const req = order({ side: 'buy', qty });
    const first = trading.placeOrder(req);
    const afterFirst = cash();
    const again = trading.placeOrder(req);
    expect(again.duplicate).toBe(true);
    expect(again.trade.feeCents).toBe(first.trade.feeCents);
    expect(cash()).toBe(afterFirst);
  }, LONG);
});

describe('The database column', () => {
  it('FEE-18: version 13 adds trades.fee_cents; trades saved before it say 0 and the column cannot go negative', () => {
    expect(MIGRATIONS[MIGRATIONS.length - 1]?.version).toBeGreaterThanOrEqual(14);
    const dir = mkdtempSync(join(tmpdir(), 'tq-fee-'));
    try {
      const db = new Db(join(dir, 'old.sqlite'));
      for (const m of MIGRATIONS.filter((x) => x.version <= 12)) {
        db.tx(() => {
          db.exec(m.sql);
          db.exec(`PRAGMA user_version = ${m.version}`);
        });
      }
      db.run("INSERT INTO users(id, username, display_name, pw_hash, created_ms) VALUES (1, 'a', 'a', 'x', 0)");
      db.run("INSERT INTO accounts(id, user_id, kind, cash_cents, start_cash_cents, created_ms) VALUES (1, 1, 'career', 100000, 100000, 0)");
      db.run("INSERT INTO trades(account_id, client_order_id, company_id, side, requested, filled, total_cents, mid_cents, spread_cents, impact_cents, realized_cents, tick, created_ms, result_json) VALUES (1, 'old-order-0001', 0, 'buy', 1, 1, 500, 500, 0, 0, 0, 1, 0, '{}')");
      expect(migrate(db).filter((v) => v <= 15)).toEqual([13, 14, 15]);
      expect(db.get('SELECT fee_cents FROM trades')).toEqual({ fee_cents: 0 });
      expect(() => db.run("UPDATE trades SET fee_cents = -1")).toThrow();
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- the web API --------------------------------------------------------------------------------------------------------------

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
  while (running.length > 0) {
    const r = running.pop() as Running;
    await new Promise<void>((done) => {
      r.server.closeAllConnections?.();
      r.server.close(() => done());
    });
    try {
      r.app.close();
    } catch {
      // already closed
    }
  }
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

async function boot(): Promise<Running> {
  const dir = mkdtempSync(join(tmpdir(), 'tq-memefee-'));
  dirs.push(dir);
  const clock = new Clock();
  const config = loadConfig({ TQ_DATA_DIR: dir, TQ_COMPANIES: '66', TQ_WARMUP_DAYS: '1', TQ_PORT: '8787', TQ_OWNER: 'boss' });
  const app = createApp({ config, log: new Logger({ sink: null, now: clock.now }), worldSeed: 777, now: clock.now, flowGain: 0, autoPauses: false, memecoins: true });
  const server = createServer(app.handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const r = { app, server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, dir, clock };
  running.push(r);
  return r;
}

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

describe('The fee over the web API', () => {
  it('FEE-19: the estimate, the order and the trade list all carry the fee; a stock carries none', async () => {
    const r = await boot();
    const reg = await fetch(r.base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'alice', password: 'a-good-password' }) });
    expect(reg.status).toBe(201);
    const cookie = (reg.headers.get('set-cookie') ?? '').split(';')[0] as string;
    advance(r, 900); // the coins list a few minutes after the world starts
    const market = (await call(r, '/api/market')).json.companies as any[];
    const coin = market.filter((c) => c.sector === 'meme' && c.trading).sort((a, b) => a.price - b.price)[0];
    const stock = market.filter((c) => c.sector !== 'meme' && c.trading).sort((a, b) => a.price - b.price)[0];
    expect(coin).toBeTruthy();
    const qty = Math.max(2, Math.floor(30_000 / coin.price));
    const est = await call(r, `/api/market/${coin.ticker}/estimate?side=buy&qty=${qty}&account=career`, { cookie });
    expect(est.status).toBe(200);
    expect(est.json.feeBps).toBe(50);
    expect(est.json.feeCents).toBe(feeOf(est.json.totalCents, 50));
    expect(est.json.netCents).toBe(est.json.totalCents + est.json.feeCents);
    const sEst = await call(r, `/api/market/${stock.ticker}/estimate?side=buy&qty=3&account=career`, { cookie });
    expect(sEst.json).toMatchObject({ feeBps: 0, feeCents: 0 });

    const ordered = await call(r, '/api/orders', { method: 'POST', cookie, body: { account: 'career', ticker: coin.ticker, side: 'buy', qty, clientOrderId: 'api-order-fee-0001' } });
    expect(ordered.status).toBe(201);
    expect(ordered.json.trade.feeCents).toBe(feeOf(ordered.json.trade.totalCents, 50));
    expect(ordered.json.account.cashCents).toBe(START - ordered.json.trade.totalCents - ordered.json.trade.feeCents);
    const trades = (await call(r, '/api/account/trades?account=career&limit=5', { cookie })).json.trades as any[];
    expect(trades[0].feeCents).toBe(ordered.json.trade.feeCents);
    const sOrder = await call(r, '/api/orders', { method: 'POST', cookie, body: { account: 'career', ticker: stock.ticker, side: 'buy', qty: 3, clientOrderId: 'api-order-fee-0002' } });
    expect(sOrder.status).toBe(201);
    expect(sOrder.json.trade.feeCents).toBe(0);
  }, LONG);
});
