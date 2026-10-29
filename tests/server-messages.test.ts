// Private chats over HTTP (server/messages.ts, docs/world.md §16). The properties that matter: only the members of a conversation can read it (the
// owner too), friends write at once while anybody else sends one request that has to be accepted, a blocked player cannot write or ask for
// friendship and his group messages are hidden, groups are small and run by their creator, text and pace follow the public chat's rules, the
// owner sees only what a player reports, and none of it touches money or the market.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../server/app';
import { CHAT_BURST, CHAT_MAX_LENGTH, MIN_GAP_MS, NEW_ACCOUNT_WAIT_MS } from '../server/chat';
import { loadConfig } from '../server/config';
import { Logger } from '../server/log';
import { MAX_BLOCKS, MAX_GROUPS, MAX_GROUP_MEMBERS, MAX_GROUP_TITLE, MAX_INVITES_WAITING, MAX_REQUESTS_IN, PM_KEEP, PM_PAGE, PM_REPORTS_PER_HOUR, REPORT_CONTEXT, REQUESTS_PER_DAY, GROUPS_PER_HOUR } from '../server/messages';
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
  const dir = mkdtempSync(join(tmpdir(), 'tq-pm-'));
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
  return { status: res.status, json, text };
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
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

const db = (r: Running) => r.app.services.db;
const idOf = (r: Running, name: string): number => (db(r).get<{ id: number }>('SELECT id FROM users WHERE username = ?', name) as { id: number }).id;
let nextRequest = 0;
const requestId = (): string => `pm-test-${(nextRequest += 1)}-abcdef`;

const post = (r: Running, cookie: string | undefined, path: string, body: unknown = {}) => call(r, `/api/messages/${path}`, { method: 'POST', cookie, body });
const inbox = async (r: Running, cookie: string) => (await call(r, '/api/messages', { cookie })).json;
const thread = (r: Running, cookie: string, id: number, query = '') => call(r, `/api/messages/thread/${id}${query}`, { cookie });
const texts = (page: any): string[] => page.messages.map((m: any) => m.text);
/** Sends a message (to a username or into a conversation) and then lets the pause between messages pass. */
async function tell(r: Running, cookie: string, to: string | number, text: unknown, wait = 2) {
  const res = await post(r, cookie, 'send', typeof to === 'number' ? { conversationId: to, text } : { username: to, text });
  r.clock.advanceSeconds(wait);
  return res;
}
const ask = (r: Running, cookie: string, path: string, name: string) => call(r, `/api/friends/${path}`, { method: 'POST', cookie, body: { username: name } });
async function befriend(r: Running, a: string, aName: string, b: string, bName: string): Promise<void> {
  expect((await ask(r, a, 'request', bName)).status).toBe(200);
  expect((await ask(r, b, 'accept', aName)).status).toBe(200);
}
const reportsOf = async (r: Running, boss: string) => (await call(r, '/api/admin/private-reports', { cookie: boss })).json.reports as any[];

/** Alice, Bob, Carol, Dave and the owner (boss), all old enough to write. */
async function world(r: Running) {
  const [alice, bob, carol, dave, boss] = [await signUp(r, 'alice'), await signUp(r, 'bob'), await signUp(r, 'carol'), await signUp(r, 'dave'), await signUp(r, 'boss')];
  r.clock.advanceSeconds(NEW_ACCOUNT_WAIT_MS / 1000 + 1);
  return { alice, bob, carol, dave, boss };
}

/** Adds players the rules did not meet (no password): returns their ids. */
function bulk(r: Running, prefix: string, count: number): number[] {
  const ids: number[] = [];
  for (let i = 0; i < count; i += 1) {
    ids.push(db(r).run("INSERT INTO users(username, display_name, pw_hash, role, created_ms) VALUES (?, ?, 'x', 'player', ?)", `${prefix}${i}`, `${prefix}${i}`, r.clock.now() - 10 * 60_000).lastInsertRowid);
  }
  return ids;
}
const pairOf = (a: number, b: number): [number, number] => (a < b ? [a, b] : [b, a]);
/** A direct chat that is a pending message request from `from` to `to`, made without the rules. */
function plantRequest(r: Running, from: number, to: number): number {
  const [a, b] = pairOf(from, to);
  const now = r.clock.now();
  const id = db(r).run("INSERT INTO conversations(kind, direct_a, direct_b, created_by, created_ms, last_ms, request, requester_id, request_ms) VALUES ('direct', ?, ?, ?, ?, ?, 'pending', ?, ?)", a, b, from, now, now, from, now).lastInsertRowid;
  for (const u of [from, to]) db(r).run("INSERT INTO conversation_members(conversation_id, user_id, state, joined_ms) VALUES (?, ?, 'member', ?)", id, u, now);
  db(r).run("INSERT INTO private_messages(conversation_id, user_id, body, created_ms) VALUES (?, ?, 'hello', ?)", id, from, now);
  return id;
}
/** A group that `creator` made and `members` joined, made without the rules. */
function plantGroup(r: Running, creator: number, title: string, members: number[] = []): number {
  const now = r.clock.now();
  const id = db(r).run("INSERT INTO conversations(kind, title, created_by, created_ms, last_ms) VALUES ('group', ?, ?, ?, ?)", title, creator, now, now).lastInsertRowid;
  for (const u of [creator, ...members]) db(r).run("INSERT INTO conversation_members(conversation_id, user_id, state, joined_ms) VALUES (?, ?, 'member', ?)", id, u, now);
  return id;
}
/** Puts many messages in one conversation without the rules. */
function flood(r: Running, conversationId: number, userId: number, count: number, prefix = 'm'): void {
  db(r).tx(() => {
    for (let i = 1; i <= count; i += 1) db(r).run('INSERT INTO private_messages(conversation_id, user_id, body, created_ms) VALUES (?, ?, ?, ?)', conversationId, userId, `${prefix}${i}`, r.clock.now());
  });
}

describe('who may read and write', () => {
  it('PM-1: every private-chat route needs a signed-in player; the owner routes need the owner', async () => {
    const r = await boot();
    const { alice } = await world(r);
    const routes: [string, string, unknown][] = [
      ['GET', '/api/messages', undefined],
      ['GET', '/api/messages/thread/1', undefined],
      ['POST', '/api/messages/send', { username: 'bob', text: 'hi' }],
      ['POST', '/api/messages/read', { conversationId: 1 }],
      ['POST', '/api/messages/respond', { conversationId: 1, answer: 'accept' }],
      ['POST', '/api/messages/report', { messageId: 1 }],
      ['POST', '/api/messages/block', { username: 'bob' }],
      ['POST', '/api/messages/unblock', { username: 'bob' }],
      ['POST', '/api/messages/group/create', { title: 'x', usernames: ['bob'] }],
      ['POST', '/api/messages/group/invite', { conversationId: 1, username: 'bob' }],
      ['POST', '/api/messages/group/remove', { conversationId: 1, username: 'bob' }],
      ['POST', '/api/messages/group/leave', { conversationId: 1 }],
      ['POST', '/api/messages/group/rename', { conversationId: 1, title: 'y' }],
      ['POST', '/api/messages/group/join', { conversationId: 1 }],
      ['POST', '/api/messages/group/visibility', { conversationId: 1, visibility: 'public' }],
      ['GET', '/api/messages/groups/public', undefined],
      ['GET', '/api/messages/picture/1', undefined],
      ['GET', '/api/admin/private-reports', undefined],
      ['POST', '/api/admin/private-reports/dismiss', { requestId: requestId(), messageId: 1 }],
    ];
    const wrong: string[] = [];
    for (const [method, path, body] of routes) {
      const res = await call(r, path, { method, body });
      if (res.status !== 401) wrong.push(`${method} ${path} anonymous -> ${res.status}`);
    }
    expect(wrong).toEqual([]);
    for (const [method, path, body] of routes.filter(([, p]) => p.startsWith('/api/admin/'))) {
      const res = await call(r, path, { method, body, cookie: alice });
      if (res.status !== 403) wrong.push(`${method} ${path} as a player -> ${res.status}`);
    }
    expect(wrong).toEqual([]);
  }, LONG);

  it('PM-2: a brand-new account can read but cannot write (or make a group) for five minutes; the owner can at once', async () => {
    const r = await boot();
    const [alice, bob, boss] = [await signUp(r, 'alice'), await signUp(r, 'bob'), await signUp(r, 'boss')];
    const view = await inbox(r, alice);
    expect(view.you).toMatchObject({ canWrite: false, reason: 'new_account', untilMs: r.clock.now() + NEW_ACCOUNT_WAIT_MS });
    expect(view.you.message).toMatch(/5 minutes/);
    const refused = await post(r, alice, 'send', { username: 'bob', text: 'hello' });
    expect(refused.status).toBe(403);
    expect(refused.json.error.code).toBe('too_new');
    expect((await post(r, alice, 'group/create', { title: 'club', usernames: ['bob'] })).json.error.code).toBe('too_new');
    // The owner writes at once; the new player can read it but not answer yet.
    const spoken = await tell(r, boss, 'alice', 'welcome');
    expect(spoken.status).toBe(200);
    const seen = await inbox(r, alice);
    expect(seen.requests).toHaveLength(1);
    expect((await thread(r, alice, spoken.json.conversationId)).status).toBe(200);
    expect((await post(r, alice, 'send', { conversationId: spoken.json.conversationId, text: 'thanks' })).json.error.code).toBe('too_new');
    r.clock.advanceSeconds(NEW_ACCOUNT_WAIT_MS / 1000 - 5);
    expect((await post(r, alice, 'send', { conversationId: spoken.json.conversationId, text: 'thanks' })).status).toBe(403);
    r.clock.advanceSeconds(5);
    expect((await post(r, alice, 'send', { conversationId: spoken.json.conversationId, text: 'thanks' })).status).toBe(200);
    expect((await inbox(r, alice)).you).toMatchObject({ canWrite: true, reason: null });
    expect(bob).toBeTruthy();
  }, LONG);

  it('PM-3: friends write to each other at once, in one conversation whichever of them starts it; unread counts and reading work', async () => {
    const r = await boot();
    const { alice, bob } = await world(r);
    await befriend(r, alice, 'alice', bob, 'bob');
    const first = await tell(r, alice, 'bob', 'hello bob');
    expect(first.status).toBe(200);
    expect(first.json.conversation).toMatchObject({ kind: 'direct', friends: true, canWrite: true, note: null, requestState: null, unread: 0 });
    const id = first.json.conversationId as number;
    // Bob sees it as an ordinary conversation, with one unread message.
    const seen = await inbox(r, bob);
    expect(seen.requests).toEqual([]);
    expect(seen.conversations).toHaveLength(1);
    expect(seen.conversations[0]).toMatchObject({ id, kind: 'direct', unread: 1, canWrite: true, friends: true, other: { username: 'alice' }, last: { text: 'hello bob', username: 'alice' } });
    expect(seen.unread).toBe(1);
    // Bob answers (by the conversation, then by name: the same conversation), which also reads what came before.
    expect((await tell(r, bob, id, 'hi alice')).status).toBe(200);
    const byName = await tell(r, bob, 'alice', 'how are you');
    expect(byName.json.conversationId).toBe(id);
    expect((await inbox(r, bob)).unread).toBe(0);
    expect((await inbox(r, alice)).conversations[0].unread).toBe(2);
    const page = (await thread(r, alice, id)).json;
    expect(texts(page)).toEqual(['hello bob', 'hi alice', 'how are you']);
    expect(page.messages.map((m: any) => m.username)).toEqual(['alice', 'bob', 'bob']);
    expect(page.more).toBe(false);
    // Reading up to a message, then to the end.
    await tell(r, alice, id, 'one');
    await tell(r, alice, id, 'two');
    await tell(r, alice, id, 'three');
    const bobs = (await inbox(r, bob)).conversations[0];
    expect(bobs.unread).toBe(3);
    const ids = (await thread(r, bob, id)).json.messages.map((m: any) => m.id) as number[];
    expect((await post(r, bob, 'read', { conversationId: id, upToId: ids[ids.length - 2] })).json).toEqual({ ok: true });
    expect((await inbox(r, bob)).conversations[0].unread).toBe(1);
    await post(r, bob, 'read', { conversationId: id });
    expect((await inbox(r, bob)).conversations[0].unread).toBe(0);
    // Reading never goes backwards.
    await post(r, bob, 'read', { conversationId: id, upToId: ids[0] });
    expect((await inbox(r, bob)).conversations[0].unread).toBe(0);
    // One conversation per pair.
    expect(db(r).get<{ n: number }>("SELECT COUNT(*) AS n FROM conversations WHERE kind = 'direct'")?.n).toBe(1);
  }, LONG);

  it('PM-4: only the members read a conversation: not another player, not the owner; and it never appears in the public chat', async () => {
    const r = await boot();
    const { alice, bob, carol, boss } = await world(r);
    await befriend(r, alice, 'alice', bob, 'bob');
    const id = (await tell(r, alice, 'bob', 'a secret between us')).json.conversationId as number;
    for (const [who, cookie] of [['carol', carol], ['boss', boss]] as const) {
      expect([who, (await thread(r, cookie, id)).status]).toEqual([who, 404]);
      expect([who, (await post(r, cookie, 'send', { conversationId: id, text: 'let me in' })).status]).toEqual([who, 404]);
      expect([who, (await post(r, cookie, 'read', { conversationId: id })).status]).toEqual([who, 404]);
      expect([who, (await post(r, cookie, 'respond', { conversationId: id, answer: 'accept' })).status]).toEqual([who, 404]);
      expect([who, (await post(r, cookie, 'group/leave', { conversationId: id })).status]).toEqual([who, 404]);
      const view = await inbox(r, cookie);
      expect([who, view.conversations, view.requests, view.unread]).toEqual([who, [], [], 0]);
    }
    const messageId = (await thread(r, alice, id)).json.messages[0].id as number;
    expect((await post(r, carol, 'report', { messageId })).status).toBe(404);
    expect((await post(r, boss, 'report', { messageId })).status).toBe(404);
    expect(await reportsOf(r, boss)).toEqual([]);
    const publicChat = await call(r, '/api/chat', { cookie: carol });
    expect(publicChat.text).not.toContain('secret');
    expect(JSON.stringify(await call(r, '/api/admin/private-reports', { cookie: boss }))).not.toContain('secret');
    // Conversation numbers that are not there, or not numbers.
    expect((await thread(r, alice, 99999)).status).toBe(404);
    expect((await call(r, '/api/messages/thread/abc', { cookie: alice })).status).toBe(400);
    expect((await call(r, '/api/messages/thread/0', { cookie: alice })).status).toBe(400);
  }, LONG);
});

describe('message requests', () => {
  it('PM-5: somebody who is not a friend sends one message as a request; the other accepts it, and then both can write', async () => {
    const r = await boot();
    const { alice, carol } = await world(r);
    const first = await tell(r, alice, 'carol', 'hi, can we talk?');
    expect(first.status).toBe(200);
    const id = first.json.conversationId as number;
    expect(first.json.conversation).toMatchObject({ friends: false, canWrite: false, requestState: 'waiting' });
    expect(first.json.conversation.note).toMatch(/not accepted/);
    // Alice cannot send a second one while it waits.
    const second = await tell(r, alice, id, 'hello??');
    expect(second.status).toBe(403);
    expect(second.json.error.code).toBe('waiting');
    expect((await tell(r, alice, 'carol', 'hello again')).json.error.code).toBe('waiting');
    // Carol sees a request, not a conversation; she can read it.
    const seen = await inbox(r, carol);
    expect(seen.conversations).toEqual([]);
    expect(seen.unread).toBe(0);
    expect(seen.requests).toHaveLength(1);
    expect(seen.requests[0]).toMatchObject({ kind: 'message', conversationId: id, from: { username: 'alice' }, text: 'hi, can we talk?' });
    const page = (await thread(r, carol, id)).json;
    expect(texts(page)).toEqual(['hi, can we talk?']);
    expect(page.conversation).toMatchObject({ requestState: 'incoming', friends: false });
    expect(page.conversation.note).toMatch(/not your friend/);
    // She says yes.
    const answered = await post(r, carol, 'respond', { conversationId: id, answer: 'accept' });
    expect(answered.status).toBe(200);
    expect(answered.json.requests).toEqual([]);
    expect(answered.json.conversations).toHaveLength(1);
    expect(db(r).get<{ request: string }>('SELECT request FROM conversations WHERE id = ?', id)?.request).toBe('accepted');
    expect((await tell(r, alice, id, 'great, thanks')).status).toBe(200);
    expect((await tell(r, carol, id, 'sure')).status).toBe(200);
    expect((await inbox(r, alice)).conversations[0]).toMatchObject({ canWrite: true, requestState: null, note: null });
    // There is nothing left to answer.
    expect((await post(r, carol, 'respond', { conversationId: id, answer: 'accept' })).json.error.code).toBe('no_request');
  }, LONG);

  it('PM-5b: nobody can answer his own request, and answers must be accept or decline', async () => {
    const r = await boot();
    const { alice, carol } = await world(r);
    const id = (await tell(r, alice, 'carol', 'hi')).json.conversationId as number;
    const own = await post(r, alice, 'respond', { conversationId: id, answer: 'accept' });
    expect([own.status, own.json.error.code]).toEqual([404, 'no_request']);
    expect(db(r).get<{ request: string }>('SELECT request FROM conversations WHERE id = ?', id)?.request).toBe('pending');
    expect((await post(r, carol, 'respond', { conversationId: id, answer: 'yes please' })).status).toBe(400);
    expect((await post(r, carol, 'respond', { conversationId: id })).status).toBe(400);
    expect((await post(r, carol, 'respond', { conversationId: 'x', answer: 'accept' })).status).toBe(400);
    expect((await post(r, carol, 'respond', { conversationId: 424242, answer: 'accept' })).status).toBe(404);
    expect(db(r).get<{ request: string }>('SELECT request FROM conversations WHERE id = ?', id)?.request).toBe('pending');
  }, LONG);

  it('PM-6: ignoring a request keeps the sender waiting without telling him; the other player can still write back, which accepts it', async () => {
    const r = await boot();
    const { alice, carol } = await world(r);
    const id = (await tell(r, alice, 'carol', 'hi')).json.conversationId as number;
    const waiting = await tell(r, alice, id, 'are you there');
    const ignored = await post(r, carol, 'respond', { conversationId: id, answer: 'decline' });
    expect(ignored.status).toBe(200);
    expect(ignored.json.requests).toEqual([]);
    expect(ignored.json.conversations).toEqual([]); // it does not clutter her list
    // Alice gets exactly the same answer as before: nothing says "ignored".
    const after = await tell(r, alice, id, 'are you there');
    expect([after.status, after.json.error.code, after.json.error.message]).toEqual([waiting.status, waiting.json.error.code, waiting.json.error.message]);
    expect((await inbox(r, alice)).conversations[0]).toMatchObject({ canWrite: false, requestState: 'waiting' });
    expect(JSON.stringify(await inbox(r, alice))).not.toMatch(/declin|ignor/i);
    // Carol writes to her by name later: that accepts the old request, and Alice can write again.
    const back = await tell(r, carol, 'alice', 'sorry, I missed this');
    expect(back.status).toBe(200);
    expect(back.json.conversationId).toBe(id);
    expect(db(r).get<{ request: string }>('SELECT request FROM conversations WHERE id = ?', id)?.request).toBe('accepted');
    expect((await tell(r, alice, id, 'no problem')).status).toBe(200);
    expect(texts((await thread(r, carol, id)).json)).toEqual(['hi', 'sorry, I missed this', 'no problem']); // what was refused never became a message
  }, LONG);

  it('PM-7: writing back to a request in its own conversation accepts it', async () => {
    const r = await boot();
    const { alice, carol } = await world(r);
    const id = (await tell(r, alice, 'carol', 'hello carol')).json.conversationId as number;
    expect((await tell(r, carol, id, 'hello alice')).status).toBe(200);
    expect(db(r).get<{ request: string }>('SELECT request FROM conversations WHERE id = ?', id)?.request).toBe('accepted');
    expect((await tell(r, alice, id, 'nice to meet you')).status).toBe(200);
    expect((await inbox(r, carol)).requests).toEqual([]);
  }, LONG);

  it('PM-8: becoming friends lifts the wait at once; after unfriending, the next message is a request again', async () => {
    const r = await boot();
    const { alice, carol } = await world(r);
    const id = (await tell(r, alice, 'carol', 'hi carol')).json.conversationId as number;
    expect((await tell(r, alice, id, 'hello?')).json.error.code).toBe('waiting');
    await befriend(r, alice, 'alice', carol, 'carol');
    expect((await tell(r, alice, id, 'now we are friends')).status).toBe(200);
    expect(db(r).get<{ request: string | null }>('SELECT request FROM conversations WHERE id = ?', id)?.request).toBeNull();
    const seen = await inbox(r, carol);
    expect(seen.requests).toEqual([]);
    expect(seen.conversations[0]).toMatchObject({ id, friends: true, unread: 2 });
    // Unfriend: the history stays, but writing starts a new request.
    expect((await ask(r, carol, 'remove', 'alice')).status).toBe(200);
    const again = await tell(r, alice, id, 'are we still talking');
    expect(again.status).toBe(200);
    expect(again.json.conversation).toMatchObject({ friends: false, requestState: 'waiting', canWrite: false });
    const requests = (await inbox(r, carol)).requests;
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ kind: 'message', conversationId: id, text: 'are we still talking' });
  }, LONG);

  it('PM-9: a player can ask only so many strangers a day, and only so many requests can wait at once', async () => {
    const r = await boot();
    const { alice } = await world(r);
    const ids = bulk(r, 'stranger', REQUESTS_PER_DAY + 2);
    for (let i = 0; i < REQUESTS_PER_DAY; i += 1) expect([i, (await tell(r, alice, `stranger${i}`, `hello ${i}`, 31)).status]).toEqual([i, 200]);
    const tooMany = await tell(r, alice, `stranger${REQUESTS_PER_DAY}`, 'hello more', 31);
    expect(tooMany.status).toBe(429);
    expect(tooMany.json.error.code).toBe('too_many_requests');
    // The next day the daily count starts again, but the ones still waiting are counted.
    r.clock.advanceSeconds(25 * 3600);
    const stillWaiting = await tell(r, alice, `stranger${REQUESTS_PER_DAY}`, 'hello more');
    expect(stillWaiting.status).toBe(409);
    expect(stillWaiting.json.error.code).toBe('too_many_requests');
    // One of them answers; the player can ask again.
    db(r).run("UPDATE conversations SET request = 'accepted' WHERE requester_id = ? AND id = (SELECT MIN(id) FROM conversations)", idOf(r, 'alice'));
    expect((await tell(r, alice, `stranger${REQUESTS_PER_DAY}`, 'hello more')).status).toBe(200);
    expect(ids).toHaveLength(REQUESTS_PER_DAY + 2);
  }, LONG);

  it('PM-10: a player with a lot of requests waiting for him cannot be sent more', async () => {
    const r = await boot();
    const { alice, dave } = await world(r);
    const senders = bulk(r, 'spam', MAX_REQUESTS_IN);
    for (const id of senders) plantRequest(r, id, idOf(r, 'dave'));
    const refused = await tell(r, alice, 'dave', 'hello dave');
    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe('cannot_message');
    // Dave sees them all as requests, newest first, and he can still write out himself.
    expect((await inbox(r, dave)).requests).toHaveLength(MAX_REQUESTS_IN);
    expect((await tell(r, dave, 'alice', 'hi alice')).status).toBe(200);
  }, LONG);
});

describe('blocking', () => {
  it('PM-11: blocking ends the friendship, the challenges and the invitations between two players, and stops all writing and friend requests', async () => {
    const r = await boot();
    const { alice, bob } = await world(r);
    await befriend(r, alice, 'alice', bob, 'bob');
    const id = (await tell(r, alice, 'bob', 'hello')).json.conversationId as number;
    const group = (await post(r, alice, 'group/create', { title: 'team', usernames: ['bob'] })).json.conversation.id as number;
    db(r).run('INSERT INTO challenges(from_id, to_id, created_ms, expires_ms) VALUES (?, ?, ?, ?)', idOf(r, 'bob'), idOf(r, 'alice'), r.clock.now(), r.clock.now() + 60_000);
    const watching = await listen(r, alice);
    const blocked = await post(r, alice, 'block', { username: 'bob' });
    expect(blocked.status).toBe(200);
    expect(blocked.json.blocked).toMatchObject([{ username: 'bob' }]);
    expect(await until(() => watching.text().includes('event: friends') && watching.text().includes('event: challenges'))).toBe(true);
    expect(db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM friendships')?.n).toBe(0);
    expect(db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM challenges')?.n).toBe(0);
    expect(db(r).get<{ n: number }>("SELECT COUNT(*) AS n FROM conversation_members WHERE conversation_id = ? AND user_id = ?", group, idOf(r, 'bob'))?.n).toBe(0);
    // Alice cannot write to him; he cannot write to her; neither can ask the other to be friends.
    const mine = await tell(r, alice, id, 'are you there');
    expect([mine.status, mine.json.error.code]).toEqual([403, 'blocked']);
    expect(mine.json.error.message).toMatch(/You blocked bob/);
    const his = await tell(r, bob, id, 'alice?');
    expect([his.status, his.json.error.code]).toEqual([403, 'cannot_message']);
    expect((await tell(r, bob, 'alice', 'alice?')).status).toBe(403);
    const ask1 = await ask(r, bob, 'request', 'alice');
    expect([ask1.status, ask1.json.error.code]).toEqual([403, 'cannot_request']);
    const ask2 = await ask(r, alice, 'request', 'bob');
    expect([ask2.status, ask2.json.error.code]).toEqual([409, 'blocked']);
    // He is not told: his lists have no sign of it, and he cannot invite her either.
    const his2 = await inbox(r, bob);
    expect(his2.blocked).toEqual([]);
    expect(his2.conversations[0]).toMatchObject({ id, canWrite: false });
    // Blocking again changes nothing, and nobody can block himself or a stranger.
    expect((await post(r, alice, 'block', { username: 'bob' })).json.blocked).toHaveLength(1);
    expect((await post(r, alice, 'block', { username: 'alice' })).status).toBe(400);
    expect((await post(r, alice, 'block', { username: 'nobody' })).status).toBe(404);
    expect((await post(r, alice, 'block', { username: 5 })).status).toBe(400);
  }, LONG);

  it('PM-11b: blocking a player whose request is waiting closes it, and he is not told', async () => {
    const r = await boot();
    const { alice, carol } = await world(r);
    const id = (await tell(r, carol, 'alice', 'buy my coin')).json.conversationId as number;
    expect((await inbox(r, alice)).requests).toHaveLength(1);
    const blocked = await post(r, alice, 'block', { username: 'carol' });
    expect(blocked.json.requests).toEqual([]);
    expect(blocked.json.conversations).toEqual([]);
    // Carol is still "waiting": nothing says she was blocked, and she cannot send more.
    const again = await tell(r, carol, id, 'hello??');
    expect([again.status, again.json.error.code]).toEqual([403, 'cannot_message']);
    expect(db(r).get<{ request: string }>('SELECT request FROM conversations WHERE id = ?', id)?.request).toBe('declined');
    // What she wrote before is hidden from Alice too, and she cannot report it any more.
    expect((await thread(r, alice, id)).status).toBe(404);
  }, LONG);

  it('PM-12: unblocking lets the two write again, but not as friends: it starts a request', async () => {
    const r = await boot();
    const { alice, bob } = await world(r);
    await befriend(r, alice, 'alice', bob, 'bob');
    await post(r, alice, 'block', { username: 'bob' });
    const un = await post(r, alice, 'unblock', { username: 'bob' });
    expect(un.status).toBe(200);
    expect(un.json.blocked).toEqual([]);
    expect((await ask(r, bob, 'request', 'alice')).status).toBe(200); // asking for friendship is possible again
    const res = await tell(r, bob, 'alice', 'hi again');
    expect(res.status).toBe(200);
    expect(res.json.conversation).toMatchObject({ friends: false, requestState: 'waiting' });
    expect((await inbox(r, alice)).requests).toHaveLength(1);
    // Unblocking somebody who is not blocked is harmless.
    expect((await post(r, alice, 'unblock', { username: 'bob' })).status).toBe(200);
  }, LONG);

  it('PM-13: nobody can block more than the limit', async () => {
    const r = await boot();
    const { alice } = await world(r);
    const others = bulk(r, 'blk', MAX_BLOCKS + 1);
    for (const id of others.slice(0, MAX_BLOCKS)) db(r).run('INSERT INTO blocks(blocker_id, blocked_id, created_ms) VALUES (?, ?, ?)', idOf(r, 'alice'), id, r.clock.now());
    const refused = await post(r, alice, 'block', { username: `blk${MAX_BLOCKS}` });
    expect([refused.status, refused.json.error.code]).toEqual([409, 'too_many_blocks']);
    expect((await post(r, alice, 'block', { username: 'blk0' })).status).toBe(200); // one already blocked is not counted twice
    expect((await post(r, alice, 'unblock', { username: 'blk0' })).status).toBe(200);
    expect((await post(r, alice, 'block', { username: `blk${MAX_BLOCKS}` })).status).toBe(200);
  }, LONG);

  it('PM-14: what a blocked player writes in a shared group is hidden from the player who blocked him, and nobody else', async () => {
    const r = await boot();
    const { alice, bob, carol } = await world(r);
    await befriend(r, alice, 'alice', bob, 'bob');
    await befriend(r, alice, 'alice', carol, 'carol');
    const group = (await post(r, alice, 'group/create', { title: 'trio', usernames: ['bob', 'carol'] })).json.conversation.id as number;
    await post(r, bob, 'respond', { conversationId: group, answer: 'accept' });
    r.clock.advanceSeconds(1);
    await post(r, carol, 'respond', { conversationId: group, answer: 'accept' });
    await tell(r, bob, group, 'bob says one');
    await tell(r, alice, group, 'alice says one');
    expect((await post(r, carol, 'block', { username: 'bob' })).status).toBe(200);
    const [forAlice, forCarol] = [await listen(r, alice), await listen(r, carol)];
    await tell(r, bob, group, 'bob says two');
    expect(await until(() => forAlice.text().includes('bob says two'))).toBe(true);
    await pause(150);
    expect(forCarol.text()).not.toContain('bob says');
    expect(texts((await thread(r, carol, group)).json)).toEqual(['alice says one']);
    expect(texts((await thread(r, alice, group)).json)).toEqual(['bob says one', 'alice says one', 'bob says two']);
    // Not in her unread count or the preview either.
    const view = (await inbox(r, carol)).conversations.find((c: any) => c.id === group);
    expect(view.unread).toBe(1);
    expect(view.last.text).toBe('alice says one');
    // Bob can still write in the group: nothing tells him.
    expect((await tell(r, bob, group, 'bob says three')).status).toBe(200);
    // And carol cannot report what she cannot see.
    const hidden = (await thread(r, alice, group)).json.messages[0].id as number;
    expect((await post(r, carol, 'report', { messageId: hidden })).status).toBe(404);
  }, LONG);

  it('PM-14b: what a player wrote in a group while the owner has him banned from the game is hidden from the others, and comes back when the ban ends', async () => {
    const r = await boot();
    const { alice, bob, carol } = await world(r);
    await befriend(r, alice, 'alice', bob, 'bob');
    await befriend(r, alice, 'alice', carol, 'carol');
    const group = (await post(r, alice, 'group/create', { title: 'trio', usernames: ['bob', 'carol'] })).json.conversation.id as number;
    await post(r, bob, 'respond', { conversationId: group, answer: 'accept' });
    r.clock.advanceSeconds(1);
    await post(r, carol, 'respond', { conversationId: group, answer: 'accept' });
    await tell(r, bob, group, 'bob says one');
    await tell(r, alice, group, 'alice says one');
    const until_ms = r.clock.now() + 60_000;
    db(r).run("INSERT INTO user_bans(user_id, reason, banned_ms, until_ms, by_user_id) VALUES (?, 'test', ?, ?, ?)", idOf(r, 'bob'), r.clock.now(), until_ms, idOf(r, 'boss'));
    expect(texts((await thread(r, carol, group)).json)).toEqual(['alice says one']);
    expect(texts((await thread(r, alice, group)).json)).toEqual(['alice says one']);
    const view = (await inbox(r, carol)).conversations.find((c: any) => c.id === group);
    expect(view.unread).toBe(1);
    expect(view.last.text).toBe('alice says one');
    // The ban ends by itself: what he wrote is there again.
    r.clock.advanceSeconds(61);
    expect(texts((await thread(r, carol, group)).json)).toEqual(['bob says one', 'alice says one']);
  }, LONG);
});

describe('groups', () => {
  it('PM-15: a group: the creator is in, friends are invited and must accept, and a new member does not see what was said before', async () => {
    const r = await boot();
    const { alice, bob, carol, dave } = await world(r);
    await befriend(r, alice, 'alice', bob, 'bob');
    await befriend(r, alice, 'alice', carol, 'carol');
    const made = await post(r, alice, 'group/create', { title: '  Trading   club ', usernames: ['bob', 'carol', 'bob'] });
    expect(made.status).toBe(200);
    const group = made.json.conversation;
    expect(group).toMatchObject({ kind: 'group', title: 'Trading club', creator: 'alice', canWrite: true, note: null });
    expect(group.members.map((m: any) => m.username)).toEqual(['alice']);
    expect(group.invited.map((m: any) => m.username).sort()).toEqual(['bob', 'carol']);
    const id = group.id as number;
    await tell(r, alice, id, 'welcome to the club');
    // Bob has an invitation, not a conversation, and cannot read or write yet.
    const seen = await inbox(r, bob);
    expect(seen.conversations).toEqual([]);
    expect(seen.requests).toMatchObject([{ kind: 'invite', conversationId: id, title: 'Trading club', from: { username: 'alice' }, memberCount: 1 }]);
    expect((await thread(r, bob, id)).status).toBe(404);
    expect((await tell(r, bob, id, 'let me in')).status).toBe(404);
    expect((await post(r, dave, 'respond', { conversationId: id, answer: 'accept' })).json.error.code).toBe('no_request');
    // Bob accepts: he reads from now on. Carol declines and is out.
    const watching = await listen(r, alice);
    const joined = await post(r, bob, 'respond', { conversationId: id, answer: 'accept' });
    expect(joined.status).toBe(200);
    expect(joined.json.requests).toEqual([]);
    expect(joined.json.conversations[0]).toMatchObject({ id, kind: 'group', unread: 0 });
    expect(await until(() => watching.text().includes('event: pm_changed'))).toBe(true);
    // Carol has not answered yet: she gets no live copy of what is said in the group.
    const carols = await listen(r, carol);
    await tell(r, alice, id, 'only for members');
    await pause(150);
    expect(carols.text()).not.toContain('only for members');
    expect((await post(r, carol, 'respond', { conversationId: id, answer: 'decline' })).json.requests).toEqual([]);
    expect((await thread(r, carol, id)).status).toBe(404);
    expect(texts((await thread(r, bob, id)).json)).toEqual(['only for members']); // bob joined before it was said, not before 'welcome'
    await tell(r, bob, id, 'thanks for having me');
    expect(texts((await thread(r, bob, id)).json)).toEqual(['only for members', 'thanks for having me']);
    expect(texts((await thread(r, alice, id)).json)).toEqual(['welcome to the club', 'only for members', 'thanks for having me']);
    const after = (await thread(r, alice, id)).json.conversation;
    expect(after.members.map((m: any) => m.username)).toEqual(['alice', 'bob']);
    expect(after.invited).toEqual([]);
  }, LONG);

  it('PM-16: a group is made only from friends, with a name, a sensible size, and not too often', async () => {
    const r = await boot();
    const { alice, bob, carol } = await world(r);
    await befriend(r, alice, 'alice', bob, 'bob');
    const bad = async (body: unknown, status: number, code: string) => {
      const res = await post(r, alice, 'group/create', body);
      expect([JSON.stringify(body), res.status, res.json?.error?.code]).toEqual([JSON.stringify(body), status, code]);
    };
    await bad({ title: 'x', usernames: ['carol'] }, 403, 'not_friends');
    await bad({ title: 'x', usernames: [] }, 400, 'bad_request');
    await bad({ title: 'x', usernames: 'bob' }, 400, 'bad_request');
    await bad({ title: 'x' }, 400, 'bad_request');
    await bad({ title: '   ', usernames: ['bob'] }, 400, 'bad_request');
    await bad({ title: 42, usernames: ['bob'] }, 400, 'bad_request');
    await bad({ title: 'y'.repeat(MAX_GROUP_TITLE + 1), usernames: ['bob'] }, 400, 'bad_request');
    await bad({ title: 'x', usernames: ['alice'] }, 400, 'bad_request');
    await bad({ title: 'x', usernames: ['nobody'] }, 404, 'no_such_player');
    await bad({ title: 'x', usernames: Array.from({ length: MAX_GROUP_MEMBERS }, (_, i) => `p${i}`) }, 400, 'group_full');
    expect(db(r).get<{ n: number }>("SELECT COUNT(*) AS n FROM conversations WHERE kind = 'group'")?.n).toBe(0);
    // The longest title allowed works.
    expect((await post(r, alice, 'group/create', { title: 'y'.repeat(MAX_GROUP_TITLE), usernames: ['bob'] })).status).toBe(200);
    // A friend who already has too many invitations waiting cannot be asked for another one.
    const makers = bulk(r, 'maker', MAX_INVITES_WAITING);
    makers.forEach((maker, i) => {
      const group = plantGroup(r, maker, `waiting${i}`);
      db(r).run("INSERT INTO conversation_members(conversation_id, user_id, state, invited_by, joined_ms) VALUES (?, ?, 'invited', ?, ?)", group, idOf(r, 'bob'), maker, r.clock.now());
    });
    r.clock.advanceSeconds(11);
    const crowded = await post(r, alice, 'group/create', { title: 'one more', usernames: ['bob'] });
    expect([crowded.status, crowded.json.error.code]).toEqual([409, 'cannot_message']);
    expect(carol).toBeTruthy();
  }, LONG);

  it('PM-17: a group holds at most the allowed number of players, invited ones counted; only its creator removes and renames', async () => {
    const r = await boot();
    const { alice, bob, carol } = await world(r);
    const extra = bulk(r, 'friend', MAX_GROUP_MEMBERS);
    for (const id of extra) db(r).run("INSERT INTO friendships(user_a, user_b, requester_id, status, created_ms, accepted_ms) VALUES (?, ?, ?, 'accepted', ?, ?)", ...pairOf(idOf(r, 'alice'), id), idOf(r, 'alice'), r.clock.now(), r.clock.now());
    await befriend(r, alice, 'alice', bob, 'bob');
    await befriend(r, alice, 'alice', carol, 'carol');
    const names = Array.from({ length: MAX_GROUP_MEMBERS - 2 }, (_, i) => `friend${i}`);
    const id = (await post(r, alice, 'group/create', { title: 'big', usernames: names })).json.conversation.id as number;
    // MAX - 1 players are in or invited: one more fits, the next does not.
    expect((await post(r, alice, 'group/invite', { conversationId: id, username: 'bob' })).status).toBe(200);
    const full = await post(r, alice, 'group/invite', { conversationId: id, username: 'carol' });
    expect([full.status, full.json.error.code]).toEqual([409, 'group_full']);
    // Somebody already in cannot be asked again.
    expect((await post(r, alice, 'group/invite', { conversationId: id, username: 'bob' })).status).toBe(409);
    // Bob joins; he is not the creator, so he cannot remove or rename. The size limit holds for him too when he invites.
    await post(r, bob, 'respond', { conversationId: id, answer: 'accept' });
    for (const [path, body] of [['group/remove', { username: 'friend0' }], ['group/rename', { title: 'mine now' }]] as const) {
      const res = await post(r, bob, path, { conversationId: id, ...body });
      expect([path, res.status, res.json.error.code]).toEqual([path, 403, 'not_creator']);
    }
    const bobFull = await post(r, bob, 'group/invite', { conversationId: id, username: 'carol' });
    expect([bobFull.status, bobFull.json.error.code]).toEqual([409, 'group_full']);
    // The creator renames, and the new name reaches everybody.
    const renamed = await post(r, alice, 'group/rename', { conversationId: id, title: 'the bigger club' });
    expect(renamed.json.conversation.title).toBe('the bigger club');
    expect((await inbox(r, bob)).conversations[0].title).toBe('the bigger club');
    expect((await post(r, alice, 'group/rename', { conversationId: id, title: '' })).status).toBe(400);
    // A direct chat is not a group.
    const direct = (await tell(r, alice, 'bob', 'hello')).json.conversationId as number;
    expect((await post(r, alice, 'group/rename', { conversationId: direct, title: 'x' })).status).toBe(404);
    expect((await post(r, alice, 'group/invite', { conversationId: direct, username: 'carol' })).status).toBe(404);
  }, LONG);

  it('PM-32: any member of a group invites his own friends, never somebody else\'s, and the friend still has to accept; the creator alone removes and renames', async () => {
    const r = await boot();
    const { alice, bob, carol } = await world(r);
    await befriend(r, alice, 'alice', bob, 'bob');
    await befriend(r, bob, 'bob', carol, 'carol');
    const id = (await post(r, alice, 'group/create', { title: 'club', usernames: ['bob'] })).json.conversation.id as number;
    // Bob has only been invited: he is not in the group yet, so he cannot invite anybody.
    const early = await post(r, bob, 'group/invite', { conversationId: id, username: 'carol' });
    expect([early.status, early.json.error.code]).toEqual([404, 'no_such_conversation']);
    await post(r, bob, 'respond', { conversationId: id, answer: 'accept' });
    // Alice is not carol's friend, so she cannot invite her; bob is, so he can. Dave is nobody's friend.
    const notHers = await post(r, alice, 'group/invite', { conversationId: id, username: 'carol' });
    expect([notHers.status, notHers.json.error.code]).toEqual([403, 'not_friends']);
    const stranger = await post(r, bob, 'group/invite', { conversationId: id, username: 'dave' });
    expect([stranger.status, stranger.json.error.code]).toEqual([403, 'not_friends']);
    const watching = await listen(r, alice);
    const asked = await post(r, bob, 'group/invite', { conversationId: id, username: 'carol' });
    expect(asked.status).toBe(200);
    expect(asked.json.conversation.invited.map((p: any) => p.username)).toEqual(['carol']);
    expect(await until(() => watching.text().includes('event: pm_changed'))).toBe(true);
    // The same friend cannot be asked twice; carol sees the invitation, from the member who asked her, and cannot read the group yet.
    expect((await post(r, bob, 'group/invite', { conversationId: id, username: 'carol' })).status).toBe(409);
    const seen = await inbox(r, carol);
    expect(seen.requests).toMatchObject([{ kind: 'invite', conversationId: id, title: 'club', from: { username: 'bob' }, memberCount: 2 }]);
    expect((await thread(r, carol, id)).status).toBe(404);
    expect((await post(r, carol, 'group/invite', { conversationId: id, username: 'bob' })).status).toBe(404);
    // She accepts. She can remove and rename nothing, but she can leave, and after that she cannot invite any more.
    await post(r, carol, 'respond', { conversationId: id, answer: 'accept' });
    for (const [path, body] of [['group/remove', { username: 'bob' }], ['group/rename', { title: 'mine' }]] as const) {
      const res = await post(r, carol, path, { conversationId: id, ...body });
      expect([path, res.status, res.json.error.code]).toEqual([path, 403, 'not_creator']);
    }
    expect((await thread(r, alice, id)).json.conversation.members.map((p: any) => p.username)).toEqual(['alice', 'bob', 'carol']);
    expect((await post(r, carol, 'group/leave', { conversationId: id })).status).toBe(200);
    const gone = await post(r, carol, 'group/invite', { conversationId: id, username: 'bob' });
    expect([gone.status, gone.json.error.code]).toEqual([404, 'no_such_conversation']);
  }, LONG);

  it('PM-18: the creator takes a player out or takes back an invitation; anybody leaves; the longest-standing member takes over; the last one out closes the group', async () => {
    const r = await boot();
    const { alice, bob, carol, dave } = await world(r);
    for (const [c, n] of [[bob, 'bob'], [carol, 'carol'], [dave, 'dave']] as const) await befriend(r, alice, 'alice', c, n);
    const id = (await post(r, alice, 'group/create', { title: 'crew', usernames: ['bob', 'carol', 'dave'] })).json.conversation.id as number;
    r.clock.advanceSeconds(1);
    await post(r, bob, 'respond', { conversationId: id, answer: 'accept' });
    r.clock.advanceSeconds(1);
    await post(r, carol, 'respond', { conversationId: id, answer: 'accept' });
    // Dave's invitation is taken back; carol is removed.
    expect((await post(r, alice, 'group/remove', { conversationId: id, username: 'dave' })).json.conversation.invited).toEqual([]);
    expect((await inbox(r, dave)).requests).toEqual([]);
    expect((await post(r, alice, 'group/remove', { conversationId: id, username: 'carol' })).status).toBe(200);
    expect((await thread(r, carol, id)).status).toBe(404);
    expect((await post(r, alice, 'group/remove', { conversationId: id, username: 'carol' })).status).toBe(404);
    expect((await post(r, alice, 'group/remove', { conversationId: id, username: 'alice' })).status).toBe(400);
    // The creator leaves: bob (the only one left) takes over.
    const left = await post(r, alice, 'group/leave', { conversationId: id });
    expect(left.status).toBe(200);
    expect(left.json.conversations).toEqual([]);
    expect((await thread(r, bob, id)).json.conversation).toMatchObject({ creator: 'bob' });
    expect((await thread(r, alice, id)).status).toBe(404);
    // The last one out closes the group and its messages.
    await tell(r, bob, id, 'anyone here');
    expect((await post(r, bob, 'group/leave', { conversationId: id })).status).toBe(200);
    expect(db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM conversations')?.n).toBe(0);
    expect(db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM private_messages')?.n).toBe(0);
    // A direct chat cannot be left.
    const direct = (await tell(r, bob, 'alice', 'hello')).json.conversationId as number;
    expect((await post(r, bob, 'group/leave', { conversationId: direct })).status).toBe(404);
  }, LONG);

  it('PM-19: with a successor chosen by who has been in the group longest; a player can be in only so many groups', async () => {
    const r = await boot();
    const { alice, bob, carol } = await world(r);
    await befriend(r, alice, 'alice', bob, 'bob');
    await befriend(r, alice, 'alice', carol, 'carol');
    const id = (await post(r, alice, 'group/create', { title: 'order', usernames: ['carol', 'bob'] })).json.conversation.id as number;
    r.clock.advanceSeconds(1);
    await post(r, carol, 'respond', { conversationId: id, answer: 'accept' });
    r.clock.advanceSeconds(1);
    await post(r, bob, 'respond', { conversationId: id, answer: 'accept' });
    await post(r, alice, 'group/leave', { conversationId: id });
    expect((await thread(r, bob, id)).json.conversation.creator).toBe('carol');
    // The most groups: Alice is in the most there can be, so she can neither make nor join another.
    const erin = await signUp(r, 'erin');
    r.clock.advanceSeconds(NEW_ACCOUNT_WAIT_MS / 1000 + 1);
    await befriend(r, alice, 'alice', erin, 'erin');
    for (let i = 0; i < MAX_GROUPS; i += 1) plantGroup(r, idOf(r, 'bob'), `filler${i}`, [idOf(r, 'alice')]);
    const full = await post(r, alice, 'group/create', { title: 'one too many', usernames: ['erin'] });
    expect([full.status, full.json.error.code]).toEqual([409, 'too_many_groups']);
    const asked = (await post(r, erin, 'group/create', { title: 'erin club', usernames: ['alice'] })).json.conversation.id as number;
    const refused = await post(r, alice, 'respond', { conversationId: asked, answer: 'accept' });
    expect([refused.status, refused.json.error.code]).toEqual([409, 'too_many_groups']);
    expect((await inbox(r, alice)).requests).toHaveLength(1); // the invitation is still there to accept later
  }, LONG);

  it('PM-20: groups are made only so often', async () => {
    const r = await boot();
    const { alice, bob } = await world(r);
    await befriend(r, alice, 'alice', bob, 'bob');
    for (let i = 0; i < GROUPS_PER_HOUR; i += 1) {
      expect([i, (await post(r, alice, 'group/create', { title: `club ${i}`, usernames: ['bob'] })).status]).toEqual([i, 200]);
      r.clock.advanceSeconds(11);
      // The invitations pile up for Bob; he answers them so that is not what limits Alice here.
      const waiting = (await inbox(r, bob)).requests[0];
      await post(r, bob, 'respond', { conversationId: waiting.conversationId, answer: 'decline' });
    }
    const slow = await post(r, alice, 'group/create', { title: 'one more', usernames: ['bob'] });
    expect([slow.status, slow.json.error.code]).toEqual([429, 'rate_limited']);
    r.clock.advanceSeconds(3600);
    expect((await post(r, alice, 'group/create', { title: 'one more', usernames: ['bob'] })).status).toBe(200);
  }, LONG);
});

describe('what a message may be', () => {
  it('PM-21: messages are plain one-line text: empty, too long and not-text messages are refused, and line breaks become spaces', async () => {
    const r = await boot();
    const { alice, bob } = await world(r);
    await befriend(r, alice, 'alice', bob, 'bob');
    const id = (await tell(r, alice, 'bob', 'first')).json.conversationId as number;
    const bad = async (text: unknown, status: number, code: string) => {
      const res = await tell(r, alice, id, text);
      expect([String(text).slice(0, 12), res.status, res.json?.error?.code]).toEqual([String(text).slice(0, 12), status, code]);
    };
    await bad('', 400, 'empty');
    await bad('   \n\t  ', 400, 'empty');
    await bad(42, 400, 'bad_request');
    await bad(null, 400, 'bad_request');
    await bad('x'.repeat(CHAT_MAX_LENGTH + 1), 400, 'too_long');
    expect((await tell(r, alice, id, 'x'.repeat(CHAT_MAX_LENGTH))).status).toBe(200);
    const cleaned = await tell(r, alice, id, '  two\nlines\r\n and\ttabs  ');
    expect(cleaned.json.message.text).toBe('two lines and tabs');
    // The text is shown as text: nothing is interpreted.
    const tag = await tell(r, alice, id, '<b>bold</b> & more');
    expect(tag.json.message.text).toBe('<b>bold</b> & more');
    expect((await tell(r, alice, id, 'x', 2)).status).toBe(200);
    // A conversation that is not a number, or not there.
    expect((await tell(r, alice, 'bob', 'ok', 11)).status).toBe(200);
    expect((await post(r, alice, 'send', { conversationId: 'one', text: 'hi' })).status).toBe(400);
    expect((await post(r, alice, 'send', { conversationId: -3, text: 'hi' })).status).toBe(400);
    expect((await post(r, alice, 'send', { conversationId: 1.5, text: 'hi' })).status).toBe(400);
    expect((await post(r, alice, 'send', { text: 'hi' })).status).toBe(400);
    expect((await post(r, alice, 'send', { username: 7, text: 'hi' })).status).toBe(400);
  }, LONG);

  it('PM-22: the pause between messages, the burst limit and not repeating the last message follow the public chat\'s rules', async () => {
    const r = await boot();
    const { alice, bob, carol } = await world(r);
    await befriend(r, alice, 'alice', bob, 'bob');
    await befriend(r, alice, 'alice', carol, 'carol');
    const toBob = (await tell(r, alice, 'bob', 'one', 0)).json.conversationId as number;
    const quick = await tell(r, alice, toBob, 'two', 0);
    expect([quick.status, quick.json.error.code]).toEqual([429, 'too_fast']);
    r.clock.advanceSeconds(MIN_GAP_MS / 1000);
    expect((await tell(r, alice, toBob, 'two', 0)).status).toBe(200);
    // The same words again within a minute: refused in that conversation (any capitals), fine in another one.
    r.clock.advanceSeconds(2);
    const again = await tell(r, alice, toBob, 'TWO', 0);
    expect([again.status, again.json.error.code]).toEqual([400, 'repeat']);
    expect((await tell(r, alice, 'carol', 'two', 0)).status).toBe(200);
    r.clock.advanceSeconds(61);
    expect((await tell(r, alice, toBob, 'TWO', 0)).status).toBe(200);
    // At most CHAT_BURST messages in half a minute, across all conversations.
    r.clock.advanceSeconds(31);
    let sent = 0;
    for (let i = 0; i < CHAT_BURST + 3; i += 1) {
      const res = await tell(r, alice, i % 2 === 0 ? toBob : 'carol', `burst ${i}`, 2);
      if (res.status === 200) sent += 1;
      else expect(res.json.error.code).toBe('too_fast');
    }
    expect(sent).toBe(CHAT_BURST);
  }, LONG);

  it('PM-23: only the newest PM_KEEP messages of a conversation are kept', async () => {
    const r = await boot();
    const { alice, bob } = await world(r);
    await befriend(r, alice, 'alice', bob, 'bob');
    const id = (await tell(r, alice, 'bob', 'start')).json.conversationId as number;
    flood(r, id, idOf(r, 'bob'), PM_KEEP + 5);
    expect((await tell(r, alice, id, 'the newest')).status).toBe(200);
    expect(db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM private_messages WHERE conversation_id = ?', id)?.n).toBe(PM_KEEP);
    const last = (await thread(r, bob, id)).json.messages.at(-1);
    expect(last.text).toBe('the newest');
    // Another conversation is not touched.
    const other = plantGroup(r, idOf(r, 'bob'), 'other', [idOf(r, 'alice')]);
    flood(r, other, idOf(r, 'bob'), 10);
    await tell(r, alice, id, 'and again');
    expect(db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM private_messages WHERE conversation_id = ?', other)?.n).toBe(10);
  }, LONG);

  it('PM-24: a conversation is read a page at a time, newest first, and older pages are asked for by the number of the oldest message seen', async () => {
    const r = await boot();
    const { alice, bob } = await world(r);
    await befriend(r, alice, 'alice', bob, 'bob');
    const id = (await tell(r, alice, 'bob', 'm1')).json.conversationId as number;
    flood(r, id, idOf(r, 'bob'), 119, 'n');
    const page1 = (await thread(r, alice, id)).json;
    expect(page1.messages).toHaveLength(PM_PAGE);
    expect(page1.more).toBe(true);
    expect(page1.messages.at(-1).text).toBe('n119');
    const page2 = (await thread(r, alice, id, `?before=${page1.messages[0].id}`)).json;
    expect(page2.messages).toHaveLength(PM_PAGE);
    expect(page2.more).toBe(true);
    expect(page2.messages.at(-1).id).toBeLessThan(page1.messages[0].id);
    const page3 = (await thread(r, alice, id, `?before=${page2.messages[0].id}`)).json;
    expect(page3.messages).toHaveLength(120 - 2 * PM_PAGE);
    expect(page3.more).toBe(false);
    expect(page3.messages[0].text).toBe('m1');
    expect((await thread(r, alice, id, '?limit=100')).json.messages).toHaveLength(100);
    expect((await thread(r, alice, id, '?limit=101')).status).toBe(400);
    expect((await thread(r, alice, id, '?limit=0')).status).toBe(400);
    expect((await thread(r, alice, id, '?before=abc')).status).toBe(400);
  }, LONG);

  it('PM-25: nobody can be written to who is not a real player: a computer player, a banned player, oneself or somebody who is not there', async () => {
    const r = await boot();
    const { alice, bob } = await world(r);
    await befriend(r, alice, 'alice', bob, 'bob');
    const id = (await tell(r, alice, 'bob', 'before the ban')).json.conversationId as number;
    await tell(r, bob, id, 'bob answers');
    const botId = db(r).run("INSERT INTO users(username, display_name, pw_hash, role, created_ms) VALUES ('robo-1', 'Robo', 'x', 'player', 1)").lastInsertRowid;
    db(r).run("INSERT INTO bots(user_id, persona) VALUES (?, 'test')", botId);
    const code = async (body: unknown) => {
      const res = await post(r, alice, 'send', body);
      return [res.status, res.json?.error?.code];
    };
    expect(await code({ username: 'robo-1', text: 'hi robot' })).toEqual([404, 'no_such_player']);
    expect(await code({ username: 'alice', text: 'hi me' })).toEqual([400, 'bad_request']);
    expect(await code({ username: 'nobody', text: 'hi' })).toEqual([404, 'no_such_player']);
    expect(await code({ username: '', text: 'hi' })).toEqual([404, 'no_such_player']);
    // The owner bans Bob from the game: he disappears from the chat, and nobody can write to him.
    db(r).run("INSERT INTO user_bans(user_id, reason, banned_ms, until_ms, by_user_id) VALUES (?, 'test', ?, NULL, ?)", idOf(r, 'bob'), r.clock.now(), idOf(r, 'boss'));
    expect(await code({ conversationId: id, text: 'still there?' })).toEqual([404, 'no_such_player']);
    expect(await code({ username: 'bob', text: 'still there?' })).toEqual([404, 'no_such_player']);
    expect((await inbox(r, alice)).conversations).toEqual([]);
    expect((await thread(r, alice, id)).status).toBe(404); // the conversation is not listed, so it cannot be opened
  }, LONG);
});

describe('reports', () => {
  async function group3(r: Running) {
    const w = await world(r);
    await befriend(r, w.alice, 'alice', w.bob, 'bob');
    await befriend(r, w.alice, 'alice', w.carol, 'carol');
    const id = (await post(r, w.alice, 'group/create', { title: 'trio', usernames: ['bob', 'carol'] })).json.conversation.id as number;
    await post(r, w.bob, 'respond', { conversationId: id, answer: 'accept' });
    r.clock.advanceSeconds(1);
    await post(r, w.carol, 'respond', { conversationId: id, answer: 'accept' });
    return { ...w, id };
  }

  it('PM-26: a member reports a message; the owner then sees that message and the few before it, nothing else, and a message can be reported once per player', async () => {
    const r = await boot();
    const { alice, bob, carol, boss, id } = await group3(r);
    for (let i = 1; i <= 8; i += 1) await tell(r, i % 2 === 0 ? alice : carol, id, `line ${i}`);
    const rude = (await tell(r, bob, id, 'rude words')).json.message.id as number;
    await tell(r, alice, id, 'a later line');
    expect(await reportsOf(r, boss)).toEqual([]);
    expect((await post(r, carol, 'report', { messageId: rude })).json).toEqual({ ok: true });
    expect((await post(r, carol, 'report', { messageId: rude })).status).toBe(200); // again: nothing changes
    const list = await reportsOf(r, boss);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ messageId: rude, kind: 'group', groupTitle: 'trio', reporters: 1, authorOpenReports: 1, author: { username: 'bob' } });
    expect(REPORT_CONTEXT).toBe(5);
    expect(list[0].lines.map((l: any) => l.text)).toEqual(['line 4', 'line 5', 'line 6', 'line 7', 'line 8', 'rude words']);
    expect(list[0].lines.filter((l: any) => l.reported).map((l: any) => l.text)).toEqual(['rude words']);
    expect(JSON.stringify(list)).not.toContain('a later line');
    // A second player reports it: still one entry, two reporters.
    expect((await post(r, alice, 'report', { messageId: rude })).status).toBe(200);
    expect((await reportsOf(r, boss))[0].reporters).toBe(2);
    expect(db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM private_reports')?.n).toBe(2);
    // Bad reports.
    expect((await post(r, bob, 'report', { messageId: rude })).json.error.code).toBe('bad_request'); // his own message
    expect((await post(r, alice, 'report', { messageId: 999999 })).status).toBe(404);
    expect((await post(r, alice, 'report', { messageId: 'x' })).status).toBe(400);
    const bossLine = await tell(r, boss, 'alice', 'from the owner');
    expect((await post(r, alice, 'report', { messageId: bossLine.json.message.id })).json.error.code).toBe('bad_request');
  }, LONG);

  it('PM-27: the report keeps its copy of the lines when the conversation is trimmed, left or deleted; a player cannot report too many', async () => {
    const r = await boot();
    const { alice, bob, carol, boss, id } = await group3(r);
    await tell(r, alice, id, 'before it');
    const rude = (await tell(r, bob, id, 'rude words')).json.message.id as number;
    await post(r, carol, 'report', { messageId: rude });
    for (const [c, n] of [[alice, 'alice'], [bob, 'bob'], [carol, 'carol']] as const) expect([n, (await post(r, c, 'group/leave', { conversationId: id })).status]).toEqual([n, 200]);
    expect(db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM conversations')?.n).toBe(0);
    const list = await reportsOf(r, boss);
    expect(list).toHaveLength(1);
    expect(list[0].lines.map((l: any) => l.text)).toEqual(['before it', 'rude words']);
    expect(list[0]).toMatchObject({ kind: null, groupTitle: null });
    // The most reports an hour.
    for (let i = 0; i < PM_REPORTS_PER_HOUR; i += 1) db(r).run('INSERT INTO private_reports(message_id, conversation_id, reporter_id, author_id, created_ms, context_json) VALUES (?, 0, ?, ?, ?, ?)', 9000 + i, idOf(r, 'alice'), idOf(r, 'bob'), r.clock.now(), '[]');
    await befriend(r, alice, 'alice', bob, 'bob');
    const fresh = (await tell(r, bob, 'alice', 'another rude one')).json.message.id as number;
    const slow = await post(r, alice, 'report', { messageId: fresh });
    expect([slow.status, slow.json.error.code]).toEqual([429, 'rate_limited']);
    r.clock.advanceSeconds(3601);
    expect((await post(r, alice, 'report', { messageId: fresh })).status).toBe(200);
  }, LONG);

  it('PM-28: the owner closes a report once per request, it is logged, and the messages stay where they are', async () => {
    const r = await boot();
    const { alice, bob, carol, boss, id } = await group3(r);
    const rude = (await tell(r, bob, id, 'rude words')).json.message.id as number;
    const mild = (await tell(r, alice, id, 'a bit rude')).json.message.id as number;
    await post(r, carol, 'report', { messageId: rude });
    await post(r, carol, 'report', { messageId: mild });
    const first = await call(r, '/api/admin/private-reports/dismiss', { method: 'POST', cookie: boss, body: { requestId: 'pm-dismiss-12345', messageId: rude } });
    expect([first.status, first.json]).toEqual([200, { ok: true, duplicate: false }]);
    expect((await reportsOf(r, boss)).map((x) => x.messageId)).toEqual([mild]);
    expect(texts((await thread(r, carol, id)).json)).toContain('rude words');
    const again = await call(r, '/api/admin/private-reports/dismiss', { method: 'POST', cookie: boss, body: { requestId: 'pm-dismiss-12345', messageId: rude } });
    expect(again.json.duplicate).toBe(true);
    expect(db(r).all("SELECT action, target FROM admin_log WHERE action = 'pm_dismiss'")).toEqual([{ action: 'pm_dismiss', target: `message ${rude}` }]);
    // The same request number for another message is refused, not applied; unknown messages and bad request numbers too.
    expect((await call(r, '/api/admin/private-reports/dismiss', { method: 'POST', cookie: boss, body: { requestId: 'pm-dismiss-12345', messageId: mild } })).status).toBe(409);
    expect((await reportsOf(r, boss)).map((x) => x.messageId)).toEqual([mild]);
    expect((await call(r, '/api/admin/private-reports/dismiss', { method: 'POST', cookie: boss, body: { requestId: requestId(), messageId: 424242 } })).status).toBe(404);
    expect((await call(r, '/api/admin/private-reports/dismiss', { method: 'POST', cookie: boss, body: { requestId: 'x', messageId: mild } })).status).toBe(400);
    // Reporting the same message again does not open it again.
    await post(r, carol, 'report', { messageId: rude });
    expect((await reportsOf(r, boss)).map((x) => x.messageId)).toEqual([mild]);
  }, LONG);
});

describe('live events', () => {
  it('PM-29: a new message reaches the members\' pages at once, and nobody else\'s; reading and answering tell the player\'s other pages', async () => {
    const r = await boot();
    const { alice, bob, carol } = await world(r);
    await befriend(r, alice, 'alice', bob, 'bob');
    const [forBob, forCarol, forAnon] = [await listen(r, bob), await listen(r, carol), await listen(r)];
    const sent = await tell(r, alice, 'bob', 'live hello');
    expect(await until(() => forBob.text().includes('event: pm\n'))).toBe(true);
    expect(forBob.text()).toContain('live hello');
    expect(forBob.text()).toContain(`"conversationId":${sent.json.conversationId}`);
    await pause(150);
    expect(forCarol.text()).not.toContain('live hello');
    expect(forAnon.text()).not.toContain('live hello');
    // Reading sends a nudge to the reader's pages.
    const before = (forBob.text().match(/event: pm_changed/g) ?? []).length;
    await post(r, bob, 'read', { conversationId: sent.json.conversationId });
    expect(await until(() => (forBob.text().match(/event: pm_changed/g) ?? []).length > before)).toBe(true);
    // A request reaches only its receiver; an invitation too.
    await tell(r, alice, 'carol', 'a request');
    expect(await until(() => forCarol.text().includes('a request'))).toBe(true);
    expect(forBob.text()).not.toContain('a request');
    const invited = (forCarol.text().match(/event: pm_changed/g) ?? []).length;
    const bobsNudges = (forBob.text().match(/event: pm_changed/g) ?? []).length;
    await post(r, alice, 'group/create', { title: 'live club', usernames: ['bob'] });
    expect(await until(() => (forBob.text().match(/event: pm_changed/g) ?? []).length > bobsNudges)).toBe(true);
    await pause(150);
    expect((forCarol.text().match(/event: pm_changed/g) ?? []).length).toBe(invited);
  }, LONG);
});

describe('the database and the code', () => {
  it('PM-30: version 21 upgrades an older database without touching it, and its tables refuse impossible rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tq-pm-db-'));
    dirs.push(dir);
    const d = new Db(join(dir, 'x.sqlite'));
    try {
      for (const m of MIGRATIONS.filter((x) => x.version <= 20)) {
        d.exec(m.sql);
        d.exec(`PRAGMA user_version = ${m.version}`);
      }
      for (const id of [1, 2, 3]) d.run("INSERT INTO users(id, username, display_name, pw_hash, role, created_ms) VALUES (?, ?, ?, 'x', 'player', 1)", id, `u${id}`, `u${id}`);
      expect(migrate(d)).toEqual([21, 22, 23, 24, 25, 26, 27, 28, 29]); // (29 adds ranked 1v1, daily goals and the away card; 28 adds the Shop's own-screen gear and the billboard; 27 adds the Shop; 26 adds public groups, pictures and the username log; 25 adds the empty moderator and badge tables; 24 adds the empty company-picture table; 23 adds the Learn tables; 22 adds deleting your own private message, pictures and the weekly marks)
      expect(d.get<{ user_version: number }>('PRAGMA user_version')?.user_version).toBe(29);
      for (const table of ['conversations', 'conversation_members', 'private_messages', 'blocks', 'private_reports']) expect(d.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n).toBe(0);
      expect(migrate(d)).toEqual([]);
      // A conversation is direct (two different players, the smaller number first) or a group (with a name).
      expect(() => d.run("INSERT INTO conversations(kind, created_ms, last_ms) VALUES ('direct', 1, 1)")).toThrow();
      expect(() => d.run("INSERT INTO conversations(kind, direct_a, direct_b, created_ms, last_ms) VALUES ('direct', 2, 1, 1, 1)")).toThrow();
      expect(() => d.run("INSERT INTO conversations(kind, direct_a, direct_b, created_ms, last_ms) VALUES ('direct', 1, 1, 1, 1)")).toThrow();
      expect(() => d.run("INSERT INTO conversations(kind, title, created_ms, last_ms) VALUES ('group', NULL, 1, 1)")).toThrow();
      expect(() => d.run("INSERT INTO conversations(kind, title, direct_a, direct_b, created_ms, last_ms) VALUES ('group', 'g', 1, 2, 1, 1)")).toThrow();
      expect(() => d.run("INSERT INTO conversations(kind, title, created_ms, last_ms) VALUES ('channel', 'g', 1, 1)")).toThrow();
      expect(() => d.run("INSERT INTO conversations(kind, direct_a, direct_b, created_ms, last_ms, request) VALUES ('direct', 1, 2, 1, 1, 'maybe')")).toThrow();
      const direct = d.run("INSERT INTO conversations(kind, direct_a, direct_b, created_ms, last_ms) VALUES ('direct', 1, 2, 1, 1)").lastInsertRowid;
      expect(() => d.run("INSERT INTO conversations(kind, direct_a, direct_b, created_ms, last_ms) VALUES ('direct', 1, 2, 2, 2)")).toThrow(); // one per pair
      const group = d.run("INSERT INTO conversations(kind, title, created_by, created_ms, last_ms) VALUES ('group', 'g', 1, 1, 1)").lastInsertRowid;
      d.run("INSERT INTO conversations(kind, title, created_ms, last_ms) VALUES ('group', 'g', 1, 1)"); // any number of groups with one name
      // Members: one row per player and conversation, a known state.
      d.run("INSERT INTO conversation_members(conversation_id, user_id, state, joined_ms) VALUES (?, 1, 'member', 1)", group);
      expect(() => d.run("INSERT INTO conversation_members(conversation_id, user_id, state, joined_ms) VALUES (?, 1, 'member', 2)", group)).toThrow();
      expect(() => d.run("INSERT INTO conversation_members(conversation_id, user_id, state, joined_ms) VALUES (?, 2, 'banned', 2)", group)).toThrow();
      expect(() => d.run("INSERT INTO conversation_members(conversation_id, user_id, state, joined_ms) VALUES (?, 99, 'member', 2)", group)).toThrow(); // a real player
      // A message is 1 to 1200 characters, by a real player, in a real conversation.
      expect(() => d.run("INSERT INTO private_messages(conversation_id, user_id, body, created_ms) VALUES (?, 1, '', 1)", group)).toThrow();
      expect(() => d.run('INSERT INTO private_messages(conversation_id, user_id, body, created_ms) VALUES (?, 1, ?, 1)', group, 'x'.repeat(1201))).toThrow();
      expect(() => d.run("INSERT INTO private_messages(conversation_id, user_id, body, created_ms) VALUES (?, 99, 'hi', 1)", group)).toThrow();
      expect(() => d.run("INSERT INTO private_messages(conversation_id, user_id, body, created_ms) VALUES (999, 1, 'hi', 1)")).toThrow();
      d.run('INSERT INTO private_messages(conversation_id, user_id, body, created_ms) VALUES (?, 1, ?, 1)', group, 'x'.repeat(1200));
      d.run("INSERT INTO private_messages(conversation_id, user_id, body, created_ms) VALUES (?, 2, 'hi', 1)", direct);
      // Blocks: not oneself, once.
      expect(() => d.run('INSERT INTO blocks(blocker_id, blocked_id, created_ms) VALUES (1, 1, 1)')).toThrow();
      d.run('INSERT INTO blocks(blocker_id, blocked_id, created_ms) VALUES (1, 2, 1)');
      expect(() => d.run('INSERT INTO blocks(blocker_id, blocked_id, created_ms) VALUES (1, 2, 2)')).toThrow();
      d.run('INSERT INTO blocks(blocker_id, blocked_id, created_ms) VALUES (2, 1, 1)');
      // Reports: once per player and message.
      d.run("INSERT INTO private_reports(message_id, conversation_id, reporter_id, author_id, created_ms, context_json) VALUES (5, 1, 2, 1, 1, '[]')");
      expect(() => d.run("INSERT INTO private_reports(message_id, conversation_id, reporter_id, author_id, created_ms, context_json) VALUES (5, 1, 2, 1, 2, '[]')")).toThrow();
      d.run("INSERT INTO private_reports(message_id, conversation_id, reporter_id, author_id, created_ms, context_json) VALUES (5, 1, 3, 1, 2, '[]')");
      // A player who is deleted takes his chats, blocks and messages with him; a group stays without its creator.
      d.run('DELETE FROM users WHERE id = 1');
      expect(d.get<{ n: number }>('SELECT COUNT(*) AS n FROM conversations WHERE id = ?', direct)?.n).toBe(0);
      expect(d.get<{ n: number }>('SELECT COUNT(*) AS n FROM private_messages')?.n).toBe(0);
      expect(d.get<{ n: number }>('SELECT COUNT(*) AS n FROM blocks')?.n).toBe(0);
      expect(d.get<{ created_by: number | null }>('SELECT created_by FROM conversations WHERE id = ?', group)?.created_by).toBeNull();
    } finally {
      d.close();
    }
  });

  it('PM-31: private chats never touch money or the market, and use no clock or dice of their own', () => {
    const source = readFileSync(join(process.cwd(), 'server', 'messages.ts'), 'utf8');
    const code = source.replace(/\/\/.*$/gm, '').replace(/`[^`]*`/g, '``');
    for (const word of ['accounts', 'positions', 'cash_cents', 'trading', 'orders', 'Math.random', 'Date.now', 'new Date', 'setTimeout', 'setInterval']) expect([word, code.includes(word)]).toEqual([word, false]);
    // Everything that a message does goes through the rules in this one file: the routes only call it.
    const routes = readFileSync(join(process.cwd(), 'server', 'routes', 'messages.ts'), 'utf8');
    expect(routes).not.toMatch(/INSERT|UPDATE|DELETE|SELECT/);
  });
});
