// Moderators (server/admin.ts, server/chat.ts, docs/world.md §21). The owner chooses them. A moderator can ban for up to 7 days, kick for a short
// while, lift what a moderator did, mute and delete in the public chat and take away a picture, but only for ordinary players: never for the owner,
// for another moderator or for himself, and never what the owner decided. Everything else of the admin panel stays the owner's. Every action is logged.
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KICK_MINUTES, MAX_MODERATORS, MOD_BANS_PER_HOUR, MOD_MAX_BAN_HOURS } from '../server/admin';
import { createApp, type App } from '../server/app';
import { MOD_MAX_MUTE_MINUTES, NEW_ACCOUNT_WAIT_MS } from '../server/chat';
import { loadConfig } from '../server/config';
import { Logger } from '../server/log';
import { MIGRATIONS, migrate } from '../server/schema';
import { Db } from '../server/sqlite';
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
  const dir = mkdtempSync(join(tmpdir(), 'tq-mod-'));
  dirs.push(dir);
  const clock = new Clock();
  const config = loadConfig({ TQ_DATA_DIR: dir, TQ_COMPANIES: '12', TQ_WARMUP_DAYS: '1', TQ_PORT: '8787', TQ_OWNER: 'boss' });
  const app = createApp({ config, log: new Logger({ sink: null, now: clock.now }), worldSeed: 777, now: clock.now, flowGain: 0 });
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
  return { status: res.status, json };
}

async function signUp(r: Running, name: string): Promise<string> {
  const res = await fetch(r.base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: name, password: PASSWORD }) });
  expect(res.status).toBe(201);
  return (res.headers.get('set-cookie') ?? '').split(';')[0] as string;
}

async function login(r: Running, name: string) {
  const res = await fetch(r.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: name, password: PASSWORD }) });
  return { status: res.status, json: (await res.json()) as any };
}

async function listen(r: Running, cookie?: string): Promise<{ text(): string }> {
  const controller = new AbortController();
  streams.push(controller);
  const res = await fetch(r.base + '/api/stream', { headers: cookie ? { Cookie: cookie } : {}, signal: controller.signal });
  expect(res.status).toBe(200);
  let text = '';
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        text += decoder.decode(value);
      }
    } catch {
      // aborted by the test
    }
  })();
  return { text: () => text };
}
const until = async (check: () => boolean, ms = 3000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((done) => setTimeout(done, 20));
  }
  return check();
};

const db = (r: Running) => r.app.services.db;
const idOf = (r: Running, name: string): number => (db(r).get<{ id: number }>('SELECT id FROM users WHERE username = ?', name) as { id: number }).id;
let nextRequest = 0;
const rid = (): string => `mod-test-${(nextRequest += 1)}-abcdef`;
const post = (r: Running, cookie: string, path: string, body: Record<string, unknown> = {}) => call(r, path, { method: 'POST', cookie, body: { requestId: rid(), ...body } });
const meRole = async (r: Running, cookie: string): Promise<string | undefined> => (await call(r, '/api/me', { cookie })).json.user?.role;
const log = (r: Running): { action: string; target: string; admin: string }[] =>
  db(r).all<{ action: string; target: string; admin: string }>('SELECT l.action, l.target, u.username AS admin FROM admin_log l JOIN users u ON u.id = l.admin_user_id ORDER BY l.id');
/** Players the rules did not meet (no password): for tests that need many of them. */
function bulk(r: Running, prefix: string, count: number): string[] {
  const names: string[] = [];
  for (let i = 0; i < count; i += 1) {
    db(r).run("INSERT INTO users(username, display_name, pw_hash, role, created_ms) VALUES (?, ?, 'x', 'player', ?)", `${prefix}${i}`, `${prefix}${i}`, r.clock.now() - 10 * 60_000);
    names.push(`${prefix}${i}`);
  }
  return names;
}

/** The owner (boss), a moderator (mia), two moderators' target players (alice, bob) and a second moderator (max). All old enough to write. */
async function crew(r: Running) {
  const [boss, mia, max, alice, bob] = [await signUp(r, 'boss'), await signUp(r, 'mia'), await signUp(r, 'max'), await signUp(r, 'alice'), await signUp(r, 'bob')];
  r.clock.advanceSeconds(NEW_ACCOUNT_WAIT_MS / 1000 + 1);
  for (const name of ['mia', 'max']) expect((await post(r, boss, '/api/admin/moderator', { username: name, on: true })).status).toBe(200);
  return { boss, mia, max, alice, bob };
}

describe('choosing moderators', () => {
  it('MOD-1: only the owner makes (or unmakes) a moderator; the role shows everywhere at once and the choice is logged once', async () => {
    const r = await boot();
    const [boss, alice, bob] = [await signUp(r, 'boss'), await signUp(r, 'alice'), await signUp(r, 'bob')];
    // A player cannot, and neither can a moderator.
    const denied = await post(r, alice, '/api/admin/moderator', { username: 'bob', on: true });
    expect([denied.status, denied.json.error.code]).toEqual([403, 'owner_only']);
    expect(await meRole(r, alice)).toBe('player');
    const watching = await listen(r, alice);
    const id = rid();
    const made = await call(r, '/api/admin/moderator', { method: 'POST', cookie: boss, body: { requestId: id, username: 'alice', on: true } });
    expect([made.status, made.json.moderator, made.json.duplicate]).toEqual([200, true, false]);
    expect(await meRole(r, alice)).toBe('moderator');
    expect(await until(() => watching.text().includes('event: role_changed'))).toBe(true);
    // The same request again changes nothing and is not logged twice.
    const again = await call(r, '/api/admin/moderator', { method: 'POST', cookie: boss, body: { requestId: id, username: 'alice', on: true } });
    expect([again.status, again.json.duplicate]).toEqual([200, true]);
    expect(log(r).filter((l) => l.action === 'mod_appoint')).toEqual([{ action: 'mod_appoint', target: 'alice', admin: 'boss' }]);
    // A moderator cannot choose another moderator.
    const copy = await post(r, alice, '/api/admin/moderator', { username: 'bob', on: true });
    expect([copy.status, copy.json.error.code]).toEqual([403, 'owner_only']);
    expect(await meRole(r, bob)).toBe('player');
    // The owner is above a moderator; asking twice is an error, not a second row.
    expect((await post(r, boss, '/api/admin/moderator', { username: 'boss', on: true })).status).toBe(400);
    expect((await post(r, boss, '/api/admin/moderator', { username: 'alice', on: true })).json.error.code).toBe('already_moderator');
    expect((await post(r, boss, '/api/admin/moderator', { username: 'bob', on: false })).json.error.code).toBe('not_moderator');
    expect((await post(r, boss, '/api/admin/moderator', { username: 'nobody', on: true })).status).toBe(404);
    expect((await post(r, boss, '/api/admin/moderator', { username: 'bob', on: 'yes' })).status).toBe(400);
    // The admin panel's list shows the role, and taking it away puts him back among the players.
    const state = await call(r, '/api/admin/state', { cookie: boss });
    expect(state.json.players.map((p: any) => [p.username, p.role])).toEqual([['boss', 'owner'], ['alice', 'moderator'], ['bob', 'player']]);
    expect((await post(r, boss, '/api/admin/moderator', { username: 'alice', on: false })).status).toBe(200);
    expect(await meRole(r, alice)).toBe('player');
    expect(log(r).map((l) => l.action)).toEqual(['mod_appoint', 'mod_remove']);
  }, LONG);

  it('MOD-2: there can be only so many moderators, a computer player cannot be one, and a restart keeps them (the owner setting never touches the list)', async () => {
    const r = await boot();
    const boss = await signUp(r, 'boss');
    const names = bulk(r, 'p', MAX_MODERATORS + 1);
    for (const name of names.slice(0, MAX_MODERATORS)) expect((await post(r, boss, '/api/admin/moderator', { username: name, on: true })).status).toBe(200);
    const over = await post(r, boss, '/api/admin/moderator', { username: names[MAX_MODERATORS] as string, on: true });
    expect([over.status, over.json.error.code]).toEqual([400, 'too_many_moderators']);
    db(r).run("INSERT INTO users(username, display_name, pw_hash, role, created_ms) VALUES ('robot', 'robot', 'bot', 'player', 0)");
    expect((await post(r, boss, '/api/admin/moderator', { username: 'robot', on: true })).status).toBe(400);
    // The server applies the owner setting at every start: the moderators stay.
    r.app.services.auth.applyOwner();
    expect(db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM moderators')?.n).toBe(MAX_MODERATORS);
    expect(r.app.services.auth.userById(idOf(r, names[0] as string))?.role).toBe('moderator');
    // If the moderator becomes the owner (the server setting changes), he is the owner, not a moderator.
    db(r).run("UPDATE users SET role = 'owner' WHERE username = ?", names[0] as string);
    expect(r.app.services.auth.userById(idOf(r, names[0] as string))?.role).toBe('owner');
  }, LONG);
});

describe('banning and kicking', () => {
  it('MOD-3: a moderator bans an ordinary player for 1 to 168 hours, never longer or for good; the ban is logged under his name', async () => {
    const r = await boot();
    const { boss, mia, alice, bob } = await crew(r);
    for (const hours of [null, 169, 24 * 365]) {
      const out = await post(r, mia, '/api/admin/ban', { username: 'alice', reason: 'rude', hours });
      expect([hours, out.status, out.json.error.code]).toEqual([hours, 403, 'ban_too_long']);
    }
    expect((await post(r, mia, '/api/admin/ban', { username: 'alice', reason: 'rude' })).json.error.code).toBe('ban_too_long');
    expect(r.app.services.auth.banOf(idOf(r, 'alice'))).toBeNull();
    expect(MOD_MAX_BAN_HOURS).toBe(168);
    const ok = await post(r, mia, '/api/admin/ban', { username: 'alice', reason: 'rude', hours: 168 });
    expect([ok.status, ok.json.untilMs]).toEqual([200, r.clock.now() + 168 * 3_600_000]);
    // He is signed out on the very next request and cannot sign in; he is told why.
    expect((await call(r, '/api/me', { cookie: alice })).json.user).toBeNull();
    const refused = await login(r, 'alice');
    expect([refused.status, refused.json.error.code]).toEqual([403, 'banned']);
    expect(refused.json.error.message).toContain('rude');
    expect(log(r).filter((l) => l.action === 'ban')).toEqual([{ action: 'ban', target: 'alice', admin: 'mia' }]);
    // A player who is not staff cannot ban at all, and the owner can still ban for good.
    expect((await post(r, bob, '/api/admin/ban', { username: 'mia', hours: 1 })).json.error.code).toBe('staff_only');
    expect((await post(r, boss, '/api/admin/ban', { username: 'bob', reason: 'cheating' })).status).toBe(200);
  }, LONG);

  it('MOD-4: a moderator can never ban, kick or unban the owner, another moderator or himself; the owner can ban a moderator', async () => {
    const r = await boot();
    const { boss, mia, max } = await crew(r);
    const wrong: string[] = [];
    for (const what of ['ban', 'kick', 'unban']) {
      const body = (username: string) => ({ username, hours: 1, minutes: 10 });
      const onOwner = await post(r, mia, `/api/admin/${what}`, body('boss'));
      if (what !== 'unban' && (onOwner.status !== 400 || onOwner.json.error.code !== 'cannot_ban_owner')) wrong.push(`${what} the owner: ${onOwner.status}`);
      if (what === 'unban' && onOwner.status !== 400) wrong.push(`unban the owner: ${onOwner.status}`);
      const onMod = await post(r, mia, `/api/admin/${what}`, body('max'));
      if (onMod.status !== 403 || onMod.json.error.code !== 'cannot_act_on_staff') wrong.push(`${what} another moderator: ${onMod.status}`);
      const onSelf = await post(r, mia, `/api/admin/${what}`, body('mia'));
      if (onSelf.status !== 400 || onSelf.json.error.code !== 'cannot_act_on_self') wrong.push(`${what} himself: ${onSelf.status}`);
    }
    expect(wrong).toEqual([]);
    expect(db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM user_bans')?.n).toBe(0);
    expect(log(r).map((l) => l.action)).toEqual(['mod_appoint', 'mod_appoint']);
    // The owner can ban a moderator (and he cannot sign in), and only the owner can lift it.
    expect((await post(r, boss, '/api/admin/ban', { username: 'max', hours: 2 })).status).toBe(200);
    expect((await login(r, 'max')).status).toBe(403);
    expect((await post(r, mia, '/api/admin/unban', { username: 'max' })).json.error.code).toBe('cannot_act_on_staff');
    expect((await post(r, boss, '/api/admin/unban', { username: 'max' })).status).toBe(200);
    expect((await login(r, 'max')).status).toBe(200);
    expect(max).toBeTruthy();
  }, LONG);

  it('MOD-5: a kick lasts 10 minutes, 1 hour or 1 day, signs the player out now, tells him he was kicked, and ends by itself', async () => {
    const r = await boot();
    const { boss, mia, alice } = await crew(r);
    expect([...KICK_MINUTES]).toEqual([10, 60, 1440]);
    for (const minutes of [0, 5, 11, 61, 100000, '10', null]) expect([minutes, (await post(r, mia, '/api/admin/kick', { username: 'alice', minutes })).status]).toEqual([minutes, 400]);
    const out = await post(r, mia, '/api/admin/kick', { username: 'alice', minutes: 10, reason: 'calm down' });
    expect([out.status, out.json.untilMs]).toEqual([200, r.clock.now() + 600_000]);
    expect((await call(r, '/api/me', { cookie: alice })).json.user).toBeNull();
    const me = (await call(r, '/api/me', { cookie: alice })).json;
    expect(me.banned).toMatchObject({ kind: 'kick', reason: 'calm down' });
    const refused = await login(r, 'alice');
    expect([refused.status, refused.json.error.code]).toEqual([403, 'banned']);
    expect(refused.json.error.message).toMatch(/^You were kicked out for a short time/);
    expect(refused.json.error.message).toContain('calm down');
    expect(log(r).filter((l) => l.action === 'kick')).toEqual([{ action: 'kick', target: 'alice', admin: 'mia' }]);
    // A second kick (or a ban) of someone who is out already is refused, not stacked.
    expect((await post(r, mia, '/api/admin/kick', { username: 'alice', minutes: 60 })).json.error.code).toBe('already_banned');
    // After ten minutes he can come back by himself, with the same cookie and with a new sign-in.
    r.clock.advanceSeconds(601);
    expect((await call(r, '/api/me', { cookie: alice })).json.user.username).toBe('alice');
    expect((await login(r, 'alice')).status).toBe(200);
    // The owner can kick too; a kick of a different length is its own request.
    expect((await post(r, boss, '/api/admin/kick', { username: 'bob', minutes: 1440 })).json.untilMs).toBe(r.clock.now() + 86_400_000);
    expect((await post(r, alice, '/api/admin/kick', { username: 'bob', minutes: 10 })).json.error.code).toBe('staff_only');
  }, LONG);

  it('MOD-6: a moderator cannot change, replace or lift what the owner decided, but can lift what a moderator did', async () => {
    const r = await boot();
    const { boss, mia, max, alice } = await crew(r);
    expect((await post(r, boss, '/api/admin/ban', { username: 'alice', hours: 48, reason: 'owner decision' })).status).toBe(200);
    const wrong: string[] = [];
    for (const [path, body] of [
      ['ban', { username: 'alice', hours: 1 }],
      ['unban', { username: 'alice' }],
    ] as const) {
      const out = await post(r, mia, `/api/admin/${path}`, body);
      if (out.status !== 403 || out.json.error.code !== 'owner_ban') wrong.push(`${path}: ${out.status} ${out.json.error?.code}`);
    }
    expect(wrong).toEqual([]);
    expect(r.app.services.auth.banOf(idOf(r, 'alice'))).toMatchObject({ reason: 'owner decision', untilMs: r.clock.now() + 48 * 3_600_000 });
    // What a moderator gave, another moderator may lift or change; the owner too.
    expect((await post(r, mia, '/api/admin/ban', { username: 'bob', hours: 5, reason: 'spam' })).status).toBe(200);
    expect((await post(r, max, '/api/admin/unban', { username: 'bob' })).status).toBe(200);
    expect(r.app.services.auth.banOf(idOf(r, 'bob'))).toBeNull();
    expect((await post(r, mia, '/api/admin/kick', { username: 'bob', minutes: 10 })).status).toBe(200);
    expect((await post(r, boss, '/api/admin/unban', { username: 'bob' })).status).toBe(200);
    expect(alice).toBeTruthy();
  }, LONG);

  it('MOD-7: a moderator can give only so many bans and kicks in an hour; the owner has no limit; the count starts fresh after the hour', async () => {
    const r = await boot();
    const { boss, mia } = await crew(r);
    const names = bulk(r, 'q', MOD_BANS_PER_HOUR + 6);
    for (let i = 0; i < MOD_BANS_PER_HOUR; i += 1) {
      const out = i % 2 === 0 ? await post(r, mia, '/api/admin/ban', { username: names[i] as string, hours: 1 }) : await post(r, mia, '/api/admin/kick', { username: names[i] as string, minutes: 10 });
      expect([i, out.status]).toEqual([i, 200]);
    }
    const over = await post(r, mia, '/api/admin/kick', { username: names[MOD_BANS_PER_HOUR] as string, minutes: 10 });
    expect([over.status, over.json.error.code]).toEqual([429, 'rate_limited']);
    expect(r.app.services.auth.banOf(idOf(r, names[MOD_BANS_PER_HOUR] as string))).toBeNull();
    // The owner is not limited.
    expect((await post(r, boss, '/api/admin/ban', { username: names[MOD_BANS_PER_HOUR] as string, hours: 1 })).status).toBe(200);
    // Lifting a ban is not counted.
    expect((await post(r, mia, '/api/admin/unban', { username: names[0] as string })).status).toBe(200);
    r.clock.advanceSeconds(3601);
    expect((await post(r, mia, '/api/admin/kick', { username: names[MOD_BANS_PER_HOUR + 1] as string, minutes: 10 })).status).toBe(200);
  }, LONG);

  it('MOD-8: a moderator finds a player by name (no money shown); the list is for the owner and moderators only', async () => {
    const r = await boot();
    const { boss, mia, alice } = await crew(r);
    expect((await call(r, '/api/mod/players?q=ali', { cookie: alice })).json.error.code).toBe('staff_only');
    expect((await call(r, '/api/mod/players?q=ali')).status).toBe(401);
    expect((await post(r, mia, '/api/admin/ban', { username: 'alice', hours: 1, reason: 'x' })).status).toBe(200);
    const found = await call(r, '/api/mod/players?q=ali', { cookie: mia });
    expect(found.json.players).toHaveLength(1);
    expect(Object.keys(found.json.players[0]).sort()).toEqual(['banned', 'createdMs', 'displayName', 'formerNames', 'role', 'username']);
    expect(found.json.players[0]).toMatchObject({ username: 'alice', role: 'player', banned: { kind: 'ban', reason: 'x' } });
    const all = await call(r, '/api/mod/players', { cookie: boss });
    expect(all.json.players.map((p: any) => [p.username, p.role]).sort()).toEqual([['alice', 'player'], ['bob', 'player'], ['boss', 'owner'], ['max', 'moderator'], ['mia', 'moderator']]);
    // Wildcards in the search are just letters.
    expect((await call(r, '/api/mod/players?q=%25', { cookie: mia })).json.players).toEqual([]);
  }, LONG);
});

describe('the public chat', () => {
  const say = (r: Running, cookie: string, text: string) => call(r, '/api/chat/send', { method: 'POST', cookie, body: { text } });
  const plant = (r: Running, name: string, text: string): number => db(r).run('INSERT INTO chat_messages(user_id, body, created_ms) VALUES (?, ?, ?)', idOf(r, name), text, r.clock.now()).lastInsertRowid;

  it('MOD-9: a moderator deletes, mutes (up to 7 days) and closes reports for ordinary players only; he cannot ban from the chat for good', async () => {
    const r = await boot();
    const { boss, mia, max, alice, bob } = await crew(r);
    const bad = (await say(r, alice, 'a rude thing')).json.message.id as number;
    const del = await post(r, mia, '/api/admin/chat/delete', { messageId: bad });
    expect(del.status).toBe(200);
    expect(MOD_MAX_MUTE_MINUTES).toBe(7 * 24 * 60);
    const ok = await post(r, mia, '/api/admin/chat/mute', { username: 'alice', minutes: MOD_MAX_MUTE_MINUTES });
    expect([ok.status, ok.json.untilMs]).toEqual([200, r.clock.now() + MOD_MAX_MUTE_MINUTES * 60_000]);
    expect((await say(r, alice, 'hello again')).json.error.code).toBe('muted');
    const long = await post(r, mia, '/api/admin/chat/mute', { username: 'bob', minutes: MOD_MAX_MUTE_MINUTES + 1 });
    expect([long.status, long.json.error.code]).toEqual([403, 'ban_too_long']);
    const forever = await post(r, mia, '/api/admin/chat/ban', { username: 'bob' });
    expect([forever.status, forever.json.error.code]).toEqual([403, 'ban_too_long']);
    expect((await say(r, bob, 'still fine')).status).toBe(200);
    // Not the owner, not another moderator, not himself.
    const wrong: string[] = [];
    for (const [what, body] of [
      ['mute', { username: 'boss', minutes: 5 }],
      ['mute', { username: 'max', minutes: 5 }],
      ['mute', { username: 'mia', minutes: 5 }],
      ['ban', { username: 'boss' }],
      ['lift', { username: 'max' }],
    ] as const) {
      const out = await post(r, mia, `/api/admin/chat/${what}`, body);
      if (out.status < 400 || !['cannot_moderate_owner', 'cannot_moderate_staff', 'ban_too_long'].includes(out.json.error.code)) wrong.push(`${what} ${JSON.stringify(body)}: ${out.status}`);
    }
    expect(wrong).toEqual([]);
    // A moderator may lift what a moderator gave.
    expect((await post(r, max, '/api/admin/chat/lift', { username: 'alice' })).status).toBe(200);
    r.clock.advanceSeconds(30);
    expect((await say(r, alice, 'back again')).status).toBe(200);
    expect(log(r).filter((l) => l.action.startsWith('chat_')).map((l) => [l.action, l.admin])).toEqual([['chat_delete', 'mia'], ['chat_mute', 'mia'], ['chat_lift', 'max']]);
    expect(boss).toBeTruthy();
  }, LONG);

  it('MOD-10: a moderator cannot delete the owner\'s or a moderator\'s message, close a report about one, or lift a mute the owner gave', async () => {
    const r = await boot();
    const { boss, mia, max, alice, bob } = await crew(r);
    const ownerMsg = plant(r, 'boss', 'the owner speaks');
    const modMsg = plant(r, 'max', 'a moderator speaks');
    const wrong: string[] = [];
    for (const [id, who] of [[ownerMsg, 'owner'], [modMsg, 'moderator']] as const) {
      const out = await post(r, mia, '/api/admin/chat/delete', { messageId: id });
      if (out.status !== 403 || out.json.error.code !== 'cannot_moderate_staff') wrong.push(`delete ${who}: ${out.status}`);
      const dismiss = await post(r, mia, '/api/admin/chat/dismiss', { messageId: id });
      if (dismiss.status !== 403) wrong.push(`dismiss ${who}: ${dismiss.status}`);
    }
    expect(wrong).toEqual([]);
    // A moderator can delete his own message.
    expect((await post(r, max, '/api/admin/chat/delete', { messageId: modMsg })).status).toBe(200);
    // The owner's mute stands against a moderator, who can neither shorten it nor lift it.
    expect((await post(r, boss, '/api/admin/chat/mute', { username: 'alice', minutes: 600 })).status).toBe(200);
    for (const [what, body] of [['mute', { username: 'alice', minutes: 1 }], ['lift', { username: 'alice' }]] as const) {
      const out = await post(r, mia, `/api/admin/chat/${what}`, body);
      expect([what, out.status, out.json.error.code]).toEqual([what, 403, 'owner_decision']);
    }
    expect((await say(r, alice, 'hi')).json.error.code).toBe('muted');
    expect((await post(r, boss, '/api/admin/chat/lift', { username: 'alice' })).status).toBe(200);
    expect(bob).toBeTruthy();
  }, LONG);

  it('MOD-11: the reports a moderator sees leave out the owner\'s and the moderators\' messages; the owner sees all; the list says which restrictions are the owner\'s', async () => {
    const r = await boot();
    const { boss, mia, max, alice, bob } = await crew(r);
    const a = (await say(r, alice, 'alice rude')).json.message.id as number;
    const m = plant(r, 'max', 'max rude');
    expect((await call(r, '/api/chat/report', { method: 'POST', cookie: bob, body: { messageId: a } })).status).toBe(200);
    expect((await call(r, '/api/chat/report', { method: 'POST', cookie: bob, body: { messageId: m } })).status).toBe(200);
    const forOwner = (await call(r, '/api/admin/chat', { cookie: boss })).json;
    expect(forOwner.reports.map((x: any) => x.username).sort()).toEqual(['alice', 'max']);
    const forMod = (await call(r, '/api/admin/chat', { cookie: mia })).json;
    expect(forMod.reports.map((x: any) => x.username)).toEqual(['alice']);
    expect((await call(r, '/api/admin/chat', { cookie: alice })).json.error.code).toBe('staff_only');
    expect((await post(r, boss, '/api/admin/chat/mute', { username: 'bob', minutes: 30 })).status).toBe(200);
    expect((await post(r, max, '/api/admin/chat/mute', { username: 'alice', minutes: 30 })).status).toBe(200);
    const list = (await call(r, '/api/admin/chat', { cookie: mia })).json.restricted;
    expect(list.map((x: any) => [x.username, x.by, x.byOwner]).sort()).toEqual([['alice', 'max', false], ['bob', 'boss', true]]);
  }, LONG);
});

describe('what stays the owner\'s', () => {
  it('MOD-12: the rest of the admin panel is closed to a moderator, and nothing it tried changed anything', async () => {
    const r = await boot();
    const { boss, mia } = await crew(r);
    const before = log(r).length;
    const owner: [string, string, Record<string, unknown> | undefined][] = [
      ['GET', '/api/admin/state', undefined],
      ['POST', '/api/admin/shock', { ticker: 'QLRX', percent: -50, style: 'rug', speed: 'instant' }],
      ['POST', '/api/admin/halt', { ticker: 'QLRX', halted: true }],
      ['POST', '/api/admin/cash', { username: 'alice', amountCents: 5000 }],
      ['POST', '/api/admin/coins', { username: 'alice', amountCents: 5000 }],
      ['POST', '/api/admin/shares', { username: 'alice', ticker: 'QLRX', qty: 5 }],
      ['POST', '/api/admin/reset', { username: 'alice' }],
      ['POST', '/api/admin/announce', { text: 'hello' }],
      ['POST', '/api/admin/pause', { paused: true }],
      ['POST', '/api/admin/moderator', { username: 'alice', on: true }],
      ['GET', '/api/admin/private-reports', undefined],
    ];
    const wrong: string[] = [];
    for (const [method, path, body] of owner) {
      const out = await call(r, path, { method, cookie: mia, body: body && { requestId: rid(), ...body } });
      if (out.status === 404 || out.status === 405) continue; // (a route this version does not have)
      if (out.status !== 403 || out.json.error.code !== 'owner_only') wrong.push(`${method} ${path}: ${out.status} ${out.json?.error?.code}`);
    }
    expect(wrong).toEqual([]);
    expect(log(r).length).toBe(before);
    expect(r.app.services.halts.list()).toEqual([]);
    expect(boss).toBeTruthy();
  }, LONG);

  it('MOD-13: a moderator removes the picture of an ordinary player, never of the owner or of another moderator', async () => {
    const r = await boot();
    const { mia, alice } = await crew(r);
    for (const name of ['alice', 'boss', 'max', 'mia']) {
      db(r).run('INSERT INTO user_avatars(user_id, mime, data, updated_ms) VALUES (?, ?, ?, ?)', idOf(r, name), 'image/png', new Uint8Array([1, 2, 3]), r.clock.now());
    }
    const wrong: string[] = [];
    for (const name of ['boss', 'max']) {
      const out = await post(r, mia, '/api/admin/avatar/remove', { username: name });
      if (out.status !== 403 || out.json.error.code !== 'not_allowed') wrong.push(`${name}: ${out.status}`);
    }
    expect(wrong).toEqual([]);
    expect((await post(r, mia, '/api/admin/avatar/remove', { username: 'alice' })).status).toBe(200);
    expect(db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM user_avatars')?.n).toBe(3);
    expect((await post(r, alice, '/api/admin/avatar/remove', { username: 'mia' })).json.error.code).toBe('staff_only');
    expect(log(r).filter((l) => l.action === 'avatar_remove')).toEqual([{ action: 'avatar_remove', target: 'alice', admin: 'mia' }]);
  }, LONG);
});

describe('a moderator is a player too', () => {
  it('MOD-14: a moderator is ranked and listed like any player, with the role named in the player list, chat and friends; the owner stays unranked', async () => {
    const r = await boot();
    const { boss, mia, alice } = await crew(r);
    const list = (await call(r, '/api/players', { cookie: alice })).json.players as { username: string; role: string; rank: number | null }[];
    const by = Object.fromEntries(list.map((p) => [p.username, p]));
    expect([by.mia?.role, by.mia?.rank !== null, by.boss?.role, by.boss?.rank]).toEqual(['moderator', true, 'owner', null]);
    const sent = await call(r, '/api/chat/send', { method: 'POST', cookie: mia, body: { text: 'hello all' } });
    expect(sent.json.message.role).toBe('moderator');
    expect((await call(r, '/api/chat', { cookie: alice })).json.messages.map((m: any) => [m.username, m.role])).toEqual([['mia', 'moderator']]);
    const board = (await call(r, '/api/leaderboard?scope=all', { cookie: alice })).json;
    expect(board.rows.map((x: any) => x.username)).toContain('mia');
    expect(boss).toBeTruthy();
  }, LONG);

  it('MOD-16: the admin service itself refuses a moderator the owner-only job (not only the route in front of it)', async () => {
    const r = await boot();
    await crew(r);
    const mia = { id: idOf(r, 'mia'), username: 'mia', displayName: 'mia', role: 'moderator' as const, createdMs: 0 };
    expect(() => r.app.services.admin.setModerator(mia, { requestId: rid(), username: 'alice', on: true })).toThrow(/owner/i);
    expect(db(r).get('SELECT 1 AS x FROM moderators m JOIN users u ON u.id = m.user_id WHERE u.username = ?', 'alice')).toBeUndefined();
  }, LONG);

  it('MOD-15: version 25 keeps every old row; a kick kind other than ban or kick, or a moderator who is not a player, is refused by the table', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tq-mod-mig-'));
    dirs.push(dir);
    const d = new Db(join(dir, 'old.sqlite'));
    try {
      // Build a database as version 24 left it, with one ban and one player.
      d.tx(() => {
        for (const m of MIGRATIONS.filter((x) => x.version <= 24)) {
          d.exec(m.sql);
          d.exec(`PRAGMA user_version = ${m.version}`);
        }
      });
      d.run("INSERT INTO users(username, display_name, pw_hash, role, created_ms) VALUES ('old', 'old', 'x', 'player', 1), ('boss', 'boss', 'x', 'owner', 1)");
      d.run("INSERT INTO user_bans(user_id, reason, banned_ms, until_ms, by_user_id) VALUES (1, 'old ban', 5, NULL, 2)");
      expect(migrate(d)).toEqual([25, 26, 27, 28, 29, 30]);
      expect(d.get<{ kind: string; reason: string }>('SELECT kind, reason FROM user_bans WHERE user_id = 1')).toEqual({ kind: 'ban', reason: 'old ban' });
      expect(d.get<{ n: number }>('SELECT COUNT(*) AS n FROM moderators')?.n).toBe(0);
      expect(() => d.run("UPDATE user_bans SET kind = 'pause' WHERE user_id = 1")).toThrow();
      expect(() => d.run('INSERT INTO moderators(user_id, appointed_ms) VALUES (99, 1)')).toThrow();
      d.run('INSERT INTO moderators(user_id, appointed_ms, appointed_by) VALUES (1, 5, 2)');
      d.run("INSERT INTO user_badges(user_id, badge, earned_ms) VALUES (1, 'welcome', 5)");
      expect(() => d.run("INSERT INTO user_badges(user_id, badge, earned_ms) VALUES (1, 'welcome', 6)")).toThrow();
      expect(() => d.run("INSERT INTO user_badges(user_id, badge, earned_ms) VALUES (99, 'welcome', 6)")).toThrow();
      // Deleting a player takes his moderator row and his badges with him.
      d.run('PRAGMA foreign_keys = ON');
      d.run('DELETE FROM user_bans WHERE user_id = 1');
      d.run('DELETE FROM users WHERE id = 1');
      expect(d.get<{ n: number }>('SELECT (SELECT COUNT(*) FROM moderators) + (SELECT COUNT(*) FROM user_badges) AS n')?.n).toBe(0);
    } finally {
      d.close();
    }
  });
});
