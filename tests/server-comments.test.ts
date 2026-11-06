// Comments on companies over HTTP (server/comments.ts, docs/world.md §40). The properties that matter: every company, old or new, has its own comment section that anybody can
// read; only a signed-in player writes, answers, likes and reports; a comment is plain one-line text of limited length; spam is slowed down; a player muted or banned from the chat
// cannot write comments; the owner and the moderators delete comments and close reports (each written once to the admin log, a moderator never touching the owner's or another
// moderator's comments); and comments never touch money or prices.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../server/app';
import { COMMENT_GAP_MS, COMMENT_KEEP_PER_COMPANY, COMMENT_MAX_LENGTH, COMMENT_PAGE, COMMENT_PAGE_MAX, COMMENT_REPEAT_MS, COMMENT_REPORTS_PER_HOUR, COMMENTS_PER_DAY, RECENT_MAX, REPLIES_MAX } from '../server/comments';
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
      // already closed by the test
    }
  }
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

async function boot(): Promise<Running> {
  const dir = mkdtempSync(join(tmpdir(), 'tq-comments-'));
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

const db = (r: Running) => r.app.services.db;
const idOf = (r: Running, name: string): number => (db(r).get<{ id: number }>('SELECT id FROM users WHERE username = ?', name) as { id: number }).id;
let nextRequest = 0;
const requestId = (): string => `comment-test-${(nextRequest += 1)}-abcdef`;
const tickers = (r: Running): string[] => db(r).all<{ ticker: string }>('SELECT ticker FROM companies ORDER BY id').map((x) => x.ticker);

/** Writes a comment (the clock moves past the pause first, so the tests that are not about the pause never meet it). */
async function write(r: Running, cookie: string, ticker: string, text: unknown, parentId?: number) {
  r.clock.advanceSeconds(COMMENT_GAP_MS / 1000 + 1);
  return call(r, '/api/comments/post', { method: 'POST', cookie, body: { ticker, text, ...(parentId === undefined ? {} : { parentId }) } });
}
const view = async (r: Running, ticker: string, cookie?: string, query = '') => (await call(r, `/api/comments/${ticker}${query}`, { cookie })).json;
const texts = (v: any): string[] => v.comments.map((c: any) => c.text);
const staffCall = (r: Running, cookie: string, what: 'delete' | 'dismiss', body: Record<string, unknown>) => call(r, `/api/admin/comments/${what}`, { method: 'POST', cookie, body: { requestId: requestId(), ...body } });
const chatAdmin = (r: Running, cookie: string, what: 'mute' | 'ban' | 'lift', body: Record<string, unknown>) => call(r, `/api/admin/chat/${what}`, { method: 'POST', cookie, body: { requestId: requestId(), ...body } });
const log = (r: Running): { action: string; target: string; admin: string }[] =>
  db(r).all<{ action: string; target: string; admin: string }>("SELECT l.action, l.target, u.username AS admin FROM admin_log l JOIN users u ON u.id = l.admin_user_id WHERE l.action LIKE 'comment_%' ORDER BY l.id");
/** Puts a comment in the table without the rules (a long time ago, or in bulk). */
function plant(r: Running, name: string, ticker: string, text: string, createdMs = r.clock.now(), parentId: number | null = null): number {
  const company = db(r).get<{ id: number }>('SELECT id FROM companies WHERE ticker = ?', ticker) as { id: number };
  return db(r).run('INSERT INTO company_comments(company_id, user_id, parent_id, body, created_ms) VALUES (?, ?, ?, ?, ?)', company.id, idOf(r, name), parentId, text, createdMs).lastInsertRowid;
}

/** The owner (boss), a moderator (mia), and three players (alice, bob, cy). */
async function crew(r: Running) {
  const [boss, mia, alice, bob, cy] = [await signUp(r, 'boss'), await signUp(r, 'mia'), await signUp(r, 'alice'), await signUp(r, 'bob'), await signUp(r, 'cal')];
  expect((await call(r, '/api/admin/moderator', { method: 'POST', cookie: boss, body: { requestId: requestId(), username: 'mia', on: true } })).status).toBe(200);
  return { boss, mia, alice, bob, cy };
}

describe('who may read and write', () => {
  it('COMMENT-1: anybody can read; writing, liking, reporting and deleting need a signed-in player; the staff routes need the owner or a moderator', async () => {
    const r = await boot();
    const { alice } = await crew(r);
    const [stock] = tickers(r) as [string];
    expect((await write(r, alice, stock, 'hello')).status).toBe(200);
    // Signed out: reading works, and shows that writing needs an account.
    const open = await call(r, `/api/comments/${stock}`);
    expect(open.status).toBe(200);
    expect(texts(open.json)).toEqual(['hello']);
    expect(open.json.you).toMatchObject({ canWrite: false, reason: 'signed_out' });
    expect(open.json.you.message).toMatch(/Sign in/);
    expect(open.json.comments[0]).toMatchObject({ liked: false, mine: false });
    expect((await call(r, '/api/comments/recent')).status).toBe(200);
    const wrong: string[] = [];
    const checks: [string, string, unknown][] = [
      ['POST', '/api/comments/post', { ticker: stock, text: 'hi' }],
      ['POST', '/api/comments/like', { commentId: 1 }],
      ['POST', '/api/comments/report', { commentId: 1 }],
      ['POST', '/api/comments/delete', { commentId: 1 }],
      ['GET', '/api/admin/comments', undefined],
      ...['delete', 'dismiss'].map((w): [string, string, unknown] => ['POST', `/api/admin/comments/${w}`, { requestId: requestId(), commentId: 1 }]),
    ];
    for (const [method, path, body] of checks) {
      const out = await call(r, path, { method, body });
      if (out.status !== 401) wrong.push(`${method} ${path} signed out: ${out.status}`);
      if (path.startsWith('/api/admin/')) {
        const asPlayer = await call(r, path, { method, body, cookie: alice });
        if (asPlayer.status !== 403 || asPlayer.json.error.code !== 'staff_only') wrong.push(`${method} ${path} as a player: ${asPlayer.status}`);
      }
    }
    expect(wrong).toEqual([]);
    expect(db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM company_comments')?.n).toBe(1);
  }, LONG);

  it('COMMENT-2: every company has a comment section: the ones from day one (stocks and memecoins), and a company that is listed later; an unknown ticker is refused', async () => {
    const r = await boot();
    const { alice } = await crew(r);
    const all = tickers(r);
    expect(all.length).toBeGreaterThanOrEqual(12);
    for (const t of all) {
      const v = await call(r, `/api/comments/${t}`);
      expect([t, v.status, v.json.ticker, v.json.comments]).toEqual([t, 200, t, []]);
    }
    // The first and the last company on the list (an original stock and the newest listing) both take comments, and the ticker may be typed in lower case.
    expect((await write(r, alice, all[0] as string, 'first one')).status).toBe(200);
    expect((await write(r, alice, (all[all.length - 1] as string).toLowerCase(), 'last one')).status).toBe(200);
    // A company listed later (a launch, or a company the owner made) is a new row of the companies table: it works at once, with no setup.
    db(r).run("INSERT INTO companies(ticker, name, listing_tick, listed_ms) VALUES ('NEWCO', 'New Company', 99, ?)", r.clock.now());
    expect((await write(r, alice, 'NEWCO', 'welcome to the market')).status).toBe(200);
    expect(texts(await view(r, 'newco'))).toEqual(['welcome to the market']);
    for (const bad of ['NOPE', '', 'A'.repeat(40)]) {
      const out = await write(r, alice, bad, 'hi');
      expect([bad, out.status, out.json.error?.code]).toEqual([bad, 404, 'no_such_company']);
    }
    expect((await call(r, '/api/comments/NOPE')).status).toBe(404);
    // Each company has its own comments.
    expect(texts(await view(r, all[0] as string))).toEqual(['first one']);
  }, LONG);
});

describe('what a comment may be', () => {
  it('COMMENT-3: one line of plain text: spaces collapsed, hidden and control characters removed, markup kept as plain text, length limited', async () => {
    const r = await boot();
    const { alice } = await crew(r);
    const [t] = tickers(r) as [string];
    expect((await write(r, alice, t, '  to   the\n\tmoon  ')).status).toBe(200);
    expect((await view(r, t)).comments[0].text).toBe('to the moon');
    const tricky = await write(r, alice, t, 'a‮b​c\u0000d');
    expect(tricky.json.comment.text).toBe('a b c d');
    const markup = await write(r, alice, t, '<img src=x onerror=alert(1)> http://evil.example/x [click](http://x)');
    expect(markup.json.comment.text).toBe('<img src=x onerror=alert(1)> http://evil.example/x [click](http://x)');
    // Emoji and non-English text are fine, and the limit counts characters, not bytes.
    expect((await write(r, alice, t, '🚀'.repeat(COMMENT_MAX_LENGTH))).status).toBe(200);
    const tooLong = await write(r, alice, t, 'x'.repeat(COMMENT_MAX_LENGTH + 1));
    expect([tooLong.status, tooLong.json.error.code]).toEqual([400, 'too_long']);
    expect(tooLong.json.error.message).toContain(String(COMMENT_MAX_LENGTH + 1));
    for (const empty of ['', '   ', '\n\t', '​​']) {
      const out = await write(r, alice, t, empty);
      expect([empty, out.status, out.json.error.code]).toEqual([empty, 400, 'empty']);
    }
    for (const notText of [5, null, { a: 1 }, ['x']]) {
      const out = await write(r, alice, t, notText);
      expect([out.status, out.json.error.code]).toEqual([400, 'bad_request']);
    }
    expect((await view(r, t)).comments).toHaveLength(4);
  }, LONG);

  it('COMMENT-4: comments show newest first with the writer, their answers oldest first, and the page can be walked back to the start', async () => {
    const r = await boot();
    const { alice, bob, boss } = await crew(r);
    const [t, other] = tickers(r) as [string, string];
    const first = (await write(r, alice, t, 'first')).json.comment;
    const second = (await write(r, bob, t, 'second')).json.comment;
    const third = (await write(r, boss, t, 'third')).json.comment;
    await write(r, bob, t, 'answer one', first.id);
    await write(r, boss, t, 'answer two', first.id);
    const v = await view(r, t, alice);
    expect(texts(v)).toEqual(['third', 'second', 'first']);
    expect(v.comments.map((c: any) => [c.username, c.role])).toEqual([['boss', 'owner'], ['bob', 'player'], ['alice', 'player']]);
    expect(v.comments[2].replies.map((x: any) => [x.text, x.username])).toEqual([['answer one', 'bob'], ['answer two', 'boss']]);
    expect(v.comments[2].mine).toBe(true);
    expect(v.comments[0].mine).toBe(false);
    expect(v.total).toBe(5);
    expect(v.more).toBe(false);
    expect(v.limits).toEqual({ maxLength: COMMENT_MAX_LENGTH, gapMs: COMMENT_GAP_MS });
    expect(Object.keys(v.comments[0]).sort()).toEqual(['createdMs', 'displayName', 'id', 'liked', 'likes', 'mine', 'replies', 'role', 'text', 'username']);
    expect(second.id).toBeLessThan(third.id);
    // Another company has none of them.
    expect((await view(r, other)).comments).toEqual([]);
    // Walking back through many comments, a page at a time.
    for (let i = 0; i < COMMENT_PAGE + 5; i += 1) plant(r, 'cal', t, `old ${i}`, r.clock.now() - 1_000_000 + i);
    const page1 = await view(r, t);
    expect(page1.comments).toHaveLength(COMMENT_PAGE);
    expect(page1.more).toBe(true);
    const last = page1.comments[page1.comments.length - 1].id;
    const page2 = await view(r, t, undefined, `?before=${last}`);
    expect(page2.comments.length).toBeGreaterThan(0);
    expect(page2.comments.every((c: any) => c.id < last)).toBe(true);
    const seen = new Set([...page1.comments, ...page2.comments].map((c: any) => c.id));
    expect(seen.size).toBe(page1.comments.length + page2.comments.length);
    expect(page2.more).toBe(false);
    // A page is never bigger than the maximum: asking for more is refused.
    expect((await view(r, t, undefined, `?limit=${COMMENT_PAGE_MAX}`)).comments.length).toBeLessThanOrEqual(COMMENT_PAGE_MAX);
    const tooMany = await call(r, `/api/comments/${t}?limit=${COMMENT_PAGE_MAX + 1}`);
    expect([tooMany.status, tooMany.json.error.code]).toEqual([400, 'bad_parameter']);
    expect((await view(r, t, undefined, '?limit=2')).comments).toHaveLength(2);
  }, LONG);
});

describe('answers', () => {
  it('COMMENT-5: an answer goes under its comment; an answer to an answer joins the same thread; an answer cannot cross companies or reach a deleted comment', async () => {
    const r = await boot();
    const { alice, bob, cy } = await crew(r);
    const [t, other] = tickers(r) as [string, string];
    const top = (await write(r, alice, t, 'top')).json.comment;
    const reply = (await write(r, bob, t, 'reply', top.id)).json.comment;
    const deeper = (await write(r, cy, t, 'reply to a reply', reply.id)).json.comment;
    expect(db(r).get<{ parent_id: number }>('SELECT parent_id FROM company_comments WHERE id = ?', deeper.id)?.parent_id).toBe(top.id);
    const v = await view(r, t);
    expect(v.comments).toHaveLength(1);
    expect(v.comments[0].replies.map((x: any) => x.text)).toEqual(['reply', 'reply to a reply']);
    // The wrong company, a missing comment, a bad id.
    for (const [ticker, parentId, code, status] of [[other, top.id, 'no_such_comment', 404], [t, 99_999, 'no_such_comment', 404], [t, 'x', 'bad_request', 400], [t, 0, 'bad_request', 400]] as const) {
      const out = await call(r, '/api/comments/post', { method: 'POST', cookie: alice, body: { ticker, text: 'nope', parentId } });
      r.clock.advanceSeconds(20);
      expect([parentId, out.status, out.json.error.code]).toEqual([parentId, status, code]);
    }
    // Once the comment is deleted nobody can answer it, and its answers disappear from every list.
    expect((await call(r, '/api/comments/delete', { method: 'POST', cookie: alice, body: { commentId: top.id } })).status).toBe(200);
    const gone = await write(r, bob, t, 'too late', top.id);
    expect([gone.status, gone.json.error.code]).toEqual([404, 'no_such_comment']);
    expect((await view(r, t)).comments).toEqual([]);
    expect((await view(r, t)).total).toBe(0);
    expect((await call(r, '/api/comments/recent')).json.comments).toEqual([]);
  }, LONG);

  it('COMMENT-6: a comment takes at most 50 answers', async () => {
    const r = await boot();
    const { alice, bob } = await crew(r);
    const [t] = tickers(r) as [string];
    const top = (await write(r, alice, t, 'popular')).json.comment;
    for (let i = 0; i < REPLIES_MAX; i += 1) plant(r, 'bob', t, `answer ${i}`, r.clock.now() - 10_000 + i, top.id);
    const full = await write(r, bob, t, 'one more', top.id);
    expect([full.status, full.json.error.code]).toEqual([400, 'thread_full']);
    expect(full.json.error.message).toContain(String(REPLIES_MAX));
    // A new comment is still fine.
    expect((await write(r, bob, t, 'a new comment')).status).toBe(200);
  }, LONG);
});

describe('slowing spam down', () => {
  it('COMMENT-7: 15 seconds between comments (counted across companies), the same text is refused for ten minutes', async () => {
    const r = await boot();
    const { alice, bob } = await crew(r);
    const [t, other] = tickers(r) as [string, string];
    const send = (cookie: string, ticker: string, text: string) => call(r, '/api/comments/post', { method: 'POST', cookie, body: { ticker, text } });
    expect((await send(alice, t, 'one')).status).toBe(200);
    const fast = await send(alice, other, 'two');
    expect([fast.status, fast.json.error.code]).toEqual([429, 'too_fast']);
    expect(fast.json.error.message).toMatch(/15 seconds/);
    r.clock.advanceSeconds(COMMENT_GAP_MS / 1000 - 1);
    expect((await send(alice, other, 'two')).status).toBe(429);
    // Somebody else is not slowed by Alice.
    expect((await send(bob, t, 'bob here')).status).toBe(200);
    r.clock.advanceSeconds(1);
    expect((await send(alice, other, 'two')).status).toBe(200);
    // The same words again, in any case, are refused for ten minutes; other words are fine.
    r.clock.advanceSeconds(COMMENT_GAP_MS / 1000 + 1);
    const same = await send(alice, t, 'TWO');
    expect([same.status, same.json.error.code]).toEqual([400, 'repeat']);
    expect((await send(alice, t, 'three')).status).toBe(200);
    r.clock.advanceSeconds(COMMENT_REPEAT_MS / 1000 + 1);
    expect((await send(alice, t, 'three')).status).toBe(200);
  }, LONG);

  it('COMMENT-8: a player writes at most 60 comments in a day, then can again as the day moves on', async () => {
    const r = await boot();
    const { alice } = await crew(r);
    const [t] = tickers(r) as [string];
    for (let i = 0; i < COMMENTS_PER_DAY; i += 1) plant(r, 'alice', t, `spam ${i}`, r.clock.now() - 3_600_000 + i * 1000);
    const capped = await write(r, alice, t, 'one too many');
    expect([capped.status, capped.json.error.code]).toEqual([429, 'daily_cap']);
    expect(capped.json.error.message).toContain(String(COMMENTS_PER_DAY));
    // Others are not affected, and a day later the cap has moved.
    r.clock.advanceSeconds(86_400);
    expect((await write(r, alice, t, 'a new day')).status).toBe(200);
  }, LONG);

  it('COMMENT-9: only the newest 300 comments of a company are kept, with their answers and likes; other companies are not touched', async () => {
    const r = await boot();
    const { alice, bob } = await crew(r);
    const [t, other] = tickers(r) as [string, string];
    const oldest = plant(r, 'bob', t, 'the oldest', 1);
    plant(r, 'alice', t, 'answer to the oldest', 2, oldest);
    db(r).run('INSERT INTO comment_likes(comment_id, user_id, created_ms) VALUES (?, ?, 3)', oldest, idOf(r, 'alice'));
    for (let i = 1; i < COMMENT_KEEP_PER_COMPANY; i += 1) plant(r, 'bob', t, `filler ${i}`, 10 + i);
    plant(r, 'bob', other, 'elsewhere', 5);
    expect(db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM company_comments WHERE parent_id IS NULL AND company_id = (SELECT id FROM companies WHERE ticker = ?)', t)?.n).toBe(COMMENT_KEEP_PER_COMPANY);
    expect((await write(r, alice, t, 'the newest')).status).toBe(200);
    expect(db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM company_comments WHERE parent_id IS NULL AND company_id = (SELECT id FROM companies WHERE ticker = ?)', t)?.n).toBe(COMMENT_KEEP_PER_COMPANY);
    expect(db(r).get('SELECT 1 FROM company_comments WHERE id = ?', oldest)).toBeUndefined();
    expect(db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM company_comments WHERE body = ?', 'answer to the oldest')?.n).toBe(0);
    expect(db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM comment_likes')?.n).toBe(0);
    expect((await view(r, other)).total).toBe(1);
    void bob;
  }, LONG);
});

describe('likes', () => {
  it('COMMENT-10: a like is a switch: one per player, not on your own comment, counted for everybody and shown as liked only to the one who liked', async () => {
    const r = await boot();
    const { alice, bob, cy } = await crew(r);
    const [t] = tickers(r) as [string];
    const c = (await write(r, alice, t, 'like me')).json.comment;
    const like = (cookie: string, id: number) => call(r, '/api/comments/like', { method: 'POST', cookie, body: { commentId: id } });
    expect((await like(bob, c.id)).json).toEqual({ liked: true, likes: 1 });
    expect((await like(cy, c.id)).json).toEqual({ liked: true, likes: 2 });
    const seenByBob = (await view(r, t, bob)).comments[0];
    expect([seenByBob.likes, seenByBob.liked]).toEqual([2, true]);
    const seenByAlice = (await view(r, t, alice)).comments[0];
    expect([seenByAlice.likes, seenByAlice.liked]).toEqual([2, false]);
    expect((await view(r, t)).comments[0].liked).toBe(false);
    expect((await like(bob, c.id)).json).toEqual({ liked: false, likes: 1 });
    expect((await like(bob, c.id)).json).toEqual({ liked: true, likes: 2 });
    const own = await like(alice, c.id);
    expect([own.status, own.json.error.code]).toEqual([400, 'bad_request']);
    const missing = await like(bob, 99_999);
    expect([missing.status, missing.json.error.code]).toEqual([404, 'no_such_comment']);
    const bad = await call(r, '/api/comments/like', { method: 'POST', cookie: bob, body: { commentId: 'x' } });
    expect([bad.status, bad.json.error.code]).toEqual([400, 'bad_request']);
    // Answers can be liked too, and the recent list shows the count.
    const reply = (await write(r, cy, t, 'a reply', c.id)).json.comment;
    expect((await like(alice, reply.id)).json).toEqual({ liked: true, likes: 1 });
    expect((await call(r, '/api/comments/recent')).json.comments.map((x: any) => [x.text, x.likes])).toEqual([['a reply', 1], ['like me', 2]]);
    // Likes need no pause and do not count as comments.
    expect(db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM company_comments')?.n).toBe(2);
  }, LONG);
});

describe('muted and banned players', () => {
  it('COMMENT-11: a player muted in the chat cannot write comments until the mute ends, but can read and like; a chat ban stops comments until lifted', async () => {
    const r = await boot();
    const { boss, alice, bob } = await crew(r);
    const [t] = tickers(r) as [string];
    const c = (await write(r, bob, t, 'bob says')).json.comment;
    const mutedAt = r.clock.now();
    expect((await chatAdmin(r, boss, 'mute', { username: 'alice', minutes: 30, reason: 'noisy' })).status).toBe(200);
    const muted = await write(r, alice, t, 'let me speak');
    expect([muted.status, muted.json.error.code]).toEqual([403, 'muted']);
    expect(muted.json.error.message).toMatch(/muted for another 30 minutes/);
    const v = await view(r, t, alice);
    expect(v.you).toMatchObject({ canWrite: false, reason: 'muted', untilMs: mutedAt + 30 * 60_000 });
    expect(texts(v)).toEqual(['bob says']);
    expect((await call(r, '/api/comments/like', { method: 'POST', cookie: alice, body: { commentId: c.id } })).status).toBe(200);
    // The mute ends by itself.
    r.clock.advanceSeconds(30 * 60 + 1);
    expect((await view(r, t, alice)).you.canWrite).toBe(true);
    expect((await write(r, alice, t, 'back again')).status).toBe(200);
    // A ban from the chat lasts until the owner lifts it.
    expect((await chatAdmin(r, boss, 'ban', { username: 'alice', reason: 'rude' })).status).toBe(200);
    const banned = await write(r, alice, t, 'still here');
    expect([banned.status, banned.json.error.code]).toEqual([403, 'chat_banned']);
    expect((await view(r, t, alice)).you).toMatchObject({ canWrite: false, reason: 'banned' });
    expect((await chatAdmin(r, boss, 'lift', { username: 'alice' })).status).toBe(200);
    expect((await write(r, alice, t, 'free again')).status).toBe(200);
  }, LONG);

  it('COMMENT-12: the comments of a player the owner banned from the game are hidden from every list until he is allowed back', async () => {
    const r = await boot();
    const { boss, alice, bob } = await crew(r);
    const [t] = tickers(r) as [string];
    const c = (await write(r, alice, t, 'alice speaks')).json.comment;
    await write(r, bob, t, 'bob answers alice', c.id);
    await write(r, bob, t, 'bob speaks');
    expect((await call(r, '/api/admin/ban', { method: 'POST', cookie: boss, body: { requestId: requestId(), username: 'alice', reason: 'cheating' } })).status).toBe(200);
    expect(texts(await view(r, t))).toEqual(['bob speaks']);
    expect((await view(r, t)).total).toBe(1);
    expect((await call(r, '/api/comments/recent')).json.comments.map((x: any) => x.text)).toEqual(['bob speaks']);
    expect((await call(r, '/api/admin/unban', { method: 'POST', cookie: boss, body: { requestId: requestId(), username: 'alice' } })).status).toBe(200);
    expect(texts(await view(r, t))).toEqual(['bob speaks', 'alice speaks']);
  }, LONG);
});

describe('reports and deleting', () => {
  it('COMMENT-13: a player reports a comment once; not his own, not the owner\'s; too many reports an hour are refused; the staff see the open reports with a count', async () => {
    const r = await boot();
    const { boss, mia, alice, bob, cy } = await crew(r);
    const [t] = tickers(r) as [string];
    const c = (await write(r, alice, t, 'a bad comment')).json.comment;
    const own = (await write(r, boss, t, 'the owner speaks')).json.comment;
    const report = (cookie: string, id: unknown) => call(r, '/api/comments/report', { method: 'POST', cookie, body: { commentId: id } });
    expect((await report(bob, c.id)).status).toBe(200);
    expect((await report(bob, c.id)).status).toBe(200); // the same report again changes nothing
    expect((await report(cy, c.id)).status).toBe(200);
    const mine = await report(alice, c.id);
    expect([mine.status, mine.json.error.code]).toEqual([400, 'bad_request']);
    const owners = await report(bob, own.id);
    expect([owners.status, owners.json.error.code]).toEqual([400, 'bad_request']);
    expect((await report(bob, 99_999)).status).toBe(404);
    expect((await report(bob, 'x')).status).toBe(400);
    expect(db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM comment_reports')?.n).toBe(2);
    const seen = (await call(r, '/api/admin/comments', { cookie: mia })).json;
    expect(seen.reports).toHaveLength(1);
    expect(seen.reports[0]).toMatchObject({ commentId: c.id, ticker: t, text: 'a bad comment', username: 'alice', reporters: 2, restriction: null });
    // Too many reports in an hour.
    for (let i = 0; i < COMMENT_REPORTS_PER_HOUR; i += 1) plant(r, 'alice', t, `c${i}`);
    const planted = db(r).all<{ id: number }>("SELECT id FROM company_comments WHERE body LIKE 'c%' AND user_id = ?", idOf(r, 'alice'));
    let blocked = 0;
    for (const p of planted) {
      const out = await report(cy, p.id);
      if (out.status === 429) {
        expect(out.json.error.code).toBe('rate_limited');
        blocked += 1;
      }
    }
    expect(blocked).toBeGreaterThan(0);
  }, LONG);

  it('COMMENT-14: a player deletes his own comment (answers go with it); nobody else\'s; the owner and a moderator delete any ordinary player\'s, written to the log once', async () => {
    const r = await boot();
    const { boss, mia, alice, bob } = await crew(r);
    const [t] = tickers(r) as [string];
    const del = (cookie: string, id: number) => call(r, '/api/comments/delete', { method: 'POST', cookie, body: { commentId: id } });
    const mine = (await write(r, alice, t, 'delete me')).json.comment;
    const reply = (await write(r, bob, t, 'bob answers', mine.id)).json.comment;
    const theirs = (await write(r, bob, t, 'bob stays')).json.comment;
    const notYours = await del(alice, theirs.id);
    expect([notYours.status, notYours.json.error.code]).toEqual([403, 'bad_request']);
    expect((await del(alice, 99_999)).status).toBe(404);
    expect((await del(alice, mine.id)).status).toBe(200);
    expect((await del(alice, mine.id)).status).toBe(200); // again: nothing more happens
    expect(texts(await view(r, t))).toEqual(['bob stays']);
    expect(db(r).get<{ deleted_ms: number | null }>('SELECT deleted_ms FROM company_comments WHERE id = ?', reply.id)?.deleted_ms).toBeNull(); // hidden, not erased
    // The staff: a moderator deletes an ordinary player's comment; the same request id twice is one entry in the log.
    const id = requestId();
    const first = await call(r, '/api/admin/comments/delete', { method: 'POST', cookie: mia, body: { requestId: id, commentId: theirs.id } });
    expect([first.status, first.json.duplicate]).toEqual([200, false]);
    const again = await call(r, '/api/admin/comments/delete', { method: 'POST', cookie: mia, body: { requestId: id, commentId: theirs.id } });
    expect([again.status, again.json.duplicate]).toEqual([200, true]);
    expect(texts(await view(r, t))).toEqual([]);
    expect(log(r)).toEqual([{ action: 'comment_delete', target: `comment ${theirs.id}`, admin: 'mia' }]);
    const owned = (await write(r, alice, t, 'owner deletes this')).json.comment;
    expect((await staffCall(r, boss, 'delete', { commentId: owned.id })).status).toBe(200);
    expect(log(r).map((l) => [l.action, l.admin])).toEqual([['comment_delete', 'mia'], ['comment_delete', 'boss']]);
    expect((await staffCall(r, boss, 'delete', { commentId: 99_999 })).status).toBe(404);
    expect((await staffCall(r, boss, 'delete', { commentId: 'x' })).status).toBe(400);
  }, LONG);

  it('COMMENT-15: a moderator never deletes or closes reports about the owner\'s or another moderator\'s comments; the owner can; a moderator does not even see those reports', async () => {
    const r = await boot();
    const { boss, mia, alice } = await crew(r);
    const max = await signUp(r, 'max');
    expect((await call(r, '/api/admin/moderator', { method: 'POST', cookie: boss, body: { requestId: requestId(), username: 'max', on: true } })).status).toBe(200);
    const [t] = tickers(r) as [string];
    const bossOwn = (await write(r, boss, t, 'owner words')).json.comment;
    const maxOwn = (await write(r, max, t, 'max words')).json.comment;
    const miaOwn = (await write(r, mia, t, 'mia words')).json.comment;
    // Reports about a moderator's comment are possible (only the owner's are refused), and only the owner sees them.
    db(r).run('INSERT INTO comment_reports(comment_id, reporter_id, created_ms) VALUES (?, ?, 1)', maxOwn.id, idOf(r, 'alice'));
    db(r).run('INSERT INTO comment_reports(comment_id, reporter_id, created_ms) VALUES (?, ?, 1)', bossOwn.id, idOf(r, 'alice'));
    expect((await call(r, '/api/admin/comments', { cookie: mia })).json.reports).toEqual([]);
    expect((await call(r, '/api/admin/comments', { cookie: boss })).json.reports.map((x: any) => x.commentId).sort()).toEqual([bossOwn.id, maxOwn.id].sort());
    for (const target of [bossOwn, maxOwn]) {
      for (const what of ['delete', 'dismiss'] as const) {
        const out = await staffCall(r, mia, what, { commentId: target.id });
        expect([what, out.status, out.json.error.code]).toEqual([what, 403, 'cannot_moderate_staff']);
      }
    }
    // A moderator may remove his own comment through the same tool, and the owner may remove a moderator's.
    expect((await staffCall(r, mia, 'delete', { commentId: miaOwn.id })).status).toBe(200);
    expect((await staffCall(r, boss, 'delete', { commentId: maxOwn.id })).status).toBe(200);
    expect(texts(await view(r, t))).toEqual(['owner words']);
    expect(log(r).map((l) => [l.action, l.admin])).toEqual([['comment_delete', 'mia'], ['comment_delete', 'boss']]);
    void alice;
  }, LONG);

  it('COMMENT-16: "dismiss" closes the reports without deleting the comment; deleting closes them too; a muted writer shows as muted on the report', async () => {
    const r = await boot();
    const { boss, mia, alice, bob, cy } = await crew(r);
    const [t] = tickers(r) as [string];
    const a = (await write(r, alice, t, 'borderline')).json.comment;
    const b = (await write(r, bob, t, 'worse')).json.comment;
    for (const who of [bob, cy]) await call(r, '/api/comments/report', { method: 'POST', cookie: who, body: { commentId: a.id } });
    await call(r, '/api/comments/report', { method: 'POST', cookie: cy, body: { commentId: b.id } });
    await chatAdmin(r, boss, 'mute', { username: 'bob', minutes: 60 });
    const list = (await call(r, '/api/admin/comments', { cookie: boss })).json.reports;
    expect(list.map((x: any) => [x.commentId, x.reporters, x.restriction])).toEqual([[b.id, 1, 'mute'], [a.id, 2, null]]);
    const dismissId = requestId();
    const out = await call(r, '/api/admin/comments/dismiss', { method: 'POST', cookie: mia, body: { requestId: dismissId, commentId: a.id } });
    expect([out.status, out.json.duplicate]).toEqual([200, false]);
    expect((await call(r, '/api/admin/comments/dismiss', { method: 'POST', cookie: mia, body: { requestId: dismissId, commentId: a.id } })).json.duplicate).toBe(true);
    expect(texts(await view(r, t))).toEqual(['worse', 'borderline']); // dismissing does not delete
    expect((await call(r, '/api/admin/comments', { cookie: boss })).json.reports.map((x: any) => x.commentId)).toEqual([b.id]);
    expect((await staffCall(r, mia, 'delete', { commentId: b.id })).status).toBe(200);
    expect((await call(r, '/api/admin/comments', { cookie: boss })).json.reports).toEqual([]);
    // The reports about a deleted comment are closed in the table too (not just hidden from the list).
    expect(db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM comment_reports WHERE comment_id = ? AND resolved_ms IS NULL', b.id)?.n).toBe(0);
    expect(log(r).map((l) => [l.action, l.admin])).toEqual([['comment_dismiss', 'mia'], ['comment_delete', 'mia']]);
    // A report about a comment its writer deleted himself stays for the staff until they close it.
    const c = (await write(r, alice, t, 'sorry')).json.comment;
    await call(r, '/api/comments/report', { method: 'POST', cookie: bob, body: { commentId: c.id } });
    await call(r, '/api/comments/delete', { method: 'POST', cookie: alice, body: { commentId: c.id } });
    expect((await call(r, '/api/admin/comments', { cookie: boss })).json.reports.map((x: any) => x.commentId)).toEqual([c.id]);
    expect((await staffCall(r, boss, 'dismiss', { commentId: c.id })).status).toBe(200);
    expect((await call(r, '/api/admin/comments', { cookie: boss })).json.reports).toEqual([]);
  }, LONG);
});

describe('the market-wide list', () => {
  it('COMMENT-17: "Recent comments" shows the newest comments and answers of all companies with the company, never deleted ones, at most 50', async () => {
    const r = await boot();
    const { alice, bob } = await crew(r);
    const [a, b] = tickers(r) as [string, string];
    const one = (await write(r, alice, a, 'on A')).json.comment;
    await write(r, bob, b, 'on B');
    await write(r, bob, a, 'reply on A', one.id);
    const v = (await call(r, '/api/comments/recent')).json;
    expect(v.comments.map((x: any) => [x.text, x.ticker, x.reply])).toEqual([['reply on A', a, true], ['on B', b, false], ['on A', a, false]]);
    expect(Object.keys(v.comments[0]).sort()).toEqual(['company', 'createdMs', 'displayName', 'id', 'likes', 'reply', 'role', 'text', 'ticker', 'username']);
    expect(v.comments[0].company).toBe(db(r).get<{ name: string }>('SELECT name FROM companies WHERE ticker = ?', a)?.name);
    expect((await call(r, '/api/comments/recent?limit=2')).json.comments).toHaveLength(2);
    for (let i = 0; i < RECENT_MAX + 5; i += 1) plant(r, 'bob', b, `bulk ${i}`, r.clock.now() + 1000 + i);
    expect((await call(r, `/api/comments/recent?limit=${RECENT_MAX}`)).json.comments).toHaveLength(RECENT_MAX);
    expect((await call(r, `/api/comments/recent?limit=${RECENT_MAX + 1}`)).status).toBe(400);
    expect((await call(r, '/api/comments/recent')).json.comments).toHaveLength(20);
  }, LONG);
});

describe('storage and wiring', () => {
  it('COMMENT-18: schema step 31 adds exactly the comment tables, upgrades an older database, and the tables refuse nonsense and clean up after themselves', () => {
    const last = MIGRATIONS[MIGRATIONS.length - 1] as (typeof MIGRATIONS)[number];
    expect(last.version).toBeGreaterThanOrEqual(31);
    const m31 = MIGRATIONS.find((x) => x.version === 31) as (typeof MIGRATIONS)[number];
    for (const word of ['CREATE TABLE company_comments', 'CREATE TABLE comment_likes', 'CREATE TABLE comment_reports']) expect(m31.sql).toContain(word);
    const dir = mkdtempSync(join(tmpdir(), 'tq-comments-db-'));
    dirs.push(dir);
    const d = new Db(join(dir, 'x.sqlite'));
    try {
      for (const x of MIGRATIONS.filter((v) => v.version <= 30)) {
        d.exec(x.sql);
        d.exec(`PRAGMA user_version = ${x.version}`);
      }
      for (const id of [1, 2]) d.run("INSERT INTO users(id, username, display_name, pw_hash, role, created_ms) VALUES (?, ?, ?, 'x', 'player', 1)", id, `u${id}`, `u${id}`);
      d.run("INSERT INTO companies(id, ticker, name, listing_tick, listed_ms) VALUES (1, 'AAA', 'Alpha', 0, 1)");
      expect(migrate(d)).toEqual([31, 32]);
      expect(d.get<{ user_version: number }>('PRAGMA user_version')?.user_version).toBe(32);
      expect(migrate(d)).toEqual([]);
      for (const t of ['company_comments', 'comment_likes', 'comment_reports']) expect(d.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`)?.n).toBe(0);
      // A comment is 1 to 1200 characters, by a real player, on a real company.
      expect(() => d.run("INSERT INTO company_comments(company_id, user_id, body, created_ms) VALUES (1, 1, '', 1)")).toThrow();
      expect(() => d.run('INSERT INTO company_comments(company_id, user_id, body, created_ms) VALUES (1, 1, ?, 1)', 'x'.repeat(1201))).toThrow();
      expect(() => d.run("INSERT INTO company_comments(company_id, user_id, body, created_ms) VALUES (1, 99, 'hi', 1)")).toThrow();
      expect(() => d.run("INSERT INTO company_comments(company_id, user_id, body, created_ms) VALUES (99, 1, 'hi', 1)")).toThrow();
      d.run("INSERT INTO company_comments(id, company_id, user_id, body, created_ms) VALUES (1, 1, 1, 'top', 1)");
      d.run("INSERT INTO company_comments(id, company_id, user_id, parent_id, body, created_ms) VALUES (2, 1, 2, 1, 'answer', 2)");
      d.run('INSERT INTO comment_likes(comment_id, user_id, created_ms) VALUES (1, 2, 3)');
      expect(() => d.run('INSERT INTO comment_likes(comment_id, user_id, created_ms) VALUES (1, 2, 4)')).toThrow(); // one like per player
      d.run('INSERT INTO comment_reports(comment_id, reporter_id, created_ms) VALUES (1, 2, 3)');
      expect(() => d.run('INSERT INTO comment_reports(comment_id, reporter_id, created_ms) VALUES (1, 2, 4)')).toThrow(); // one report per player
      // Deleting a comment takes its answers, likes and reports; deleting a player takes his comments.
      d.run('DELETE FROM company_comments WHERE id = 1');
      for (const t of ['comment_likes', 'comment_reports']) expect(d.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`)?.n).toBe(0);
      expect(d.get<{ n: number }>('SELECT COUNT(*) AS n FROM company_comments')?.n).toBe(0);
      d.run("INSERT INTO company_comments(id, company_id, user_id, body, created_ms) VALUES (3, 1, 2, 'x', 1)");
      d.run('DELETE FROM users WHERE id = 2');
      expect(d.get<{ n: number }>('SELECT COUNT(*) AS n FROM company_comments')?.n).toBe(0);
    } finally {
      d.close();
    }
  }, LONG);

  it('COMMENT-19: the routes are registered in one place, comments never touch money or prices, and the module uses no randomness', () => {
    const routes = readFileSync(resolve(process.cwd(), 'server', 'routes', 'comments.ts'), 'utf8');
    for (const path of ['/api/comments/recent', '/api/comments/:ticker', '/api/comments/post', '/api/comments/like', '/api/comments/report', '/api/comments/delete', '/api/admin/comments', '/api/admin/comments/delete', '/api/admin/comments/dismiss']) expect(routes).toContain(`'${path}'`);
    // '/api/comments/recent' comes before '/api/comments/:ticker', which would otherwise take it for a ticker.
    expect(routes.indexOf("'/api/comments/recent'")).toBeLessThan(routes.indexOf("'/api/comments/:ticker'"));
    const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const module = code(readFileSync(resolve(process.cwd(), 'server', 'comments.ts'), 'utf8'));
    expect(module).not.toMatch(/Math\.random|Date\.now|new Date/);
    expect(module).not.toMatch(/\b(accounts|trades|positions|orders|cash_cents|holdings|prices?)\b/i);
    expect(module).not.toMatch(/from '\.\/(trading|world|market|launch|accounts|prices)/);
    const admin = readFileSync(resolve(process.cwd(), 'server', 'admin.ts'), 'utf8');
    expect(admin).toContain("'comment_delete' | 'comment_dismiss'");
  });
});

describe('deleting from the Recent comments list', () => {
  it('COMMENT-26: the owner removes any comment that shows in "Recent comments" (a player\'s, a moderator\'s, an answer, his own) with the same route as under a chart; each is gone from the list at once and written once to the log; a moderator still cannot remove the owner\'s', async () => {
    const r = await boot();
    const { boss, mia, alice, bob } = await crew(r);
    const [t1, t2] = tickers(r) as [string, string];
    const player = (await write(r, alice, t1, 'alice words')).json.comment;
    r.clock.advanceSeconds(20);
    const answer = (await write(r, bob, t1, 'bob answers alice', player.id)).json.comment;
    r.clock.advanceSeconds(20);
    const modOwn = (await write(r, mia, t2, 'mia words')).json.comment;
    r.clock.advanceSeconds(20);
    const bossOwn = (await write(r, boss, t2, 'owner words')).json.comment;
    const recent = async (): Promise<string[]> => (await call(r, '/api/comments/recent')).json.comments.map((c: any) => c.text);
    expect((await recent()).sort()).toEqual(['alice words', 'bob answers alice', 'mia words', 'owner words']);
    // A moderator cannot take the owner's line out of the list; it stays.
    const refused = await staffCall(r, mia, 'delete', { commentId: bossOwn.id });
    expect([refused.status, refused.json.error.code]).toEqual([403, 'cannot_moderate_staff']);
    expect(await recent()).toContain('owner words');
    // The owner can remove each kind, one by one.
    const gone: string[] = [];
    for (const [c, text] of [[answer, 'bob answers alice'], [modOwn, 'mia words'], [player, 'alice words'], [bossOwn, 'owner words']] as const) {
      const out = await staffCall(r, boss, 'delete', { commentId: c.id });
      expect([text, out.status, out.json.duplicate]).toEqual([text, 200, false]);
      gone.push(text);
      expect(await recent(), text).not.toContain(text);
    }
    expect(await recent()).toEqual([]);
    expect(log(r).map((l) => [l.action, l.admin])).toEqual([['comment_delete', 'boss'], ['comment_delete', 'boss'], ['comment_delete', 'boss'], ['comment_delete', 'boss']]);
    // A line that is already gone (two screens open): a clear answer, and the list is unchanged.
    const late = await staffCall(r, boss, 'delete', { commentId: player.id });
    expect(late.status).toBe(200);
    const never = await staffCall(r, boss, 'delete', { commentId: 99_999 });
    expect([never.status, never.json.error.code]).toEqual([404, 'no_such_comment']);
    // Players and signed-out visitors never reach the route.
    expect((await staffCall(r, alice, 'delete', { commentId: player.id })).status).toBeGreaterThanOrEqual(401);
    expect((await call(r, '/api/admin/comments/delete', { method: 'POST', body: { requestId: requestId(), commentId: player.id } })).status).toBe(401);
  }, LONG);
});

