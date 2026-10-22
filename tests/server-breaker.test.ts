// Automatic trading pauses ("circuit breaker"): when a company's price has moved 10 % within 5 minutes, trading in it stops for
// 5 minutes. The rules checked here: exactly where the line is (9.9 % no, 10 % yes, up or down, slow drifts no); the window slides;
// the pause ends by itself after 5 minutes and the 5-minute clock then starts afresh; the owner's own price moves, owner halts and
// "pause everything" never trigger it; replaying the past after downtime never makes a pause; a pause survives a restart; orders
// are refused with a clear message while it lasts and a company that is not paused trades as usual; the owner can resume early.
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../server/app';
import { BREAKER_PAUSE_TICKS, BREAKER_WINDOW_TICKS, CircuitBreaker, bandOf, type BreakerWorld } from '../server/breaker';
import { loadConfig } from '../server/config';
import { Halts } from '../server/halts';
import { Logger } from '../server/log';
import { migrate } from '../server/schema';
import { Db } from '../server/sqlite';
import type { WorldEvent } from '../src/world';
import { Clock } from './helpers/server';

const LONG = 240_000;

// ---- the rule itself, with a made-up market -----------------------------------------------------------------------------------

class FakeWorld implements BreakerWorld {
  sim = { P: new Float64Array([10_000, 20_000]), isListed: (_i: number): boolean => this.listed };
  effects = { hasActive: (id: number, prefix: string): boolean => prefix === 'admin:' && this.admin.has(id) };
  companies = [{ ticker: 'AAA', tier: 'large' }, { ticker: 'BBB', tier: 'micro' }];
  listed = true;
  admin = new Set<number>();
  clock = 0;
  currentTick(): number {
    return this.clock;
  }
}

function unit(tier = 'large') {
  const db = new Db(':memory:');
  migrate(db);
  const world = new FakeWorld();
  world.companies = [{ ticker: 'AAA', tier }, { ticker: 'BBB', tier: 'micro' }];
  const halts = new Halts(db);
  let tick = 0;
  halts.setClock(() => tick);
  const breaker = new CircuitBreaker({ world, halts, log: new Logger({ sink: null }) });
  /** Runs the market from `from` to `to` (inclusive); `price(t)` is company AAA's price at tick t. The clock is "now" at every tick. */
  const run = (from: number, to: number, price: (t: number) => number, live = true): void => {
    for (let t = from; t <= to; t += 1) {
      tick = t;
      world.clock = live ? t : to + 10_000;
      world.sim.P[0] = price(t);
      breaker.step(t);
    }
  };
  return { db, world, halts, breaker, run, at: (t: number) => { tick = t; } };
}
const ramp = (start: number, end: number, t0: number, t1: number) => (t: number): number => (t <= t0 ? start : t >= t1 ? end : Math.round(start + ((end - start) * (t - t0)) / (t1 - t0)));

describe('Automatic trading pauses: the rule', () => {
  it('BRK-1: exactly 10 % within 5 minutes pauses, 9.9 % does not, up and down; a slow drift does not', () => {
    const cases: [string, number, boolean][] = [
      ['up 9.9 %', 10_990, false],
      ['up 10 %', 11_000, true],
      ['down 9.99 %', 9_001, false],
      ['down 10 %', 9_000, true],
      ['up 50 %', 15_000, true],
      ['down 60 %', 4_000, true],
    ];
    for (const [name, end, expected] of cases) {
      const u = unit();
      u.run(0, 300, ramp(10_000, end, 0, 300));
      const p = u.halts.list().length + u.halts.autoList().length;
      expect(`${name}: ${p > 0}`).toBe(`${name}: ${expected}`);
      if (expected) {
        const a = u.halts.autoList()[0];
        expect(a?.companyId).toBe(0);
        expect(Math.sign(a?.moveBps ?? 0)).toBe(Math.sign(end - 10_000));
        expect((a?.untilTick ?? 0) - (a?.sinceTick ?? 0)).toBe(BREAKER_PAUSE_TICKS);
        expect((a?.sinceTick ?? 1) % 5).toBe(0); // the price is only looked at every 5 seconds
      }
    }
    // The other company (BBB, flat) is never touched.
    const u = unit();
    u.run(0, 300, ramp(10_000, 30_000, 0, 300));
    expect(u.halts.autoList().map((x) => x.companyId)).toEqual([0]);
    // A drift of 1 % a minute is 5 % in 5 minutes: never a pause, however long it goes on (the price doubles in 70 minutes).
    const slow = unit();
    slow.run(0, 4_200, (t) => Math.round(10_000 * 1.01 ** (t / 60)));
    expect(slow.halts.autoList()).toEqual([]);
    expect(slow.db.all('SELECT * FROM auto_pauses')).toEqual([]);
    // A drift of 3 % a minute is more than 10 % in 5 minutes: it pauses.
    const fast = unit();
    fast.run(0, 300, (t) => Math.round(10_000 * 1.03 ** (t / 60)));
    expect(fast.halts.autoList().length).toBe(1);
  });

  it('BRK-1b: the line depends on the size of the company, as on real exchanges: 10 % large, 15 % mid, 30 % small, 45 % micro', () => {
    const bands: [string, number][] = [['mega', 0.1], ['large', 0.1], ['mid', 0.15], ['small', 0.3], ['micro', 0.45]];
    for (const [tier, band] of bands) {
      expect(bandOf(tier)).toBe(band);
      const justUnder = unit(tier);
      justUnder.run(0, 300, ramp(10_000, Math.round(10_000 * (1 + band)) - 1, 0, 300));
      expect(`${tier} just under: ${justUnder.halts.autoList().length}`).toBe(`${tier} just under: 0`);
      const atBand = unit(tier);
      atBand.run(0, 300, ramp(10_000, Math.round(10_000 * (1 + band)), 0, 300));
      expect(`${tier} at the band: ${atBand.halts.autoList().length}`).toBe(`${tier} at the band: 1`);
      const down = unit(tier);
      down.run(0, 300, ramp(10_000, Math.round(10_000 * (1 - band)), 0, 300));
      expect(`${tier} falling by the band: ${down.halts.autoList().length}`).toBe(`${tier} falling by the band: 1`);
    }
    expect(bandOf('something-else')).toBe(0.1);
    // The same 20 % jump: a large company is stopped, a micro-cap's usual wobble is left alone.
    const large = unit('large');
    large.run(0, 120, (t) => (t < 100 ? 10_000 : 12_000));
    const micro = unit('micro');
    micro.run(0, 120, (t) => (t < 100 ? 10_000 : 12_000));
    expect([large.halts.autoList().length, micro.halts.autoList().length]).toEqual([1, 0]);
  });

  it('BRK-2: only the last 5 minutes count: an old rise slides out of the window', () => {
    // +9 % at tick 400, then +2 % at tick 700: 11.2 % in all, but the first rise is more than 5 minutes old by then.
    const u = unit();
    u.run(0, 900, (t) => (t < 400 ? 10_000 : t < 700 ? 10_900 : 11_118));
    expect(u.halts.autoList()).toEqual([]);
    expect(u.db.all('SELECT * FROM auto_pauses')).toEqual([]);
    // The same two steps only 100 ticks apart are 11.2 % within 5 minutes: paused.
    const v = unit();
    v.run(0, 520, (t) => (t < 400 ? 10_000 : t < 500 ? 10_900 : 11_118));
    expect(v.halts.autoList().length).toBe(1);
  });

  it('BRK-3: the pause lasts 5 minutes, then reopens by itself, and the 5-minute clock starts afresh', () => {
    const u = unit();
    u.run(0, 100, ramp(10_000, 10_000, 0, 1));
    u.run(101, 125, (t) => (t < 105 ? 10_000 : 14_000)); // a 40 % jump at tick 105
    const first = u.halts.autoList()[0];
    expect(first).toBeDefined();
    const until = first?.untilTick ?? 0;
    expect(until - (first?.sinceTick ?? 0)).toBe(BREAKER_PAUSE_TICKS);
    expect(u.halts.isHalted(0)).toBe(true);
    // It keeps moving while paused (another +20 %), but trading stays stopped until the 5 minutes are up.
    u.run(126, until - 1, ramp(14_000, 16_800, 126, until - 1));
    expect(u.halts.autoPauseOf(0)).not.toBeNull();
    u.run(until, until, () => 16_800);
    expect(u.halts.autoPauseOf(0)).toBeNull();
    expect(u.halts.isHalted(0)).toBe(false);
    expect(u.db.all('SELECT * FROM auto_pauses')).toEqual([]); // the row is gone once it has run out
    // It reopens at its current price; that earlier move does not count again: 4 more minutes of calm do not re-pause it.
    u.run(until + 1, until + 240, () => 16_800);
    expect(u.halts.autoList()).toEqual([]);
    // But a new 10 % move after reopening pauses it again.
    u.run(until + 241, until + 300, (t) => (t < until + 250 ? 16_800 : 19_000));
    expect(u.halts.autoList().length).toBe(1);
  });

  it('BRK-4: the owner\'s own price moves never trigger a pause; neither do owner halts or "pause everything"', () => {
    // A pump (an "admin:" event is running for company 0) from tick 100 to 400: nothing is watched while it lasts.
    const u = unit();
    u.run(0, 99, () => 10_000);
    u.world.admin.add(0);
    u.run(100, 400, ramp(10_000, 60_000, 100, 400));
    expect(u.halts.autoList()).toEqual([]);
    u.world.admin.delete(0);
    // After it, the watching starts from the new price: calm trading at $600 is fine...
    u.run(401, 900, () => 60_000);
    expect(u.halts.autoList()).toEqual([]);
    // ...and a big move after that is not the owner's doing, so it pauses.
    u.run(901, 960, (t) => (t < 910 ? 60_000 : 48_000));
    expect(u.halts.autoList().length).toBe(1);

    // The same jump with no owner event running pauses at once (so the check above really was about the owner).
    const n = unit();
    n.run(0, 120, (t) => (t < 100 ? 10_000 : 15_000));
    expect(n.halts.autoList().length).toBe(1);

    // "Pause everything" is on: nothing is watched.
    const p = unit();
    p.halts.setPaused({ reason: 'maintenance', sinceMs: 0 });
    p.run(0, 120, (t) => (t < 100 ? 10_000 : 15_000));
    expect(p.halts.autoList()).toEqual([]);
  });

  it('BRK-5: replaying the past (the market catching up after the server was off) never makes a pause; a company not yet listed is not watched', () => {
    const u = unit();
    u.run(0, 120, (t) => (t < 100 ? 10_000 : 15_000), false); // the clock is 10,000 ticks ahead: this is all history
    expect(u.halts.autoList()).toEqual([]);
    expect(u.db.all('SELECT * FROM auto_pauses')).toEqual([]);
    const w = unit();
    w.world.listed = false;
    w.run(0, 120, (t) => (t < 100 ? 10_000 : 15_000));
    expect(w.halts.autoList()).toEqual([]);
  });

  it('BRK-6: a pause is saved: a new Halts on the same database still knows it, until it runs out', () => {
    const u = unit();
    u.run(0, 120, (t) => (t < 100 ? 10_000 : 15_000));
    const before = u.halts.autoList()[0];
    expect(before).toBeDefined();
    const again = new Halts(u.db); // what a server restart does
    again.setClock(() => (before?.sinceTick ?? 0) + 100);
    expect(again.autoPauseOf(0)).toEqual(before);
    expect(again.isHalted(0)).toBe(true);
    expect(again.isHalted(1)).toBe(false);
    again.setClock(() => before?.untilTick ?? 0);
    expect(again.autoPauseOf(0)).toBeNull();
    expect(again.isHalted(0)).toBe(false);
    expect(BREAKER_WINDOW_TICKS).toBe(300);
    expect(BREAKER_PAUSE_TICKS).toBe(300);
  });
});

// ---- inside the real server ---------------------------------------------------------------------------------------------------------

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

async function boot(options: { dir?: string; clock?: Clock; flow?: number; autoPauses?: boolean } = {}): Promise<Running> {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'tq-brk-'));
  if (!options.dir) dirs.push(dir);
  const clock = options.clock ?? new Clock();
  const config = loadConfig({ TQ_DATA_DIR: dir, TQ_COMPANIES: '66', TQ_WARMUP_DAYS: '1', TQ_PORT: '8787', TQ_OWNER: 'boss' });
  const app = createApp({ config, log: new Logger({ sink: null, now: clock.now }), worldSeed: 777, now: clock.now, flowGain: options.flow ?? 0, autoPauses: options.autoPauses });
  const server = createServer(app.handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const r = { app, server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, dir, clock };
  running.push(r);
  return r;
}

async function restart(r: Running): Promise<Running> {
  await stop(r);
  running.splice(running.indexOf(r), 1);
  return boot({ dir: r.dir, clock: r.clock, flow: WHALE_GAIN });
}

function advance(r: Running, seconds: number): void {
  r.clock.advanceSeconds(seconds);
  const w = r.app.services.world;
  for (let i = 0; i < 400_000 && w.sim.tick < w.currentTick(); i += 1) w.pump();
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

async function signUp(r: Running, name: string): Promise<string> {
  const res = await fetch(r.base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: name, password: 'a-good-password' }) });
  expect(res.status).toBe(201);
  return (res.headers.get('set-cookie') ?? '').split(';')[0] as string;
}

let counter = 0;
const rid = (): string => `req-${(counter += 1).toString().padStart(8, '0')}`;
const post = (r: Running, path: string, cookie: string | undefined, body: Record<string, unknown>) => call(r, path, { method: 'POST', cookie, body: { requestId: rid(), ...body } });
let orderNo = 0;
const trade = (r: Running, cookie: string, body: Record<string, unknown> = {}) =>
  call(r, '/api/orders', { method: 'POST', cookie, body: { account: 'career', ticker: 'ZRLX', side: 'buy', qty: 10, clientOrderId: `order-${(orderNo += 1)}-abcdef`, ...body } });
const market = async (r: Running) => (await call(r, '/api/market')).json.companies as any[];
const rowOf = async (r: Running, ticker: string) => (await market(r)).find((c) => c.ticker === ticker);
const pausesIn = (r: Running) => r.app.services.db.all('SELECT * FROM auto_pauses') as { company_id: number; since_tick: number; until_tick: number; move_bps: number }[];

const ZRLX = { name: 'Zorlex Robotics', ticker: 'ZRLX', sector: 'robotics', tier: 'large', personality: 'growth', priceCents: 1250 };

/**
 * The game's own pushes are the size of the real market, which no player can use to move a large company by 10 % (that is the point). To test
 * what happens when a whale does, these tests make every push 500 times as strong (the test-only option flowGain).
 */
const WHALE_GAIN = 500;

/** A running market with a large stock that players can push around (very strong pushes, see WHALE_GAIN), a trader with shares and the owner. */
async function whaleWorld(autoPauses = true) {
  const r = await boot({ flow: WHALE_GAIN, autoPauses });
  const alice = await signUp(r, 'alice');
  const boss = await signUp(r, 'boss');
  expect((await post(r, '/api/admin/stock', boss, ZRLX)).status).toBe(200);
  advance(r, 120);
  expect((await post(r, '/api/admin/shares', boss, { username: 'alice', ticker: 'ZRLX', qty: 100_000 })).status).toBe(200);
  return { r, alice, boss };
}

describe('Automatic trading pauses: in the server', () => {
  it('BRK-7: a player who pushes a thin stock down by 10 % is stopped for 5 minutes, with a clear message, and then trading reopens by itself', async () => {
    const { r, alice, boss } = await whaleWorld();
    const start = (await rowOf(r, 'ZRLX')).price as number;
    // Sell a little at a time (500 shares every 15 seconds) until the market steps in (a large company: 10 %).
    let refused: { status: number; json: any } | null = null;
    let sold = 0;
    for (let i = 0; i < 40 && refused === null; i += 1) {
      const res = await trade(r, alice, { side: 'sell', qty: 500 });
      if (res.status === 403) refused = res;
      else {
        expect(res.status).toBe(201);
        sold += 500;
        advance(r, 15);
      }
    }
    expect(refused).not.toBeNull();
    expect(sold).toBeGreaterThan(0);
    expect(refused?.json.error.code).toBe('halted');
    expect(refused?.json.error.details.auto).toBe(true);
    expect(refused?.json.error.details.moveBps).toBeLessThanOrEqual(-1000);
    expect(refused?.json.error.details.reopensInTicks).toBeGreaterThan(0);
    expect(refused?.json.error.details.reopensInTicks).toBeLessThanOrEqual(BREAKER_PAUSE_TICKS);
    expect(refused?.json.error.message).toMatch(/Trading in ZRLX is paused automatically: the price fell [\d.]+% within 5 minutes; reopens in about \d minutes?\. Nothing was bought or sold\./);
    const paused = await rowOf(r, 'ZRLX');
    expect(paused.halted).toBe(true);
    expect(paused.autoPause.moveBps).toBeLessThanOrEqual(-1000);
    expect(paused.price).toBeLessThan(start * 0.95); // it really did fall a lot
    expect(pausesIn(r).length).toBe(1);

    // Everything for this company is refused (buys, sells, the estimate); other companies are not affected.
    expect((await trade(r, alice, { side: 'buy', qty: 1 })).status).toBe(403);
    expect((await call(r, '/api/market/ZRLX/estimate?side=sell&qty=1&account=career')).status).toBe(403);
    const cheap = (await market(r)).filter((c) => c.trading && !c.halted && c.ticker !== 'ZRLX').sort((a, b) => a.price - b.price)[0];
    expect((await trade(r, alice, { ticker: cheap.ticker, qty: 1 })).status).toBe(201);
    expect((await market(r)).filter((c) => c.halted).map((c) => c.ticker)).toEqual(['ZRLX']);
    // The owner sees it in the halted list, marked automatic.
    const state = (await call(r, '/api/admin/state', { cookie: boss })).json;
    expect(state.halts.map((h: any) => [h.ticker, h.auto])).toEqual([['ZRLX', true]]);
    expect(state.halts[0].reason).toMatch(/^paused automatically: the price fell/);

    // The price keeps moving while it is paused, and after 5 minutes trading reopens on its own.
    advance(r, 120);
    expect((await rowOf(r, 'ZRLX')).halted).toBe(true);
    advance(r, BREAKER_PAUSE_TICKS + 10);
    const reopened = await rowOf(r, 'ZRLX');
    expect(reopened.halted).toBe(false);
    expect(reopened.autoPause).toBeNull();
    expect(pausesIn(r).length).toBe(0);
    expect((await trade(r, alice, { side: 'sell', qty: 1 })).status).toBe(201);
  }, LONG);

  it('BRK-8: the owner can reopen a paused company at once (Resume), and it is written to the log; a restart in the middle keeps the pause', async () => {
    let { r, alice, boss } = await whaleWorld();
    let refused = false;
    for (let i = 0; i < 40 && !refused; i += 1) {
      const res = await trade(r, alice, { side: 'sell', qty: 500 });
      if (res.status === 403) refused = true;
      else advance(r, 15);
    }
    expect(refused).toBe(true);
    const before = pausesIn(r)[0];
    expect(before).toBeDefined();

    // A restart (the server is stopped and started again 20 seconds later) does not forget the pause.
    advance(r, 20);
    r = await restart(r);
    advance(r, 5);
    const after = pausesIn(r)[0];
    expect(after).toEqual(before);
    expect((await rowOf(r, 'ZRLX')).halted).toBe(true);
    alice = await (async () => {
      const res = await fetch(r.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'alice', password: 'a-good-password' }) });
      return (res.headers.get('set-cookie') ?? '').split(';')[0] as string;
    })();
    boss = await (async () => {
      const res = await fetch(r.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'boss', password: 'a-good-password' }) });
      return (res.headers.get('set-cookie') ?? '').split(';')[0] as string;
    })();
    expect((await trade(r, alice, { side: 'sell', qty: 1 })).status).toBe(403);

    // The owner reopens it: orders work again, the row is gone, the log says so.
    const resume = await post(r, '/api/admin/halt', boss, { ticker: 'ZRLX', halted: false });
    expect(resume.status).toBe(200);
    expect(pausesIn(r).length).toBe(0);
    expect((await rowOf(r, 'ZRLX')).halted).toBe(false);
    expect((await trade(r, alice, { side: 'sell', qty: 1 })).status).toBe(201);
    expect(r.app.services.db.all("SELECT target FROM admin_log WHERE action = 'resume'").length).toBe(1);
  }, LONG);

  it('BRK-9: the owner\'s own pumps and crashes never pause a company, however big', async () => {
    const r = await boot({ flow: 5 });
    const alice = await signUp(r, 'alice');
    const boss = await signUp(r, 'boss');
    advance(r, 60);
    // A large company (the narrowest band: 10 %), so that a pause would have been easiest to trigger.
    const cheap = (await market(r)).filter((c) => c.trading && c.tier === 'large').sort((a, b) => a.price - b.price)[0];
    const cheapId = cheap.id as number;
    expect((await post(r, '/api/admin/cash', boss, { username: 'alice', amountCents: 500_000 })).status).toBe(200);
    for (const [percent, style] of [[900, 'pump'], [-80, 'crash']] as const) {
      expect((await post(r, '/api/admin/shock', boss, { ticker: cheap.ticker, percent, style, speed: 'fast' })).status).toBe(200);
      for (let i = 0; i < 12; i += 1) {
        advance(r, 30);
        expect(`${style} after ${(i + 1) * 30} s: ${(await rowOf(r, cheap.ticker)).halted}`).toBe(`${style} after ${(i + 1) * 30} s: false`);
      }
      expect((await trade(r, alice, { ticker: cheap.ticker, qty: 1 })).status).toBe(201);
    }
    expect(pausesIn(r).filter((p) => p.company_id === cheapId)).toEqual([]);
  }, LONG);

  it('BRK-10: a company\'s own news is not the owner\'s doing: a big story moves it and the market pauses it; with the switch off nothing ever pauses', async () => {
    for (const on of [true, false]) {
      const r = await boot({ flow: 0, autoPauses: on });
      const w = r.app.services.world;
      advance(r, 60);
      const target = (await market(r)).filter((c) => c.trading && c.tier === 'large').sort((a, b) => a.price - b.price)[0];
      const id = (await call(r, `/api/market/${target.ticker}`)).json.id as number;
      const ev: WorldEvent = {
        key: `test:crash:${on}`,
        kind: 'ordinary',
        scope: 'company',
        companyId: id,
        partnerId: null,
        sector: null,
        publishTick: w.sim.tick + 5,
        startTick: w.sim.tick + 5,
        durationTicks: 40,
        shape: 'burst',
        realized: -0.4,
        permShare: 1,
      };
      w.addEvents([ev]);
      advance(r, 150);
      const row = await rowOf(r, target.ticker);
      expect(row.price).toBeLessThan(target.price * 0.8);
      expect(`switch ${on ? 'on' : 'off'}: ${row.halted}`).toBe(`switch ${on ? 'on' : 'off'}: ${on}`);
      if (on) {
        expect(row.autoPause.moveBps).toBeLessThanOrEqual(-1000);
        expect(pausesIn(r).filter((p) => p.company_id === id).length).toBe(1);
      } else {
        expect(pausesIn(r)).toEqual([]);
      }
      await stop(r);
      running.splice(running.indexOf(r), 1);
    }
  }, LONG);

  it('BRK-11: the pause table exists from schema 10 and is empty at first', () => {
    const db = new Db(':memory:');
    expect(migrate(db).filter((v) => v <= 15).slice(-5)).toEqual([11, 12, 13, 14, 15]); // (later versions follow in the same go)
    expect((db.get('SELECT COUNT(*) AS n FROM auto_pauses') as { n: number }).n).toBe(0);
  });
});
