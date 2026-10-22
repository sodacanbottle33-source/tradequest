// The news over HTTP: the feed and company pages, what is hidden, the owner-only view, health, the live push, and the
// "only one server per database" lock.
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../server/app';
import { loadConfig } from '../server/config';
import { Logger } from '../server/log';
import { Clock } from './helpers/server';

const LONG = 240_000;

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

function newDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tq-news-'));
  dirs.push(dir);
  return dir;
}

async function boot(options: { dir?: string; clock?: Clock; env?: Record<string, string>; start?: boolean } = {}): Promise<Running> {
  const dir = options.dir ?? newDir();
  const clock = options.clock ?? new Clock();
  const config = loadConfig({ TQ_DATA_DIR: dir, TQ_COMPANIES: '12', TQ_WARMUP_DAYS: '1', TQ_PORT: '8787', TQ_OWNER: 'boss', ...(options.env ?? {}) });
  const app = createApp({ config, log: new Logger({ sink: null, now: clock.now }), worldSeed: 777, now: clock.now, flowGain: 0 });
  const server = createServer(app.handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  if (options.start !== false) app.start();
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
  const res = await fetch(r.base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: name, password: 'a-good-password' }) });
  expect(res.status).toBe(201);
  return (res.headers.get('set-cookie') ?? '').split(';')[0] as string;
}

describe('news feed over HTTP', () => {
  it('lists published news newest first, page by page, and never shows what has not happened yet', async () => {
    const r = await boot();
    const first = await call(r, '/api/news?limit=25');
    expect(first.status).toBe(200);
    expect(first.json.items).toHaveLength(25);
    const tick: number = first.json.tick;
    for (const i of first.json.items) {
      expect(i.publishTick).toBeLessThanOrEqual(tick);
      expect(typeof i.headline).toBe('string');
      expect(i.headline.length).toBeGreaterThan(10);
      expect(i.body.length).toBeGreaterThan(20);
      expect(typeof i.categoryLabel).toBe('string');
      expect(['positive', 'negative', 'uncertain']).toContain(i.direction);
      expect(typeof i.breaking).toBe('boolean');
    }
    const ids: number[] = [];
    let url = '/api/news?limit=50';
    let last = Infinity;
    for (let page = 0; page < 200; page += 1) {
      const p = await call(r, url);
      for (const i of p.json.items) {
        expect(i.publishTick).toBeLessThanOrEqual(last);
        last = i.publishTick;
        ids.push(i.id);
      }
      if (!p.json.next) break;
      url = `/api/news?limit=50&before=${encodeURIComponent(p.json.next)}`;
    }
    const db = r.app.services.db;
    const published = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM news_items WHERE publish_tick <= ?', tick)?.n;
    expect(ids.length).toBe(published);
    expect(new Set(ids).size).toBe(ids.length);
    const total = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM news_items')?.n ?? 0;
    expect(total).toBeGreaterThan(ids.length); // tomorrow's news exists, but players cannot see it
  }, LONG);

  it('hides the hidden outcome and source credibility from every public answer', async () => {
    const r = await boot();
    const feed = await call(r, '/api/news?limit=100');
    const company = await call(r, '/api/market/QLRX/news?limit=100');
    const one = await call(r, `/api/news/${feed.json.items[0].id}`);
    for (const text of [feed.text, company.text, one.text]) {
      for (const secret of ['realized', 'credibility', 'permShare', 'perm_share', 'price_at', 'durationTicks']) expect(text).not.toContain(secret);
    }
  }, LONG);

  it('filters by category and breaking label; rejects bad requests with a clear message', async () => {
    const r = await boot();
    const prod = await call(r, '/api/news?category=product&limit=100');
    expect(prod.json.items.length).toBeGreaterThan(0);
    for (const i of prod.json.items) expect(i.category).toBe('product');
    const brk = await call(r, '/api/news?breaking=1&limit=100');
    expect(brk.json.items.length).toBeGreaterThan(0);
    for (const i of brk.json.items) expect(i.breaking).toBe(true);
    expect((await call(r, '/api/news?category=lies')).status).toBe(400);
    expect((await call(r, '/api/news?before=banana')).status).toBe(400);
    expect((await call(r, '/api/news?breaking=maybe')).status).toBe(400);
    expect((await call(r, '/api/news?limit=0')).status).toBe(400);
  }, LONG);

  it('a company page has its own news and the sector and market news that affects it', async () => {
    const r = await boot();
    const d = await call(r, '/api/market/QLRX');
    const sector = d.json.sector as string;
    const feed = await call(r, '/api/market/QLRX/news?limit=100');
    expect(feed.status).toBe(200);
    expect(feed.json.ticker).toBe('QLRX');
    let own = 0;
    for (const i of feed.json.items) {
      if (i.ticker === 'QLRX') own += 1;
      else if (i.partnerTicker === 'QLRX') continue;
      else if (i.scope === 'sector') expect(i.sector).toBe(sector);
      else expect(i.scope).toBe('market');
    }
    expect(own).toBeGreaterThanOrEqual(3);
    expect((await call(r, '/api/market/NOPE/news')).status).toBe(404);
  }, LONG);

  it('one item by id; unknown, unpublished and malformed ids are refused', async () => {
    const r = await boot();
    const feed = await call(r, '/api/news?limit=3');
    const id = feed.json.items[0].id;
    const one = await call(r, `/api/news/${id}`);
    expect(one.status).toBe(200);
    expect(one.json.headline).toBe(feed.json.items[0].headline);
    const future = r.app.services.db.get<{ id: number }>('SELECT id FROM news_items WHERE publish_tick > ? ORDER BY publish_tick LIMIT 1', feed.json.tick);
    expect(future).not.toBeNull();
    expect((await call(r, `/api/news/${future?.id}`)).status).toBe(404);
    expect((await call(r, '/api/news/99999999')).status).toBe(404);
    expect((await call(r, '/api/news/abc')).status).toBe(400);
  }, LONG);

  it('health shows the news summary and the scheduler, and the market health includes it', async () => {
    const r = await boot();
    const h = await call(r, '/api/news/health');
    expect(h.status).toBe(200);
    expect(h.json.ok).toBe(true);
    expect(h.json.behind).toEqual([]);
    expect(h.json.belowMinimum).toEqual([]);
    expect(h.json.items).toBeGreaterThan(72); // 12 companies × 3 core items × 2 days, plus extras, sector, economy and viral news
    expect(h.json.scheduler.running).toBe(true);
    expect(h.json.scheduler.lastError).toBeNull();
    expect(h.json.scheduler.lastSuccessMs).toBe(r.clock.ms);
    const all = await call(r, '/api/health');
    expect(all.json.ok).toBe(true);
    expect(all.json.news.ok).toBe(true);
  }, LONG);
});

describe('owner-only price-effects view', () => {
  it('shows the hidden numbers to the owner only', async () => {
    const r = await boot();
    expect((await call(r, '/api/debug/effects/QLRX')).status).toBe(401);
    const player = await signUp(r, 'alice');
    expect((await call(r, '/api/debug/effects/QLRX', { cookie: player })).status).toBe(403);
    const owner = await signUp(r, 'boss');
    const res = await call(r, '/api/debug/effects/QLRX?hours=48', { cookie: owner });
    expect(res.status).toBe(200);
    expect(res.json.items.length).toBeGreaterThan(0);
    for (const i of res.json.items) {
      expect(typeof i.realized).toBe('number');
      expect(i.endTick).toBeGreaterThan(i.startTick);
    }
    expect((await call(r, '/api/debug/effects/NOPE', { cookie: owner })).status).toBe(404);
  }, LONG);
});

describe('live push', () => {
  it('a news event is pushed to open browsers when a story is published', async () => {
    const r = await boot();
    const db = r.app.services.db;
    const res = await fetch(`${r.base}/api/stream`);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const events: { name: string; data: any }[] = [];
    void (async () => {
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
        if (done || !value) return;
        buf += decoder.decode(value);
        let at: number;
        while ((at = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, at);
          buf = buf.slice(at + 2);
          const name = /^event: (.*)$/m.exec(frame)?.[1];
          const data = /^data: (.*)$/m.exec(frame)?.[1];
          if (name && data) events.push({ name, data: JSON.parse(data) });
        }
      }
    })();
    const waitFor = async (test: () => boolean, ms = 8000): Promise<void> => {
      const end = Date.now() + ms;
      while (!test() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 25));
    };
    // One tick so the server knows where "now" is, then jump to just after the next story's publication.
    r.clock.advanceSeconds(1);
    await waitFor(() => events.some((e) => e.name === 'tick'));
    const tick = r.app.services.world.sim.tick;
    const next = db.get<{ id: number; publish_tick: number; headline: string }>('SELECT id, publish_tick, headline FROM news_items WHERE publish_tick > ? ORDER BY publish_tick, id LIMIT 1', tick);
    expect(next).not.toBeNull();
    r.clock.advanceSeconds((next?.publish_tick as number) - tick + 1);
    await waitFor(() => events.some((e) => e.name === 'news' && e.data.id === next?.id), 20_000);
    await reader.cancel();
    const got = events.find((e) => e.name === 'news' && e.data.id === next?.id);
    expect(got).toBeDefined();
    expect(got?.data.headline).toBe(next?.headline);
    expect(JSON.stringify(got?.data)).not.toContain('realized');
  }, LONG);
});

describe('one server per database', () => {
  it('a second server on the same data folder is refused while the first runs, and allowed after it closes', async () => {
    const dir = newDir();
    const clock = new Clock();
    const first = await boot({ dir, clock });
    await expect(boot({ dir, clock })).rejects.toThrow(/Another TradeQuest server/);
    await new Promise<void>((done) => {
      first.server.closeAllConnections?.();
      first.server.close(() => done());
    });
    first.app.close();
    running.splice(running.indexOf(first), 1);
    clock.advanceSeconds(5);
    const again = await boot({ dir, clock });
    expect((await call(again, '/api/health')).status).toBe(200);
  }, LONG);

  it('after a crash the lock runs out by itself', async () => {
    const dir = newDir();
    const clock = new Clock();
    const first = await boot({ dir, clock, start: false });
    // The first program "crashes": it never closes and never renews its lock.
    clock.advanceSeconds(10);
    await expect(boot({ dir, clock })).rejects.toThrow(/Another TradeQuest server/);
    clock.advanceSeconds(40); // longer than the 30-second lock
    const second = await boot({ dir, clock });
    expect((await call(second, '/api/health')).status).toBe(200);
    expect(first.app.services.world.sim.tick).toBeLessThanOrEqual(second.app.services.world.sim.tick);
  }, LONG);
});
