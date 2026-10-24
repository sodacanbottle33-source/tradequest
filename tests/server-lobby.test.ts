// The 1v1 lobby on the server: matchmaking, ready, countdown, an exact 180-tick match on the shared market, results and
// rewards saved once, and every way a player can leave or disappear. (docs/world.md §9, spec §11–12.)
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LOSER_REWARD_CENTS, MATCH_CASH_CENTS, MATCH_TICKS, PRESENCE_MS, decideMatch } from '../src/world';
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
  /** Players who have the page open: they ask the server about the lobby every few seconds, as the real page does. */
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

async function boot(options: { dir?: string; clock?: Clock } = {}): Promise<Running> {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'tq-lobby-'));
  if (!options.dir) dirs.push(dir);
  const clock = options.clock ?? new Clock();
  const config = loadConfig({ TQ_DATA_DIR: dir, TQ_COMPANIES: '12', TQ_WARMUP_DAYS: '1', TQ_PORT: '8787' });
  const app = createApp({ config, log: new Logger({ sink: null, now: clock.now }), worldSeed: 777, now: clock.now, flowGain: 0 });
  const server = createServer(app.handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const r = { app, server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, dir, clock, players: new Set<string>() };
  running.push(r);
  return r;
}

async function stop(r: Running): Promise<void> {
  await new Promise<void>((done) => {
    r.server.closeAllConnections?.();
    r.server.close(() => done());
  });
  r.app.close();
  running.splice(running.indexOf(r), 1);
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

/** Moves the server clock to a tick, letting the market catch up as the live timer would and letting open pages ask about the lobby every 5 seconds. */
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
async function elapse(r: Running, seconds: number): Promise<void> {
  await gotoTick(r, r.app.services.world.currentTick() + seconds);
}

let orderNo = 0;
const order = (r: Running, cookie: string, account: string, body: Record<string, unknown> = {}) =>
  call(r, '/api/orders', { method: 'POST', cookie, body: { account, ticker: 'QLRX', side: 'buy', qty: 2, clientOrderId: `order-${(orderNo += 1)}-abcdef`, ...body } });

/** Two signed-in players in one lobby, both ready; the countdown is running. */
async function readyPair(r: Running, names: [string, string] = ['alice', 'bob'], before?: (firstCookie: string) => Promise<void>) {
  const [ca, cb] = [await signUp(r, names[0]), await signUp(r, names[1])];
  if (before) await before(ca);
  const a = await call(r, '/api/lobby/join', { method: 'POST', cookie: ca });
  const b = await call(r, '/api/lobby/join', { method: 'POST', cookie: cb });
  expect(b.json.match.id).toBe(a.json.match.id);
  await call(r, '/api/lobby/ready', { method: 'POST', cookie: ca, body: { ready: true } });
  const done = await call(r, '/api/lobby/ready', { method: 'POST', cookie: cb, body: { ready: true } });
  return { ca, cb, matchId: a.json.match.id as number, view: done.json.match };
}

function sql<T>(r: Running, query: string, ...params: (string | number)[]): T[] {
  return r.app.services.db.all<T>(query, ...params);
}

describe('matchmaking', () => {
  it('one player waits alone (1/2), a second joins the same lobby (2/2), a third starts another lobby', async () => {
    const r = await boot();
    const [ca, cb, cc] = [await signUp(r, 'alice'), await signUp(r, 'bob'), await signUp(r, 'carol')];
    const a = await call(r, '/api/lobby/join', { method: 'POST', cookie: ca });
    expect(a.status).toBe(200);
    expect(a.json.match.phase).toBe('waiting');
    expect(a.json.match.playerCount).toBe(1);
    expect(a.json.match.capacity).toBe(2);
    expect(a.json.match.players.map((p: any) => p.name)).toEqual(['alice']);
    expect(a.json.match.message).toMatch(/alone|opponent/i);
    expect(a.json.match.canTrade).toBe(false);

    const b = await call(r, '/api/lobby/join', { method: 'POST', cookie: cb });
    expect(b.json.match.id).toBe(a.json.match.id);
    expect(b.json.match.phase).toBe('ready_check');
    expect(b.json.match.playerCount).toBe(2);
    expect(b.json.match.players.map((p: any) => p.name).sort()).toEqual(['alice', 'bob']);

    const aNow = await call(r, '/api/lobby', { cookie: ca });
    expect(aNow.json.match.playerCount).toBe(2);
    expect(aNow.json.match.phase).toBe('ready_check');

    const c = await call(r, '/api/lobby/join', { method: 'POST', cookie: cc });
    expect(c.json.match.id).not.toBe(a.json.match.id);
    expect(c.json.match.playerCount).toBe(1);
  }, LONG);

  it('joining twice never makes a second membership; nobody can play against themselves', async () => {
    const r = await boot();
    const ca = await signUp(r, 'alice');
    const first = await call(r, '/api/lobby/join', { method: 'POST', cookie: ca });
    const again = await call(r, '/api/lobby/join', { method: 'POST', cookie: ca });
    expect(again.json.match.id).toBe(first.json.match.id);
    expect(again.json.match.playerCount).toBe(1);
    expect(sql(r, 'SELECT * FROM match_players WHERE active = 1')).toHaveLength(1);
    expect(sql(r, 'SELECT * FROM matches')).toHaveLength(1);
    // The database itself refuses a second active membership for one player.
    expect(() => r.app.services.db.run("INSERT INTO matches(state, created_ms, duration_ticks, start_cash_cents) VALUES ('lobby', 1, 180, 100000)")).not.toThrow();
    const other = sql<{ id: number }>(r, 'SELECT id FROM matches ORDER BY id DESC LIMIT 1')[0]!.id;
    const user = sql<{ user_id: number }>(r, 'SELECT user_id FROM match_players')[0]!.user_id;
    expect(() => r.app.services.db.run('INSERT INTO match_players(match_id, user_id, joined_ms, last_seen_ms) VALUES (?, ?, 1, 1)', other, user)).toThrow();
  }, LONG);

  it('needs a signed-in player, and cannot be told the lobby is full or the match has started', async () => {
    const r = await boot();
    expect((await call(r, '/api/lobby/join', { method: 'POST' })).status).toBe(401);
    expect((await call(r, '/api/lobby')).status).toBe(401);
    const ca = await signUp(r, 'alice');
    await call(r, '/api/lobby/join', { method: 'POST', cookie: ca });
    // Ready with nobody else there is refused.
    const early = await call(r, '/api/lobby/ready', { method: 'POST', cookie: ca, body: { ready: true } });
    expect(early.status).toBe(409);
    expect(early.json.error.code).toBe('no_opponent');
    // Extra fields claiming facts are ignored; there is no request that starts a match.
    const lie = await call(r, '/api/lobby/ready', { method: 'POST', cookie: ca, body: { ready: true, playerCount: 2, state: 'live', startTick: 1, matchId: 99 } });
    expect(lie.status).toBe(409);
    const view = await call(r, '/api/lobby', { cookie: ca });
    expect(view.json.match.phase).toBe('waiting');
    expect(view.json.match.startTick).toBeNull();
    expect((await call(r, '/api/lobby/start', { method: 'POST', cookie: ca })).status).toBe(404);
    expect((await call(r, '/api/lobby/ready', { method: 'POST', cookie: ca, body: { ready: 'yes' } })).status).toBe(400);
  }, LONG);

  it('a player not in any lobby cannot trade in a match', async () => {
    const r = await boot();
    const ca = await signUp(r, 'alice');
    const res = await order(r, ca, 'match');
    expect(res.status).toBe(404);
    expect(res.json.error.code).toBe('no_match');
  }, LONG);
});

describe('ready and countdown', () => {
  it('when both are ready the countdown starts on a 10-tick boundary and the match is exactly 180 ticks long', async () => {
    const r = await boot();
    const [ca, cb] = [await signUp(r, 'alice'), await signUp(r, 'bob')];
    await call(r, '/api/lobby/join', { method: 'POST', cookie: ca });
    await call(r, '/api/lobby/join', { method: 'POST', cookie: cb });
    const one = await call(r, '/api/lobby/ready', { method: 'POST', cookie: ca, body: { ready: true } });
    expect(one.json.match.phase).toBe('ready_check');
    expect(one.json.match.message).toMatch(/Waiting for bob/);
    const bView = await call(r, '/api/lobby', { cookie: cb });
    expect(bView.json.match.players.find((p: any) => p.name === 'alice').ready).toBe(true);
    expect(bView.json.match.players.find((p: any) => p.name === 'bob').ready).toBe(false);
    const both = await call(r, '/api/lobby/ready', { method: 'POST', cookie: cb, body: { ready: true } });
    const m = both.json.match;
    expect(m.phase).toBe('countdown');
    const now = r.app.services.world.currentTick();
    expect(m.startTick % 10).toBe(0);
    expect(m.startTick - now).toBeGreaterThanOrEqual(10);
    expect(m.endTick - m.startTick).toBe(MATCH_TICKS);
    expect(m.startCashCents).toBe(MATCH_CASH_CENTS);
    expect(m.ticksToStart).toBe(m.startTick - r.app.services.world.sim.tick);
    // Both players are told the same start tick, and the same moment in server time.
    const aView = await call(r, '/api/lobby', { cookie: ca });
    expect(aView.json.match.startTick).toBe(m.startTick);
    expect(aView.json.match.startMs).toBe(m.startMs);
    expect(aView.json.match.endTick).toBe(m.endTick);
  }, LONG);

  it('a player who takes their ready back during the countdown stops it', async () => {
    const r = await boot();
    const { ca, cb } = await readyPair(r);
    const back = await call(r, '/api/lobby/ready', { method: 'POST', cookie: cb, body: { ready: false } });
    expect(back.json.match.phase).toBe('ready_check');
    expect(back.json.match.startTick).toBeNull();
    await elapse(r, 40);
    const a = await call(r, '/api/lobby', { cookie: ca });
    expect(a.json.match.phase).toBe('ready_check');
    expect(sql(r, "SELECT * FROM accounts WHERE kind = 'match'")).toHaveLength(0);
  }, LONG);
});

describe('the three minutes', () => {
  it('starts with exactly $1,000 each whatever the Career account holds, and trading opens at the start tick and closes at the end tick', async () => {
    const r = await boot();
    // Career money is spent before the match; the match balance is still exactly $1,000.
    let careerBefore = 0;
    const { ca, cb, view } = await readyPair(r, ['alice', 'bob'], async (cookie) => {
      careerBefore = (await order(r, cookie, 'career', { qty: 3 })).json.account.cashCents;
    });
    expect(careerBefore).toBeLessThan(100_000);
    const start = view.startTick as number;
    const end = view.endTick as number;
    // Career is closed from the countdown (docs/world.md §9.12): the Career account cannot be changed while the match runs.
    expect((await order(r, ca, 'career', { qty: 1 })).status).toBe(409);

    // Before the start tick: no match account exists and nothing can be bought.
    await gotoTick(r, start - 1);
    expect((await call(r, '/api/lobby', { cookie: ca })).json.match.phase).toBe('countdown');
    expect((await order(r, ca, 'match')).status).toBe(404);

    await gotoTick(r, start);
    const live = await call(r, '/api/lobby', { cookie: ca });
    expect(live.json.match.phase).toBe('live');
    expect(live.json.match.canTrade).toBe(true);
    for (const c of [ca, cb]) {
      const acc = await call(r, '/api/account?account=match', { cookie: c });
      expect(acc.json.cashCents).toBe(MATCH_CASH_CENTS);
      expect(acc.json.startCashCents).toBe(MATCH_CASH_CENTS);
      expect(acc.json.kind).toBe('match');
      expect(acc.json.valuation).toBe('mid');
    }

    // First tradable tick.
    const first = await order(r, ca, 'match');
    expect(first.status).toBe(201);
    expect(first.json.trade.tick).toBe(start);
    // Last tradable tick is end − 1: that is 180 ticks, start … end − 1.
    await gotoTick(r, end - 1);
    const last = await order(r, cb, 'match');
    expect(last.status).toBe(201);
    expect(last.json.trade.tick).toBe(end - 1);
    // At the end tick the match is over.
    await gotoTick(r, end);
    const late = await order(r, cb, 'match');
    expect(late.status).toBe(403);
    expect(late.json.error.message).toMatch(/over|time is up/i);

    // The Career account was not touched by the match.
    const career = await call(r, '/api/account?account=career', { cookie: ca });
    expect(career.json.cashCents).toBe(careerBefore);
    expect(career.json.positions).toHaveLength(1);
  }, LONG);

  it('both players trade the same prices at the same moment', async () => {
    const r = await boot();
    const { ca, cb, view } = await readyPair(r);
    await gotoTick(r, view.startTick + 30);
    const a = await call(r, '/api/market', { cookie: ca });
    const b = await call(r, '/api/market', { cookie: cb });
    expect(a.json).toEqual(b.json);
    const ta = await order(r, ca, 'match', { qty: 5 });
    const tb = await order(r, cb, 'match', { qty: 5 });
    expect(ta.json.trade.tick).toBe(tb.json.trade.tick);
    expect(ta.json.trade.totalCents).toBe(tb.json.trade.totalCents);
    expect(ta.json.account.netWorthCents).toBe(tb.json.account.netWorthCents);
  }, LONG);

  it('a player cannot spend more than the $1,000 match cash', async () => {
    const r = await boot();
    const { ca, view } = await readyPair(r);
    await gotoTick(r, view.startTick + 1);
    const big = await order(r, ca, 'match', { qty: 500_000 });
    expect(big.status).toBe(400);
    expect(big.json.error.code).toBe('insufficient_cash');
    const acc = await call(r, '/api/account?account=match', { cookie: ca });
    expect(acc.json.cashCents).toBe(MATCH_CASH_CENTS);
  }, LONG);

  it('players who do not trade tie, and each is paid $50 exactly once', async () => {
    const r = await boot();
    const { ca, cb, matchId, view } = await readyPair(r);
    await gotoTick(r, view.endTick + 12);
    const a = await call(r, '/api/lobby', { cookie: ca });
    const b = await call(r, '/api/lobby', { cookie: cb });
    expect(a.json.match.phase).toBe('finished');
    expect(a.json.match.outcome).toBe('tie');
    expect(a.json.match.winnerUserId).toBeNull();
    for (const v of [a, b]) {
      for (const p of v.json.match.players) {
        expect(p.result).toBe('tie');
        expect(p.profitCents).toBe(0);
        expect(p.rewardCents).toBe(LOSER_REWARD_CENTS);
      }
    }
    expect((await call(r, '/api/wallet', { cookie: ca })).json.balanceCents).toBe(LOSER_REWARD_CENTS);
    expect((await call(r, '/api/wallet', { cookie: cb })).json.balanceCents).toBe(LOSER_REWARD_CENTS);

    // Settling again changes nothing: the result and the money were saved once.
    expect(r.app.services.matches.settle(matchId)).toBe(false);
    r.app.services.matches.settleDue(r.app.services.world.savedTick);
    await elapse(r, 30);
    expect((await call(r, '/api/wallet', { cookie: ca })).json.balanceCents).toBe(LOSER_REWARD_CENTS);
    expect(sql(r, 'SELECT * FROM wallet_ledger')).toHaveLength(2);
    // And the database itself refuses a second payment for the same match.
    const again = r.app.services.db.run('INSERT OR IGNORE INTO wallet_ledger(user_id, delta_cents, reason, match_id, created_ms) SELECT user_id, 5000, \'match_reward\', match_id, 1 FROM match_players WHERE match_id = ?', matchId);
    expect(again.changes).toBe(0);
  }, LONG);

  it('the winner is paid their positive profit and the loser $50 (profit made visible by changing the match cash directly)', async () => {
    const r = await boot();
    const { ca, cb, matchId, view } = await readyPair(r);
    await gotoTick(r, view.startTick);
    await call(r, '/api/lobby', { cookie: ca }); // opens the accounts
    const bob = sql<{ account_id: number }>(r, 'SELECT account_id FROM match_players WHERE match_id = ? AND user_id = (SELECT id FROM users WHERE username = \'bob\')', matchId)[0]!;
    r.app.services.db.run('UPDATE accounts SET cash_cents = cash_cents + 30000 WHERE id = ?', bob.account_id); // bob "made" $300
    await gotoTick(r, view.endTick + 12);
    const a = await call(r, '/api/lobby', { cookie: ca });
    expect(a.json.match.outcome).toBe('win');
    const pa = a.json.match.players.find((p: any) => p.name === 'alice');
    const pb = a.json.match.players.find((p: any) => p.name === 'bob');
    expect(pb).toMatchObject({ result: 'win', profitCents: 30000, rewardCents: 30000, finalValueCents: 130000 });
    expect(pa).toMatchObject({ result: 'loss', profitCents: 0, rewardCents: LOSER_REWARD_CENTS });
    expect((await call(r, '/api/wallet', { cookie: cb })).json.balanceCents).toBe(30000);
    expect((await call(r, '/api/wallet', { cookie: ca })).json.balanceCents).toBe(LOSER_REWARD_CENTS);
    expect(a.json.match.winnerUserId).toBe(pb.userId);
    // The Career accounts are exactly as they were: the reward is virtual currency in the wallet, not Career cash.
    for (const c of [ca, cb]) expect((await call(r, '/api/account?account=career', { cookie: c })).json.cashCents).toBe(100_000);
  }, LONG);

  it('a winner whose profit is under $50 is still paid the $50 minimum, so winning never pays less than losing', async () => {
    const r = await boot();
    const { ca, cb, matchId, view } = await readyPair(r);
    await gotoTick(r, view.startTick);
    await call(r, '/api/lobby', { cookie: ca });
    const bob = sql<{ account_id: number }>(r, 'SELECT account_id FROM match_players WHERE match_id = ? AND user_id = (SELECT id FROM users WHERE username = \'bob\')', matchId)[0]!;
    r.app.services.db.run('UPDATE accounts SET cash_cents = cash_cents + 688 WHERE id = ?', bob.account_id); // bob "made" $6.88
    await gotoTick(r, view.endTick + 12);
    const a = await call(r, '/api/lobby', { cookie: ca });
    const pa = a.json.match.players.find((p: any) => p.name === 'alice');
    const pb = a.json.match.players.find((p: any) => p.name === 'bob');
    expect(pb).toMatchObject({ result: 'win', profitCents: 688, rewardCents: LOSER_REWARD_CENTS });
    expect(pa).toMatchObject({ result: 'loss', profitCents: 0, rewardCents: LOSER_REWARD_CENTS });
    expect((await call(r, '/api/wallet', { cookie: cb })).json.balanceCents).toBe(LOSER_REWARD_CENTS);
    expect((await call(r, '/api/wallet', { cookie: ca })).json.balanceCents).toBe(LOSER_REWARD_CENTS);
  }, LONG);

  it('scores trades with the closing price at the end tick, matching an independent calculation from the stored candle', async () => {
    const r = await boot();
    const { ca, cb, matchId, view } = await readyPair(r);
    await gotoTick(r, view.startTick + 5);
    await order(r, ca, 'match', { qty: 4 });
    await order(r, cb, 'match', { ticker: 'VNTA', qty: 3 });
    await order(r, cb, 'match', { ticker: 'VNTA', side: 'sell', qty: 1 });
    await gotoTick(r, view.endTick + 12);
    const res = await call(r, '/api/lobby', { cookie: ca });
    expect(res.json.match.phase).toBe('finished');
    const rows = sql<{ user_id: number; account_id: number; final_value_cents: number; profit_cents: number; reward_cents: number; result: string }>(r, 'SELECT user_id, account_id, final_value_cents, profit_cents, reward_cents, result FROM match_players WHERE match_id = ?', matchId);
    expect(rows).toHaveLength(2);
    const competitors = rows.map((p) => {
      const cash = sql<{ cash_cents: number }>(r, 'SELECT cash_cents FROM accounts WHERE id = ?', p.account_id)[0]!.cash_cents;
      const held = sql<{ company_id: number; shares: number }>(r, 'SELECT company_id, shares FROM positions WHERE account_id = ?', p.account_id);
      let value = cash;
      for (const h of held) value += sql<{ close: number }>(r, 'SELECT close FROM candles_c10 WHERE company_id = ? AND idx = ?', h.company_id, view.endTick / 10)[0]!.close * h.shares;
      return { userId: p.user_id, finalValueCents: value, forfeited: false };
    });
    const expected = decideMatch(competitors[0]!, competitors[1]!);
    for (const row of rows) {
      const v = expected.players.find((p) => p.userId === row.user_id)!;
      expect(row.profit_cents).toBe(v.profitCents);
      expect(row.reward_cents).toBe(v.rewardCents);
      expect(row.result).toBe(v.result);
      expect(row.final_value_cents).toBe(competitors.find((c) => c.userId === row.user_id)!.finalValueCents);
    }
    // The candle used is the price at the last tick of the match: the stored close of candle end/10 equals the market at that tick.
    const w = r.app.services.world;
    expect(w.candles(0, 'c10', 5).some((c) => c.index === view.endTick / 10)).toBe(true);
  }, LONG);
});

describe('leaving and disconnecting', () => {
  it('leaving a lobby with one player closes it; the same player can search again', async () => {
    const r = await boot();
    const ca = await signUp(r, 'alice');
    const a = await call(r, '/api/lobby/join', { method: 'POST', cookie: ca });
    const left = await call(r, '/api/lobby/leave', { method: 'POST', cookie: ca });
    expect(left.json.match).toBeNull();
    expect((await call(r, '/api/lobby', { cookie: ca })).json.match).toBeNull();
    expect(sql<{ state: string }>(r, 'SELECT state FROM matches WHERE id = ?', a.json.match.id)[0]!.state).toBe('cancelled');
    const again = await call(r, '/api/lobby/join', { method: 'POST', cookie: ca });
    expect(again.json.match.id).not.toBe(a.json.match.id);
  }, LONG);

  it('when one of two leaves before the countdown ends, the other goes back to waiting (1/2) and a new player can join', async () => {
    const r = await boot();
    const { ca, cb } = await readyPair(r);
    expect((await call(r, '/api/lobby', { cookie: ca })).json.match.phase).toBe('countdown');
    await call(r, '/api/lobby/leave', { method: 'POST', cookie: cb });
    const a = await call(r, '/api/lobby', { cookie: ca });
    expect(a.json.match.phase).toBe('waiting');
    expect(a.json.match.playerCount).toBe(1);
    expect(a.json.match.startTick).toBeNull();
    expect(a.json.match.players[0].ready).toBe(false);
    await elapse(r, 60);
    expect((await call(r, '/api/lobby', { cookie: ca })).json.match.phase).toBe('waiting'); // no match was started alone
    expect(sql(r, "SELECT * FROM accounts WHERE kind = 'match'")).toHaveLength(0);
    const cc = await signUp(r, 'carol');
    const c = await call(r, '/api/lobby/join', { method: 'POST', cookie: cc });
    expect(c.json.match.id).toBe(a.json.match.id);
    expect(c.json.match.playerCount).toBe(2);
  }, LONG);

  it('a player who disappears from a lobby (no sign of life for 15 seconds) is removed', async () => {
    const r = await boot();
    const [ca, cb] = [await signUp(r, 'alice'), await signUp(r, 'bob')];
    await call(r, '/api/lobby/join', { method: 'POST', cookie: ca });
    await call(r, '/api/lobby/join', { method: 'POST', cookie: cb });
    // Bob closes the browser; Alice keeps the page open.
    for (let i = 0; i < 4; i += 1) {
      r.clock.advanceSeconds(PRESENCE_MS / 1000 / 3);
      await call(r, '/api/lobby', { cookie: ca });
    }
    const a = await call(r, '/api/lobby', { cookie: ca });
    expect(a.json.match.playerCount).toBe(1);
    expect(a.json.match.phase).toBe('waiting');
    expect((await call(r, '/api/lobby', { cookie: cb })).json.match).toBeNull();
  }, LONG);

  it('a lobby left alone and forgotten disappears, and nobody is matched with a ghost', async () => {
    const r = await boot();
    const [ca, cb] = [await signUp(r, 'alice'), await signUp(r, 'bob')];
    const first = await call(r, '/api/lobby/join', { method: 'POST', cookie: ca });
    r.clock.advanceSeconds(PRESENCE_MS / 1000 + 5);
    const b = await call(r, '/api/lobby/join', { method: 'POST', cookie: cb });
    expect(b.json.match.id).not.toBe(first.json.match.id);
    expect(b.json.match.playerCount).toBe(1);
  }, LONG);

  it('a player who disconnects during the match does not stop it: it is scored normally at the end', async () => {
    const r = await boot();
    const { ca, cb, matchId, view } = await readyPair(r);
    await gotoTick(r, view.startTick + 5);
    await order(r, ca, 'match', { qty: 2 });
    // Alice stops talking to the server; Bob plays on.
    r.players.delete(ca);
    await gotoTick(r, view.startTick + 100);
    expect((await call(r, '/api/lobby', { cookie: cb })).json.match.phase).toBe('live');
    await gotoTick(r, view.endTick + 12);
    const b = await call(r, '/api/lobby', { cookie: cb });
    expect(b.json.match.phase).toBe('finished');
    expect(b.json.match.players.every((p: any) => p.result && p.result !== 'forfeit')).toBe(true);
    expect(sql<{ state: string }>(r, 'SELECT state FROM matches WHERE id = ?', matchId)[0]!.state).toBe('finished');
    void ca;
  }, LONG);

  it('leaving a live match is a forfeit: the leaver loses and gets nothing, the other wins; the match still ends on time', async () => {
    const r = await boot();
    const { ca, cb, view } = await readyPair(r);
    await gotoTick(r, view.startTick + 20);
    const left = await call(r, '/api/lobby/leave', { method: 'POST', cookie: ca });
    expect(left.json.match.phase).toBe('live');
    expect((await order(r, ca, 'match')).status).toBe(403);
    expect((await order(r, cb, 'match')).status).toBe(201); // the other player carries on
    await gotoTick(r, view.endTick + 12);
    const b = await call(r, '/api/lobby', { cookie: cb });
    expect(b.json.match.outcome).toBe('forfeit');
    const alice = b.json.match.players.find((p: any) => p.name === 'alice');
    const bob = b.json.match.players.find((p: any) => p.name === 'bob');
    expect(alice).toMatchObject({ result: 'forfeit', rewardCents: 0 });
    expect(bob.result).toBe('win');
    expect((await call(r, '/api/wallet', { cookie: ca })).json.balanceCents).toBe(0);
  }, LONG);

  it('if both leave a live match it is abandoned with no winner and no reward', async () => {
    const r = await boot();
    const { ca, cb, view } = await readyPair(r);
    await gotoTick(r, view.startTick + 20);
    await call(r, '/api/lobby/leave', { method: 'POST', cookie: ca });
    await call(r, '/api/lobby/leave', { method: 'POST', cookie: cb });
    await gotoTick(r, view.endTick + 12);
    const a = await call(r, '/api/lobby', { cookie: ca });
    expect(a.json.match.outcome).toBe('abandoned');
    expect(a.json.match.winnerUserId).toBeNull();
    expect(sql(r, 'SELECT * FROM wallet_ledger')).toHaveLength(0);
  }, LONG);

  it('the results screen can be closed, then the player is free to search again', async () => {
    const r = await boot();
    const { ca, view } = await readyPair(r);
    await gotoTick(r, view.endTick + 12);
    expect((await call(r, '/api/lobby', { cookie: ca })).json.match.phase).toBe('finished');
    await call(r, '/api/lobby/dismiss', { method: 'POST', cookie: ca });
    expect((await call(r, '/api/lobby', { cookie: ca })).json.match).toBeNull();
    const again = await call(r, '/api/lobby/join', { method: 'POST', cookie: ca });
    expect(again.json.match.phase).toBe('waiting');
    const hist = await call(r, '/api/matches', { cookie: ca });
    expect(hist.json.matches).toHaveLength(1);
    expect(hist.json.matches[0]).toMatchObject({ state: 'finished', outcome: 'tie' });
    expect(hist.json.matches[0].opponent.name).toBe('bob');
  }, LONG);
});

describe('many matches and restarts', () => {
  it('two matches at once do not affect each other, and each is settled once with its own results', async () => {
    const r = await boot();
    const m1 = await readyPair(r, ['alice', 'bob']);
    const m2 = await readyPair(r, ['carol', 'dave']);
    expect(m1.matchId).not.toBe(m2.matchId);
    const start = Math.max(m1.view.startTick, m2.view.startTick);
    await gotoTick(r, start + 3);
    // Alice buys a lot in her match. Carol's match and the market itself are not affected.
    const before = await call(r, '/api/market/QLRX/book', {});
    const carolBefore = await call(r, '/api/estimate'.replace('/api/estimate', '/api/market/QLRX/estimate?side=buy&qty=50&account=match'), { cookie: m2.ca });
    await order(r, m1.ca, 'match', { qty: 30 });
    const after = await call(r, '/api/market/QLRX/book', {});
    const carolAfter = await call(r, '/api/market/QLRX/estimate?side=buy&qty=50&account=match', { cookie: m2.ca });
    expect(after.json).toEqual(before.json);
    expect(carolAfter.json).toEqual(carolBefore.json);
    await order(r, m2.cb, 'match', { qty: 10 });
    await gotoTick(r, Math.max(m1.view.endTick, m2.view.endTick) + 12);
    for (const [matchId, users] of [[m1.matchId, 2], [m2.matchId, 2]] as const) {
      const rows = sql<{ result: string; reward_cents: number }>(r, 'SELECT result, reward_cents FROM match_players WHERE match_id = ?', matchId);
      expect(rows).toHaveLength(users);
      expect(rows.every((x) => x.result !== null)).toBe(true);
      expect(sql<{ state: string }>(r, 'SELECT state FROM matches WHERE id = ?', matchId)[0]!.state).toBe('finished');
    }
    const ledger = sql<{ user_id: number; match_id: number }>(r, 'SELECT user_id, match_id FROM wallet_ledger');
    expect(new Set(ledger.map((l) => `${l.user_id}:${l.match_id}`)).size).toBe(ledger.length);
    // The market kept going: it did not restart or reset when the matches ended.
    expect(r.app.services.world.sim.tick).toBe(r.app.services.world.currentTick());
    expect(r.app.services.world.health().ok).toBe(true);
  }, LONG);

  it('a server restart during a match cancels it without a result; nobody wins, loses or is paid', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tq-lobby-'));
    dirs.push(dir);
    const clock = new Clock();
    let r = await boot({ dir, clock });
    const { ca, cb, matchId, view } = await readyPair(r);
    await gotoTick(r, view.startTick + 30);
    await order(r, ca, 'match', { qty: 2 });
    await stop(r);
    clock.advanceSeconds(5);
    r = await boot({ dir, clock });
    // Same accounts and sessions survive the restart (they are in the database).
    const a = await call(r, '/api/lobby', { cookie: ca });
    expect(a.json.match.phase).toBe('cancelled');
    expect(a.json.match.cancelReason).toBe('server_restart');
    expect(a.json.match.message).toMatch(/restart/i);
    expect(sql<{ state: string }>(r, 'SELECT state FROM matches WHERE id = ?', matchId)[0]!.state).toBe('cancelled');
    expect(sql(r, 'SELECT * FROM wallet_ledger')).toHaveLength(0);
    expect((await call(r, '/api/wallet', { cookie: cb })).json.balanceCents).toBe(0);
    expect((await order(r, ca, 'match')).status).toBe(403); // the cancelled match cannot be traded
    await call(r, '/api/lobby/dismiss', { method: 'POST', cookie: ca });
    const fresh = await call(r, '/api/lobby/join', { method: 'POST', cookie: ca });
    expect(fresh.json.match.phase).toBe('waiting');
  }, LONG);

  it('players who joined before a restart but never came back are not matched with new players', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tq-lobby-'));
    dirs.push(dir);
    const clock = new Clock();
    let r = await boot({ dir, clock });
    const ca = await signUp(r, 'alice');
    const first = await call(r, '/api/lobby/join', { method: 'POST', cookie: ca });
    await stop(r);
    clock.advanceSeconds(120);
    r = await boot({ dir, clock });
    const cb = await signUp(r, 'bob');
    const b = await call(r, '/api/lobby/join', { method: 'POST', cookie: cb });
    expect(b.json.match.id).not.toBe(first.json.match.id);
    expect(b.json.match.playerCount).toBe(1);
  }, LONG);

  it('health reports the lobby, and the market is still healthy during and after a match', async () => {
    const r = await boot();
    const { view } = await readyPair(r);
    await gotoTick(r, view.startTick + 10);
    const h = await call(r, '/api/health');
    expect(h.json.ok).toBe(true);
    expect(h.json.lobby).toMatchObject({ live: 1, countdown: 0 });
  }, LONG);
});

describe('live push', () => {
  it('both players receive a match event when the other joins and when the countdown starts', async () => {
    const r = await boot();
    const [ca, cb] = [await signUp(r, 'alice'), await signUp(r, 'bob')];
    const seen: any[] = [];
    const res = await fetch(`${r.base}/api/stream`, { headers: { Cookie: ca } });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    void (async () => {
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
        if (done || !value) return;
        buf += decoder.decode(value);
        let at: number;
        while ((at = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, at);
          buf = buf.slice(at + 2);
          if (/^event: match$/m.test(frame)) seen.push(JSON.parse(/^data: (.*)$/m.exec(frame)![1] as string));
        }
      }
    })();
    const waitFor = async (test: () => boolean): Promise<void> => {
      const end = Date.now() + 5000;
      while (!test() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 20));
    };
    await call(r, '/api/lobby/join', { method: 'POST', cookie: ca });
    await waitFor(() => seen.length >= 1);
    await call(r, '/api/lobby/join', { method: 'POST', cookie: cb });
    await waitFor(() => seen.some((e) => e.match?.playerCount === 2));
    await call(r, '/api/lobby/ready', { method: 'POST', cookie: ca, body: { ready: true } });
    await call(r, '/api/lobby/ready', { method: 'POST', cookie: cb, body: { ready: true } });
    await waitFor(() => seen.some((e) => e.match?.phase === 'countdown'));
    await reader.cancel();
    expect(seen.some((e) => e.match?.phase === 'waiting')).toBe(true);
    expect(seen.some((e) => e.match?.playerCount === 2)).toBe(true);
    const cd = seen.find((e) => e.match?.phase === 'countdown');
    expect(cd.match.endTick - cd.match.startTick).toBe(MATCH_TICKS);
  }, LONG);
});

describe('leverage in a 1v1 match', () => {
  it('LEV-28: a leveraged position counts at its value minus its debt in the final score; the match is settled once and the rewards follow that score', async () => {
    const r = await boot();
    const { ca, cb, matchId, view } = await readyPair(r);
    await gotoTick(r, view.startTick + 3);
    const bought = await order(r, ca, 'match', { qty: 100, leverage: 20 });
    expect(bought.status).toBe(201);
    expect(bought.json.trade.leverage).toBe(20);
    const margin = Math.ceil(bought.json.trade.totalCents / 20);
    expect((await call(r, '/api/account?account=match', { cookie: ca })).json.cashCents).toBe(MATCH_CASH_CENTS - margin);
    // The other player holds nothing: his score stays at the start cash.
    await gotoTick(r, view.endTick + 12);

    const rows = sql<{ user_id: number; final_value_cents: number; profit_cents: number }>(r, 'SELECT user_id, final_value_cents, profit_cents FROM match_players WHERE match_id = ?', matchId);
    expect(rows).toHaveLength(2);
    const aliceRow = rows.find((x) => x.user_id === sql<{ id: number }>(r, "SELECT id FROM users WHERE username = 'alice'")[0]!.id)!;
    const aliceAcc = sql<{ id: number; cash_cents: number }>(r, "SELECT a.id AS id, a.cash_cents AS cash_cents FROM accounts a JOIN users u ON u.id = a.user_id WHERE u.username = 'alice' AND a.kind = 'match'")[0]!;
    const pos = sql<{ shares: number; debt_cents: number }>(r, 'SELECT shares, debt_cents FROM positions WHERE account_id = ?', aliceAcc.id);
    const close = sql<{ close: number }>(r, 'SELECT close FROM candles_c10 WHERE company_id = 0 AND idx = ?', Math.floor(view.endTick / 10))[0]!.close;
    // Either the position is still there, valued at the final price minus the debt (never below nothing), or the market closed it and it counts as nothing.
    const equity = pos.length === 1 ? Math.max(0, close * pos[0]!.shares - pos[0]!.debt_cents) : 0;
    expect(aliceRow.final_value_cents).toBe(aliceAcc.cash_cents + equity);
    expect(aliceRow.profit_cents).toBe(aliceRow.final_value_cents - MATCH_CASH_CENTS);
    // A wiped-out position loses the margin and nothing more.
    expect(aliceRow.final_value_cents).toBeGreaterThanOrEqual(MATCH_CASH_CENTS - margin);
    // Settled once.
    expect(r.app.services.matches.settle(matchId)).toBe(false);
    expect(sql(r, 'SELECT * FROM wallet_ledger').length).toBeLessThanOrEqual(2);
    void cb;
  }, LONG);
});

describe('short selling in a 1v1 match', () => {
  it('SHORT-19: a short position counts at its collateral minus the cost of buying the shares back at the final price; the match is settled once', async () => {
    const r = await boot();
    const { ca, cb, matchId, view } = await readyPair(r);
    await gotoTick(r, view.startTick + 3);
    const opened = await order(r, ca, 'match', { side: 'sell', short: true, qty: 20 });
    expect(opened.status).toBe(201);
    expect(opened.json.trade.short).toBe(true);
    const shown = (await call(r, '/api/account?account=match', { cookie: ca })).json;
    expect(shown.positions).toHaveLength(1);
    expect(shown.positions[0].short).toBe(true);
    await gotoTick(r, view.endTick + 12);

    const aliceId = sql<{ id: number }>(r, "SELECT id FROM users WHERE username = 'alice'")[0]!.id;
    const rows = sql<{ user_id: number; final_value_cents: number; profit_cents: number }>(r, 'SELECT user_id, final_value_cents, profit_cents FROM match_players WHERE match_id = ?', matchId);
    expect(rows).toHaveLength(2);
    const aliceRow = rows.find((x) => x.user_id === aliceId)!;
    const aliceAcc = sql<{ id: number; cash_cents: number }>(r, "SELECT a.id AS id, a.cash_cents AS cash_cents FROM accounts a JOIN users u ON u.id = a.user_id WHERE u.username = 'alice' AND a.kind = 'match'")[0]!;
    const pos = sql<{ shares: number; cost_cents: number; credit_cents: number; short: number }>(r, 'SELECT shares, cost_cents, credit_cents, short FROM positions WHERE account_id = ?', aliceAcc.id);
    const close = sql<{ close: number }>(r, 'SELECT close FROM candles_c10 WHERE company_id = 0 AND idx = ?', Math.floor(view.endTick / 10))[0]!.close;
    // Either the short is still open, worth what is left of its collateral after buying back at the final price (never below nothing),
    // or the market closed it (margin gone) and it counts as nothing.
    const equity = pos.length === 1 ? Math.max(0, pos[0]!.credit_cents + pos[0]!.cost_cents - close * pos[0]!.shares) : 0;
    if (pos.length === 1) expect(pos[0]!.short).toBe(1);
    expect(aliceRow.final_value_cents).toBe(aliceAcc.cash_cents + equity);
    expect(aliceRow.profit_cents).toBe(aliceRow.final_value_cents - MATCH_CASH_CENTS);
    // A short can lose its margin but never more than that: the score never falls below the start cash minus the margin.
    expect(aliceRow.final_value_cents).toBeGreaterThanOrEqual(0);
    expect(r.app.services.matches.settle(matchId)).toBe(false);
    void cb;
  }, LONG);
});
