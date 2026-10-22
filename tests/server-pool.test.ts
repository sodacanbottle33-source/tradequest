// The money pool behind a memecoin that a player launched (server/pools.ts, server/trading.ts, server/launch.ts, docs/world.md §12.2). The rules checked here:
// every coin launched gets a pool whose first deposit is the launching player's first buy; what buyers pay goes IN (the fee does not), a sale is PAID OUT of it
// and is cut down to what the pool can pay; the launching player can take ALL of it (the rug pull) whether or not he holds any of the coin, and then the coin is
// dead: worth nothing, not tradable, price crashed, news published; a coin with a pool takes plain buying and selling only; cash is conserved (nobody's money
// is made or lost except by the fee); and a coin from before pools works as it did.
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../server/app';
import { loadConfig } from '../server/config';
import { Logger } from '../server/log';
import { MAX_ACTIVE_PER_KIND } from '../server/launch';
import { Clock } from './helpers/server';

const LONG = 240_000;
const BASE = 66; // the hand-written companies; launched companies get the ids after them

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

async function boot(options: { dir?: string; clock?: Clock; flowGain?: number } = {}): Promise<Running> {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'tq-pool-'));
  if (!options.dir) dirs.push(dir);
  const clock = options.clock ?? new Clock();
  const config = loadConfig({ TQ_DATA_DIR: dir, TQ_COMPANIES: '66', TQ_WARMUP_DAYS: '1', TQ_PORT: '8787', TQ_OWNER: 'boss' });
  const app = createApp({ config, log: new Logger({ sink: null, now: clock.now }), worldSeed: 777, now: clock.now, flowGain: options.flowGain ?? 0, memecoins: false });
  const server = createServer(app.handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const r = { app, server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, dir, clock };
  running.push(r);
  return r;
}

async function restart(r: Running): Promise<Running> {
  await stop(r);
  running.splice(running.indexOf(r), 1);
  return boot({ dir: r.dir, clock: r.clock });
}

function catchUp(r: Running): void {
  const w = r.app.services.world;
  for (let i = 0; i < 400_000 && w.sim.tick < w.currentTick(); i += 1) w.pump();
  expect(w.sim.tick).toBe(w.currentTick());
}
function advance(r: Running, seconds: number): void {
  r.clock.advanceSeconds(seconds);
  catchUp(r);
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

/** $5,000 first buy: 2,500 coins at $2.00. */
const MOON = { name: 'Moon Pepe', ticker: 'MPEP', seedCents: 500_000 };
const launchCoin = (r: Running, cookie: string | undefined, over: Record<string, unknown> = {}) => post(r, '/api/launch/coin', cookie, { ...MOON, ...over });
const launchStock = (r: Running, cookie: string | undefined) => post(r, '/api/launch/stock', cookie, { name: 'Acme Robotics', ticker: 'ACMR', sector: 'robotics', seedCents: 500_000 });
const rug = (r: Running, cookie: string | undefined, ticker = 'MPEP', over: Record<string, unknown> = {}) => post(r, '/api/launch/rug', cookie, { ticker, ...over });
const fund = (r: Running, boss: string, username: string, amountCents: number) => post(r, '/api/admin/cash', boss, { username, amountCents });

let orderNo = 0;
const trade = (r: Running, cookie: string, body: Record<string, unknown> = {}) =>
  call(r, '/api/orders', { method: 'POST', cookie, body: { account: 'career', ticker: 'MPEP', side: 'buy', qty: 10, clientOrderId: `order-${(orderNo += 1)}-abcdef`, ...body } });
const estimate = (r: Running, cookie: string, side: 'buy' | 'sell', qty: number, ticker = 'MPEP', extra = '') => call(r, `/api/market/${ticker}/estimate?side=${side}&qty=${qty}${extra}`, { cookie });

const rowsOf = (r: Running, sql: string, ...params: (string | number)[]) => r.app.services.db.all(sql, ...params);
const account = async (r: Running, cookie: string) => (await call(r, '/api/account', { cookie })).json;
const launchState = async (r: Running, cookie: string) => (await call(r, '/api/launch', { cookie })).json;
const market = async (r: Running) => (await call(r, '/api/market')).json.companies as any[];
const priceOf = async (r: Running, ticker: string): Promise<number> => (await market(r)).find((c) => c.ticker === ticker).price;
const poolOf = (r: Running, ticker = 'MPEP') => {
  const id = r.app.services.world.companyByTicker(ticker)?.id as number;
  return rowsOf(r, 'SELECT * FROM coin_pools WHERE company_id = ?', id)[0] as { company_id: number; pool_cents: number; in_cents: number; out_cents: number; drained_cents: number; drained_ms: number | null; drain_request_id: string | null } | undefined;
};
/** Sets what the pool holds (keeps the books balanced: in = pool + out + drained). */
const setPool = (r: Running, ticker: string, cents: number) => {
  const id = r.app.services.world.companyByTicker(ticker)?.id as number;
  r.app.services.db.run('UPDATE coin_pools SET pool_cents = ?, in_cents = ? + out_cents + drained_cents WHERE company_id = ?', cents, cents, id);
};

/** The owner ("boss"), alice (the developer), bob and carol (buyers): each of them has $10,000 more than the start. */
async function players() {
  const r = await boot();
  const boss = await signUp(r, 'boss');
  const alice = await signUp(r, 'alice');
  const bob = await signUp(r, 'bob');
  const carol = await signUp(r, 'carol');
  for (const name of ['alice', 'bob', 'carol']) expect((await fund(r, boss, name, 1_000_000)).status).toBe(200);
  return { r, boss, alice, bob, carol };
}

/** Alice launches Moon Pepe with $5,000 and it starts trading. */
async function trading() {
  const p = await players();
  expect((await launchCoin(p.r, p.alice)).status).toBe(200);
  advance(p.r, 45);
  return p;
}

/** All the cash there is: every account, every pool, and every fee that was paid (a fee is gone, but counted so the books balance). */
function money(r: Running): number {
  const cash = (rowsOf(r, 'SELECT SUM(cash_cents) AS s FROM accounts')[0] as { s: number }).s;
  const pools = (rowsOf(r, 'SELECT COALESCE(SUM(pool_cents), 0) AS s FROM coin_pools')[0] as { s: number }).s;
  const tradeFees = (rowsOf(r, 'SELECT COALESCE(SUM(fee_cents), 0) AS s FROM trades')[0] as { s: number }).s;
  const launchFees = (rowsOf(r, 'SELECT COALESCE(SUM(fee_cents), 0) AS s FROM launches')[0] as { s: number }).s;
  return cash + pools + tradeFees + launchFees;
}

// ---- the pool is made with the coin ---------------------------------------------------------------------------------------------------

describe('a coin gets a money pool', () => {
  it('POOL-1: the first buy is the first deposit; a free launch starts empty; a stock has no pool; the launch fee is not in it', async () => {
    const { r, alice } = await players();
    const cash0 = (await account(r, alice)).cashCents;
    expect((await launchCoin(r, alice)).status).toBe(200);
    expect(poolOf(r)).toMatchObject({ pool_cents: 500_000, in_cents: 500_000, out_cents: 0, drained_cents: 0, drained_ms: null, drain_request_id: null });
    expect((await account(r, alice)).cashCents).toBe(cash0 - 500_000 - 200); // the first buy is in the pool, the $2.00 fee is gone
    expect((await launchCoin(r, alice, { name: 'Free Pepe', ticker: 'FREE', seedCents: 0 })).status).toBe(200);
    expect(poolOf(r, 'FREE')).toMatchObject({ pool_cents: 0, in_cents: 0 });
    expect((await launchStock(r, alice)).status).toBe(200);
    expect(rowsOf(r, 'SELECT * FROM coin_pools')).toHaveLength(2); // two coins, no stock

    const state = await launchState(r, alice);
    const byTicker = (t: string) => state.mine.find((m: any) => m.ticker === t);
    expect(byTicker('MPEP').pool).toEqual({ cents: 500_000, inCents: 500_000, outCents: 0, drainedCents: 0, dead: false });
    expect(byTicker('FREE').pool).toEqual({ cents: 0, inCents: 0, outCents: 0, drainedCents: 0, dead: false });
    expect(byTicker('ACMR').pool).toBeNull();
  }, LONG);

  it('POOL-2: the market list and the company page say how much is in the pool (and nothing for companies without one)', async () => {
    const { r, boss, alice } = await trading();
    const rows = await market(r);
    expect(rows.find((c) => c.ticker === 'MPEP').pool).toEqual({ cents: 500_000, dead: false });
    expect(rows.filter((c) => c.pool !== null).map((c) => c.ticker)).toEqual(['MPEP']);
    expect((await call(r, '/api/market/MPEP')).json.pool).toEqual({ cents: 500_000, dead: false });
    expect((await call(r, '/api/market/QLRX')).json.pool).toBeNull();
    const admin = (await call(r, '/api/admin/state', { cookie: boss })).json;
    expect(admin.launches[0]).toMatchObject({ ticker: 'MPEP', username: 'alice', pool: { cents: 500_000, inCents: 500_000, outCents: 0, drainedCents: 0, dead: false } });
    expect(alice).toBeTruthy();
  }, LONG);
});

// ---- money in and money out -----------------------------------------------------------------------------------------------------------

describe('what buyers pay goes in, what sellers get comes out', () => {
  it('POOL-3: a buy puts everything it cost into the pool; the fee is not in it; the buyer pays exactly the pool\'s gain plus the fee', async () => {
    const { r, bob } = await trading();
    const cash = (await account(r, bob)).cashCents;
    const before = poolOf(r)?.pool_cents as number;
    const bought = await trade(r, bob, { qty: 50 });
    expect(bought.status).toBe(201);
    const t = bought.json.trade;
    expect(t.totalCents).toBeGreaterThan(9_000);
    expect(t.feeCents).toBeGreaterThan(0);
    const pool = poolOf(r);
    expect(pool?.pool_cents).toBe(before + t.totalCents);
    expect(pool?.in_cents).toBe(500_000 + t.totalCents);
    expect((await account(r, bob)).cashCents).toBe(cash - t.totalCents - t.feeCents);
  }, LONG);

  it('POOL-4: a sale is paid from the pool: the pool loses what the shares sold for, the seller gets that minus the fee', async () => {
    const { r, bob } = await trading();
    expect((await trade(r, bob, { qty: 50 })).status).toBe(201);
    advance(r, 20);
    const cash = (await account(r, bob)).cashCents;
    const before = poolOf(r) as { pool_cents: number };
    const sold = await trade(r, bob, { side: 'sell', qty: 30 });
    expect(sold.status).toBe(201);
    const t = sold.json.trade;
    expect(t).toMatchObject({ filled: 30, poolLimited: false });
    expect(poolOf(r)).toMatchObject({ pool_cents: before.pool_cents - t.totalCents, out_cents: t.totalCents });
    expect((await account(r, bob)).cashCents).toBe(cash + t.totalCents - t.feeCents);
  }, LONG);

  it('POOL-5: a sale bigger than the pool is filled only as far as the pool can pay: estimate and order agree, the pool is never overdrawn', async () => {
    const { r, bob } = await trading();
    expect((await trade(r, bob, { qty: 50 })).status).toBe(201);
    advance(r, 20);
    setPool(r, 'MPEP', 3_000); // $30.00 is left: not enough for 50 coins worth about $100
    const e = (await estimate(r, bob, 'sell', 50)).json;
    expect(e.poolLimited).toBe(true);
    expect(e.poolCents).toBe(3_000);
    expect(e.filledQty).toBeGreaterThan(5);
    expect(e.filledQty).toBeLessThan(50);
    expect(e.unfilledQty).toBe(50 - e.filledQty);
    expect(e.totalCents).toBeLessThanOrEqual(3_000);
    expect(e.maxQty).toBe(e.filledQty); // the most he can sell right now
    const cash = (await account(r, bob)).cashCents;
    const sold = await trade(r, bob, { side: 'sell', qty: 50 });
    expect(sold.status).toBe(201);
    expect(sold.json.trade).toMatchObject({ requested: 50, filled: e.filledQty, poolLimited: true });
    expect(sold.json.trade.totalCents).toBeLessThanOrEqual(3_000);
    const pool = poolOf(r) as { pool_cents: number; out_cents: number };
    expect(pool.pool_cents).toBe(3_000 - sold.json.trade.totalCents);
    expect(pool.pool_cents).toBeGreaterThanOrEqual(0);
    expect((await account(r, bob)).cashCents).toBe(cash + sold.json.trade.totalCents - sold.json.trade.feeCents);
    expect((await account(r, bob)).positions[0].shares).toBe(50 - e.filledQty); // what the pool could not pay for is still his
  }, LONG);

  it('POOL-6: with less in the pool than one coin is worth, nothing can be sold: a sentence says so, and nothing changes', async () => {
    const { r, bob } = await trading();
    expect((await trade(r, bob, { qty: 50 })).status).toBe(201);
    advance(r, 20);
    setPool(r, 'MPEP', 100);
    const cash = (await account(r, bob)).cashCents;
    const trades0 = rowsOf(r, 'SELECT COUNT(*) AS n FROM trades')[0];
    const e = await estimate(r, bob, 'sell', 5);
    expect(e.status).toBe(400);
    expect(e.json.error.code).toBe('no_liquidity');
    const sold = await trade(r, bob, { side: 'sell', qty: 5 });
    expect(sold.status).toBe(400);
    expect(sold.json.error.code).toBe('no_liquidity');
    expect(sold.json.error.message).toMatch(/money pool behind MPEP holds only \$1\.00/);
    expect((await account(r, bob)).cashCents).toBe(cash);
    expect(rowsOf(r, 'SELECT COUNT(*) AS n FROM trades')[0]).toEqual(trades0);
    expect(poolOf(r)?.pool_cents).toBe(100);
    // It fills up again when somebody buys.
    expect((await trade(r, bob, { qty: 20 })).status).toBe(201);
    expect(poolOf(r)?.pool_cents).toBeGreaterThan(3_000);
  }, LONG);

  it('POOL-7: nobody\'s cash is made or lost except by fees: every account, every pool and every fee add up to the same at each step, also after the rug pull', async () => {
    const { r, alice, bob, carol } = await trading();
    const total = money(r);
    const steps: Array<() => Promise<unknown>> = [
      () => trade(r, bob, { qty: 80 }),
      () => trade(r, carol, { qty: 120 }),
      () => trade(r, bob, { side: 'sell', qty: 30 }),
      () => trade(r, alice, { side: 'sell', qty: 500 }),
      () => trade(r, carol, { side: 'sell', qty: 60 }),
      () => trade(r, alice, { qty: 40 }),
    ];
    for (const step of steps) {
      advance(r, 15);
      const res = (await step()) as { status: number; text: string };
      if (res.status !== 201) throw new Error(`step failed: ${res.text}`);
      expect(money(r)).toBe(total);
      const pool = poolOf(r) as { pool_cents: number; in_cents: number; out_cents: number; drained_cents: number };
      expect(pool.pool_cents).toBe(pool.in_cents - pool.out_cents - pool.drained_cents);
    }
    advance(r, 15);
    expect((await rug(r, alice)).status).toBe(200);
    expect(money(r)).toBe(total);
    expect(poolOf(r)).toMatchObject({ pool_cents: 0 });
  }, LONG);
});

// ---- only plain buying and selling ----------------------------------------------------------------------------------------------------

describe('a coin with a pool takes plain buying and selling only', () => {
  it('POOL-8: leverage, shorting, stop-loss, take-profit, exits on a held position and limit orders are all refused with the reason; nothing changes', async () => {
    const { r, bob } = await trading();
    expect((await trade(r, bob, { qty: 20 })).status).toBe(201);
    advance(r, 20);
    const cash = (await account(r, bob)).cashCents;
    const trades0 = rowsOf(r, 'SELECT COUNT(*) AS n FROM trades')[0];
    const refusals = [
      await trade(r, bob, { qty: 5, leverage: 2 }),
      await trade(r, bob, { side: 'sell', qty: 5, short: true }),
      await trade(r, bob, { qty: 5, stopPrice: 150 }),
      await trade(r, bob, { qty: 5, takePrice: 900 }),
      await call(r, '/api/positions/exits', { method: 'POST', cookie: bob, body: { ticker: 'MPEP', stopPrice: 150 } }),
      await call(r, '/api/limit-orders', { method: 'POST', cookie: bob, body: { ticker: 'MPEP', side: 'buy', qty: 5, limitPrice: 150, clientOrderId: 'limit-order-0001' } }),
      await call(r, '/api/limit-orders', { method: 'POST', cookie: bob, body: { ticker: 'MPEP', side: 'sell', qty: 5, limitPrice: 5000, clientOrderId: 'limit-order-0002' } }),
      await estimate(r, bob, 'buy', 5, 'MPEP', '&leverage=3'),
      await estimate(r, bob, 'sell', 5, 'MPEP', '&short=1'),
    ];
    for (const res of refusals) {
      expect(res.status).toBe(403);
      expect(res.json.error.code).toBe('not_allowed');
      expect(res.json.error.message).toMatch(/MPEP: Coins that players launch can only be bought and sold at the market price/);
    }
    expect((await account(r, bob)).cashCents).toBe(cash);
    expect(rowsOf(r, 'SELECT COUNT(*) AS n FROM trades')[0]).toEqual(trades0);
    expect(rowsOf(r, 'SELECT COUNT(*) AS n FROM limit_orders')[0]).toEqual({ n: 0 });
    expect((await account(r, bob)).positions[0]).toMatchObject({ shares: 20, debtCents: 0, stopCents: 0, takeCents: 0, short: false });
  }, LONG);

  it('POOL-9: a stock and a coin from before pools (no pool row) keep every one of those tools', async () => {
    const { r, bob, alice } = await trading();
    expect((await launchStock(r, alice)).status).toBe(200);
    r.app.services.db.run('DELETE FROM coin_pools'); // MPEP now looks like a coin launched before pools existed
    advance(r, 45);
    expect((await trade(r, bob, { qty: 10, leverage: 2 })).status).toBe(201);
    expect((await trade(r, bob, { side: 'sell', qty: 4, short: true, ticker: 'ACMR' })).status).toBe(201);
    const wrongStop = await trade(r, bob, { qty: 5, stopPrice: 900 }); // a stop above the market is wrong: judged on its merits, not refused as a pool coin
    expect([wrongStop.status, wrongStop.json.error.code]).toEqual([400, 'bad_exit']);
    expect((await trade(r, bob, { qty: 5, stopPrice: 120 })).status).toBe(201);
    const limit = await call(r, '/api/limit-orders', { method: 'POST', cookie: bob, body: { ticker: 'MPEP', side: 'buy', qty: 5, limitPrice: 100, clientOrderId: 'limit-order-0003' } });
    expect(limit.status).toBe(201);
  }, LONG);
});

// ---- the rug pull ---------------------------------------------------------------------------------------------------------------------

describe('the rug pull takes the pool', () => {
  it('POOL-10: all of it becomes the developer\'s cash; the pool is empty; the coin is dead for everybody: worth nothing, no buying, no selling, no estimates', async () => {
    const { r, alice, bob } = await trading();
    expect((await trade(r, bob, { qty: 50 })).status).toBe(201);
    advance(r, 20);
    const poolBefore = poolOf(r)?.pool_cents as number;
    const aliceCash = (await account(r, alice)).cashCents;
    const bobBefore = await account(r, bob);
    expect(bobBefore.positions[0].equityCents).toBeGreaterThan(8_000);

    const done = await rug(r, alice);
    expect(done.status).toBe(200);
    expect(done.json).toMatchObject({ ok: true, kind: 'drain', duplicate: false, ticker: 'MPEP', takenCents: poolBefore, paidInCents: poolBefore, otherHolders: 1, otherCoins: 50, ownCoins: 2500 });
    expect((await account(r, alice)).cashCents).toBe(aliceCash + poolBefore);
    expect(poolOf(r)).toMatchObject({ pool_cents: 0, in_cents: poolBefore, drained_cents: poolBefore });
    expect(poolOf(r)?.drained_ms).not.toBeNull();

    // Worth nothing: Bob's coins and Alice's own, in the account and in net worth.
    const bobAfter = await account(r, bob);
    expect(bobAfter.positions[0]).toMatchObject({ ticker: 'MPEP', shares: 50, dead: true, valueCents: 0, equityCents: 0 });
    expect(bobAfter.netWorthCents).toBe(bobAfter.cashCents);
    const aliceAfter = await account(r, alice);
    expect(aliceAfter.positions[0]).toMatchObject({ shares: 2500, dead: true, equityCents: 0 });
    expect(aliceAfter.netWorthCents).toBe(aliceAfter.cashCents);

    // Nothing can be traded any more, for anybody.
    const trades0 = rowsOf(r, 'SELECT COUNT(*) AS n FROM trades')[0];
    for (const res of [await trade(r, bob, { side: 'sell', qty: 10 }), await trade(r, bob, { qty: 10 }), await trade(r, alice, { side: 'sell', qty: 10 }), await estimate(r, bob, 'sell', 10), await estimate(r, bob, 'buy', 10)]) {
      expect(res.status).toBe(403);
      expect(res.json.error.code).toBe('not_allowed');
      expect(res.json.error.message).toMatch(/took all the money out of its pool \(a rug pull\)\. MPEP is worthless now/);
    }
    expect(rowsOf(r, 'SELECT COUNT(*) AS n FROM trades')[0]).toEqual(trades0);
    expect((await call(r, '/api/market/MPEP')).json.pool).toEqual({ cents: 0, dead: true });
  }, LONG);

  it('POOL-11: the same request pays once; a new request after it is refused; the result is the first one', async () => {
    const { r, alice, bob } = await trading();
    expect((await trade(r, bob, { qty: 30 })).status).toBe(201);
    advance(r, 20);
    const id = 'req-drain-once-000001';
    const first = await rug(r, alice, 'MPEP', { requestId: id });
    expect(first.json).toMatchObject({ kind: 'drain', duplicate: false });
    const cash = (await account(r, alice)).cashCents;
    const again = await rug(r, alice, 'MPEP', { requestId: id });
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ kind: 'drain', duplicate: true, takenCents: first.json.takenCents });
    expect((await account(r, alice)).cashCents).toBe(cash);
    const second = await rug(r, alice);
    expect(second.status).toBe(400);
    expect(second.json.error.code).toBe('already_pulled');
    expect((await account(r, alice)).cashCents).toBe(cash);
    // One request id cannot be used for another coin.
    expect((await launchCoin(r, alice, { name: 'Other Coin', ticker: 'OTHR' })).status).toBe(200);
    advance(r, 45);
    const reused = await rug(r, alice, 'OTHR', { requestId: id });
    expect(reused.status).toBe(409);
    expect(reused.json.error.code).toBe('request_id_reused');
  }, LONG);

  it('POOL-12: he needs to hold none of the coin: a free launch, other players buy, he takes their money; an empty pool is refused with a sentence', async () => {
    const { r, alice, bob, carol } = await players();
    expect((await launchCoin(r, alice, { seedCents: 0 })).status).toBe(200);
    advance(r, 45);
    expect((await account(r, alice)).positions).toEqual([]);
    const state0 = await launchState(r, alice);
    expect(state0.mine[0]).toMatchObject({ canRug: false, sharesNow: 0 });
    expect(state0.mine[0].blocked).toMatch(/no money in the MPEP pool yet/);
    const empty = await rug(r, alice);
    expect(empty.status).toBe(400);
    expect(empty.json.error.code).toBe('pool_empty');

    const b = await trade(r, bob, { qty: 4 });
    const c = await trade(r, carol, { qty: 3 });
    expect([b.status, c.status]).toEqual([201, 201]);
    const put = b.json.trade.totalCents + c.json.trade.totalCents;
    expect(poolOf(r)?.pool_cents).toBe(put);
    advance(r, 20);
    const cash = (await account(r, alice)).cashCents;
    const done = await rug(r, alice);
    expect(done.json).toMatchObject({ kind: 'drain', takenCents: put, otherHolders: 2, otherCoins: 7, ownCoins: 0 });
    expect((await account(r, alice)).cashCents).toBe(cash + put);
    // His result for this coin: the fee he paid and everything the others put in.
    const state = await launchState(r, alice);
    expect(state.mine[0]).toMatchObject({ profitCents: put - 200, rugs: 1, ruggedCents: put, canRug: false, pool: { cents: 0, drainedCents: put, dead: true } });
  }, LONG);

  it('POOL-13: only the developer can do it, and not while the coin is halted or before it trades', async () => {
    const { r, boss, alice, bob } = await players();
    expect((await launchCoin(r, alice)).status).toBe(200);
    const early = await rug(r, alice);
    expect(early.status).toBe(400);
    expect(early.json.error.code).toBe('not_trading');
    advance(r, 45);
    expect((await trade(r, bob, { qty: 10 })).status).toBe(201);
    expect((await rug(r, bob)).json.error.code).toBe('not_yours');
    expect((await rug(r, boss)).status).toBe(403);
    expect((await post(r, '/api/admin/halt', boss, { ticker: 'MPEP', halted: true, reason: 'looks like a scam' })).status).toBe(200);
    const state = await launchState(r, alice);
    expect(state.mine[0]).toMatchObject({ halted: true, canRug: false });
    const refused = await rug(r, alice);
    expect(refused.status).toBe(403);
    expect(refused.json.error.code).toBe('halted');
    expect(poolOf(r)?.drained_ms).toBeNull();
    expect((await post(r, '/api/admin/halt', boss, { ticker: 'MPEP', halted: false })).status).toBe(200);
    expect((await rug(r, alice)).status).toBe(200);
  }, LONG);

  it('POOL-14: the coin crashes and the news says what happened; the crash survives a restart and the price is the same one', async () => {
    const { r, boss, alice, bob } = await players();
    expect((await fund(r, boss, 'alice', 60_000_000)).status).toBe(200);
    expect((await launchCoin(r, alice, { name: 'Big Pepe', ticker: 'BPEP', seedCents: 50_000_000 })).status).toBe(200); // $500,000 in: a pricey coin
    advance(r, 45);
    const priceBefore = await priceOf(r, 'BPEP');
    expect(priceBefore).toBeGreaterThan(1_500);
    expect((await trade(r, bob, { ticker: 'BPEP', qty: 5 })).status).toBe(201);
    advance(r, 20);
    const done = await rug(r, alice, 'BPEP');
    expect(done.status).toBe(200);
    const news = rowsOf(r, "SELECT key, source, direction, realized, headline, body, company_id FROM news_items WHERE key LIKE 'rug:%'") as any[];
    expect(news).toHaveLength(1);
    expect(news[0]).toMatchObject({ key: `rug:${BASE}:drain`, source: 'admin', direction: 'negative', company_id: BASE });
    expect(news[0].realized).toBeLessThan(-0.5);
    expect(news[0].headline).toBe('Big Pepe is a rug pull: its developer drained the pool');
    expect(news[0].body).toMatch(/took all \$[\d,]+\.\d\d out of the money pool behind BPEP/);
    expect(JSON.stringify(news)).not.toMatch(/alice/);
    advance(r, 60);
    const priceAfter = await priceOf(r, 'BPEP');
    expect(priceAfter).toBeLessThan(priceBefore * 0.2); // down 99 %, but never below the $1.00 floor
    expect(priceAfter).toBeGreaterThanOrEqual(100);

    // A restart: the pool is still empty, the coin still dead, and the price after the crash is the very same.
    const priceThen = await priceOf(r, 'BPEP');
    const tick = r.app.services.world.sim.tick;
    const r2 = await restart(r);
    catchUp(r2);
    expect(r2.app.services.world.sim.tick).toBe(tick);
    expect(await priceOf(r2, 'BPEP')).toBe(priceThen);
    expect(poolOf(r2, 'BPEP')?.drained_ms).not.toBeNull();
    const bob2 = (await call(r2, '/api/auth/login', { method: 'POST', body: { username: 'bob', password: 'a-good-password' } })).json;
    expect(bob2).toBeTruthy();
  }, LONG * 2);

  it('POOL-15: a dead coin does not use up one of his places: he can launch another; the Launch tab and the owner see the result', async () => {
    const { r, boss, alice, bob } = await players();
    for (const [name, ticker] of [['Coin Alpha', 'ALPH'], ['Coin Beta', 'BETA'], ['Coin Gamma', 'GAMM']]) expect((await launchCoin(r, alice, { name, ticker, seedCents: 100_000 })).status).toBe(200);
    advance(r, 45);
    const full = await launchCoin(r, alice, { name: 'Coin Delta', ticker: 'DELA', seedCents: 100_000 });
    expect(full.status).toBe(400);
    expect(full.json.error.code).toBe('too_many_active');
    expect((await launchState(r, alice)).counts).toMatchObject({ coinActive: MAX_ACTIVE_PER_KIND, coinEver: 3 });
    expect((await trade(r, bob, { ticker: 'BETA', qty: 5 })).status).toBe(201);
    advance(r, 20);
    const done = await rug(r, alice, 'BETA');
    expect(done.status).toBe(200);
    expect((await launchState(r, alice)).counts).toMatchObject({ coinActive: 2, coinEver: 3 });
    expect((await launchCoin(r, alice, { name: 'Coin Delta', ticker: 'DELA', seedCents: 100_000 })).status).toBe(200);
    const mine = (await launchState(r, alice)).mine.find((m: any) => m.ticker === 'BETA');
    expect(mine).toMatchObject({ rugs: 1, canRug: false, valueNowCents: 0, pool: { dead: true, drainedCents: done.json.takenCents } });
    expect(mine.blocked).toMatch(/already: BETA is dead/);
    const admin = (await call(r, '/api/admin/state', { cookie: boss })).json;
    expect(admin.launches.find((l: any) => l.ticker === 'BETA')).toMatchObject({ rugs: 1, ruggedCents: done.json.takenCents, pool: { cents: 0, drainedCents: done.json.takenCents, dead: true } });
  }, LONG * 2);

  it('POOL-16: a coin from before pools keeps the old rug pull (one market sale of everything he holds); a stock too', async () => {
    const { r, alice } = await trading();
    r.app.services.db.run('DELETE FROM coin_pools');
    const done = await rug(r, alice);
    expect(done.status).toBe(200);
    expect(done.json).toMatchObject({ kind: 'sale', ticker: 'MPEP', requested: 2500, filled: 2500 });
    expect(rowsOf(r, 'SELECT * FROM launch_rugs')).toHaveLength(1);
    expect((await account(r, alice)).positions).toEqual([]);
  }, LONG);
});
