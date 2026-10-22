// More owner tools over HTTP: banning (and unbanning) players, pausing ALL trading, the announcement banner, giving or taking shares,
// resetting a Career account, and the database upgrade that adds them. The rules checked here: only the owner may use any of it;
// every action is idempotent and logged once; a ban takes effect on the very next request and survives a restart; gifts of shares
// never look like trading profit; and a reset leaves a truly clean account without ever deleting a trade (the ids feed price pushes).
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../server/app';
import { loadConfig } from '../server/config';
import { Logger } from '../server/log';
import { MIGRATIONS, migrate } from '../server/schema';
import { Db } from '../server/sqlite';
import { Clock } from './helpers/server';

const LONG = 240_000;

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

async function boot(options: { dir?: string; clock?: Clock; flow?: number } = {}): Promise<Running> {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'tq-owner-'));
  if (!options.dir) dirs.push(dir);
  const clock = options.clock ?? new Clock();
  const config = loadConfig({ TQ_DATA_DIR: dir, TQ_COMPANIES: '12', TQ_WARMUP_DAYS: '1', TQ_PORT: '8787', TQ_OWNER: 'boss' });
  const app = createApp({ config, log: new Logger({ sink: null, now: clock.now }), worldSeed: 777, now: clock.now, flowGain: options.flow ?? 0 });
  const server = createServer(app.handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const r = { app, server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, dir, clock, players: new Set<string>() };
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
  for (let i = 0; i < 200_000 && w.sim.tick < w.currentTick(); i += 1) w.pump();
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
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] as string;
  r.players.add(cookie);
  return cookie;
}

const login = (r: Running, username: string, password = 'a-good-password') => call(r, '/api/auth/login', { method: 'POST', body: { username, password } });

let counter = 0;
const rid = (): string => `req-${(counter += 1).toString().padStart(8, '0')}`;
const post = (r: Running, path: string, cookie: string | undefined, body: Record<string, unknown>) => call(r, path, { method: 'POST', cookie, body: { requestId: rid(), ...body } });

let orderNo = 0;
const trade = (r: Running, cookie: string, body: Record<string, unknown> = {}) =>
  call(r, '/api/orders', { method: 'POST', cookie, body: { account: 'career', ticker: 'QLRX', side: 'buy', qty: 2, clientOrderId: `order-${(orderNo += 1)}-abcdef`, ...body } });

const account = async (r: Running, cookie: string) => (await call(r, '/api/account', { cookie })).json;
const logOf = (r: Running, action: string) => r.app.services.db.all<{ target: string; detail_json: string }>('SELECT target, detail_json FROM admin_log WHERE action = ? ORDER BY id', action);

/** Reads a server-sent-events stream just enough to see which events arrive. */
async function openStream(r: Running, cookie?: string) {
  const ctrl = new AbortController();
  const res = await fetch(r.base + '/api/stream', { headers: cookie ? { Cookie: cookie } : {}, signal: ctrl.signal });
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const dec = new TextDecoder();
  let text = '';
  return {
    /** Reads until `needle` has appeared (or the stream ends / times out). Returns the text so far and whether the stream ended. */
    async until(needle: string, ms = 5000): Promise<{ text: string; ended: boolean }> {
      const stop = Date.now() + ms;
      while (!text.includes(needle) && Date.now() < stop) {
        const next = await Promise.race([reader.read(), new Promise<{ done: true; value: undefined }>((resolve) => setTimeout(() => resolve({ done: true, value: undefined }), Math.max(50, stop - Date.now())))]);
        if (next.value) text += dec.decode(next.value);
        if (next.done) return { text, ended: true };
      }
      return { text, ended: false };
    },
    close: () => ctrl.abort(),
  };
}

// ---- bans -----------------------------------------------------------------------------------------------------------------

describe('banning players', () => {
  it('OWN-1: only the owner can ban; a banned player cannot sign in (and is told why); his old session stops working at once; unban brings it back', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const boss = await signUp(r, 'boss');
    expect((await post(r, '/api/admin/ban', undefined, { username: 'alice' })).status).toBe(401);
    expect((await post(r, '/api/admin/ban', alice, { username: 'alice' })).status).toBe(403);
    expect((await account(r, alice)).cashCents).toBe(100_000);

    const banned = await post(r, '/api/admin/ban', boss, { username: 'alice', reason: 'spamming the chat' });
    expect(banned.status).toBe(200);
    expect(banned.json).toMatchObject({ ok: true, duplicate: false, username: 'alice', untilMs: null });

    // The cookie he still holds is worth nothing now, on every route.
    expect((await call(r, '/api/account', { cookie: alice })).status).toBe(401);
    expect((await trade(r, alice)).status).toBe(401);
    expect((await call(r, '/api/lobby', { cookie: alice })).status).toBe(401);
    const me = await call(r, '/api/me', { cookie: alice });
    expect(me.json).toEqual({ user: null, banned: { reason: 'spamming the chat', untilMs: null } });
    // A guest sees no ban; the owner is unaffected.
    expect((await call(r, '/api/me')).json).toEqual({ user: null });
    expect((await call(r, '/api/me', { cookie: boss })).json.user.username).toBe('boss');

    // He cannot sign in again, and is told why — but only if he knows the password.
    const again = await login(r, 'alice');
    expect(again.status).toBe(403);
    expect(again.json.error.code).toBe('banned');
    expect(again.json.error.message).toMatch(/banned/i);
    expect(again.json.error.message).toContain('spamming the chat');
    expect((await login(r, 'alice', 'wrong-password-1')).json.error.code).toBe('bad_login');

    // The owner sees it, and the player's money was not touched.
    const state = (await call(r, '/api/admin/state', { cookie: boss })).json;
    const row = state.players.find((p: any) => p.username === 'alice');
    expect(row.banned).toMatchObject({ reason: 'spamming the chat', untilMs: null });
    expect(row.cashCents).toBe(100_000);
    expect(state.players.find((p: any) => p.username === 'boss').banned).toBeNull();

    // Unban: the old session works again, and he can sign in.
    expect((await post(r, '/api/admin/unban', boss, { username: 'alice' })).status).toBe(200);
    expect((await call(r, '/api/account', { cookie: alice })).status).toBe(200);
    expect((await login(r, 'alice')).status).toBe(200);
    expect((await call(r, '/api/me', { cookie: alice })).json.user.username).toBe('alice');
    const second = await post(r, '/api/admin/unban', boss, { username: 'alice' });
    expect(second.status).toBe(400);
    expect(second.json.error.code).toBe('not_banned');

    // Both actions are in the log once each.
    expect(logOf(r, 'ban')).toHaveLength(1);
    expect(logOf(r, 'unban')).toHaveLength(1);
    expect(JSON.parse(logOf(r, 'ban')[0]?.detail_json ?? '{}')).toMatchObject({ reason: 'spamming the chat', hours: null });
  }, LONG);

  it('OWN-2: the owner cannot be banned; bad input is refused; the same request id never bans twice', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const boss = await signUp(r, 'boss');
    void alice;
    const self = await post(r, '/api/admin/ban', boss, { username: 'boss' });
    expect(self.status).toBe(400);
    expect(self.json.error.code).toBe('cannot_ban_owner');
    expect((await call(r, '/api/account', { cookie: boss })).status).toBe(200);
    expect((await post(r, '/api/admin/ban', boss, { username: 'nobody' })).status).toBe(404);
    for (const hours of [0, -3, 1.5, 'x', 24 * 365 + 1]) {
      expect((await post(r, '/api/admin/ban', boss, { username: 'alice', hours })).status).toBe(400);
    }
    expect((await post(r, '/api/admin/ban', boss, { username: 'alice', reason: 'x'.repeat(121) })).status).toBe(400);
    expect((await post(r, '/api/admin/ban', boss, { username: 'alice', requestId: 'short' })).status).toBe(400);
    expect(logOf(r, 'ban')).toHaveLength(0);

    const id = 'same-request-0001';
    const first = await call(r, '/api/admin/ban', { method: 'POST', cookie: boss, body: { requestId: id, username: 'alice', reason: 'first' } });
    const twice = await call(r, '/api/admin/ban', { method: 'POST', cookie: boss, body: { requestId: id, username: 'alice', reason: 'first' } });
    expect(first.json.duplicate).toBe(false);
    expect(twice.status).toBe(200);
    expect(twice.json.duplicate).toBe(true);
    expect(logOf(r, 'ban')).toHaveLength(1);
    const other = await call(r, '/api/admin/ban', { method: 'POST', cookie: boss, body: { requestId: id, username: 'boss' } });
    expect(other.status).toBe(400); // still the owner check first; nothing changed
    await signUp(r, 'carol');
    const reused = await call(r, '/api/admin/ban', { method: 'POST', cookie: boss, body: { requestId: id, username: 'carol' } });
    expect(reused.status).toBe(409);
    expect(reused.json.error.code).toBe('request_id_reused');
  }, LONG);

  it('OWN-3: a timed ban ends by itself', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const boss = await signUp(r, 'boss');
    const b = await post(r, '/api/admin/ban', boss, { username: 'alice', reason: 'cool off', hours: 2 });
    expect(b.json.untilMs).toBe(r.clock.ms + 2 * 3_600_000);
    expect((await login(r, 'alice')).status).toBe(403);
    expect((await login(r, 'alice')).json.error.message).toMatch(/until \d{4}-\d\d-\d\d \d\d:\d\d UTC/);
    advance(r, 3600);
    expect((await call(r, '/api/account', { cookie: alice })).status).toBe(401);
    advance(r, 3601);
    expect((await call(r, '/api/account', { cookie: alice })).status).toBe(200);
    expect((await login(r, 'alice')).status).toBe(200);
    const meAfter = (await call(r, '/api/me', { cookie: alice })).json;
    expect(meAfter.user.username).toBe('alice');
    expect(meAfter.banned).toBeUndefined();
    const state = (await call(r, '/api/admin/state', { cookie: boss })).json;
    expect(state.players.find((p: any) => p.username === 'alice').banned).toBeNull();
  }, LONG);

  it('OWN-4: a ban survives a restart of the server', async () => {
    let r = await boot();
    await signUp(r, 'alice');
    const boss = await signUp(r, 'boss');
    await post(r, '/api/admin/ban', boss, { username: 'alice', reason: 'for good' });
    r = await restart(r);
    const login2 = await login(r, 'alice');
    expect(login2.status).toBe(403);
    expect(login2.json.error.message).toContain('for good');
    const boss2 = (await login(r, 'boss')).status;
    expect(boss2).toBe(200);
  }, LONG);

  it('OWN-5: a ban closes the player\'s open streams, takes him out of a waiting lobby, and forfeits a live match', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const bob = await signUp(r, 'bob');
    const boss = await signUp(r, 'boss');

    // streams
    const stream = await openStream(r, alice);
    expect((await stream.until('event: hello')).text).toContain('event: hello');
    // waiting lobby
    await call(r, '/api/lobby/join', { method: 'POST', cookie: alice });
    expect(r.app.services.db.all('SELECT * FROM match_players WHERE active = 1')).toHaveLength(1);
    await post(r, '/api/admin/ban', boss, { username: 'alice' });
    expect((await stream.until('never-appears', 3000)).ended).toBe(true);
    stream.close();
    expect(r.app.services.db.all('SELECT * FROM match_players WHERE active = 1')).toHaveLength(0);
    await post(r, '/api/admin/unban', boss, { username: 'alice' });

    // live match: alice and bob play, alice is banned halfway through
    const w = r.app.services.world;
    const goto = async (tick: number) => {
      while (w.currentTick() < tick) {
        const next = Math.min(tick, w.currentTick() + 5);
        r.clock.ms = w.msOfTick(next);
        for (let i = 0; i < 20_000 && w.sim.tick < w.currentTick(); i += 1) w.pump();
        for (const cookie of [alice, bob]) await call(r, '/api/lobby', { cookie });
      }
    };
    await call(r, '/api/lobby/join', { method: 'POST', cookie: alice });
    await call(r, '/api/lobby/join', { method: 'POST', cookie: bob });
    await call(r, '/api/lobby/ready', { method: 'POST', cookie: alice, body: { ready: true } });
    const ready = await call(r, '/api/lobby/ready', { method: 'POST', cookie: bob, body: { ready: true } });
    const view = ready.json.match;
    await goto(view.startTick + 20);
    expect((await call(r, '/api/lobby', { cookie: bob })).json.match.phase).toBe('live');
    expect((await post(r, '/api/admin/ban', boss, { username: 'alice', reason: 'cheating' })).status).toBe(200);
    expect((await trade(r, alice, { account: 'match' })).status).toBe(401);
    expect((await trade(r, bob, { account: 'match' })).status).toBe(201);
    await goto(view.endTick + 12);
    const done = await call(r, '/api/lobby', { cookie: bob });
    expect(done.json.match.outcome).toBe('forfeit');
    expect(done.json.match.players.find((p: any) => p.name === 'alice')).toMatchObject({ result: 'forfeit', rewardCents: 0 });
    expect(done.json.match.players.find((p: any) => p.name === 'bob').result).toBe('win');
  }, LONG);
});

// ---- pausing everything ---------------------------------------------------------------------------------------------------

describe('pausing all trading', () => {
  it('OWN-6: while paused every order is refused with the reason, every company shows as halted, and reopening restores trading', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const boss = await signUp(r, 'boss');
    expect((await trade(r, alice)).status).toBe(201);
    expect((await post(r, '/api/admin/pause', alice, { paused: true })).status).toBe(403);
    expect((await post(r, '/api/admin/pause', boss, { paused: 'yes' })).status).toBe(400);

    const p = await post(r, '/api/admin/pause', boss, { paused: true, reason: 'maintenance' });
    expect(p.status).toBe(200);
    const refused = await trade(r, alice);
    expect(refused.status).toBe(403);
    expect(refused.json.error.code).toBe('halted');
    expect(refused.json.error.message).toMatch(/whole market/);
    expect(refused.json.error.message).toContain('maintenance');
    expect((await trade(r, alice, { side: 'sell', qty: 1 })).status).toBe(403);
    expect((await call(r, '/api/market/QLRX/estimate?side=buy&qty=1&account=career', { cookie: alice })).status).toBe(403);
    const market = (await call(r, '/api/market')).json;
    const listed = market.companies.filter((c: any) => c.trading);
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.every((c: any) => c.halted)).toBe(true);
    expect((await call(r, '/api/health')).json.paused).toMatchObject({ reason: 'maintenance' });
    const state = (await call(r, '/api/admin/state', { cookie: boss })).json;
    expect(state.paused).toMatchObject({ reason: 'maintenance' });
    expect(state.halts).toEqual([]); // no single company was halted
    expect(logOf(r, 'pause')).toHaveLength(1);

    // Prices keep moving while trading is paused.
    const before = r.app.services.world.sim.tick;
    advance(r, 30);
    expect(r.app.services.world.sim.tick).toBe(before + 30);

    const idem = 'pause-again-0001';
    expect((await call(r, '/api/admin/pause', { method: 'POST', cookie: boss, body: { requestId: idem, paused: false } })).json.duplicate).toBe(false);
    expect((await call(r, '/api/admin/pause', { method: 'POST', cookie: boss, body: { requestId: idem, paused: false } })).json.duplicate).toBe(true);
    expect((await call(r, '/api/health')).json.paused).toBeNull();
    expect((await trade(r, alice)).status).toBe(201);
    expect((await call(r, '/api/market')).json.companies.some((c: any) => c.halted)).toBe(false);
    expect(logOf(r, 'unpause')).toHaveLength(1);
  }, LONG);

  it('OWN-7: a single company halt still works on its own, and the pause switch does not undo or hide it', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const boss = await signUp(r, 'boss');
    await post(r, '/api/admin/halt', boss, { ticker: 'QLRX', halted: true, reason: 'under review' });
    expect((await trade(r, alice)).json.error.message).toMatch(/QLRX is halted: under review/);
    await post(r, '/api/admin/pause', boss, { paused: true, reason: 'everything off' });
    expect((await trade(r, alice)).json.error.message).toMatch(/QLRX is halted: under review/); // the company's own halt is named first
    const other = r.app.services.world.companies.find((c) => c.ticker !== 'QLRX' && r.app.services.world.sim.isListed(c.id));
    expect((await trade(r, alice, { ticker: other?.ticker })).json.error.message).toMatch(/whole market: everything off/);
    await post(r, '/api/admin/pause', boss, { paused: false });
    expect((await trade(r, alice, { ticker: other?.ticker })).status).toBe(201);
    expect((await trade(r, alice)).status).toBe(403); // QLRX is still halted by itself
    const state = (await call(r, '/api/admin/state', { cookie: boss })).json;
    expect(state.halts.map((h: any) => h.ticker)).toEqual(['QLRX']);
  }, LONG);

  it('OWN-8: the pause survives a restart', async () => {
    let r = await boot();
    const alice = await signUp(r, 'alice');
    const boss = await signUp(r, 'boss');
    void boss;
    await post(r, '/api/admin/pause', boss, { paused: true, reason: 'rebooting' });
    r = await restart(r);
    const again = (await login(r, 'alice')).status;
    expect(again).toBe(200);
    const cookie = (await fetch(r.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'alice', password: 'a-good-password' }) })).headers.get('set-cookie')?.split(';')[0] as string;
    void alice;
    const refused = await trade(r, cookie);
    expect(refused.status).toBe(403);
    expect(refused.json.error.message).toContain('rebooting');
    expect((await call(r, '/api/health')).json.paused).toMatchObject({ reason: 'rebooting' });
  }, LONG);
});

// ---- announcement ---------------------------------------------------------------------------------------------------------

describe('the announcement banner', () => {
  it('OWN-9: the owner posts and takes down a message that every visitor sees, and it is pushed to open pages', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const boss = await signUp(r, 'boss');
    expect((await call(r, '/api/health')).json.announcement).toBeNull();
    expect((await post(r, '/api/admin/announce', alice, { text: 'hello' })).status).toBe(403);
    expect((await post(r, '/api/admin/announce', undefined, { text: 'hello' })).status).toBe(401);
    expect((await post(r, '/api/admin/announce', boss, { text: 'x'.repeat(201) })).status).toBe(400);
    expect((await post(r, '/api/admin/announce', boss, { text: 42 })).status).toBe(400);

    const stream = await openStream(r);
    await stream.until('event: hello');
    const posted = await post(r, '/api/admin/announce', boss, { text: '  Maintenance\n at   8pm\t tonight ' });
    expect(posted.status).toBe(200);
    expect(posted.json.announcement.text).toBe('Maintenance at 8pm tonight');
    const pushed = await stream.until('event: notice');
    expect(pushed.text).toContain('Maintenance at 8pm tonight');
    const health = (await call(r, '/api/health')).json;
    expect(health.announcement.text).toBe('Maintenance at 8pm tonight');
    expect((await call(r, '/api/admin/state', { cookie: boss })).json.announcement.text).toBe('Maintenance at 8pm tonight');

    const cleared = await post(r, '/api/admin/announce', boss, { text: '' });
    expect(cleared.json.announcement).toBeNull();
    expect((await call(r, '/api/health')).json.announcement).toBeNull();
    stream.close();
    expect(logOf(r, 'announce')).toHaveLength(2);
  }, LONG);

  it('OWN-10: the announcement survives a restart and a repeated request id is applied once', async () => {
    let r = await boot();
    await signUp(r, 'alice');
    const boss = await signUp(r, 'boss');
    const id = 'announce-same-01';
    const a = await call(r, '/api/admin/announce', { method: 'POST', cookie: boss, body: { requestId: id, text: 'First' } });
    const b = await call(r, '/api/admin/announce', { method: 'POST', cookie: boss, body: { requestId: id, text: 'First' } });
    expect([a.json.duplicate, b.json.duplicate]).toEqual([false, true]);
    expect(logOf(r, 'announce')).toHaveLength(1);
    r = await restart(r);
    expect((await call(r, '/api/health')).json.announcement.text).toBe('First');
  }, LONG);
});

// ---- shares ---------------------------------------------------------------------------------------------------------------

describe('giving and taking shares', () => {
  it('OWN-11: a gift of shares shows in the account, never as profit, can be sold, and taking shares back is just as neutral', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const boss = await signUp(r, 'boss');
    expect((await post(r, '/api/admin/shares', alice, { username: 'alice', ticker: 'QLRX', qty: 5 })).status).toBe(403);
    const given = await post(r, '/api/admin/shares', boss, { username: 'alice', ticker: 'QLRX', qty: 10, note: 'welcome gift' });
    expect(given.status).toBe(200);
    expect(given.json).toMatchObject({ ok: true, username: 'alice', ticker: 'QLRX', shares: 10 });
    let acc = await account(r, alice);
    expect(acc.positions).toHaveLength(1);
    expect(acc.positions[0]).toMatchObject({ ticker: 'QLRX', shares: 10, unrealizedCents: 0 });
    expect(acc.cashCents).toBe(100_000);
    expect(acc.profitCents).toBe(0);
    expect(acc.startCashCents).toBe(100_000 + acc.positions[0].valueCents);

    const taken = await post(r, '/api/admin/shares', boss, { username: 'alice', ticker: 'QLRX', qty: -4 });
    expect(taken.json.shares).toBe(6);
    acc = await account(r, alice);
    expect(acc.positions[0]).toMatchObject({ shares: 6, unrealizedCents: 0 });
    expect(acc.profitCents).toBe(0);

    const tooMany = await post(r, '/api/admin/shares', boss, { username: 'alice', ticker: 'QLRX', qty: -7 });
    expect(tooMany.status).toBe(400);
    expect(tooMany.json.error.code).toBe('not_enough');
    expect((await account(r, alice)).positions[0].shares).toBe(6);

    // The gift is a real holding: alice can sell it all, and the position disappears.
    const sold = await trade(r, alice, { side: 'sell', qty: 6 });
    expect(sold.status).toBe(201);
    expect((await account(r, alice)).positions).toEqual([]);
    expect((await account(r, alice)).cashCents).toBeGreaterThan(100_000);

    // Taking all that is left removes the position; giving to a player without a position creates one.
    await post(r, '/api/admin/shares', boss, { username: 'alice', ticker: 'QLRX', qty: 3 });
    const gone = await post(r, '/api/admin/shares', boss, { username: 'alice', ticker: 'QLRX', qty: -3 });
    expect(gone.json.shares).toBe(0);
    expect((await account(r, alice)).positions).toEqual([]);

    const entries = logOf(r, 'shares');
    expect(entries).toHaveLength(4);
    expect(JSON.parse(entries[0]?.detail_json ?? '{}')).toMatchObject({ ticker: 'QLRX', qty: 10, sharesBefore: 0, sharesAfter: 10, note: 'welcome gift' });
  }, LONG);

  it('OWN-12: bad share requests change nothing', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const boss = await signUp(r, 'boss');
    const bad = async (body: Record<string, unknown>, status: number) => expect((await post(r, '/api/admin/shares', boss, body)).status).toBe(status);
    await bad({ username: 'alice', ticker: 'QLRX', qty: 0 }, 400);
    await bad({ username: 'alice', ticker: 'QLRX', qty: 1.5 }, 400);
    await bad({ username: 'alice', ticker: 'QLRX', qty: '5' }, 400);
    await bad({ username: 'alice', ticker: 'QLRX', qty: 1_000_001 }, 400);
    await bad({ username: 'alice', ticker: 'QLRX', qty: -1 }, 400); // holds none
    await bad({ username: 'nobody', ticker: 'QLRX', qty: 1 }, 404);
    await bad({ username: 'alice', ticker: 'NOPE', qty: 1 }, 404);
    const w = r.app.services.world;
    const unlisted = w.companies.find((c) => !w.sim.isListed(c.id));
    if (unlisted) await bad({ username: 'alice', ticker: unlisted.ticker, qty: 1 }, 400);
    expect((await account(r, alice)).positions).toEqual([]);
    expect(logOf(r, 'shares')).toHaveLength(0);
    // Repeating a request id gives once.
    const id = 'shares-same-0001';
    const a = await call(r, '/api/admin/shares', { method: 'POST', cookie: boss, body: { requestId: id, username: 'alice', ticker: 'QLRX', qty: 2 } });
    const b = await call(r, '/api/admin/shares', { method: 'POST', cookie: boss, body: { requestId: id, username: 'alice', ticker: 'QLRX', qty: 2 } });
    expect([a.json.duplicate, b.json.duplicate]).toEqual([false, true]);
    expect((await account(r, alice)).positions[0].shares).toBe(2);
  }, LONG);
});

// ---- reset ----------------------------------------------------------------------------------------------------------------

describe('resetting a Career account', () => {
  it('OWN-13: a reset gives $1,000, no shares, no history and no old profit; coins stay; the player can trade again, with price pushes on', async () => {
    const r = await boot({ flow: 5 });
    const alice = await signUp(r, 'alice');
    const bob = await signUp(r, 'bob');
    const boss = await signUp(r, 'boss');
    await trade(r, alice, { qty: 8 });
    await trade(r, alice, { qty: 3, side: 'sell' });
    await trade(r, bob, { qty: 4 });
    await post(r, '/api/admin/cash', boss, { username: 'alice', amountCents: 50_000 });
    await post(r, '/api/admin/coins', boss, { username: 'alice', amountCents: 7_000 });
    const before = await account(r, alice);
    expect(before.positions.length).toBeGreaterThan(0);
    expect((await call(r, '/api/account/trades', { cookie: alice })).json.trades).toHaveLength(2);
    const tradesInDb = r.app.services.db.all<{ n: number }>('SELECT count(*) AS n FROM trades')[0]?.n as number;
    const pushesBefore = r.app.services.db.all<{ n: number }>('SELECT count(*) AS n FROM flow_events')[0]?.n as number;

    expect((await post(r, '/api/admin/reset', alice, { username: 'alice' })).status).toBe(403);
    const done = await post(r, '/api/admin/reset', boss, { username: 'alice', note: 'start over' });
    expect(done.status).toBe(200);
    expect(done.json.cashCents).toBe(100_000);

    const after = await account(r, alice);
    expect(after).toMatchObject({ cashCents: 100_000, startCashCents: 100_000, positions: [], profitCents: 0, realizedCents: 0, netWorthCents: 100_000 });
    expect((await call(r, '/api/account/trades', { cookie: alice })).json.trades).toEqual([]);
    expect((await call(r, '/api/wallet', { cookie: alice })).json.balanceCents).toBe(7_000);
    // Nothing was deleted: the trades (and their stored price pushes) are all still in the database; other players are untouched.
    expect(r.app.services.db.all<{ n: number }>('SELECT count(*) AS n FROM trades')[0]?.n).toBe(tradesInDb);
    expect((await account(r, bob)).positions).toHaveLength(1);
    const entry = JSON.parse(logOf(r, 'reset')[0]?.detail_json ?? '{}');
    expect(entry).toMatchObject({ cashBeforeCents: before.cashCents, netWorthBeforeCents: before.netWorthCents, positions: before.positions.length, note: 'start over' });

    // The player starts again: new trades work (and push prices), and only they show.
    const again = await trade(r, alice, { qty: 5 });
    expect(again.status).toBe(201);
    const trades = (await call(r, '/api/account/trades', { cookie: alice })).json.trades;
    expect(trades).toHaveLength(1);
    expect(trades[0].id).toBe(again.json.trade.id);
    expect(r.app.services.db.all<{ n: number }>('SELECT count(*) AS n FROM flow_events')[0]?.n as number).toBeGreaterThan(pushesBefore);
    const acc = await account(r, alice);
    expect(acc.positions[0].shares).toBe(5);
    expect(acc.realizedCents).toBe(0);
    // A second reset gives the same clean account.
    await post(r, '/api/admin/reset', boss, { username: 'alice' });
    expect(await account(r, alice)).toMatchObject({ cashCents: 100_000, positions: [], realizedCents: 0 });
    expect((await call(r, '/api/account/trades', { cookie: alice })).json.trades).toEqual([]);
  }, LONG);

  it('OWN-14: an unknown player is refused and a repeated request id resets once', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const boss = await signUp(r, 'boss');
    expect((await post(r, '/api/admin/reset', boss, { username: 'nobody' })).status).toBe(404);
    await trade(r, alice, { qty: 3 });
    const id = 'reset-same-0001';
    const a = await call(r, '/api/admin/reset', { method: 'POST', cookie: boss, body: { requestId: id, username: 'alice' } });
    await trade(r, alice, { qty: 2 });
    const b = await call(r, '/api/admin/reset', { method: 'POST', cookie: boss, body: { requestId: id, username: 'alice' } });
    expect([a.json.duplicate, b.json.duplicate]).toEqual([false, true]);
    expect((await account(r, alice)).positions[0].shares).toBe(2); // the repeat did not wipe the new trade
    expect(logOf(r, 'reset')).toHaveLength(1);
  }, LONG);
});

// ---- the database upgrade -------------------------------------------------------------------------------------------------

describe('the database upgrade to schema 7', () => {
  it('OWN-15: keeps the admin log and accounts, adds bans, and the log accepts the new kinds of action', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tq-owner-mig-'));
    dirs.push(dir);
    const db = new Db(join(dir, 'old.sqlite'));
    try {
      for (const m of MIGRATIONS.filter((x) => x.version <= 6)) {
        db.exec(m.sql);
        db.exec(`PRAGMA user_version = ${m.version}`);
      }
      db.run("INSERT INTO users(id, username, display_name, pw_hash, role, created_ms) VALUES (1, 'boss', 'boss', 'x', 'owner', 1)");
      db.run("INSERT INTO users(id, username, display_name, pw_hash, role, created_ms) VALUES (2, 'alice', 'alice', 'x', 'player', 1)");
      db.run("INSERT INTO accounts(user_id, kind, match_id, cash_cents, start_cash_cents, created_ms) VALUES (2, 'career', NULL, 123400, 100000, 1)");
      db.run("INSERT INTO admin_log(request_id, created_ms, admin_user_id, action, target, detail_json) VALUES ('old-request-01', 5, 1, 'flow', 'price impact', '{}')");
      expect(migrate(db)).toEqual([7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]); // versions 8 to 18 (companies made by the owner, automatic pauses, leverage, memecoins with shorts and stops, the memecoin fee, launches, 1v1 bots, margin costs and limit orders, free coin launches, money pools) follow at once
      expect(db.all('SELECT request_id, action FROM admin_log')).toEqual([{ request_id: 'old-request-01', action: 'flow' }]);
      expect(db.all('SELECT cash_cents, start_cash_cents, reset_trade_id FROM accounts')).toEqual([{ cash_cents: 123400, start_cash_cents: 100000, reset_trade_id: 0 }]);
      for (const [i, action] of ['ban', 'unban', 'shares', 'reset', 'announce', 'pause', 'unpause'].entries()) {
        db.run("INSERT INTO admin_log(request_id, created_ms, admin_user_id, action, target, detail_json) VALUES (?, 6, 1, ?, 'x', '{}')", `new-request-0${i}`, action);
      }
      expect(db.all('SELECT count(*) AS n FROM admin_log')).toEqual([{ n: 8 }]);
      expect(() => db.run("INSERT INTO admin_log(request_id, created_ms, admin_user_id, action, target, detail_json) VALUES ('new-request-99', 6, 1, '', 'x', '{}')")).toThrow();
      db.run("INSERT INTO user_bans(user_id, reason, banned_ms, until_ms, by_user_id) VALUES (2, 'test', 1, NULL, 1)");
      expect(db.all('SELECT user_id, reason, until_ms FROM user_bans')).toEqual([{ user_id: 2, reason: 'test', until_ms: null }]);
      expect(migrate(db)).toEqual([]);
    } finally {
      db.close();
    }
  });
});
