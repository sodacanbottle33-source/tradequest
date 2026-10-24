// Companies that players launched and 1v1 matches (docs/world.md §9.10). Anybody who launches a coin or a stock holds a big part of it and could push its
// price up with his Career money while a match runs; a match is scored on the shared price, so he could win with it. So: a match account can never trade
// a launched company (orders and estimates are refused, the 1v1 list leaves them out, bots never pick them), and nobody can launch while his own match is
// starting or running. Career trading of launched companies is not touched.
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../server/app';
import { loadConfig } from '../server/config';
import { LAUNCHED_IN_MATCH, NO_LAUNCH_IN_MATCH } from '../server/lobby/service';
import { BotTrader, PERSONAS } from '../server/lobby/bots';
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
  const dir = mkdtempSync(join(tmpdir(), 'tq-lm-'));
  dirs.push(dir);
  const clock = new Clock();
  const config = loadConfig({ TQ_DATA_DIR: dir, TQ_COMPANIES: '66', TQ_WARMUP_DAYS: '1', TQ_PORT: '8787', TQ_OWNER: 'boss' });
  // No built-in memecoins in this world: the only coins in it are the ones players launch.
  const app = createApp({ config, log: new Logger({ sink: null, now: clock.now }), worldSeed: 777, now: clock.now, flowGain: 0, bots: true, botWaitMs: 10_000, memecoins: false });
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
const MOON = { name: 'Moon Pepe', ticker: 'MPEP', seedCents: 500_000 };
const ACME = { name: 'Acme Robotics', ticker: 'ACMR', sector: 'robotics', seedCents: 500_000 };
const launchCoin = (r: Running, cookie: string, over: Record<string, unknown> = {}) => post(r, '/api/launch/coin', cookie, { ...MOON, ...over });
const launchStock = (r: Running, cookie: string, over: Record<string, unknown> = {}) => post(r, '/api/launch/stock', cookie, { ...ACME, ...over });
const sql = <T>(r: Running, query: string, ...params: (string | number)[]): T[] => r.app.services.db.all<T>(query, ...params);

let orderNo = 0;
const order = (r: Running, cookie: string, account: 'career' | 'match', ticker: string, body: Record<string, unknown> = {}) =>
  call(r, '/api/orders', { method: 'POST', cookie, body: { account, ticker, side: 'buy', qty: 2, clientOrderId: `order-${(orderNo += 1)}-abcdef`, ...body } });
const cashOf = async (r: Running, cookie: string, account = 'career'): Promise<number> => (await call(r, `/api/account?account=${account}`, { cookie })).json.cashCents;

/** The owner, alice ($1,000 of her own plus $20,000 from the owner) and a coin and a stock alice launched and that are already trading. */
async function world() {
  const r = await boot();
  const boss = await signUp(r, 'boss');
  const alice = await signUp(r, 'alice');
  expect((await post(r, '/api/admin/cash', boss, { username: 'alice', amountCents: 2_000_000 })).status).toBe(200);
  expect((await launchCoin(r, alice)).status).toBe(200);
  expect((await launchStock(r, alice)).status).toBe(200);
  await elapse(r, 60);
  return { r, boss, alice };
}

/** Alice plays a bot and both are ready: the countdown is running. Returns the match view. */
async function startBotMatch(r: Running, cookie: string) {
  expect((await call(r, '/api/lobby/bot', { method: 'POST', cookie })).status).toBe(200);
  const view = (await call(r, '/api/lobby/ready', { method: 'POST', cookie, body: { ready: true } })).json.match;
  expect(view.phase).toBe('countdown');
  return view;
}

describe('a match cannot trade companies that players launched', () => {
  it('LM-1: in a live match, orders and estimates for a launched coin or stock are refused with the reason; every other company still trades; Career is untouched', async () => {
    const { r, alice } = await world();
    const bob = await signUp(r, 'bob');
    const view = await startBotMatch(r, alice);
    await gotoTick(r, view.startTick);
    expect((await call(r, '/api/lobby', { cookie: alice })).json.match.canTrade).toBe(true);

    for (const ticker of ['MPEP', 'ACMR']) {
      const res = await order(r, alice, 'match', ticker);
      expect(res.status).toBe(403);
      expect(res.json.error.code).toBe('not_allowed');
      expect(res.json.error.message).toBe(LAUNCHED_IN_MATCH);
      const est = await call(r, `/api/market/${ticker}/estimate?side=buy&qty=2&account=match`, { cookie: alice });
      expect(est.status).toBe(403);
      expect(est.json.error.message).toBe(LAUNCHED_IN_MATCH);
      // Shorting and selling are refused the same way (there is nothing to close, but the rule is about the company).
      expect((await order(r, alice, 'match', ticker, { side: 'sell', short: true })).status).toBe(403);
    }
    expect(sql(r, "SELECT * FROM trades WHERE account_id IN (SELECT id FROM accounts WHERE kind = 'match')")).toHaveLength(0);
    expect(await cashOf(r, alice, 'match')).toBe(100_000);

    // Any other company trades in the match as before.
    const ok = await order(r, alice, 'match', 'QLRX');
    expect([200, 201]).toContain(ok.status);
    expect((await call(r, '/api/market/QLRX/estimate?side=buy&qty=2&account=match', { cookie: alice })).status).toBe(200);

    // Career: the launched coin trades as always for anybody who is not in a match, and the estimate works. Alice's own Career is closed while her match runs (docs/world.md §9.12).
    const career = await order(r, bob, 'career', 'MPEP', { qty: 5 });
    expect([200, 201]).toContain(career.status);
    expect((await call(r, '/api/market/MPEP/estimate?side=buy&qty=5&account=career', { cookie: bob })).status).toBe(200);
    const closed = await order(r, alice, 'career', 'ACMR', { qty: 1 });
    expect(closed.status).toBe(409);
    expect(closed.json.error.code).toBe('in_match');
  }, LONG);

  it('LM-2: the company list says which companies players launched, from the moment they are launched (also before they trade)', async () => {
    const r = await boot();
    const boss = await signUp(r, 'boss');
    const alice = await signUp(r, 'alice');
    await post(r, '/api/admin/cash', boss, { username: 'alice', amountCents: 2_000_000 });
    const before = (await call(r, '/api/market')).json.companies as any[];
    expect(before.every((c) => c.launched === false)).toBe(true);
    await launchCoin(r, alice);
    await launchStock(r, alice);
    await elapse(r, 2); // not listed yet: the company is in the list, not trading
    const early = (await call(r, '/api/market')).json.companies as any[];
    const moon = early.find((c) => c.ticker === 'MPEP');
    expect(moon).toBeTruthy();
    expect(moon.launched).toBe(true);
    await elapse(r, 60);
    const rows = (await call(r, '/api/market')).json.companies as any[];
    expect(rows.filter((c) => c.launched).map((c) => c.ticker).sort()).toEqual(['ACMR', 'MPEP']);
    expect(rows.filter((c) => c.launched && !c.trading)).toHaveLength(0);
    expect(rows.filter((c) => !c.launched).length).toBe(rows.length - 2);
    expect((await call(r, '/api/market/MPEP')).json.launched).toBe(true);
    expect((await call(r, '/api/market/QLRX')).json.launched).toBe(false);
  }, LONG);

  it('LM-3: a company the owner creates by hand (Admin → Create stock) is not a launch and trades in a match like any company; launched ones still do not', async () => {
    const { r, boss } = await world();
    // The owner's "Create stock" is not a launch: it can be traded in a match like any company.
    const made = await post(r, '/api/admin/stock', boss, { name: 'Owner Works', ticker: 'OWNW', sector: 'robotics', tier: 'small', personality: 'steady', priceCents: 2500 });
    expect(made.status).toBe(200);
    await elapse(r, 60);
    const rows = (await call(r, '/api/market')).json.companies as any[];
    expect(rows.find((c) => c.ticker === 'OWNW').launched).toBe(false);
    const bob = await signUp(r, 'bob');
    const view = await startBotMatch(r, bob);
    await gotoTick(r, view.startTick);
    expect([200, 201]).toContain((await order(r, bob, 'match', 'OWNW')).status);
    expect((await order(r, bob, 'match', 'MPEP')).status).toBe(403);
  }, LONG);
});

describe('launching while in a match', () => {
  it('LM-4: nobody can launch while his match is in the countdown or running; nothing is made or paid; it works before and after, and while only waiting', async () => {
    const r = await boot();
    const boss = await signUp(r, 'boss');
    const alice = await signUp(r, 'alice');
    await post(r, '/api/admin/cash', boss, { username: 'alice', amountCents: 5_000_000 });
    const cash = await cashOf(r, alice);

    // Waiting in a lobby (alone, then with a bot that has not been accepted yet) is not "in a match": launching is allowed.
    expect((await call(r, '/api/lobby/join', { method: 'POST', cookie: alice })).status).toBe(200);
    expect((await launchCoin(r, alice)).status).toBe(200);
    expect(await cashOf(r, alice)).toBe(cash - 500_200); // the $5,000 first buy and the $2.00 launch fee

    await elapse(r, 12); // a bot has joined; she has not pressed Ready
    const lobby = (await call(r, '/api/lobby', { cookie: alice })).json.match;
    expect(lobby.phase).toBe('ready_check');
    expect((await launchStock(r, alice)).status).toBe(200);
    const afterTwo = await cashOf(r, alice);
    expect(afterTwo).toBe(cash - (500_000 + 200) - (498_663 + 1_000)); // the $5,000 coin and its $2.00 fee, and the $5,000 stock (219 shares at $22.77) and its $10.00 fee

    // Countdown.
    const view = (await call(r, '/api/lobby/ready', { method: 'POST', cookie: alice, body: { ready: true } })).json.match;
    expect(view.phase).toBe('countdown');
    const blockedCoin = await launchCoin(r, alice, { name: 'Second Coin', ticker: 'SCND' });
    expect(blockedCoin.status).toBe(409);
    expect(blockedCoin.json.error.code).toBe('in_match');
    expect(blockedCoin.json.error.message).toBe(NO_LAUNCH_IN_MATCH);
    const blockedStock = await launchStock(r, alice, { name: 'Second Stock', ticker: 'SCNS' });
    expect(blockedStock.status).toBe(409);

    // Live.
    await gotoTick(r, view.startTick + 20);
    expect((await call(r, '/api/lobby', { cookie: alice })).json.match.phase).toBe('live');
    expect((await launchCoin(r, alice, { name: 'Third Coin', ticker: 'THRD' })).status).toBe(409);
    expect(sql<{ n: number }>(r, 'SELECT COUNT(*) AS n FROM launches')[0]?.n).toBe(2);
    expect(sql<{ n: number }>(r, "SELECT COUNT(*) AS n FROM custom_companies WHERE ticker IN ('SCND', 'SCNS', 'THRD')")[0]?.n).toBe(0);
    expect(await cashOf(r, alice)).toBe(afterTwo);

    // A request that was already done still answers the same way (it launches nothing new).
    const repeated = await call(r, '/api/launch/coin', { method: 'POST', cookie: alice, body: { requestId: 'req-00000001', ...MOON } });
    expect([200, 409]).toContain(repeated.status);
    expect(sql<{ n: number }>(r, 'SELECT COUNT(*) AS n FROM launches')[0]?.n).toBe(2);

    // The owner is not exempt, and a player who is in no match is not affected by somebody else's.
    const bob = await signUp(r, 'bob');
    await post(r, '/api/admin/cash', boss, { username: 'bob', amountCents: 2_000_000 });
    expect((await launchCoin(r, bob, { name: 'Bobs Coin', ticker: 'BOBC' })).status).toBe(200);

    // After the match.
    await gotoTick(r, view.endTick + 15);
    await elapse(r, 3);
    expect((await call(r, '/api/lobby', { cookie: alice })).json.match.phase).toBe('finished');
    expect((await launchCoin(r, alice, { name: 'Fourth Coin', ticker: 'FRTH' })).status).toBe(200);
  }, LONG);

  it('LM-5: a player who leaves a countdown (the match is cancelled) can launch again at once', async () => {
    const r = await boot();
    const boss = await signUp(r, 'boss');
    const alice = await signUp(r, 'alice');
    await post(r, '/api/admin/cash', boss, { username: 'alice', amountCents: 2_000_000 });
    const view = await startBotMatch(r, alice);
    expect(view.phase).toBe('countdown');
    expect((await launchCoin(r, alice)).status).toBe(409);
    await call(r, '/api/lobby/leave', { method: 'POST', cookie: alice });
    expect((await launchCoin(r, alice)).status).toBe(200);
  }, LONG);
});

describe('forfeiting', () => {
  it('LM-7: a player who forfeits a match against another player can launch at once (he cannot trade in it any more); the opponent still cannot until it ends', async () => {
    const r = await boot();
    const boss = await signUp(r, 'boss');
    const alice = await signUp(r, 'alice');
    const bob = await signUp(r, 'bob');
    await post(r, '/api/admin/cash', boss, { username: 'alice', amountCents: 2_000_000 });
    await post(r, '/api/admin/cash', boss, { username: 'bob', amountCents: 2_000_000 });
    await call(r, '/api/lobby/join', { method: 'POST', cookie: alice });
    await call(r, '/api/lobby/join', { method: 'POST', cookie: bob });
    await call(r, '/api/lobby/ready', { method: 'POST', cookie: alice, body: { ready: true } });
    const view = (await call(r, '/api/lobby/ready', { method: 'POST', cookie: bob, body: { ready: true } })).json.match;
    await gotoTick(r, view.startTick + 20);
    expect((await launchCoin(r, alice)).status).toBe(409); // still in it
    const left = await call(r, '/api/lobby/leave', { method: 'POST', cookie: alice });
    expect(left.json.match.phase).toBe('live'); // against a person the match runs on for him
    expect(left.json.match.players.find((p: any) => p.you).forfeited).toBe(true);
    expect((await launchCoin(r, alice)).status).toBe(200);
    expect((await launchCoin(r, bob, { name: 'Bobs Coin', ticker: 'BOBC' })).status).toBe(409);
    await gotoTick(r, view.endTick + 15);
    await elapse(r, 3);
    const done = (await call(r, '/api/lobby', { cookie: bob })).json.match;
    expect(done.phase).toBe('finished');
    expect(done.outcome).toBe('forfeit');
    expect((await launchCoin(r, bob, { name: 'Bobs Coin', ticker: 'BOBC' })).status).toBe(200);
  }, LONG);
});

describe('bots', () => {
  it('LM-6: a bot never trades a launched company: in a world whose only coins were launched by players, the two coin bots find nothing to trade, and the others trade stocks', async () => {
    const { r, alice } = await world();
    await elapse(r, 120); // the launched companies have a minute of finished candles by now
    {
      // What a bot is allowed to look at: it has price history for the launched companies (so leaving them out is the rule at work, not a lack of data) and still does not list them.
      const { db, world: w, trading, log } = r.app.services;
      const ids = db.all<{ company_id: number }>('SELECT company_id FROM launches').map((x) => x.company_id);
      const last = Math.floor(w.savedTick / 10) - 1;
      for (const id of ids) {
        expect(db.get('SELECT 1 AS x FROM candles_c10 WHERE company_id = ? AND idx = ?', id, last)).toBeTruthy();
        expect(db.get('SELECT 1 AS x FROM candles_c10 WHERE company_id = ? AND idx = ?', id, last - 6)).toBeTruthy();
      }
      const seen = (new BotTrader({ db, world: w, trading, log }) as any).movers() as { companyId: number }[];
      expect(seen.length).toBeGreaterThan(20);
      for (const id of ids) expect(seen.some((m) => m.companyId === id)).toBe(false);
    }
    // Eight bot matches at once (one per style). Everybody presses Ready so the lobbies are full.
    const names = ['player1', 'player2', 'player3', 'player4', 'player5', 'player6', 'player7', 'player8'];
    let end = 0;
    for (const n of names) {
      const c = await signUp(r, n);
      expect((await call(r, '/api/lobby/bot', { method: 'POST', cookie: c })).status).toBe(200);
      end = Math.max(end, (await call(r, '/api/lobby/ready', { method: 'POST', cookie: c, body: { ready: true } })).json.match.endTick as number);
    }
    void alice;
    expect(new Set(sql<{ persona: string }>(r, 'SELECT persona FROM bots').map((b) => b.persona)).size).toBe(8);
    await gotoTick(r, end);
    const launched = new Set(sql<{ company_id: number }>(r, 'SELECT company_id FROM launches').map((x) => x.company_id));
    expect(launched.size).toBe(2);
    let tradedStocks = 0;
    for (const p of PERSONAS) {
      const user = sql<{ user_id: number }>(r, 'SELECT user_id FROM bots WHERE persona = ?', p.id)[0]!.user_id;
      const trades = sql<{ company_id: number }>(r, 'SELECT t.company_id FROM trades t JOIN accounts a ON a.id = t.account_id WHERE a.user_id = ?', user);
      for (const t of trades) expect(launched.has(t.company_id)).toBe(false);
      if (p.pool === 'coins') expect(trades).toHaveLength(0); // the only coins in this world are launched ones
      else tradedStocks += trades.length;
    }
    expect(tradedStocks).toBeGreaterThan(0);
    expect(sql(r, "SELECT * FROM positions WHERE company_id IN (SELECT company_id FROM launches) AND account_id IN (SELECT id FROM accounts WHERE kind = 'match')")).toHaveLength(0);
  }, LONG);
});
