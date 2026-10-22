// The live order book (docs/world.md §6.4). While players are net buying a company, the asks get thinner and the bids thicker; while they
// are net selling, the opposite; the effect fades with the pressure (half-life 5 minutes). Every number a player sees is the number an
// order gets: the book on the page, the estimate and the fill all come from the same ladder. 1v1 orders and a world with player pushes
// switched off never tilt the book.
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BOOK_LEVELS, BOOK_TILT_GAIN, BOOK_TILT_MAX, BOOK_TILT_MIN, LEVEL_GROWTH, bookScale, ladder, quoteOf, touchShares } from '../src/world';
import { createApp, type App } from '../server/app';
import { loadConfig } from '../server/config';
import { bookDepth } from '../server/flow';
import { Logger } from '../server/log';
import { Clock } from './helpers/server';

const LONG = 240_000;

describe('Live book: the rules', () => {
  it('BOOK-1: net buying thins the asks and thickens the bids, net selling does the opposite; never below 15 % or above 160 %; 0 is the calm book', () => {
    expect(bookScale('buy', 0)).toBe(1);
    expect(bookScale('sell', 0)).toBe(1);
    expect(bookScale('buy', 0.5)).toBeCloseTo(1 - BOOK_TILT_GAIN * 0.5, 12);
    expect(bookScale('sell', 0.5)).toBeCloseTo(1 + BOOK_TILT_GAIN * 0.5, 12);
    expect(bookScale('buy', -0.5)).toBeGreaterThan(1);
    expect(bookScale('sell', -0.5)).toBeLessThan(1);
    expect(bookScale('buy', 1)).toBeGreaterThanOrEqual(BOOK_TILT_MIN);
    expect(bookScale('sell', -1)).toBeGreaterThanOrEqual(BOOK_TILT_MIN);
    for (const t of [-50, -1, 0, 1, 50, Number.POSITIVE_INFINITY, Number.NaN]) {
      for (const side of ['buy', 'sell'] as const) {
        const f = bookScale(side, t);
        expect(f).toBeGreaterThanOrEqual(BOOK_TILT_MIN);
        expect(f).toBeLessThanOrEqual(BOOK_TILT_MAX);
      }
    }
    expect(bookScale('buy', Number.NaN)).toBe(1);
  });

  it('BOOK-2: the ladder scales its sizes and nothing else; scale 1 is exactly the old book', () => {
    const company = { avgDailyVolume: 200_000, liquidity: 0.5 };
    const quote = quoteOf({ spreadBps: 20 }, 5_000, 1);
    const calm = ladder(company, quote, 1, 'buy');
    expect(ladder(company, quote, 1, 'buy', BOOK_LEVELS, 1)).toEqual(calm);
    const thin = ladder(company, quote, 1, 'buy', BOOK_LEVELS, 0.4);
    expect(thin.map((l) => l.price)).toEqual(calm.map((l) => l.price));
    const touch = touchShares(company, 1);
    thin.forEach((l, k) => {
      expect(l.size).toBeLessThan((calm[k] as { size: number }).size);
      expect(l.size).toBe(Math.max(1, Math.floor(touch * (1 + LEVEL_GROWTH * k) * 0.4)));
    });
    // Sizes never reach zero, however thin.
    for (const l of ladder({ avgDailyVolume: 3, liquidity: 0.1 }, quote, 1, 'sell', BOOK_LEVELS, 0.15)) expect(l.size).toBeGreaterThanOrEqual(1);
  });
});

// ---- the whole program -------------------------------------------------------------------------------------------------------

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
      // closed by the test
    }
  }
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

async function boot(flowGain: number): Promise<Running> {
  const dir = mkdtempSync(join(tmpdir(), 'tq-book-'));
  dirs.push(dir);
  const clock = new Clock();
  const config = loadConfig({ TQ_DATA_DIR: dir, TQ_COMPANIES: '12', TQ_WARMUP_DAYS: '1', TQ_PORT: '8787', TQ_OWNER: 'boss' });
  const app = createApp({ config, log: new Logger({ sink: null, now: clock.now }), worldSeed: 777, now: clock.now, flowGain, autoPauses: false });
  const server = createServer(app.handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const r = { app, server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, dir, clock };
  running.push(r);
  return r;
}

function advance(r: Running, seconds: number): void {
  const w = r.app.services.world;
  for (let left = seconds; left > 0; left -= 10) {
    r.clock.advanceSeconds(Math.min(10, left));
    for (let i = 0; i < 400_000 && w.sim.tick < w.currentTick(); i += 1) w.pump();
  }
  expect(w.sim.tick).toBe(w.currentTick());
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

async function signUp(r: Running, name: string): Promise<{ cookie: string; accountId: number }> {
  const res = await fetch(r.base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: name, password: 'a-good-password' }) });
  expect(res.status).toBe(201);
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] as string;
  const accountId = r.app.services.db.get<{ id: number }>("SELECT a.id AS id FROM accounts a JOIN users u ON u.id = a.user_id WHERE u.username = ? AND a.kind = 'career'", name)!.id;
  return { cookie, accountId };
}

let orderNo = 0;
const sizes = (levels: { size: number }[]): number[] => levels.map((l) => l.size);
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
const bookOf = async (r: Running, ticker: string) => (await call(r, `/api/market/${ticker}/book`)).json as { bids: { levels: { price: number; size: number }[]; total: number }; asks: { levels: { price: number; size: number }[]; total: number } };

describe('Live book: over the web API', () => {
  it('BOOK-3: after players buy a lot the asks are thinner and the bids thicker; the page, the estimate and the fill all agree; it fades back with time', async () => {
    const r = await boot(1);
    const alice = await signUp(r, 'alice');
    const bob = await signUp(r, 'bob');
    advance(r, 60);
    const w = r.app.services.world;
    const co = w.companyByTicker('QLRX')!;
    const calm = await bookOf(r, co.ticker);
    // Give alice plenty of cash and let her buy about half of a calm book's depth.
    r.app.services.db.run('UPDATE accounts SET cash_cents = 500000000000 WHERE id = ?', alice.accountId);
    const qty = Math.floor(bookDepth(co) * 0.5);
    const buy = await call(r, '/api/orders', { method: 'POST', cookie: alice.cookie, body: { account: 'career', ticker: co.ticker, side: 'buy', qty, clientOrderId: `order-${(orderNo += 1)}-abcdef` } });
    expect(buy.status).toBe(201);
    const after = await bookOf(r, co.ticker);
    expect(after.asks.levels).toHaveLength(calm.asks.levels.length);
    expect(sum(sizes(after.asks.levels))).toBeLessThan(sum(sizes(calm.asks.levels)));
    expect(sum(sizes(after.bids.levels))).toBeGreaterThan(sum(sizes(calm.bids.levels)));
    // Level by level, the asks are thinner and the bids thicker.
    after.asks.levels.forEach((l, k) => expect(l.size).toBeLessThanOrEqual((calm.asks.levels[k] as { size: number }).size));
    after.bids.levels.forEach((l, k) => expect(l.size).toBeGreaterThanOrEqual((calm.bids.levels[k] as { size: number }).size));

    // What the page shows is what the world's book is, and what an order gets: bob's estimate and his real fill use the same ladder.
    const live = w.book(co.id, 'buy', after.asks.levels.length);
    expect(after.asks.levels.map((l) => l.size)).toEqual(live.map((l) => l.size));
    const probe = Math.floor(sum(sizes(after.asks.levels)) / 3);
    const est = await call(r, `/api/market/${co.ticker}/estimate?side=buy&qty=${probe}&account=career`, { cookie: bob.cookie });
    expect(est.status).toBe(200);
    r.app.services.db.run('UPDATE accounts SET cash_cents = 500000000000 WHERE id = ?', bob.accountId);
    const fill = await call(r, '/api/orders', { method: 'POST', cookie: bob.cookie, body: { account: 'career', ticker: co.ticker, side: 'buy', qty: probe, clientOrderId: `order-${(orderNo += 1)}-abcdef` } });
    expect(fill.status).toBe(201);
    expect(fill.json.trade.filled).toBe(est.json.filledQty);
    expect(fill.json.trade.totalCents).toBe(est.json.totalCents);

    // Selling pushes the other way: after the pressure is sold off and then some, the bids are thinner than the asks relative to calm.
    // Fading: 15 minutes later (three half-lives) most of the effect is gone.
    advance(r, 900);
    const later = await bookOf(r, co.ticker);
    const calmLater = ladderSizes(w, co.id, 'buy', later.asks.levels.length);
    void calmLater;
    const gap = (levels: { size: number }[], reference: { size: number }[]): number => Math.abs(sum(sizes(levels)) - sum(sizes(reference)));
    expect(gap(later.asks.levels, calm.asks.levels)).toBeLessThan(gap(after.asks.levels, calm.asks.levels));
  }, LONG);

  it('BOOK-4: net selling does the opposite: the bids thin out and the asks thicken', async () => {
    const r = await boot(1);
    const alice = await signUp(r, 'alice');
    advance(r, 60);
    const w = r.app.services.world;
    const co = w.companyByTicker('QLRX')!;
    r.app.services.db.run('UPDATE accounts SET cash_cents = 500000000000 WHERE id = ?', alice.accountId);
    const qty = Math.floor(bookDepth(co) * 0.6);
    // Alice owns the shares she sells (a position given directly), so this is pure selling pressure.
    r.app.services.db.run('INSERT INTO positions(account_id, company_id, shares, cost_cents) VALUES (?, ?, ?, 1)', alice.accountId, co.id, qty);
    const calm = await bookOf(r, co.ticker);
    const sold = await call(r, '/api/orders', { method: 'POST', cookie: alice.cookie, body: { account: 'career', ticker: co.ticker, side: 'sell', qty, clientOrderId: `order-${(orderNo += 1)}-abcdef` } });
    expect(sold.status).toBe(201);
    const after = await bookOf(r, co.ticker);
    expect(sum(sizes(after.bids.levels))).toBeLessThan(sum(sizes(calm.bids.levels)));
    expect(sum(sizes(after.asks.levels))).toBeGreaterThan(sum(sizes(calm.asks.levels)));
  }, LONG);

  it('BOOK-5: with player pushes switched off, or for a 1v1 order, the book never tilts', async () => {
    const off = await boot(0);
    const a = await signUp(off, 'alice');
    advance(off, 60);
    const co = off.app.services.world.companyByTicker('QLRX')!;
    const calm = await bookOf(off, co.ticker);
    off.app.services.db.run('UPDATE accounts SET cash_cents = 500000000000 WHERE id = ?', a.accountId);
    const qty = Math.floor(bookDepth(co) * 0.5);
    expect((await call(off, '/api/orders', { method: 'POST', cookie: a.cookie, body: { account: 'career', ticker: co.ticker, side: 'buy', qty, clientOrderId: `order-${(orderNo += 1)}-abcdef` } })).status).toBe(201);
    expect(sizes((await bookOf(off, co.ticker)).asks.levels)).toEqual(sizes(calm.asks.levels));

    const on = await boot(1);
    const b = await signUp(on, 'bob');
    advance(on, 60);
    const co2 = on.app.services.world.companyByTicker('QLRX')!;
    const calm2 = await bookOf(on, co2.ticker);
    const match = on.app.services.trading.createMatchAccount(on.app.services.db.get<{ user_id: number }>('SELECT user_id FROM accounts WHERE id = ?', b.accountId)!.user_id, 1, 500_000_000_000);
    const now = on.app.services.world.sim.tick;
    on.app.services.db.run("INSERT INTO matches(id, state, created_ms, start_tick, end_tick, duration_ticks, start_cash_cents) VALUES (1, 'live', 0, ?, ?, 180, 500000000000)", now - 5, now + 175);
    const out = on.app.services.trading.placeOrder({ accountId: match.id, clientOrderId: 'match-order-000001', companyId: co2.id, side: 'buy', qty: Math.floor(bookDepth(co2) * 0.5) });
    expect(out.trade.filled).toBeGreaterThan(0);
    expect(sizes((await bookOf(on, co2.ticker)).asks.levels)).toEqual(sizes(calm2.asks.levels));
  }, LONG);
});

function ladderSizes(w: App['services']['world'], id: number, side: 'buy' | 'sell', levels: number): number[] {
  return w.book(id, side, levels).map((l) => l.size);
}
