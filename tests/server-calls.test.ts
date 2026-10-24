// Voice calls over HTTP (server/calls.ts, docs/world.md §17). The properties that matter: only friends who are online can be called, one call at a
// time, a ring runs out, only the two players can answer / hang up / pass connection messages and only the right kind from the right side, a
// player whose page is gone is hung up on after a short grace, a call ends when the friendship does, and nothing about a call is ever stored.
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../server/app';
import { GONE_GRACE_MS, INVITES_PER_HOUR, INVITES_PER_MINUTE, MAX_CANDIDATE, MAX_SDP, MAX_SIGNALS, RING_MS } from '../server/calls';
import { DEFAULT_ICE_SERVERS, iceServersOf, loadConfig } from '../server/config';
import { Logger } from '../server/log';
import { Clock } from './helpers/server';

const LONG = 240_000;
const PASSWORD = 'a-good-password';
const SDP = 'v=0\r\no=- 4611731400430051336 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv\r\n';
const CANDIDATE = { kind: 'candidate', candidate: 'candidate:1 1 udp 2113937151 192.168.1.5 54321 typ host generation 0', sdpMid: '0', sdpMLineIndex: 0 };

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

async function boot(dir?: string, startMs?: number, logLines?: string[]): Promise<Running> {
  const folder = dir ?? mkdtempSync(join(tmpdir(), 'tq-call-'));
  if (dir === undefined) dirs.push(folder);
  const clock = new Clock(startMs);
  const config = loadConfig({ TQ_DATA_DIR: folder, TQ_COMPANIES: '12', TQ_WARMUP_DAYS: '1', TQ_PORT: '8787', TQ_OWNER: 'boss' });
  const app = createApp({ config, log: new Logger({ sink: logLines ? (line) => logLines.push(line) : null, now: clock.now }), worldSeed: 777, now: clock.now, flowGain: 0 });
  const server = createServer(app.handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const r = { app, server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, dir: folder, clock };
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

interface Page {
  text(): string;
  /** Closes the page and waits until the server has noticed. */
  close(): Promise<void>;
}

/** A player's open page: a live stream that collects what arrives on it. */
async function open(r: Running, cookie: string): Promise<Page> {
  const controller = new AbortController();
  streams.push(controller);
  const res = await fetch(r.base + '/api/stream', { headers: { Cookie: cookie }, signal: controller.signal });
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
  return {
    text: () => text,
    close: async () => {
      const hub = r.app.services.hub;
      const before = hub.size;
      controller.abort();
      for (let i = 0; i < 300 && hub.size >= before; i += 1) await pause(10);
      expect(hub.size).toBe(before - 1);
    },
  };
}
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
const until = async (check: () => boolean, ms = 3000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await pause(20);
  }
  return check();
};

/** Every event of one name that arrived on a page, in order. */
function events(page: Page, name: string): any[] {
  const out: any[] = [];
  for (const block of page.text().split('\n\n')) {
    const lines = block.split('\n');
    const event = lines.find((l) => l.startsWith('event: '))?.slice(7);
    const data = lines.find((l) => l.startsWith('data: '))?.slice(6);
    if (event === name && data !== undefined) out.push(JSON.parse(data));
  }
  return out;
}

const db = (r: Running) => r.app.services.db;
const idOf = (r: Running, name: string): number => (db(r).get<{ id: number }>('SELECT id FROM users WHERE username = ?', name) as { id: number }).id;

const act = (r: Running, cookie: string | undefined, path: string, body: unknown = {}) => call(r, `/api/calls/${path}`, { method: 'POST', cookie, body });
const view = async (r: Running, cookie: string) => (await call(r, '/api/calls', { cookie })).json;
const ask = (r: Running, cookie: string, path: string, name: string) => call(r, `/api/friends/${path}`, { method: 'POST', cookie, body: { username: name } });
async function befriend(r: Running, a: string, aName: string, b: string, bName: string): Promise<void> {
  expect((await ask(r, a, 'request', bName)).status).toBe(200);
  expect((await ask(r, b, 'accept', aName)).status).toBe(200);
}

/** Alice, Bob and Carol, each with a page open; Alice and Bob are friends, Alice and Carol are friends, Bob and Carol are not. */
async function world(r: Running) {
  const alice = await signUp(r, 'alice');
  const bob = await signUp(r, 'bob');
  const carol = await signUp(r, 'carol');
  await befriend(r, alice, 'alice', bob, 'bob');
  await befriend(r, alice, 'alice', carol, 'carol');
  const pages = { alice: await open(r, alice), bob: await open(r, bob), carol: await open(r, carol) };
  return { alice, bob, carol, pages };
}

/** Alice rings Bob and Bob answers. Returns the call number. */
async function answered(r: Running, w: Awaited<ReturnType<typeof world>>): Promise<string> {
  const rang = await act(r, w.alice, 'invite', { username: 'bob' });
  expect(rang.status).toBe(200);
  const id = rang.json.call.id as string;
  expect((await act(r, w.bob, 'accept', { callId: id })).status).toBe(200);
  return id;
}

describe('who can call whom', () => {
  it('CALL-1: every call route needs a signed-in player', async () => {
    const r = await boot();
    expect((await call(r, '/api/calls')).status).toBe(401);
    for (const path of ['invite', 'accept', 'hangup', 'signal']) {
      expect([path, (await act(r, undefined, path, {})).status]).toEqual([path, 401]);
    }
  }, LONG);

  it('CALL-2: with no call the answer is empty and carries the servers and the ring time', async () => {
    const r = await boot();
    const { alice } = await world(r);
    const v = await view(r, alice);
    expect(v.call).toBeNull();
    expect(v.limits).toEqual({ ringMs: RING_MS });
    expect(v.ice).toEqual(DEFAULT_ICE_SERVERS.map((s) => ({ urls: [...s.urls] })));
  }, LONG);

  it('CALL-3: ringing a friend with a page open shows the call to both, outgoing for one and incoming for the other', async () => {
    const r = await boot();
    const w = await world(r);
    const rang = await act(r, w.alice, 'invite', { username: 'bob' });
    expect(rang.status).toBe(200);
    expect(rang.json.call).toMatchObject({ state: 'ringing', direction: 'outgoing', other: { username: 'bob', displayName: 'bob', role: 'player' }, msLeft: RING_MS });
    expect(await until(() => events(w.pages.bob, 'call').length > 0 && events(w.pages.alice, 'call').length > 0)).toBe(true);
    expect(events(w.pages.bob, 'call')[0].call).toMatchObject({ id: rang.json.call.id, state: 'ringing', direction: 'incoming', other: { username: 'alice' }, msLeft: RING_MS });
    expect(events(w.pages.alice, 'call')[0].call).toMatchObject({ direction: 'outgoing' });
    expect((await view(r, w.bob)).call).toMatchObject({ direction: 'incoming', other: { username: 'alice' } });
    // Carol was not asked and sees nothing.
    await pause(100);
    expect(events(w.pages.carol, 'call')).toEqual([]);
    expect((await view(r, w.carol)).call).toBeNull();
    r.clock.advanceSeconds(10);
    expect((await view(r, w.bob)).call.msLeft).toBe(RING_MS - 10_000);
  }, LONG);

  it('CALL-4: only a friend, only a real player, nobody who blocked or was blocked, and both pages must be open', async () => {
    const r = await boot();
    const w = await world(r);
    const code = async (cookie: string, body: unknown) => {
      const res = await act(r, cookie, 'invite', body);
      return [res.status, res.json?.error?.code];
    };
    // Bob and Carol are not friends (neither of them learns whether the other is online).
    expect(await code(w.bob, { username: 'carol' })).toEqual([403, 'not_friends']);
    await w.pages.carol.close();
    expect(await code(w.bob, { username: 'carol' })).toEqual([403, 'not_friends']);
    expect(await code(w.alice, { username: 'nobody' })).toEqual([404, 'no_such_player']);
    expect(await code(w.alice, { username: '' })).toEqual([404, 'no_such_player']);
    expect(await code(w.alice, {})).toEqual([404, 'no_such_player']);
    expect(await code(w.alice, { username: 'alice' })).toEqual([400, 'bad_request']);
    // A computer player cannot be called.
    const botId = db(r).run("INSERT INTO users(username, display_name, pw_hash, role, created_ms) VALUES ('robo-1', 'Robo', 'x', 'player', 1)").lastInsertRowid;
    db(r).run("INSERT INTO bots(user_id, persona) VALUES (?, 'test')", botId);
    expect(await code(w.alice, { username: 'robo-1' })).toEqual([404, 'no_such_player']);
    // A friend whose page is closed cannot be called; and a caller whose own page is closed cannot call.
    expect(await code(w.alice, { username: 'carol' })).toEqual([409, 'offline']);
    await w.pages.alice.close();
    expect(await code(w.alice, { username: 'bob' })).toEqual([409, 'offline']);
    await open(r, w.alice);
    r.clock.advanceSeconds(61); // the attempts above count toward the limit of calls a minute
    // A block in either direction (even one that left the friendship standing) stops it, with the same words.
    db(r).run('INSERT INTO blocks(blocker_id, blocked_id, created_ms) VALUES (?, ?, 1)', idOf(r, 'bob'), idOf(r, 'alice'));
    const blockedByHim = await act(r, w.alice, 'invite', { username: 'bob' });
    expect([blockedByHim.status, blockedByHim.json.error.code, blockedByHim.json.error.message]).toEqual([403, 'cannot_call', "You can't call bob."]);
    db(r).run('DELETE FROM blocks');
    db(r).run('INSERT INTO blocks(blocker_id, blocked_id, created_ms) VALUES (?, ?, 1)', idOf(r, 'alice'), idOf(r, 'bob'));
    expect(await code(w.alice, { username: 'bob' })).toEqual([403, 'cannot_call']);
    expect(await code(w.bob, { username: 'alice' })).toEqual([403, 'cannot_call']);
    db(r).run('DELETE FROM blocks');
    // A player the owner banned cannot be called.
    db(r).run("INSERT INTO user_bans(user_id, reason, banned_ms, until_ms, by_user_id) VALUES (?, 'test', ?, NULL, ?)", idOf(r, 'bob'), r.clock.now(), idOf(r, 'alice'));
    expect(await code(w.alice, { username: 'bob' })).toEqual([404, 'no_such_player']);
    expect(r.app.services.calls.size).toBe(0);
  }, LONG);

  it('CALL-5: one call at a time: nobody on a call, or ringing, can start or receive another, and the words say who is busy', async () => {
    const r = await boot();
    const w = await world(r);
    const rang = await act(r, w.alice, 'invite', { username: 'bob' });
    const id = rang.json.call.id as string;
    // Alice is calling: she cannot call Carol too; Carol cannot call Alice (Alice is busy).
    const second = await act(r, w.alice, 'invite', { username: 'carol' });
    expect([second.status, second.json.error.code]).toEqual([409, 'busy']);
    const toBusy = await act(r, w.carol, 'invite', { username: 'alice' });
    expect([toBusy.status, toBusy.json.error.code]).toEqual([409, 'player_busy']);
    // Bob rings Alice back before he answers: he is told to answer instead, and nothing new starts.
    const back = await act(r, w.bob, 'invite', { username: 'alice' });
    expect([back.status, back.json.error.code, back.json.error.message]).toEqual([409, 'busy', 'alice is already calling you. Answer the call.']);
    expect(r.app.services.calls.size).toBe(1);
    // After the answer it is the same.
    await act(r, w.bob, 'accept', { callId: id });
    expect((await act(r, w.carol, 'invite', { username: 'alice' })).json.error.code).toBe('player_busy');
    expect((await act(r, w.bob, 'invite', { username: 'alice' })).json.error.code).toBe('busy');
    // When it is over everybody is free again.
    expect((await act(r, w.alice, 'hangup', { callId: id })).status).toBe(200);
    expect((await act(r, w.carol, 'invite', { username: 'alice' })).status).toBe(200);
  }, LONG);
});

describe('answering and ending', () => {
  it('CALL-6: only the player who was called can answer; the call is then answered for both, and a second answer is refused', async () => {
    const r = await boot();
    const w = await world(r);
    const id = (await act(r, w.alice, 'invite', { username: 'bob' })).json.call.id as string;
    expect((await act(r, w.alice, 'accept', { callId: id })).json.error.code).toBe('not_allowed');
    expect((await act(r, w.carol, 'accept', { callId: id })).json.error.code).toBe('no_call');
    expect((await act(r, w.bob, 'accept', { callId: 'nope' })).json.error.code).toBe('no_call');
    expect((await act(r, w.bob, 'accept', {})).json.error.code).toBe('no_call');
    const ok = await act(r, w.bob, 'accept', { callId: id });
    expect(ok.status).toBe(200);
    expect(ok.json.call).toMatchObject({ id, state: 'active', direction: 'incoming', msLeft: null });
    expect(await until(() => events(w.pages.alice, 'call').some((e) => e.call?.state === 'active'))).toBe(true);
    expect(events(w.pages.alice, 'call').at(-1).call).toMatchObject({ state: 'active', direction: 'outgoing' });
    expect((await act(r, w.bob, 'accept', { callId: id })).json.error.code).toBe('not_ringing');
    // An answered call does not run out like a ring.
    r.clock.advanceSeconds(RING_MS / 1000 + 5);
    expect((await view(r, w.alice)).call).toMatchObject({ state: 'active' });
  }, LONG);

  it('CALL-6b: a ring cannot be answered once the caller\'s page is gone, and it stays a ring until it runs out', async () => {
    const r = await boot();
    const w = await world(r);
    const id = (await act(r, w.alice, 'invite', { username: 'bob' })).json.call.id as string;
    await w.pages.alice.close();
    const late = await act(r, w.bob, 'accept', { callId: id });
    expect([late.status, late.json.error.code]).toEqual([409, 'offline']);
    expect((await view(r, w.bob)).call).toMatchObject({ id, state: 'ringing' });
  }, LONG);

  it('CALL-6c: answering starts a fresh grace for a page that was away while the phone rang', async () => {
    const r = await boot();
    const w = await world(r);
    const id = (await act(r, w.alice, 'invite', { username: 'bob' })).json.call.id as string;
    await w.pages.bob.close();
    r.app.services.calls.sweep(); // Bob's page is gone: the clock of his absence starts
    r.clock.advanceSeconds(10);
    expect((await act(r, w.bob, 'accept', { callId: id })).status).toBe(200); // (his requests still work without the page)
    r.clock.advanceSeconds(10); // 20 s since he was first seen gone, but only 10 s since he answered
    r.app.services.calls.sweep();
    expect((await view(r, w.alice)).call).toMatchObject({ id, state: 'active' });
  }, LONG);

  it('CALL-7: the caller can take a ring back and the callee can refuse it, each with its own reason, and both are free to call again', async () => {
    const r = await boot();
    const w = await world(r);
    const first = (await act(r, w.alice, 'invite', { username: 'bob' })).json.call.id as string;
    const cancelled = await act(r, w.alice, 'hangup', { callId: first });
    expect(cancelled.status).toBe(200);
    expect(cancelled.json.call).toBeNull();
    expect(await until(() => events(w.pages.bob, 'call').some((e) => e.ended))).toBe(true);
    expect(events(w.pages.bob, 'call').at(-1)).toEqual({ call: null, ended: { callId: first, reason: 'cancelled', other: { username: 'alice', displayName: 'alice', role: 'player' }, role: 'callee', byYou: false } });
    expect(events(w.pages.alice, 'call').at(-1).ended).toMatchObject({ reason: 'cancelled', role: 'caller', byYou: true });
    const second = (await act(r, w.alice, 'invite', { username: 'bob' })).json.call.id as string;
    expect(second).not.toBe(first);
    expect((await act(r, w.bob, 'hangup', { callId: second })).json.call).toBeNull();
    expect(await until(() => events(w.pages.alice, 'call').filter((e) => e.ended).length === 2)).toBe(true);
    expect(events(w.pages.alice, 'call').at(-1).ended).toMatchObject({ callId: second, reason: 'declined', role: 'caller', byYou: false, other: { username: 'bob' } });
    // A call that is over cannot be ended again, or answered.
    expect((await act(r, w.alice, 'hangup', { callId: second })).json.error.code).toBe('no_call');
    expect((await act(r, w.bob, 'accept', { callId: second })).json.error.code).toBe('no_call');
    expect(r.app.services.calls.size).toBe(0);
  }, LONG);

  it('CALL-8: hanging up an answered call tells the other player; a browser that could not connect says so, and only an answered call counts as failed', async () => {
    const r = await boot();
    const w = await world(r);
    const id = await answered(r, w);
    expect((await act(r, w.bob, 'hangup', { callId: id })).json.call).toBeNull();
    expect(await until(() => events(w.pages.alice, 'call').some((e) => e.ended))).toBe(true);
    expect(events(w.pages.alice, 'call').at(-1).ended).toMatchObject({ reason: 'ended', byYou: false });
    const again = await answered(r, w);
    await act(r, w.alice, 'hangup', { callId: again, failed: true });
    expect(await until(() => events(w.pages.bob, 'call').filter((e) => e.ended).length === 2)).toBe(true);
    expect(events(w.pages.bob, 'call').at(-1).ended).toMatchObject({ callId: again, reason: 'failed', byYou: false });
    // "Failed" on a ring that was never answered is just a ring taken back.
    const ring = (await act(r, w.alice, 'invite', { username: 'bob' })).json.call.id as string;
    await act(r, w.alice, 'hangup', { callId: ring, failed: true });
    expect(await until(() => events(w.pages.bob, 'call').filter((e) => e.ended).length === 3)).toBe(true);
    expect(events(w.pages.bob, 'call').at(-1).ended.reason).toBe('cancelled');
    // Only a real "true" says the connection failed; anything else is an ordinary hang up.
    const third = await answered(r, w);
    await act(r, w.alice, 'hangup', { callId: third, failed: 'yes' });
    expect(await until(() => events(w.pages.bob, 'call').filter((e) => e.ended).length === 4)).toBe(true);
    expect(events(w.pages.bob, 'call').at(-1).ended.reason).toBe('ended');
  }, LONG);

  it('CALL-9: a ring runs out after the ring time; both are told, and answering after that is too late', async () => {
    const r = await boot();
    const w = await world(r);
    const id = (await act(r, w.alice, 'invite', { username: 'bob' })).json.call.id as string;
    r.clock.advanceSeconds(RING_MS / 1000 - 1);
    expect((await view(r, w.bob)).call).toMatchObject({ state: 'ringing', msLeft: 1000 });
    r.clock.advanceSeconds(1);
    expect((await view(r, w.bob)).call).toBeNull();
    expect(await until(() => events(w.pages.alice, 'call').some((e) => e.ended))).toBe(true);
    expect(events(w.pages.alice, 'call').at(-1).ended).toMatchObject({ callId: id, reason: 'missed', role: 'caller', byYou: false });
    expect(await until(() => events(w.pages.bob, 'call').at(-1)?.ended?.callId === id)).toBe(true);
    expect(events(w.pages.bob, 'call').at(-1).ended).toMatchObject({ callId: id, reason: 'missed', role: 'callee' });
    expect((await act(r, w.bob, 'accept', { callId: id })).json.error.code).toBe('no_call');
    // The server's own clock tick does the same without anybody asking.
    const next = (await act(r, w.alice, 'invite', { username: 'bob' })).json.call.id as string;
    r.clock.advanceSeconds(RING_MS / 1000);
    r.app.services.calls.sweep();
    expect(r.app.services.calls.size).toBe(0);
    expect(await until(() => events(w.pages.alice, 'call').filter((e) => e.ended).length === 2)).toBe(true);
    expect(events(w.pages.alice, 'call').at(-1).ended.callId).toBe(next);
  }, LONG);

  it('CALL-10: every page of a player gets the call; the first to answer wins and the others are told it is answered', async () => {
    const r = await boot();
    const w = await world(r);
    const bob2 = await open(r, w.bob);
    const id = (await act(r, w.alice, 'invite', { username: 'bob' })).json.call.id as string;
    expect(await until(() => events(w.pages.bob, 'call').length > 0 && events(bob2, 'call').length > 0)).toBe(true);
    expect((await act(r, w.bob, 'accept', { callId: id })).status).toBe(200);
    expect((await act(r, w.bob, 'accept', { callId: id })).json.error.code).toBe('not_ringing');
    expect(await until(() => events(bob2, 'call').some((e) => e.call?.state === 'active'))).toBe(true);
    // Closing one of Bob's pages does not end the call: he still has another.
    await bob2.close();
    r.clock.advanceSeconds(GONE_GRACE_MS / 1000 + 5);
    r.app.services.calls.sweep();
    expect((await view(r, w.alice)).call).toMatchObject({ state: 'active' });
  }, LONG);
});

describe('connection messages', () => {
  it('CALL-11: the offer, the answer and the network addresses go to the other player only, and only while the call is answered', async () => {
    const r = await boot();
    const w = await world(r);
    const id = (await act(r, w.alice, 'invite', { username: 'bob' })).json.call.id as string;
    // Not answered yet: nothing to pass on.
    expect((await act(r, w.alice, 'signal', { callId: id, signal: { kind: 'offer', sdp: SDP } })).json.error.code).toBe('not_active');
    await act(r, w.bob, 'accept', { callId: id });
    expect((await act(r, w.alice, 'signal', { callId: id, signal: { kind: 'offer', sdp: SDP } })).json).toEqual({ ok: true });
    expect((await act(r, w.bob, 'signal', { callId: id, signal: { kind: 'answer', sdp: SDP } })).json).toEqual({ ok: true });
    expect((await act(r, w.alice, 'signal', { callId: id, signal: CANDIDATE })).json).toEqual({ ok: true });
    expect((await act(r, w.bob, 'signal', { callId: id, signal: { ...CANDIDATE, sdpMid: null, sdpMLineIndex: null } })).json).toEqual({ ok: true });
    expect(await until(() => events(w.pages.bob, 'call_signal').length === 2 && events(w.pages.alice, 'call_signal').length === 2)).toBe(true);
    expect(events(w.pages.bob, 'call_signal')).toEqual([
      { callId: id, signal: { kind: 'offer', sdp: SDP } },
      { callId: id, signal: CANDIDATE },
    ]);
    expect(events(w.pages.alice, 'call_signal')).toEqual([
      { callId: id, signal: { kind: 'answer', sdp: SDP } },
      { callId: id, signal: { kind: 'candidate', candidate: CANDIDATE.candidate, sdpMid: null, sdpMLineIndex: null } },
    ]);
    // Carol hears nothing, and cannot send anything into the call.
    await pause(100);
    expect(events(w.pages.carol, 'call_signal')).toEqual([]);
    expect((await act(r, w.carol, 'signal', { callId: id, signal: CANDIDATE })).json.error.code).toBe('no_call');
    expect(events(w.pages.alice, 'call_signal')).toHaveLength(2);
    expect(events(w.pages.bob, 'call_signal')).toHaveLength(2);
  }, LONG);

  it('CALL-12: the right kind from the right side, only the known fields, within the size limits', async () => {
    const r = await boot();
    const w = await world(r);
    const id = await answered(r, w);
    const send = async (cookie: string, signal: unknown) => {
      const res = await act(r, cookie, 'signal', { callId: id, signal });
      return [res.status, res.json?.error?.code];
    };
    // Only the caller offers and only the callee answers.
    expect(await send(w.bob, { kind: 'offer', sdp: SDP })).toEqual([400, 'bad_request']);
    expect(await send(w.alice, { kind: 'answer', sdp: SDP })).toEqual([400, 'bad_request']);
    // Not a signal at all.
    for (const bad of [undefined, null, 'offer', 42, [], {}, { kind: 'hello' }, { kind: 'offer' }, { kind: 'offer', sdp: 5 }]) {
      expect([JSON.stringify(bad), ...(await send(w.alice, bad))]).toEqual([JSON.stringify(bad), 400, 'bad_request']);
    }
    // A description must look like one and fit.
    expect(await send(w.alice, { kind: 'offer', sdp: 'hello there, this is not an sdp' })).toEqual([400, 'bad_request']);
    expect(await send(w.alice, { kind: 'offer', sdp: 'v=0' })).toEqual([400, 'bad_request']);
    expect(await send(w.alice, { kind: 'offer', sdp: SDP + `a=${String.fromCharCode(233)}\r\n` })).toEqual([400, 'bad_request']);
    expect(await send(w.alice, { kind: 'offer', sdp: SDP + `a=x${String.fromCharCode(0)}\r\n` })).toEqual([400, 'bad_request']);
    expect(await send(w.alice, { kind: 'offer', sdp: SDP + 'x'.repeat(MAX_SDP) })).toEqual([400, 'bad_request']);
    expect(await send(w.alice, { kind: 'offer', sdp: SDP + 'x'.repeat(MAX_SDP * 3) })).toEqual([413, 'too_large']);
    expect(await send(w.alice, { kind: 'offer', sdp: SDP + 'a='.padEnd(MAX_SDP - SDP.length - 10, 'x') })).toEqual([200, undefined]);
    // An address must be short text; the index a small whole number.
    expect(await send(w.alice, { ...CANDIDATE, candidate: 'x'.repeat(MAX_CANDIDATE + 1) })).toEqual([400, 'bad_request']);
    expect(await send(w.alice, { ...CANDIDATE, candidate: 5 })).toEqual([400, 'bad_request']);
    expect(await send(w.alice, { ...CANDIDATE, sdpMid: 5 })).toEqual([400, 'bad_request']);
    expect(await send(w.alice, { ...CANDIDATE, sdpMLineIndex: -1 })).toEqual([400, 'bad_request']);
    expect(await send(w.alice, { ...CANDIDATE, sdpMLineIndex: 1.5 })).toEqual([400, 'bad_request']);
    expect(await send(w.alice, { ...CANDIDATE, sdpMLineIndex: 65 })).toEqual([400, 'bad_request']);
    expect(await send(w.alice, { ...CANDIDATE, candidate: '' })).toEqual([200, undefined]);
    // Extra fields never get through.
    expect(await send(w.alice, { ...CANDIDATE, evil: '<img src=x>', usernameFragment: 'abc' })).toEqual([200, undefined]);
    expect(await until(() => events(w.pages.bob, 'call_signal').length === 3)).toBe(true);
    expect(Object.keys(events(w.pages.bob, 'call_signal')[2].signal).sort()).toEqual(['candidate', 'kind', 'sdpMLineIndex', 'sdpMid']);
    // A refused signal never reached the other player.
    expect(events(w.pages.bob, 'call_signal')).toHaveLength(3);
    // An address with a letter outside plain ASCII or a control character is refused too.
    expect(await send(w.alice, { ...CANDIDATE, candidate: `a${String.fromCharCode(233)}` })).toEqual([400, 'bad_request']);
    expect(await send(w.alice, { ...CANDIDATE, candidate: `a${String.fromCharCode(0)}` })).toEqual([400, 'bad_request']);
    // Extra fields never get through an offer either.
    expect(await send(w.alice, { kind: 'offer', sdp: SDP, evil: '<img src=x>' })).toEqual([200, undefined]);
    expect(await until(() => events(w.pages.bob, 'call_signal').length === 4)).toBe(true);
    expect(Object.keys(events(w.pages.bob, 'call_signal')[3].signal).sort()).toEqual(['kind', 'sdp']);
  }, LONG);

  it('CALL-12b: the routes slow down a flood of requests, even ones that fail, and a flood of signals; the ten seconds then pass', async () => {
    const r = await boot();
    const w = await world(r);
    const codes: number[] = [];
    for (let i = 0; i < 22; i += 1) codes.push((await act(r, w.alice, 'accept', { callId: 'nope' })).status);
    expect(codes.slice(0, 20).every((c) => c === 404)).toBe(true);
    expect(codes.slice(20)).toEqual([429, 429]);
    r.clock.advanceSeconds(11);
    expect((await act(r, w.alice, 'accept', { callId: 'nope' })).status).toBe(404);
    const id = await answered(r, w);
    r.clock.advanceSeconds(11);
    for (let i = 0; i < 120; i += 1) expect([i, (await act(r, w.alice, 'signal', { callId: id, signal: CANDIDATE })).status]).toEqual([i, 200]);
    const flood = await act(r, w.alice, 'signal', { callId: id, signal: CANDIDATE });
    expect([flood.status, flood.json.error.code]).toEqual([429, 'rate_limited']);
    expect(flood.json.error.message).toMatch(/Too many requests/); // the route's own limit, not the call's total
    r.clock.advanceSeconds(11);
    expect((await act(r, w.alice, 'signal', { callId: id, signal: CANDIDATE })).status).toBe(200);
  }, LONG);

  it('CALL-13: one call can pass on only so many signals', async () => {
    const r = await boot();
    const w = await world(r);
    const id = await answered(r, w);
    for (let i = 0; i < MAX_SIGNALS; i += 1) {
      // The route's own limit is per ten seconds; let the time pass so only the call's total counts.
      if (i % 100 === 99) r.clock.advanceSeconds(11);
      const res = await act(r, w.alice, 'signal', { callId: id, signal: CANDIDATE });
      expect([i, res.status]).toEqual([i, 200]);
    }
    r.clock.advanceSeconds(11);
    const over = await act(r, w.alice, 'signal', { callId: id, signal: CANDIDATE });
    expect([over.status, over.json.error.code]).toEqual([429, 'rate_limited']);
    const other = await act(r, w.bob, 'signal', { callId: id, signal: { kind: 'answer', sdp: SDP } });
    expect([other.status, other.json.error.code]).toEqual([429, 'rate_limited']);
  }, LONG);
});

describe('when something goes wrong', () => {
  it('CALL-14: a player whose page is gone is hung up on after the grace, not before, and coming back in time keeps the call', async () => {
    const r = await boot();
    const w = await world(r);
    const id = await answered(r, w);
    await w.pages.bob.close();
    r.app.services.calls.sweep(); // the server's own clock tick notices that Bob's page is gone
    r.clock.advanceSeconds(GONE_GRACE_MS / 1000 - 1);
    r.app.services.calls.sweep();
    expect((await view(r, w.alice)).call).toMatchObject({ id, state: 'active' });
    // Bob's page comes back in time: the clock of his absence starts again next time.
    const back = await open(r, w.bob);
    r.app.services.calls.sweep();
    r.clock.advanceSeconds(10);
    r.app.services.calls.sweep();
    expect((await view(r, w.alice)).call).toMatchObject({ id, state: 'active' });
    await back.close();
    r.app.services.calls.sweep();
    r.clock.advanceSeconds(GONE_GRACE_MS / 1000);
    r.app.services.calls.sweep();
    expect(r.app.services.calls.size).toBe(0);
    expect(await until(() => events(w.pages.alice, 'call').at(-1)?.ended !== undefined)).toBe(true);
    expect(events(w.pages.alice, 'call').at(-1).ended).toMatchObject({ callId: id, reason: 'disconnected', byYou: false });
    expect((await view(r, w.alice)).call).toBeNull();
  }, LONG);

  it('CALL-14b: the same for the player who called: a page that comes back in time starts a new clock of absence', async () => {
    const r = await boot();
    const w = await world(r);
    const id = await answered(r, w);
    await w.pages.alice.close();
    r.app.services.calls.sweep();
    r.clock.advanceSeconds(GONE_GRACE_MS / 1000 - 1);
    r.app.services.calls.sweep();
    expect((await view(r, w.bob)).call).toMatchObject({ id, state: 'active' });
    const back = await open(r, w.alice);
    r.app.services.calls.sweep();
    r.clock.advanceSeconds(10);
    r.app.services.calls.sweep();
    expect((await view(r, w.bob)).call).toMatchObject({ id, state: 'active' });
    await back.close();
  }, LONG);

  it('CALL-15: a ring to a page that disappears also ends, for the caller too', async () => {
    const r = await boot();
    const w = await world(r);
    const id = (await act(r, w.alice, 'invite', { username: 'bob' })).json.call.id as string;
    await w.pages.alice.close();
    r.app.services.calls.sweep();
    r.clock.advanceSeconds(GONE_GRACE_MS / 1000);
    r.app.services.calls.sweep();
    expect(r.app.services.calls.size).toBe(0);
    expect(await until(() => events(w.pages.bob, 'call').some((e) => e.ended))).toBe(true);
    expect(events(w.pages.bob, 'call').at(-1).ended).toMatchObject({ callId: id, reason: 'disconnected', role: 'callee' });
  }, LONG);

  it('CALL-16: a call ends at once when the two stop being friends: unfriending, blocking or a ban', async () => {
    const r = await boot();
    const w = await world(r);
    // Unfriending.
    let id = await answered(r, w);
    expect((await ask(r, w.alice, 'remove', 'bob')).status).toBe(200);
    expect(await until(() => events(w.pages.bob, 'call').some((e) => e.ended?.callId === id))).toBe(true);
    expect(events(w.pages.bob, 'call').at(-1).ended).toMatchObject({ reason: 'unavailable', byYou: false });
    expect(events(w.pages.alice, 'call').at(-1).ended).toMatchObject({ callId: id, reason: 'unavailable' });
    expect(r.app.services.calls.size).toBe(0);
    // Blocking a friend who is ringing you.
    await befriend(r, w.alice, 'alice', w.bob, 'bob');
    id = (await act(r, w.carol, 'invite', { username: 'alice' })).json.call.id as string;
    expect((await call(r, '/api/messages/block', { method: 'POST', cookie: w.alice, body: { username: 'carol' } })).status).toBe(200);
    expect(await until(() => events(w.pages.carol, 'call').some((e) => e.ended?.callId === id))).toBe(true);
    expect(events(w.pages.carol, 'call').at(-1).ended.reason).toBe('unavailable');
    expect(r.app.services.calls.size).toBe(0);
    // A player the owner bans while the phone rings.
    id = (await act(r, w.alice, 'invite', { username: 'bob' })).json.call.id as string;
    db(r).run("INSERT INTO user_bans(user_id, reason, banned_ms, until_ms, by_user_id) VALUES (?, 'test', ?, NULL, ?)", idOf(r, 'bob'), r.clock.now(), idOf(r, 'alice'));
    r.app.services.calls.sweep();
    expect(r.app.services.calls.size).toBe(0);
    expect(await until(() => events(w.pages.alice, 'call').at(-1)?.ended?.callId === id)).toBe(true);
    expect(events(w.pages.alice, 'call').at(-1).ended).toMatchObject({ callId: id, reason: 'unavailable' });
  }, LONG);

  it('CALL-16b: a call is checked again as soon as a block or a ban appears, without waiting for the next second', async () => {
    const r = await boot();
    const w = await world(r);
    const calls = r.app.services.calls;
    let id = await answered(r, w);
    // A block between two players who are (still) friends: the call goes at once.
    db(r).run('INSERT INTO blocks(blocker_id, blocked_id, created_ms) VALUES (?, ?, ?)', idOf(r, 'bob'), idOf(r, 'alice'), r.clock.now());
    calls.recheck(idOf(r, 'alice'));
    expect(calls.size).toBe(0);
    expect(await until(() => events(w.pages.bob, 'call').some((e) => e.ended?.callId === id))).toBe(true);
    expect(events(w.pages.bob, 'call').at(-1).ended.reason).toBe('unavailable');
    db(r).run('DELETE FROM blocks');
    // A ban on one of them.
    id = await answered(r, w);
    db(r).run("INSERT INTO user_bans(user_id, reason, banned_ms, until_ms, by_user_id) VALUES (?, 'test', ?, NULL, ?)", idOf(r, 'bob'), r.clock.now(), idOf(r, 'alice'));
    calls.recheck(idOf(r, 'bob'));
    expect(calls.size).toBe(0);
    expect(await until(() => events(w.pages.alice, 'call').at(-1)?.ended?.callId === id)).toBe(true);
    // Looking again at a player with no call changes nothing.
    calls.recheck(idOf(r, 'carol'));
    expect(calls.size).toBe(0);
  }, LONG);

  it('CALL-17: nobody can start calls without limit: so many a minute and so many an hour, and the limit passes with time', async () => {
    const r = await boot();
    const w = await world(r);
    const ring = async () => {
      const res = await act(r, w.alice, 'invite', { username: 'bob' });
      if (res.status === 200) await act(r, w.alice, 'hangup', { callId: res.json.call.id });
      return [res.status, res.json?.error?.code];
    };
    for (let i = 0; i < INVITES_PER_MINUTE; i += 1) expect(await ring()).toEqual([200, undefined]);
    expect(await ring()).toEqual([429, 'rate_limited']);
    r.clock.advanceSeconds(61);
    expect(await ring()).toEqual([200, undefined]);
    // Up to the hour's limit, a few a minute.
    let made = INVITES_PER_MINUTE + 1;
    while (made < INVITES_PER_HOUR) {
      r.clock.advanceSeconds(61);
      for (let i = 0; i < INVITES_PER_MINUTE && made < INVITES_PER_HOUR; i += 1) {
        expect(await ring()).toEqual([200, undefined]);
        made += 1;
      }
    }
    r.clock.advanceSeconds(61);
    const hour = await act(r, w.alice, 'invite', { username: 'bob' });
    expect([hour.status, hour.json.error.code]).toEqual([429, 'rate_limited']);
    expect(hour.json.error.message).toMatch(/this hour/);
    r.clock.advanceSeconds(3600);
    expect(await ring()).toEqual([200, undefined]);
  }, LONG);
});

describe('what a call is not', () => {
  it('CALL-18: the owner is called and calls like any friend, and cannot see anybody else\'s call', async () => {
    const r = await boot();
    const w = await world(r);
    const boss = await signUp(r, 'boss');
    expect((await call(r, '/api/me', { cookie: boss })).json.user.role).toBe('owner');
    await befriend(r, w.alice, 'alice', boss, 'boss');
    const bossPage = await open(r, boss);
    const id = (await act(r, w.alice, 'invite', { username: 'boss' })).json.call.id as string;
    expect(await until(() => events(bossPage, 'call').length > 0)).toBe(true);
    expect(events(bossPage, 'call')[0].call).toMatchObject({ other: { username: 'alice' }, direction: 'incoming' });
    expect((await act(r, boss, 'accept', { callId: id })).status).toBe(200);
    expect((await view(r, w.bob)).call).toBeNull();
    // The owner sees an owner mark on the other side of a call with him.
    expect((await view(r, w.alice)).call.other).toEqual({ username: 'boss', displayName: 'boss', role: 'owner' });
    expect((await act(r, boss, 'invite', { username: 'bob' })).json.error.code).toBe('not_friends');
    // The owner has no way to read a call he is not in.
    expect((await act(r, boss, 'signal', { callId: 'x', signal: CANDIDATE })).json.error.code).toBe('no_call');
    const other = await answeredBetween(r, w);
    expect((await act(r, boss, 'hangup', { callId: other })).json.error.code).toBe('no_call');
    expect((await act(r, boss, 'signal', { callId: other, signal: CANDIDATE })).json.error.code).toBe('no_call');
  }, LONG);

  it('CALL-19: nothing about a call is written to the database, and a restart ends every call', async () => {
    const r = await boot();
    const w = await world(r);
    const tables = () => db(r).all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((t) => t.name);
    expect(tables().filter((t) => /call/i.test(t))).toEqual([]);
    const before = db(r).get<{ n: number }>('SELECT total_changes() AS n')?.n;
    const id = await answered(r, w);
    await act(r, w.alice, 'signal', { callId: id, signal: CANDIDATE });
    await act(r, w.bob, 'hangup', { callId: id });
    await view(r, w.alice);
    expect(db(r).get<{ n: number }>('SELECT total_changes() AS n')?.n).toBe(before);
    expect(tables().filter((t) => /call/i.test(t))).toEqual([]);
    // A call that is going when the server stops is gone when it starts again.
    await answered(r, w);
    expect(r.app.services.calls.size).toBe(1);
    const dir = r.dir;
    r.app.close();
    const again = await boot(dir, r.clock.now() + 60_000);
    expect(again.app.services.calls.size).toBe(0);
    const login = async (name: string): Promise<string> => {
      const res = await fetch(again.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: name, password: PASSWORD }) });
      expect(res.status).toBe(200);
      return (res.headers.get('set-cookie') ?? '').split(';')[0] as string;
    };
    const a = await login('alice');
    await open(again, a);
    await open(again, await login('bob'));
    // A call number from before the restart can never match a call made after it (the first call of each run is number 1).
    const fresh = (await act(again, a, 'invite', { username: 'bob' })).json.call.id as string;
    expect(fresh).not.toBe(id);
    expect((await act(again, a, 'hangup', { callId: id })).json.error.code).toBe('no_call');
  }, LONG);

  it('CALL-19b: the server\'s own log notes only that a call started and how it ended, by player number: no names, no sound, no connection messages', async () => {
    const lines: string[] = [];
    const r = await boot(undefined, undefined, lines);
    const w = await world(r);
    const id = await answered(r, w);
    await act(r, w.alice, 'signal', { callId: id, signal: { kind: 'offer', sdp: SDP } });
    await act(r, w.bob, 'hangup', { callId: id });
    const mine = lines.filter((l) => l.includes('[calls]'));
    expect(mine).toHaveLength(2);
    expect(mine[0]).toMatch(/Player \d+ is calling player \d+\./);
    expect(mine[1]).toMatch(/A call between players \d+ and \d+ ended: ended\./);
    const everything = mine.join('\n');
    expect(/alice|bob|carol|v=0|candidate/i.test(everything)).toBe(false);
  }, LONG);

  it('CALL-20: the servers for finding the other browser come from TQ_ICE_SERVERS, are checked, and default to free public STUN', () => {
    expect(iceServersOf(undefined)).toEqual(DEFAULT_ICE_SERVERS);
    expect(iceServersOf('')).toEqual(DEFAULT_ICE_SERVERS);
    expect(DEFAULT_ICE_SERVERS.every((s) => s.urls.every((u) => u.startsWith('stun:')) && s.username === undefined)).toBe(true);
    expect(iceServersOf('[{"urls":"stun:s.example.org:3478"},{"urls":["turn:t.example.org:3478","turns:t.example.org:5349"],"username":"u","credential":"p"}]')).toEqual([
      { urls: ['stun:s.example.org:3478'] },
      { urls: ['turn:t.example.org:3478', 'turns:t.example.org:5349'], username: 'u', credential: 'p' },
    ]);
    expect(loadConfig({ TQ_DATA_DIR: '/tmp/x', TQ_ICE_SERVERS: '[{"urls":"stun:a.example.org:1"}]' }).iceServers).toEqual([{ urls: ['stun:a.example.org:1'] }]);
    for (const bad of ['nope', '{}', '[]', '[1]', '[{}]', '[{"urls":"http://x"}]', '[{"urls":[]}]', '[{"urls":"stun:a b"}]', '[{"urls":"stun:a","username":5}]', `[{"urls":"turn:a","credential":"${'x'.repeat(513)}"}]`, JSON.stringify(Array.from({ length: 9 }, () => ({ urls: 'stun:a' })))]) {
      expect(() => iceServersOf(bad)).toThrow(/TQ_ICE_SERVERS/);
    }
    // Extra fields on a server are dropped.
    expect(iceServersOf('[{"urls":"stun:a:1","evil":1}]')).toEqual([{ urls: ['stun:a:1'] }]);
  });
});

/** Carol and Alice are in a call (Alice's friend Carol answers); the number of that call. */
async function answeredBetween(r: Running, w: Awaited<ReturnType<typeof world>>): Promise<string> {
  const id = (await act(r, w.carol, 'invite', { username: 'alice' })).json;
  // Alice is on the owner's call, so use Bob and Carol instead: make them friends first.
  expect(id.error?.code).toBe('player_busy');
  await befriend(r, w.bob, 'bob', w.carol, 'carol');
  const rang = await act(r, w.bob, 'invite', { username: 'carol' });
  expect(rang.status).toBe(200);
  expect((await act(r, w.carol, 'accept', { callId: rang.json.call.id })).status).toBe(200);
  return rang.json.call.id as string;
}
