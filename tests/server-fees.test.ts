// The stock trading fee (docs/world.md §6.6, server/fees.ts): 0.1 % of the order's value (STOCK_FEE_BPS = 10), rounded UP to a whole
// cent, in Career only (a 1v1 match order is free). It works exactly like the memecoin fee (tests/server-memefees.test.ts): paid on top of
// the margin when a position opens, out of what comes back when one closes (never more than comes back), also when a stop-loss or
// take-profit closes it. The Trading class and the app have the stock fee OFF unless told a rate, so the older tests are not changed by it;
// the game turns it on in server/main.ts (checked here). Checked: the rate, the money to the cent for every kind of order, the
// estimates, "how many can I afford", a 1v1 account, a limit order, the memecoin fee left alone, and how the rate gets from main.ts to Trading.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CURATED } from '../src/world';
import { Auth } from '../server/auth';
import { MEME_FEE_BPS, STOCK_FEE_BPS, feeOf } from '../server/fees';
import { marginOf } from '../server/leverage';
import { Trading, type OrderRequest } from '../server/trading';
import { makeRig, type Rig } from './helpers/server';

const LONG = 240_000;
const START = 100_000; // a Career account starts with $1,000

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

/** A world with the stocks and the thirty coins, and one player, trading with the rates the game uses unless told otherwise. */
async function setup(stockBps: number = STOCK_FEE_BPS) {
  const rig = makeRig();
  rigs.push(rig);
  const { db, world } = rig.open({ companyCount: CURATED.length, memecoins: true, warmupDays: 1 });
  for (let step = 0; step < 4; step += 1) {
    rig.clock.advanceSeconds(300);
    world.advanceTo(world.currentTick(), Infinity);
  }
  const auth = new Auth(db, rig.clock.now, '');
  const trading = new Trading(db, world, rig.clock.now, MEME_FEE_BPS, stockBps);
  const { user } = await auth.register('alice', 'correct horse', '127.0.0.1');
  const account = trading.careerAccountOf(user.id);
  const stock = 0;
  expect(world.companies[stock]?.sector).not.toBe('meme');
  let n = 0;
  const order = (partial: Partial<OrderRequest> & Pick<OrderRequest, 'side' | 'qty'>): OrderRequest => ({
    accountId: account.id,
    clientOrderId: `order-${String(++n).padStart(6, '0')}`,
    companyId: stock,
    ...partial,
  });
  const position = (companyId = stock) =>
    db.get<PosRow>('SELECT shares, cost_cents, debt_cents, short, credit_cents FROM positions WHERE account_id = ? AND company_id = ?', account.id, companyId);
  const cash = (): number => (db.get<{ cash_cents: number }>('SELECT cash_cents FROM accounts WHERE id = ?', account.id) as { cash_cents: number }).cash_cents;
  const mid = world.sim.price(stock);
  /** About $300 worth of the stock. */
  const qty = Math.max(2, Math.floor(30_000 / mid));
  return { rig, db, world, auth, trading, user, account, stock, order, position, cash, mid, qty };
}

describe('The stock fee itself', () => {
  it('SFEE-1: the game rate is 0.1 % (10 basis points) for stocks and still 0.5 % for coins; 0.1 % of $300 is 30 cents, rounded up', () => {
    expect(STOCK_FEE_BPS).toBe(10);
    expect(MEME_FEE_BPS).toBe(50);
    expect(feeOf(30_000, STOCK_FEE_BPS)).toBe(30);
    expect(feeOf(30_001, STOCK_FEE_BPS)).toBe(31);
    expect(feeOf(1, STOCK_FEE_BPS)).toBe(1); // any real order pays a cent
    expect(feeOf(1_000, STOCK_FEE_BPS)).toBe(1);
    expect(feeOf(1_001, STOCK_FEE_BPS)).toBe(2);
  });

  it('SFEE-2: a stock rate that is not a whole number of basis points from 0 to 10000 is refused when the program starts', () => {
    const rig = makeRig();
    rigs.push(rig);
    const { db, world } = rig.open({ companyCount: 12 });
    for (const bad of [-1, 0.5, 10_001, Number.NaN]) expect(() => new Trading(db, world, rig.clock.now, MEME_FEE_BPS, bad)).toThrow(/stock fee.*basis points/);
    expect(() => new Trading(db, world, rig.clock.now, MEME_FEE_BPS, 0)).not.toThrow();
  });

  it('SFEE-3: left out, the stock rate is 0 (the older tests see no stock fee); main.ts is what turns it on', () => {
    const main = readFileSync(resolve(process.cwd(), 'server', 'main.ts'), 'utf8');
    expect(main).toMatch(/import \{ STOCK_FEE_BPS \} from '\.\/fees'/);
    expect(main).toMatch(/createApp\(\{[^}]*stockFeeBps: STOCK_FEE_BPS/);
    const app = readFileSync(resolve(process.cwd(), 'server', 'app.ts'), 'utf8');
    expect(app).toMatch(/new Trading\(db, world, now, undefined, options\.stockFeeBps \?\? 0\)/);
  });
});

describe('Stock orders pay the fee', () => {
  it('SFEE-4: a buy pays the shares plus the fee on top; the position costs the shares only; the estimate says so', async () => {
    const { trading, account, order, position, cash, qty, stock } = await setup();
    const est = trading.estimate(account.id, stock, 'buy', qty);
    expect(est).toMatchObject({ feeBps: 10 });
    const out = trading.placeOrder(order({ side: 'buy', qty }));
    const total = out.trade.totalCents;
    const fee = feeOf(total, 10);
    expect(fee).toBeGreaterThan(0);
    expect(est.feeCents).toBe(fee);
    expect(out.trade.feeCents).toBe(fee);
    expect(cash()).toBe(START - total - fee);
    expect(position()).toMatchObject({ shares: out.trade.filled, cost_cents: total, debt_cents: 0, short: 0 });
    expect(out.trade.realizedCents).toBe(-fee);
  }, LONG);

  it('SFEE-5: a sell pays the fee out of the proceeds; the whole round trip is in the realized figure to the cent', async () => {
    const { trading, account, order, position, cash, qty } = await setup();
    const buy = trading.placeOrder(order({ side: 'buy', qty }));
    const held = position()?.shares as number;
    const before = cash();
    const sell = trading.placeOrder(order({ side: 'sell', qty: held }));
    const feeSell = feeOf(sell.trade.totalCents, 10);
    expect(sell.trade.feeCents).toBe(feeSell);
    expect(cash()).toBe(before + sell.trade.totalCents - feeSell);
    expect(sell.trade.realizedCents).toBe(sell.trade.totalCents - feeSell - buy.trade.totalCents);
    expect(position()).toBeUndefined();
    expect(trading.view(account.id).realizedCents).toBe(cash() - START);
  }, LONG);

  it('SFEE-6: with leverage the fee is on the VALUE of the order, not on the margin', async () => {
    const { trading, order, position, cash, qty } = await setup();
    const buy = trading.placeOrder(order({ side: 'buy', qty, leverage: 10 }));
    const total = buy.trade.totalCents;
    const margin = marginOf(total, 10);
    expect(buy.trade.feeCents).toBe(feeOf(total, 10));
    expect(cash()).toBe(START - margin - feeOf(total, 10));
    expect(position()).toMatchObject({ cost_cents: margin, debt_cents: total - margin });
  }, LONG);

  it('SFEE-7: a short pays the fee on top of the margin when it opens, and out of what comes back when it is covered', async () => {
    const { trading, order, position, cash, qty } = await setup();
    const open = trading.placeOrder(order({ side: 'sell', short: true, qty, leverage: 5 }));
    const credit = open.trade.totalCents;
    const margin = marginOf(credit, 5);
    const openFee = feeOf(credit, 10);
    expect(open.trade).toMatchObject({ feeCents: openFee, realizedCents: -openFee, short: true });
    expect(cash()).toBe(START - margin - openFee);
    const before = cash();
    const cover = trading.placeOrder(order({ side: 'buy', short: true, qty: position()?.shares as number }));
    const back = Math.max(0, credit + margin - cover.trade.totalCents);
    const coverFee = Math.min(feeOf(cover.trade.totalCents, 10), back);
    expect(cover.trade.feeCents).toBe(coverFee);
    expect(cash()).toBe(before + back - coverFee);
    expect(position()).toBeUndefined();
  }, LONG);

  it('SFEE-8: the closing the market does at a stop-loss pays the fee like an ordinary sale', async () => {
    const { trading, account, order, position, cash, qty, stock, world } = await setup();
    trading.placeOrder(order({ side: 'buy', qty }));
    const costBefore = position()?.cost_cents as number;
    const before = cash();
    const t = trading.closeByExit(account.id, stock, 'stop', world.sim.tick) as NonNullable<ReturnType<Trading['closeByExit']>>;
    expect(t.feeCents).toBe(feeOf(t.totalCents, 10));
    expect(t.feeCents).toBeGreaterThan(0);
    expect(cash()).toBe(before + t.totalCents - t.feeCents);
    expect(t.realizedCents).toBe(t.totalCents - t.feeCents - costBefore);
  }, LONG);

  it('SFEE-9: "how many can I afford" counts the fee, so a buy of the most it says never fails for lack of cash', async () => {
    const { trading, account, order, cash, stock } = await setup();
    const est = trading.estimate(account.id, stock, 'buy', 1);
    const max = est.maxQty;
    expect(max).toBeGreaterThan(1);
    const out = trading.placeOrder(order({ side: 'buy', qty: max }));
    expect(out.trade.filled).toBe(max);
    expect(cash()).toBeGreaterThanOrEqual(0);
    // one more share would not have fit
    expect(cash()).toBeLessThan(trading.estimate(account.id, stock, 'buy', 1).totalCents + 1_000);
  }, LONG);
});

describe('Who pays the stock fee', () => {
  it('SFEE-10: a 1v1 match account pays none; the memecoin fee is still 0.5 %', async () => {
    const { trading, db, user, order, cash, world } = await setup();
    const coin = CURATED.length;
    expect(world.companies[coin]?.sector).toBe('meme');
    const coinBuy = trading.placeOrder(order({ companyId: coin, side: 'buy', qty: Math.max(2, Math.floor(30_000 / world.sim.price(coin))) }));
    expect(coinBuy.trade.feeCents).toBe(feeOf(coinBuy.trade.totalCents, 50));
    expect(cash()).toBe(START - coinBuy.trade.totalCents - coinBuy.trade.feeCents);
    db.run("INSERT INTO matches(id, state, created_ms, start_tick, end_tick, duration_ticks, start_cash_cents) VALUES (1, 'live', 0, 1000, 1180, 180, 100000)");
    const acc = trading.createMatchAccount(user.id, 1, 100_000);
    expect(trading.estimate(acc.id, 0, 'buy', 5)).toMatchObject({ feeCents: 0, feeBps: 0 });
    const out = trading.placeOrder({ accountId: acc.id, clientOrderId: 'match-order-000001', companyId: 0, side: 'buy', qty: 5 });
    expect(out.trade.feeCents).toBe(0);
    expect(trading.view(acc.id).cashCents).toBe(100_000 - out.trade.totalCents);
  }, LONG);

  it('SFEE-11: with the stock rate 0 stocks are free again, and a limit order asks for the same rate as a market order', async () => {
    const free = await setup(0);
    const buy = free.trading.placeOrder(free.order({ side: 'buy', qty: free.qty }));
    expect(buy.trade.feeCents).toBe(0);
    expect(free.trading.feeRateFor(free.stock, 'career')).toBe(0);
    const paid = await setup();
    expect(paid.trading.feeRateFor(paid.stock, 'career')).toBe(10);
    expect(paid.trading.feeRateFor(paid.stock, 'match')).toBe(0);
    expect(paid.trading.feeRateFor(CURATED.length, 'career')).toBe(50);
  }, LONG);
});
