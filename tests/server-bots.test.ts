// 1v1 bots: a computer opponent for a player who waits alone in the lobby (docs/world.md §9.9). A bot is a normal player to the lobby and the
// scoring; real players always take its place; it trades with the same rules and only looks at the past.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MATCH_CASH_CENTS, MATCH_TICKS } from '../src/world';
import { createApp, type App } from '../server/app';
import { loadConfig } from '../server/config';
import { BOT_WAIT_MS, PERSONAS, seeded } from '../server/lobby/bots';
import { Logger } from '../server/log';
import { MIGRATIONS, migrate } from '../server/schema';
import { Db } from '../server/sqlite';
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

async function boot(options: { dir?: string; bots?: boolean; coins?: boolean } = {}): Promise<Running> {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'tq-bots-'));
  if (!options.dir) dirs.push(dir);
  const clock = new Clock();
  const config = loadConfig({ TQ_DATA_DIR: dir, TQ_COMPANIES: options.coins ? '66' : '12', TQ_WARMUP_DAYS: '1', TQ_PORT: '8787' });
  const app = createApp({ config, log: new Logger({ sink: null, now: clock.now }), worldSeed: 777, now: clock.now, flowGain: 0, bots: options.bots !== false, botWaitMs: BOT_WAIT_MS, memecoins: options.coins === true });
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

function sql<T>(r: Running, query: string, ...params: (string | number)[]): T[] {
  return r.app.services.db.all<T>(query, ...params);
}

const join_ = (r: Running, cookie: string) => call(r, '/api/lobby/join', { method: 'POST', cookie });
const playBot = (r: Running, cookie: string) => call(r, '/api/lobby/bot', { method: 'POST', cookie });
const ready = (r: Running, cookie: string, value = true) => call(r, '/api/lobby/ready', { method: 'POST', cookie, body: { ready: value } });
const botOf = (view: any) => view.players.find((p: any) => p.bot);

/** A player in a match against a bot, both ready: the countdown is running. */
async function botMatch(r: Running, name: string) {
  const c = await signUp(r, name);
  const v = await playBot(r, c);
  expect(v.status).toBe(200);
  const done = await ready(r, c);
  return { cookie: c, matchId: v.json.match.id as number, view: done.json.match };
}

describe('the roster', () => {
  it('BOT-1: version 15 adds the bots table; eight styles; nobody can sign in as a bot or register its name', async () => {
    expect(MIGRATIONS[MIGRATIONS.length - 1]?.version).toBeGreaterThanOrEqual(15);
    const dir = mkdtempSync(join(tmpdir(), 'tq-bots-mig-'));
    try {
      const db = new Db(join(dir, 'old.sqlite'));
      for (const m of MIGRATIONS.filter((x) => x.version <= 14)) {
        db.tx(() => {
          db.exec(m.sql);
          db.exec(`PRAGMA user_version = ${m.version}`);
        });
      }
      expect(migrate(db).filter((v) => v <= 15)).toEqual([15]); // (later versions follow in the same go)
      expect(db.all('SELECT * FROM bots')).toEqual([]);
      db.run("INSERT INTO users(id, username, display_name, pw_hash, created_ms) VALUES (1, 'bot-x', 'X (bot)', 'bot', 0)");
      db.run("INSERT INTO bots(user_id, persona) VALUES (1, 'sam')");
      expect(() => db.run("INSERT INTO bots(user_id, persona) VALUES (1, 'other')")).toThrow(); // one row per user
      db.run("INSERT INTO users(id, username, display_name, pw_hash, created_ms) VALUES (2, 'bot-y', 'Y (bot)', 'bot', 0)");
      expect(() => db.run("INSERT INTO bots(user_id, persona) VALUES (2, 'sam')")).toThrow(); // one bot per style
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(PERSONAS).toHaveLength(8);
    expect(new Set(PERSONAS.map((p) => p.id)).size).toBe(8);
    for (const p of PERSONAS) {
      expect(p.leverage[0]).toBeGreaterThanOrEqual(1);
      expect(p.leverage[1]).toBeLessThanOrEqual(50);
      expect(p.leverage[0]).toBeLessThanOrEqual(p.leverage[1]);
      expect(p.stake[1]).toBeLessThanOrEqual(0.95);
      expect(p.holdFor[0]).toBeLessThanOrEqual(p.holdFor[1]);
    }

    const r = await boot();
    const reg = await fetch(r.base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'bot-sam', password: 'a-good-password' }) });
    expect(reg.status).toBe(400); // the hyphen is not allowed in a username
    const c = await signUp(r, 'alice');
    await playBot(r, c); // makes a bot user
    const bot = sql<{ username: string; pw_hash: string }>(r, 'SELECT u.username, u.pw_hash FROM users u JOIN bots b ON b.user_id = u.id')[0] as { username: string; pw_hash: string };
    expect(bot.username).toMatch(/^bot-[a-z]+$/);
    for (const pw of ['bot', '', 'a-good-password', 'scrypt$00$00']) {
      const login = await call(r, '/api/auth/login', { method: 'POST', body: { username: bot.username, password: pw } });
      expect(login.status).toBe(401);
    }
  }, LONG);

  it('BOT-2: bots are off unless the app turns them on: a lobby waits for a real player, there is no "Play a bot" and no bot row', async () => {
    const r = await boot({ bots: false });
    const c = await signUp(r, 'alice');
    expect((await join_(r, c)).json.match.phase).toBe('waiting');
    await elapse(r, 60);
    const v = await call(r, '/api/lobby', { cookie: c });
    expect(v.json.match.phase).toBe('waiting');
    expect(v.json.match.playerCount).toBe(1);
    expect(v.json.match.message).toMatch(/real player/);
    const res = await playBot(r, c);
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe('no_bots');
    expect(v.json.bots).toBe(false); // the page then hides the button and the rule about bots
    expect(sql(r, 'SELECT * FROM bots')).toHaveLength(0);
  }, LONG);
});

describe('joining the lobby', () => {
  it('BOT-3: a player who waits alone gets a bot after 10 seconds, not before; the bot is ready, the player presses Ready', async () => {
    const r = await boot();
    const c = await signUp(r, 'alice');
    const first = await join_(r, c);
    expect(first.json.match.phase).toBe('waiting');
    expect(first.json.match.message).toMatch(/bot will play you/);
    expect((await call(r, '/api/lobby', { cookie: c })).json.bots).toBe(true);
    await elapse(r, 8);
    expect((await call(r, '/api/lobby', { cookie: c })).json.match.phase).toBe('waiting');
    await elapse(r, 4);
    const v = await call(r, '/api/lobby', { cookie: c });
    expect(v.json.match.phase).toBe('ready_check');
    expect(v.json.match.playerCount).toBe(2);
    const bot = botOf(v.json.match);
    expect(bot.name).toMatch(/ \(bot\)$/);
    expect(bot.ready).toBe(true);
    expect(bot.you).toBe(false);
    expect(v.json.match.players.find((p: any) => p.you).bot).toBe(false);
    expect(v.json.match.message).toMatch(/will play you/);
    // The countdown starts only when the real player is ready too.
    const go = await ready(r, c);
    expect(go.json.match.phase).toBe('countdown');
    expect(go.json.match.message).toMatch(/Both players are ready/);
  }, LONG);

  it('BOT-4: "Play a bot now" puts a bot in at once; pressing it again changes nothing; a player already waiting is not given a second bot', async () => {
    const r = await boot();
    const c = await signUp(r, 'alice');
    const v = await playBot(r, c);
    expect(v.status).toBe(200);
    expect(v.json.match.phase).toBe('ready_check');
    expect(botOf(v.json.match)).toBeTruthy();
    const again = await playBot(r, c);
    expect(again.json.match.id).toBe(v.json.match.id);
    expect(again.json.match.playerCount).toBe(2);
    expect(sql(r, 'SELECT * FROM match_players WHERE active = 1')).toHaveLength(2);
    expect(sql(r, 'SELECT * FROM bots')).toHaveLength(1);
    await expect(call(r, '/api/lobby/bot', { method: 'POST' })).resolves.toMatchObject({ status: 401 });
  }, LONG);

  it('BOT-5: a real player always takes the bot\'s place; the bot goes back to the roster; real players still match each other with no wait', async () => {
    const r = await boot();
    const [ca, cb, cc, cd] = [await signUp(r, 'alice'), await signUp(r, 'bob'), await signUp(r, 'carol'), await signUp(r, 'dave')];
    await join_(r, ca);
    await elapse(r, 12);
    const withBot = await call(r, '/api/lobby', { cookie: ca });
    expect(botOf(withBot.json.match)).toBeTruthy();
    const b = await join_(r, cb);
    expect(b.json.match.id).toBe(withBot.json.match.id);
    expect(b.json.match.players.map((p: any) => p.name).sort()).toEqual(['alice', 'bob']);
    expect(botOf(b.json.match)).toBeUndefined();
    expect(b.json.match.message).toMatch(/has joined/);
    const a = await call(r, '/api/lobby', { cookie: ca });
    expect(a.json.match.players.map((p: any) => p.name).sort()).toEqual(['alice', 'bob']);
    expect(a.json.match.players.every((p: any) => p.ready === false)).toBe(true);
    expect(sql(r, 'SELECT * FROM match_players WHERE active = 1 AND user_id IN (SELECT user_id FROM bots)')).toHaveLength(0);
    // Nobody is "searching" because of a bot, and two real players meet at once.
    const c1 = await join_(r, cc);
    expect(c1.json.match.id).not.toBe(b.json.match.id);
    expect(c1.json.match.phase).toBe('waiting');
    expect((await call(r, '/api/lobby', { cookie: ca })).json.searching).toBe(1);
    const d = await join_(r, cd);
    expect(d.json.match.id).toBe(c1.json.match.id);
    expect(botOf(d.json.match)).toBeUndefined();
  }, LONG);

  it('BOT-6: a lobby with a bot is not swept away for "inactivity", and when the real player leaves, the bot leaves and the lobby closes', async () => {
    const r = await boot();
    const c = await signUp(r, 'alice');
    await playBot(r, c);
    await elapse(r, 90); // far longer than the 15 s a silent real player is allowed
    const v = await call(r, '/api/lobby', { cookie: c });
    expect(v.json.match.phase).toBe('ready_check');
    expect(botOf(v.json.match)).toBeTruthy();
    const matchId = v.json.match.id as number;
    await call(r, '/api/lobby/leave', { method: 'POST', cookie: c });
    expect(sql(r, 'SELECT * FROM match_players WHERE active = 1')).toHaveLength(0);
    expect(sql<{ state: string; cancel_reason: string }>(r, 'SELECT state, cancel_reason FROM matches WHERE id = ?', matchId)[0]).toEqual({ state: 'cancelled', cancel_reason: 'everyone_left' });
    // The same player can start again, and the bot is free once more.
    const again = await playBot(r, c);
    expect(again.status).toBe(200);
    expect(botOf(again.json.match)).toBeTruthy();
  }, LONG);

  it('BOT-7: a real player who disappears from the lobby is removed with his bot; the countdown with a bot is cancelled if the player leaves it', async () => {
    const r = await boot();
    const c = await signUp(r, 'alice');
    const v = await playBot(r, c);
    const started = await ready(r, c);
    expect(started.json.match.phase).toBe('countdown');
    const left = await call(r, '/api/lobby/leave', { method: 'POST', cookie: c });
    expect(left.json.match).toBeNull();
    expect(sql(r, 'SELECT * FROM match_players WHERE active = 1')).toHaveLength(0);
    expect(sql<{ state: string }>(r, 'SELECT state FROM matches WHERE id = ?', v.json.match.id)[0]?.state).toBe('cancelled');
    // A second player who just closes the page: removed by the presence check, and his bot with him.
    r.players.delete(c);
    const d = await signUp(r, 'dave');
    r.players.delete(d);
    await playBot(r, d);
    await elapse(r, 40);
    expect(sql(r, 'SELECT * FROM match_players WHERE active = 1')).toHaveLength(0);
  }, LONG);

  it('BOT-8: at most eight bot matches at a time; the ninth player waits and gets a bot as soon as one is free', async () => {
    const r = await boot();
    const cookies: string[] = [];
    for (let i = 0; i < 9; i += 1) cookies.push(await signUp(r, `player${i}`));
    // Everybody presses Ready at once, so the lobbies are full and no real player can join another's.
    let end = 0;
    for (let i = 0; i < 8; i += 1) {
      expect((await playBot(r, cookies[i] as string)).status).toBe(200);
      const started = await ready(r, cookies[i] as string);
      expect(started.json.match.phase).toBe('countdown');
      end = Math.max(end, started.json.match.endTick as number);
    }
    const ninth = await playBot(r, cookies[8] as string);
    expect(ninth.status).toBe(409);
    expect(ninth.json.error.code).toBe('no_bot_free');
    expect((await call(r, '/api/lobby', { cookie: cookies[8] as string })).json.match.phase).toBe('waiting');
    await elapse(r, 40); // the automatic bot has nobody free either
    expect((await call(r, '/api/lobby', { cookie: cookies[8] as string })).json.match.phase).toBe('waiting');
    expect(sql(r, 'SELECT * FROM bots')).toHaveLength(8);
    expect(sql(r, "SELECT * FROM matches WHERE state IN ('countdown', 'live')")).toHaveLength(8);
    // The matches end, the bots are free again, and the waiting player gets one on the next lobby update.
    await gotoTick(r, end + 5);
    const v = await call(r, '/api/lobby', { cookie: cookies[8] as string });
    expect(v.json.match.phase).toBe('ready_check');
    expect(botOf(v.json.match)).toBeTruthy();
  }, LONG);
});

describe('a match against a bot', () => {
  it('BOT-9: both get exactly $1,000; the bot trades only inside the 180 ticks, only in a match account, and the player\'s Career money is untouched', async () => {
    const r = await boot();
    const { cookie, view } = await botMatch(r, 'alice');
    const start = view.startTick as number;
    const end = view.endTick as number;
    expect(end - start).toBe(MATCH_TICKS);
    await gotoTick(r, start);
    const live = await call(r, '/api/lobby', { cookie });
    expect(live.json.match.phase).toBe('live');
    expect(live.json.match.canTrade).toBe(true);
    const accounts = sql<{ id: number; user_id: number; kind: string; start_cash_cents: number }>(r, "SELECT id, user_id, kind, start_cash_cents FROM accounts WHERE kind = 'match'");
    expect(accounts).toHaveLength(2);
    for (const a of accounts) expect(a.start_cash_cents).toBe(MATCH_CASH_CENTS);
    const botUser = sql<{ user_id: number }>(r, 'SELECT user_id FROM bots')[0]!.user_id;
    const botAccount = accounts.find((a) => a.user_id === botUser)!;
    expect(sql(r, "SELECT * FROM accounts WHERE user_id = ? AND kind = 'career'", botUser)).toHaveLength(0);

    await gotoTick(r, end);
    const trades = sql<{ tick: number; client_order_id: string; side: string; filled: number }>(r, 'SELECT tick, client_order_id, side, filled FROM trades WHERE account_id = ? ORDER BY id', botAccount.id);
    expect(trades.length).toBeGreaterThanOrEqual(1);
    for (const t of trades) {
      expect(t.tick).toBeGreaterThanOrEqual(start);
      expect(t.tick).toBeLessThan(end);
      expect(t.client_order_id).toMatch(/^bot-\d+-\d+-\d+$/);
    }
    // Nothing of the bot happens outside the match accounts, and nothing touches the player's Career account.
    expect(sql(r, "SELECT * FROM trades WHERE account_id NOT IN (SELECT id FROM accounts WHERE kind = 'match')")).toHaveLength(0);
    const career = (await call(r, '/api/account?account=career', { cookie })).json;
    expect(career.cashCents).toBe(100_000);
    expect(career.positions).toHaveLength(0);
    // After the end tick the bot's account is closed for orders like anybody's.
    const gate = r.app.services.trading.account(botAccount.id)!;
    expect(r.app.services.matches.gate(gate, end)).toMatch(/over/i);
  }, LONG);

  it('BOT-10: the match is settled once; the player is paid like in any match and the bot gets no reward; the history shows a bot', async () => {
    const r = await boot();
    const { cookie, matchId, view } = await botMatch(r, 'alice');
    await gotoTick(r, (view.endTick as number) + 15);
    await elapse(r, 3);
    const done = await call(r, '/api/lobby', { cookie });
    expect(done.json.match.phase).toBe('finished');
    const me = done.json.match.players.find((p: any) => p.you);
    const bot = botOf(done.json.match);
    expect(['win', 'loss', 'tie']).toContain(me.result);
    expect(bot.profitCents).not.toBeNull();
    expect(bot.rewardCents).toBeNull(); // the results show a dash, not a reward nobody receives
    expect(me.rewardCents).toBeGreaterThanOrEqual(5000);
    const wallet = await call(r, '/api/wallet', { cookie });
    expect(wallet.json.balanceCents).toBe(me.rewardCents);
    const botUser = sql<{ user_id: number }>(r, 'SELECT user_id FROM bots')[0]!.user_id;
    expect(sql(r, 'SELECT * FROM wallets WHERE user_id = ?', botUser)).toHaveLength(0);
    expect(sql(r, 'SELECT * FROM wallet_ledger WHERE user_id = ?', botUser)).toHaveLength(0);
    expect(sql<{ state: string }>(r, 'SELECT state FROM matches WHERE id = ?', matchId)[0]?.state).toBe('finished');
    // Settling again changes nothing.
    r.app.services.matches.settle(matchId);
    expect((await call(r, '/api/wallet', { cookie })).json.balanceCents).toBe(me.rewardCents);
    const history = (await call(r, '/api/matches', { cookie })).json.matches as any[];
    expect(history[0].opponent.bot).toBe(true);
    expect(history[0].opponent.name).toMatch(/ \(bot\)$/);
    // The bot is free for the next match, and a new lobby with it works.
    await call(r, '/api/lobby/dismiss', { method: 'POST', cookie });
    const next = await playBot(r, cookie);
    expect(next.status).toBe(200);
    expect(botOf(next.json.match)).toBeTruthy();
  }, LONG);

  it('BOT-11: leaving a live match against a bot is a forfeit: the bot wins and the player gets nothing', async () => {
    const r = await boot();
    const { cookie, view } = await botMatch(r, 'alice');
    await gotoTick(r, (view.startTick as number) + 20);
    await call(r, '/api/lobby/leave', { method: 'POST', cookie });
    await gotoTick(r, (view.endTick as number) + 15);
    await elapse(r, 3);
    const done = await call(r, '/api/lobby', { cookie });
    expect(done.json.match.phase).toBe('finished');
    expect(done.json.match.outcome).toBe('forfeit');
    const me = done.json.match.players.find((p: any) => p.you);
    expect(me.result).toBe('forfeit');
    expect(me.rewardCents).toBe(0);
    expect(botOf(done.json.match).result).toBe('win');
    expect((await call(r, '/api/wallet', { cookie })).json.balanceCents).toBe(0);
  }, LONG);

  it('BOT-12: a restart during a match with a bot cancels it with no result; afterwards the bot is free and a new bot match works', async () => {
    const r = await boot();
    const { cookie, matchId, view } = await botMatch(r, 'alice');
    await gotoTick(r, (view.startTick as number) + 30);
    const dir = r.dir;
    await new Promise<void>((done) => {
      r.server.closeAllConnections?.();
      r.server.close(() => done());
    });
    r.app.close();
    running.splice(running.indexOf(r), 1);
    const r2 = await boot({ dir });
    expect(sql<{ state: string; cancel_reason: string }>(r2, 'SELECT state, cancel_reason FROM matches WHERE id = ?', matchId)[0]).toEqual({ state: 'cancelled', cancel_reason: 'server_restart' });
    expect(sql(r2, 'SELECT * FROM match_players WHERE active = 1')).toHaveLength(0);
    const login = await call(r2, '/api/auth/login', { method: 'POST', body: { username: 'alice', password: 'a-good-password' } });
    expect(login.status).toBe(200);
    expect(cookie.length).toBeGreaterThan(0);
    const c2 = ((await fetch(r2.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'alice', password: 'a-good-password' }) })).headers.get('set-cookie') ?? '').split(';')[0] as string;
    const next = await playBot(r2, c2);
    expect(next.status).toBe(200);
    expect(botOf(next.json.match)).toBeTruthy();
  }, LONG);
});

describe('forfeiting against a bot', () => {
  it('BOT-15: leaving a live match against a bot ends it at once: the bot wins, nobody is paid, and the player can play again straight away', async () => {
    const r = await boot();
    const { cookie, matchId, view } = await botMatch(r, 'alice');
    await gotoTick(r, (view.startTick as number) + 30);
    const live = await call(r, '/api/lobby', { cookie });
    expect(live.json.match.phase).toBe('live');
    const left = await call(r, '/api/lobby/leave', { method: 'POST', cookie });
    expect(left.status).toBe(200);
    // The answer is the finished match, so the page shows the result at once; the clock still has about 150 seconds to run.
    expect(left.json.match.phase).toBe('finished');
    expect(left.json.match.outcome).toBe('forfeit');
    expect(r.app.services.world.currentTick()).toBeLessThan(view.endTick as number);
    const me = left.json.match.players.find((p: any) => p.you);
    expect(me.result).toBe('forfeit');
    expect(me.rewardCents).toBe(0);
    expect(botOf(left.json.match).result).toBe('win');
    expect(botOf(left.json.match).rewardCents).toBeNull();
    expect(sql<{ state: string; outcome: string }>(r, 'SELECT state, outcome FROM matches WHERE id = ?', matchId)[0]).toEqual({ state: 'finished', outcome: 'forfeit' });
    expect(sql(r, 'SELECT * FROM match_players WHERE active = 1')).toHaveLength(0);
    expect((await call(r, '/api/wallet', { cookie })).json.balanceCents).toBe(0);
    const botUser = sql<{ user_id: number }>(r, 'SELECT user_id FROM bots')[0]!.user_id;
    expect(sql(r, 'SELECT * FROM wallets WHERE user_id = ?', botUser)).toHaveLength(0);
    // Nothing can be traded in the ended match any more, the bot stops, and settling again changes nothing.
    const order = await call(r, '/api/orders', { method: 'POST', cookie, body: { account: 'match', ticker: 'QLRX', side: 'buy', qty: 1, clientOrderId: 'order-after-forfeit-1' } });
    expect(order.status).toBe(403);
    const tradesBefore = sql<{ n: number }>(r, 'SELECT COUNT(*) AS n FROM trades')[0]!.n;
    await elapse(r, 60);
    expect(sql<{ n: number }>(r, 'SELECT COUNT(*) AS n FROM trades')[0]!.n).toBe(tradesBefore);
    expect(r.app.services.matches.settle(matchId)).toBe(false);
    // History shows it, and the player can start another match against a bot at once (the bot is free again).
    const history = (await call(r, '/api/matches', { cookie })).json.matches as any[];
    expect(history[0]).toMatchObject({ matchId, outcome: 'forfeit', opponent: { bot: true } });
    const next = await playBot(r, cookie);
    expect(next.status).toBe(200);
    expect(next.json.match.id).not.toBe(matchId);
    expect(botOf(next.json.match)).toBeTruthy();
  }, LONG);

  it('BOT-16: leaving a live match with a bot before it has any trades works too, and leaving the countdown is still just leaving', async () => {
    const r = await boot();
    const { cookie, view } = await botMatch(r, 'alice');
    await gotoTick(r, (view.startTick as number) + 2);
    const left = await call(r, '/api/lobby/leave', { method: 'POST', cookie });
    expect(left.json.match.phase).toBe('finished');
    expect(left.json.match.players.find((p: any) => p.you).result).toBe('forfeit');
    await call(r, '/api/lobby/dismiss', { method: 'POST', cookie });
    expect((await call(r, '/api/lobby', { cookie })).json.match).toBeNull();
    // A countdown that is left is cancelled as before.
    const second = await botMatch(r, 'bobby');
    const out = await call(r, '/api/lobby/leave', { method: 'POST', cookie: second.cookie });
    expect(out.json.match).toBeNull();
    expect(sql<{ state: string }>(r, 'SELECT state FROM matches WHERE id = ?', second.matchId)[0]?.state).toBe('cancelled');
  }, LONG);
});

describe('how a bot plays', () => {
  it('BOT-13: the same match is played the same way (seeded), and the bot only reads finished candles and never random numbers', async () => {
    const a = seeded(123);
    const b = seeded(123);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    expect(seeded(124)()).not.toBe(seeded(123)());
    const src = readFileSync(join(process.cwd(), 'server', 'lobby', 'bots.ts'), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(src).not.toMatch(/Math\.random|crypto/);
    expect(src).toMatch(/Math\.floor\(this\.world\.savedTick \/ 10\) - 1/); // the last FINISHED candle
    expect(src).not.toMatch(/from '\.\.\/\.\.\/src\/world'/); // no direct use of price functions: only the market's current quote and stored candles

    const runOnce = async (): Promise<string[]> => {
      const r = await boot();
      const { view } = await botMatch(r, 'alice');
      await gotoTick(r, view.endTick as number);
      const botUser = sql<{ user_id: number }>(r, 'SELECT user_id FROM bots')[0]!.user_id;
      const rows = sql<{ tick: number; company_id: number; side: string; filled: number }>(r, 'SELECT t.tick, t.company_id, t.side, t.filled FROM trades t JOIN accounts a ON a.id = t.account_id WHERE a.user_id = ? ORDER BY t.id', botUser);
      const start = view.startTick as number;
      await stopOne(r);
      return rows.map((t) => `${t.tick - start}:${t.company_id}:${t.side}:${t.filled}`);
    };
    const first = await runOnce();
    const second = await runOnce();
    expect(first.length).toBeGreaterThanOrEqual(1);
    expect(second).toEqual(first);
  }, LONG);

  it('BOT-14: all eight styles play a full match in a world with memecoins: each one trades, nothing is refused outside the rules, every match ends', async () => {
    const r = await boot({ coins: true });
    const names = PERSONAS.map((_, i) => `player${i}`);
    const cookies: string[] = [];
    for (const n of names) cookies.push(await signUp(r, n));
    let end = 0;
    for (const c of cookies) {
      expect((await playBot(r, c)).status).toBe(200);
      end = Math.max(end, (await ready(r, c)).json.match.endTick as number); // full lobbies: the next player cannot join this one
    }
    expect(new Set(sql<{ persona: string }>(r, 'SELECT persona FROM bots').map((b) => b.persona)).size).toBe(8);
    await gotoTick(r, end);
    for (const p of PERSONAS) {
      const user = sql<{ user_id: number }>(r, 'SELECT b.user_id FROM bots b WHERE b.persona = ?', p.id)[0]!.user_id;
      const trades = sql<{ n: number }>(r, 'SELECT COUNT(*) AS n FROM trades t JOIN accounts a ON a.id = t.account_id WHERE a.user_id = ?', user)[0]!.n;
      expect(`${p.id}:${trades >= 1}`).toBe(`${p.id}:true`);
      const acc = sql<{ cash_cents: number }>(r, "SELECT cash_cents FROM accounts WHERE user_id = ? AND kind = 'match'", user)[0]!;
      expect(acc.cash_cents).toBeGreaterThanOrEqual(0);
    }
    await elapse(r, 15);
    for (const c of cookies) expect((await call(r, '/api/lobby', { cookie: c })).json.match.phase).toBe('finished');
    // Coin styles trade coins, stock styles trade stocks.
    const sectorOf = (companyId: number): string => r.app.services.world.companies[companyId]?.sector ?? '';
    for (const p of PERSONAS.filter((x) => x.pool !== 'any')) {
      const user = sql<{ user_id: number }>(r, 'SELECT b.user_id FROM bots b WHERE b.persona = ?', p.id)[0]!.user_id;
      for (const t of sql<{ company_id: number }>(r, 'SELECT t.company_id FROM trades t JOIN accounts a ON a.id = t.account_id WHERE a.user_id = ?', user)) {
        expect(`${p.id}:${sectorOf(t.company_id) === 'meme'}`).toBe(`${p.id}:${p.pool === 'coins'}`);
      }
    }
  }, LONG);
});

async function stopOne(r: Running): Promise<void> {
  await new Promise<void>((done) => {
    r.server.closeAllConnections?.();
    r.server.close(() => done());
  });
  r.app.close();
  running.splice(running.indexOf(r), 1);
}
