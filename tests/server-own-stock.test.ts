// Companies made by the owner. The rules checked here: only the owner can make one; every input is checked and nothing is half-made;
// the same request never makes two; the new company is a real one (it lists a few seconds later, trades, has news and charts, can be
// moved and halted); and — the important one — adding it to the RUNNING market gives exactly the prices that loading it at a restart
// gives, including the sector-wide and market-wide stories that were already loaded when it was made.
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../server/app';
import { loadConfig } from '../server/config';
import { makeEntry } from '../server/customStock';
import { FLOW_MOVE_SHARE, pushOf } from '../server/flow';
import { Logger } from '../server/log';
import { MIGRATIONS, migrate } from '../server/schema';
import { Db } from '../server/sqlite';
import { WorldRuntime, type NewsHooks } from '../server/world/runtime';
import { MAX_PRICE, type Company, type WorldEvent } from '../src/world';
import { Clock, makeRig } from './helpers/server';

const LONG = 240_000;
/** The market has the 66 hand-written companies; the owner's own companies get the ids after them. */
const BASE = 66;

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

async function boot(options: { dir?: string; clock?: Clock; flow?: number } = {}): Promise<Running> {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'tq-ostk-'));
  if (!options.dir) dirs.push(dir);
  const clock = options.clock ?? new Clock();
  const config = loadConfig({ TQ_DATA_DIR: dir, TQ_COMPANIES: '66', TQ_WARMUP_DAYS: '1', TQ_PORT: '8787', TQ_OWNER: 'boss' });
  const app = createApp({ config, log: new Logger({ sink: null, now: clock.now }), worldSeed: 777, now: clock.now, flowGain: options.flow ?? 0 });
  const server = createServer(app.handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const r = { app, server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, dir, clock };
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
  for (let i = 0; i < 400_000 && w.sim.tick < w.currentTick(); i += 1) w.pump();
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
  return (res.headers.get('set-cookie') ?? '').split(';')[0] as string;
}

async function logIn(r: Running, name: string): Promise<string> {
  const res = await fetch(r.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: name, password: 'a-good-password' }) });
  expect(res.status).toBe(200);
  return (res.headers.get('set-cookie') ?? '').split(';')[0] as string;
}

let counter = 0;
const rid = (): string => `req-${(counter += 1).toString().padStart(8, '0')}`;
const post = (r: Running, path: string, cookie: string | undefined, body: Record<string, unknown>) => call(r, path, { method: 'POST', cookie, body: { requestId: rid(), ...body } });

const ZRLX = { name: 'Zorlex Robotics', ticker: 'ZRLX', sector: 'robotics', tier: 'small', personality: 'growth', priceCents: 1250 };
const make = (r: Running, cookie: string | undefined, over: Record<string, unknown> = {}) => post(r, '/api/admin/stock', cookie, { ...ZRLX, ...over });

let orderNo = 0;
const trade = (r: Running, cookie: string, body: Record<string, unknown> = {}) =>
  call(r, '/api/orders', { method: 'POST', cookie, body: { account: 'career', ticker: 'ZRLX', side: 'buy', qty: 10, clientOrderId: `order-${(orderNo += 1)}-abcdef`, ...body } });

const market = async (r: Running) => (await call(r, '/api/market')).json.companies as any[];
const rowsOf = (r: Running, sql: string, ...params: (string | number)[]) => r.app.services.db.all(sql, ...params);
const logOf = (r: Running, action: string) => rowsOf(r, 'SELECT target, detail_json FROM admin_log WHERE action = ? ORDER BY id', action) as { target: string; detail_json: string }[];

async function openStream(r: Running) {
  const ctrl = new AbortController();
  const res = await fetch(r.base + '/api/stream', { signal: ctrl.signal });
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const dec = new TextDecoder();
  let text = '';
  return {
    async until(needle: string, ms = 5000): Promise<string> {
      const stopAt = Date.now() + ms;
      while (!text.includes(needle) && Date.now() < stopAt) {
        const next = await Promise.race([reader.read(), new Promise<{ done: true; value: undefined }>((resolve) => setTimeout(() => resolve({ done: true, value: undefined }), Math.max(50, stopAt - Date.now())))]);
        if (next.value) text += dec.decode(next.value);
        if (next.done) break;
      }
      return text;
    },
    close: () => ctrl.abort(),
  };
}

// ---- making a company -------------------------------------------------------------------------------------------------------

describe('making a company', () => {
  it('OSTK-1: only the owner can make one; the form options come with the admin state', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const boss = await signUp(r, 'boss');
    expect((await make(r, undefined)).status).toBe(401);
    expect((await make(r, alice)).status).toBe(403);
    expect(await market(r)).toHaveLength(BASE);
    expect(rowsOf(r, 'SELECT * FROM custom_companies')).toHaveLength(0);

    const state = (await call(r, '/api/admin/state', { cookie: boss })).json;
    expect(state.stocks).toEqual([]);
    expect(state.stockForm.sectors).toHaveLength(13);
    expect(state.stockForm.tiers.map((t: any) => t.id)).toEqual(['micro', 'small', 'mid', 'large', 'mega']);
    expect(state.stockForm.personalities.map((p: any) => p.id).sort()).toEqual(['cyclical', 'declining', 'growth', 'income', 'steady', 'turnaround', 'volatile']);
    expect(state.stockForm).toMatchObject({ minPriceCents: 200, maxPriceCents: 100_000, listsInSeconds: 30 });
    const forPlayer = await call(r, '/api/admin/state', { cookie: alice });
    expect(forPlayer.status).toBe(403);
  }, LONG);

  it('OSTK-2: a new company lists a few seconds later at the chosen price, then trades like any other', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const boss = await signUp(r, 'boss');
    const made = await make(r, boss);
    expect(made.status).toBe(200);
    expect(made.json).toMatchObject({ ok: true, duplicate: false, ticker: 'ZRLX', name: 'Zorlex Robotics', companyId: BASE, loaded: true });
    expect(made.json.startsInSeconds).toBeGreaterThanOrEqual(30);
    expect(made.json.startsInSeconds).toBeLessThanOrEqual(40);

    // It is in the market list at once, but does not trade yet.
    let rows = await market(r);
    expect(rows).toHaveLength(BASE + 1);
    const before = rows.find((c) => c.ticker === 'ZRLX');
    expect(before).toMatchObject({ id: BASE, name: 'Zorlex Robotics', sector: 'robotics', tier: 'small', trading: false });
    expect(before.listsInTicks).toBeGreaterThan(0);
    const early = await trade(r, alice);
    expect(early.status).toBe(400);
    expect(early.json.error.code).toBe('not_trading');
    const state = (await call(r, '/api/admin/state', { cookie: boss })).json;
    expect(state.stocks).toHaveLength(1);
    expect(state.stocks[0]).toMatchObject({ ticker: 'ZRLX', loaded: true, trading: false, startPriceCents: 1250 });

    advance(r, 45);
    rows = await market(r);
    const now = rows.find((c) => c.ticker === 'ZRLX');
    expect(now.trading).toBe(true);
    expect(now.price).toBeGreaterThan(1000);
    expect(now.price).toBeLessThan(1500); // seconds after listing, still near $12.50
    const detail = (await call(r, '/api/market/ZRLX')).json;
    expect(detail).toMatchObject({ ticker: 'ZRLX', name: 'Zorlex Robotics', industry: 'Robotics', sector: 'robotics' });
    expect(detail.description).toContain('Zorlex Robotics');
    expect(detail.products).toEqual(['Zorlex Arm', 'Zorlex Walker']);
    expect(detail.sharesOutstanding).toBeGreaterThan(0);

    // A player can trade it, and the book and charts work.
    const bought = await trade(r, alice);
    expect(bought.status).toBe(201);
    expect(bought.json.trade ?? bought.json).toBeTruthy();
    expect((await call(r, '/api/market/ZRLX/book')).status).toBe(200);
    advance(r, 300);
    const candles = (await call(r, '/api/market/ZRLX/candles?res=c10&limit=50')).json.candles;
    expect(candles.length).toBeGreaterThan(20);
    expect(candles.every((c: any) => c.low <= c.open && c.low <= c.close && c.high >= c.open && c.high >= c.close && c.low > 0)).toBe(true);
    expect((await trade(r, alice, { side: 'sell', qty: 10 })).status).toBe(201);
    // The 24-hour figures of the new company are real numbers (they come from the rolling statistics, which had to grow).
    const stats = (await market(r)).find((c) => c.ticker === 'ZRLX');
    expect(stats.volume24h).toBeGreaterThan(0);
    expect(stats.low24h).toBeGreaterThan(0);
    expect(stats.high24h).toBeGreaterThanOrEqual(stats.low24h);
    expect(stats.open24h).toBeGreaterThan(0);
    expect(Number.isInteger(stats.changeBps)).toBe(true);

    // Others are untouched: same 12 companies, same ids.
    expect(rows.slice(0, BASE).map((c) => c.ticker)).toEqual((await market(r)).slice(0, BASE).map((c) => c.ticker));
    expect(logOf(r, 'stock')).toHaveLength(1);
    expect(JSON.parse(logOf(r, 'stock')[0]?.detail_json ?? '{}')).toMatchObject({ companyId: BASE, name: 'Zorlex Robotics', priceCents: 1250, tier: 'small', personality: 'growth' });
  }, LONG);

  it('OSTK-3: bad input is refused and nothing is half-made', async () => {
    const r = await boot();
    const boss = await signUp(r, 'boss');
    const existing = (await market(r))[3];
    const bad: Record<string, unknown>[] = [
      { name: 'ab' },
      { name: '' },
      { name: 'x'.repeat(41) },
      { name: '<script>' },
      { name: '1234' },
      { name: 12 },
      { ticker: 'ab' },
      { ticker: 'ABCDEF' },
      { ticker: 'AB1' },
      { ticker: 'ZR LX' },
      { ticker: 5 },
      { ticker: existing.ticker },
      { name: existing.name.toLowerCase() },
      { sector: 'crypto' },
      { sector: 7 },
      { tier: 'huge' },
      { personality: 'angry' },
      { personality: '__proto__' },
      { personality: 'constructor' },
      { priceCents: 199 },
      { priceCents: 100_001 },
      { priceCents: 1250.5 },
      { priceCents: '1250' },
      { priceCents: null },
      { industry: '<b>' },
      { industry: 'y'.repeat(51) },
      { description: 'z'.repeat(301) },
      { description: 5 },
    ];
    for (const over of bad) {
      const res = await make(r, boss, over);
      if (![400, 409].includes(res.status)) throw new Error(`Input ${JSON.stringify(over)} was answered with ${res.status}`);
    }
    expect((await post(r, '/api/admin/stock', boss, { ...ZRLX, requestId: 'short' })).status).toBe(400);
    expect(await market(r)).toHaveLength(BASE);
    expect(rowsOf(r, 'SELECT * FROM custom_companies')).toHaveLength(0);
    expect(rowsOf(r, 'SELECT * FROM companies')).toHaveLength(BASE);
    expect(logOf(r, 'stock')).toHaveLength(0);

    // Names and tickers may not repeat among the owner's own companies either.
    expect((await make(r, boss)).status).toBe(200);
    const sameTicker = await make(r, boss, { name: 'Another Name' });
    expect(sameTicker.status).toBe(409);
    expect(sameTicker.json.error.code).toBe('ticker_taken');
    const sameName = await make(r, boss, { ticker: 'OTHR', name: 'zorlex robotics' });
    expect(sameName.status).toBe(409);
    expect(sameName.json.error.code).toBe('name_taken');
    expect(await market(r)).toHaveLength(BASE + 1);

    // Plain edge values that are fine.
    const edge = await make(r, boss, { name: 'Ōtsuka Ventures & Co.', ticker: 'otk', priceCents: 200, industry: 'Space / launch', description: 'A short one.', sector: 'emerging', tier: 'micro', personality: 'turnaround' });
    expect(edge.status).toBe(200);
    expect(edge.json.ticker).toBe('OTK');
    const detail = (await call(r, '/api/market/OTK')).json;
    expect(detail).toMatchObject({ name: 'Ōtsuka Ventures & Co.', industry: 'Space / launch', description: 'A short one.' });
  }, LONG);

  it('OSTK-4: the same request never makes two companies', async () => {
    const r = await boot();
    const boss = await signUp(r, 'boss');
    const id = 'same-request-0001';
    const first = await call(r, '/api/admin/stock', { method: 'POST', cookie: boss, body: { requestId: id, ...ZRLX } });
    const second = await call(r, '/api/admin/stock', { method: 'POST', cookie: boss, body: { requestId: id, ...ZRLX } });
    expect(first.json.duplicate).toBe(false);
    expect(second.status).toBe(200);
    expect(second.json).toMatchObject({ ok: true, duplicate: true, ticker: 'ZRLX' });
    expect(await market(r)).toHaveLength(BASE + 1);
    expect(logOf(r, 'stock')).toHaveLength(1);
    const other = await call(r, '/api/admin/stock', { method: 'POST', cookie: boss, body: { requestId: id, ...ZRLX, ticker: 'QQQQ', name: 'Quad Q' } });
    expect(other.status).toBe(409);
    expect(other.json.error.code).toBe('request_id_reused');
    expect(await market(r)).toHaveLength(BASE + 1);
  }, LONG);

  it('OSTK-5: the owner\'s other tools work on the new company (price move, halt, shares), and players\' trades move it', async () => {
    const r = await boot({ flow: 5 });
    const alice = await signUp(r, 'alice');
    const boss = await signUp(r, 'boss');
    await make(r, boss, { tier: 'micro' });
    advance(r, 120);

    const priceOf = async () => (await market(r)).find((c) => c.ticker === 'ZRLX').price as number;
    const p0 = await priceOf();
    expect((await post(r, '/api/admin/shock', boss, { ticker: 'ZRLX', percent: 100, style: 'pump', speed: 'fast' })).status).toBe(200);
    advance(r, 400);
    expect(await priceOf()).toBeGreaterThan(p0 * 1.6);

    expect((await post(r, '/api/admin/halt', boss, { ticker: 'ZRLX', halted: true, reason: 'checking' })).status).toBe(200);
    expect((await trade(r, alice)).status).toBe(403);
    expect((await post(r, '/api/admin/halt', boss, { ticker: 'ZRLX', halted: false })).status).toBe(200);
    expect((await trade(r, alice)).status).toBe(201);

    expect((await post(r, '/api/admin/shares', boss, { username: 'alice', ticker: 'ZRLX', qty: 50 })).status).toBe(200);
    const acc = (await call(r, '/api/account', { cookie: alice })).json;
    const position = acc.positions.find((p: any) => p.ticker === 'ZRLX');
    expect(position.shares).toBe(60);

    // Her big buy pushes the thin micro-cap up (this test runs the pushes five times as strong as the game does, so a few thousand shares show).
    expect((await post(r, '/api/admin/cash', boss, { username: 'alice', amountCents: 500_000_000 })).status).toBe(200);
    const before = await priceOf();
    const big = await trade(r, alice, { qty: 5_000 });
    expect(big.status).toBe(201);
    advance(r, 30);
    expect(await priceOf()).toBeGreaterThan(before);
    expect(rowsOf(r, 'SELECT count(*) AS n FROM flow_events')[0]).toEqual({ n: 2 }); // her two trades that moved it (the 10-share one too)
  }, LONG);

  it('OSTK-6: every start sees the same companies; several can be made; one that was saved but not loaded blocks the next until a restart', async () => {
    let r = await boot();
    const boss = await signUp(r, 'boss');
    expect((await make(r, boss)).json.companyId).toBe(BASE);
    expect((await make(r, boss, { name: 'Second Co', ticker: 'SECO', sector: 'energy', tier: 'large', personality: 'income', priceCents: 40_000 })).json.companyId).toBe(BASE + 1);
    expect((await make(r, boss, { name: 'Third Co', ticker: 'THRC', sector: 'media', tier: 'mega', personality: 'declining', priceCents: 200 })).json.companyId).toBe(BASE + 2);
    advance(r, 3 * 3600);
    const companiesNow = JSON.stringify(r.app.services.world.companies);
    const pricesNow = Array.from(r.app.services.world.sim.P);

    r = await restart(r);
    expect(JSON.stringify(r.app.services.world.companies)).toBe(companiesNow);
    expect(r.app.services.world.companies.map((c: Company) => c.id)).toEqual(Array.from({ length: BASE + 3 }, (_, i) => i));
    expect(Array.from(r.app.services.world.sim.P).slice(0, BASE + 3).every((p) => p > 0)).toBe(true);
    advance(r, 60);
    void pricesNow;

    // A company that is saved but not loaded into the running market (the program stopped between the two steps) blocks the next one.
    const w = r.app.services.world;
    const cookie = await logIn(r, 'boss');
    const bossId = (rowsOf(r, "SELECT id FROM users WHERE username = 'boss'")[0] as { id: number }).id;
    const entry = makeEntry({ ...ZRLX, name: 'Saved Only', ticker: 'SAVD' }, { names: new Set(), tickers: new Set() });
    r.app.services.db.tx(() => w.recordOwnCompany(entry, w.ownListingTick(), bossId));
    expect(w.companies).toHaveLength(BASE + 3);
    const blocked = await make(r, cookie, { name: 'Next One', ticker: 'NEXT' });
    expect(blocked.status).toBe(409);
    expect(blocked.json.error.code).toBe('restart_needed');
    expect(blocked.json.error.message).toMatch(/restart/i);
    const stateWhile = (await call(r, '/api/admin/state', { cookie })).json;
    expect(stateWhile.stocks.find((x: any) => x.ticker === 'SAVD')).toMatchObject({ loaded: false, trading: false });

    r = await restart(r);
    const rows = await market(r);
    expect(rows).toHaveLength(BASE + 4);
    expect(rows[BASE + 3]).toMatchObject({ ticker: 'SAVD', id: BASE + 3 });
    advance(r, 120);
    expect((await market(r))[BASE + 3].trading).toBe(true);
    const cookie2 = await logIn(r, 'boss');
    expect((await make(r, cookie2, { name: 'Next One', ticker: 'NEXT' })).status).toBe(200);
  }, LONG);

  it('OSTK-7: the market page of a company that is about to list does not break, and open pages are told at once', async () => {
    const r = await boot();
    const boss = await signUp(r, 'boss');
    const stream = await openStream(r);
    expect(await stream.until('event: hello')).toContain('event: hello');
    await make(r, boss);
    expect(await stream.until('event: notice')).toContain('event: notice');
    stream.close();
    const detail = await call(r, '/api/market/ZRLX');
    expect(detail.status).toBe(200);
    expect(detail.json).toMatchObject({ ticker: 'ZRLX', trading: false });
    expect(detail.json.listsInTicks).toBeGreaterThan(0);
    expect((await call(r, '/api/market/ZRLX/candles?res=c10&limit=10')).status).toBe(200);
    expect((await call(r, '/api/market/ZRLX/book')).status).toBeLessThan(500);
    expect((await call(r, '/api/market/ZRLX/news')).status).toBe(200);
    expect((await call(r, '/api/health')).json.companies).toBe(BASE + 1);
  }, LONG);
});

// ---- the market must come out the same whichever way the company got in ------------------------------------------------------------

describe('adding to the running market equals loading at a restart', () => {
  it('OSTK-8: made while the server runs, or saved and loaded at a restart: identical prices, candles and news for hours', async () => {
    // One history, copied. World A makes the company live; world B only saves it and then restarts. Both then run on.
    const clock = new Clock();
    let a = await boot({ clock });
    await signUp(a, 'boss');
    advance(a, 2 * 3600);
    await stop(a);
    running.splice(running.indexOf(a), 1);
    const dirB = mkdtempSync(join(tmpdir(), 'tq-ostk-b-'));
    dirs.push(dirB);
    cpSync(a.dir, dirB, { recursive: true });

    a = await boot({ dir: a.dir, clock: new Clock(clock.ms) });
    let b = await boot({ dir: dirB, clock: new Clock(clock.ms) });
    const cookieA = await logIn(a, 'boss');
    const made = await make(a, cookieA);
    expect(made.status).toBe(200);
    expect(made.json.loaded).toBe(true);

    // B: the same company saved with the same listing tick, but not loaded into the running world.
    const wb = b.app.services.world;
    const bossId = (rowsOf(b, "SELECT id FROM users WHERE username = 'boss'")[0] as { id: number }).id;
    const entry = makeEntry(ZRLX, { names: new Set(), tickers: new Set() });
    b.app.services.db.tx(() => wb.recordOwnCompany(entry, made.json.listingTick, bossId));
    b = await restart(b);

    const sameNow = (): void => {
      const wa = a.app.services.world;
      const wb2 = b.app.services.world;
      expect(wa.sim.tick).toBe(wb2.sim.tick);
      expect(Array.from(wa.sim.P)).toEqual(Array.from(wb2.sim.P));
      expect(Array.from(wa.sim.F)).toEqual(Array.from(wb2.sim.F));
      expect(JSON.stringify(wa.companies)).toBe(JSON.stringify(wb2.companies));
      for (const id of [0, 5, BASE]) {
        for (const res of ['c10', 'h1'] as const) expect(wa.candles(id, res, 400)).toEqual(wb2.candles(id, res, 400));
      }
    };
    sameNow();
    for (const hours of [1, 2, 3]) {
      advance(a, hours * 3600);
      advance(b, hours * 3600);
      sameNow();
    }
    const newsRows = (r: Running) => rowsOf(r, 'SELECT key, company_id, partner_id, sector, scope, kind, publish_tick, start_tick, end_tick, realized, headline FROM news_items ORDER BY key');
    expect(newsRows(a)).toEqual(newsRows(b));
    const ownNews = rowsOf(a, 'SELECT key, scope FROM news_items WHERE company_id = ' + BASE) as { key: string; scope: string }[];
    expect(ownNews.length).toBeGreaterThanOrEqual(3);
    // sector- and market-wide stories that started after the listing reached the company in both worlds (so the test is not empty)
    const wide = rowsOf(a, "SELECT count(*) AS n FROM news_items WHERE scope IN ('sector', 'market') AND start_tick >= ?", made.json.listingTick) as { n: number }[];
    expect(wide[0]?.n).toBeGreaterThan(0);

    // And a crash-style restart of A in the middle of it all changes nothing.
    a = await restart(a);
    advance(a, 1800);
    advance(b, 1800);
    sameNow();
  }, LONG * 2);
});

// ---- the engine level, with stories we choose --------------------------------------------------------------------------------------

describe('the running world takes the new company in exactly', () => {
  function hooksOf(events: WorldEvent[]): NewsHooks {
    let companies: readonly Company[] = [];
    const known = (e: WorldEvent): boolean => (e.companyId === null || e.companyId < companies.length) && (e.partnerId === null || e.partnerId < companies.length);
    return {
      bind: (context) => {
        companies = context.companies;
      },
      ensureThrough: () => undefined,
      eventsActiveAt: (t) => events.filter(known).filter((e) => e.startTick <= t && t < e.startTick + e.durationTicks),
      eventsStartingIn: (from, through) => events.filter(known).filter((e) => e.startTick >= from && e.startTick <= through),
    };
  }

  it('OSTK-9: sector-wide, market-wide, company and partner stories reach the new company the same way, live or after a restart', () => {
    // The world is at tick 86,400 after one day of warm-up and loads its next six hours of stories a few ticks later. Six seconds on,
    // the stories below are already loaded, which is the case that matters: the new company has to be handed its share of them.
    const LT = 86_440;
    const base = { partnerId: null, permShare: 0.5, shape: 'front' as const };
    const events: WorldEvent[] = [
      { ...base, key: 'm:1:1', kind: 'macro', scope: 'market', companyId: null, sector: null, publishTick: LT + 50, startTick: LT + 100, durationTicks: 900, realized: 0.1 },
      { ...base, key: 's:1:1', kind: 'macro', scope: 'sector', companyId: null, sector: 'robotics', publishTick: LT + 150, startTick: LT + 200, durationTicks: 600, realized: -0.08 },
      { ...base, key: `c${BASE}:1:0`, kind: 'ordinary', scope: 'company', companyId: BASE, sector: null, publishTick: LT + 20, startTick: LT + 40, durationTicks: 300, realized: 0.12 },
      { ...base, key: `c${BASE}:1:1`, kind: 'ordinary', scope: 'company+partner', companyId: BASE, partnerId: 4, sector: null, publishTick: LT + 400, startTick: LT + 420, durationTicks: 300, realized: 0.05 },
      // before the listing: must not touch the new company
      { ...base, key: 'm:1:0', kind: 'macro', scope: 'market', companyId: null, sector: null, publishTick: LT - 100, startTick: LT - 20, durationTicks: 900, realized: -0.2 },
      { ...base, key: 'c3:1:0', kind: 'ordinary', scope: 'company', companyId: 3, sector: null, publishTick: LT + 60, startTick: LT + 80, durationTicks: 300, realized: 0.07 },
    ];
    const open = (list: WorldEvent[]) => {
      const rig = makeRig(new Clock());
      const o = rig.open({ companyCount: BASE, news: hooksOf(list) });
      rig.clock.advanceSeconds(6);
      o.world.advanceTo(o.world.currentTick(), Infinity);
      o.db.run("INSERT INTO users(id, username, display_name, pw_hash, role, created_ms) VALUES (1, 'boss', 'boss', 'x', 'owner', 1)");
      return { rig, ...o };
    };
    const entry = makeEntry(ZRLX, { names: new Set(), tickers: new Set() });
    const run = (rig: ReturnType<typeof makeRig>, w: WorldRuntime, seconds: number): void => {
      rig.clock.advanceSeconds(seconds);
      w.advanceTo(w.currentTick(), Infinity);
    };
    const a = open(events);
    const b = open(events);
    const without = open(events.filter((e) => e.scope === 'company' || e.scope === 'company+partner'));
    let b2: ReturnType<typeof b.rig.open> | null = null;
    try {
      for (const x of [a, b, without]) {
        expect(x.world.sim.tick).toBe(86_406);
        expect(x.world.ownListingTick()).toBe(LT);
      }
      expect(a.world.effects.pendingCount).toBeGreaterThan(0); // the stories are already in the loaded window

      // A: made live. B: saved, then the world is opened again from the same file (a restart). "without": live, but no sector/market-wide stories exist.
      for (const x of [a, without]) {
        x.db.tx(() => x.world.recordOwnCompany(entry, LT, 1));
        x.world.loadOwnCompany(BASE);
      }
      b.db.tx(() => b.world.recordOwnCompany(entry, LT, 1));
      b.db.close();
      b.rig.opened.splice(b.rig.opened.indexOf(b.db), 1);
      b2 = b.rig.open({ companyCount: BASE, news: hooksOf(events) });
      expect(b2.world.companies).toHaveLength(BASE + 1);
      expect(a.world.companies).toHaveLength(BASE + 1);

      const same = (): void => {
        const wb = (b2 as NonNullable<typeof b2>).world;
        expect(a.world.sim.tick).toBe(wb.sim.tick);
        expect(Array.from(a.world.sim.P)).toEqual(Array.from(wb.sim.P));
        expect(Array.from(a.world.sim.F)).toEqual(Array.from(wb.sim.F));
        expect(a.world.candles(BASE, 'c10', 300)).toEqual(wb.candles(BASE, 'c10', 300));
        expect(a.world.candles(4, 'c10', 300)).toEqual(wb.candles(4, 'c10', 300));
      };
      for (const seconds of [20, 100, 400, 900, 1800]) {
        run(a.rig, a.world, seconds);
        run(b.rig, (b2 as NonNullable<typeof b2>).world, seconds);
        run(without.rig, without.world, seconds);
        same();
      }
      // The test is not empty: without the sector- and market-wide stories the new company ends somewhere else.
      expect(without.world.sim.P[BASE]).not.toBe(a.world.sim.P[BASE]);
    } finally {
      a.rig.cleanup();
      b.rig.cleanup();
      without.rig.cleanup();
    }
  }, LONG);
});

// ---- the database upgrade ----------------------------------------------------------------------------------------------------------

describe('the database upgrade', () => {
  it('OSTK-10: version 8 adds the table for companies made by the owner, version 9 adds a strength column (no longer used by the game), and everything else is kept', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tq-ostk-mig-'));
    dirs.push(dir);
    const db = new Db(join(dir, 'old.sqlite'));
    try {
      for (const m of MIGRATIONS.filter((x) => x.version <= 7)) {
        db.exec(m.sql);
        db.exec(`PRAGMA user_version = ${m.version}`);
      }
      db.run("INSERT INTO users(id, username, display_name, pw_hash, role, created_ms) VALUES (1, 'boss', 'boss', 'x', 'owner', 1)");
      db.run("INSERT INTO companies(id, ticker, name, listing_tick, listed_ms) VALUES (0, 'AAAA', 'Aaaa', 0, 1)");
      db.run("INSERT INTO admin_log(request_id, created_ms, admin_user_id, action, target, detail_json) VALUES ('old-request-01', 5, 1, 'ban', 'x', '{}')");
      // A database from before the owner could make companies gets the new versions, one after the other ...
      const chain = new Db(join(dir, 'older.sqlite'));
      try {
        for (const m of MIGRATIONS.filter((x) => x.version <= 7)) {
          chain.exec(m.sql);
          chain.exec(`PRAGMA user_version = ${m.version}`);
        }
        expect(migrate(chain)).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
      } finally {
        chain.close();
      }
      // ... and one that already had version 8 keeps its company, saved the way version 8 saved it (no strength column yet).
      for (const m of MIGRATIONS.filter((x) => x.version === 8)) {
        db.exec(m.sql);
        db.exec(`PRAGMA user_version = ${m.version}`);
      }
      db.run("INSERT INTO companies(id, ticker, name, listing_tick, listed_ms) VALUES (1, 'ZRLX', 'Zorlex', 100, 2)");
      db.run("INSERT INTO custom_companies(company_id, ticker, name, sector, industry, tier, personality, price_cents, product1, product2, description, created_ms, created_by) VALUES (1, 'ZRLX', 'Zorlex', 'tech', 'x', 'small', 'growth', 1250, 'a', 'b', 'd', 2, 1)");
      // ... then versions 9 and 10: that company keeps everything and gets the (unused) strength column at 1; the pause table starts empty.
      expect(migrate(db)).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
      expect(db.all('SELECT * FROM auto_pauses')).toEqual([]);
      expect(db.all('SELECT request_id, action FROM admin_log')).toEqual([{ request_id: 'old-request-01', action: 'ban' }]);
      expect(db.all('SELECT company_id, price_cents, flow_mult FROM custom_companies')).toEqual([{ company_id: 1, price_cents: 1250, flow_mult: 1 }]);
      // the table refuses a price outside the engine's range, a strength that is not 1, 10 or 100, and a second company with the same ticker or name
      expect(() => db.run("INSERT INTO custom_companies(company_id, ticker, name, sector, industry, tier, personality, price_cents, product1, product2, description, created_ms, created_by) VALUES (2, 'QQQQ', 'Q', 'tech', 'x', 'small', 'growth', 50, 'a', 'b', 'd', 2, 1)")).toThrow();
      db.run("INSERT INTO companies(id, ticker, name, listing_tick, listed_ms) VALUES (2, 'QQQQ', 'Q', 100, 2)");
      expect(() => db.run("INSERT INTO custom_companies(company_id, ticker, name, sector, industry, tier, personality, price_cents, product1, product2, description, created_ms, created_by, flow_mult) VALUES (2, 'QQQQ', 'Q', 'tech', 'x', 'small', 'growth', 500, 'a', 'b', 'd', 2, 1, 5)")).toThrow();
      expect(() => db.run("INSERT INTO custom_companies(company_id, ticker, name, sector, industry, tier, personality, price_cents, product1, product2, description, created_ms, created_by) VALUES (2, 'ZRLX', 'Q', 'tech', 'x', 'small', 'growth', 500, 'a', 'b', 'd', 2, 1)")).toThrow();
      expect(migrate(db)).toEqual([]);
    } finally {
      db.close();
    }
  });
});

// ---- extremes -----------------------------------------------------------------------------------------------------------------------

describe('extreme choices behave', () => {
  it('OSTK-11: the cheapest declining micro-cap and the dearest mega-cap run for two days without a broken number', async () => {
    const r = await boot();
    const boss = await signUp(r, 'boss');
    expect((await make(r, boss, { name: 'Tiny Decline', ticker: 'TDEC', tier: 'micro', personality: 'declining', priceCents: 200, sector: 'emerging' })).status).toBe(200);
    expect((await make(r, boss, { name: 'Huge Rock', ticker: 'HROK', tier: 'mega', personality: 'income', priceCents: 100_000, sector: 'utilities' })).status).toBe(200);
    for (let day = 0; day < 4; day += 1) {
      advance(r, 12 * 3600);
      for (const t of ['TDEC', 'HROK']) {
        const c = (await market(r)).find((x) => x.ticker === t);
        if (!(Number.isFinite(c.price) && c.price >= 100 && c.price <= 5_000_000)) throw new Error(`${t} has a broken price ${c.price}`);
        expect(c.bid).toBeLessThan(c.ask);
        expect(c.bid).toBeGreaterThan(0);
        expect(Number.isFinite(c.marketCapCents) && c.marketCapCents > 0).toBe(true);
        const book = await call(r, `/api/market/${t}/book`);
        expect(book.status).toBe(200);
      }
    }
    const world = r.app.services.world;
    for (const id of [BASE, BASE + 1]) {
      for (const res of ['c10', 'h1', 'd1'] as const) {
        const candles = world.candles(id, res, 500);
        expect(candles.length).toBeGreaterThan(0);
        for (const c of candles) expect(c.low > 0 && c.low <= c.high && Number.isFinite(c.volume)).toBe(true);
      }
    }
    const health = (await call(r, '/api/health')).json;
    expect(health.ok).toBe(true);
    expect(health.companies).toBe(BASE + 2);
  }, LONG * 2);

  it('OSTK-12: a $10 mega-cap pumped far above $50,000 does not break the market list, its page, trading or any account', async () => {
    // What really happened: the owner made a $10 mega-cap (about 18 billion shares) and pumped it +900% several times in a row.
    // It reached the top price (then $50,000; the ceiling is $1,000,000 now), price × shares passed 2^53 cents, and "market cap overflow"
    // turned /api/market into a 500 for everybody.
    let r = await boot();
    const alice = await signUp(r, 'alice');
    const boss = await signUp(r, 'boss');
    expect((await make(r, boss, { name: 'Big Cheap Co', ticker: 'BIGC', sector: 'tech', tier: 'mega', personality: 'growth', priceCents: 1000 })).status).toBe(200);
    advance(r, 120);
    for (let i = 0; i < 5; i += 1) expect((await post(r, '/api/admin/shock', boss, { ticker: 'BIGC', percent: 900, style: 'pump', speed: 'fast' })).status).toBe(200);
    advance(r, 900);

    const check = async (): Promise<void> => {
      const list = await call(r, '/api/market');
      expect(list.status).toBe(200);
      const row = list.json.companies.find((c: any) => c.ticker === 'BIGC');
      expect(row.price).toBeGreaterThan(5_000_000); // well past the old $50,000 ceiling (at the top price of $1,000,000 now)
      expect(row.marketCapCents).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
      expect(list.json.companies.filter((c: any) => c.trading).length).toBe(BASE + 1);
      const one = await call(r, '/api/market/BIGC');
      expect(one.status).toBe(200);
      expect(one.json.marketCapCents).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
      for (const res of ['c10', 'h1', 'd1']) expect((await call(r, `/api/market/BIGC/candles?res=${res}&limit=50`)).status).toBe(200);
      expect((await call(r, '/api/market/BIGC/news')).status).toBe(200);
      for (const side of ['buy', 'sell']) for (const qty of [1, 5_000, 1_000_000]) expect((await call(r, `/api/market/BIGC/estimate?side=${side}&qty=${qty}&account=career`)).status).toBe(200);
    };
    await check();

    expect((await post(r, '/api/admin/cash', boss, { username: 'alice', amountCents: 500_000_000 })).status).toBe(200);
    expect((await trade(r, alice, { ticker: 'BIGC', qty: 20 })).status).toBe(201);
    expect((await post(r, '/api/admin/shares', boss, { username: 'alice', ticker: 'BIGC', qty: 1_000_000 })).status).toBe(200);
    const acc = await call(r, '/api/account?account=career', { cookie: alice });
    expect(acc.status).toBe(200);
    expect(acc.json.positions.find((p: any) => p.ticker === 'BIGC').shares).toBe(1_000_020);
    expect((await trade(r, alice, { ticker: 'BIGC', side: 'sell', qty: 500_000 })).status).toBe(201);
    expect((await call(r, '/api/account/trades?account=career', { cookie: alice })).status).toBe(200);
    expect((await call(r, '/api/admin/state', { cookie: boss })).status).toBe(200);
    expect((await call(r, '/api/news')).status).toBe(200);
    expect((await call(r, '/api/health')).json.ok).toBe(true);

    // The same after a restart (the stored price moves are replayed).
    r = await restart(r);
    advance(r, 60);
    await check();
  }, LONG * 2);

  it('OSTK-13: pumped all the way to the ceiling ($1,000,000 a share): every page answers, huge orders and gifts are refused politely, small ones work', async () => {
    let r = await boot();
    const alice = await signUp(r, 'alice');
    const boss = await signUp(r, 'boss');
    expect(MAX_PRICE).toBe(100_000_000); // $1,000,000.00: just above the most expensive real share
    expect((await make(r, boss, { name: 'Sky High Co', ticker: 'SKYH', sector: 'tech', tier: 'mega', personality: 'growth', priceCents: 100_000 })).status).toBe(200);
    advance(r, 120);
    for (let i = 0; i < 8; i += 1) expect((await post(r, '/api/admin/shock', boss, { ticker: 'SKYH', percent: 900, style: 'pump', speed: 'fast' })).status).toBe(200);
    advance(r, 1200);

    const check = async (): Promise<void> => {
      const list = await call(r, '/api/market');
      expect(list.status).toBe(200);
      const row = list.json.companies.find((c: any) => c.ticker === 'SKYH');
      expect(row.price).toBeGreaterThan(MAX_PRICE * 0.9); // at the ceiling (the short-term wobble keeps it a hair under)
      expect(row.price).toBeLessThanOrEqual(MAX_PRICE);
      const one = await call(r, '/api/market/SKYH');
      expect(one.status).toBe(200);
      expect(one.json.price).toBeGreaterThan(MAX_PRICE * 0.9);
      for (const res of ['c10', 'h1', 'd1']) expect((await call(r, `/api/market/SKYH/candles?res=${res}&limit=50`)).status).toBe(200);
      expect((await call(r, '/api/market/SKYH/news')).status).toBe(200);
      // Small estimates work; a huge one is refused with a clear message, never a crash.
      for (const side of ['buy', 'sell']) {
        expect((await call(r, `/api/market/SKYH/estimate?side=${side}&qty=1&account=career`)).status).toBe(200);
        expect((await call(r, `/api/market/SKYH/estimate?side=${side}&qty=50&account=career`)).status).toBe(200);
        const huge = await call(r, `/api/market/SKYH/estimate?side=${side}&qty=100000000&account=career`);
        expect(huge.status).toBe(400);
        expect(huge.json.error.code).toBe('too_large');
        expect(huge.json.error.message).toMatch(/most you can order/i);
      }
    };
    await check();

    // Orders: far too big → polite 400; a normal one works once the player has the money (two $1,000,000,000 gifts).
    expect((await trade(r, alice, { ticker: 'SKYH', qty: 100_000_000 })).status).toBe(400);
    expect((await post(r, '/api/admin/cash', boss, { username: 'alice', amountCents: 100_000_000_000 })).status).toBe(200);
    expect((await post(r, '/api/admin/cash', boss, { username: 'alice', amountCents: 100_000_000_000 })).status).toBe(200);
    expect((await trade(r, alice, { ticker: 'SKYH', qty: 1 })).status).toBe(201);
    // Gifts of shares: a million at a time is fine, but a position worth more than the game can count is refused.
    let gifted = 0;
    let refused: { status: number; json: any } | null = null;
    for (let i = 0; i < 20 && refused === null; i += 1) {
      const g = await post(r, '/api/admin/shares', boss, { username: 'alice', ticker: 'SKYH', qty: 1_000_000 });
      if (g.status === 200) gifted += 1_000_000;
      else refused = g;
    }
    expect(refused).not.toBeNull();
    expect(refused?.status).toBe(400);
    expect(refused?.json.error.code).toBe('too_large');
    expect(gifted).toBeGreaterThanOrEqual(5_000_000);
    const acc = await call(r, '/api/account?account=career', { cookie: alice });
    expect(acc.status).toBe(200);
    expect(acc.json.positions.find((p: any) => p.ticker === 'SKYH').shares).toBe(1 + gifted);
    expect(Number.isSafeInteger(acc.json.netWorthCents)).toBe(true);
    expect((await trade(r, alice, { ticker: 'SKYH', side: 'sell', qty: 100 })).status).toBe(201);
    expect((await call(r, '/api/account/trades?account=career', { cookie: alice })).status).toBe(200);
    expect((await call(r, '/api/admin/state', { cookie: boss })).status).toBe(200);
    expect((await call(r, '/api/health')).json.ok).toBe(true);

    // The price can come down from the ceiling (a rug pull), and everything still answers after a restart.
    expect((await post(r, '/api/admin/shock', boss, { ticker: 'SKYH', percent: -90, style: 'rug', speed: 'instant' })).status).toBe(200);
    advance(r, 60);
    const down = (await market(r)).find((c) => c.ticker === 'SKYH').price as number;
    expect(down).toBeLessThan(MAX_PRICE / 2);
    r = await restart(r);
    advance(r, 30);
    expect((await call(r, '/api/market')).status).toBe(200);
    expect((await call(r, '/api/market/SKYH')).status).toBe(200);
  }, LONG * 2);

  it('OSTK-14: trades push every stock with the one fixed strength: no choice on the form or in the list, no route to change it, and an old setting is ignored', async () => {
    const GAIN = 1; // what the game really uses
    const r = await boot({ flow: GAIN });
    const alice = await signUp(r, 'alice');
    const boss = await signUp(r, 'boss');
    const stateOf = async () => (await call(r, '/api/admin/state', { cookie: boss })).json;

    // Nothing to choose: not in the form, not in the list of the owner's stocks, not in the admin state.
    const state0 = await stateOf();
    expect(state0.stockForm).not.toHaveProperty('sensitivities');
    expect(state0.stockForm).not.toHaveProperty('defaultSensitivity');
    expect(state0).not.toHaveProperty('flow');
    // A request that still carries the old field makes the stock like any other (the field is not looked at).
    const made = await make(r, boss, { tier: 'micro', sensitivity: 'extreme' });
    expect(made.status).toBe(200);
    expect(made.json).not.toHaveProperty('sensitivity');
    expect((await stateOf()).stocks[0]).not.toHaveProperty('sensitivity');
    const other = await make(r, boss, { name: 'Quiet Co', ticker: 'QUIE', tier: 'micro' });
    expect(other.status).toBe(200);
    advance(r, 120);

    // The routes that used to change the strength are gone, for the owner too.
    for (const path of ['/api/admin/stock-sensitivity', '/api/admin/flow']) {
      const gone = await call(r, path, { method: 'POST', cookie: boss, body: { requestId: rid(), ticker: 'ZRLX', sensitivity: 'extreme', level: 'wild' } });
      expect(gone.status).toBe(404);
    }

    // The push of a sale is the formula of server/flow.ts at the fixed strength, the same rule for both stocks.
    for (const ticker of ['ZRLX', 'QUIE']) {
      const c = r.app.services.world.companies.find((x) => x.ticker === ticker) as Company;
      const res = await call(r, `/api/market/${ticker}/estimate?side=sell&qty=1&account=career`, { cookie: alice });
      expect(res.status).toBe(200);
      const expected = Math.abs(FLOW_MOVE_SHARE * pushOf(c, -1, GAIN)) * 10_000;
      expect(expected).toBeGreaterThan(0);
      expect(Math.abs(res.json.moveBps as number)).toBeCloseTo(expected, 0);
    }

    // An old database may still hold the retired settings (a dial value in "meta", a strength on the stock): they change nothing.
    r.app.services.db.run("INSERT INTO meta(key, value) VALUES ('flow_level', 'off') ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    r.app.services.db.run("UPDATE custom_companies SET flow_mult = 100 WHERE ticker = 'ZRLX'");
    const c = r.app.services.world.companies.find((x) => x.ticker === 'ZRLX') as Company;
    const res = await call(r, '/api/market/ZRLX/estimate?side=sell&qty=1&account=career', { cookie: alice });
    expect(Math.abs(res.json.moveBps as number)).toBeCloseTo(Math.abs(FLOW_MOVE_SHARE * pushOf(c, -1, GAIN)) * 10_000, 0);

    // The trade that really happens stores that same push.
    expect((await post(r, '/api/admin/shares', boss, { username: 'alice', ticker: 'ZRLX', qty: 1 })).status).toBe(200);
    expect((await trade(r, alice, { side: 'sell', qty: 1 })).status).toBe(201);
    const stored = rowsOf(r, 'SELECT total FROM flow_events ORDER BY rowid DESC LIMIT 1')[0] as { total: number };
    expect(Math.abs(Math.abs(stored.total) * 10_000 - Math.abs(res.json.moveBps as number))).toBeLessThan(0.2);

    // A player cannot reach those routes either (and they do not exist for anybody).
    expect((await call(r, '/api/admin/flow', { method: 'POST', cookie: alice, body: { requestId: rid(), level: 'wild' } })).status).toBe(404);
  }, LONG * 2);
});
