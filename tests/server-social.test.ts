// Friends, the player list and the leaderboard of the richest players, over HTTP (server/social.ts, docs/world.md §13).
// The properties that matter: the leaderboard is Career net worth and nothing else, it never shows the owner, a computer player or a
// banned player, it shows 100 players and tells everybody where they stand, friends need a yes from both sides, and other players
// learn nothing about you except your name and your net worth.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../server/app';
import { loadConfig } from '../server/config';
import { PERSONAS, botUserId } from '../server/lobby/bots';
import { Logger } from '../server/log';
import { migrate } from '../server/schema';
import { Db } from '../server/sqlite';
import { BOARD_CACHE_MS, BOARD_SIZE, MAX_FRIENDS, MAX_INCOMING, MAX_OUTGOING } from '../server/social';
import { Clock } from './helpers/server';

const LONG = 240_000;
const PASSWORD = 'a-good-password';

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
  let dir = options.dir;
  if (!dir) {
    dir = mkdtempSync(join(tmpdir(), 'tq-social-'));
    dirs.push(dir);
  }
  const clock = options.clock ?? new Clock();
  const config = loadConfig({ TQ_DATA_DIR: dir, TQ_COMPANIES: '12', TQ_WARMUP_DAYS: '1', TQ_PORT: '8787', TQ_OWNER: 'boss' });
  const app = createApp({ config, log: new Logger({ sink: null, now: clock.now }), worldSeed: 777, now: clock.now, flowGain: 0 });
  const server = createServer(app.handler);
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
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
  return { status: res.status, json };
}

async function signUp(r: Running, name: string): Promise<string> {
  const res = await fetch(r.base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: name, password: PASSWORD }) });
  expect(res.status).toBe(201);
  return (res.headers.get('set-cookie') ?? '').split(';')[0] as string;
}

const db = (r: Running) => r.app.services.db;
const idOf = (r: Running, name: string): number => (db(r).get<{ id: number }>('SELECT id FROM users WHERE username = ?', name) as { id: number }).id;
const setCash = (r: Running, name: string, cents: number): void => {
  db(r).run("UPDATE accounts SET cash_cents = ?, start_cash_cents = ? WHERE kind = 'career' AND user_id = ?", cents, cents, idOf(r, name));
};
/** Makes a player without going through the sign-up form (which allows ten new accounts an hour from one address). */
function addPlayer(r: Running, name: string, cashCents: number, createdMs = r.clock.now()): number {
  return db(r).tx(() => {
    const u = db(r).run("INSERT INTO users(username, display_name, pw_hash, role, created_ms) VALUES (?, ?, 'x', 'player', ?)", name, name, createdMs);
    db(r).run("INSERT INTO accounts(user_id, kind, match_id, cash_cents, start_cash_cents, created_ms) VALUES (?, 'career', NULL, ?, ?, ?)", u.lastInsertRowid, cashCents, cashCents, createdMs);
    return u.lastInsertRowid;
  });
}
/** Lets the worked-out ranking go out of date, as half a minute of real time does. */
const later = (r: Running, seconds = BOARD_CACHE_MS / 1000 + 1): void => r.clock.advanceSeconds(seconds);

const names = (rows: readonly { username: string }[]): string[] => rows.map((x) => x.username);
const board = async (r: Running, cookie: string, scope = 'all') => (await call(r, `/api/leaderboard?scope=${scope}`, { cookie })).json;
const friends = async (r: Running, cookie: string) => (await call(r, '/api/friends', { cookie })).json;
const act = (r: Running, cookie: string, what: 'request' | 'accept' | 'decline' | 'cancel' | 'remove', username: string) =>
  call(r, `/api/friends/${what}`, { method: 'POST', cookie, body: { username } });
const befriend = async (r: Running, a: string, aName: string, b: string, bName: string): Promise<void> => {
  expect((await act(r, a, 'request', bName)).status).toBe(200);
  expect((await act(r, b, 'accept', aName)).status).toBe(200);
};

describe('who may ask', () => {
  it('SOCIAL-1: the player list, the leaderboard and every friend action need a signed-in player', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const wrong: string[] = [];
    for (const path of ['/api/players', '/api/leaderboard', '/api/friends']) {
      const out = await call(r, path);
      if (out.status !== 401 || out.json.error.code !== 'sign_in_required') wrong.push(`GET ${path}: ${out.status}`);
      const ok = await call(r, path, { cookie: alice });
      if (ok.status !== 200) wrong.push(`GET ${path} signed in: ${ok.status}`);
    }
    for (const what of ['request', 'accept', 'decline', 'cancel', 'remove']) {
      const out = await call(r, `/api/friends/${what}`, { method: 'POST', body: { username: 'alice' } });
      if (out.status !== 401) wrong.push(`POST ${what}: ${out.status}`);
    }
    expect(wrong).toEqual([]);
    expect(db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM friendships')?.n).toBe(0);
  }, LONG);
});

describe('the leaderboard', () => {
  it('SOCIAL-2: players are ranked by Career net worth, richest first; the owner, the computer players and banned players are left out', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    await signUp(r, 'bob');
    await signUp(r, 'carol');
    const boss = await signUp(r, 'boss');
    setCash(r, 'alice', 500_000);
    setCash(r, 'bob', 2_000_000);
    setCash(r, 'carol', 300_000);
    setCash(r, 'boss', 90_000_000); // the owner has far more than anybody
    // A computer player that happens to be richest of all, as the 1v1 bots' Career accounts can be.
    const botId = botUserId(db(r), PERSONAS[0] as (typeof PERSONAS)[number], r.clock.now());
    db(r).run("INSERT INTO accounts(user_id, kind, match_id, cash_cents, start_cash_cents, created_ms) VALUES (?, 'career', NULL, ?, ?, ?)", botId, 800_000_000, 800_000_000, r.clock.now());
    later(r);

    const b = await board(r, alice);
    expect(b.scope).toBe('all');
    expect(b.rows.map((x: { username: string; rank: number; netWorthCents: number }) => [x.rank, x.username, x.netWorthCents])).toEqual([
      [1, 'bob', 2_000_000],
      [2, 'alice', 500_000],
      [3, 'carol', 300_000],
    ]);
    expect(b.total).toBe(3);
    expect(b.me).toEqual({ rank: 2, netWorthCents: 500_000, inTop: true });
    expect(JSON.stringify(b)).not.toMatch(/boss|bot-|\(bot\)/);

    // The owner does not see himself ranked either.
    const forBoss = await board(r, boss);
    expect(names(forBoss.rows)).toEqual(['bob', 'alice', 'carol']);
    expect(forBoss.me).toBeNull();

    // A banned player drops out at once, and comes back when the ban is lifted.
    const ban = await call(r, '/api/admin/ban', { method: 'POST', cookie: boss, body: { requestId: 'ban-0000001', username: 'bob', reason: 'cheating', hours: null } });
    expect(ban.status).toBe(200);
    expect(names((await board(r, alice)).rows)).toEqual(['alice', 'carol']);
    expect((await call(r, '/api/admin/unban', { method: 'POST', cookie: boss, body: { requestId: 'ban-0000002', username: 'bob' } })).status).toBe(200);
    expect(names((await board(r, alice)).rows)).toEqual(['bob', 'alice', 'carol']);
  }, LONG);

  it('SOCIAL-3: the same money ranks the older account first, and the order never changes between two questions', async () => {
    const r = await boot();
    const first = await signUp(r, 'first');
    r.clock.advanceSeconds(5);
    await signUp(r, 'second');
    r.clock.advanceSeconds(5);
    await signUp(r, 'third');
    const one = await board(r, first);
    expect(names(one.rows)).toEqual(['first', 'second', 'third']);
    later(r);
    expect(await board(r, first)).toMatchObject({ rows: one.rows });
    // An account that is older than the others comes first even though it was added last (it has the highest id).
    addPlayer(r, 'veteran', 100_000, r.clock.now() - 86_400_000);
    expect(names((await board(r, first)).rows)).toEqual(['veteran', 'first', 'second', 'third']);
  }, LONG);

  it('SOCIAL-4: only the best 100 are listed; everybody else is told their own place', async () => {
    const r = await boot();
    const zed = await signUp(r, 'zed');
    setCash(r, 'zed', 100); // the poorest of all
    for (let i = 1; i <= 104; i += 1) addPlayer(r, `p${String(i).padStart(3, '0')}`, 100_000 + i * 100);
    later(r);
    const b = await board(r, zed);
    expect(BOARD_SIZE).toBe(100);
    expect(b.rows).toHaveLength(100);
    expect(b.rows[0]).toMatchObject({ rank: 1, username: 'p104' });
    expect(b.rows[99]).toMatchObject({ rank: 100, username: 'p005' });
    expect(b.total).toBe(105);
    expect(b.size).toBe(100);
    expect(b.me).toEqual({ rank: 105, netWorthCents: 100, inTop: false });
    expect(names(b.rows)).not.toContain('zed');

    const rich = await signUp(r, 'rich');
    setCash(r, 'rich', 99_999_999);
    later(r);
    const top = await board(r, rich);
    expect(top.rows[0]).toMatchObject({ rank: 1, username: 'rich', relation: 'you' });
    expect(top.me).toEqual({ rank: 1, netWorthCents: 99_999_999, inTop: true });
    expect(top.rows).toHaveLength(100);
  }, LONG);

  it('SOCIAL-5: net worth is what My account shows: cash plus what the shares are worth, and it moves with the market', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    await signUp(r, 'bob');
    const w = r.app.services.world;
    for (let i = 0; i < 200_000 && w.sim.tick < w.currentTick(); i += 1) w.pump();
    const buy = await call(r, '/api/orders', { method: 'POST', cookie: alice, body: { account: 'career', ticker: 'QLRX', side: 'buy', qty: 3, clientOrderId: 'alice-order-0001' } });
    expect(buy.status).toBe(201);
    later(r);
    for (let i = 0; i < 200_000 && w.sim.tick < w.currentTick(); i += 1) w.pump();
    const mine = (await call(r, '/api/account', { cookie: alice })).json;
    const b = await board(r, alice);
    const row = b.rows.find((x: { username: string }) => x.username === 'alice');
    expect(row.netWorthCents).toBe(mine.netWorthCents);
    expect(mine.positions).toHaveLength(1);
    expect(mine.netWorthCents).not.toBe(mine.cashCents); // there really is a holding in it
    expect(b.me.netWorthCents).toBe(mine.netWorthCents);
  }, LONG);

  it('SOCIAL-6: the ranking is worked out once and kept for half a minute; a new player or a ban shows at once', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    setCash(r, 'alice', 500_000);
    later(r);
    expect((await board(r, alice)).me.netWorthCents).toBe(500_000);
    setCash(r, 'alice', 900_000);
    expect((await board(r, alice)).me.netWorthCents).toBe(500_000); // still the old number
    r.clock.advanceSeconds(BOARD_CACHE_MS / 1000 - 1);
    expect((await board(r, alice)).me.netWorthCents).toBe(500_000);
    r.clock.advanceSeconds(2);
    expect((await board(r, alice)).me.netWorthCents).toBe(900_000);
    // A player who signs up is on the list straight away.
    await signUp(r, 'newbie');
    expect(names((await board(r, alice)).rows)).toContain('newbie');
  }, LONG);
});

describe('the player list', () => {
  it('SOCIAL-7: it lists real players richest first with the owner last and without a net worth; bots and banned players are not on it', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    await signUp(r, 'Bobby');
    const boss = await signUp(r, 'boss');
    await signUp(r, 'mallory');
    setCash(r, 'alice', 500_000);
    setCash(r, 'Bobby', 900_000);
    setCash(r, 'boss', 90_000_000);
    botUserId(db(r), PERSONAS[1] as (typeof PERSONAS)[number], r.clock.now());
    later(r);
    expect((await call(r, '/api/admin/ban', { method: 'POST', cookie: boss, body: { requestId: 'ban-0000003', username: 'mallory', hours: 1 } })).status).toBe(200);

    const list = (await call(r, '/api/players', { cookie: alice })).json;
    expect(list.total).toBe(3);
    expect(list.players.map((p: { username: string; rank: number | null; netWorthCents: number | null; role: string; relation: string }) => [p.username, p.role, p.rank, p.netWorthCents, p.relation])).toEqual([
      ['Bobby', 'player', 1, 900_000, 'none'],
      ['alice', 'player', 2, 500_000, 'you'],
      ['boss', 'owner', null, null, 'none'],
    ]);
    // Search: any part of the name, any case, with or without @.
    expect(names((await call(r, '/api/players?q=BOB', { cookie: alice })).json.players)).toEqual(['Bobby']);
    expect(names((await call(r, '/api/players?q=%40ali', { cookie: alice })).json.players)).toEqual(['alice']);
    expect((await call(r, '/api/players?q=bot', { cookie: alice })).json.players).toEqual([]);
    expect((await call(r, '/api/players?q=mallory', { cookie: alice })).json.total).toBe(0);
  }, LONG);

  it('SOCIAL-8: the list comes in pages, and a page or a search that is out of range is refused', async () => {
    const r = await boot();
    const zed = await signUp(r, 'zed');
    for (let i = 1; i <= 59; i += 1) addPlayer(r, `p${String(i).padStart(3, '0')}`, 100_000 + i * 100);
    later(r);
    const first = (await call(r, '/api/players', { cookie: zed })).json;
    expect(first.total).toBe(60);
    expect(first.players).toHaveLength(50);
    const second = (await call(r, '/api/players?offset=50', { cookie: zed })).json;
    expect(second.players).toHaveLength(10);
    expect(second.players[9]).toMatchObject({ username: 'zed', relation: 'you' });
    expect((await call(r, '/api/players?limit=5&offset=2', { cookie: zed })).json.players).toHaveLength(5);
    for (const bad of ['limit=0', 'limit=101', 'offset=-1', 'limit=abc', `q=${'x'.repeat(41)}`]) {
      const out = await call(r, `/api/players?${bad}`, { cookie: zed });
      expect([bad, out.status]).toEqual([bad, 400]);
    }
    expect((await call(r, '/api/leaderboard?scope=everything', { cookie: zed })).status).toBe(400);
  }, LONG);

  it('SOCIAL-9: other players see a name, a place, a net worth and a few badge icons, nothing more', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const bob = await signUp(r, 'bob');
    await befriend(r, alice, 'alice', bob, 'bob');
    later(r);
    const keys = (o: object): string[] => Object.keys(o).sort();
    const list = (await call(r, '/api/players', { cookie: bob })).json;
    for (const p of list.players) expect(keys(p)).toEqual(['badges', 'displayName', 'netWorthCents', 'rank', 'relation', 'role', 'username']);
    const b = await board(r, bob);
    for (const x of b.rows) expect(keys(x)).toEqual(['displayName', 'netWorthCents', 'rank', 'relation', 'username']);
    const f = await friends(r, bob);
    expect(keys(f)).toEqual(['friends', 'incoming', 'limits', 'outgoing']);
    for (const x of f.friends) expect(keys(x)).toEqual(['displayName', 'netWorthCents', 'rank', 'role', 'sinceMs', 'username']);
    expect(JSON.stringify([list, b, f])).not.toMatch(/cash|position|holding|trade|id"|email|pw_hash/i);
  }, LONG);
});

describe('friends', () => {
  it('SOCIAL-10: a request needs a yes: it waits on both sides until the other player accepts, and then both are friends', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const bob = await signUp(r, 'bob');
    setCash(r, 'bob', 900_000);
    setCash(r, 'alice', 500_000);
    later(r);

    const sent = await act(r, alice, 'request', 'bob');
    expect(sent.status).toBe(200);
    expect(sent.json.relation).toBe('outgoing');
    expect(sent.json.outgoing.map((x: { username: string }) => x.username)).toEqual(['bob']);
    expect(sent.json.friends).toEqual([]);
    const forBob = await friends(r, bob);
    expect(forBob.incoming.map((x: { username: string }) => x.username)).toEqual(['alice']);
    expect(forBob.friends).toEqual([]);
    expect((await call(r, '/api/players?q=alice', { cookie: bob })).json.players[0].relation).toBe('incoming');
    expect((await call(r, '/api/players?q=bob', { cookie: alice })).json.players[0].relation).toBe('outgoing');
    // Only the player who was asked can say yes.
    const self = await act(r, alice, 'accept', 'bob');
    expect(self.status).toBe(404);
    expect(self.json.error.code).toBe('no_request');
    expect((await friends(r, alice)).friends).toEqual([]);

    const accepted = await act(r, bob, 'accept', 'alice');
    expect(accepted.status).toBe(200);
    expect(accepted.json.relation).toBe('friend');
    expect(accepted.json.incoming).toEqual([]);
    expect(names(accepted.json.friends)).toEqual(['alice']);
    expect(accepted.json.friends[0]).toMatchObject({ rank: 2, netWorthCents: 500_000, role: 'player' });
    const forAlice = await friends(r, alice);
    expect(names(forAlice.friends)).toEqual(['bob']);
    expect(forAlice.outgoing).toEqual([]);
    expect(forAlice.limits).toEqual({ maxFriends: MAX_FRIENDS, maxOutgoing: MAX_OUTGOING });
    expect((await call(r, '/api/players?q=bob', { cookie: alice })).json.players[0].relation).toBe('friend');
  }, LONG);

  it('SOCIAL-11: asking someone who already asked you is a yes; asking twice or asking a friend changes nothing', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const bob = await signUp(r, 'bob');
    await act(r, alice, 'request', 'bob');
    const again = await act(r, alice, 'request', 'bob');
    expect(again.status).toBe(200);
    expect(again.json.relation).toBe('outgoing');
    expect(db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM friendships')?.n).toBe(1);
    const back = await act(r, bob, 'request', 'alice'); // he asks her back: that is a yes
    expect(back.json.relation).toBe('friend');
    expect(names(back.json.friends)).toEqual(['alice']);
    const third = await act(r, alice, 'request', 'bob');
    expect(third.json.relation).toBe('friend');
    expect(db(r).get<{ n: number }>("SELECT COUNT(*) AS n FROM friendships WHERE status = 'accepted'")?.n).toBe(1);
    expect((await act(r, bob, 'accept', 'alice')).json.relation).toBe('friend'); // saying yes twice is fine too
  }, LONG);

  it('SOCIAL-12: you cannot ask yourself, a stranger who does not exist, a computer player or a banned player; names ignore case and a leading @', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    await signUp(r, 'Bobby');
    const boss = await signUp(r, 'boss');
    await signUp(r, 'mallory');
    botUserId(db(r), PERSONAS[0] as (typeof PERSONAS)[number], r.clock.now());
    expect((await act(r, alice, 'request', 'alice')).json.error.code).toBe('bad_request');
    expect((await act(r, alice, 'request', 'nobody')).json.error.code).toBe('no_such_player');
    expect((await act(r, alice, 'request', '')).json.error.code).toBe('no_such_player');
    expect((await act(r, alice, 'request', 'bot-sam')).status).toBe(404);
    expect((await call(r, '/api/friends/request', { method: 'POST', cookie: alice, body: { username: 5 } })).status).toBe(400);
    expect((await call(r, '/api/friends/request', { method: 'POST', cookie: alice, body: {} })).status).toBe(400);
    expect((await call(r, '/api/admin/ban', { method: 'POST', cookie: boss, body: { requestId: 'ban-0000004', username: 'mallory', hours: null } })).status).toBe(200);
    expect((await act(r, alice, 'request', 'mallory')).status).toBe(404);
    expect((await act(r, alice, 'request', '  @bobby ')).json.relation).toBe('outgoing');
    expect(db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM friendships')?.n).toBe(1);
    // The owner is a player like any other for friends.
    expect((await act(r, alice, 'request', 'BOSS')).json.relation).toBe('outgoing');
  }, LONG);

  it('SOCIAL-13: declining, cancelling and removing; the refused ones say why; a declined request can be sent again', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const bob = await signUp(r, 'bob');
    const carol = await signUp(r, 'carol');
    await act(r, alice, 'request', 'bob');
    // Bob says no: the request is gone from both lists (Alice gets no notice, it just disappears).
    const no = await act(r, bob, 'decline', 'alice');
    expect(no.status).toBe(200);
    expect(no.json.incoming).toEqual([]);
    expect((await friends(r, alice)).outgoing).toEqual([]);
    expect((await act(r, bob, 'decline', 'alice')).json.error.code).toBe('no_request');
    expect((await act(r, alice, 'cancel', 'bob')).json.error.code).toBe('no_request');
    // Taking a request back: it goes from both lists.
    await act(r, alice, 'request', 'bob');
    expect((await act(r, alice, 'cancel', 'bob')).json.outgoing).toEqual([]);
    expect((await friends(r, bob)).incoming).toEqual([]);
    // The one who sent a request cannot decline it, and the one who got it cannot cancel it.
    await act(r, alice, 'request', 'bob');
    expect((await act(r, alice, 'decline', 'bob')).json.error.code).toBe('no_request');
    expect((await act(r, bob, 'cancel', 'alice')).json.error.code).toBe('no_request');
    expect((await friends(r, bob)).incoming).toHaveLength(1);

    await act(r, bob, 'accept', 'alice');
    expect((await act(r, carol, 'remove', 'alice')).json.error.code).toBe('not_friends');
    expect((await act(r, alice, 'decline', 'bob')).json.error.code).toBe('no_request'); // nothing is waiting any more
    const gone = await act(r, alice, 'remove', 'bob');
    expect(gone.json.friends).toEqual([]);
    expect((await friends(r, bob)).friends).toEqual([]); // for both
    expect((await act(r, alice, 'remove', 'bob')).json.error.code).toBe('not_friends');
    expect((await act(r, alice, 'remove', 'nobody')).json.error.code).toBe('no_such_player');
    expect((await act(r, alice, 'request', 'bob')).json.relation).toBe('outgoing'); // a fresh start
  }, LONG);

  it('SOCIAL-14: the limits: friends, requests waiting, and requests waiting for one player', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const bob = await signUp(r, 'bob');
    const aliceId = idOf(r, 'alice');
    const bobId = idOf(r, 'bob');
    const link = (x: number, y: number, requester: number, status: 'pending' | 'accepted') => {
      const [a, b] = x < y ? [x, y] : [y, x];
      db(r).run('INSERT INTO friendships(user_a, user_b, requester_id, status, created_ms, accepted_ms) VALUES (?, ?, ?, ?, ?, ?)', a, b, requester, status, r.clock.now(), status === 'accepted' ? r.clock.now() : null);
    };
    // Alice has sent the most requests there can be.
    const pending = Array.from({ length: MAX_OUTGOING }, (_, i) => addPlayer(r, `w${String(i).padStart(2, '0')}`, 100_000));
    for (const id of pending) link(aliceId, id, aliceId, 'pending');
    const refused = await act(r, alice, 'request', 'bob');
    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe('too_many_requests');
    expect((await act(r, alice, 'cancel', 'w00')).status).toBe(200);
    expect((await act(r, alice, 'request', 'bob')).json.relation).toBe('outgoing');

    // Bob has the most requests waiting that one player can have.
    const askers = Array.from({ length: MAX_INCOMING }, (_, i) => addPlayer(r, `q${String(i).padStart(3, '0')}`, 100_000));
    for (const id of askers) link(bobId, id, id, 'pending');
    const carol = await signUp(r, 'carol');
    const busy = await act(r, carol, 'request', 'bob');
    expect(busy.status).toBe(409);
    expect(busy.json.error.code).toBe('player_busy');
    expect((await friends(r, bob)).incoming.length).toBe(MAX_INCOMING + 1);

    // Erin asks Dave; then Dave gets the most friends there can be. He can neither ask her back nor say yes, until he removes one.
    const dave = await signUp(r, 'dave');
    const erin = await signUp(r, 'erin');
    expect((await act(r, erin, 'request', 'dave')).status).toBe(200);
    const daveId = idOf(r, 'dave');
    for (let i = 0; i < MAX_FRIENDS; i += 1) link(daveId, addPlayer(r, `f${String(i).padStart(3, '0')}`, 100_000), daveId, 'accepted');
    expect((await act(r, dave, 'accept', 'erin')).json.error.code).toBe('too_many_friends');
    expect((await act(r, dave, 'request', 'erin')).json.error.code).toBe('too_many_friends'); // asking her back is a yes too
    expect((await friends(r, dave)).friends.length).toBe(MAX_FRIENDS);
    expect((await act(r, dave, 'remove', 'f000')).status).toBe(200);
    expect((await act(r, dave, 'accept', 'erin')).json.relation).toBe('friend');
    // Nobody can ask a player who is full, and a full player cannot ask anybody.
    const frank = await signUp(r, 'frank');
    expect((await act(r, frank, 'request', 'dave')).json.error.code).toBe('too_many_friends');
    expect((await act(r, dave, 'request', 'frank')).json.error.code).toBe('too_many_friends');
  }, LONG);

  it('SOCIAL-15: too many changes too quickly are refused', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    for (let i = 0; i < 25; i += 1) addPlayer(r, `p${String(i).padStart(2, '0')}`, 100_000);
    const results: number[] = [];
    for (let i = 0; i < 25; i += 1) results.push((await act(r, alice, 'request', `p${String(i).padStart(2, '0')}`)).status);
    expect(results.slice(0, 20).every((s) => s === 200)).toBe(true);
    expect(results.slice(20)).toEqual([429, 429, 429, 429, 429]);
    r.clock.advanceSeconds(11);
    expect((await act(r, alice, 'request', 'p20')).status).toBe(200);
  }, LONG);

  it('SOCIAL-16: the other player is told over his live stream when a request arrives, is accepted or is taken away', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const bob = await signUp(r, 'bob');
    const told: number[] = [];
    const hub = r.app.services.hub as unknown as { publishTo(userId: number, event: string, data: unknown): void };
    const original = hub.publishTo.bind(hub);
    hub.publishTo = (userId, event, data) => {
      if (event === 'friends') told.push(userId);
      original(userId, event, data);
    };
    const aliceId = idOf(r, 'alice');
    const bobId = idOf(r, 'bob');
    await act(r, alice, 'request', 'bob');
    expect(told).toEqual([bobId]);
    await act(r, bob, 'accept', 'alice');
    expect(told).toEqual([bobId, aliceId]);
    await act(r, bob, 'remove', 'alice');
    expect(told).toEqual([bobId, aliceId, aliceId]);
    await act(r, alice, 'request', 'bob');
    await act(r, alice, 'cancel', 'bob');
    expect(told.slice(3)).toEqual([bobId, bobId]);
    await act(r, alice, 'request', 'bob');
    const before = told.length;
    await act(r, bob, 'decline', 'alice'); // a "no" is silent
    expect(told.length).toBe(before);
  }, LONG);

  it('SOCIAL-17: a banned friend is hidden while the ban lasts and is back when it ends; nothing is lost', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const bob = await signUp(r, 'bob');
    const boss = await signUp(r, 'boss');
    await befriend(r, alice, 'alice', bob, 'bob');
    expect(names((await friends(r, alice)).friends)).toEqual(['bob']);
    await call(r, '/api/admin/ban', { method: 'POST', cookie: boss, body: { requestId: 'ban-0000005', username: 'bob', hours: null } });
    expect((await friends(r, alice)).friends).toEqual([]);
    expect(names((await board(r, alice, 'friends')).rows)).toEqual(['alice']);
    await call(r, '/api/admin/unban', { method: 'POST', cookie: boss, body: { requestId: 'ban-0000006', username: 'bob' } });
    expect(names((await friends(r, alice)).friends)).toEqual(['bob']);
  }, LONG);
});

describe('the friends leaderboard', () => {
  it('SOCIAL-18: it ranks you and your friends against each other and nobody else', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const bob = await signUp(r, 'bob');
    const carol = await signUp(r, 'carol');
    await signUp(r, 'stranger');
    setCash(r, 'alice', 500_000);
    setCash(r, 'bob', 900_000);
    setCash(r, 'carol', 100_000);
    setCash(r, 'stranger', 9_000_000);
    await befriend(r, alice, 'alice', bob, 'bob');
    await befriend(r, alice, 'alice', carol, 'carol');
    later(r);

    const mine = await board(r, alice, 'friends');
    expect(mine.scope).toBe('friends');
    expect(mine.rows.map((x: { rank: number; username: string; relation: string }) => [x.rank, x.username, x.relation])).toEqual([
      [1, 'bob', 'friend'],
      [2, 'alice', 'you'],
      [3, 'carol', 'friend'],
    ]);
    expect(mine.total).toBe(3);
    expect(mine.me).toEqual({ rank: 2, netWorthCents: 500_000, inTop: true });
    // Bob and Carol are not friends with each other, so Carol sees only herself and Alice.
    expect(names((await board(r, carol, 'friends')).rows)).toEqual(['alice', 'carol']);
    // Everyone's own place in the big list is the same as before.
    expect((await board(r, alice, 'all')).me.rank).toBe(3);
    // Waiting requests do not count as friends.
    await act(r, alice, 'request', 'stranger');
    expect(names((await board(r, alice, 'friends')).rows)).toEqual(['bob', 'alice', 'carol']);
  }, LONG);

  it('SOCIAL-19: the owner can be a friend but is never ranked, and sees only his friends', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const boss = await signUp(r, 'boss');
    setCash(r, 'boss', 90_000_000);
    await befriend(r, alice, 'alice', boss, 'boss');
    later(r);
    const f = await friends(r, alice);
    expect(f.friends).toHaveLength(1);
    expect(f.friends[0]).toMatchObject({ username: 'boss', role: 'owner', rank: null, netWorthCents: null });
    expect(names((await board(r, alice, 'friends')).rows)).toEqual(['alice']);
    const forBoss = await board(r, boss, 'friends');
    expect(names(forBoss.rows)).toEqual(['alice']);
    expect(forBoss.me).toBeNull();
  }, LONG);
});

describe('storage', () => {
  it('SOCIAL-20: friends and requests survive a restart of the server', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const bob = await signUp(r, 'bob');
    await signUp(r, 'carol');
    await befriend(r, alice, 'alice', bob, 'bob');
    await act(r, alice, 'request', 'carol');
    await stop(r);
    running.splice(running.indexOf(r), 1);
    const again = await boot({ dir: r.dir, clock: r.clock });
    const login = async (name: string) => (await fetch(again.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: name, password: PASSWORD }) })).headers.get('set-cookie')!.split(';')[0]!;
    const a = await friends(again, await login('alice'));
    expect(names(a.friends)).toEqual(['bob']);
    expect(names(a.outgoing)).toEqual(['carol']);
    expect(names((await friends(again, await login('carol'))).incoming)).toEqual(['alice']);
  }, LONG);

  it('SOCIAL-21: the table refuses a pair stored the wrong way round, twice, with a stranger as requester, or accepted without a time', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tq-social-db-'));
    dirs.push(dir);
    const d = new Db(join(dir, 'x.sqlite'));
    try {
      migrate(d);
      for (const id of [1, 2, 3]) d.run("INSERT INTO users(id, username, display_name, pw_hash, role, created_ms) VALUES (?, ?, ?, 'x', 'player', 1)", id, `u${id}`, `u${id}`);
      const insert = (a: number, b: number, requester: number, status: string, accepted: number | null) =>
        d.run('INSERT INTO friendships(user_a, user_b, requester_id, status, created_ms, accepted_ms) VALUES (?, ?, ?, ?, 1, ?)', a, b, requester, status, accepted);
      expect(() => insert(2, 1, 1, 'pending', null)).toThrow(); // smaller id first
      expect(() => insert(1, 1, 1, 'pending', null)).toThrow(); // not with yourself
      expect(() => insert(1, 2, 3, 'pending', null)).toThrow(); // the requester is one of the two
      expect(() => insert(1, 2, 1, 'accepted', null)).toThrow(); // accepted needs a time
      expect(() => insert(1, 2, 1, 'pending', 5)).toThrow(); // waiting has none
      expect(() => insert(1, 2, 1, 'blocked', null)).toThrow();
      insert(1, 2, 1, 'pending', null);
      expect(() => insert(1, 2, 2, 'pending', null)).toThrow(); // one row per pair
      d.run('DELETE FROM users WHERE id = 2'); // a player who is deleted takes his friendships with him
      expect(d.get<{ n: number }>('SELECT COUNT(*) AS n FROM friendships')?.n).toBe(0);
    } finally {
      d.close();
    }
  });
});

describe('what it cannot do', () => {
  it('SOCIAL-22: nothing here moves money or shares between players, and the routes only ask the Social service', () => {
    const strip = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const service = strip(readFileSync(resolve(process.cwd(), 'server', 'social.ts'), 'utf8'));
    const routes = strip(readFileSync(resolve(process.cwd(), 'server', 'routes', 'social.ts'), 'utf8'));
    const writes = [...service.matchAll(/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(\w+)/gi)].map((m) => (m[2] as string).toLowerCase());
    expect([...new Set(writes)].sort()).toEqual(['friendships', 'weekly_marks']); // the tables of this feature (the weekly board keeps each player's net worth at the start of the week: a number to compare with, no money moves)
    expect(service).not.toMatch(/cash_cents|wallets|positions|placeOrder|adjustCash/);
    expect(routes).not.toMatch(/\.db\b|trading\.|cash/);
  });
});

describe('many players', () => {
  it('SOCIAL-23: 3,000 players are ranked in a fraction of a second, and a second question in the same half minute costs almost nothing', async () => {
    const r = await boot();
    const zed = await signUp(r, 'zed');
    db(r).tx(() => {
      for (let i = 1; i <= 3000; i += 1) addPlayer(r, `m${String(i).padStart(4, '0')}`, 100_000 + ((i * 7919) % 100_000));
    });
    later(r);
    const t0 = performance.now();
    const b = await board(r, zed);
    const first = performance.now() - t0;
    const t1 = performance.now();
    await board(r, zed);
    const second = performance.now() - t1;
    expect(b.total).toBe(3001);
    expect(b.rows).toHaveLength(100);
    // Generous bounds: they only catch a ranking that is worked out again for every request or grows with the square of the players.
    expect(first).toBeLessThan(5000);
    expect(second).toBeLessThan(first + 1000);
  }, LONG);
});
