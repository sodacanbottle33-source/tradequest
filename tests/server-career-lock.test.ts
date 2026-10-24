// Career trading is closed while a player's own 1v1 match is starting or running (docs/world.md §9.12). Career money moves prices, and a match is
// scored on the shared prices, so with Career money a player could push the price his match is scored on. While his match is in the countdown or live
// (and he has not forfeited it), new Career orders, limit orders and stop-loss / take-profit settings are refused with 409 `in_match`. His match account
// trades as always, everybody else's Career is untouched, and Career opens again the moment the match is over, cancelled or forfeited.
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../server/app';
import { loadConfig } from '../server/config';
import { CAREER_CLOSED_IN_MATCH } from '../server/lobby/service';
import { Logger } from '../server/log';
import { Clock } from './helpers/server';

const LONG = 480_000;

interface Running {
  app: App;
  server: Server;
  base: string;
  dir: string;
  clock: Clock;
  players: Set<string>;
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
      // closed by the test
    }
  }
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

async function boot(): Promise<Running> {
  const dir = mkdtempSync(join(tmpdir(), 'tq-cl-'));
  dirs.push(dir);
  const clock = new Clock();
  const config = loadConfig({ TQ_DATA_DIR: dir, TQ_COMPANIES: '66', TQ_WARMUP_DAYS: '1', TQ_PORT: '8787', TQ_OWNER: 'boss' });
  // The built-in memecoins are in this world: a match account has to be able to trade them.
  const app = createApp({ config, log: new Logger({ sink: null, now: clock.now }), worldSeed: 777, now: clock.now, flowGain: 0, bots: true, botWaitMs: 10_000, memecoins: true });
  const server = createServer(app.handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const r = { app, server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, dir, clock, players: new Set<string>() };
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
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] as string;
  r.players.add(cookie);
  return cookie;
}

/** Moves the server clock to a tick, letting the market catch up and letting open pages ask about the lobby every 5 seconds, as the real page does. */
async function gotoTick(r: Running, tick: number): Promise<void> {
  const w = r.app.services.world;
  while (w.currentTick() < tick) {
    const next = Math.min(tick, w.currentTick() + 5);
    r.clock.ms = w.msOfTick(next);
    for (let i = 0; i < 20_000 && w.sim.tick < w.currentTick(); i += 1) w.pump();
    for (const cookie of r.players) await call(r, '/api/lobby', { cookie });
  }
  expect(w.sim.tick).toBe(tick);
}
const elapse = (r: Running, seconds: number) => gotoTick(r, r.app.services.world.currentTick() + seconds);

let counter = 0;
const rid = (): string => `req-${(counter += 1).toString().padStart(8, '0')}`;
const post = (r: Running, path: string, cookie: string | undefined, body: Record<string, unknown>) => call(r, path, { method: 'POST', cookie, body: { requestId: rid(), ...body } });
const lobby = (r: Running, cookie: string, action: string, body?: Record<string, unknown>) => call(r, `/api/lobby/${action}`, { method: 'POST', cookie, body });
const sql = <T>(r: Running, query: string, ...params: (string | number)[]): T[] => r.app.services.db.all<T>(query, ...params);

let orderNo = 0;
const order = (r: Running, cookie: string, account: 'career' | 'match', ticker: string, body: Record<string, unknown> = {}) =>
  call(r, '/api/orders', { method: 'POST', cookie, body: { account, ticker, side: 'buy', qty: 2, clientOrderId: `order-${(orderNo += 1)}-abcdef`, ...body } });
const limitOrder = (r: Running, cookie: string, body: Record<string, unknown>) =>
  call(r, '/api/limit-orders', { method: 'POST', cookie, body: { clientOrderId: `limit-${(orderNo += 1)}-abcdef`, side: 'buy', qty: 2, ...body } });
const accountOf = async (r: Running, cookie: string, account = 'career') => (await call(r, `/api/account?account=${account}`, { cookie })).json;
const cashOf = async (r: Running, cookie: string, account = 'career'): Promise<number> => (await accountOf(r, cookie, account)).cashCents;

/** What a Career account holds, without the live prices (those move with the market). */
const held = (a: { positions: { ticker: string; shares: number; short: boolean; costCents: number }[] }) => a.positions.map((x) => `${x.ticker} ${x.short ? 'short' : 'long'} ${x.shares} for ${x.costCents}`);

/** A listed stock and a listed built-in coin (not launched by a player), with their quotes now. */
function pick(r: Running) {
  const w = r.app.services.world;
  const launched = new Set(sql<{ company_id: number }>(r, 'SELECT company_id FROM launches').map((l) => l.company_id));
  const good = (meme: boolean) => w.companies.find((c) => (c.sector === 'meme') === meme && !launched.has(c.id) && w.sim.isListed(c.id) && w.sim.price(c.id) >= 300 && w.sim.price(c.id) <= 20_000);
  const stock = good(false);
  const coin = good(true);
  expect(stock).toBeDefined();
  expect(coin).toBeDefined();
  return { stock: stock as NonNullable<typeof stock>, coin: coin as NonNullable<typeof coin>, quote: (id: number) => w.quote(id) };
}

/** The owner, three players with Career cash, and a stock of alice's Career that she already holds (so a stop-loss can be set on it). */
async function world() {
  const r = await boot();
  const boss = await signUp(r, 'boss');
  const alice = await signUp(r, 'alice');
  const bob = await signUp(r, 'bob');
  for (const name of ['alice', 'bob']) expect((await post(r, '/api/admin/cash', boss, { username: name, amountCents: 2_000_000 })).status).toBe(200);
  await elapse(r, 30);
  const p = pick(r);
  expect((await order(r, alice, 'career', p.stock.ticker, { qty: 3 })).status).toBeLessThan(300);
  return { r, boss, alice, bob, ...p };
}

/** The player plays a bot and is ready: the countdown is running. Returns the match view. */
async function startBotMatch(r: Running, cookie: string) {
  expect((await lobby(r, cookie, 'bot')).status).toBe(200);
  const view = (await lobby(r, cookie, 'ready', { ready: true })).json.match;
  expect(view.phase).toBe('countdown');
  return view;
}

/** Every Career write that exists, tried by one player: all must be refused with the same answer. */
async function tryEverything(r: Running, cookie: string, stock: string, bid: number) {
  const refused: { name: string; status: number; code?: string; message?: string }[] = [];
  const note = (name: string, res: { status: number; json: any }) => refused.push({ name, status: res.status, code: res.json?.error?.code, message: res.json?.error?.message });
  note('buy', await order(r, cookie, 'career', stock, { side: 'buy' }));
  note('sell', await order(r, cookie, 'career', stock, { side: 'sell', qty: 1 }));
  note('short', await order(r, cookie, 'career', stock, { side: 'sell', short: true }));
  note('default account', await call(r, '/api/orders', { method: 'POST', cookie, body: { ticker: stock, side: 'buy', qty: 1, clientOrderId: `order-${(orderNo += 1)}-abcdef` } }));
  note('limit', await limitOrder(r, cookie, { ticker: stock, limitPrice: Math.max(1, Math.floor(bid * 0.9)) }));
  note('exits', await post(r, '/api/positions/exits', cookie, { ticker: stock, stopPrice: Math.max(1, Math.floor(bid * 0.8)) }));
  return refused;
}

describe('Career is closed during your own match', () => {
  it('CL-1: in the countdown and while live, every new Career order is refused (buy, sell, short, limit order, stop-loss); nothing moves; your match account trades a stock and a memecoin; reading and cancelling still work', async () => {
    // The words are the player's only explanation (the test below compares with this constant), so they are pinned here.
    expect(CAREER_CLOSED_IN_MATCH).toBe('Career trading is closed while your 1v1 match is starting or running. Trade inside the match, or come back to Career when it is over.');
    const { r, alice, stock, coin, quote } = await world();
    // A limit order placed before the match: it waits, and cancelling it during the match is still allowed (it only gives cash back).
    const q = quote(stock.id);
    const waiting = await limitOrder(r, alice, { ticker: stock.ticker, limitPrice: Math.max(1, Math.floor(q.ask * 0.5)), qty: 2 });
    expect(waiting.status).toBe(201);
    const before = await accountOf(r, alice);
    // The bot in the match trades too, so only alice's Career account is counted.
    const careerTrades = () => sql<{ n: number }>(r, "SELECT COUNT(*) AS n FROM trades WHERE account_id IN (SELECT a.id FROM accounts a JOIN users u ON u.id = a.user_id WHERE u.username = 'alice' AND a.kind = 'career')")[0]?.n;
    const tradesBefore = careerTrades();
    expect(tradesBefore).toBe(1);

    const view = await startBotMatch(r, alice);
    // ---- countdown ----
    for (const phase of ['countdown', 'live']) {
      if (phase === 'live') {
        await gotoTick(r, view.startTick + 20);
        expect((await call(r, '/api/lobby', { cookie: alice })).json.match.phase).toBe('live');
      }
      const refused = await tryEverything(r, alice, stock.ticker, quote(stock.id).bid);
      for (const x of refused) {
        expect({ phase, ...x }).toEqual({ phase, name: x.name, status: 409, code: 'in_match', message: CAREER_CLOSED_IN_MATCH });
      }
      expect(refused).toHaveLength(6);
      // Nothing moved: same cash, same positions, same set-aside money, no new trade.
      const now = await accountOf(r, alice);
      expect({ cash: now.cashCents, reserved: now.reservedCents, held: held(now) }).toEqual({ cash: before.cashCents, reserved: before.reservedCents, held: held(before) });
      expect(careerTrades()).toBe(tradesBefore);
      expect(sql(r, "SELECT id FROM limit_orders WHERE state = 'open'")).toHaveLength(1);
    }

    // ---- the match account is not affected ----
    expect((await call(r, '/api/lobby', { cookie: alice })).json.match.canTrade).toBe(true);
    const buyStock = await order(r, alice, 'match', stock.ticker, { qty: 2 });
    expect([200, 201]).toContain(buyStock.status);
    const buyCoin = await order(r, alice, 'match', coin.ticker, { qty: 5 });
    expect([200, 201]).toContain(buyCoin.status);
    const inMatch = await accountOf(r, alice, 'match');
    expect(inMatch.positions.map((x: any) => x.ticker).sort()).toEqual([coin.ticker, stock.ticker].sort());
    expect(inMatch.cashCents).toBeLessThan(100_000);
    // The Career account is still exactly as it was.
    expect(await cashOf(r, alice)).toBe(before.cashCents);

    // ---- reading and cancelling are not trading ----
    expect((await call(r, `/api/market/${stock.ticker}/estimate?side=buy&qty=2&account=career`, { cookie: alice })).status).toBe(200);
    expect((await call(r, '/api/limit-orders?state=open', { cookie: alice })).status).toBe(200);
    expect((await call(r, '/api/limit-orders/estimate?ticker=' + stock.ticker + '&side=buy&qty=1&limit=' + Math.floor(q.ask * 0.5), { cookie: alice })).status).toBe(200);
    const cancelled = await call(r, '/api/limit-orders/cancel', { method: 'POST', cookie: alice, body: { id: waiting.json.order.id } });
    expect(cancelled.status).toBe(200);
    expect((await accountOf(r, alice)).reservedCents).toBe(0);
  }, LONG);

  it('CL-2: Career opens again when the match is over; only waiting in a lobby (alone, or with a bot that has not been accepted) does not close it', async () => {
    const { r, alice, stock } = await world();
    // Waiting alone, then with a bot that has joined but is not accepted yet.
    expect((await lobby(r, alice, 'join')).status).toBe(200);
    expect((await order(r, alice, 'career', stock.ticker, { qty: 1 })).status).toBeLessThan(300);
    await elapse(r, 12);
    expect((await call(r, '/api/lobby', { cookie: alice })).json.match.phase).toBe('ready_check');
    expect((await order(r, alice, 'career', stock.ticker, { qty: 1 })).status).toBeLessThan(300);
    expect((await limitOrder(r, alice, { ticker: stock.ticker, limitPrice: 100 })).status).toBe(201);

    // The countdown starts: closed.
    const view = (await lobby(r, alice, 'ready', { ready: true })).json.match;
    expect(view.phase).toBe('countdown');
    expect((await order(r, alice, 'career', stock.ticker, { qty: 1 })).status).toBe(409);
    // The match ends: open at once.
    await gotoTick(r, view.endTick + 15);
    await elapse(r, 3);
    const done = (await call(r, '/api/lobby', { cookie: alice })).json.match;
    expect(done.phase).toBe('finished');
    const after = await order(r, alice, 'career', stock.ticker, { qty: 1 });
    expect(after.status).toBeLessThan(300);
    expect((await post(r, '/api/positions/exits', alice, { ticker: stock.ticker, stopPrice: 100 })).status).toBe(200);
    expect((await limitOrder(r, alice, { ticker: stock.ticker, limitPrice: 100 })).status).toBe(201);
  }, LONG);

  it('CL-3: leaving the countdown (the match is cancelled) opens Career at once; other players are never affected', async () => {
    const { r, alice, bob, stock } = await world();
    await startBotMatch(r, alice);
    expect((await order(r, alice, 'career', stock.ticker, { qty: 1 })).status).toBe(409);
    // Bob is not in a match: his Career trades while alice's match is starting.
    expect((await order(r, bob, 'career', stock.ticker, { qty: 1 })).status).toBeLessThan(300);
    expect((await limitOrder(r, bob, { ticker: stock.ticker, limitPrice: 100 })).status).toBe(201);
    expect((await post(r, '/api/positions/exits', bob, { ticker: stock.ticker, stopPrice: 100 })).status).toBe(200);
    // Alice leaves before it starts.
    await lobby(r, alice, 'leave');
    const free = await order(r, alice, 'career', stock.ticker, { qty: 1 });
    expect(free.status).toBeLessThan(300);
  }, LONG);

  it('CL-4: against another player, the one who forfeits can use Career at once (he cannot trade in the match any more); the opponent stays closed until it ends', async () => {
    const { r, alice, bob, stock } = await world();
    await lobby(r, alice, 'join');
    await lobby(r, bob, 'join');
    await lobby(r, alice, 'ready', { ready: true });
    const view = (await lobby(r, bob, 'ready', { ready: true })).json.match;
    await gotoTick(r, view.startTick + 20);
    expect((await order(r, alice, 'career', stock.ticker, { qty: 1 })).status).toBe(409);
    expect((await order(r, bob, 'career', stock.ticker, { qty: 1 })).status).toBe(409);

    const left = await lobby(r, alice, 'leave');
    expect(left.json.match.players.find((p: any) => p.you).forfeited).toBe(true);
    expect((await order(r, alice, 'career', stock.ticker, { qty: 1 })).status).toBeLessThan(300);
    const stillClosed = await order(r, bob, 'career', stock.ticker, { qty: 1 });
    expect(stillClosed.status).toBe(409);
    expect(stillClosed.json.error.code).toBe('in_match');

    await gotoTick(r, view.endTick + 15);
    await elapse(r, 3);
    expect((await call(r, '/api/lobby', { cookie: bob })).json.match.phase).toBe('finished');
    expect((await order(r, bob, 'career', stock.ticker, { qty: 1 })).status).toBeLessThan(300);
  }, LONG);

  it('CL-5: nobody is exempt, not even the owner; the owner panel and other kinds of requests are not touched', async () => {
    const { r, boss, alice, stock } = await world();
    await startBotMatch(r, boss);
    const refused = await order(r, boss, 'career', stock.ticker, { qty: 1 });
    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe('in_match');
    // The admin tools are the owner's own business, not trading: a gift of cash to a player still works.
    const before = await cashOf(r, alice);
    expect((await post(r, '/api/admin/cash', boss, { username: 'alice', amountCents: 100_000 })).status).toBe(200);
    expect(await cashOf(r, alice)).toBe(before + 100_000);
    // Signing in state, the market and the news are open to read as always.
    expect((await call(r, '/api/market', { cookie: boss })).status).toBe(200);
  }, LONG);

  it('CL-6: a bad Career request during a match still gets the match answer, and a request for the match account is never mistaken for Career', async () => {
    const { r, alice, stock } = await world();
    const view = await startBotMatch(r, alice);
    await gotoTick(r, view.startTick + 20);
    // A match order without an account name goes to Career (the default), as it always did: closed.
    const noName = await call(r, '/api/orders', { method: 'POST', cookie: alice, body: { ticker: stock.ticker, side: 'buy', qty: 1, clientOrderId: `order-${(orderNo += 1)}-abcdef` } });
    expect(noName.status).toBe(409);
    // Naming the match account goes to the match: open.
    expect([200, 201]).toContain((await order(r, alice, 'match', stock.ticker, { qty: 1 })).status);
    // Stop-loss on a match position works; the same call for Career does not.
    const exitsMatch = await post(r, '/api/positions/exits', alice, { account: 'match', ticker: stock.ticker, stopPrice: 1 });
    expect(exitsMatch.status).toBe(200);
    const exitsCareer = await post(r, '/api/positions/exits', alice, { account: 'career', ticker: stock.ticker, stopPrice: 1 });
    expect(exitsCareer.status).toBe(409);
  }, LONG);
});
