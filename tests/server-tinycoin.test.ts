// Coins that cost a tiny fraction of a cent, seen through the whole server (server/trading.ts, server/launch.ts, server/admin.ts, server/routes/core.ts, the
// world runtime). The rules checked here: a rug-pulled coin sits at the lowest price there is ($0.00000000000001), for good, also after a restart, and cannot
// be traded; a coin from before the tiny prices that was rug pulled freezes too, after its 99 % fall; the "spend this much" estimate; rounding in tiny
// prices cannot make money (buy and sell the same tokens never gains, and the books balance to the cent); the owner can move up to a coin's trillion
// tokens; and the order limits follow the coin (a trillion tokens for a launched coin, 100 million shares for the rest).
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../server/app';
import { loadConfig } from '../server/config';
import { Logger } from '../server/log';
import { Clock } from './helpers/server';

const LONG = 240_000;

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

async function logIn(r: Running, name: string): Promise<string> {
  const res = await fetch(r.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: name, password: 'a-good-password' }) });
  expect(res.status).toBe(200);
  return (res.headers.get('set-cookie') ?? '').split(';')[0] as string;
}

/**
 * Turns a coin that was just launched (and has not listed yet) into one from before the tiny prices and before money pools: counted in cents,
 * 80,000 coins at $2.00 each (2,500 of them for the $5,000), no pool row. The server is restarted so that it loads the coin that way, so the
 * players have to log in again (the cookies come back in `names` order).
 */
async function asOldCoin(r: Running, keepPool: boolean, ...names: string[]): Promise<{ r: Running; cookies: string[] }> {
  const db = r.app.services.db;
  const row = db.get('SELECT company_id, entry_json FROM meme_companies WHERE ticker = ?', 'MPEP') as { company_id: number; entry_json: string };
  const entry = JSON.parse(row.entry_json);
  entry.price = 200;
  entry.meme.supply = 80_000;
  delete entry.meme.priceScale;
  db.run('UPDATE meme_companies SET entry_json = ? WHERE company_id = ?', JSON.stringify(entry), row.company_id);
  db.run('UPDATE launches SET price_cents = 200, stake_shares = 2500, spent_cents = 500000 WHERE company_id = ?', row.company_id);
  db.run('UPDATE positions SET shares = 2500 WHERE company_id = ?', row.company_id);
  if (!keepPool) db.run('DELETE FROM coin_pools WHERE company_id = ?', row.company_id);
  const again = await restart(r);
  const cookies: string[] = [];
  for (const n of names) cookies.push(await logIn(again, n));
  return { r: again, cookies };
}

async function signUp(r: Running, name: string): Promise<string> {
  const res = await fetch(r.base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: name, password: 'a-good-password' }) });
  expect(res.status).toBe(201);
  return (res.headers.get('set-cookie') ?? '').split(';')[0] as string;
}

let counter = 0;
const rid = (): string => `req-${(counter += 1).toString().padStart(8, '0')}`;
const post = (r: Running, path: string, cookie: string | undefined, body: Record<string, unknown>) => call(r, path, { method: 'POST', cookie, body: { requestId: rid(), ...body } });

/** $5,000 first buy: 31.25 billion tokens at $0.00000016 each (a trillion tokens in all). A billion tokens cost about $160. */
const MOON = { name: 'Moon Pepe', ticker: 'MPEP', seedCents: 500_000 };
const MOON_TOKENS = 31_250_000_000;
const BILLION = 1_000_000_000;
const launchCoin = (r: Running, cookie: string | undefined, over: Record<string, unknown> = {}) => post(r, '/api/launch/coin', cookie, { ...MOON, ...over });
const rug = (r: Running, cookie: string | undefined, ticker = 'MPEP', over: Record<string, unknown> = {}) => post(r, '/api/launch/rug', cookie, { ticker, ...over });
const fund = (r: Running, boss: string, username: string, amountCents: number) => post(r, '/api/admin/cash', boss, { username, amountCents });

let orderNo = 0;
const trade = (r: Running, cookie: string, body: Record<string, unknown> = {}) =>
  call(r, '/api/orders', { method: 'POST', cookie, body: { account: 'career', ticker: 'MPEP', side: 'buy', qty: 10, clientOrderId: `order-${(orderNo += 1)}-abcdef`, ...body } });
const estimate = (r: Running, cookie: string, side: 'buy' | 'sell', qty: number, ticker = 'MPEP', extra = '') => call(r, `/api/market/${ticker}/estimate?side=${side}&qty=${qty}${extra}`, { cookie });

const rowsOf = (r: Running, sql: string, ...params: (string | number)[]) => r.app.services.db.all(sql, ...params);
const account = async (r: Running, cookie: string) => (await call(r, '/api/account', { cookie })).json;
const market = async (r: Running) => (await call(r, '/api/market')).json.companies as any[];
const priceOf = async (r: Running, ticker: string): Promise<number> => (await market(r)).find((c) => c.ticker === ticker).price;

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


const DUST_CENTS = 1e-12; // the lowest price there is: $0.00000000000001 is a trillionth of a cent

describe('a rug-pulled coin', () => {
  it('TINYS-01: sits at the lowest price there is and never moves again, is worth nothing, cannot be traded, and is the same after a restart', async () => {
    const { r, alice, bob } = await trading();
    expect((await trade(r, bob, { qty: BILLION })).status).toBe(201);
    advance(r, 20);
    const before = await priceOf(r, 'MPEP');
    expect(before).toBeGreaterThan(1e-6);
    expect(before).toBeLessThan(10);
    const done = await rug(r, alice);
    expect(done.status).toBe(200);
    expect(done.json).toMatchObject({ kind: 'drain', otherCoins: BILLION, ownCoins: MOON_TOKENS });
    advance(r, 60);
    expect(await priceOf(r, 'MPEP')).toBe(DUST_CENTS);
    const w = r.app.services.world;
    const id = w.companyByTicker('MPEP')?.id as number;
    expect(w.sim.isDead(id)).toBe(true);

    // It stays there for hours; the candles after the fall are flat at that price.
    const tick0 = w.sim.tick;
    advance(r, 6 * 3600);
    expect(await priceOf(r, 'MPEP')).toBe(DUST_CENTS);
    const candles = (await call(r, '/api/market/MPEP/candles?res=c10&limit=200')).json.candles as any[];
    const late = candles.slice(-100);
    expect(late.length).toBeGreaterThan(50);
    for (const c of late) expect([c.open, c.high, c.low, c.close]).toEqual([DUST_CENTS, DUST_CENTS, DUST_CENTS, DUST_CENTS]);
    expect(w.sim.tick).toBeGreaterThan(tick0);

    // Worth nothing in the account, and not tradable for anybody.
    const acc = await account(r, bob);
    expect(acc.positions[0]).toMatchObject({ ticker: 'MPEP', shares: BILLION, dead: true, valueCents: 0, equityCents: 0 });
    expect(acc.netWorthCents).toBe(acc.cashCents);
    for (const res of [await trade(r, bob, { side: 'sell', qty: BILLION }), await trade(r, bob, { qty: BILLION }), await estimate(r, bob, 'sell', 1000), await estimate(r, bob, 'buy', 1000)]) {
      expect(res.status).toBe(403);
      expect(res.json.error.code).toBe('not_allowed');
    }

    // A restart gives the very same world.
    const tick = w.sim.tick;
    const r2 = await restart(r);
    catchUp(r2);
    expect(r2.app.services.world.sim.tick).toBe(tick);
    expect(await priceOf(r2, 'MPEP')).toBe(DUST_CENTS);
    advance(r2, 3600);
    expect(await priceOf(r2, 'MPEP')).toBe(DUST_CENTS);
    expect(r2.app.services.world.sim.isDead(id)).toBe(true);
  }, LONG * 2);

  it('TINYS-02: a coin from before the tiny prices that already had a pool and was rug pulled falls 99 % as before and then freezes (it used to keep moving)', async () => {
    const first = await players();
    expect((await launchCoin(first.r, first.alice)).status).toBe(200);
    const { r, cookies } = await asOldCoin(first.r, true, 'alice', 'bob');
    const [alice, bob] = cookies as [string, string];
    advance(r, 45);
    expect((await trade(r, bob, { qty: 10 })).status).toBe(201); // ten coins at $2.00
    advance(r, 20);
    const before = await priceOf(r, 'MPEP');
    expect(before).toBeGreaterThan(100); // cents: dollars, like every older coin
    const done = await rug(r, alice);
    expect(done.status).toBe(200);
    expect(done.json.kind).toBe('drain');
    const news = rowsOf(r, "SELECT realized FROM news_items WHERE key LIKE 'rug:%'") as { realized: number }[];
    expect(news[0]!.realized).toBeLessThan(-0.5); // the fall of 99 % is still part of the story for these coins
    advance(r, 120);
    const after = await priceOf(r, 'MPEP');
    expect(after).toBeLessThan(before);
    expect(after).toBe(100); // a $2 coin falling 99 % lands on the old floor of $1.00 and stays there
    // Frozen: for hours it does not move at all (before this update such a coin went on moving after its fall).
    advance(r, 6 * 3600);
    expect(await priceOf(r, 'MPEP')).toBe(after);
    const r2 = await restart(r);
    catchUp(r2);
    expect(await priceOf(r2, 'MPEP')).toBe(after);
    advance(r2, 3600);
    expect(await priceOf(r2, 'MPEP')).toBe(after);
  }, LONG * 2);
});

describe('the "spend this much" estimate', () => {
  it('TINYS-03: maxQty is the most tokens the money buys, never more than the cash, and what it allows never costs more than the budget', async () => {
    const { r, bob } = await trading();
    const free = (await estimate(r, bob, 'buy', 1)).json;
    expect(free.maxQty).toBeGreaterThan(1e9); // with all his $11,000 he can buy many billions of tokens
    for (const budget of [50, 1_000, 100_000, 700_000]) {
      const e = (await estimate(r, bob, 'buy', 1, 'MPEP', `&budget=${budget}`)).json;
      expect(e.maxQty).toBeGreaterThan(0);
      expect(e.maxQty).toBeLessThanOrEqual(free.maxQty);
      const at = (await estimate(r, bob, 'buy', e.maxQty, 'MPEP')).json;
      expect(at.filledQty).toBe(e.maxQty);
      expect(at.totalCents + at.feeCents).toBeLessThanOrEqual(budget);
      // A few per cent more tokens would cost more than the budget (the money is used up, not left lying around).
      const more = (await estimate(r, bob, 'buy', Math.ceil(e.maxQty * 1.05) + 10, 'MPEP')).json;
      expect(more.totalCents + more.feeCents).toBeGreaterThan(budget);
    }
    // A budget bigger than the cash is cut down to the cash; nothing at all buys nothing.
    const huge = (await estimate(r, bob, 'buy', 1, 'MPEP', '&budget=900000000000')).json;
    expect(huge.maxQty).toBe(free.maxQty);
    const none = (await estimate(r, bob, 'buy', 1, 'MPEP', '&budget=0')).json;
    expect(none.maxQty).toBe(0);
    expect((await estimate(r, bob, 'buy', 1, 'MPEP', '&budget=-5')).status).toBe(400);
    expect((await estimate(r, bob, 'buy', 1, 'MPEP', '&budget=abc')).status).toBe(400);
    // And a real order for that many tokens goes through for that money.
    const plan = (await estimate(r, bob, 'buy', 1, 'MPEP', '&budget=100000')).json;
    const cash = (await account(r, bob)).cashCents;
    const bought = await trade(r, bob, { qty: plan.maxQty });
    expect(bought.status).toBe(201);
    expect(cash - (await account(r, bob)).cashCents).toBeLessThanOrEqual(100_000);
  }, LONG);
});

describe('rounding at tiny prices', () => {
  it('TINYS-04: buying and selling the same tokens right away never gains, whatever the size, and the books balance to the cent at every step', async () => {
    const { r, bob } = await trading();
    const total = money(r);
    let orders = 0;
    for (const size of [1, 2, 7, 999, 62_500, 100_000, 1_234_567, 98_765_432, BILLION]) {
      advance(r, 25);
      const cash = (await account(r, bob)).cashCents;
      const b = await trade(r, bob, { qty: size });
      if (b.status !== 201) throw new Error(`buy of ${size} failed: ${b.text}`);
      expect(money(r)).toBe(total);
      const s = await trade(r, bob, { side: 'sell', qty: size });
      if (s.status !== 201) throw new Error(`sale of ${size} failed: ${s.text}`);
      expect(money(r)).toBe(total);
      expect((await account(r, bob)).cashCents).toBeLessThanOrEqual(cash); // never a cent more than he started with
      const pool = rowsOf(r, 'SELECT pool_cents, in_cents, out_cents, drained_cents FROM coin_pools')[0] as { pool_cents: number; in_cents: number; out_cents: number; drained_cents: number };
      expect(pool.pool_cents).toBe(pool.in_cents - pool.out_cents - pool.drained_cents);
      expect(pool.pool_cents).toBeGreaterThanOrEqual(0);
      orders += 2;
    }
    expect(orders).toBe(18);
  }, LONG * 2);

  it('TINYS-05: a one-token order costs a whole cent when it is bought and pays nothing when it is sold: no free money from rounding in either direction', async () => {
    const { r, bob } = await trading();
    const cash = (await account(r, bob)).cashCents;
    const b = await trade(r, bob, { qty: 1 });
    expect(b.status).toBe(201);
    expect(b.json.trade.totalCents).toBe(1);
    expect((await account(r, bob)).cashCents).toBeLessThanOrEqual(cash - 1);
    advance(r, 20);
    const s = await trade(r, bob, { side: 'sell', qty: 1 });
    expect(s.status).toBe(201);
    expect(s.json.trade.totalCents).toBe(0);
    expect((await account(r, bob)).positions).toEqual([]);
  }, LONG);
});

describe('the owner and the limits', () => {
  it('TINYS-06: the owner can give or take up to a trillion tokens of a launched coin, and a few of any other company', async () => {
    const { r, boss, bob } = await trading();
    const give = async (qty: number, ticker = 'MPEP') => post(r, '/api/admin/shares', boss, { username: 'bob', ticker, qty });
    const ok = await give(500_000_000_000);
    expect(ok.status).toBe(200);
    expect(ok.json.shares).toBe(500_000_000_000);
    const acc = await account(r, bob);
    expect(acc.positions[0]).toMatchObject({ ticker: 'MPEP', shares: 500_000_000_000 });
    expect(acc.netWorthCents).toBeGreaterThan(5_000_000); // about $80,000 of coins at $0.00000016 each, less the gap
    expect((await give(-100_000_000_000)).json.shares).toBe(400_000_000_000);
    expect((await give(1_000_000_000_001)).status).toBe(400); // more tokens than the coin has
    expect((await give(0)).status).toBe(400);
    expect((await give(-400_000_000_001)).status).toBe(400); // more than he holds
    const stockTicker = (await market(r))[0].ticker as string;
    expect((await give(1_000_000_000, stockTicker)).status).toBe(400); // any other company: the usual limit per action
    expect((await give(5, stockTicker)).status).toBe(200);
  }, LONG);

  it('TINYS-07: an order may be for up to a trillion tokens of a launched coin and up to 100 million shares of any other company', async () => {
    const { r, bob } = await trading();
    const tooMany = await trade(r, bob, { qty: 1_000_000_000_001 });
    expect(tooMany.status).toBe(400);
    expect(tooMany.json.error.message).toMatch(/1,000,000,000,000/);
    const stockTicker = (await market(r))[0].ticker as string;
    const tooManyShares = await trade(r, bob, { ticker: stockTicker, qty: 100_000_001 });
    expect(tooManyShares.status).toBe(400);
    expect(tooManyShares.json.error.message).toMatch(/100,000,000/);
    expect((await estimate(r, bob, 'buy', 1_000_000_000_001)).status).toBe(400);
    expect((await estimate(r, bob, 'buy', 1_000_000_000_000)).status).toBe(200);
    expect((await estimate(r, bob, 'buy', 100_000_001, stockTicker)).status).toBe(400);
  }, LONG);

  it('TINYS-08: the market list and the account show prices in cents as decimals: a launched coin is a tiny number, every other company is as before', async () => {
    const { r, bob } = await trading();
    expect((await trade(r, bob, { qty: BILLION })).status).toBe(201);
    advance(r, 10);
    const rows = await market(r);
    const coin = rows.find((c) => c.ticker === 'MPEP');
    expect(coin.price).toBeGreaterThan(1e-8);
    expect(coin.price).toBeLessThan(10);
    expect(Number.isInteger(coin.price)).toBe(false);
    expect(coin.marketCapCents).toBeGreaterThan(1_000_000); // about $160,000
    expect(coin.marketCapCents).toBeLessThan(10_000_000_000);
    for (const c of rows.filter((x) => x.ticker !== 'MPEP')) expect(Number.isInteger(c.price)).toBe(true);
    const acc = await account(r, bob);
    const p = acc.positions[0];
    expect(p.markCents).toBeGreaterThan(1e-8);
    expect(p.avgCostCents).toBeGreaterThan(1e-8);
    expect(p.avgCostCents).toBeLessThan(10);
    expect(p.costCents).toBeGreaterThan(10_000);
    const detail = (await call(r, '/api/market/MPEP')).json;
    expect(detail.sharesOutstanding).toBe(1_000_000_000_000);
  }, LONG);
});
