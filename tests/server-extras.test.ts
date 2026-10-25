// The small extras around the chats (docs/world.md §18): deleting your own message (public and private), profile pictures, the online dot and the
// weekly leaderboard. The properties that matter: only the writer can delete his message and it is gone for everybody at once, a report already
// made keeps its evidence; a picture is only accepted when it really is a small JPEG, PNG or WebP (a tiny file can claim to be a huge picture),
// everybody signed in sees it, the owner can remove any and it is logged; "online" means a page is open; the weekly board ranks the growth since
// Monday 00:00 Tokyo time as a percentage, leaves out the owner, the computer players and banned players, and remembers last week's best three.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../server/app';
import { NEW_ACCOUNT_WAIT_MS } from '../server/chat';
import { loadConfig } from '../server/config';
import { Logger } from '../server/log';
import { AVATAR_CHANGES_PER_HOUR, AVATAR_MAX_BYTES, AVATAR_MAX_SIDE, decodePicture, imageSize } from '../server/profile';
import { MIGRATIONS } from '../server/schema';
import { WEEKLY_MIN_START_CENTS, WEEK_MS, weekStartOf } from '../server/social';
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
  const dir = mkdtempSync(join(tmpdir(), 'tq-extras-'));
  dirs.push(dir);
  const clock = new Clock();
  const config = loadConfig({ TQ_DATA_DIR: dir, TQ_COMPANIES: '12', TQ_WARMUP_DAYS: '1', TQ_PORT: '8787', TQ_OWNER: 'boss' });
  const app = createApp({ config, log: new Logger({ sink: null, now: clock.now }), worldSeed: 777, now: clock.now, flowGain: 0 });
  const server = createServer(app.handler);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const r = { app, server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, dir, clock };
  running.push(r);
  return r;
}

async function call(r: Running, path: string, init: { method?: string; body?: unknown; cookie?: string; raw?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.body !== undefined || init.raw !== undefined) headers['Content-Type'] = 'application/json';
  if (init.cookie) headers.Cookie = init.cookie;
  const res = await fetch(r.base + path, { method: init.method ?? 'GET', headers, body: init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body)) });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, headers: res.headers };
}

async function signUp(r: Running, name: string): Promise<string> {
  const res = await fetch(r.base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: name, password: PASSWORD }) });
  expect(res.status).toBe(201);
  return (res.headers.get('set-cookie') ?? '').split(';')[0] as string;
}

async function listen(r: Running, cookie?: string): Promise<{ text(): string; close(): void }> {
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
  return { text: () => text, close: () => controller.abort() };
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
const requestId = (): string => `extras-test-${(nextRequest += 1)}-abcdef`;
const ask = (r: Running, cookie: string, path: string, name: string) => call(r, `/api/friends/${path}`, { method: 'POST', cookie, body: { username: name } });
async function befriend(r: Running, a: string, aName: string, b: string, bName: string): Promise<void> {
  expect((await ask(r, a, 'request', bName)).status).toBe(200);
  expect((await ask(r, b, 'accept', aName)).status).toBe(200);
}
/** Alice, Bob, Carol and the owner (boss), all old enough to write. */
async function world(r: Running) {
  const [alice, bob, carol, boss] = [await signUp(r, 'alice'), await signUp(r, 'bob'), await signUp(r, 'carol'), await signUp(r, 'boss')];
  r.clock.advanceSeconds(NEW_ACCOUNT_WAIT_MS / 1000 + 1);
  return { alice, bob, carol, boss };
}

// ---- pictures made by hand: only the bytes the server looks at --------------------------------------------------------

function png(width: number, height: number, extra = 0): Uint8Array {
  const b = new Uint8Array(33 + extra);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 0);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}
function jpeg(width: number, height: number): Uint8Array {
  // start, a comment segment, then the frame header (SOF0): length 17, precision 8, height, width, 3 components
  const b = new Uint8Array([0xff, 0xd8, 0xff, 0xfe, 0x00, 0x04, 0x68, 0x69, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);
  return b;
}
function webpLossy(width: number, height: number): Uint8Array {
  const b = new Uint8Array(40);
  b.set([0x52, 0x49, 0x46, 0x46, 32, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20, 20, 0, 0, 0, 0, 0, 0, 0x9d, 0x01, 0x2a], 0);
  new DataView(b.buffer).setUint16(26, width, true);
  new DataView(b.buffer).setUint16(28, height, true);
  return b;
}
const url = (mime: string, bytes: Uint8Array): string => `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
const setPicture = (r: Running, cookie: string | undefined, image: unknown) => call(r, '/api/profile/avatar', { method: 'POST', cookie, body: { image } });

describe('deleting your own message', () => {
  it('EXTRA-1: a player deletes his own chat message; it is gone for everybody at once; nobody else can delete it', async () => {
    const r = await boot();
    const { alice, bob } = await world(r);
    const said = await call(r, '/api/chat/send', { method: 'POST', cookie: alice, body: { text: 'oops wrong chat' } });
    const id = said.json.message.id as number;
    r.clock.advanceSeconds(2);
    await call(r, '/api/chat/send', { method: 'POST', cookie: bob, body: { text: 'hello' } });
    const watching = await listen(r, bob);
    expect((await call(r, '/api/chat/delete', { method: 'POST', cookie: bob, body: { messageId: id } })).status).toBe(403);
    expect((await call(r, '/api/chat/delete', { method: 'POST', body: { messageId: id } })).status).toBe(401);
    expect(((await call(r, '/api/chat', { cookie: bob })).json.messages as any[]).map((m) => m.text)).toEqual(['oops wrong chat', 'hello']);
    expect((await call(r, '/api/chat/delete', { method: 'POST', cookie: alice, body: { messageId: id } })).status).toBe(200);
    expect(((await call(r, '/api/chat', { cookie: bob })).json.messages as any[]).map((m) => m.text)).toEqual(['hello']);
    expect(await until(() => watching.text().includes('event: chat_removed'))).toBe(true);
    expect(watching.text()).toContain(`"id":${id}`);
    // again: nothing changes, and no second notice
    expect((await call(r, '/api/chat/delete', { method: 'POST', cookie: alice, body: { messageId: id } })).status).toBe(200);
    expect((watching.text().match(/event: chat_removed/g) ?? []).length).toBe(1);
    expect((await call(r, '/api/chat/delete', { method: 'POST', cookie: alice, body: { messageId: 99999 } })).status).toBe(404);
    for (const bad of ['1', 0, -1, 1.5, null]) expect((await call(r, '/api/chat/delete', { method: 'POST', cookie: alice, body: { messageId: bad } })).status).toBe(400);
    expect(db(r).get<{ deleted_by: number }>('SELECT deleted_by FROM chat_messages WHERE id = ?', id)?.deleted_by).toBe(idOf(r, 'alice'));
  }, LONG);

  it('EXTRA-2: deleting a message that was reported does not make the report go away: the owner still sees it and can punish the writer', async () => {
    const r = await boot();
    const { alice, bob, boss } = await world(r);
    const id = (await call(r, '/api/chat/send', { method: 'POST', cookie: bob, body: { text: 'rude words' } })).json.message.id as number;
    await call(r, '/api/chat/report', { method: 'POST', cookie: alice, body: { messageId: id } });
    await call(r, '/api/chat/delete', { method: 'POST', cookie: bob, body: { messageId: id } });
    const view = (await call(r, '/api/admin/chat', { cookie: boss })).json;
    expect(view.reports.map((x: any) => [x.messageId, x.text, x.username])).toEqual([[id, 'rude words', 'bob']]);
    // the message can no longer be reported by anybody else, and the owner can still close the report
    expect((await call(r, '/api/chat/report', { method: 'POST', cookie: alice, body: { messageId: id } })).status).toBe(404);
    const closed = await call(r, '/api/admin/chat/dismiss', { method: 'POST', cookie: boss, body: { requestId: requestId(), messageId: id } });
    expect(closed.status).toBe(200);
    expect((await call(r, '/api/admin/chat', { cookie: boss })).json.reports).toEqual([]);
    // a message the OWNER deleted is not shown again by this rule
    r.clock.advanceSeconds(5);
    const other = (await call(r, '/api/chat/send', { method: 'POST', cookie: bob, body: { text: 'again rude' } })).json.message.id as number;
    await call(r, '/api/chat/report', { method: 'POST', cookie: alice, body: { messageId: other } });
    await call(r, '/api/admin/chat/delete', { method: 'POST', cookie: boss, body: { requestId: requestId(), messageId: other } });
    expect((await call(r, '/api/admin/chat', { cookie: boss })).json.reports).toEqual([]);
  }, LONG);

  it('EXTRA-3: in a private chat the writer deletes his own message for both sides; nobody else can; a report made before keeps its copy', async () => {
    const r = await boot();
    const { alice, bob, boss } = await world(r);
    await befriend(r, alice, 'alice', bob, 'bob');
    const send = async (cookie: string, to: string | number, text: string) => {
      const res = await call(r, '/api/messages/send', { method: 'POST', cookie, body: typeof to === 'number' ? { conversationId: to, text } : { username: to, text } });
      r.clock.advanceSeconds(2);
      return res;
    };
    const first = await send(alice, 'bob', 'first');
    expect(first.status).toBe(200);
    const cid = first.json.conversationId as number;
    const mid = (await send(alice, cid, 'secret mistake')).json.message.id as number;
    await send(bob, cid, 'reply');
    const texts = async (cookie: string) => ((await call(r, `/api/messages/thread/${cid}`, { cookie })).json.messages as any[]).map((m) => m.text);
    expect(await texts(bob)).toEqual(['first', 'secret mistake', 'reply']);
    // Bob reports it, then Alice deletes it: the owner keeps what was reported
    expect((await call(r, '/api/messages/report', { method: 'POST', cookie: bob, body: { messageId: mid } })).status).toBe(200);
    const watching = await listen(r, bob);
    expect((await call(r, '/api/messages/delete', { method: 'POST', cookie: bob, body: { messageId: mid } })).status).toBe(403);
    expect((await call(r, '/api/messages/delete', { method: 'POST', body: { messageId: mid } })).status).toBe(401);
    expect((await call(r, '/api/messages/delete', { method: 'POST', cookie: alice, body: { messageId: mid } })).status).toBe(200);
    expect(await texts(alice)).toEqual(['first', 'reply']);
    expect(await texts(bob)).toEqual(['first', 'reply']);
    expect(await until(() => watching.text().includes('event: pm_deleted'))).toBe(true);
    expect(watching.text()).toContain(`"conversationId":${cid},"id":${mid}`);
    expect(await until(() => watching.text().includes('event: pm_changed'))).toBe(true);
    const reports = (await call(r, '/api/admin/private-reports', { cookie: boss })).json.reports as any[];
    expect(JSON.stringify(reports)).toContain('secret mistake');
    // deleting again is fine; a message that is not in your chats is "gone"; the table keeps the row (the writing-speed limits still count it)
    expect((await call(r, '/api/messages/delete', { method: 'POST', cookie: alice, body: { messageId: mid } })).status).toBe(200);
    expect((await call(r, '/api/messages/delete', { method: 'POST', cookie: alice, body: { messageId: 99999 } })).status).toBe(404);
    expect(db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM private_messages WHERE id = ? AND deleted_ms IS NOT NULL', mid)?.n).toBe(1);
    // a deleted message can no longer be reported, and the last message of the chat list is the newest one still there
    expect((await call(r, '/api/messages/report', { method: 'POST', cookie: bob, body: { messageId: mid } })).status).toBe(404);
    const inbox = (await call(r, '/api/messages', { cookie: bob })).json;
    expect(inbox.conversations[0].last.text).toBe('reply');
    // Carol is not in the chat: she cannot delete anything there
    const carol = await signUp(r, 'carol2');
    expect((await call(r, '/api/messages/delete', { method: 'POST', cookie: carol, body: { messageId: mid } })).status).toBe(404);
  }, LONG);

  it('EXTRA-4: a deleted private message does not count as unread', async () => {
    const r = await boot();
    const { alice, bob } = await world(r);
    await befriend(r, alice, 'alice', bob, 'bob');
    const a = await call(r, '/api/messages/send', { method: 'POST', cookie: alice, body: { username: 'bob', text: 'one' } });
    r.clock.advanceSeconds(2);
    const cid = a.json.conversationId as number;
    const b = await call(r, '/api/messages/send', { method: 'POST', cookie: alice, body: { conversationId: cid, text: 'two' } });
    expect((await call(r, '/api/messages', { cookie: bob })).json.conversations[0].unread).toBe(2);
    await call(r, '/api/messages/delete', { method: 'POST', cookie: alice, body: { messageId: b.json.message.id } });
    expect((await call(r, '/api/messages', { cookie: bob })).json.conversations[0].unread).toBe(1);
  }, LONG);
});

describe('image checks', () => {
  it('EXTRA-5: the size is read from the picture itself, for PNG, JPEG and WebP; anything else is null', () => {
    expect(imageSize(png(128, 96), 'image/png')).toEqual({ width: 128, height: 96 });
    expect(imageSize(jpeg(120, 80), 'image/jpeg')).toEqual({ width: 120, height: 80 });
    expect(imageSize(webpLossy(64, 32), 'image/webp')).toEqual({ width: 64, height: 32 });
    expect(imageSize(png(10, 10), 'image/jpeg')).toBeNull();
    expect(imageSize(jpeg(10, 10), 'image/png')).toBeNull();
    expect(imageSize(new Uint8Array([1, 2, 3]), 'image/webp')).toBeNull();
    expect(imageSize(new Uint8Array(0), 'image/jpeg')).toBeNull();
    // a JPEG that ends before its frame header
    expect(imageSize(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 2]), 'image/jpeg')).toBeNull();
  });

  it('EXTRA-6: a picture is taken only when it is a small, real JPEG, PNG or WebP', () => {
    expect(decodePicture(url('image/png', png(128, 128))).mime).toBe('image/png');
    expect(() => decodePicture(123)).toThrow(/text/);
    expect(() => decodePicture('hello')).toThrow(/JPEG, PNG or WebP/);
    expect(() => decodePicture(url('image/gif', png(8, 8)))).toThrow(/JPEG, PNG or WebP/);
    expect(() => decodePicture(url('image/svg+xml', new TextEncoder().encode('<svg onload="x()"/>')))).toThrow(/JPEG, PNG or WebP/);
    expect(() => decodePicture('data:image/png;base64,%%%')).toThrow(/JPEG, PNG or WebP/);
    expect(() => decodePicture(url('image/png', jpeg(8, 8)))).toThrow(/not a real picture/); // says PNG, is JPEG
    expect(() => decodePicture(url('image/png', new TextEncoder().encode('<html><script>alert(1)</script></html>') as Uint8Array))).toThrow(/not a real picture/);
    expect(() => decodePicture(url('image/png', png(AVATAR_MAX_SIDE + 1, 10)))).toThrow(/pixels/);
    expect(() => decodePicture(url('image/png', png(0, 10)))).toThrow(/not a real picture/);
    expect(() => decodePicture(url('image/png', png(8, 8, AVATAR_MAX_BYTES)))).toThrow(/too big/);
    expect(() => decodePicture(url('image/png', png(AVATAR_MAX_SIDE, AVATAR_MAX_SIDE, AVATAR_MAX_BYTES - 33)))).not.toThrow();
  });
});

describe('profile pictures', () => {
  it('EXTRA-7: listing, showing and changing pictures need a signed-in player; the owner route needs the owner', async () => {
    const r = await boot();
    const { alice } = await world(r);
    expect((await call(r, '/api/avatars')).status).toBe(401);
    expect((await call(r, '/api/avatar/alice')).status).toBe(401);
    expect((await call(r, '/api/online')).status).toBe(401);
    expect((await setPicture(r, undefined, url('image/png', png(8, 8)))).status).toBe(401);
    expect((await call(r, '/api/profile/avatar/remove', { method: 'POST' })).status).toBe(401);
    expect((await call(r, '/api/admin/avatar/remove', { method: 'POST', cookie: alice, body: { requestId: requestId(), username: 'alice' } })).status).toBe(403);
    expect((await call(r, '/api/avatars', { cookie: alice })).json).toEqual({ avatars: {} });
    expect((await call(r, '/api/avatar/alice', { cookie: alice })).status).toBe(404);
  }, LONG);

  it('EXTRA-8: a picture is stored as it came, shown to every signed-in player with safe headers, and a new one replaces it', async () => {
    const r = await boot();
    const { alice, bob } = await world(r);
    const watching = await listen(r, bob);
    const bytes = jpeg(128, 128);
    const set = await setPicture(r, alice, url('image/jpeg', bytes));
    expect(set.status).toBe(200);
    const v1 = set.json.version as number;
    expect((await call(r, '/api/avatars', { cookie: bob })).json).toEqual({ avatars: { alice: v1 } });
    const got = await fetch(`${r.base}/api/avatar/alice?v=${v1}`, { headers: { Cookie: bob } });
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toBe('image/jpeg');
    expect(got.headers.get('x-content-type-options')).toBe('nosniff');
    expect(got.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(got.headers.get('cache-control')).toContain('immutable');
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(bytes);
    // asked without the right version number, or with the tag, the browser is told to check again / that nothing changed
    const plain = await fetch(`${r.base}/api/avatar/alice`, { headers: { Cookie: bob } });
    expect(plain.headers.get('cache-control')).toContain('no-cache');
    const same = await fetch(`${r.base}/api/avatar/alice`, { headers: { Cookie: bob, 'If-None-Match': `"${v1}"` } });
    expect(same.status).toBe(304);
    // everybody hears about it
    expect(await until(() => watching.text().includes('event: avatar'))).toBe(true);
    expect(watching.text()).toContain(`"username":"alice","v":${v1}`);
    // a new picture replaces the old one and has a new number, even in the same millisecond
    const set2 = await setPicture(r, alice, url('image/png', png(64, 64)));
    expect(set2.json.version).toBeGreaterThan(v1);
    expect(db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM user_avatars')?.n).toBe(1);
    const again = await fetch(`${r.base}/api/avatar/alice`, { headers: { Cookie: alice } });
    expect(again.headers.get('content-type')).toBe('image/png');
  }, LONG);

  it('EXTRA-9: pictures that are not pictures, too big, too wide or too many are refused and nothing is stored', async () => {
    const r = await boot();
    const { alice } = await world(r);
    const refused: [string, unknown, number][] = [
      ['not text', 42, 400],
      ['plain text', 'hello', 400],
      ['a web page', url('image/png', new TextEncoder().encode('<script>alert(1)</script>')), 400],
      ['a svg', url('image/svg+xml', new TextEncoder().encode('<svg/>')), 400],
      ['too wide', url('image/png', png(5000, 5000)), 413],
      ['too many bytes', url('image/png', png(8, 8, AVATAR_MAX_BYTES + 1)), 413],
    ];
    for (const [what, image, status] of refused) expect([what, (await setPicture(r, alice, image)).status]).toEqual([what, status]);
    // a body far past the limit is cut off before it is read
    const huge = await call(r, '/api/profile/avatar', { method: 'POST', cookie: alice, raw: JSON.stringify({ image: 'data:image/png;base64,' + 'A'.repeat(200_000) }) });
    expect(huge.status).toBe(413);
    expect(db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM user_avatars')?.n).toBe(0);
    // the database itself refuses a picture that is too big or of another kind
    expect(() => db(r).run("INSERT INTO user_avatars(user_id, mime, data, updated_ms) VALUES (?, 'text/html', x'00', 0)", idOf(r, 'alice'))).toThrow();
    expect(() => db(r).run("INSERT INTO user_avatars(user_id, mime, data, updated_ms) VALUES (?, 'image/png', zeroblob(70000), 0)", idOf(r, 'alice'))).toThrow();
  }, LONG);

  it('EXTRA-10: a player can change his picture only so often in an hour; removing his own is always possible', async () => {
    const r = await boot();
    const { alice } = await world(r);
    for (let i = 0; i < AVATAR_CHANGES_PER_HOUR; i += 1) expect((await setPicture(r, alice, url('image/png', png(8 + i, 8)))).status).toBe(200);
    const over = await setPicture(r, alice, url('image/png', png(30, 30)));
    expect(over.status).toBe(429);
    expect(over.json.error.code).toBe('rate_limited');
    r.clock.advanceSeconds(3601);
    expect((await setPicture(r, alice, url('image/png', png(30, 30)))).status).toBe(200);
    const watching = await listen(r, alice);
    expect((await call(r, '/api/profile/avatar/remove', { method: 'POST', cookie: alice })).status).toBe(200);
    expect(await until(() => watching.text().includes('"v":null'))).toBe(true);
    expect((await call(r, '/api/avatars', { cookie: alice })).json).toEqual({ avatars: {} });
    expect((await call(r, '/api/profile/avatar/remove', { method: 'POST', cookie: alice })).status).toBe(200); // nothing to remove: fine
  }, LONG);

  it('EXTRA-11: the owner removes anybody\'s picture; it is logged once and the player can set a new one', async () => {
    const r = await boot();
    const { alice, bob, boss } = await world(r);
    await setPicture(r, alice, url('image/png', png(64, 64)));
    await setPicture(r, bob, url('image/png', png(64, 64)));
    const body = { requestId: 'avatar-remove-once-1', username: 'alice' };
    const first = await call(r, '/api/admin/avatar/remove', { method: 'POST', cookie: boss, body });
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ ok: true, duplicate: false, username: 'alice' });
    expect(Object.keys((await call(r, '/api/avatars', { cookie: bob })).json.avatars)).toEqual(['bob']);
    expect((await call(r, '/api/admin/avatar/remove', { method: 'POST', cookie: boss, body })).json.duplicate).toBe(true);
    expect(db(r).all<{ action: string; target: string }>("SELECT action, target FROM admin_log WHERE action = 'avatar_remove'")).toEqual([{ action: 'avatar_remove', target: 'alice' }]);
    expect((await call(r, '/api/admin/avatar/remove', { method: 'POST', cookie: boss, body: { requestId: requestId(), username: 'nobody-here' } })).status).toBe(404);
    expect((await setPicture(r, alice, url('image/png', png(32, 32)))).status).toBe(200);
  }, LONG);

  it('EXTRA-12: a picture goes away with its player (the table is tied to the user)', async () => {
    const r = await boot();
    const keys = db(r).all<{ table: string; on_delete: string }>("SELECT \"table\", on_delete FROM pragma_foreign_key_list('user_avatars')");
    expect(keys).toEqual([{ table: 'users', on_delete: 'CASCADE' }]);
    const marks = db(r).all<{ table: string; on_delete: string }>("SELECT \"table\", on_delete FROM pragma_foreign_key_list('weekly_marks')");
    expect(marks).toEqual([{ table: 'users', on_delete: 'CASCADE' }]);
  }, LONG);
});

describe('who is online', () => {
  it('EXTRA-13: a player is online while he has a page open; a banned player never is', async () => {
    const r = await boot();
    const { alice, bob, boss } = await world(r);
    expect((await call(r, '/api/online', { cookie: alice })).json).toEqual({ online: [] });
    const a = await listen(r, alice);
    const b = await listen(r, bob);
    await listen(r); // a signed-out visitor
    expect((await call(r, '/api/online', { cookie: alice })).json).toEqual({ online: ['alice', 'bob'] });
    b.close();
    expect(await until(() => (r.app.services.hub as unknown as { has(id: number): boolean }).has(idOf(r, 'bob')) === false)).toBe(true);
    expect((await call(r, '/api/online', { cookie: alice })).json).toEqual({ online: ['alice'] });
    void a;
    const ban = await call(r, '/api/admin/ban', { method: 'POST', cookie: boss, body: { requestId: requestId(), username: 'alice', reason: 'x', hours: null } });
    expect(ban.status).toBe(200);
    expect(r.app.services.profiles.online()).toEqual([]);
  }, LONG);
});

describe('the weekly leaderboard', () => {
  it('EXTRA-14: a week starts on Monday at 00:00 Tokyo time', () => {
    const jst = (y: number, m: number, d: number, h = 0, min = 0): number => Date.UTC(y, m - 1, d, h - 9, min);
    // 2026-10-05 is a Monday
    expect(weekStartOf(jst(2026, 10, 5))).toBe(jst(2026, 10, 5));
    expect(weekStartOf(jst(2026, 10, 5, 0, 0) - 1)).toBe(jst(2026, 9, 28)); // one millisecond before: last week
    expect(weekStartOf(jst(2026, 10, 7, 15, 30))).toBe(jst(2026, 10, 5));
    expect(weekStartOf(jst(2026, 10, 11, 23, 59))).toBe(jst(2026, 10, 5)); // Sunday night is still the same week
    expect(weekStartOf(jst(2026, 10, 12))).toBe(jst(2026, 10, 12));
    expect(new Date(weekStartOf(Date.UTC(2026, 9, 25, 9, 0)) + 9 * 3_600_000).getUTCDay()).toBe(1);
    expect(WEEK_MS).toBe(7 * 86_400_000);
    expect(weekStartOf(0)).toBe(Date.UTC(1969, 11, 28, 15)); // 1970-01-01 (Thursday) belongs to the week of Monday 1969-12-29 Tokyo time
  });

  it('EXTRA-15: it needs a signed-in player, takes scope all or friends and nothing else', async () => {
    const r = await boot();
    const { alice } = await world(r);
    expect((await call(r, '/api/leaderboard/weekly')).status).toBe(401);
    expect((await call(r, '/api/leaderboard/weekly?scope=nope', { cookie: alice })).status).toBe(400);
    const out = await call(r, '/api/leaderboard/weekly', { cookie: alice });
    expect(out.status).toBe(200);
    expect(out.json).toMatchObject({ scope: 'all', size: 100, minStartCents: WEEKLY_MIN_START_CENTS });
    expect(out.json.endsMs - out.json.weekStartMs).toBe(WEEK_MS);
    expect(out.json.weekStartMs).toBe(weekStartOf(r.clock.now()));
  }, LONG);

  it('EXTRA-16: the board ranks the growth since the start of the week as a percentage; the owner, banned players and players with under $100 are left out', async () => {
    const r = await boot();
    const { alice, bob, boss } = await world(r);
    const cash = (name: string, cents: number): void => {
      db(r).run("UPDATE accounts SET cash_cents = ?, start_cash_cents = ? WHERE kind = 'career' AND user_id = ?", cents, cents, idOf(r, name));
    };
    // Everybody was written down at the first question; the account of everybody who joined this week starts at $1,000.
    expect((await call(r, '/api/leaderboard/weekly', { cookie: alice })).json.rows.map((x: any) => x.gainCents)).toEqual([0, 0, 0]);
    cash('alice', 120_000); // +20 %
    cash('bob', 150_000); // +50 %
    cash('carol', 900_000); // +800 % (but bigger accounts do not matter, only the percentage)
    cash('boss', 90_000_000);
    r.clock.advanceSeconds(31); // the ranking is kept for half a minute
    const b = (await call(r, '/api/leaderboard/weekly', { cookie: alice })).json;
    expect(b.rows.map((x: any) => [x.rank, x.username, x.gainCents, x.gainPct, x.netWorthCents])).toEqual([
      [1, 'carol', 800_000, 800, 900_000],
      [2, 'bob', 50_000, 50, 150_000],
      [3, 'alice', 20_000, 20, 120_000],
    ]);
    expect(b.me).toEqual({ rank: 3, gainCents: 20_000, gainPct: 20, inTop: true });
    expect(b.total).toBe(3);
    expect(JSON.stringify(b)).not.toContain('boss');
    expect((await call(r, '/api/leaderboard/weekly', { cookie: boss })).json.me).toBeNull();
    // A loss is a negative number and ranks last.
    cash('alice', 80_000);
    r.clock.advanceSeconds(31);
    const c = (await call(r, '/api/leaderboard/weekly', { cookie: bob })).json;
    expect(c.rows[2]).toMatchObject({ username: 'alice', gainCents: -20_000, gainPct: -20 });
    // A player who started the week with under $100 is not ranked.
    db(r).run('UPDATE weekly_marks SET net_worth_cents = 5_000 WHERE user_id = ?', idOf(r, 'bob'));
    r.clock.advanceSeconds(31);
    const d = (await call(r, '/api/leaderboard/weekly', { cookie: bob })).json;
    expect(d.rows.map((x: any) => x.username)).toEqual(['carol', 'alice']);
    expect(d.me).toBeNull();
    // A ban removes the player at once.
    await call(r, '/api/admin/ban', { method: 'POST', cookie: boss, body: { requestId: requestId(), username: 'carol', reason: 'x', hours: null } });
    expect((await call(r, '/api/leaderboard/weekly', { cookie: alice })).json.rows.map((x: any) => x.username)).toEqual(['alice']);
  }, LONG);

  it('EXTRA-17: the friends view ranks you and your friends only', async () => {
    const r = await boot();
    const { alice, bob, carol } = await world(r);
    await befriend(r, alice, 'alice', bob, 'bob');
    await call(r, '/api/leaderboard/weekly', { cookie: alice });
    const cash = (name: string, cents: number): void => {
      db(r).run("UPDATE accounts SET cash_cents = ? WHERE kind = 'career' AND user_id = ?", cents, idOf(r, name));
    };
    cash('alice', 110_000);
    cash('bob', 130_000);
    cash('carol', 400_000);
    r.clock.advanceSeconds(31);
    const f = (await call(r, '/api/leaderboard/weekly?scope=friends', { cookie: alice })).json;
    expect(f.scope).toBe('friends');
    expect(f.rows.map((x: any) => x.username)).toEqual(['bob', 'alice']);
    expect(f.me).toMatchObject({ rank: 2 });
    expect((await call(r, '/api/leaderboard/weekly?scope=friends', { cookie: carol })).json.rows.map((x: any) => x.username)).toEqual(['carol']);
  }, LONG);

  it('EXTRA-18: a new week starts again from zero; last week\'s best three are named; marks older than last week are deleted', async () => {
    const r = await boot();
    const { alice, bob, carol } = await world(r);
    const cash = (name: string, cents: number): void => {
      db(r).run("UPDATE accounts SET cash_cents = ?, start_cash_cents = ? WHERE kind = 'career' AND user_id = ?", cents, cents, idOf(r, name));
    };
    await call(r, '/api/leaderboard/weekly', { cookie: alice }); // marks for week 1
    const week1 = weekStartOf(r.clock.now());
    cash('alice', 110_000);
    cash('bob', 200_000);
    cash('carol', 90_000); // lost money
    // The next week begins: the game loop (a world tick) writes the new marks.
    r.clock.advanceSeconds(8 * 86_400);
    r.app.services.social.invalidate();
    r.app.services.social.rollWeek();
    const week2 = weekStartOf(r.clock.now());
    expect(week2).toBe(week1 + WEEK_MS);
    const marks = db(r).all<{ user_id: number; net_worth_cents: number }>('SELECT user_id, net_worth_cents FROM weekly_marks WHERE week_start_ms = ? ORDER BY user_id', week2);
    expect(marks.map((m) => m.net_worth_cents)).toEqual([110_000, 200_000, 90_000]);
    const view = (await call(r, '/api/leaderboard/weekly', { cookie: alice })).json;
    expect(view.rows.every((x: any) => x.gainCents === 0 && x.gainPct === 0)).toBe(true);
    expect(view.lastWeek.weekStartMs).toBe(week1);
    expect(view.lastWeek.winners.map((w: any) => [w.username, w.gainPct])).toEqual([
      ['bob', 100],
      ['alice', 10],
    ]); // carol lost money: no place on the podium
    // two weeks later week 1's marks are gone
    r.clock.advanceSeconds(14 * 86_400);
    r.app.services.social.invalidate();
    r.app.services.social.rollWeek();
    expect(db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM weekly_marks WHERE week_start_ms = ?', week1)?.n).toBe(0);
    void bob;
    void carol;
  }, LONG);

  it('EXTRA-19: a player who joins later in the week starts at $1,000 even if he traded before anybody asked', async () => {
    const r = await boot();
    const { alice } = await world(r);
    await call(r, '/api/leaderboard/weekly', { cookie: alice });
    r.clock.advanceSeconds(3 * 86_400);
    const dave = await signUp(r, 'dave');
    db(r).run("UPDATE accounts SET cash_cents = 150_000 WHERE kind = 'career' AND user_id = ?", idOf(r, 'dave'));
    r.clock.advanceSeconds(31);
    const b = (await call(r, '/api/leaderboard/weekly', { cookie: dave })).json;
    expect(b.rows.find((x: any) => x.username === 'dave')).toMatchObject({ gainCents: 50_000, gainPct: 50 });
  }, LONG);

  it('EXTRA-20: the game loop writes the marks without making any page see an older ranking', async () => {
    const r = await boot();
    const { alice } = await world(r);
    const before = (await call(r, '/api/leaderboard', { cookie: alice })).json;
    const social = r.app.services.social as unknown as { ranking: unknown };
    const kept = social.ranking;
    r.app.services.social.rollWeek();
    expect(social.ranking).toBe(kept);
    expect(before.rows.length).toBeGreaterThan(0);
  }, LONG);
});

describe('storage and wiring', () => {
  it('EXTRA-21: the schema is at version 22 and its newest step adds exactly the extras', () => {
    const last = MIGRATIONS[MIGRATIONS.length - 1] as (typeof MIGRATIONS)[number];
    expect(last.version).toBeGreaterThanOrEqual(22);
    const m22 = MIGRATIONS.find((m) => m.version === 22) as (typeof MIGRATIONS)[number];
    for (const word of ['private_messages ADD COLUMN deleted_ms', 'CREATE TABLE user_avatars', 'CREATE TABLE weekly_marks']) expect(m22.sql).toContain(word);
  });

  it('EXTRA-22: the new routes are registered in one place and the server code never uses Math.random', () => {
    const routes = readFileSync(resolve(process.cwd(), 'server', 'routes', 'profile.ts'), 'utf8');
    for (const path of ['/api/avatars', '/api/avatar/:username', '/api/profile/avatar', '/api/profile/avatar/remove', '/api/online', '/api/admin/avatar/remove']) expect(routes).toContain(`'${path}'`);
    const profile = readFileSync(resolve(process.cwd(), 'server', 'profile.ts'), 'utf8');
    expect(profile).not.toMatch(/Math\.random/);
  });
});
