// Pictures for stocks and memecoins (docs/world.md §20, server/companyPictures.ts). The properties that matter: everybody can look at a picture (the
// market is public) but only the player who LAUNCHED a company and the owner can set or remove it, and the owner can do so for any company, the
// built-in ones too; a picture is accepted only when it really is a small JPEG, PNG or WebP (a tiny file can claim to be a huge picture); a
// picture is kept as it came and shown with safe headers; a player changes pictures only so often (the owner is not limited); what the owner
// changes on a company that is not his own launch is written to the admin log once per requestId; a picture changes nothing about money or prices.
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../server/app';
import { loadConfig } from '../server/config';
import { Logger } from '../server/log';
import { AVATAR_CHANGES_PER_HOUR, AVATAR_MAX_BYTES, AVATAR_MAX_SIDE } from '../server/profile';
import { MIGRATIONS } from '../server/schema';
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
  const dir = mkdtempSync(join(tmpdir(), 'tq-cpic-'));
  dirs.push(dir);
  const clock = new Clock();
  const config = loadConfig({ TQ_DATA_DIR: dir, TQ_COMPANIES: '66', TQ_WARMUP_DAYS: '1', TQ_PORT: '8787', TQ_OWNER: 'boss' });
  const app = createApp({ config, log: new Logger({ sink: null, now: clock.now }), worldSeed: 777, now: clock.now, flowGain: 0, memecoins: false });
  const server = createServer(app.handler);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const r = { app, server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, dir, clock };
  running.push(r);
  return r;
}

async function call(r: Running, path: string, init: { method?: string; body?: unknown; cookie?: string; raw?: string } = {}) {
  const headers: Record<string, string> = {};
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
let nextRequest = 0;
const requestId = (): string => `cpic-test-${(nextRequest += 1)}-abcdef`;
const post = (r: Running, path: string, cookie: string | undefined, body: Record<string, unknown> = {}) => call(r, path, { method: 'POST', cookie, body: { requestId: requestId(), ...body } });

/** The owner (boss), Alice (who has cash and launched the stock ACMR) and Bob (who launched nothing). */
async function world(r: Running) {
  const [boss, alice, bob] = [await signUp(r, 'boss'), await signUp(r, 'alice'), await signUp(r, 'bob')];
  expect((await post(r, '/api/admin/cash', boss, { username: 'alice', amountCents: 1_000_000 })).status).toBe(200);
  const made = await post(r, '/api/launch/stock', alice, { name: 'Acme Robotics', ticker: 'ACMR', sector: 'robotics', seedCents: 500_000 });
  expect(made.status).toBe(200);
  const market = (await call(r, '/api/market')).json.companies as { ticker: string; launched: boolean }[];
  const builtIn = (market.find((c) => !c.launched) as { ticker: string }).ticker;
  return { boss, alice, bob, builtIn };
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
  return new Uint8Array([0xff, 0xd8, 0xff, 0xfe, 0x00, 0x04, 0x68, 0x69, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);
}
const url = (mime: string, bytes: Uint8Array): string => `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
const setPicture = (r: Running, cookie: string | undefined, ticker: string, image: unknown, extra: Record<string, unknown> = {}) => call(r, `/api/company-picture/${ticker}`, { method: 'POST', cookie, body: { image, ...extra } });
const removePicture = (r: Running, cookie: string | undefined, ticker: string, extra: Record<string, unknown> = {}) => call(r, `/api/company-picture/${ticker}/remove`, { method: 'POST', cookie, body: extra });
const stored = (r: Running): number => db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM company_pictures')?.n ?? 0;

describe('pictures for stocks and memecoins', () => {
  it('CPIC-1: anybody can look at the pictures, signed in or not; changing one, and asking whether you may, needs a signed-in player', async () => {
    const r = await boot();
    const { alice } = await world(r);
    expect((await call(r, '/api/company-pictures')).json).toEqual({ pictures: {} });
    expect((await call(r, '/api/company-picture/ACMR')).status).toBe(404);
    expect((await setPicture(r, undefined, 'ACMR', url('image/png', png(8, 8)))).status).toBe(401);
    expect((await removePicture(r, undefined, 'ACMR')).status).toBe(401);
    expect((await call(r, '/api/company-picture/ACMR/rights')).status).toBe(401);
    expect((await call(r, '/api/company-picture/ACMR/rights', { cookie: alice })).json).toEqual({ canChange: true, ticker: 'ACMR', hasPicture: false });
    expect(stored(r)).toBe(0);
  }, LONG);

  it('CPIC-2: the launcher sets and changes the picture of his company; it is shown to everybody with safe headers and the page is told at once', async () => {
    const r = await boot();
    const { alice } = await world(r);
    const visitor = await listen(r);
    const bytes = jpeg(128, 128);
    const set = await setPicture(r, alice, 'ACMR', url('image/jpeg', bytes));
    expect(set.status).toBe(200);
    const v1 = set.json.version as number;
    expect(set.json).toMatchObject({ ok: true, duplicate: false, ticker: 'ACMR' });
    // a visitor who is not signed in sees the list and the picture
    expect((await call(r, '/api/company-pictures')).json).toEqual({ pictures: { ACMR: v1 } });
    const got = await fetch(`${r.base}/api/company-picture/ACMR?v=${v1}`);
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toBe('image/jpeg');
    expect(got.headers.get('x-content-type-options')).toBe('nosniff');
    expect(got.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(got.headers.get('cache-control')).toContain('immutable');
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(bytes);
    const plain = await fetch(`${r.base}/api/company-picture/ACMR`);
    expect(plain.headers.get('cache-control')).toContain('no-cache');
    expect((await fetch(`${r.base}/api/company-picture/ACMR`, { headers: { 'If-None-Match': `"${v1}"` } })).status).toBe(304);
    expect(await until(() => visitor.text().includes('event: company_picture'))).toBe(true);
    expect(visitor.text()).toContain(`"ticker":"ACMR","v":${v1}`);
    // he changes it: one row, a new number, the new kind of picture; the ticker may be typed in small letters
    const set2 = await setPicture(r, alice, 'acmr', url('image/png', png(64, 64)));
    expect(set2.status).toBe(200);
    expect(set2.json.version).toBeGreaterThan(v1);
    expect(stored(r)).toBe(1);
    expect((await fetch(`${r.base}/api/company-picture/ACMR`)).headers.get('content-type')).toBe('image/png');
    // he takes it away; everybody hears, and taking away nothing is fine
    expect((await removePicture(r, alice, 'ACMR')).status).toBe(200);
    expect(await until(() => visitor.text().includes('"ticker":"ACMR","v":null'))).toBe(true);
    expect((await call(r, '/api/company-pictures')).json).toEqual({ pictures: {} });
    expect((await call(r, '/api/company-picture/ACMR')).status).toBe(404);
    expect((await removePicture(r, alice, 'ACMR')).status).toBe(200);
  }, LONG);

  it('CPIC-3: nobody else can change a company\'s picture: not another player, not the launcher for a company he did not launch', async () => {
    const r = await boot();
    const { alice, bob, builtIn } = await world(r);
    const image = url('image/png', png(32, 32));
    const refused = async (res: Promise<{ status: number; json: any }>, what: string) => {
      const out = await res;
      expect([what, out.status, out.json.error.code]).toEqual([what, 403, 'not_allowed']);
    };
    await refused(setPicture(r, bob, 'ACMR', image), 'bob sets alice\'s');
    await refused(removePicture(r, bob, 'ACMR'), 'bob removes alice\'s');
    await refused(setPicture(r, alice, builtIn, image), 'alice sets a built-in one');
    await refused(removePicture(r, alice, builtIn), 'alice removes a built-in one');
    expect((await call(r, '/api/company-picture/ACMR/rights', { cookie: bob })).json.canChange).toBe(false);
    expect((await call(r, `/api/company-picture/${builtIn}/rights`, { cookie: alice })).json.canChange).toBe(false);
    expect(stored(r)).toBe(0);
    // the launcher's picture cannot be taken away by somebody else either
    await setPicture(r, alice, 'ACMR', image);
    await refused(removePicture(r, bob, 'ACMR'), 'bob removes it');
    expect(stored(r)).toBe(1);
  }, LONG);

  it('CPIC-4: the owner sets and removes the picture of any company, built-in ones too; it is logged once per request and needs a request number', async () => {
    const r = await boot();
    const { boss, alice, builtIn } = await world(r);
    const image = url('image/png', png(48, 48));
    expect((await call(r, `/api/company-picture/${builtIn}/rights`, { cookie: boss })).json).toMatchObject({ canChange: true, hasPicture: false });
    // a change of a company he did not launch must carry a request number (so a double click is not done twice)
    expect((await setPicture(r, boss, builtIn, image)).status).toBe(400);
    expect(stored(r)).toBe(0);
    const once = { requestId: 'cpic-owner-set-once-1' };
    const first = await setPicture(r, boss, builtIn, image, once);
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ ok: true, duplicate: false, ticker: builtIn });
    const again = await setPicture(r, boss, builtIn, url('image/png', png(50, 50)), once);
    expect(again.json).toMatchObject({ ok: true, duplicate: true, version: null });
    expect(Object.keys((await call(r, '/api/company-pictures')).json.pictures)).toEqual([builtIn]);
    // the owner also changes and removes the picture of a company a player launched
    await setPicture(r, alice, 'ACMR', image);
    expect((await setPicture(r, boss, 'ACMR', url('image/png', png(40, 40)), { requestId: 'cpic-owner-set-two-2' })).status).toBe(200);
    const gone = { requestId: 'cpic-owner-gone-3' };
    expect((await removePicture(r, boss, 'ACMR', gone)).json).toMatchObject({ ok: true, duplicate: false });
    expect((await removePicture(r, boss, 'ACMR', gone)).json.duplicate).toBe(true);
    expect((await removePicture(r, boss, builtIn)).status).toBe(400);
    expect(Object.keys((await call(r, '/api/company-pictures')).json.pictures)).toEqual([builtIn]);
    expect(db(r).all<{ action: string; target: string }>("SELECT action, target FROM admin_log WHERE action LIKE 'company_pic_%' ORDER BY id")).toEqual([
      { action: 'company_pic_set', target: builtIn },
      { action: 'company_pic_set', target: 'ACMR' },
      { action: 'company_pic_remove', target: 'ACMR' },
    ]);
    // the player can put one back afterwards
    expect((await setPicture(r, alice, 'ACMR', image)).status).toBe(200);
    // a request number cannot be used for another action
    expect((await setPicture(r, boss, builtIn, image, { requestId: 'cpic-owner-gone-3' })).status).toBe(409);
  }, LONG);

  it('CPIC-5: pictures that are not pictures, too big or too wide are refused, and nothing is stored', async () => {
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
    for (const [what, image, status] of refused) expect([what, (await setPicture(r, alice, 'ACMR', image)).status]).toEqual([what, status]);
    expect((await setPicture(r, alice, 'ACMR', url('image/png', png(AVATAR_MAX_SIDE, AVATAR_MAX_SIDE)))).status).toBe(200);
    expect((await setPicture(r, alice, 'ACMR', url('image/png', png(AVATAR_MAX_SIDE + 1, 8)))).status).toBe(413);
    const huge = await call(r, '/api/company-picture/ACMR', { method: 'POST', cookie: alice, raw: JSON.stringify({ image: 'data:image/png;base64,' + 'A'.repeat(200_000) }) });
    expect(huge.status).toBe(413);
    expect(stored(r)).toBe(1); // only the one good picture
    // the database itself refuses a picture that is too big or of another kind
    expect(() => db(r).run("INSERT INTO company_pictures(company_id, mime, data, updated_ms) VALUES (1, 'text/html', x'00', 0)")).toThrow();
    expect(() => db(r).run("INSERT INTO company_pictures(company_id, mime, data, updated_ms) VALUES (2, 'image/png', zeroblob(70000), 0)")).toThrow();
  }, LONG);

  it('CPIC-6: a company that is not there is not found; a player changes pictures only so often, the owner is not limited', async () => {
    const r = await boot();
    const { boss, alice, builtIn } = await world(r);
    const image = url('image/png', png(8, 8));
    for (const ticker of ['NOPE', 'ZZZZZZZZZZZZZZZZ', '%20']) {
      const res = await setPicture(r, alice, ticker, image);
      expect([ticker, res.status, res.json.error.code]).toEqual([ticker, 404, 'no_such_company']);
    }
    expect((await call(r, '/api/company-picture/NOPE/rights', { cookie: alice })).status).toBe(404);
    for (let i = 0; i < AVATAR_CHANGES_PER_HOUR; i += 1) expect((await setPicture(r, alice, 'ACMR', url('image/png', png(8 + i, 8)))).status).toBe(200);
    const over = await setPicture(r, alice, 'ACMR', url('image/png', png(40, 40)));
    expect([over.status, over.json.error.code]).toEqual([429, 'rate_limited']);
    r.clock.advanceSeconds(3601);
    expect((await setPicture(r, alice, 'ACMR', url('image/png', png(40, 40)))).status).toBe(200);
    // the owner may set a picture for company after company, far past the limit
    for (let i = 0; i < AVATAR_CHANGES_PER_HOUR + 5; i += 1) expect((await setPicture(r, boss, builtIn, url('image/png', png(8 + i, 8)), { requestId: requestId() })).status).toBe(200);
  }, LONG);

  it('CPIC-7: a picture changes nothing about money or prices, and the table is tied to the companies', async () => {
    const r = await boot();
    const { alice } = await world(r);
    const cash = (await call(r, '/api/account', { cookie: alice })).json.cashCents as number;
    const prices = (await call(r, '/api/market')).json.companies.map((c: any) => [c.ticker, c.price]);
    expect((await setPicture(r, alice, 'ACMR', url('image/png', png(64, 64)))).status).toBe(200);
    expect((await call(r, '/api/account', { cookie: alice })).json.cashCents).toBe(cash);
    expect((await call(r, '/api/market')).json.companies.map((c: any) => [c.ticker, c.price])).toEqual(prices);
    const keys = db(r).all<{ table: string; on_delete: string }>("SELECT \"table\", on_delete FROM pragma_foreign_key_list('company_pictures') ORDER BY \"table\"");
    expect(keys).toEqual([
      { table: 'companies', on_delete: 'NO ACTION' },
      { table: 'users', on_delete: 'SET NULL' },
    ]);
    const m24 = MIGRATIONS.find((m) => m.version === 24);
    expect(m24?.sql).toContain('CREATE TABLE company_pictures');
    expect(MIGRATIONS[MIGRATIONS.length - 1]?.version).toBeGreaterThanOrEqual(24);
    const src = await import('node:fs').then((fs) => fs.readFileSync(join(process.cwd(), 'server', 'routes', 'companyPictures.ts'), 'utf8'));
    for (const path of ['/api/company-pictures', '/api/company-picture/:ticker', '/api/company-picture/:ticker/rights', '/api/company-picture/:ticker/remove']) expect(src).toContain(`'${path}'`);
  }, LONG);
});
