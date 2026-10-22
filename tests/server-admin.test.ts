// The owner's tools over HTTP: who may use them, price moves (rug / crash / pump) that survive a restart unchanged, trading halts,
// cash and coin gifts, and the admin log. The most important property is the one about restarts: a price move made while the
// server runs must produce exactly the same prices as a server that was stopped and started in the middle of it.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { solveTotal } from '../server/admin';
import { createApp, type App } from '../server/app';
import { OWNER_FILE, loadConfig } from '../server/config';
import { Logger } from '../server/log';
import { effectiveDuration, weightAt, type Shape } from '../src/world';
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

function newDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tq-admin-'));
  dirs.push(dir);
  return dir;
}

async function boot(options: { dir?: string; clock?: Clock; env?: Record<string, string>; warmup?: string; flow?: number } = {}): Promise<Running> {
  const dir = options.dir ?? newDir();
  const clock = options.clock ?? new Clock();
  const config = loadConfig({ TQ_DATA_DIR: dir, TQ_COMPANIES: '12', TQ_WARMUP_DAYS: options.warmup ?? '1', TQ_PORT: '8787', TQ_OWNER: 'boss', ...(options.env ?? {}) });
  const app = createApp({ config, log: new Logger({ sink: null, now: clock.now }), worldSeed: 777, now: clock.now, flowGain: options.flow ?? 0 });
  const server = createServer(app.handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const r = { app, server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, dir, clock };
  running.push(r);
  return r;
}

/** Runs the market up to the test clock (the real timer is not started in these tests). */
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
  return { status: res.status, json };
}

async function signUp(r: Running, name: string): Promise<string> {
  const res = await fetch(r.base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: name, password: 'a-good-password' }) });
  expect(res.status).toBe(201);
  return (res.headers.get('set-cookie') ?? '').split(';')[0] as string;
}

let counter = 0;
const rid = (): string => `req-${(counter += 1).toString().padStart(8, '0')}`;
const post = (r: Running, path: string, cookie: string, body: Record<string, unknown>) => call(r, path, { method: 'POST', cookie, body: { requestId: rid(), ...body } });
const priceOf = (r: Running, ticker: string): number => {
  const w = r.app.services.world;
  return w.sim.price((w.companyByTicker(ticker) as { id: number }).id);
};

describe('who may use the owner tools', () => {
  it('ADM-1: signed-out visitors get 401, ordinary players 403, only the owner gets in', async () => {
    const r = await boot();
    const player = await signUp(r, 'alice');
    const owner = await signUp(r, 'boss');
    const calls: [string, string, Record<string, unknown> | undefined][] = [
      ['GET', '/api/admin/state', undefined],
      ['POST', '/api/admin/shock', { ticker: 'QLRX', percent: -50, style: 'rug', speed: 'instant' }],
      ['POST', '/api/admin/halt', { ticker: 'QLRX', halted: true }],
      ['POST', '/api/admin/cash', { username: 'alice', amountCents: 5000 }],
      ['POST', '/api/admin/coins', { username: 'alice', amountCents: 5000 }],
    ];
    const wrong: string[] = [];
    for (const [method, path, body] of calls) {
      const out = await call(r, path, { method, body: body && { requestId: rid(), ...body } });
      if (out.status !== 401) wrong.push(`${path} signed out: ${out.status}`);
      const asPlayer = await call(r, path, { method, cookie: player, body: body && { requestId: rid(), ...body } });
      if (asPlayer.status !== 403 || asPlayer.json.error.code !== 'owner_only') wrong.push(`${path} as player: ${asPlayer.status}`);
    }
    expect(wrong).toEqual([]);
    const state = await call(r, '/api/admin/state', { cookie: owner });
    expect(state.status).toBe(200);
    expect(state.json.players.map((p: { username: string }) => p.username)).toEqual(['alice', 'boss']);
    // Nothing the players tried changed anything.
    expect(r.app.services.halts.list()).toEqual([]);
    expect(r.app.services.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM admin_log')?.n).toBe(0);
  }, LONG);

  it('ADM-2: the browser cannot make anybody the owner; /api/me tells the truth', async () => {
    const r = await boot();
    const player = await signUp(r, 'alice');
    expect((await call(r, '/api/me', { cookie: player })).json.user.role).toBe('player');
    const owner = await signUp(r, 'boss');
    expect((await call(r, '/api/me', { cookie: owner })).json.user.role).toBe('owner');
    // Extra fields in a request are ignored.
    const res = await fetch(r.base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'sneaky', password: 'a-good-password', role: 'owner' }) });
    expect(((await res.json()) as { user: { role: string } }).user.role).toBe('player');
  }, LONG);

  it('ADM-3: the server setting decides: exactly one owner, applied at every start', async () => {
    const dir = newDir();
    const first = await boot({ dir, env: { TQ_OWNER: '' } });
    await signUp(first, 'alice');
    await signUp(first, 'boss');
    expect(first.app.services.db.get<{ role: string }>("SELECT role FROM users WHERE username = 'boss'")?.role).toBe('player');
    await stop(first);

    // Choosing the owner later promotes the existing account.
    const second = await boot({ dir, env: { TQ_OWNER: 'BOSS' } });
    expect(second.app.services.db.all<{ username: string }>("SELECT username FROM users WHERE role = 'owner'")).toEqual([{ username: 'boss' }]);
    await stop(second);

    // Choosing somebody else takes the role away from the old owner.
    const third = await boot({ dir, env: { TQ_OWNER: 'alice' } });
    expect(third.app.services.db.all<{ username: string }>("SELECT username FROM users WHERE role = 'owner'")).toEqual([{ username: 'alice' }]);
    await stop(third);

    // No owner configured: nobody is the owner.
    const fourth = await boot({ dir, env: { TQ_OWNER: '' } });
    expect(fourth.app.services.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE role = 'owner'")?.n).toBe(0);
  }, LONG);

  it('ADM-4: the owner can also be named in data/owner.txt; the environment setting wins; bad content is an error', () => {
    const dir = newDir();
    mkdirSync(dir, { recursive: true });
    expect(loadConfig({ TQ_DATA_DIR: dir }).ownerUsername).toBe('');
    writeFileSync(join(dir, OWNER_FILE), '﻿HT_owner\r\nignored second line\r\n');
    expect(loadConfig({ TQ_DATA_DIR: dir }).ownerUsername).toBe('HT_owner');
    expect(loadConfig({ TQ_DATA_DIR: dir, TQ_OWNER: 'other' }).ownerUsername).toBe('other');
    writeFileSync(join(dir, OWNER_FILE), '\n');
    expect(loadConfig({ TQ_DATA_DIR: dir }).ownerUsername).toBe('');
    writeFileSync(join(dir, OWNER_FILE), 'not a valid name!\n');
    expect(() => loadConfig({ TQ_DATA_DIR: dir })).toThrow(/owner\.txt/);
  });
});

describe('price moves', () => {
  it('ADM-5: solveTotal gives the move that makes the price end up where asked, for every speed', () => {
    const off: string[] = [];
    for (const [shape, ticks] of [['burst', 6], ['front', 300], ['front', 3600]] as [Shape, number][]) {
      for (const multiplier of [0.01, 0.1, 0.5, 0.9, 1.1, 2, 10]) {
        const total = solveTotal(multiplier, shape, ticks);
        let product = 1;
        for (let k = 0; k < effectiveDuration(shape, ticks); k += 1) product *= 1 + total * weightAt(shape, ticks, k);
        if (Math.abs(product / multiplier - 1) > 0.000001) off.push(`${shape} ${ticks} ×${multiplier} gave ×${product}`);
      }
    }
    expect(off).toEqual([]);
  });

  it('ADM-6: a rug pull crashes the price, shows up as breaking news, and the hidden numbers stay hidden', async () => {
    const r = await boot();
    const owner = await signUp(r, 'boss');
    catchUp(r);
    const before = priceOf(r, 'QLRX');
    const res = await post(r, '/api/admin/shock', owner, { ticker: 'QLRX', percent: -90, style: 'rug', speed: 'instant' });
    expect(res.status).toBe(200);
    expect(res.json.duplicate).toBe(false);
    expect(res.json.startsAtTick).toBeGreaterThan(r.app.services.world.sim.tick);
    advance(r, 60);
    const after = priceOf(r, 'QLRX');
    const drop = 1 - after / before;
    expect(drop).toBeGreaterThan(0.8); // the price went from `before` to `after`
    expect(drop).toBeLessThan(0.98);
    // Other companies were not rugged.
    for (const t of ['NVRA', 'SKVR']) {
      const c = r.app.services.world.companyByTicker(t);
      if (c) expect(priceOf(r, t)).toBeGreaterThan(0);
    }

    const feed = await call(r, '/api/market/QLRX/news?limit=5');
    const item = feed.json.items.find((i: { kind: string }) => i.kind === 'admin');
    expect(item).toBeDefined();
    expect(item.breaking).toBe(true);
    expect(item.direction).toBe('negative');
    expect(item.strength).toBe('extreme');
    expect(item.ticker).toBe('QLRX');
    expect(item.headline).toMatch(/collapses/);
    expect(item.realized).toBeUndefined(); // the secret number is not part of the public story
    expect(JSON.stringify(item)).not.toMatch(/realized|permShare/);

    const debug = await call(r, '/api/debug/effects/QLRX?hours=1', { cookie: owner });
    const mine = debug.json.items.find((i: { kind: string }) => i.kind === 'admin');
    expect(mine.source).toBe('admin');
    expect(mine.realized).toBeLessThan(-1);

    // Once the effect is over, the story shows what the price did.
    advance(r, 120);
    const done = await call(r, `/api/news/${item.id}`);
    expect(done.json.outcome).not.toBeNull();
    expect(done.json.outcome.changeBps).toBeLessThan(-8000);
    // The health check is still happy with the extra story in the table.
    const health = await call(r, '/api/health');
    expect(health.json.news.ok).toBe(true);
  }, LONG);

  it('ADM-7: a pump roughly doubles the price over the chosen time, and a custom headline is used as typed', async () => {
    const r = await boot();
    const owner = await signUp(r, 'boss');
    catchUp(r);
    const before = priceOf(r, 'QLRX');
    const res = await post(r, '/api/admin/shock', owner, { ticker: 'QLRX', percent: 100, style: 'custom', speed: 'fast', headline: '  Moon <b>mission</b>  ', body: 'Line one\nline two' });
    expect(res.status).toBe(200);
    advance(r, 400);
    const ratio = priceOf(r, 'QLRX') / before;
    expect(ratio).toBeGreaterThan(1.6);
    expect(ratio).toBeLessThan(2.6);
    const item = (await call(r, '/api/market/QLRX/news?limit=5')).json.items.find((i: { kind: string }) => i.kind === 'admin');
    expect(item.headline).toBe('Moon <b>mission</b>'); // text only: the screen shows it as text, never as markup
    expect(item.body).toBe('Line one line two');
    expect(item.direction).toBe('positive');
  }, LONG);

  it('ADM-8: bad requests are refused with a clear message and change nothing', async () => {
    const r = await boot();
    const owner = await signUp(r, 'boss');
    catchUp(r);
    const bad: [string, Record<string, unknown>][] = [
      ['percent too low', { ticker: 'QLRX', percent: -100, style: 'rug', speed: 'instant' }],
      ['percent too high', { ticker: 'QLRX', percent: 901, style: 'pump', speed: 'instant' }],
      ['percent tiny', { ticker: 'QLRX', percent: 0.5, style: 'pump', speed: 'instant' }],
      ['percent text', { ticker: 'QLRX', percent: '50', style: 'pump', speed: 'instant' }],
      ['percent NaN-like', { ticker: 'QLRX', percent: null, style: 'pump', speed: 'instant' }],
      ['rug upward', { ticker: 'QLRX', percent: 50, style: 'rug', speed: 'instant' }],
      ['crash upward', { ticker: 'QLRX', percent: 50, style: 'crash', speed: 'instant' }],
      ['pump downward', { ticker: 'QLRX', percent: -50, style: 'pump', speed: 'instant' }],
      ['unknown style', { ticker: 'QLRX', percent: -50, style: 'boom', speed: 'instant' }],
      ['unknown speed', { ticker: 'QLRX', percent: -50, style: 'rug', speed: 'warp' }],
      ['custom without headline', { ticker: 'QLRX', percent: -50, style: 'custom', speed: 'instant' }],
      ['headline too long', { ticker: 'QLRX', percent: -50, style: 'custom', speed: 'instant', headline: 'x'.repeat(121) }],
      ['headline not text', { ticker: 'QLRX', percent: -50, style: 'custom', speed: 'instant', headline: 5 }],
    ];
    const accepted: string[] = [];
    for (const [what, body] of bad) {
      const res = await post(r, '/api/admin/shock', owner, body);
      if (res.status !== 400 || !(res.json.error.message.length > 10)) accepted.push(`${what}: ${res.status}`);
    }
    expect(accepted).toEqual([]);
    expect((await post(r, '/api/admin/shock', owner, { ticker: 'NOPE', percent: -50, style: 'rug', speed: 'instant' })).status).toBe(404);
    expect((await call(r, '/api/admin/shock', { method: 'POST', cookie: owner, body: { requestId: 'x', ticker: 'QLRX', percent: -50, style: 'rug', speed: 'instant' } })).status).toBe(400);
    expect(r.app.services.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM news_items WHERE source = 'admin'")?.n).toBe(0);
    expect(r.app.services.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM admin_log')?.n).toBe(0);
  }, LONG);

  it('ADM-9: the same request sent twice moves the price once; reusing its id for something else is refused', async () => {
    const r = await boot();
    const owner = await signUp(r, 'boss');
    catchUp(r);
    const body = { requestId: 'once-only-0001', ticker: 'QLRX', percent: -30, style: 'crash', speed: 'instant' };
    const a = await call(r, '/api/admin/shock', { method: 'POST', cookie: owner, body });
    const b = await call(r, '/api/admin/shock', { method: 'POST', cookie: owner, body });
    expect(a.json.duplicate).toBe(false);
    expect(b.status).toBe(200);
    expect(b.json.duplicate).toBe(true);
    expect(r.app.services.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM news_items WHERE source = 'admin'")?.n).toBe(1);
    const other = await call(r, '/api/admin/shock', { method: 'POST', cookie: owner, body: { ...body, ticker: 'NVRA' } });
    expect(other.status).toBe(409);
  }, LONG);

  it('ADM-10: a price move made while the server runs gives exactly the same prices as a server that restarted in the middle of it', async () => {
    // Two worlds from the same seed and the same clock. In A the server is stopped and started again while the move is running;
    // B never stops. Every price must be identical afterwards (this is the "replay gives the same market" promise).
    const clockA = new Clock();
    const clockB = new Clock();
    const a1 = await boot({ clock: clockA, warmup: '0' });
    const b = await boot({ clock: clockB, warmup: '0' });
    const ownerA = await signUp(a1, 'boss');
    const ownerB = await signUp(b, 'boss');
    let startPrice = 0;
    for (const [r, owner] of [[a1, ownerA], [b, ownerB]] as [Running, string][]) {
      advance(r, 100);
      startPrice = priceOf(r, 'QLRX');
      const res = await call(r, '/api/admin/shock', { method: 'POST', cookie: owner, body: { requestId: 'same-move-0001', ticker: 'QLRX', percent: -85, style: 'rug', speed: 'fast' } });
      expect(res.status).toBe(200);
      advance(r, 77); // part of the move has happened, and the last saved candle is earlier than "now"
    }
    expect(a1.app.services.world.sim.tick).toBe(b.app.services.world.sim.tick);
    const dir = a1.dir;
    await stop(a1);
    clockA.advanceSeconds(10); // the server was away for a moment
    const a2 = await boot({ dir, clock: clockA, warmup: '0' });
    catchUp(a2);
    for (const r of [a2, b]) advance(r, 0);
    advance(b, 10);
    for (const r of [a2, b]) advance(r, 500);
    const wa = a2.app.services.world;
    const wb = b.app.services.world;
    expect(wa.sim.tick).toBe(wb.sim.tick);
    const pa = Array.from({ length: wa.companies.length }, (_, i) => wa.sim.price(i));
    const pb = Array.from({ length: wb.companies.length }, (_, i) => wb.sim.price(i));
    expect(pa).toEqual(pb);
    const qa = wa.companyByTicker('QLRX') as { id: number };
    expect(wa.candles(qa.id, 'c10', 200)).toEqual(wb.candles(qa.id, 'c10', 200));
    expect(pa[qa.id]).toBeLessThan(startPrice * 0.5); // the move really happened in both worlds
  }, LONG);
});

describe('trading halts', () => {
  it('ADM-11: a halt refuses orders, shows in the market list, keeps the price moving, and can be lifted', async () => {
    const r = await boot();
    const owner = await signUp(r, 'boss');
    const player = await signUp(r, 'alice');
    catchUp(r);
    const order = (cookie: string, side: 'buy' | 'sell', qty = 1) => call(r, '/api/orders', { method: 'POST', cookie, body: { account: 'career', ticker: 'QLRX', side, qty, clientOrderId: rid() } });
    expect((await order(player, 'buy', 2)).status).toBe(201);

    const halt = await post(r, '/api/admin/halt', owner, { ticker: 'QLRX', halted: true, reason: 'Under review' });
    expect(halt.status).toBe(200);
    const blocked = await order(player, 'buy');
    expect(blocked.status).toBe(403);
    expect(blocked.json.error.code).toBe('halted');
    expect(blocked.json.error.message).toMatch(/halted: Under review/);
    expect((await order(player, 'sell')).json.error.code).toBe('halted'); // holders cannot sell either
    expect((await call(r, '/api/market/QLRX/estimate?side=buy&qty=1', { cookie: player })).json.error.code).toBe('halted');
    const row = (await call(r, '/api/market')).json.companies.find((c: { ticker: string }) => c.ticker === 'QLRX');
    expect(row.halted).toBe(true);
    expect(row.trading).toBe(true);
    expect((await call(r, '/api/market/QLRX')).json.halted).toBe(true);
    // Other companies are untouched, and the halted one keeps its price moving.
    expect((await call(r, '/api/orders', { method: 'POST', cookie: player, body: { account: 'career', ticker: 'NVRA', side: 'buy', qty: 1, clientOrderId: rid() } })).status).toBe(201);
    const p0 = priceOf(r, 'QLRX');
    advance(r, 120);
    expect(priceOf(r, 'QLRX')).not.toBe(p0);
    const state = await call(r, '/api/admin/state', { cookie: owner });
    expect(state.json.halts).toHaveLength(1);
    expect(state.json.halts[0]).toMatchObject({ ticker: 'QLRX', reason: 'Under review' });

    // A halt survives a restart.
    const dir = r.dir;
    await stop(r);
    const again = await boot({ dir, clock: r.clock });
    expect(again.app.services.halts.isHalted(again.app.services.world.companyByTicker('QLRX')!.id)).toBe(true);
    const owner2 = (await fetch(again.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'boss', password: 'a-good-password' }) })).headers.get('set-cookie')!.split(';')[0]!;
    const player2 = (await fetch(again.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'alice', password: 'a-good-password' }) })).headers.get('set-cookie')!.split(';')[0]!;
    catchUp(again);
    expect((await call(again, '/api/orders', { method: 'POST', cookie: player2, body: { account: 'career', ticker: 'QLRX', side: 'sell', qty: 1, clientOrderId: rid() } })).json.error.code).toBe('halted');
    expect((await post(again, '/api/admin/halt', owner2, { ticker: 'QLRX', halted: false })).status).toBe(200);
    expect((await call(again, '/api/orders', { method: 'POST', cookie: player2, body: { account: 'career', ticker: 'QLRX', side: 'sell', qty: 1, clientOrderId: rid() } })).status).toBe(201);
    expect((await call(again, '/api/market')).json.companies.find((c: { ticker: string }) => c.ticker === 'QLRX').halted).toBe(false);
  }, LONG);
});

describe('cash and coins', () => {
  it('ADM-12: giving or taking Career cash changes the balance but not the profit; too much is refused', async () => {
    const r = await boot();
    const owner = await signUp(r, 'boss');
    const player = await signUp(r, 'alice');
    catchUp(r);
    const account = async () => (await call(r, '/api/account', { cookie: player })).json;
    const first = await account();
    expect(first.cashCents).toBe(100_000);
    expect(first.profitCents).toBe(0);

    const give = await post(r, '/api/admin/cash', owner, { username: 'alice', amountCents: 250_000, note: 'for testing' });
    expect(give.status).toBe(200);
    expect(give.json.cashCents).toBe(350_000);
    const rich = await account();
    expect(rich.cashCents).toBe(350_000);
    expect(rich.startCashCents).toBe(350_000);
    expect(rich.profitCents).toBe(0); // a gift is a deposit, not trading profit
    // She can really spend it.
    const buy = await call(r, '/api/orders', { method: 'POST', cookie: player, body: { account: 'career', ticker: 'QLRX', side: 'buy', qty: 3, clientOrderId: rid() } });
    expect(buy.status).toBe(201);

    const tooMuch = await post(r, '/api/admin/cash', owner, { username: 'alice', amountCents: -99_999_999 });
    expect(tooMuch.status).toBe(400);
    expect(tooMuch.json.error.code).toBe('not_enough');
    expect(tooMuch.json.error.message).toMatch(/alice has only \$/);
    const cashNow = (await account()).cashCents;
    const take = await post(r, '/api/admin/cash', owner, { username: 'alice', amountCents: -cashNow });
    expect(take.json.cashCents).toBe(0);
    expect((await account()).cashCents).toBe(0);

    expect((await post(r, '/api/admin/cash', owner, { username: 'nobody', amountCents: 100 })).status).toBe(404);
    const taken: string[] = [];
    for (const amountCents of [0, 1.5, '100', null, 1e12, -1e12]) {
      const res = await post(r, '/api/admin/cash', owner, { username: 'alice', amountCents });
      if (res.status !== 400) taken.push(`${String(amountCents)}: ${res.status}`);
    }
    expect(taken).toEqual([]);
  }, LONG);

  it('ADM-13: coins go into the wallet and its ledger; the same request cannot pay twice', async () => {
    const r = await boot();
    const owner = await signUp(r, 'boss');
    const player = await signUp(r, 'alice');
    catchUp(r);
    const body = { requestId: 'coins-once-0001', username: 'alice', amountCents: 12_345 };
    expect((await call(r, '/api/admin/coins', { method: 'POST', cookie: owner, body })).json.coinsCents).toBe(12_345);
    expect((await call(r, '/api/admin/coins', { method: 'POST', cookie: owner, body })).json.duplicate).toBe(true);
    const wallet = await call(r, '/api/wallet', { cookie: player });
    expect(wallet.json.balanceCents).toBe(12_345);
    expect(wallet.json.recent[0]).toMatchObject({ deltaCents: 12_345, reason: 'admin_grant' });
    expect((await call(r, '/api/lobby', { cookie: player })).json.wallet).toBe(12_345);
    // Career cash is a different thing and did not move.
    expect((await call(r, '/api/account', { cookie: player })).json.cashCents).toBe(100_000);

    const tooMuch = await post(r, '/api/admin/coins', owner, { username: 'alice', amountCents: -12_346 });
    expect(tooMuch.status).toBe(400);
    expect((await call(r, '/api/wallet', { cookie: player })).json.balanceCents).toBe(12_345);
    expect((await post(r, '/api/admin/coins', owner, { username: 'alice', amountCents: -345 })).json.coinsCents).toBe(12_000);
    expect((await call(r, '/api/wallet', { cookie: player })).json.recent[0].reason).toBe('admin_take');
  }, LONG);
});

describe('the admin log and overview', () => {
  it('ADM-14: every action is logged once, newest first, with who did it; players and events are listed', async () => {
    const r = await boot();
    const owner = await signUp(r, 'boss');
    await signUp(r, 'alice');
    await signUp(r, 'alex_2');
    catchUp(r);
    await post(r, '/api/admin/cash', owner, { username: 'alice', amountCents: 5_000, note: 'bonus' });
    await post(r, '/api/admin/halt', owner, { ticker: 'QLRX', halted: true, reason: 'test' });
    await post(r, '/api/admin/halt', owner, { ticker: 'QLRX', halted: false });
    await post(r, '/api/admin/shock', owner, { ticker: 'NVRA', percent: 40, style: 'pump', speed: 'slow' });
    const state = (await call(r, '/api/admin/state', { cookie: owner })).json;
    expect(state.log.map((l: { action: string }) => l.action)).toEqual(['shock', 'resume', 'halt', 'cash']);
    expect(state.log[0]).toMatchObject({ admin: 'boss', target: 'NVRA' });
    expect(state.log[3].detail).toMatchObject({ amountCents: 5_000, note: 'bonus', cashAfterCents: 105_000 });
    expect(state.events).toHaveLength(1);
    expect(state.events[0]).toMatchObject({ ticker: 'NVRA', direction: 'positive' });
    const alice = state.players.find((p: { username: string }) => p.username === 'alice');
    expect(alice).toMatchObject({ cashCents: 105_000, netWorthCents: 105_000, coinsCents: 0, role: 'player' });
    // The player filter is a plain "contains", and "_" is not a wildcard.
    const filtered = (await call(r, '/api/admin/state?q=al', { cookie: owner })).json.players.map((p: { username: string }) => p.username);
    expect(filtered).toEqual(['alice', 'alex_2']);
    expect((await call(r, '/api/admin/state?q=_', { cookie: owner })).json.players.map((p: { username: string }) => p.username)).toEqual(['alex_2']);
    expect((await call(r, '/api/admin/state?q=%25', { cookie: owner })).json.players).toEqual([]);
  }, LONG);
});
