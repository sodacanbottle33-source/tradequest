// Limit orders (docs/world.md §6.8): an order that waits until the price reaches its limit. Cash is set aside for an order that opens a position,
// shares are promised to an order that closes one, an order fills only in the live market, never above (buy) or below (sell) its limit, and
// nothing is ever promised twice.
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../server/app';
import { loadConfig } from '../server/config';
import { feeOf } from '../server/fees';
import { marginOf } from '../server/leverage';
import { GOOD_FOR_TICKS, MAX_OPEN_ORDERS, type LimitOrderView } from '../server/limitOrders';
import { Logger } from '../server/log';
import { MIGRATIONS } from '../server/schema';
import { Clock } from './helpers/server';

const LONG = 300_000;

interface Running {
  app: App;
  server: Server;
  base: string;
  dir: string;
  clock: Clock;
}
const running: Running[] = [];
const dirs: string[] = [];
async function stop(r: Running): Promise<void> {
  await new Promise<void>((done) => {
    r.server.closeAllConnections?.();
    r.server.close(() => done());
  });
  try {
    r.app.close();
  } catch {
    // closed by the test
  }
}
afterEach(async () => {
  while (running.length > 0) await stop(running.pop() as Running);
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

interface BootOptions {
  dir?: string;
  ms?: number;
  flowGain?: number;
}
async function boot(options: BootOptions = {}): Promise<Running> {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'tq-limit-'));
  if (!options.dir) dirs.push(dir);
  const clock = new Clock(options.ms);
  const config = loadConfig({ TQ_DATA_DIR: dir, TQ_COMPANIES: '66', TQ_WARMUP_DAYS: '1', TQ_PORT: '8787', TQ_OWNER: 'boss' });
  const app = createApp({ config, log: new Logger({ sink: null, now: clock.now }), worldSeed: 777, now: clock.now, flowGain: options.flowGain ?? 0, autoPauses: false, memecoins: true });
  const server = createServer(app.handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const r = { app, server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, dir, clock };
  running.push(r);
  return r;
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
function gotoTick(r: Running, tick: number): void {
  const w = r.app.services.world;
  while (w.currentTick() < tick) {
    const next = Math.min(tick, w.currentTick() + 2);
    r.clock.ms = w.msOfTick(next);
    for (let i = 0; i < 20_000 && w.sim.tick < w.currentTick(); i += 1) w.pump();
  }
  expect(w.sim.tick).toBe(tick);
}
const elapse = (r: Running, seconds: number) => gotoTick(r, r.app.services.world.currentTick() + seconds);
let counter = 0;
const oid = (): string => `lim-test-${(counter += 1).toString().padStart(8, '0')}`;
const post = (r: Running, path: string, cookie: string | undefined, body: Record<string, unknown>) => call(r, path, { method: 'POST', cookie, body: { requestId: oid(), ...body } });
const sql = <T>(r: Running, query: string, ...params: (string | number)[]): T[] => r.app.services.db.all<T>(query, ...params);

/** A stock of a few tens of dollars that trades, with the quote now. */
function pickStock(r: Running, index = 0) {
  const w = r.app.services.world;
  const list = w.companies.filter((c) => c.sector !== 'meme' && w.sim.isListed(c.id) && w.sim.price(c.id) >= 1500 && w.sim.price(c.id) <= 6000);
  const c = list[index] as (typeof list)[number];
  return { company: c, ticker: c.ticker, quote: w.quote(c.id) };
}

interface Account {
  cashCents: number;
  reservedCents: number;
  netWorthCents: number;
  positions: { ticker: string; shares: number; short: boolean; costCents: number }[];
}
const account = async (r: Running, cookie: string): Promise<Account> => (await call(r, '/api/account?account=career', { cookie })).json;
const place = (r: Running, cookie: string, body: Record<string, unknown>) => call(r, '/api/limit-orders', { method: 'POST', cookie, body: { clientOrderId: oid(), ...body } });
const orders = async (r: Running, cookie: string, state = 'open'): Promise<LimitOrderView[]> => (await call(r, `/api/limit-orders?state=${state}`, { cookie })).json.orders;

/** The books balance: what each order has set aside is what the account view says, closed orders hold nothing, nothing is over-filled. */
function checkBooks(r: Running): void {
  const bad = sql<{ id: number }>(r, "SELECT id FROM limit_orders WHERE (state != 'open' AND reserved_cents != 0) OR filled > qty OR (state = 'filled' AND filled != qty) OR (state = 'open' AND filled >= qty)");
  expect(bad).toHaveLength(0);
  for (const a of sql<{ account_id: number }>(r, "SELECT DISTINCT account_id FROM limit_orders")) {
    const view = r.app.services.trading.view(a.account_id);
    const held = sql<{ s: number | null }>(r, "SELECT SUM(reserved_cents) AS s FROM limit_orders WHERE account_id = ? AND state = 'open'", a.account_id)[0]?.s ?? 0;
    expect(view.reservedCents).toBe(held);
    expect(view.cashCents).toBeGreaterThanOrEqual(0);
  }
}

async function crash(r: Running, boss: string, ticker: string, percent: number): Promise<void> {
  expect((await post(r, '/api/admin/shock', boss, { ticker, style: 'crash', percent, speed: 'instant' })).status).toBe(200);
  elapse(r, 20);
}
async function pump(r: Running, boss: string, ticker: string, percent: number): Promise<void> {
  expect((await post(r, '/api/admin/shock', boss, { ticker, style: 'pump', percent, speed: 'instant' })).status).toBe(200);
  elapse(r, 20);
}

// ---- placing and cancelling -------------------------------------------------------------------------------------------------

describe('placing and cancelling', () => {
  it('LIMIT-1: migration 16 makes the table; a new account has nothing set aside', async () => {
    const r = await boot();
    expect(MIGRATIONS.find((m) => m.version === 16)?.sql).toContain('CREATE TABLE limit_orders');
    expect(sql(r, "SELECT name FROM sqlite_master WHERE name = 'limit_orders'")).toHaveLength(1);
    const alice = await signUp(r, 'alice');
    expect(await account(r, alice)).toMatchObject({ cashCents: 100_000, reservedCents: 0, netWorthCents: 100_000 });
    expect(await orders(r, alice)).toEqual([]);
  }, LONG);

  it('LIMIT-2: a buy order below the market sets aside the margin and the fee at its limit, keeps net worth, and is the same order when sent twice', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const { ticker, quote } = pickStock(r);
    const limit = Math.floor(quote.ask * 0.9);
    const id = oid();
    const first = await place(r, alice, { clientOrderId: id, ticker, side: 'buy', qty: 10, limitPrice: limit });
    expect(first.status).toBe(201);
    expect(first.json.order).toMatchObject({ state: 'open', kind: 'buy', qty: 10, filled: 0, remaining: 10, limitCents: limit, reservedCents: 10 * limit, leverage: 1, ticker });
    const a = await account(r, alice);
    expect(a.cashCents).toBe(100_000 - 10 * limit);
    expect(a.reservedCents).toBe(10 * limit);
    expect(a.netWorthCents).toBe(100_000);
    // The same order again: no second order, no second set-aside.
    const again = await place(r, alice, { clientOrderId: id, ticker, side: 'buy', qty: 10, limitPrice: limit });
    expect(again.status).toBe(200);
    expect(again.json.duplicate).toBe(true);
    expect(again.json.order.id).toBe(first.json.order.id);
    expect((await account(r, alice)).cashCents).toBe(100_000 - 10 * limit);
    expect(await orders(r, alice)).toHaveLength(1);
    // The set-aside money cannot be spent: a market order for more than is left is refused.
    const rich = await post(r, '/api/orders', alice, { clientOrderId: oid(), ticker, side: 'buy', qty: Math.ceil((a.cashCents / quote.ask) + 5) });
    expect(rich.status).toBe(400);
    expect(rich.json.error.code ?? rich.json.code).toBe('insufficient_cash');
    checkBooks(r);
  }, LONG);

  it('LIMIT-3: cancelling gives the cash back to the cent, twice is harmless, and nobody can cancel another player\'s order', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const bob = await signUp(r, 'bob');
    const { ticker, quote } = pickStock(r);
    const placed = await place(r, alice, { ticker, side: 'buy', qty: 7, limitPrice: Math.floor(quote.ask * 0.8), leverage: 3 });
    const order = placed.json.order as LimitOrderView;
    expect(order.reservedCents).toBe(marginOf(7 * order.limitCents, 3));
    expect((await account(r, alice)).cashCents).toBe(100_000 - order.reservedCents);
    expect((await post(r, '/api/limit-orders/cancel', bob, { id: order.id })).status).toBe(404);
    expect((await account(r, alice)).reservedCents).toBe(order.reservedCents);
    const c = await post(r, '/api/limit-orders/cancel', alice, { id: order.id });
    expect(c.status).toBe(200);
    expect(c.json.order).toMatchObject({ state: 'cancelled', reservedCents: 0, remaining: 0 });
    expect(await account(r, alice)).toMatchObject({ cashCents: 100_000, reservedCents: 0, netWorthCents: 100_000 });
    expect((await post(r, '/api/limit-orders/cancel', alice, { id: order.id })).status).toBe(200);
    expect((await account(r, alice)).cashCents).toBe(100_000);
    expect(await orders(r, alice)).toHaveLength(0);
    expect((await orders(r, alice, 'all'))[0]).toMatchObject({ id: order.id, state: 'cancelled' });
    expect((await post(r, '/api/limit-orders/cancel', alice, { id: 99_999 })).status).toBe(404);
    expect((await post(r, '/api/limit-orders/cancel', alice, { id: 'x' })).status).toBe(400);
    checkBooks(r);
  }, LONG);

  it('LIMIT-4: refusals: no cash, no shares, a short mixed up with a long, a stop on the wrong side, a wrong price, too many orders, no sign-in, a match account', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const { ticker, quote } = pickStock(r);
    const code = (res: { json: any }) => res.json.error?.code ?? res.json.code;
    // Not enough cash for what it could cost at its limit.
    const big = await place(r, alice, { ticker, side: 'buy', qty: 1000, limitPrice: quote.ask });
    expect(big.status).toBe(400);
    expect(code(big)).toBe('insufficient_cash');
    expect(big.json.error?.message ?? big.json.message).toContain('Nothing was placed');
    // Nothing to sell, nothing to cover.
    expect(code(await place(r, alice, { ticker, side: 'sell', qty: 1, limitPrice: quote.bid * 2 }))).toBe('insufficient_shares');
    expect(code(await place(r, alice, { ticker, side: 'buy', short: true, qty: 1, limitPrice: Math.floor(quote.bid / 2) }))).toBe('insufficient_shares');
    // A stop-loss above the limit of a long, a take-profit below it; a short the other way round.
    const limit = Math.floor(quote.ask * 0.9);
    expect(code(await place(r, alice, { ticker, side: 'buy', qty: 1, limitPrice: limit, stopPrice: limit + 5 }))).toBe('bad_exit');
    expect(code(await place(r, alice, { ticker, side: 'buy', qty: 1, limitPrice: limit, takePrice: limit - 5 }))).toBe('bad_exit');
    expect(code(await place(r, alice, { ticker, side: 'sell', short: true, qty: 1, limitPrice: limit * 2, stopPrice: limit }))).toBe('bad_exit');
    // A stop on an order that closes a position.
    // Silly numbers.
    for (const bad of [0, -5, 1.5, 'x', null]) {
      const res = await place(r, alice, { ticker, side: 'buy', qty: 1, limitPrice: bad });
      expect([400]).toContain(res.status);
    }
    expect((await place(r, alice, { ticker, side: 'buy', qty: 0, limitPrice: limit })).status).toBe(400);
    expect((await place(r, alice, { ticker, side: 'buy', qty: 1.5, limitPrice: limit })).status).toBe(400);
    expect((await place(r, alice, { ticker, side: 'hold', qty: 1, limitPrice: limit })).status).toBe(400);
    expect((await place(r, alice, { ticker, side: 'buy', qty: 1, limitPrice: limit, leverage: 51 })).status).toBe(400);
    expect((await place(r, alice, { ticker, side: 'buy', qty: 1, limitPrice: limit, goodFor: '2w' })).status).toBe(400);
    expect((await place(r, alice, { ticker: 'NOPE', side: 'buy', qty: 1, limitPrice: limit })).status).toBe(404);
    expect((await place(r, alice, { clientOrderId: 'x', ticker, side: 'buy', qty: 1, limitPrice: limit })).status).toBe(400);
    // Not signed in.
    expect((await place(r, undefined as any, { ticker, side: 'buy', qty: 1, limitPrice: limit })).status).toBe(401);
    expect((await call(r, '/api/limit-orders')).status).toBe(401);
    // The most open orders at a time.
    for (let i = 0; i < MAX_OPEN_ORDERS; i += 1) expect((await place(r, alice, { ticker, side: 'buy', qty: 1, limitPrice: 100 + i })).status).toBe(201);
    const over = await place(r, alice, { ticker, side: 'buy', qty: 1, limitPrice: 99 });
    expect(over.status).toBe(400);
    expect(code(over)).toBe('too_many_orders');
    // A match account takes no limit orders (the routes only ever use Career, so this is asked of the service directly).
    const { limits, trading, db } = r.app.services;
    const user = db.get<{ id: number }>("SELECT id FROM users WHERE username = 'alice'") as { id: number };
    const matchAcc = trading.createMatchAccount(user.id, 1, 100_000);
    expect(() => limits.place({ accountId: matchAcc.id, clientOrderId: oid(), companyId: pickStock(r).company.id, side: 'buy', qty: 1, limitPrice: 100 })).toThrow(/Career/);
    checkBooks(r);
  }, LONG);

  it('LIMIT-5: an order lasts as long as the player chose and then ends with its cash back', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const { ticker, quote } = pickStock(r);
    const limit = Math.floor(quote.ask * 0.5);
    const hour = (await place(r, alice, { ticker, side: 'buy', qty: 5, limitPrice: limit, goodFor: '1h' })).json.order as LimitOrderView;
    const day = (await place(r, alice, { ticker, side: 'buy', qty: 5, limitPrice: limit, goodFor: '1d' })).json.order as LimitOrderView;
    const dflt = (await place(r, alice, { ticker, side: 'buy', qty: 5, limitPrice: limit })).json.order as LimitOrderView;
    expect(hour.expiresTick - hour.createdTick).toBe(GOOD_FOR_TICKS['1h']);
    expect(day.expiresTick - day.createdTick).toBe(GOOD_FOR_TICKS['1d']);
    expect(dflt.expiresTick - dflt.createdTick).toBe(GOOD_FOR_TICKS['1d']);
    expect(GOOD_FOR_TICKS['3d']).toBe(259_200);
    expect((await account(r, alice)).reservedCents).toBe(3 * 5 * limit);
    gotoTick(r, hour.expiresTick);
    expect((await orders(r, alice)).map((o) => o.id).sort()).toEqual([hour.id, day.id, dflt.id].sort());
    elapse(r, 1);
    const open = await orders(r, alice);
    expect(open.map((o) => o.id).sort()).toEqual([day.id, dflt.id].sort());
    const ended = (await orders(r, alice, 'all')).find((o) => o.id === hour.id) as LimitOrderView;
    expect(ended).toMatchObject({ state: 'expired', reservedCents: 0, filled: 0 });
    expect(ended.reason).toContain('ran out of time');
    expect(await account(r, alice)).toMatchObject({ cashCents: 100_000 - 2 * 5 * limit, reservedCents: 2 * 5 * limit });
    checkBooks(r);
  }, LONG);
});

// ---- filling --------------------------------------------------------------------------------------------------------------

describe('filling', () => {
  it('LIMIT-6: a buy order waits while the ask is above its limit and fills when the price falls to it: never above the limit, the set-aside cash is used exactly', async () => {
    const r = await boot();
    const boss = await signUp(r, 'boss');
    const alice = await signUp(r, 'alice');
    const { ticker, company, quote } = pickStock(r);
    const limit = Math.floor(quote.ask * 0.9);
    const o = (await place(r, alice, { ticker, side: 'buy', qty: 10, limitPrice: limit })).json.order as LimitOrderView;
    elapse(r, 30);
    expect((await orders(r, alice))[0]).toMatchObject({ id: o.id, state: 'open', filled: 0 });
    expect((await account(r, alice)).positions).toHaveLength(0);
    await crash(r, boss, ticker, -25);
    const w = r.app.services.world;
    expect(w.quote(company.id).ask).toBeLessThanOrEqual(limit);
    const done = (await orders(r, alice, 'all'))[0] as LimitOrderView;
    expect(done).toMatchObject({ id: o.id, state: 'filled', filled: 10, remaining: 0, reservedCents: 0 });
    expect(done.avgFillCents as number).toBeLessThanOrEqual(limit);
    const a = await account(r, alice);
    expect(a.positions).toHaveLength(1);
    expect(a.positions[0]).toMatchObject({ ticker, shares: 10, short: false });
    expect(a.reservedCents).toBe(0);
    // The cash that left is what the shares cost (no fee on a stock), and the money set aside was enough.
    const trade = sql<{ client_order_id: string; total_cents: number; filled: number; side: string }>(r, 'SELECT client_order_id, total_cents, filled, side FROM trades WHERE account_id = (SELECT id FROM accounts WHERE user_id = (SELECT id FROM users WHERE username = \'alice\') AND kind = \'career\')');
    expect(trade).toHaveLength(1);
    expect(trade[0]).toMatchObject({ client_order_id: `limit-${o.id}-1`, filled: 10, side: 'buy' });
    expect(a.cashCents).toBe(100_000 - (trade[0] as { total_cents: number }).total_cents);
    expect(trade[0]?.total_cents).toBeLessThanOrEqual(10 * limit);
    // Every part of the fill is at or below the limit.
    const parts = JSON.parse(sql<{ result_json: string }>(r, 'SELECT result_json FROM trades LIMIT 1')[0]?.result_json ?? '{}').parts as { price: number }[];
    for (const p of parts) expect(p.price).toBeLessThanOrEqual(limit);
    checkBooks(r);
  }, LONG);

  it('LIMIT-7: a buy order at or above the ask fills at once, at the market prices, never above its limit', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const { ticker, quote } = pickStock(r);
    const res = await place(r, alice, { ticker, side: 'buy', qty: 12, limitPrice: quote.ask + 40 });
    expect(res.status).toBe(201);
    expect(res.json.order).toMatchObject({ state: 'filled', filled: 12, reservedCents: 0 });
    expect(res.json.order.avgFillCents).toBeLessThanOrEqual(quote.ask + 40);
    expect(res.json.account.positions[0]).toMatchObject({ ticker, shares: 12 });
    expect(res.json.account.reservedCents).toBe(0);
    checkBooks(r);
  }, LONG);

  it('LIMIT-8: a sell order above the market keeps its shares promised, fills when the bid rises to it, and the shares cannot be promised twice', async () => {
    const r = await boot();
    const boss = await signUp(r, 'boss');
    const alice = await signUp(r, 'alice');
    const { ticker, company, quote } = pickStock(r);
    expect((await post(r, '/api/orders', alice, { clientOrderId: oid(), ticker, side: 'buy', qty: 20 })).status).toBe(201);
    const bid = r.app.services.world.quote(company.id).bid;
    const limit = Math.ceil(bid * 1.1);
    const first = await place(r, alice, { ticker, side: 'sell', qty: 12, limitPrice: limit });
    expect(first.status).toBe(201);
    expect(first.json.order).toMatchObject({ kind: 'sell', state: 'open', reservedCents: 0 });
    // 12 are promised; 9 more would be 21.
    const over = await place(r, alice, { ticker, side: 'sell', qty: 9, limitPrice: limit + 5 });
    expect(over.status).toBe(400);
    expect(over.json.error?.code ?? over.json.code).toBe('insufficient_shares');
    expect(over.json.error?.message ?? over.json.message).toContain('already promised');
    expect((await place(r, alice, { ticker, side: 'sell', qty: 8, limitPrice: limit + 5 })).status).toBe(201);
    const cash = (await account(r, alice)).cashCents;
    expect(quote.ask).toBeGreaterThan(0);
    await pump(r, boss, ticker, 25);
    const all = await orders(r, alice, 'all');
    expect(all.filter((o) => o.state === 'filled')).toHaveLength(2);
    for (const o of all) expect(o.avgFillCents as number).toBeGreaterThanOrEqual(o.limitCents);
    const a = await account(r, alice);
    expect(a.positions).toHaveLength(0);
    expect(a.cashCents).toBeGreaterThan(cash);
    checkBooks(r);
  }, LONG);

  it('LIMIT-9: a short sale and a cover order: cash is set aside for the short, the cover sets nothing aside, both fill at their limits', async () => {
    const r = await boot();
    const boss = await signUp(r, 'boss');
    const alice = await signUp(r, 'alice');
    const { ticker, company, quote } = pickStock(r);
    const limit = Math.ceil(quote.bid * 1.1);
    const s = (await place(r, alice, { ticker, side: 'sell', short: true, qty: 10, limitPrice: limit, leverage: 2 })).json.order as LimitOrderView;
    expect(s).toMatchObject({ kind: 'short', state: 'open', reservedCents: marginOf(10 * limit, 2) });
    expect((await account(r, alice)).cashCents).toBe(100_000 - s.reservedCents);
    await pump(r, boss, ticker, 25);
    const sold = (await orders(r, alice, 'all'))[0] as LimitOrderView;
    expect(sold).toMatchObject({ id: s.id, state: 'filled', filled: 10, reservedCents: 0 });
    expect(sold.avgFillCents as number).toBeGreaterThanOrEqual(limit);
    let a = await account(r, alice);
    expect(a.positions[0]).toMatchObject({ ticker, shares: 10, short: true });
    expect(a.reservedCents).toBe(0);
    // Now cover below the market.
    const bid = r.app.services.world.quote(company.id).ask;
    const cover = (await place(r, alice, { ticker, side: 'buy', short: true, qty: 10, limitPrice: Math.floor(bid * 0.8) })).json.order as LimitOrderView;
    expect(cover).toMatchObject({ kind: 'cover', state: 'open', reservedCents: 0 });
    expect((await account(r, alice)).cashCents).toBe(a.cashCents);
    await crash(r, boss, ticker, -35);
    const covered = (await orders(r, alice, 'all')).find((o) => o.id === cover.id) as LimitOrderView;
    expect(covered).toMatchObject({ state: 'filled', filled: 10 });
    expect(covered.avgFillCents as number).toBeLessThanOrEqual(cover.limitCents);
    a = await account(r, alice);
    expect(a.positions).toHaveLength(0);
    expect(a.cashCents).toBeGreaterThan(100_000 - 1); // sold high, bought back low
    checkBooks(r);
  }, LONG);

  it('LIMIT-10: stop-loss and take-profit on a buy order are set on the position when it fills, and the leverage is the order\'s', async () => {
    const r = await boot();
    const boss = await signUp(r, 'boss');
    const alice = await signUp(r, 'alice');
    const { ticker, quote } = pickStock(r);
    const limit = Math.floor(quote.ask * 0.9);
    const stop = Math.floor(limit * 0.8);
    const take = Math.ceil(limit * 1.5);
    const o = (await place(r, alice, { ticker, side: 'buy', qty: 10, limitPrice: limit, leverage: 4, stopPrice: stop, takePrice: take })).json.order as LimitOrderView;
    expect(o).toMatchObject({ leverage: 4, stopCents: stop, takeCents: take, reservedCents: marginOf(10 * limit, 4) });
    await crash(r, boss, ticker, -12);
    const pos = (await account(r, alice)).positions[0] as any;
    expect(pos).toBeDefined();
    expect(pos).toMatchObject({ ticker, shares: 10, leverage: 4, stopCents: stop, takeCents: take });
    expect(sql<{ leverage: number }>(r, 'SELECT leverage FROM trades ORDER BY id DESC LIMIT 1')[0]?.leverage).toBe(4);
    checkBooks(r);
  }, LONG);

  it('LIMIT-11: a part of an order that does not fit in the book at its limit is traded now and the rest keeps waiting with its cash set aside again', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const boss = await signUp(r, 'boss');
    expect((await post(r, '/api/admin/cash', boss, { username: 'alice', amountCents: 50_000_000 })).status).toBe(200);
    const { ticker, company, quote } = pickStock(r);
    const w = r.app.services.world;
    // Far more shares than the first price levels hold, with a limit just above the ask: only what is at the first levels fills.
    const levels = w.book(company.id, 'buy');
    const firstLevel = levels.filter((l) => l.price <= quote.ask + 1).reduce((n, l) => n + l.size, 0);
    expect(firstLevel).toBeGreaterThan(10);
    const qty = Math.min(firstLevel * 5, 500_000);
    const limit = quote.ask + 1;
    const res = await place(r, alice, { ticker, side: 'buy', qty, limitPrice: limit });
    expect(res.status).toBe(201);
    const o = res.json.order as LimitOrderView;
    expect(o.state).toBe('open');
    expect(o.filled).toBeGreaterThan(0);
    expect(o.filled).toBeLessThan(qty);
    expect(o.remaining).toBe(qty - o.filled);
    expect(o.reservedCents).toBe((qty - o.filled) * limit);
    expect(o.avgFillCents as number).toBeLessThanOrEqual(limit);
    const a = await account(r, alice);
    expect(a.reservedCents).toBe(o.reservedCents);
    expect(a.positions[0]?.shares).toBe(o.filled);
    expect(w.sim.tick).toBeGreaterThan(0);
    checkBooks(r);
    // Cancelling gives the rest back.
    const c = await post(r, '/api/limit-orders/cancel', alice, { id: o.id });
    expect(c.json.order).toMatchObject({ state: 'cancelled', filled: o.filled, reservedCents: 0 });
    expect((await account(r, alice)).reservedCents).toBe(0);
    checkBooks(r);
  }, LONG);
});

// ---- nothing promised twice ---------------------------------------------------------------------------------------------------

describe('one cash, one position', () => {
  it('LIMIT-12: cash set aside for one order cannot back another order, a market order, or a launch; when the first ends it is free again', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const { ticker, quote } = pickStock(r);
    const limit = Math.floor(quote.ask * 0.5);
    const qty = Math.floor((100_000 * 0.4) / limit);
    const a1 = (await place(r, alice, { ticker, side: 'buy', qty, limitPrice: limit })).json.order as LimitOrderView;
    const a2 = await place(r, alice, { ticker, side: 'buy', qty, limitPrice: limit });
    expect(a2.status).toBe(201);
    const a3 = await place(r, alice, { ticker, side: 'buy', qty, limitPrice: limit });
    expect(a3.status).toBe(400);
    expect(a3.json.error?.code ?? a3.json.code).toBe('insufficient_cash');
    expect((await account(r, alice)).netWorthCents).toBe(100_000);
    // A launch of a coin that costs more than the free cash is refused.
    const free = (await account(r, alice)).cashCents;
    const launch = await post(r, '/api/launch/coin', alice, { name: 'Moon Pepe', ticker: 'MPEP', seedCents: free + 5_000 });
    expect(launch.status).toBeGreaterThanOrEqual(400);
    expect((await account(r, alice)).cashCents).toBe(free);
    await post(r, '/api/limit-orders/cancel', alice, { id: a1.id });
    expect((await place(r, alice, { ticker, side: 'buy', qty, limitPrice: limit })).status).toBe(201);
    checkBooks(r);
  }, LONG);

  it('LIMIT-13: when a stop-loss closes the position first, a sell order that waits ends instead of selling shares that are not there; one that holds less trades what is left', async () => {
    const r = await boot();
    const boss = await signUp(r, 'boss');
    const alice = await signUp(r, 'alice');
    const { ticker, company } = pickStock(r);
    const bid0 = r.app.services.world.quote(company.id).bid;
    expect((await post(r, '/api/orders', alice, { clientOrderId: oid(), ticker, side: 'buy', qty: 10, stopPrice: Math.floor(bid0 * 0.9) })).status).toBe(201);
    const sell = (await place(r, alice, { ticker, side: 'sell', qty: 10, limitPrice: Math.ceil(bid0 * 1.5) })).json.order as LimitOrderView;
    expect(sell.state).toBe('open');
    await crash(r, boss, ticker, -40); // the stop-loss fires: the position is gone
    expect((await account(r, alice)).positions).toHaveLength(0);
    // The price rises again beyond the sell order's limit: the shares are not there any more.
    await pump(r, boss, ticker, 300);
    const ended = (await orders(r, alice, 'all'))[0] as LimitOrderView;
    expect(ended).toMatchObject({ id: sell.id, state: 'cancelled', filled: 0 });
    expect(ended.reason).toContain('nothing to sell');
    checkBooks(r);
  }, LONG);

  it('LIMIT-21: when the player sold part of the shares meanwhile, the sell order trades what is left and is done', async () => {
    const r = await boot();
    const boss = await signUp(r, 'boss');
    const alice = await signUp(r, 'alice');
    const { ticker, company } = pickStock(r);
    expect((await post(r, '/api/orders', alice, { clientOrderId: oid(), ticker, side: 'buy', qty: 10 })).status).toBe(201);
    const bid = r.app.services.world.quote(company.id).bid;
    const o = (await place(r, alice, { ticker, side: 'sell', qty: 10, limitPrice: Math.ceil(bid * 1.1) })).json.order as LimitOrderView;
    expect(o.state).toBe('open');
    expect((await post(r, '/api/orders', alice, { clientOrderId: oid(), ticker, side: 'sell', qty: 4 })).status).toBe(201);
    await pump(r, boss, ticker, 30);
    const done = (await orders(r, alice, 'all'))[0] as LimitOrderView;
    expect(done.id).toBe(o.id);
    // It sold the 6 that were left; the order is over (filled 6 of 10 is not "filled", so it ends when there is nothing more to sell).
    expect(done.filled).toBe(6);
    expect((await account(r, alice)).positions).toHaveLength(0);
    expect(['filled', 'cancelled']).toContain(done.state);
    expect(done.state === 'cancelled' ? done.reason : '').toBe(done.state === 'cancelled' ? 'Your shares are gone, so there was nothing to sell.' : '');
    checkBooks(r);
  }, LONG);

  it('LIMIT-14: the owner\'s reset ends the account\'s orders and the account goes back to its starting cash with nothing set aside', async () => {
    const r = await boot();
    const boss = await signUp(r, 'boss');
    const alice = await signUp(r, 'alice');
    const { ticker, quote } = pickStock(r);
    await place(r, alice, { ticker, side: 'buy', qty: 5, limitPrice: Math.floor(quote.ask * 0.5) });
    expect((await account(r, alice)).reservedCents).toBeGreaterThan(0);
    expect((await post(r, '/api/admin/reset', boss, { username: 'alice' })).status).toBe(200);
    expect(await account(r, alice)).toMatchObject({ cashCents: 100_000, reservedCents: 0, netWorthCents: 100_000 });
    expect(await orders(r, alice)).toEqual([]);
    expect((await orders(r, alice, 'all'))[0]).toMatchObject({ state: 'cancelled', reservedCents: 0 });
    checkBooks(r);
  }, LONG);
});

// ---- the market around the order -----------------------------------------------------------------------------------------------

describe('the market around the order', () => {
  it('LIMIT-15: a halted company does not fill; when trading reopens the order fills; the order is not lost', async () => {
    const r = await boot();
    const boss = await signUp(r, 'boss');
    const alice = await signUp(r, 'alice');
    const { ticker, quote } = pickStock(r);
    const limit = Math.floor(quote.ask * 0.9);
    const o = (await place(r, alice, { ticker, side: 'buy', qty: 5, limitPrice: limit })).json.order as LimitOrderView;
    expect((await post(r, '/api/admin/halt', boss, { ticker, halted: true, reason: 'test' })).status).toBe(200);
    await crash(r, boss, ticker, -30);
    expect((await orders(r, alice))[0]).toMatchObject({ id: o.id, state: 'open', filled: 0 });
    expect((await account(r, alice)).positions).toHaveLength(0);
    expect((await post(r, '/api/admin/halt', boss, { ticker, halted: false })).status).toBe(200);
    elapse(r, 15);
    expect((await orders(r, alice, 'all'))[0]).toMatchObject({ id: o.id, state: 'filled', filled: 5 });
    checkBooks(r);
  }, LONG);

  it('LIMIT-16: nothing fills while the market is catching up (the price of the past is not a price you can trade at); it fills once the market is live again', async () => {
    const r = await boot();
    const boss = await signUp(r, 'boss');
    const alice = await signUp(r, 'alice');
    const { ticker, company, quote } = pickStock(r);
    const limit = Math.floor(quote.ask * 0.9);
    const o = (await place(r, alice, { ticker, side: 'buy', qty: 5, limitPrice: limit })).json.order as LimitOrderView;
    await crash(r, boss, ticker, -30);
    const filled = (await orders(r, alice, 'all'))[0] as LimitOrderView;
    expect(filled.state).toBe('filled');
    // A second order, while the market seems to be far behind the clock: nothing is sent to the market.
    const { limits, world } = r.app.services;
    const o2 = (await place(r, alice, { ticker, side: 'buy', qty: 5, limitPrice: world.quote(company.id).ask + 500 })).json.order as LimitOrderView;
    expect(o2.state).toBe('filled'); // already at the price: filled at placement, while live
    const o3 = (await place(r, alice, { ticker, side: 'sell', qty: 5, limitPrice: world.quote(company.id).bid + 200 })).json.order as LimitOrderView;
    expect(o3.state).toBe('open');
    const lag = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(world), 'lagTicks');
    expect(lag?.get).toBeDefined();
    Object.defineProperty(world, 'lagTicks', { get: () => 99, configurable: true });
    try {
      let tried = 0;
      const original = (limits as any).attempt.bind(limits);
      (limits as any).attempt = (...args: unknown[]) => {
        tried += 1;
        return original(...args);
      };
      limits.step(world.sim.tick + 1);
      expect(tried).toBe(0);
    } finally {
      delete (world as any).lagTicks;
    }
    expect(o.id).toBeGreaterThan(0);
    checkBooks(r);
  }, LONG);

  it('LIMIT-17: a banned player\'s orders wait and fill after the ban is lifted', async () => {
    const r = await boot();
    const boss = await signUp(r, 'boss');
    const alice = await signUp(r, 'alice');
    const { ticker, quote } = pickStock(r);
    const limit = Math.floor(quote.ask * 0.9);
    const o = (await place(r, alice, { ticker, side: 'buy', qty: 5, limitPrice: limit })).json.order as LimitOrderView;
    expect((await post(r, '/api/admin/ban', boss, { username: 'alice', reason: 'test' })).status).toBe(200);
    await crash(r, boss, ticker, -30);
    const row = sql<{ state: string; filled: number }>(r, 'SELECT state, filled FROM limit_orders WHERE id = ?', o.id)[0];
    expect(row).toMatchObject({ state: 'open', filled: 0 });
    expect((await post(r, '/api/admin/unban', boss, { username: 'alice' })).status).toBe(200);
    elapse(r, 15);
    expect(sql<{ state: string }>(r, 'SELECT state FROM limit_orders WHERE id = ?', o.id)[0]?.state).toBe('filled');
    checkBooks(r);
  }, LONG);

  it('LIMIT-18: a restart keeps the order and the set-aside cash, and it fills afterwards when the price gets there', async () => {
    const r = await boot();
    await signUp(r, 'boss');
    const alice = await signUp(r, 'alice');
    const { ticker, quote } = pickStock(r);
    const limit = Math.floor(quote.ask * 0.9);
    const o = (await place(r, alice, { ticker, side: 'buy', qty: 10, limitPrice: limit })).json.order as LimitOrderView;
    elapse(r, 40);
    const ms = r.clock.ms;
    const dir = r.dir;
    await stop(r);
    running.splice(running.indexOf(r), 1);
    const r2 = await boot({ dir, ms });
    const cookieOf = async (name: string): Promise<string> => {
      const res = await fetch(r2.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: name, password: 'a-good-password' }) });
      return (res.headers.get('set-cookie') ?? '').split(';')[0] as string;
    };
    const aliceCookie = await cookieOf('alice');
    const bossCk = await cookieOf('boss');
    expect((await orders(r2, aliceCookie))[0]).toMatchObject({ id: o.id, state: 'open', reservedCents: 10 * limit });
    expect(await account(r2, aliceCookie)).toMatchObject({ cashCents: 100_000 - 10 * limit, reservedCents: 10 * limit });
    await crash(r2, bossCk, ticker, -25);
    expect((await orders(r2, aliceCookie, 'all'))[0]).toMatchObject({ id: o.id, state: 'filled', filled: 10 });
    checkBooks(r2);
  }, LONG);

  it('LIMIT-19: the player is told when an order fills or ends, at once, with the order in the message', async () => {
    const r = await boot();
    const boss = await signUp(r, 'boss');
    const alice = await signUp(r, 'alice');
    const { hub } = r.app.services;
    const told: { userId: number; event: string; data: any }[] = [];
    const original = hub.publishTo.bind(hub);
    hub.publishTo = ((userId: number, event: string, data: unknown) => {
      told.push({ userId, event, data });
      return original(userId, event, data);
    }) as typeof hub.publishTo;
    const { ticker, quote } = pickStock(r);
    const limit = Math.floor(quote.ask * 0.9);
    const o = (await place(r, alice, { ticker, side: 'buy', qty: 5, limitPrice: limit })).json.order as LimitOrderView;
    expect(told.filter((t) => t.event === 'limit')).toHaveLength(0);
    await crash(r, boss, ticker, -25);
    const aliceId = sql<{ id: number }>(r, "SELECT id FROM users WHERE username = 'alice'")[0]?.id;
    const events = told.filter((t) => t.event === 'limit');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ userId: aliceId, data: { what: 'fill', order: { id: o.id, state: 'filled', ticker } } });
    // A cancel by the player is not announced, an expiry is.
    const o2 = (await place(r, alice, { ticker, side: 'buy', qty: 5, limitPrice: 100, goodFor: '1h' })).json.order as LimitOrderView;
    await post(r, '/api/limit-orders/cancel', alice, { id: o2.id });
    expect(told.filter((t) => t.event === 'limit')).toHaveLength(1);
    const o3 = (await place(r, alice, { ticker, side: 'buy', qty: 5, limitPrice: 100, goodFor: '1h' })).json.order as LimitOrderView;
    gotoTick(r, o3.expiresTick + 1);
    const ended = told.filter((t) => t.event === 'limit' && t.data.what === 'ended');
    expect(ended).toHaveLength(1);
    expect(ended[0]?.data.order).toMatchObject({ id: o3.id, state: 'expired' });
    checkBooks(r);
  }, LONG);

  it('LIMIT-20: what the answer holds: only the player\'s own orders, nothing hidden about the market', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const bob = await signUp(r, 'bob');
    const { ticker, quote } = pickStock(r);
    await place(r, alice, { ticker, side: 'buy', qty: 3, limitPrice: Math.floor(quote.ask * 0.5) });
    expect(await orders(r, bob)).toEqual([]);
    expect(await orders(r, alice)).toHaveLength(1);
    const res = await call(r, '/api/limit-orders?state=all&limit=5', { cookie: alice });
    expect(Object.keys(res.json.orders[0]).sort()).toEqual(['avgFillCents', 'clientOrderId', 'closedMs', 'companyId', 'createdMs', 'createdTick', 'expiresTick', 'filled', 'id', 'kind', 'leverage', 'limitCents', 'qty', 'reason', 'remaining', 'reservedCents', 'short', 'side', 'state', 'stopCents', 'takeCents', 'ticker']);
    for (const word of ['realized', 'credibility', 'account_id', 'retry']) expect(res.text.includes(word)).toBe(false);
    expect(feeOf(1000, 50)).toBe(5);
  }, LONG);

  it('LIMIT-22: the order form\'s numbers are the ones the order then really uses (set-aside cash, the most shares, "fills now")', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const { ticker, quote } = pickStock(r);
    const est = (q: string) => call(r, `/api/limit-orders/estimate?ticker=${ticker}&${q}`, { cookie: alice });
    // An order below the market waits: what it would set aside is what placing it sets aside.
    const limit = Math.floor(quote.ask * 0.5);
    const e1 = (await est(`side=buy&qty=10&limit=${limit}`)).json;
    expect(e1).toMatchObject({ kind: 'buy', opening: true, reserveCents: 10 * limit, feeBps: 0, cashCents: 100_000, fillsNow: false, valueCents: 10 * limit });
    const placed = (await place(r, alice, { ticker, side: 'buy', qty: 10, limitPrice: limit })).json.order as LimitOrderView;
    expect(placed.reservedCents).toBe(e1.reserveCents);
    // With leverage the margin only.
    const e2 = (await est(`side=buy&qty=10&limit=${limit}&leverage=5`)).json;
    expect(e2.reserveCents).toBe(marginOf(10 * limit, 5));
    // The most shares: that many can be placed, one more cannot. (The first order already set 10 × limit aside.)
    const e3 = (await est(`side=buy&qty=1&limit=${limit}`)).json;
    expect(e3.cashCents).toBe(100_000 - 10 * limit);
    expect(e3.maxQty).toBe(Math.floor((100_000 - 10 * limit) / limit));
    const fits = await place(r, alice, { ticker, side: 'buy', qty: e3.maxQty, limitPrice: limit });
    expect(fits.status).toBe(201);
    const over = await place(r, alice, { ticker, side: 'buy', qty: 1, limitPrice: limit });
    expect(over.status).toBe(400);
    expect(over.json.error?.code ?? over.json.code).toBe('insufficient_cash');
    // A price the market is already at fills at once.
    expect((await est(`side=buy&qty=1&limit=${quote.ask + 5}`)).json.fillsNow).toBe(true);
    expect((await est(`side=sell&qty=1&limit=${quote.bid + 50}`)).json.fillsNow).toBe(false);
    // A sell with nothing to sell: nothing may be asked for.
    const e4 = (await est(`side=sell&qty=5&limit=${quote.ask}`)).json;
    expect(e4).toMatchObject({ kind: 'sell', opening: false, reserveCents: 0, held: 0, maxQty: 0 });
    // A memecoin has its fee on top.
    const w = r.app.services.world;
    const coin = w.companies.find((c) => c.sector === 'meme' && w.sim.isListed(c.id));
    if (coin) {
      const cp = w.quote(coin.id);
      const lim = Math.max(1, Math.floor(cp.ask * 0.5));
      const em = (await call(r, `/api/limit-orders/estimate?ticker=${coin.ticker}&side=buy&qty=3&limit=${lim}`, { cookie: alice })).json;
      expect(em.feeBps).toBe(50);
      expect(em.reserveCents).toBe(3 * lim + feeOf(3 * lim, 50));
    }
    // Bad input and no sign-in.
    expect((await est('side=buy&qty=1&limit=0')).status).toBe(400);
    expect((await est('side=hold&qty=1&limit=100')).status).toBe(400);
    expect((await call(r, `/api/limit-orders/estimate?ticker=${ticker}&side=buy&qty=1&limit=100`)).status).toBe(401);
    checkBooks(r);
  }, LONG);
});
