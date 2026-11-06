// Penny stocks (docs/world.md §44): the lowest price of a share is one cent instead of one dollar, and six invented penny stocks join the market.
// What is checked: the list itself; that a stock can now fall below a dollar and never below one cent; that the six join a brand-new or a
// running world once, change nothing that exists, and survive a restart; that a name clash is refused; that quotes, the order book and
// real orders (a buy, a sell, a short with a take-profit under a dollar, stop and take exits) work at prices of a few cents.
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CURATED, MIN_PRICE, MAX_PRICE, PENNY_SEEDS, STOCK_SECTOR_IDS, WorldSim, buildCatalog, ladder, memeEntries, pennyEntries, quoteOf, type Company } from '../src/world';
import { PERSONALITIES } from '../src/world/params';
import { createApp, type App } from '../server/app';
import { loadConfig } from '../server/config';
import { Logger } from '../server/log';
import { Db } from '../server/sqlite';
import { PENNY_STOCKS_SEEDED } from '../server/world/runtime';
import { bookOf, makeEvent } from './helpers/world';
import { Clock, makeRig, priceVector, type Rig } from './helpers/server';

const LONG = 240_000;
const rigs: Rig[] = [];
function rig(clock?: Clock): Rig {
  const r = makeRig(clock);
  rigs.push(r);
  return r;
}
const apps: { app: App; server: Server; dir: string }[] = [];
afterEach(async () => {
  while (rigs.length > 0) rigs.pop()?.cleanup();
  while (apps.length > 0) {
    const a = apps.pop() as (typeof apps)[number];
    await new Promise<void>((done) => {
      a.server.closeAllConnections?.();
      a.server.close(() => done());
    });
    try {
      a.app.close();
    } catch {
      // closed by the test
    }
    rmSync(a.dir, { recursive: true, force: true });
  }
});

describe('the list of penny stocks', () => {
  it('PENNY-1: six penny stocks, each under a dollar, ordinary micro-cap stocks (not coins), with names and tickers nobody else uses', () => {
    const list = pennyEntries();
    expect(list.length).toBe(6);
    expect(PENNY_SEEDS.length).toBe(6);
    expect(new Set(list.map((e) => e.ticker)).size).toBe(6);
    expect(new Set(list.map((e) => e.name)).size).toBe(6);
    for (const e of list) {
      expect(/^[A-Z]{4}$/.test(e.ticker)).toBe(true);
      expect(e.price).toBeGreaterThanOrEqual(MIN_PRICE);
      expect(e.price).toBeLessThan(100); // under a dollar: that is what makes it a penny stock
      expect(Number.isInteger(e.price)).toBe(true);
      expect(e.tier).toBe('micro');
      expect((STOCK_SECTOR_IDS as readonly string[]).includes(e.sector)).toBe(true);
      expect(e.meme).toBeUndefined();
      expect(Object.keys(PERSONALITIES)).toContain(e.personality);
      expect(e.description.length).toBeLessThanOrEqual(300);
      expect(e.description.startsWith('A penny stock')).toBe(true);
      expect(e.products[0]).not.toBe(e.products[1]);
    }
    // No clash with the hand-written stocks, the thirty coins, or a big generated catalog (what a world grows into).
    const taken = new Set<string>();
    const takenNames = new Set<string>();
    for (const c of buildCatalog(1500)) {
      taken.add(c.ticker);
      takenNames.add(c.name);
    }
    for (const m of memeEntries()) {
      taken.add(m.ticker);
      takenNames.add(m.name);
    }
    for (const e of list) {
      expect(taken.has(e.ticker) ? `${e.ticker} is already used` : '').toBe('');
      expect(takenNames.has(e.name) ? `${e.name} is already used` : '').toBe('');
    }
  });

  it('PENNY-2: made into companies, each is an ordinary stock with a sensible size, listed at its price', () => {
    const first = CURATED.length + 30;
    const own = new Map(memeEntries().map((e, i) => [CURATED.length + i, e]));
    pennyEntries().forEach((e, i) => own.set(first + i, e));
    const catalog = buildCatalog(first + 6, () => 0, own);
    const pennies = catalog.slice(first);
    expect(pennies.map((c) => c.ticker)).toEqual(pennyEntries().map((e) => e.ticker));
    for (const c of pennies) {
      expect(c.sector).not.toBe('meme');
      expect(c.basePriceCents).toBeLessThan(100);
      expect(c.priceScale).toBeUndefined(); // counted in whole cents, like every stock
      expect(c.sharesOutstanding).toBeGreaterThanOrEqual(1_000_000);
      expect(c.avgDailyVolume).toBeGreaterThan(0);
      expect(c.spreadBps).toBeGreaterThan(0);
    }
    // The stocks that were there before are exactly the same with or without the penny stocks.
    const before = buildCatalog(first, () => 0, new Map(memeEntries().map((e, i) => [CURATED.length + i, e])));
    expect(JSON.stringify(catalog.slice(0, first))).toBe(JSON.stringify(before));
  });
});

describe('the lowest price is one cent', () => {
  it('PENNY-3: the lowest price of a share is 1 cent, and the highest is still $1,000,000', () => {
    expect(MIN_PRICE).toBe(1);
    expect(MAX_PRICE).toBe(100_000_000);
  });

  it('PENNY-4: a big crash takes an ordinary stock far below a dollar, and no price is ever below one cent (it used to stop at $1.00)', () => {
    const catalog = buildCatalog(66);
    const stock = catalog.find((c) => c.sector !== 'meme' && c.basePriceCents >= 2500 && c.basePriceCents <= 3500) as Company;
    expect(stock).toBeDefined();
    const run = (move: number): { low: number; end: number } => {
      const e = makeEvent({ key: 'crash', companyId: stock.id, startTick: 5, durationTicks: 6, realized: move, permShare: 1, shape: 'front' });
      const sim = new WorldSim(9, catalog);
      const book = bookOf([e], catalog);
      let low = Number.POSITIVE_INFINITY;
      for (let t = 1; t <= 1200; t += 1) {
        sim.step(book);
        const p = sim.price(stock.id);
        expect(Number.isInteger(p)).toBe(true);
        expect(p).toBeGreaterThanOrEqual(1);
        low = Math.min(low, p);
      }
      return { low, end: sim.price(stock.id) };
    };
    const big = run(-3.2); // about -96 %
    expect(big.low).toBeLessThan(100);
    expect(big.low).toBeGreaterThanOrEqual(1);
    const huge = run(-6); // far more than the stock could lose: it stops at the lowest price there is
    expect(huge.low).toBe(1);
    expect(huge.end).toBeGreaterThanOrEqual(1);
    expect(huge.end).toBeLessThan(10);
  }, LONG);

  it('PENNY-5: a penny stock moves around for days with no price below a cent, whole cents only, and it does move', () => {
    const first = CURATED.length + 30;
    const own = new Map(memeEntries().map((e, i) => [CURATED.length + i, e]));
    pennyEntries().forEach((e, i) => own.set(first + i, e));
    const catalog = buildCatalog(first + 6, () => 0, own);
    const sim = new WorldSim(4, catalog);
    const book = bookOf([], catalog);
    const seen = new Map<number, Set<number>>();
    for (let i = first; i < first + 6; i += 1) seen.set(i, new Set());
    for (let t = 1; t <= 30_000; t += 1) {
      sim.step(book);
      for (let i = first; i < first + 6; i += 1) {
        const p = sim.price(i);
        if (!Number.isInteger(p) || p < MIN_PRICE) throw new Error(`tick ${t}: ${catalog[i]?.ticker} is ${p}`);
        (seen.get(i) as Set<number>).add(p);
      }
    }
    for (let i = first; i < first + 6; i += 1) expect((seen.get(i) as Set<number>).size).toBeGreaterThan(3);
  }, LONG);
});

describe('quotes and the order book at a few cents', () => {
  it('PENNY-6: the buy and sell prices of a 12-cent stock stay positive whole cents and the book never goes below a cent', () => {
    const c = { spreadBps: 58.5, avgDailyVolume: 2_700_000, liquidity: 0.2 };
    const q = quoteOf(c, 12, 1);
    expect(q.bid).toBeGreaterThanOrEqual(1);
    expect(q.ask).toBeGreaterThan(q.bid);
    expect(Number.isInteger(q.bid) && Number.isInteger(q.ask)).toBe(true);
    // A one-cent stock: the bid cannot go to zero.
    const floor = quoteOf(c, 1, 1);
    expect(floor.bid).toBe(1);
    expect(floor.ask).toBe(2);
    for (const price of [1, 2, 5, 12, 42, 99]) {
      const quote = quoteOf(c, price, 1.4);
      for (const side of ['buy', 'sell'] as const) {
        const levels = ladder(c, quote, 1.4, side);
        expect(levels.length).toBeGreaterThan(0);
        for (const l of levels) {
          expect(Number.isInteger(l.price)).toBe(true);
          expect(l.price).toBeGreaterThanOrEqual(1);
          expect(l.size).toBeGreaterThanOrEqual(1);
        }
      }
    }
  });
});

describe('the penny stocks in a running world', () => {
  it('PENNY-7: a brand-new world has them from the first tick, after the coins, saved once', () => {
    const r = rig();
    const { world, db } = r.open({ companyCount: CURATED.length, memecoins: true, pennyStocks: true });
    expect(world.companies.length).toBe(CURATED.length + 30 + 6);
    const first = CURATED.length + 30;
    pennyEntries().forEach((e, i) => {
      const c = world.companies[first + i] as Company;
      expect(c.ticker).toBe(e.ticker);
      expect(c.sector).not.toBe('meme');
      expect(c.listingTick).toBe(0);
      expect(world.sim.isListed(first + i)).toBe(true);
      // (The world has already run a day of history, so the price is near the listing price, not exactly on it.)
      expect(world.sim.price(first + i)).toBeGreaterThanOrEqual(MIN_PRICE);
      expect(world.sim.price(first + i)).toBeLessThan(e.price * 2 + 5);
    });
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM meme_companies')?.n).toBe(36);
    expect(db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', PENNY_STOCKS_SEEDED)).toBeDefined();
    expect(world.companyByTicker('DRFT')?.id).toBe(first);
  }, LONG);

  it('PENNY-8: a world without the switch has none (tests and old programs are not changed)', () => {
    const r = rig();
    const { world, db } = r.open({ companyCount: CURATED.length, memecoins: true });
    expect(world.companies.length).toBe(CURATED.length + 30);
    expect(db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', PENNY_STOCKS_SEEDED)).toBeUndefined();
    expect(world.companyByTicker('DRFT')).toBeUndefined();
  }, LONG);

  it('PENNY-9: a world that has run for a while gets them after its last company, listing a few minutes later; every other price stays exactly the same', () => {
    const a = rig(new Clock());
    const control = a.open({ companyCount: CURATED.length, warmupDays: 1, memecoins: true });
    const b = rig(new Clock());
    b.open({ companyCount: CURATED.length, warmupDays: 1, memecoins: true }).db.close();
    a.clock.advanceSeconds(3600);
    b.clock.advanceSeconds(3600);
    control.world.advanceTo(control.world.currentTick(), Infinity);
    const upgraded = b.open({ companyCount: CURATED.length, warmupDays: 1, memecoins: true, pennyStocks: true });
    const n = CURATED.length + 30;
    expect(upgraded.world.companies.length).toBe(n + 6);
    const first = upgraded.world.companies[n] as Company;
    expect(first.ticker).toBe('DRFT');
    expect(first.listingTick).toBeGreaterThan(upgraded.world.currentTick());
    expect(upgraded.world.sim.isListed(n)).toBe(false);
    for (let step = 0; step < 4; step += 1) {
      a.clock.advanceSeconds(300);
      b.clock.advanceSeconds(300);
      control.world.advanceTo(control.world.currentTick(), Infinity);
      upgraded.world.advanceTo(upgraded.world.currentTick(), Infinity);
      expect(upgraded.world.sim.tick).toBe(control.world.sim.tick);
      expect(priceVector(upgraded.world).slice(0, n)).toEqual(priceVector(control.world).slice(0, n));
    }
    expect(upgraded.world.sim.isListed(n)).toBe(true);
    expect(upgraded.world.sim.price(n)).toBeGreaterThanOrEqual(MIN_PRICE);
    expect(upgraded.world.sim.price(n)).toBeLessThan(500);
  }, LONG);

  it('PENNY-10: they are added only once; a restart reproduces their prices; the saved numbers survive without the switch', () => {
    const r = rig();
    const first = r.open({ companyCount: CURATED.length, memecoins: true, pennyStocks: true });
    r.clock.advanceSeconds(600);
    first.world.advanceTo(first.world.currentTick(), Infinity);
    const before = priceVector(first.world);
    const tickBefore = first.world.sim.tick;
    first.db.close();
    const second = r.open({ companyCount: CURATED.length, memecoins: true, pennyStocks: false });
    expect(second.world.companies.length).toBe(CURATED.length + 36);
    expect(second.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM meme_companies')?.n).toBe(36);
    expect(second.world.sim.tick).toBe(tickBefore);
    expect(priceVector(second.world)).toEqual(before);
    second.db.close();
    const third = r.open({ companyCount: CURATED.length, memecoins: true, pennyStocks: true });
    expect(third.world.companies.length).toBe(CURATED.length + 36);
    expect(third.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM meme_companies')?.n).toBe(36);
    expect(third.world.companies.slice(CURATED.length + 30).map((c) => c.ticker)).toEqual(pennyEntries().map((e) => e.ticker));
    expect(priceVector(third.world)).toEqual(before);
  }, LONG);

  it('PENNY-11: a stopped world with penny stocks catches up to exactly the prices a world that never stopped has', () => {
    const live = rig(new Clock());
    const w1 = live.open({ companyCount: CURATED.length, memecoins: true, pennyStocks: true });
    const stop = rig(new Clock());
    stop.open({ companyCount: CURATED.length, memecoins: true, pennyStocks: true }).db.close();
    live.clock.advanceSeconds(7200);
    stop.clock.advanceSeconds(7200);
    w1.world.advanceTo(w1.world.currentTick(), Infinity);
    const w2 = stop.open({ companyCount: CURATED.length, memecoins: true, pennyStocks: true });
    expect(w2.world.sim.tick).toBe(w1.world.sim.tick);
    expect(priceVector(w2.world)).toEqual(priceVector(w1.world));
  }, LONG);

  it('PENNY-12: they work without the memecoins too (ids still follow the last company), and a name clash is refused with a sentence', () => {
    const r = rig();
    const { world } = r.open({ companyCount: CURATED.length, pennyStocks: true });
    expect(world.companies.length).toBe(CURATED.length + 6);
    expect(world.companyByTicker('PWHS')?.id).toBe(CURATED.length + 1);
    const clash = rig();
    clash.open({ companyCount: CURATED.length }).db.close();
    const raw = new Db(clash.path);
    clash.opened.push(raw);
    raw.run("INSERT INTO users(username, display_name, pw_hash, role, created_ms) VALUES ('boss', 'Boss', 'x', 'owner', 1)");
    const uid = raw.get<{ id: number }>('SELECT id FROM users WHERE username = ?', 'boss')?.id as number;
    raw.run('INSERT INTO companies(id, ticker, name, listing_tick, listed_ms) VALUES (?, ?, ?, ?, ?)', CURATED.length, 'XDFT', 'Driftwater Mobile', 0, 1);
    raw.run(
      'INSERT INTO custom_companies(company_id, ticker, name, sector, industry, tier, personality, price_cents, product1, product2, description, created_ms, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      CURATED.length, 'XDFT', 'Driftwater Mobile', 'tech', 'Software', 'small', 'steady', 5000, 'a', 'b', 'd', 1, uid,
    );
    raw.close();
    expect(() => clash.open({ companyCount: CURATED.length, pennyStocks: true })).toThrow(/penny stock DRFT \(Driftwater Mobile\)/);
  }, LONG);
});

// ---- real orders at prices of a few cents ----------------------------------------------------------------------------

interface Running {
  app: App;
  base: string;
  clock: Clock;
}
async function boot(): Promise<Running> {
  const dir = mkdtempSync(join(tmpdir(), 'tq-penny-'));
  const clock = new Clock();
  const config = loadConfig({ TQ_DATA_DIR: dir, TQ_COMPANIES: '66', TQ_WARMUP_DAYS: '1', TQ_PORT: '8787', TQ_OWNER: 'boss' });
  const app = createApp({ config, log: new Logger({ sink: null, now: clock.now }), worldSeed: 777, now: clock.now, flowGain: 0, autoPauses: false, memecoins: true, pennyStocks: true });
  const server = createServer(app.handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  apps.push({ app, server, dir });
  return { app, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, clock };
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
function gotoTick(r: Running, tick: number): void {
  const w = r.app.services.world;
  while (w.currentTick() < tick) {
    const next = Math.min(tick, w.currentTick() + 2);
    r.clock.ms = w.msOfTick(next);
    for (let i = 0; i < 20_000 && w.sim.tick < w.currentTick(); i += 1) w.pump();
  }
}
let counter = 0;
const oid = (): string => `penny-test-${(counter += 1).toString().padStart(8, '0')}`;
const order = (r: Running, cookie: string, body: Record<string, unknown>) => call(r, '/api/orders', { method: 'POST', cookie, body: { account: 'career', clientOrderId: oid(), ...body } });
const account = async (r: Running, cookie: string) => (await call(r, '/api/account?account=career', { cookie })).json;

describe('real orders at a few cents', () => {
  it('PENNY-13: the market lists the penny stocks with whole-cent prices under a dollar, and a player can buy and sell one; money stays exact', async () => {
    const r = await boot();
    const w = r.app.services.world;
    gotoTick(r, w.currentTick() + 5);
    const market = await call(r, '/api/market');
    expect(market.status).toBe(200);
    const text = JSON.stringify(market.json);
    for (const e of pennyEntries()) expect(text).toContain(e.ticker);

    const cookie = await signUp(r, 'pennyfan');
    const start = await account(r, cookie);
    const company = w.companyByTicker('DRFT') as Company;
    const price = w.sim.price(company.id);
    expect(Number.isInteger(price)).toBe(true);
    expect(price).toBeLessThan(150);

    const buy = await order(r, cookie, { ticker: 'DRFT', side: 'buy', qty: 1000 });
    expect(buy.status).toBe(201);
    const afterBuy = await account(r, cookie);
    const spent = start.cashCents - afterBuy.cashCents;
    expect(Number.isInteger(spent)).toBe(true);
    // 1000 shares at about 40 cents is about $400 (the buy price is the ask, a cent or so over the middle, plus a fee of 0 or a few cents).
    expect(spent).toBeGreaterThan(1000 * (price - 5));
    expect(spent).toBeLessThan(1000 * (price + 8) + 50);
    expect(afterBuy.positions.some((p: { ticker: string; shares: number }) => p.ticker === 'DRFT' && p.shares === 1000)).toBe(true);

    const sell = await order(r, cookie, { ticker: 'DRFT', side: 'sell', qty: 1000 });
    expect(sell.status).toBe(201);
    const afterSell = await account(r, cookie);
    expect(afterSell.positions.some((p: { ticker: string }) => p.ticker === 'DRFT')).toBe(false);
    const lost = start.cashCents - afterSell.cashCents;
    expect(Number.isInteger(lost)).toBe(true);
    expect(lost).toBeGreaterThanOrEqual(0); // buying and selling right away cannot make money (the spread and the fee)
    expect(lost).toBeLessThan(1000 * 10); // and costs at most about ten cents a share

    const trades = (await call(r, '/api/account/trades?account=career', { cookie })).json.trades;
    expect(trades.length).toBeGreaterThanOrEqual(2);
    for (const t of trades) {
      expect(t.ticker).toBe('DRFT');
      expect(Number.isInteger(t.midCents)).toBe(true);
      expect(t.midCents).toBeGreaterThanOrEqual(1);
      expect(t.midCents).toBeLessThan(200);
      expect(t.avgPrice).toBeGreaterThanOrEqual(1);
      expect(t.avgPrice).toBeLessThan(200);
      expect(Number.isInteger(t.totalCents)).toBe(true);
      expect(Math.abs(t.totalCents - t.filled * t.avgPrice)).toBeLessThanOrEqual(1);
    }
  }, LONG);

  it('PENNY-14: stop-loss and take-profit can be set under a dollar, and a short can take profit under a dollar (it needed $1.00 or more before)', async () => {
    const r = await boot();
    const w = r.app.services.world;
    gotoTick(r, w.currentTick() + 5);
    const cookie = await signUp(r, 'pennyexits');
    const company = w.companyByTicker('LNTR') as Company;
    const price = w.sim.price(company.id);
    const open = await order(r, cookie, { ticker: 'LNTR', side: 'buy', qty: 500 });
    expect(open.status).toBe(201);
    const exits = await call(r, '/api/positions/exits', { method: 'POST', cookie, body: { account: 'career', ticker: 'LNTR', stopPrice: Math.max(1, price - 10), takePrice: price + 15, requestId: oid() } });
    expect([200, 201]).toContain(exits.status);
    const held = (await account(r, cookie)).positions.find((p: { ticker: string }) => p.ticker === 'LNTR');
    expect(held.stopCents).toBe(Math.max(1, price - 10));
    expect(held.takeCents).toBe(price + 15);

    // A short with a take-profit of 5 cents: the old rule said no price can be below $1.00 so it could never fire.
    const dee = await signUp(r, 'pennyshort');
    const short = await order(r, dee, { ticker: 'LNTR', side: 'sell', short: true, qty: 200, takePrice: 5 });
    expect(short.status).toBe(201);
    const shortPos = (await account(r, dee)).positions.find((p: { ticker: string; short: boolean }) => p.ticker === 'LNTR' && p.short);
    expect(shortPos.takeCents).toBe(5);
    // A take-profit of zero is still not a price.
    const bad = await order(r, dee, { ticker: 'PWHS', side: 'sell', short: true, qty: 100, takePrice: 0 });
    expect(bad.status).toBeGreaterThanOrEqual(400);
  }, LONG);
});
