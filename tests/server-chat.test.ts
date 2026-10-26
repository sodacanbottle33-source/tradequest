// The public chat room over HTTP (server/chat.ts, docs/world.md §15). The properties that matter: only signed-in players read and write, a message
// is plain one-line text of limited length, spam is slowed down, a brand-new account waits before it can write, players can report a message,
// and only the owner can delete a message, mute a player or ban him from the chat, each of which is logged once and never stops playing.
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../server/app';
import { CHAT_BURST, CHAT_KEEP, CHAT_MAX_LENGTH, CHAT_PAGE, MIN_GAP_MS, NEW_ACCOUNT_WAIT_MS, REPEAT_MS, REPORTS_PER_HOUR, cleanMessage, waitText } from '../server/chat';
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
  const dir = mkdtempSync(join(tmpdir(), 'tq-chat-'));
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

/** Opens a live stream and collects what arrives on it. */
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
const say = (r: Running, cookie: string, text: unknown) => call(r, '/api/chat/send', { method: 'POST', cookie, body: { text } });
const chatOf = async (r: Running, cookie: string, query = '') => (await call(r, `/api/chat${query}`, { cookie })).json;
const texts = (view: any): string[] => view.messages.map((m: any) => m.text);
let nextRequest = 0;
const requestId = (): string => `chat-test-${(nextRequest += 1)}-abcdef`;
const admin = (r: Running, cookie: string, what: 'delete' | 'dismiss' | 'mute' | 'ban' | 'lift', body: Record<string, unknown>) =>
  call(r, `/api/admin/chat/${what}`, { method: 'POST', cookie, body: { requestId: requestId(), ...body } });
/** Puts a message in the table without the rules (a long time ago, or in bulk). */
function plant(r: Running, name: string, text: string, createdMs = r.clock.now()): number {
  return db(r).run('INSERT INTO chat_messages(user_id, body, created_ms) VALUES (?, ?, ?)', idOf(r, name), text, createdMs).lastInsertRowid;
}

/** Alice, Bob and the owner (boss), all old enough to write. */
async function room(r: Running) {
  const [alice, bob, boss] = [await signUp(r, 'alice'), await signUp(r, 'bob'), await signUp(r, 'boss')];
  r.clock.advanceSeconds(NEW_ACCOUNT_WAIT_MS / 1000 + 1);
  return { alice, bob, boss };
}

describe('who may read and write', () => {
  it('CHAT-1: reading, writing and reporting need a signed-in player; the owner routes need the owner', async () => {
    const r = await boot();
    const { alice } = await room(r);
    const wrong: string[] = [];
    const checks: [string, string, unknown][] = [
      ['GET', '/api/chat', undefined],
      ['POST', '/api/chat/send', { text: 'hi' }],
      ['POST', '/api/chat/report', { messageId: 1 }],
      ['GET', '/api/admin/chat', undefined],
      ...['delete', 'dismiss', 'mute', 'ban', 'lift'].map((w): [string, string, unknown] => ['POST', `/api/admin/chat/${w}`, { requestId: requestId(), username: 'bob', messageId: 1, minutes: 5 }]),
    ];
    for (const [method, path, body] of checks) {
      const out = await call(r, path, { method, body });
      if (out.status !== 401) wrong.push(`${method} ${path} signed out: ${out.status}`);
      if (path.startsWith('/api/admin/')) {
        const asPlayer = await call(r, path, { method, body, cookie: alice });
        if (asPlayer.status !== 403 || asPlayer.json.error.code !== 'owner_only') wrong.push(`${method} ${path} as a player: ${asPlayer.status}`);
      }
    }
    expect(wrong).toEqual([]);
    expect(db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM chat_messages')?.n).toBe(0);
  }, LONG);

  it('CHAT-2: a new account can read at once but writes only after five minutes; the owner is exempt', async () => {
    const r = await boot();
    const [newbie, boss] = [await signUp(r, 'newbie'), await signUp(r, 'boss')];
    const view = await chatOf(r, newbie);
    expect(view.you.canWrite).toBe(false);
    expect(view.you.reason).toBe('new_account');
    expect(view.you.untilMs).toBe(r.clock.now() + NEW_ACCOUNT_WAIT_MS);
    expect(view.you.message).toMatch(/5 minutes/);
    const early = await say(r, newbie, 'hello');
    expect(early.status).toBe(403);
    expect(early.json.error.code).toBe('too_new');
    expect((await say(r, boss, 'welcome everybody')).status).toBe(200);
    expect(texts(await chatOf(r, newbie))).toEqual(['welcome everybody']);
    r.clock.advanceSeconds(NEW_ACCOUNT_WAIT_MS / 1000 - 1);
    expect((await say(r, newbie, 'hello')).status).toBe(403);
    r.clock.advanceSeconds(1);
    expect((await chatOf(r, newbie)).you.canWrite).toBe(true);
    expect((await say(r, newbie, 'hello')).status).toBe(200);
  }, LONG);

  it('CHAT-3: a message shows with its writer, oldest first; the owner is marked', async () => {
    const r = await boot();
    const { alice, bob, boss } = await room(r);
    await say(r, alice, 'first');
    r.clock.advanceSeconds(2);
    await say(r, bob, 'second');
    r.clock.advanceSeconds(2);
    await say(r, boss, 'third');
    const view = await chatOf(r, alice);
    expect(texts(view)).toEqual(['first', 'second', 'third']);
    expect(view.messages.map((m: any) => m.username)).toEqual(['alice', 'bob', 'boss']);
    expect(view.messages.map((m: any) => m.role)).toEqual(['player', 'player', 'owner']);
    expect(view.messages[0].createdMs).toBeLessThan(view.messages[2].createdMs);
    expect(view.limits.maxLength).toBe(CHAT_MAX_LENGTH);
    expect(view.more).toBe(false);
    // Nothing about a writer but a name and the role.
    expect(Object.keys(view.messages[0]).sort()).toEqual(['createdMs', 'displayName', 'id', 'role', 'text', 'username']);
  }, LONG);
});

describe('what a message may be', () => {
  it('CHAT-4: one line of plain text: spaces collapsed, hidden and control characters removed, markup left as plain text', async () => {
    const r = await boot();
    const { alice } = await room(r);
    expect(cleanMessage('  a \n\n b\t c  ')).toBe('a b c');
    const sneaky = 'hello\u{202E}evil\u{200B}\u{0} world';
    expect(cleanMessage(sneaky)).toBe('hello evil world');
    const sent = await say(r, alice, '  <b>bold</b>   <script>alert(1)</script>\nsecond line ');
    expect(sent.status).toBe(200);
    expect(sent.json.message.text).toBe('<b>bold</b> <script>alert(1)</script> second line');
    r.clock.advanceSeconds(2);
    expect((await say(r, alice, sneaky)).json.message.text).toBe('hello evil world');
    // A family emoji keeps its joiners.
    r.clock.advanceSeconds(2);
    expect((await say(r, alice, '\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}')).json.message.text).toBe('\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}');
  }, LONG);

  it('CHAT-5: an empty message and a message that is not text are refused', async () => {
    const r = await boot();
    const { alice } = await room(r);
    for (const bad of ['', '   ', '\n\t', '\u{200B}\u{202E}']) {
      const out = await say(r, alice, bad);
      expect(out.status).toBe(400);
      expect(out.json.error.code).toBe('empty');
    }
    for (const bad of [undefined, null, 5, { a: 1 }, ['hi']]) {
      const out = await say(r, alice, bad);
      expect(out.status).toBe(400);
      expect(out.json.error.code).toBe('bad_request');
    }
    expect(db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM chat_messages')?.n).toBe(0);
  }, LONG);

  it('CHAT-6: a message has at most 300 characters (counted as people count them, an emoji is one)', async () => {
    const r = await boot();
    const { alice } = await room(r);
    const ok = await say(r, alice, 'x'.repeat(CHAT_MAX_LENGTH));
    expect(ok.status).toBe(200);
    r.clock.advanceSeconds(2);
    const long = await say(r, alice, 'y'.repeat(CHAT_MAX_LENGTH + 1));
    expect(long.status).toBe(400);
    expect(long.json.error.code).toBe('too_long');
    expect(long.json.error.message).toMatch(/301/);
    r.clock.advanceSeconds(2);
    expect((await say(r, alice, '\u{1F600}'.repeat(CHAT_MAX_LENGTH))).status).toBe(200);
    r.clock.advanceSeconds(2);
    expect((await say(r, alice, '\u{1F600}'.repeat(CHAT_MAX_LENGTH + 1))).status).toBe(400);
  }, LONG);
});

describe('slowing spam down', () => {
  it('CHAT-7: a pause between messages, a limit per half minute, and the same message not twice in a row', async () => {
    const r = await boot();
    const { alice, bob } = await room(r);
    expect((await say(r, alice, 'one')).status).toBe(200);
    const quick = await say(r, alice, 'two');
    expect(quick.status).toBe(429);
    expect(quick.json.error.code).toBe('too_fast');
    // Another player is not slowed by Alice.
    expect((await say(r, bob, 'bob here')).status).toBe(200);
    r.clock.ms += MIN_GAP_MS;
    expect((await say(r, alice, 'two')).status).toBe(200);
    // The same text again, in any letter case, within a minute.
    r.clock.ms += MIN_GAP_MS;
    const repeat = await say(r, alice, 'TWO');
    expect(repeat.status).toBe(400);
    expect(repeat.json.error.code).toBe('repeat');
    // After a minute it may be said again.
    r.clock.ms += REPEAT_MS;
    expect((await say(r, alice, 'two')).status).toBe(200);
  }, LONG);

  it('CHAT-8: at most eight messages in half a minute, then it opens up again', async () => {
    const r = await boot();
    const { alice } = await room(r);
    const results: number[] = [];
    for (let i = 0; i < CHAT_BURST + 2; i += 1) {
      results.push((await say(r, alice, `message ${i}`)).status);
      r.clock.ms += MIN_GAP_MS;
    }
    expect(results.slice(0, CHAT_BURST)).toEqual(Array(CHAT_BURST).fill(200));
    expect(results.slice(CHAT_BURST)).toEqual([429, 429]);
    r.clock.advanceSeconds(30);
    expect((await say(r, alice, 'back again')).status).toBe(200);
  }, LONG);

  it('CHAT-9: the chat route itself is limited, so failing sends cannot be used to hammer the server', async () => {
    const r = await boot();
    const { alice } = await room(r);
    const codes = new Set<number>();
    for (let i = 0; i < 30; i += 1) codes.add((await say(r, alice, '')).status);
    expect(codes.has(429)).toBe(true);
  }, LONG);
});

describe('what is shown and kept', () => {
  it('CHAT-10: the chat opens with the newest 50 messages and older ones can be asked for', async () => {
    const r = await boot();
    const { alice } = await room(r);
    const ids: number[] = [];
    for (let i = 0; i < 120; i += 1) ids.push(plant(r, 'alice', `old ${i}`, r.clock.now() - 1000 * (120 - i)));
    const view = await chatOf(r, alice);
    expect(view.messages).toHaveLength(CHAT_PAGE);
    expect(texts(view)[0]).toBe('old 70');
    expect(texts(view)[CHAT_PAGE - 1]).toBe('old 119');
    expect(view.more).toBe(true);
    const older = await chatOf(r, alice, `?before=${view.messages[0].id}&limit=100`);
    expect(older.messages).toHaveLength(70);
    expect(texts(older)[0]).toBe('old 0');
    expect(older.more).toBe(false);
    expect((await call(r, '/api/chat?limit=0', { cookie: alice })).status).toBe(400);
    expect((await call(r, '/api/chat?limit=101', { cookie: alice })).status).toBe(400);
    expect(ids).toHaveLength(120);
  }, LONG);

  it('CHAT-11: only the newest 2,000 messages are kept', async () => {
    const r = await boot();
    const { alice } = await room(r);
    db(r).tx(() => {
      for (let i = 0; i < CHAT_KEEP + 25; i += 1) plant(r, 'alice', `bulk ${i}`, r.clock.now() - 10_000_000 + i);
    });
    expect((await say(r, alice, 'newest')).status).toBe(200);
    expect(db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM chat_messages')?.n).toBe(CHAT_KEEP);
    const view = await chatOf(r, alice);
    expect(texts(view).at(-1)).toBe('newest');
    expect(db(r).get<{ n: number }>("SELECT COUNT(*) AS n FROM chat_messages WHERE body = 'bulk 0'")?.n).toBe(0);
  }, LONG);

  it('CHAT-12: the messages of a player the owner banned from the game are hidden, and come back if the ban is lifted', async () => {
    const r = await boot();
    const { alice, bob } = await room(r);
    await say(r, bob, 'from bob');
    r.clock.advanceSeconds(2);
    await say(r, alice, 'from alice');
    db(r).run("INSERT INTO user_bans(user_id, reason, banned_ms, until_ms, by_user_id) VALUES (?, 'test', ?, NULL, ?)", idOf(r, 'bob'), r.clock.now(), idOf(r, 'boss'));
    expect(texts(await chatOf(r, alice))).toEqual(['from alice']);
    db(r).run('DELETE FROM user_bans WHERE user_id = ?', idOf(r, 'bob'));
    expect(texts(await chatOf(r, alice))).toEqual(['from bob', 'from alice']);
  }, LONG);

  it('CHAT-13: a new message is pushed to every signed-in page at once and to nobody who is signed out', async () => {
    const r = await boot();
    const { alice, bob } = await room(r);
    const [forBob, forStranger] = [await listen(r, bob), await listen(r)];
    const sent = await say(r, alice, 'hello room');
    expect(await until(() => forBob.text().includes('event: chat\n'))).toBe(true);
    expect(forBob.text()).toContain('"text":"hello room"');
    expect(forBob.text()).toContain(`"id":${sent.json.message.id}`);
    await new Promise((done) => setTimeout(done, 150));
    expect(forStranger.text()).not.toContain('event: chat');
    expect(forStranger.text()).not.toContain('hello room');
  }, LONG);
});

describe('reports', () => {
  it('CHAT-14: a player can report another player\'s message once; not his own, not the owner\'s, not one that is gone', async () => {
    const r = await boot();
    const { alice, bob, boss } = await room(r);
    const bad = (await say(r, bob, 'something rude')).json.message.id as number;
    r.clock.advanceSeconds(2);
    const own = (await say(r, alice, 'mine')).json.message.id as number;
    const owners = (await say(r, boss, 'from the owner')).json.message.id as number;
    const report = (cookie: string, messageId: unknown) => call(r, '/api/chat/report', { method: 'POST', cookie, body: { messageId } });
    expect((await report(alice, bad)).status).toBe(200);
    expect((await report(alice, bad)).status).toBe(200); // again: nothing changes
    expect(db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM chat_reports')?.n).toBe(1);
    expect((await report(alice, own)).status).toBe(400);
    expect((await report(alice, owners)).status).toBe(400);
    expect((await report(alice, 99999)).status).toBe(404);
    r.clock.advanceSeconds(11); // the route's own ten-second limit is not what is tested here
    for (const nonsense of ['1', 0, -1, 1.5, null, undefined]) expect((await report(alice, nonsense)).status).toBe(400);
    expect(db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM chat_reports')?.n).toBe(1);
  }, LONG);

  it('CHAT-15: one player can send only twenty reports an hour', async () => {
    const r = await boot();
    const { alice } = await room(r);
    const ids: number[] = [];
    for (let i = 0; i < REPORTS_PER_HOUR + 1; i += 1) ids.push(plant(r, 'bob', `rude ${i}`));
    let last = 0;
    for (let i = 0; i < REPORTS_PER_HOUR; i += 1) {
      last = (await call(r, '/api/chat/report', { method: 'POST', cookie: alice, body: { messageId: ids[i] } })).status;
      if (i % 5 === 4) r.clock.advanceSeconds(11); // the route's own ten-second limit is not what is tested here
    }
    expect(last).toBe(200);
    const over = await call(r, '/api/chat/report', { method: 'POST', cookie: alice, body: { messageId: ids[REPORTS_PER_HOUR] } });
    expect(over.status).toBe(429);
    expect(over.json.error.code).toBe('rate_limited');
    r.clock.advanceSeconds(3601);
    expect((await call(r, '/api/chat/report', { method: 'POST', cookie: alice, body: { messageId: ids[REPORTS_PER_HOUR] } })).status).toBe(200);
  }, LONG);
});

describe('the owner\'s tools', () => {
  it('CHAT-16: deleting a message removes it for everybody, tells the open pages, closes its reports and is logged once', async () => {
    const r = await boot();
    const { alice, bob, boss } = await room(r);
    const id = (await say(r, bob, 'rude words')).json.message.id as number;
    r.clock.advanceSeconds(2);
    await say(r, alice, 'fine words');
    await call(r, '/api/chat/report', { method: 'POST', cookie: alice, body: { messageId: id } });
    expect((await call(r, '/api/admin/chat', { cookie: boss })).json.reports.map((x: any) => x.messageId)).toEqual([id]);
    const watching = await listen(r, alice);
    const body = { requestId: 'delete-once-12345', messageId: id };
    const first = await call(r, '/api/admin/chat/delete', { method: 'POST', cookie: boss, body });
    expect(first.status).toBe(200);
    expect(first.json.duplicate).toBe(false);
    expect(texts(await chatOf(r, alice))).toEqual(['fine words']);
    expect(texts(await chatOf(r, bob))).toEqual(['fine words']);
    expect(await until(() => watching.text().includes('event: chat_removed'))).toBe(true);
    expect(watching.text()).toContain(`"id":${id}`);
    expect((await call(r, '/api/admin/chat', { cookie: boss })).json.reports).toEqual([]);
    const again = await call(r, '/api/admin/chat/delete', { method: 'POST', cookie: boss, body });
    expect(again.json.duplicate).toBe(true);
    const log = db(r).all<{ action: string; target: string }>("SELECT action, target FROM admin_log WHERE action LIKE 'chat_%'");
    expect(log).toEqual([{ action: 'chat_delete', target: `message ${id}` }]);
    // The same request id for another message is refused, not applied.
    const other = plant(r, 'bob', 'other');
    const reused = await call(r, '/api/admin/chat/delete', { method: 'POST', cookie: boss, body: { requestId: 'delete-once-12345', messageId: other } });
    expect(reused.status).toBe(409);
    expect(texts(await chatOf(r, alice))).toContain('other');
    expect((await admin(r, boss, 'delete', { messageId: 424242 })).status).toBe(404);
  }, LONG);

  it('CHAT-17: a muted player cannot write for the time chosen, can still read, and is free again afterwards', async () => {
    const r = await boot();
    const { alice, bob, boss } = await room(r);
    await say(r, alice, 'before the mute');
    const watching = await listen(r, alice);
    const muted = await admin(r, boss, 'mute', { username: 'alice', minutes: 10, reason: 'spamming' });
    expect(muted.status).toBe(200);
    expect(muted.json.untilMs).toBe(r.clock.now() + 600_000);
    expect(await until(() => watching.text().includes('event: chat_status'))).toBe(true);
    r.clock.advanceSeconds(5);
    const blocked = await say(r, alice, 'let me talk');
    expect(blocked.status).toBe(403);
    expect(blocked.json.error.code).toBe('muted');
    expect(blocked.json.error.message).toMatch(/muted for another (9|10) minutes/);
    const view = await chatOf(r, alice);
    expect(view.you).toMatchObject({ canWrite: false, reason: 'muted' });
    expect(texts(view)).toEqual(['before the mute']);
    expect((await say(r, bob, 'bob is fine')).status).toBe(200);
    r.clock.advanceSeconds(600);
    expect((await chatOf(r, alice)).you.canWrite).toBe(true);
    expect((await say(r, alice, 'thanks')).status).toBe(200);
    expect(db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM chat_restrictions')?.n).toBe(0);
    const log = db(r).all<{ action: string; target: string }>("SELECT action, target FROM admin_log WHERE action LIKE 'chat_%'");
    expect(log).toEqual([{ action: 'chat_mute', target: 'alice' }]);
  }, LONG);

  it('CHAT-18: a mute needs a whole number of minutes, and the owner cannot be muted or banned from the chat', async () => {
    const r = await boot();
    const { boss } = await room(r);
    for (const minutes of [0, -5, 1.5, '10', null, undefined, 60 * 24 * 30 + 1]) {
      const out = await admin(r, boss, 'mute', { username: 'alice', minutes });
      expect(out.status).toBe(400);
      expect(out.json.error.code).toBe('bad_request');
    }
    expect((await admin(r, boss, 'mute', { username: 'alice', minutes: 60 * 24 * 30 })).status).toBe(200);
    expect((await admin(r, boss, 'mute', { username: 'boss', minutes: 5 })).json.error.code).toBe('cannot_moderate_owner');
    expect((await admin(r, boss, 'ban', { username: 'boss' })).json.error.code).toBe('cannot_moderate_owner');
    expect((await admin(r, boss, 'mute', { username: 'nobody-here', minutes: 5 })).status).toBe(404);
    expect((await admin(r, boss, 'ban', { username: '' })).status).toBe(404);
    expect((await call(r, '/api/admin/chat/mute', { method: 'POST', cookie: boss, body: { username: 'alice', minutes: 5 } })).status).toBe(400); // no request id
  }, LONG);

  it('CHAT-19: a chat ban lasts until the owner lifts it and never stops the player from playing; lifting something that is not there changes nothing', async () => {
    const r = await boot();
    const { alice, boss } = await room(r);
    expect((await admin(r, boss, 'ban', { username: 'alice', reason: 'insults' })).status).toBe(200);
    r.clock.advanceSeconds(60 * 60 * 24 * 10); // a ban has no end date (and ten days are less than a sign-in lasts)
    const blocked = await say(r, alice, 'hello');
    expect(blocked.status).toBe(403);
    expect(blocked.json.error.code).toBe('chat_banned');
    expect((await chatOf(r, alice)).you).toMatchObject({ canWrite: false, reason: 'banned', untilMs: null });
    // She can still use the game: the 1v1 lobby and her Career account.
    expect((await call(r, '/api/lobby/join', { method: 'POST', cookie: alice })).status).toBe(200);
    expect((await call(r, '/api/account/career', { cookie: alice })).status).not.toBe(401);
    // A timed mute cannot replace a ban; lifting the ban frees her.
    const mute = await admin(r, boss, 'mute', { username: 'alice', minutes: 5 });
    expect(mute.status).toBe(409);
    expect(mute.json.error.code).toBe('already_banned');
    expect((await admin(r, boss, 'lift', { username: 'alice' })).status).toBe(200);
    expect((await say(r, alice, 'sorry everyone')).status).toBe(200);
    const nothing = await admin(r, boss, 'lift', { username: 'alice' });
    expect(nothing.status).toBe(400);
    expect(nothing.json.error.code).toBe('not_restricted');
    const log = db(r).all<{ action: string }>("SELECT action FROM admin_log WHERE action LIKE 'chat_%' ORDER BY id").map((x) => x.action);
    expect(log).toEqual(['chat_ban', 'chat_lift']); // the refused lift left no log line
  }, LONG);

  it('CHAT-20: a ban can replace a mute; the player is told over his live stream when it starts or ends', async () => {
    const r = await boot();
    const { alice, boss } = await room(r);
    const watching = await listen(r, alice);
    await admin(r, boss, 'mute', { username: 'alice', minutes: 5 });
    await admin(r, boss, 'ban', { username: 'alice' });
    expect(db(r).get<{ kind: string; until_ms: number | null }>('SELECT kind, until_ms FROM chat_restrictions WHERE user_id = ?', idOf(r, 'alice'))).toEqual({ kind: 'ban', until_ms: null });
    await admin(r, boss, 'lift', { username: 'alice' });
    expect(await until(() => (watching.text().match(/event: chat_status/g) ?? []).length === 3)).toBe(true);
  }, LONG);

  it('CHAT-21: the admin view lists open reports (who, what, how many) and everybody who is muted or banned; dismissing closes a report but keeps the message', async () => {
    const r = await boot();
    const { alice, bob, boss } = await room(r);
    const rude = (await say(r, bob, 'rude words')).json.message.id as number;
    await call(r, '/api/chat/report', { method: 'POST', cookie: alice, body: { messageId: rude } });
    await call(r, '/api/chat/report', { method: 'POST', cookie: boss, body: { messageId: rude } });
    r.clock.advanceSeconds(2);
    const mild = (await say(r, alice, 'a bit rude')).json.message.id as number;
    await call(r, '/api/chat/report', { method: 'POST', cookie: bob, body: { messageId: mild } });
    await admin(r, boss, 'mute', { username: 'bob', minutes: 30, reason: 'rude' });
    const view = (await call(r, '/api/admin/chat', { cookie: boss })).json;
    expect(view.reports.map((x: any) => [x.messageId, x.reporters, x.username, x.restriction])).toEqual([
      [mild, 1, 'alice', null],
      [rude, 2, 'bob', 'mute'],
    ]);
    expect(view.reports[1].text).toBe('rude words');
    expect(view.restricted).toHaveLength(1);
    expect(view.restricted[0]).toMatchObject({ username: 'bob', kind: 'mute', reason: 'rude', by: 'boss' });
    expect(view.restricted[0].untilMs).toBe(r.clock.now() + 30 * 60_000);
    expect((await admin(r, boss, 'dismiss', { messageId: mild })).status).toBe(200);
    expect(texts(await chatOf(r, alice))).toContain('a bit rude');
    expect((await call(r, '/api/admin/chat', { cookie: boss })).json.reports.map((x: any) => x.messageId)).toEqual([rude]);
    // A mute that ran out is not listed any more.
    r.clock.advanceSeconds(31 * 60);
    expect((await call(r, '/api/admin/chat', { cookie: boss })).json.restricted).toEqual([]);
  }, LONG);
});

describe('small helpers', () => {
  it('CHAT-22: how long a wait still is, in words', () => {
    expect(waitText(0)).toBe('less than a minute');
    expect(waitText(59_000)).toBe('less than a minute');
    expect(waitText(60_000)).toBe('1 minute');
    expect(waitText(61_000)).toBe('2 minutes');
    expect(waitText(119 * 60_000)).toBe('119 minutes');
    expect(waitText(3 * 3_600_000)).toBe('3 hours');
    expect(waitText(3 * 86_400_000)).toBe('3 days');
  });
});

describe('storage', () => {
  it('CHAT-23: version 20 upgrades an older database without touching it (old matches are not friend matches), and its tables refuse impossible rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tq-chat-db-'));
    dirs.push(dir);
    const d = new Db(join(dir, 'x.sqlite'));
    try {
      for (const m of MIGRATIONS.filter((x) => x.version <= 19)) {
        d.exec(m.sql);
        d.exec(`PRAGMA user_version = ${m.version}`);
      }
      for (const id of [1, 2, 3]) d.run("INSERT INTO users(id, username, display_name, pw_hash, role, created_ms) VALUES (?, ?, ?, 'x', 'player', 1)", id, `u${id}`, `u${id}`);
      d.run("INSERT INTO matches(id, state, created_ms, duration_ticks, start_cash_cents) VALUES (7, 'lobby', 5, 180, 10000000)");
      expect(migrate(d)).toEqual([20, 21, 22, 23, 24]); // (24 adds the empty company-picture table) (21 adds the empty private-chat tables)
      expect(d.get<{ user_version: number }>('PRAGMA user_version')?.user_version).toBe(24);
      expect(d.all('SELECT id, state, friends FROM matches')).toEqual([{ id: 7, state: 'lobby', friends: 0 }]);
      for (const table of ['challenges', 'chat_messages', 'chat_restrictions', 'chat_reports']) expect(d.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n).toBe(0);
      expect(migrate(d)).toEqual([]);
      // A match is a friend match or it is not.
      expect(() => d.run('UPDATE matches SET friends = 2 WHERE id = 7')).toThrow();
      // A message is 1 to 1200 characters.
      expect(() => d.run("INSERT INTO chat_messages(user_id, body, created_ms) VALUES (1, '', 1)")).toThrow();
      expect(() => d.run('INSERT INTO chat_messages(user_id, body, created_ms) VALUES (1, ?, 1)', 'x'.repeat(1201))).toThrow();
      d.run('INSERT INTO chat_messages(user_id, body, created_ms) VALUES (1, ?, 1)', 'x'.repeat(1200));
      expect(() => d.run("INSERT INTO chat_messages(user_id, body, created_ms) VALUES (99, 'hi', 1)")).toThrow(); // a real player
      // A mute has an end, a ban has none.
      expect(() => d.run("INSERT INTO chat_restrictions(user_id, kind, until_ms, reason, created_ms, by_user_id) VALUES (2, 'mute', NULL, '', 1, 1)")).toThrow();
      expect(() => d.run("INSERT INTO chat_restrictions(user_id, kind, until_ms, reason, created_ms, by_user_id) VALUES (2, 'ban', 5, '', 1, 1)")).toThrow();
      expect(() => d.run("INSERT INTO chat_restrictions(user_id, kind, until_ms, reason, created_ms, by_user_id) VALUES (2, 'gag', NULL, '', 1, 1)")).toThrow();
      d.run("INSERT INTO chat_restrictions(user_id, kind, until_ms, reason, created_ms, by_user_id) VALUES (2, 'mute', 5, '', 1, 1)");
      expect(() => d.run("INSERT INTO chat_restrictions(user_id, kind, until_ms, reason, created_ms, by_user_id) VALUES (2, 'ban', NULL, '', 1, 1)")).toThrow(); // one row per player
      // A report is once per player and message.
      d.run('INSERT INTO chat_reports(message_id, reporter_id, created_ms) VALUES (1, 2, 1)');
      expect(() => d.run('INSERT INTO chat_reports(message_id, reporter_id, created_ms) VALUES (1, 2, 2)')).toThrow();
      // A challenge is between two different players and has to last.
      expect(() => d.run('INSERT INTO challenges(from_id, to_id, created_ms, expires_ms) VALUES (1, 1, 1, 2)')).toThrow();
      expect(() => d.run('INSERT INTO challenges(from_id, to_id, created_ms, expires_ms) VALUES (1, 2, 5, 5)')).toThrow();
      d.run('INSERT INTO challenges(from_id, to_id, created_ms, expires_ms) VALUES (1, 2, 1, 2)');
      expect(() => d.run('INSERT INTO challenges(from_id, to_id, created_ms, expires_ms) VALUES (1, 2, 1, 3)')).toThrow(); // one per pair and direction
      // A player who is deleted takes his challenges, messages and restrictions with him.
      d.run('DELETE FROM chat_reports');
      d.run('DELETE FROM users WHERE id = 2');
      expect(d.get<{ n: number }>('SELECT COUNT(*) AS n FROM challenges')?.n).toBe(0);
      expect(d.get<{ n: number }>('SELECT COUNT(*) AS n FROM chat_restrictions')?.n).toBe(0);
    } finally {
      d.close();
    }
  });
});
