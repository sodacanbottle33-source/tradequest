// Friend 1v1 challenges over HTTP (server/challenges.ts, docs/world.md §14). The properties that matter: only friends can challenge each other,
// only a friend who has a page open, a challenge runs out, a yes opens a lobby for exactly those two (nobody else can join it, and it is
// cancelled for both if one leaves before it starts), nobody is put in two matches, and the match then plays out like any other.
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LOSER_REWARD_CENTS } from '../src/world';
import { createApp, type App } from '../server/app';
import { CHALLENGE_MS, MAX_WAITING_FOR_ONE, SENDS_PER_MINUTE } from '../server/challenges';
import { loadConfig } from '../server/config';
import { Logger } from '../server/log';
import { Clock } from './helpers/server';

const LONG = 240_000;
const PASSWORD = 'a-good-password';

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
const streams: AbortController[] = [];
afterEach(async () => {
  while (streams.length > 0) streams.pop()?.abort();
  while (running.length > 0) {
    const r = running.pop() as Running;
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
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

async function boot(): Promise<Running> {
  const dir = mkdtempSync(join(tmpdir(), 'tq-challenge-'));
  dirs.push(dir);
  const clock = new Clock();
  const config = loadConfig({ TQ_DATA_DIR: dir, TQ_COMPANIES: '12', TQ_WARMUP_DAYS: '1', TQ_PORT: '8787', TQ_OWNER: 'boss' });
  const app = createApp({ config, log: new Logger({ sink: null, now: clock.now }), worldSeed: 777, now: clock.now, flowGain: 0 });
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
  return { status: res.status, json };
}

async function signUp(r: Running, name: string): Promise<string> {
  const res = await fetch(r.base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: name, password: PASSWORD }) });
  expect(res.status).toBe(201);
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] as string;
  r.players.add(cookie);
  return cookie;
}

/** The player opens the game page: a live stream is open for him, so a friend can see that he is here. */
async function goOnline(r: Running, cookie: string): Promise<AbortController> {
  const controller = new AbortController();
  streams.push(controller);
  const res = await fetch(r.base + '/api/stream', { headers: { Cookie: cookie }, signal: controller.signal });
  expect(res.status).toBe(200);
  return controller;
}

/** The player closes the game page. The server notices the closed connection a moment later. */
async function goOffline(r: Running, name: string, page: AbortController): Promise<void> {
  page.abort();
  const hub = r.app.services.hub as unknown as { has(userId: number): boolean };
  for (let i = 0; i < 200 && hub.has(idOf(r, name)); i += 1) await new Promise<void>((done) => setTimeout(done, 10));
  expect(hub.has(idOf(r, name))).toBe(false);
}

const db = (r: Running) => r.app.services.db;
const idOf = (r: Running, name: string): number => (db(r).get<{ id: number }>('SELECT id FROM users WHERE username = ?', name) as { id: number }).id;

const friendAct = (r: Running, cookie: string, what: 'request' | 'accept' | 'remove', username: string) => call(r, `/api/friends/${what}`, { method: 'POST', cookie, body: { username } });
const befriend = async (r: Running, a: string, aName: string, b: string, bName: string): Promise<void> => {
  expect((await friendAct(r, a, 'request', bName)).status).toBe(200);
  expect((await friendAct(r, b, 'accept', aName)).status).toBe(200);
};
const challenge = (r: Running, cookie: string, what: 'send' | 'accept' | 'decline' | 'cancel', username: string) => call(r, `/api/challenges/${what}`, { method: 'POST', cookie, body: { username } });
const list = async (r: Running, cookie: string) => (await call(r, '/api/challenges', { cookie })).json;
const lobby = async (r: Running, cookie: string) => (await call(r, '/api/lobby', { cookie })).json.match;
const lobbyPost = (r: Running, cookie: string, what: 'join' | 'ready' | 'leave' | 'dismiss', body?: unknown) => call(r, `/api/lobby/${what}`, { method: 'POST', cookie, body });

/** Alice and Bob: friends, both with the page open. */
async function pair(r: Running, a = 'alice', b = 'bob') {
  const [ca, cb] = [await signUp(r, a), await signUp(r, b)];
  await befriend(r, ca, a, cb, b);
  await goOnline(r, ca);
  await goOnline(r, cb);
  return { ca, cb };
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

describe('who may challenge whom', () => {
  it('CHAL-1: every challenge route needs a signed-in player', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const wrong: string[] = [];
    const get = await call(r, '/api/challenges');
    if (get.status !== 401) wrong.push(`GET: ${get.status}`);
    if ((await call(r, '/api/challenges', { cookie: alice })).status !== 200) wrong.push('GET signed in');
    for (const what of ['send', 'accept', 'decline', 'cancel']) {
      const out = await call(r, `/api/challenges/${what}`, { method: 'POST', body: { username: 'alice' } });
      if (out.status !== 401) wrong.push(`POST ${what}: ${out.status}`);
    }
    expect(wrong).toEqual([]);
    expect(db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM challenges')?.n).toBe(0);
  }, LONG);

  it('CHAL-2: only a friend can be challenged: not a stranger, not yourself, not somebody who does not exist, not a request that is still waiting', async () => {
    const r = await boot();
    const [ca, cb, cc] = [await signUp(r, 'alice'), await signUp(r, 'bob'), await signUp(r, 'carol')];
    for (const c of [ca, cb, cc]) await goOnline(r, c);
    const stranger = await challenge(r, ca, 'send', 'bob');
    expect(stranger.status).toBe(403);
    expect(stranger.json.error.code).toBe('not_friends');
    expect((await challenge(r, ca, 'send', 'alice')).status).toBe(400);
    expect((await challenge(r, ca, 'send', 'nobody-here')).status).toBe(404);
    expect((await challenge(r, ca, 'send', '')).status).toBe(404);
    await friendAct(r, ca, 'request', 'bob'); // asked, not yet answered: still not friends
    expect((await challenge(r, ca, 'send', 'bob')).status).toBe(403);
    expect(db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM challenges')?.n).toBe(0);
  }, LONG);

  it('CHAL-3: a computer player and a banned player cannot be challenged', async () => {
    const r = await boot();
    const { ca } = await pair(r);
    db(r).run("INSERT INTO users(username, display_name, pw_hash, role, created_ms) VALUES ('bot-sam', 'Sam (bot)', 'bot', 'player', ?)", r.clock.now());
    db(r).run("INSERT INTO bots(user_id, persona) VALUES ((SELECT id FROM users WHERE username = 'bot-sam'), 'sam')");
    expect((await challenge(r, ca, 'send', 'bot-sam')).status).toBe(404);
    db(r).run("INSERT INTO user_bans(user_id, reason, banned_ms, until_ms, by_user_id) VALUES (?, 'test', ?, NULL, ?)", idOf(r, 'bob'), r.clock.now(), idOf(r, 'alice'));
    expect((await challenge(r, ca, 'send', 'bob')).status).toBe(404);
  }, LONG);

  it('CHAL-4: the friend must have the page open; a friend who is away cannot be challenged', async () => {
    const r = await boot();
    const [ca, cb] = [await signUp(r, 'alice'), await signUp(r, 'bob')];
    await befriend(r, ca, 'alice', cb, 'bob');
    await goOnline(r, ca);
    const away = await challenge(r, ca, 'send', 'bob');
    expect(away.status).toBe(409);
    expect(away.json.error.code).toBe('offline');
    expect(away.json.error.message).toMatch(/bob.*not online/i);
    expect(db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM challenges')?.n).toBe(0);
    await goOnline(r, cb);
    expect((await challenge(r, ca, 'send', 'bob')).status).toBe(200);
  }, LONG);
});

describe('sending, answering, running out', () => {
  it('CHAL-5: a challenge shows on both sides with the time it has left, and sending it again changes nothing', async () => {
    const r = await boot();
    const { ca, cb } = await pair(r);
    const sent = await challenge(r, ca, 'send', 'bob');
    expect(sent.status).toBe(200);
    expect(sent.json.match).toBeNull();
    expect(sent.json.outgoing.map((e: any) => e.username)).toEqual(['bob']);
    expect(sent.json.outgoing[0].msLeft).toBe(CHALLENGE_MS);
    expect(sent.json.incoming).toEqual([]);
    expect(sent.json.limits.validMs).toBe(CHALLENGE_MS);
    r.clock.advanceSeconds(30);
    const mine = await list(r, ca);
    const theirs = await list(r, cb);
    expect(mine.outgoing[0].msLeft).toBe(CHALLENGE_MS - 30_000);
    expect(theirs.incoming.map((e: any) => e.username)).toEqual(['alice']);
    expect(theirs.incoming[0].displayName).toBe('alice');
    expect(theirs.incoming[0].msLeft).toBe(CHALLENGE_MS - 30_000);
    expect(theirs.outgoing).toEqual([]);
    // Again: still one challenge, with its first deadline (asking twice does not extend it).
    const again = await challenge(r, ca, 'send', 'bob');
    expect(again.status).toBe(200);
    expect(again.json.outgoing).toHaveLength(1);
    expect(again.json.outgoing[0].msLeft).toBe(CHALLENGE_MS - 30_000);
    expect(db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM challenges')?.n).toBe(1);
  }, LONG);

  it('CHAL-6: a challenge runs out: after two minutes it is gone from both lists and cannot be accepted', async () => {
    const r = await boot();
    const { ca, cb } = await pair(r);
    await challenge(r, ca, 'send', 'bob');
    r.clock.advanceSeconds(CHALLENGE_MS / 1000 - 1);
    expect((await list(r, cb)).incoming).toHaveLength(1);
    r.clock.advanceSeconds(2);
    expect((await list(r, cb)).incoming).toEqual([]);
    expect((await list(r, ca)).outgoing).toEqual([]);
    const late = await challenge(r, cb, 'accept', 'alice');
    expect(late.status).toBe(404);
    expect(late.json.error.code).toBe('no_challenge');
    expect(await lobby(r, ca)).toBeNull();
    expect(await lobby(r, cb)).toBeNull();
    // And the challenger can ask again at once.
    expect((await challenge(r, ca, 'send', 'bob')).status).toBe(200);
  }, LONG);

  it('CHAL-7: the friend can decline and the challenger can take it back; each answers 404 when there is nothing to answer', async () => {
    const r = await boot();
    const { ca, cb } = await pair(r);
    await challenge(r, ca, 'send', 'bob');
    const declined = await challenge(r, cb, 'decline', 'alice');
    expect(declined.status).toBe(200);
    expect(declined.json.incoming).toEqual([]);
    expect((await list(r, ca)).outgoing).toEqual([]);
    expect((await challenge(r, cb, 'decline', 'alice')).status).toBe(404);
    await challenge(r, ca, 'send', 'bob');
    const back = await challenge(r, ca, 'cancel', 'bob');
    expect(back.status).toBe(200);
    expect(back.json.outgoing).toEqual([]);
    expect((await list(r, cb)).incoming).toEqual([]);
    expect((await challenge(r, ca, 'cancel', 'bob')).status).toBe(404);
    // Only the right person can answer: Bob cannot "cancel" Alice's challenge and Alice cannot accept her own.
    await challenge(r, ca, 'send', 'bob');
    expect((await challenge(r, cb, 'cancel', 'alice')).status).toBe(404);
    expect((await challenge(r, ca, 'accept', 'bob')).status).toBe(404);
    expect((await list(r, ca)).outgoing).toHaveLength(1);
  }, LONG);

  it('CHAL-8: one challenge at a time per player, and no more than ten can wait for one player', async () => {
    const r = await boot();
    const { ca } = await pair(r);
    const cc = await signUp(r, 'carol');
    await befriend(r, ca, 'alice', cc, 'carol');
    await goOnline(r, cc);
    expect((await challenge(r, ca, 'send', 'bob')).status).toBe(200);
    const second = await challenge(r, ca, 'send', 'carol');
    expect(second.status).toBe(409);
    expect(second.json.error.code).toBe('already_challenging');
    expect((await challenge(r, ca, 'cancel', 'bob')).status).toBe(200);
    expect((await challenge(r, ca, 'send', 'carol')).status).toBe(200);
    // Ten players are waiting on carol already: the eleventh is refused.
    const now = r.clock.now();
    for (let i = 0; i < MAX_WAITING_FOR_ONE; i += 1) {
      const id = db(r).run("INSERT INTO users(username, display_name, pw_hash, role, created_ms) VALUES (?, ?, 'x', 'player', ?)", `fan${i}`, `fan${i}`, now).lastInsertRowid;
      const [x, y] = id < idOf(r, 'carol') ? [id, idOf(r, 'carol')] : [idOf(r, 'carol'), id];
      db(r).run("INSERT INTO friendships(user_a, user_b, requester_id, status, created_ms, accepted_ms) VALUES (?, ?, ?, 'accepted', ?, ?)", x, y, id, now, now);
      if (i < MAX_WAITING_FOR_ONE - 1) db(r).run('INSERT INTO challenges(from_id, to_id, created_ms, expires_ms) VALUES (?, ?, ?, ?)', id, idOf(r, 'carol'), now, now + CHALLENGE_MS);
    }
    // alice's challenge + nine fans = ten waiting. A tenth fan is refused.
    const dave = await signUp(r, 'dave');
    await befriend(r, dave, 'dave', cc, 'carol');
    await goOnline(r, dave);
    const full = await challenge(r, dave, 'send', 'carol');
    expect(full.status).toBe(409);
    expect(full.json.error.code).toBe('player_busy');
  }, LONG);

  it('CHAL-9: sending is limited to ten challenges a minute', async () => {
    const r = await boot();
    const { ca } = await pair(r);
    const statuses: number[] = [];
    for (let i = 0; i < SENDS_PER_MINUTE + 1; i += 1) {
      statuses.push((await challenge(r, ca, 'send', 'bob')).status);
      if (i < SENDS_PER_MINUTE) await challenge(r, ca, 'cancel', 'bob');
    }
    expect(statuses.slice(0, SENDS_PER_MINUTE).every((s) => s === 200)).toBe(true);
    expect(statuses[SENDS_PER_MINUTE]).toBe(429);
    r.clock.advanceSeconds(61);
    expect((await challenge(r, ca, 'send', 'bob')).status).toBe(200);
  }, LONG);

  it('CHAL-10: ending the friendship takes the challenge away with it', async () => {
    const r = await boot();
    const { ca, cb } = await pair(r);
    await challenge(r, ca, 'send', 'bob');
    expect((await friendAct(r, cb, 'remove', 'alice')).status).toBe(200);
    expect((await list(r, cb)).incoming).toEqual([]);
    expect((await list(r, ca)).outgoing).toEqual([]);
    expect((await challenge(r, cb, 'accept', 'alice')).status).toBe(404);
    expect(await lobby(r, ca)).toBeNull();
  }, LONG);

  it('CHAL-11: both players are told over their live stream when a challenge arrives, is taken back, declined or accepted', async () => {
    const r = await boot();
    const { ca, cb } = await pair(r);
    const hub = r.app.services.hub as unknown as { publishTo(userId: number, event: string, data: unknown): void };
    const original = hub.publishTo.bind(hub);
    const told: string[] = [];
    hub.publishTo = (userId, event, data) => {
      if (event === 'challenges') told.push(`${userId}`);
      original(userId, event, data);
    };
    const [a, b] = [idOf(r, 'alice'), idOf(r, 'bob')];
    await challenge(r, ca, 'send', 'bob');
    expect(told).toEqual([`${b}`]);
    told.length = 0;
    await challenge(r, ca, 'cancel', 'bob');
    expect(told).toEqual([`${b}`]);
    told.length = 0;
    await challenge(r, ca, 'send', 'bob');
    told.length = 0;
    await challenge(r, cb, 'decline', 'alice');
    expect(told).toEqual([`${a}`]);
    told.length = 0;
    await challenge(r, ca, 'send', 'bob');
    told.length = 0;
    await challenge(r, cb, 'accept', 'alice');
    expect(new Set(told)).toEqual(new Set([`${a}`, `${b}`]));
  }, LONG);
});

describe('the friend match', () => {
  it('CHAL-12: a yes opens a lobby for exactly the two friends: 2/2, a friend match, nobody ready; the challenge is gone', async () => {
    const r = await boot();
    const { ca, cb } = await pair(r);
    await challenge(r, ca, 'send', 'bob');
    const yes = await challenge(r, cb, 'accept', 'alice');
    expect(yes.status).toBe(200);
    expect(yes.json.incoming).toEqual([]);
    const mine = yes.json.match;
    expect(mine.phase).toBe('ready_check');
    expect(mine.friendMatch).toBe(true);
    expect(mine.playerCount).toBe(2);
    expect(mine.players.map((p: any) => p.name).sort()).toEqual(['alice', 'bob']);
    expect(mine.players.every((p: any) => p.ready === false && p.bot === false)).toBe(true);
    expect(mine.message).toMatch(/friend match against alice/i);
    const theirs = await lobby(r, ca);
    expect(theirs.id).toBe(mine.id);
    expect(theirs.phase).toBe('ready_check');
    expect(theirs.friendMatch).toBe(true);
    expect(theirs.message).toMatch(/friend match against bob/i);
    expect(db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM challenges')?.n).toBe(0);
    expect((await list(r, ca)).outgoing).toEqual([]);
  }, LONG);

  it('CHAL-13: asking a friend who already asked you is a yes: the match opens at once', async () => {
    const r = await boot();
    const { ca, cb } = await pair(r);
    await challenge(r, ca, 'send', 'bob');
    const back = await challenge(r, cb, 'send', 'alice');
    expect(back.status).toBe(200);
    expect(back.json.match.phase).toBe('ready_check');
    expect(back.json.match.friendMatch).toBe(true);
    expect((await lobby(r, ca)).id).toBe(back.json.match.id);
    expect(db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM challenges')?.n).toBe(0);
  }, LONG);

  it('CHAL-14: nobody else can join a friend match: a stranger who searches gets a lobby of his own', async () => {
    const r = await boot();
    const { ca, cb } = await pair(r);
    const cc = await signUp(r, 'carol');
    await challenge(r, ca, 'send', 'bob');
    const friendMatch = (await challenge(r, cb, 'accept', 'alice')).json.match;
    const carol = await lobbyPost(r, cc, 'join');
    expect(carol.status).toBe(200);
    expect(carol.json.match.id).not.toBe(friendMatch.id);
    expect(carol.json.match.phase).toBe('waiting');
    expect(carol.json.match.playerCount).toBe(1);
    expect(carol.json.match.friendMatch).toBe(false);
    expect((await lobby(r, ca)).playerCount).toBe(2);
    expect(r.app.services.matches.searching()).toBe(1); // only carol is searching
  }, LONG);

  it('CHAL-15: both press Ready, the usual countdown runs and the match goes live for both on the same tick', async () => {
    const r = await boot();
    const { ca, cb } = await pair(r);
    await challenge(r, ca, 'send', 'bob');
    await challenge(r, cb, 'accept', 'alice');
    const first = await lobbyPost(r, ca, 'ready', { ready: true });
    expect(first.json.match.phase).toBe('ready_check');
    expect(first.json.match.message).toMatch(/waiting for your friend bob/i);
    const second = await lobbyPost(r, cb, 'ready', { ready: true });
    expect(second.json.match.phase).toBe('countdown');
    expect(second.json.match.friendMatch).toBe(true);
    const startTick = second.json.match.startTick as number;
    await gotoTick(r, startTick);
    const [a, b] = [await lobby(r, ca), await lobby(r, cb)];
    expect(a.phase).toBe('live');
    expect(b.phase).toBe('live');
    expect(a.startTick).toBe(b.startTick);
    expect(a.canTrade && b.canTrade).toBe(true);
  }, LONG);

  it('CHAL-16: leaving before the start cancels the match for both; the one who stays sees why, and no stranger takes the place', async () => {
    const r = await boot();
    const { ca, cb } = await pair(r);
    const cc = await signUp(r, 'carol');
    await challenge(r, ca, 'send', 'bob');
    await challenge(r, cb, 'accept', 'alice');
    await lobbyPost(r, cb, 'ready', { ready: true });
    const left = await lobbyPost(r, ca, 'leave');
    expect(left.status).toBe(200);
    expect(left.json.match).toBeNull();
    const stays = await lobby(r, cb);
    expect(stays.phase).toBe('cancelled');
    expect(stays.cancelReason).toBe('friend_left');
    expect(stays.message).toMatch(/friend left/i);
    expect(await lobby(r, ca)).toBeNull();
    // A stranger searching now finds an empty lobby list: nothing waits for him.
    const carol = await lobbyPost(r, cc, 'join');
    expect(carol.json.match.playerCount).toBe(1);
    expect(r.app.services.matches.searching()).toBe(1);
    expect((await lobbyPost(r, cb, 'dismiss')).status).toBe(200);
    expect(await lobby(r, cb)).toBeNull();
    // Both are free to play again.
    expect((await challenge(r, ca, 'send', 'bob')).status).toBe(200);
  }, LONG);

  it('CHAL-17: a friend who stops answering (closes the page) is removed after the usual 15 seconds and the match is cancelled', async () => {
    const r = await boot();
    const { ca, cb } = await pair(r);
    await challenge(r, ca, 'send', 'bob');
    await challenge(r, cb, 'accept', 'alice');
    // Only Bob's page keeps asking about the lobby; Alice has gone.
    r.players.delete(ca);
    await gotoTick(r, r.app.services.world.currentTick() + 20);
    const stays = await lobby(r, cb);
    expect(stays.phase).toBe('cancelled');
    expect(stays.cancelReason).toBe('friend_left');
  }, LONG);

  it('CHAL-18: leaving during the countdown costs nothing and cancels the match too', async () => {
    const r = await boot();
    const { ca, cb } = await pair(r);
    await challenge(r, ca, 'send', 'bob');
    await challenge(r, cb, 'accept', 'alice');
    await lobbyPost(r, ca, 'ready', { ready: true });
    expect((await lobbyPost(r, cb, 'ready', { ready: true })).json.match.phase).toBe('countdown');
    await lobbyPost(r, ca, 'leave');
    expect((await lobby(r, cb)).phase).toBe('cancelled');
    expect(db(r).get<{ n: number }>("SELECT COUNT(*) AS n FROM match_players WHERE user_id = ? AND forfeited = 1", idOf(r, 'alice'))?.n).toBe(0);
  }, LONG);
});

describe('who is free to play', () => {
  it('CHAL-19: a player who waits alone in the random lobby is taken out of it when his friend says yes', async () => {
    const r = await boot();
    const { ca, cb } = await pair(r);
    const alone = (await lobbyPost(r, cb, 'join')).json.match;
    expect(alone.phase).toBe('waiting');
    await challenge(r, ca, 'send', 'bob');
    const yes = await challenge(r, cb, 'accept', 'alice');
    expect(yes.status).toBe(200);
    expect(yes.json.match.id).not.toBe(alone.id);
    expect(yes.json.match.friendMatch).toBe(true);
    expect(db(r).get<{ state: string }>('SELECT state FROM matches WHERE id = ?', alone.id)?.state).toBe('cancelled');
    expect(r.app.services.matches.searching()).toBe(0);
  }, LONG);

  it('CHAL-20: a player in a lobby with a real opponent, a countdown or a live match is busy: he cannot challenge, and a yes is refused', async () => {
    const r = await boot();
    const { ca, cb } = await pair(r);
    const [cc, cd] = [await signUp(r, 'carol'), await signUp(r, 'dave')];
    await befriend(r, ca, 'alice', cc, 'carol');
    await goOnline(r, cc);
    await goOnline(r, cd);
    // Alice and Bob play a friend match and are counting down.
    await challenge(r, ca, 'send', 'bob');
    await challenge(r, cb, 'accept', 'alice');
    await lobbyPost(r, ca, 'ready', { ready: true });
    await lobbyPost(r, cb, 'ready', { ready: true });
    const sendBusy = await challenge(r, ca, 'send', 'carol');
    expect(sendBusy.status).toBe(409);
    expect(sendBusy.json.error.code).toBe('busy');
    // Carol challenges Alice anyway (Alice is the one who is busy); a yes is refused and the challenge stays for later.
    expect((await challenge(r, cc, 'send', 'alice')).status).toBe(200);
    const yes = await challenge(r, ca, 'accept', 'carol');
    expect(yes.status).toBe(409);
    expect(yes.json.error.code).toBe('busy');
    expect((await list(r, cc)).outgoing).toHaveLength(1);
    // The same for a random lobby with two real players in it.
    const [e, f] = [await signUp(r, 'erin'), await signUp(r, 'finn')];
    await goOnline(r, e);
    await lobbyPost(r, cd, 'join');
    expect((await lobbyPost(r, f, 'join')).json.match.phase).toBe('ready_check'); // dave and finn were matched by the random lobby
    await befriend(r, cd, 'dave', e, 'erin');
    expect((await challenge(r, e, 'send', 'dave')).status).toBe(200);
    const refused = await challenge(r, cd, 'accept', 'erin');
    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe('busy');
  }, LONG);

  it('CHAL-21: when a player starts a match, the challenges he had out to other friends are dropped and those friends are told', async () => {
    const r = await boot();
    const { ca, cb } = await pair(r);
    const cc = await signUp(r, 'carol');
    await befriend(r, ca, 'alice', cc, 'carol');
    await goOnline(r, cc);
    await challenge(r, ca, 'send', 'carol');
    await challenge(r, cb, 'send', 'alice'); // bob asks alice: carol's friend alice is about to be busy
    // Alice has one challenge out (to carol) and one in (from bob). Saying yes to bob starts the match and drops her own.
    const told: string[] = [];
    const hub = r.app.services.hub as unknown as { publishTo(userId: number, event: string, data: unknown): void };
    const original = hub.publishTo.bind(hub);
    hub.publishTo = (userId, event, data) => {
      if (event === 'challenges') told.push(`${userId}`);
      original(userId, event, data);
    };
    expect((await challenge(r, ca, 'accept', 'bob')).status).toBe(200);
    expect((await list(r, cc)).incoming).toEqual([]);
    expect(db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM challenges')?.n).toBe(0);
    expect(told).toContain(`${idOf(r, 'carol')}`);
  }, LONG);

  it('CHAL-22: the finished result screen of an old match does not stop a new friend match', async () => {
    const r = await boot();
    const { ca, cb } = await pair(r);
    // A first friend match that gets cancelled leaves a result screen for the one who stayed.
    await challenge(r, ca, 'send', 'bob');
    await challenge(r, cb, 'accept', 'alice');
    await lobbyPost(r, ca, 'leave');
    expect((await lobby(r, cb)).phase).toBe('cancelled');
    // Bob has not closed it, but a new challenge works and replaces it.
    await challenge(r, ca, 'send', 'bob');
    const yes = await challenge(r, cb, 'accept', 'alice');
    expect(yes.status).toBe(200);
    expect(yes.json.match.phase).toBe('ready_check');
    expect((await lobby(r, cb)).phase).toBe('ready_check');
  }, LONG);
});

describe('playing the match', () => {
  it('CHAL-23: a friend match is played and paid like any other: a forfeit loses, the winner is paid, history shows the friend', async () => {
    const r = await boot();
    const { ca, cb } = await pair(r);
    await challenge(r, ca, 'send', 'bob');
    await challenge(r, cb, 'accept', 'alice');
    await lobbyPost(r, ca, 'ready', { ready: true });
    const countdown = (await lobbyPost(r, cb, 'ready', { ready: true })).json.match;
    await gotoTick(r, countdown.startTick);
    expect((await lobby(r, ca)).phase).toBe('live');
    // Alice trades once, then walks away: she forfeits.
    const buy = await call(r, '/api/orders', { method: 'POST', cookie: ca, body: { account: 'match', ticker: 'QLRX', side: 'buy', qty: 1, clientOrderId: 'order-friend-1-abcdef' } });
    expect(buy.status).toBe(201);
    await lobbyPost(r, ca, 'leave');
    await gotoTick(r, countdown.endTick + 2);
    const b = await lobby(r, cb);
    expect(b.phase).toBe('finished');
    expect(b.friendMatch).toBe(true);
    expect(b.outcome).toBe('forfeit');
    const winner = b.players.find((p: any) => p.you);
    expect(winner.result).toBe('win');
    expect(winner.rewardCents).toBeGreaterThanOrEqual(LOSER_REWARD_CENTS);
    const wallet = await call(r, '/api/wallet', { cookie: cb });
    expect(wallet.json.balanceCents).toBe(winner.rewardCents);
    const history = await call(r, '/api/matches', { cookie: cb });
    expect(history.json.matches[0].opponent.name).toBe('alice');
    // Both are free for another challenge afterwards.
    await lobbyPost(r, cb, 'dismiss');
    await lobbyPost(r, ca, 'dismiss');
    expect((await challenge(r, ca, 'send', 'bob')).status).toBe(200);
  }, LONG);

  it('CHAL-24: a yes needs the challenger to still have his page open: if he closed it the match is not opened, the challenge stays, and it works when he is back', async () => {
    const r = await boot();
    const [ca, cb] = [await signUp(r, 'alice'), await signUp(r, 'bob')];
    await befriend(r, ca, 'alice', cb, 'bob');
    const alicePage = await goOnline(r, ca);
    await goOnline(r, cb);
    expect((await challenge(r, ca, 'send', 'bob')).status).toBe(200);
    await goOffline(r, 'alice', alicePage);
    const late = await challenge(r, cb, 'accept', 'alice');
    expect(late.status).toBe(409);
    expect(late.json.error.code).toBe('offline');
    expect(late.json.error.message).toMatch(/alice.*not online/i);
    expect(await lobby(r, cb)).toBeNull();
    expect(db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM matches')?.n).toBe(0);
    expect((await list(r, cb)).incoming.map((e: any) => e.username)).toEqual(['alice']);
    await goOnline(r, ca);
    const yes = await challenge(r, cb, 'accept', 'alice');
    expect(yes.status).toBe(200);
    expect(yes.json.match.friendMatch).toBe(true);
  }, LONG);
});
