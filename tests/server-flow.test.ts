// Player trades move prices (server/flow.ts, docs/world.md §8.6). The properties that matter:
//   • buying pushes the price up and selling pushes it down, by more for thin, small companies than for big liquid ones;
//   • the push is a STORED event, so after a restart every price is exactly what a server that never stopped has;
//   • the trader pays more than the price moves in his favour, so buying and selling again can never make money by itself;
//   • 1v1 match accounts never move the price; there is one fixed strength (no dial).
// Two worlds with the same seed and clock produce identical prices, so the difference between a world where something was traded
// and one where nothing was is exactly the effect of the trade.
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../server/app';
import { loadConfig } from '../server/config';
import { FLOW_EVENT_TICKS, FLOW_GAIN, FLOW_HALF_LIFE_TICKS, FLOW_MAX_BOOKS, FLOW_MAX_STEP, FLOW_MOVE_SHARE, FLOW_PAID_SHARE, bookDepth, fadePressure, horizonSigma, pushOf } from '../server/flow';
import * as flowModule from '../server/flow';
import { Logger } from '../server/log';
import { MIGRATIONS, migrate } from '../server/schema';
import { Db } from '../server/sqlite';
import { buildCatalog } from '../src/world';
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

/**
 * How strong the pushes are in a test. The game itself has one strength (FLOW_GAIN, the size of the real market); these tests run
 * pushes 5 or 20 times as strong ("lively", "wild") so that they show in a few seconds of market, or none at all ("off"), through
 * the test-only option flowGain. "game" gives no option at all, so the program's own default applies.
 */
const GAINS = { off: 0, lively: 5, wild: 20 } as const;
type Strength = keyof typeof GAINS | 'game';

async function boot(options: { dir?: string; clock?: Clock; flow?: Strength; warmup?: string } = {}): Promise<Running> {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'tq-flow-'));
  if (options.dir === undefined) dirs.push(dir);
  const clock = options.clock ?? new Clock();
  const config = loadConfig({ TQ_DATA_DIR: dir, TQ_COMPANIES: '12', TQ_WARMUP_DAYS: options.warmup ?? '0', TQ_PORT: '8787', TQ_OWNER: 'boss' });
  const app = createApp({ config, log: new Logger({ sink: null, now: clock.now }), worldSeed: 777, now: clock.now, flowGain: options.flow === 'game' ? undefined : GAINS[options.flow ?? 'lively'] });
  const server = createServer(app.handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const r = { app, server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, dir, clock };
  running.push(r);
  return r;
}

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

async function logIn(r: Running, name: string): Promise<string> {
  const res = await fetch(r.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: name, password: 'a-good-password' }) });
  expect(res.status).toBe(200);
  return (res.headers.get('set-cookie') ?? '').split(';')[0] as string;
}

let counter = 0;
const rid = (): string => `flow-${(counter += 1).toString().padStart(8, '0')}`;
const priceOf = (r: Running, ticker: string): number => {
  const w = r.app.services.world;
  return w.sim.price((w.companyByTicker(ticker) as { id: number }).id);
};
const allPrices = (r: Running): number[] => {
  const w = r.app.services.world;
  return Array.from({ length: w.companies.length }, (_, i) => w.sim.price(i));
};
const rows = (r: Running, sql: string): any[] => r.app.services.db.all(sql) as any[];

async function order(r: Running, cookie: string, ticker: string, side: 'buy' | 'sell', qty: number, clientOrderId = rid()) {
  return call(r, '/api/orders', { method: 'POST', cookie, body: { account: 'career', ticker, side, qty, clientOrderId } });
}
async function cashOf(r: Running, cookie: string): Promise<number> {
  return (await call(r, '/api/account?account=career', { cookie })).json.cashCents as number;
}
async function sharesOf(r: Running, cookie: string, ticker: string): Promise<number> {
  const acc = (await call(r, '/api/account?account=career', { cookie })).json;
  return (acc.positions.find((p: { ticker: string }) => p.ticker === ticker)?.shares as number | undefined) ?? 0;
}
/** Buys as many shares as the player's cash allows (the estimate knows, price impact included). */
async function buyAll(r: Running, cookie: string, ticker: string) {
  const est = await call(r, `/api/market/${ticker}/estimate?side=buy&qty=1000000&account=career`, { cookie });
  expect(est.status).toBe(200);
  const qty = est.json.maxQty as number;
  expect(qty).toBeGreaterThan(0);
  const res = await order(r, cookie, ticker, 'buy', qty);
  expect(res.status).toBe(201);
  return qty;
}

/** Two identical worlds: same seed, same clock, a player called alice in both, 100 seconds of market. */
async function twin(levelA: Strength, levelB: Strength) {
  const a = await boot({ flow: levelA });
  const b = await boot({ flow: levelB });
  const ca = await signUp(a, 'alice');
  const cb = await signUp(b, 'alice');
  advance(a, 100);
  advance(b, 100);
  expect(a.app.services.world.sim.tick).toBe(b.app.services.world.sim.tick);
  expect(allPrices(a)).toEqual(allPrices(b));
  return { a, b, ca, cb };
}

describe('the push model (pure)', () => {
  const catalog = buildCatalog(12, () => 0);
  const company = (ticker: string) => catalog.find((c) => c.ticker === ticker) as (typeof catalog)[number];

  it('FLOW-1: a push has the sign of the pressure, grows with the square root of it, and is zero without a gain', () => {
    const c = company('HLQN');
    expect(pushOf(c, 100, 1)).toBeGreaterThan(0);
    expect(pushOf(c, -100, 1)).toBeLessThan(0);
    expect(pushOf(c, -100, 1)).toBeCloseTo(-pushOf(c, 100, 1), 12);
    expect(pushOf(c, 400, 1) / pushOf(c, 100, 1)).toBeCloseTo(2, 9);
    expect(pushOf(c, 100, 5) / pushOf(c, 100, 1)).toBeCloseTo(5, 9);
    expect(pushOf(c, 100, 0)).toBe(0);
    expect(pushOf(c, 0, 5)).toBe(0);
    // Pressure beyond a few whole books counts for no more.
    const cap = FLOW_MAX_BOOKS * bookDepth(c);
    expect(pushOf(c, cap * 10, 1)).toBeCloseTo(pushOf(c, cap, 1), 12);
  });

  it('FLOW-2: for the same money a thin small company moves much more than a big liquid one', () => {
    const dollars = 5_000;
    const push = (ticker: string): number => {
      const c = company(ticker);
      return pushOf(c, Math.floor((dollars * 100) / c.basePriceCents), 1);
    };
    expect(push('HLQN')).toBeGreaterThan(8 * push('NVRA'));
    expect(push('HLQN')).toBeGreaterThan(8 * push('SKVR'));
    expect(push('ZYRA')).toBeGreaterThan(push('PLNB'));
    // And a company that is more volatile moves more than a calm one with a similar book.
    expect(horizonSigma(company('HLQN'))).toBeGreaterThan(horizonSigma(company('NVRA')));
  });

  it('FLOW-3: pressure fades with a half-life of five minutes and is gone after a long time', () => {
    expect(FLOW_HALF_LIFE_TICKS).toBe(300);
    expect(fadePressure(1000, 0)).toBe(1000);
    expect(fadePressure(1000, 300)).toBeCloseTo(500, 6);
    expect(fadePressure(1000, 600)).toBeCloseTo(250, 6);
    expect(fadePressure(-1000, 300)).toBeCloseTo(-500, 6);
    expect(fadePressure(1000, 300 * 21)).toBe(0);
    expect(fadePressure(0, 100)).toBe(0);
  });

  it('FLOW-4: there is one strength, the size of the real market; a trader pays more than the price moves, and nothing can be chosen', () => {
    expect(FLOW_GAIN).toBe(1);
    expect(Object.keys(flowModule).filter((k) => /LEVEL/i.test(k))).toEqual([]); // no dial levels any more
    expect(FLOW_PAID_SHARE).toBeGreaterThan(FLOW_MOVE_SHARE); // the trader pays more than the price moves
    expect(FLOW_MAX_STEP).toBeLessThan(0.5);
    expect(FLOW_EVENT_TICKS).toBeGreaterThan(0);
  });
});

describe('what a trade does to the price', () => {
  it('FLOW-5: a buy lifts the price of that company only, compared with an identical world without the trade', async () => {
    const { a, b, ca } = await twin('wild', 'wild');
    const qty = await buyAll(a, ca, 'HLQN');
    expect(qty).toBeGreaterThan(5);
    const events = rows(a, 'SELECT * FROM flow_events');
    expect(events).toHaveLength(1);
    expect(events[0].total).toBeGreaterThan(0);
    expect(events[0].start_tick).toBeGreaterThan(a.app.services.world.sim.tick);
    advance(a, 40);
    advance(b, 40);
    const ratio = priceOf(a, 'HLQN') / priceOf(b, 'HLQN');
    expect(ratio).toBeGreaterThan(1.01);
    expect(ratio).toBeLessThan(1.15);
    // Nobody else's price changed.
    const pa = allPrices(a);
    const pb = allPrices(b);
    const w = a.app.services.world;
    const id = (w.companyByTicker('HLQN') as { id: number }).id;
    expect(pa.filter((_, i) => i !== id)).toEqual(pb.filter((_, i) => i !== id));
  }, LONG);

  it('FLOW-6: a sell pushes the price down', async () => {
    const { a, b, ca, cb } = await twin('wild', 'wild');
    await buyAll(a, ca, 'HLQN');
    await buyAll(b, cb, 'HLQN');
    advance(a, 120);
    advance(b, 120);
    expect(allPrices(a)).toEqual(allPrices(b));
    const held = await sharesOf(a, ca, 'HLQN');
    expect(held).toBeGreaterThan(5);
    expect((await order(a, ca, 'HLQN', 'sell', held)).status).toBe(201);
    advance(a, 40);
    advance(b, 40);
    expect(priceOf(a, 'HLQN') / priceOf(b, 'HLQN')).toBeLessThan(0.99);
  }, LONG);

  it('FLOW-7: the estimate tells how far an order will push the price, and the same dollars push a small company far more than a big one', async () => {
    const r = await boot({ flow: 'lively' });
    const cookie = await signUp(r, 'alice');
    advance(r, 100);
    const est = async (ticker: string, qty: number) => (await call(r, `/api/market/${ticker}/estimate?side=buy&qty=${qty}&account=career`, { cookie })).json;
    const small = await est('HLQN', 40); // about $1,000
    const big = await est('NVRA', 11); //   about $1,000
    expect(small.moveBps).toBeGreaterThan(10 * big.moveBps);
    expect(small.moveBps).toBeGreaterThan(5);
    expect(small.paidBps / small.moveBps).toBeCloseTo(FLOW_PAID_SHARE / FLOW_MOVE_SHARE, 0);
    // Four times the shares push about twice as hard (square-root law).
    const q1 = await est('HLQN', 25);
    const q4 = await est('HLQN', 100);
    expect(q4.moveBps / q1.moveBps).toBeGreaterThan(1.8);
    expect(q4.moveBps / q1.moveBps).toBeLessThan(2.2);
    // A sell is estimated as a push down.
    expect((await call(r, '/api/market/HLQN/estimate?side=sell&qty=1', { cookie })).status).toBe(200);
    // The trader pays for the push: the same order with no push at all is cheaper.
    const off = await boot({ flow: 'off' });
    const c2 = await signUp(off, 'alice');
    advance(off, 100);
    const plain = (await call(off, '/api/market/HLQN/estimate?side=buy&qty=100&account=career', { cookie: c2 })).json;
    expect(plain.moveBps).toBe(0);
    expect(plain.paidBps).toBe(0);
    expect(q4.totalCents).toBeGreaterThan(plain.totalCents);
    expect(q4.avgPrice).toBeGreaterThan(plain.avgPrice);
  }, LONG);

  it('FLOW-8: many small orders push exactly as much as one big order (the order of trades does not matter)', async () => {
    const r = await boot({ flow: 'wild' });
    await signUp(r, 'alice');
    advance(r, 100);
    const s = r.app.services;
    const w = s.world;
    const c = w.companyByTicker('ZYRA') as { id: number };
    const company = w.companies[c.id]!;
    const tick = w.sim.tick;
    let sum = 0;
    for (let i = 0; i < 10; i += 1) {
      const pv = s.flow!.preview(company, 'buy', 12, tick);
      sum += pv.push;
      s.flow!.record(9000 + i, company, pv, tick, tick + 10 + i, r.clock.now());
    }
    expect(sum).toBeCloseTo(pushOf(company, 120, 20), 9);
    expect(s.flow!.pressureAt(c.id, tick)).toBeCloseTo(120, 9);
    expect(s.flow!.pressureAt(c.id, tick + 300)).toBeCloseTo(60, 6);
  }, LONG);

  it('FLOW-9: repeating an order (same order id) pushes only once', async () => {
    const r = await boot({ flow: 'wild' });
    const cookie = await signUp(r, 'alice');
    advance(r, 100);
    const id = rid();
    expect((await order(r, cookie, 'ZYRA', 'buy', 10, id)).status).toBe(201);
    const second = await order(r, cookie, 'ZYRA', 'buy', 10, id);
    expect(second.status).toBe(200);
    expect(second.json.duplicate).toBe(true);
    expect(rows(r, 'SELECT * FROM flow_events')).toHaveLength(1);
    expect(rows(r, 'SELECT pressure FROM flow_state')[0].pressure).toBe(10);
  }, LONG);
});

describe('no money from your own push', () => {
  it('FLOW-10: buying and selling again later, at any delay, always does worse than the same trades with no pushes at all', async () => {
    for (const lag of [3, 40, 150, 700]) {
      const { a, b, ca, cb } = await twin('wild', 'off');
      const startA = await cashOf(a, ca);
      const startB = await cashOf(b, cb);
      expect(startA).toBe(startB);
      await buyAll(a, ca, 'HLQN');
      await buyAll(b, cb, 'HLQN');
      advance(a, lag);
      advance(b, lag);
      const heldA = await sharesOf(a, ca, 'HLQN');
      const heldB = await sharesOf(b, cb, 'HLQN');
      expect((await order(a, ca, 'HLQN', 'sell', heldA)).status).toBe(201);
      expect((await order(b, cb, 'HLQN', 'sell', heldB)).status).toBe(201);
      const profitA = (await cashOf(a, ca)) - startA;
      const profitB = (await cashOf(b, cb)) - startB;
      // Same prices in both worlds up to the push, so any extra profit could only come from pushing the price.
      expect(profitA).toBeLessThan(profitB);
    }
  }, LONG);

  it('FLOW-11: "max" is exact: that many shares can be bought and one more is refused with the same answer', async () => {
    const { a, b, ca, cb } = await twin('wild', 'wild');
    const est = await call(a, '/api/market/HLQN/estimate?side=buy&qty=1000000&account=career', { cookie: ca });
    const max = est.json.maxQty as number;
    expect(max).toBeGreaterThan(5);
    const tooMany = await order(b, cb, 'HLQN', 'buy', max + 1);
    expect(tooMany.status).toBe(400);
    expect(tooMany.json.error.code).toBe('insufficient_cash');
    expect(tooMany.json.error.details.maxQty).toBe(max);
    expect((await order(a, ca, 'HLQN', 'buy', max)).status).toBe(201);
    expect(await cashOf(a, ca)).toBeLessThan(3000); // less than one more share costs: the cash is used up
  }, LONG);
});

describe('restarts', () => {
  it('FLOW-12: a server that stops and restarts in the middle of a push, and trades again, has exactly the prices of one that never stopped', async () => {
    const clockA = new Clock();
    const clockC = new Clock();
    const a1 = await boot({ clock: clockA, flow: 'wild' });
    const c = await boot({ clock: clockC, flow: 'wild' });
    const ca = await signUp(a1, 'alice');
    const cc = await signUp(c, 'alice');
    advance(a1, 100);
    advance(c, 100);
    await buyAll(a1, ca, 'HLQN');
    await buyAll(c, cc, 'HLQN');
    advance(a1, 12); // the push is still being spread over its 30 ticks
    advance(c, 12);
    const dir = a1.dir;
    await stop(a1);
    clockA.advanceSeconds(10); // the server was away for a moment
    const a2 = await boot({ dir, clock: clockA, flow: 'wild' });
    catchUp(a2);
    advance(c, 10);
    expect(a2.app.services.world.sim.tick).toBe(c.app.services.world.sim.tick);
    const ca2 = await logIn(a2, 'alice');
    // Trade again after the restart: the saved pressure must be picked up where it was.
    for (const [r, cookie] of [[a2, ca2], [c, cc]] as [Running, string][]) {
      const held = await sharesOf(r, cookie, 'HLQN');
      expect(held).toBeGreaterThan(5);
      expect((await order(r, cookie, 'HLQN', 'sell', Math.floor(held / 2), 'after-restart-0001')).status).toBe(201);
    }
    advance(a2, 400);
    advance(c, 400);
    const wa = a2.app.services.world;
    const wc = c.app.services.world;
    expect(wa.sim.tick).toBe(wc.sim.tick);
    expect(allPrices(a2)).toEqual(allPrices(c));
    const id = (wa.companyByTicker('HLQN') as { id: number }).id;
    expect(wa.candles(id, 'c10', 200)).toEqual(wc.candles(id, 'c10', 200));
    expect(rows(a2, 'SELECT key, start_tick, total FROM flow_events ORDER BY id')).toEqual(rows(c, 'SELECT key, start_tick, total FROM flow_events ORDER BY id'));
    expect(rows(a2, 'SELECT * FROM flow_state')).toEqual(rows(c, 'SELECT * FROM flow_state'));
    expect(rows(a2, 'SELECT * FROM flow_events')).toHaveLength(2);
  }, LONG);

  it('FLOW-13: the database upgrade keeps the admin log and adds the price-push tables', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tq-flow-mig-'));
    dirs.push(dir);
    const db = new Db(join(dir, 'old.sqlite'));
    try {
      for (const m of MIGRATIONS.filter((x) => x.version <= 5)) {
        db.exec(m.sql);
        db.exec(`PRAGMA user_version = ${m.version}`);
      }
      db.run("INSERT INTO users(id, username, display_name, pw_hash, role, created_ms) VALUES (1, 'boss', 'boss', 'x', 'owner', 1)");
      db.run("INSERT INTO admin_log(request_id, created_ms, admin_user_id, action, target, detail_json) VALUES ('old-request-01', 5, 1, 'halt', 'QLRX', '{}')");
      // Version 6 adds the price-push tables; version 7 (owner tools) rebuilds admin_log, so the old row must come through both.
      // Versions 8 to 12 (companies made by the owner, automatic trading pauses, leverage, memecoins with short selling and stops) only add tables and columns and follow at once.
      expect(migrate(db).filter((v) => v <= 18)).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]); // (later versions follow in the same go)
      expect(db.all('SELECT request_id, action FROM admin_log')).toEqual([{ request_id: 'old-request-01', action: 'halt' }]);
      db.run("INSERT INTO admin_log(request_id, created_ms, admin_user_id, action, target, detail_json) VALUES ('new-request-01', 6, 1, 'flow', 'price impact', '{}')");
      expect(db.all('SELECT count(*) AS n FROM admin_log')).toEqual([{ n: 2 }]);
      expect(db.all('SELECT count(*) AS n FROM flow_events')).toEqual([{ n: 0 }]);
      expect(db.all('SELECT count(*) AS n FROM flow_state')).toEqual([{ n: 0 }]);
    } finally {
      db.close();
    }
  });
});

describe('who moves prices, and how strongly', () => {
  it('FLOW-14: a 1v1 match account never moves the price and pays no extra; the same order from a Career account does', async () => {
    const r = await boot({ flow: 'wild' });
    const cookie = await signUp(r, 'alice');
    advance(r, 100);
    const s = r.app.services;
    s.trading.setGate(null); // this test is about the price, not about whether a match is running
    const userId = (rows(r, "SELECT id FROM users WHERE username = 'alice'")[0] as { id: number }).id;
    const match = s.trading.createMatchAccount(userId, 999, 5_000_00);
    const company = s.world.companyByTicker('HLQN')!;
    const career = s.trading.careerAccountOf(userId);
    const asMatch = s.trading.estimate(match.id, company.id, 'buy', 30);
    const asCareer = s.trading.estimate(career.id, company.id, 'buy', 30);
    expect(asMatch.flow.paid).toBe(0);
    expect(asMatch.flow.move).toBe(0);
    expect(asCareer.flow.paid).toBeGreaterThan(0);
    expect(asMatch.totalCents).toBeLessThan(asCareer.totalCents);
    const done = s.trading.placeOrder({ accountId: match.id, clientOrderId: 'match-order-0001', companyId: company.id, side: 'buy', qty: 30 });
    expect(done.trade.filled).toBe(30);
    expect(done.trade.totalCents).toBe(asMatch.totalCents);
    expect(rows(r, 'SELECT * FROM flow_events')).toHaveLength(0);
    expect(rows(r, 'SELECT * FROM flow_state')).toHaveLength(0);
    expect((await order(r, cookie, 'HLQN', 'buy', 30)).status).toBe(201);
    expect(rows(r, 'SELECT * FROM flow_events')).toHaveLength(1);
  }, LONG);

  it('FLOW-15: there is no dial: without any setting the game pushes with the one fixed strength, nobody can change it, and an old setting in the database is ignored', async () => {
    const r = await boot({ flow: 'game' });
    const boss = await signUp(r, 'boss');
    const alice = await signUp(r, 'alice');
    advance(r, 100);
    expect(FLOW_GAIN).toBe(1);
    expect(await call(r, '/api/admin/state', { cookie: boss }).then((x) => x.json)).not.toHaveProperty('flow');
    for (const cookie of [boss, alice, undefined]) {
      expect((await call(r, '/api/admin/flow', { method: 'POST', cookie, body: { requestId: rid(), level: 'wild' } })).status).toBe(404);
    }

    // A database made by an older version may hold a dial value; it changes nothing.
    r.app.services.db.run("INSERT INTO meta(key, value) VALUES ('flow_level', 'off') ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    const company = r.app.services.world.companyByTicker('HLQN')!;
    const est = (await call(r, '/api/market/HLQN/estimate?side=buy&qty=30&account=career', { cookie: alice })).json;
    const expected = FLOW_MOVE_SHARE * pushOf(company, 30, FLOW_GAIN) * 10_000;
    expect(expected).toBeGreaterThan(0);
    expect(est.moveBps).toBeCloseTo(expected, 0);
    expect((await order(r, alice, 'HLQN', 'buy', 30)).status).toBe(201);
    expect(rows(r, 'SELECT * FROM flow_events')).toHaveLength(1);
    expect(rows(r, "SELECT * FROM admin_log WHERE action = 'flow'")).toHaveLength(0);
  }, LONG);
});
