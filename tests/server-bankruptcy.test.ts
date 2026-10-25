// Companies that can fail (server/bankruptcy.ts, docs/world.md §18.2). Checked: the rule (a weak small company with a pile of bad news fails, one with
// less news or a good share of good news does not, and a company of any other kind never does), that it is rare and deterministic (the dice are a
// fixed function, one failure a day and three days apart), the failure itself (a story, a row, the price crashes and stops for good, a restart finds
// the same), and what players can do afterwards (no new buy, short or waiting order; the holder can still sell and the short can still cover at the
// price it stopped at, a holder loses nearly everything and a short makes money, positions say "bankrupt").
//
// The world is built once (eight days of history take a while); every test uses a company of its own, and the table of failures is emptied between tests
// so the "one every three days" rule of an earlier test does not leak into the next.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BANKRUPT_KEY, TICKS_PER_DAY, cycleOfTick, deathTickOf, type Company } from '../src/world';
import { Auth } from '../server/auth';
import {
  BANKRUPT_SLOT,
  Bankruptcies,
  CRASH_MULTIPLIER,
  CRASH_TICKS,
  FAILING_PERSONALITIES,
  FIRST_FAILING_ID,
  FAILING_TIERS,
  FAIL_CHANCE,
  GAP_DAYS,
  MIN_NEGATIVE,
  SUM_LIMIT,
  WINDOW_DAYS,
  rollOf,
} from '../server/bankruptcy';
import { LimitOrders } from '../server/limitOrders';
import { NewsService } from '../server/news/service';
import type { Db } from '../server/sqlite';
import { OrderError, Trading } from '../server/trading';
import { MarketViews } from '../server/world/views';
import type { WorldRuntime } from '../server/world/runtime';
import { makeRig, type Rig } from './helpers/server';

const LONG = 240_000;

let rig: Rig;
let db: Db;
let world: WorldRuntime;
let news: NewsService;
let weak: Company[] = [];
/** The i-th weak small company (every test uses companies of its own). */
const co = (i: number): Company => weak[i] as Company;

const newsBuilder = (r: Rig) => (d: Db) => new NewsService({ db: d, log: r.log, now: r.clock.now });

beforeAll(() => {
  rig = makeRig();
  const opened = rig.open({ companyCount: 66, warmupDays: 8, memecoins: true, news: newsBuilder(rig) });
  db = opened.db;
  world = opened.world;
  news = opened.news as NewsService;
  weak = world.companies.filter((c) => c.id >= FIRST_FAILING_ID && c.sector !== 'meme' && FAILING_TIERS.includes(c.tier) && FAILING_PERSONALITIES.includes(c.personality));
}, LONG);

afterAll(() => {
  rig?.cleanup();
});

beforeEach(() => {
  db.run('DELETE FROM bankruptcies');
  // A clean slate of news for the days the rule reads: only what a test puts there counts (the stories the world made on its own could, by chance, pile up too).
  db.run("DELETE FROM news_items WHERE source = 'generator' AND scope IN ('company', 'company+partner') AND company_id IS NOT NULL AND cycle >= ? AND cycle < ?", cycleOfTick(world.sim.tick) - WINDOW_DAYS - 1, cycleOfTick(world.sim.tick));
  db.run("DELETE FROM news_items WHERE key LIKE 'pile:%'");
});

/** Puts exactly this news in the days before today for a company: `bad` bad stories (each moving it `each`) and `good` good ones (each moving it `up`). */
function pile(companyId: number, bad: number, each = -0.03, good = 0, up = 0.03): void {
  const cycle = cycleOfTick(world.sim.tick);
  let n = 0;
  const add = (direction: 'negative' | 'positive', realized: number): void => {
    const k = n % WINDOW_DAYS;
    n += 1;
    const c = cycle - 1 - k; // spread over the five days before today
    const publish = c * TICKS_PER_DAY + 1000 + n;
    db.run(
      `INSERT INTO news_items(key, company_id, partner_id, sector, scope, kind, category, cycle, slot, publish_tick, start_tick, end_tick, duration_ticks, shape, immediacy, direction, strength, realized, perm_share, credibility, headline, body, breaking, source, created_ms)
       VALUES (?, ?, NULL, NULL, 'company', 'company', 'test', ?, 1, ?, ?, ?, 10, 'burst', 'immediate', ?, 'minor', ?, 0.3, NULL, 'test', 'test', 0, 'generator', 0)`,
      `pile:${companyId}:${cycle}:${n}`,
      companyId,
      c,
      publish,
      publish + 1,
      publish + 11,
      direction,
      realized,
    );
  };
  for (let i = 0; i < bad; i += 1) add('negative', each);
  for (let i = 0; i < good; i += 1) add('positive', up);
}

function bank(chance = 1): Bankruptcies {
  return new Bankruptcies({ db, world, news, log: rig.log, now: rig.clock.now, chance });
}

/** Lets the clock run so the world plays the seconds in between. */
function advance(seconds: number): void {
  rig.clock.advanceSeconds(seconds);
  world.advanceTo(world.currentTick(), Infinity);
}

const row = (companyId: number) => db.get<{ company_id: number; negative_stories: number; window_total: number; price_before_cents: number }>('SELECT * FROM bankruptcies WHERE company_id = ?', companyId);

describe('The rule', () => {
  it('BANK-1: there are weak small companies in the market to fail, and the numbers are the ones in the plan', () => {
    expect(weak.length).toBeGreaterThanOrEqual(12);
    for (const c of weak) {
      expect(['micro', 'small']).toContain(c.tier);
      expect(['declining', 'turnaround', 'volatile']).toContain(c.personality);
      expect(c.id).toBeGreaterThanOrEqual(10);
    }
    expect([WINDOW_DAYS, MIN_NEGATIVE, SUM_LIMIT, FAIL_CHANCE, GAP_DAYS, CRASH_MULTIPLIER, CRASH_TICKS, BANKRUPT_SLOT]).toEqual([5, 9, -0.18, 0.3, 3, 0.04, 6, 901]);
  });

  it('BANK-2: the dice are a fixed function of (world seed, company, day): same inputs, same number; about three in ten come under 0.3', () => {
    expect(rollOf(12345, 20, 9)).toBe(rollOf(12345, 20, 9));
    expect(rollOf(12345, 20, 9)).not.toBe(rollOf(12345, 21, 9));
    expect(rollOf(12345, 20, 9)).not.toBe(rollOf(12345, 20, 10));
    expect(rollOf(12345, 20, 9)).not.toBe(rollOf(54321, 20, 9));
    let under = 0;
    const n = 30_000;
    for (let i = 0; i < n; i += 1) {
      const r = rollOf(777, i % 66, Math.floor(i / 66));
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThan(1);
      if (r < FAIL_CHANCE) under += 1;
    }
    expect(under / n).toBeGreaterThan(0.28);
    expect(under / n).toBeLessThan(0.32);
  });

  it('BANK-3: a weak small company with a pile of bad news fails: a row, a story, the price crashes by more than 88 % and then never moves again', () => {
    const c = weak[0] as Company;
    pile(c.id, 10);
    const before = world.sim.price(c.id);
    const b = bank();
    const failed = b.step();
    expect(failed?.id).toBe(c.id);
    expect(b.isBankrupt(c.id)).toBe(true);
    expect(row(c.id)).toMatchObject({ company_id: c.id, negative_stories: 10 });
    expect(Math.abs((row(c.id)?.price_before_cents ?? 0) - before)).toBeLessThanOrEqual(1);
    expect(row(c.id)?.window_total).toBeCloseTo(-0.3, 6);
    const story = db.get<{ key: string; source: string; slot: number; direction: string; shape: string; headline: string; body: string; breaking: number }>(
      'SELECT key, source, slot, direction, shape, headline, body, breaking FROM news_items WHERE key = ?',
      `bankrupt:${c.id}:fail`,
    );
    expect(story).toMatchObject({ source: 'admin', slot: BANKRUPT_SLOT, direction: 'negative', shape: 'burst', breaking: 1 });
    expect(story?.headline).toContain(c.name);
    expect(story?.body).toContain(c.ticker);
    advance(40);
    const after = world.sim.price(c.id);
    expect(world.sim.isDead(c.id)).toBe(true);
    expect(after).toBeLessThan(before * 0.12);
    expect(after).toBeGreaterThan(0);
    advance(300);
    expect(world.sim.price(c.id)).toBe(after); // it never moves again
    // The story is the whole fact: the same key says the same death tick.
    const ev = news.deadEvents().find((e) => e.key === `bankrupt:${c.id}:fail`);
    expect(ev).toBeDefined();
    expect(deathTickOf(ev as NonNullable<typeof ev>)).toBe((ev as NonNullable<typeof ev>).startTick + CRASH_TICKS);
    expect(BANKRUPT_KEY.test(`bankrupt:${c.id}:fail`)).toBe(true);
  }, LONG);

  it('BANK-4: it needs the pile: 8 bad stories are not enough, 9 bad stories with good news that cancels them are not enough, and 9 that add up to the limit are enough', () => {
    const a = co(1);
    const b2 = co(2);
    const c = co(3);
    pile(a.id, MIN_NEGATIVE - 1, -0.05); // too few bad stories (even though they add up to -0.4)
    pile(b2.id, MIN_NEGATIVE, -0.03, 6, 0.03); // enough bad stories, but together they move it only -0.09
    expect(bank().step()).toBeNull();
    expect(row(a.id)).toBeUndefined();
    expect(row(b2.id)).toBeUndefined();
    pile(c.id, MIN_NEGATIVE, -0.0201); // exactly at the limits: 9 bad stories adding up to -0.18 or worse
    expect(bank().step()?.id).toBe(c.id);
  }, LONG);

  it('BANK-4b: with the real chance, a company that meets the rule fails on the days its fixed roll is under 0.3 and not on the others', () => {
    const seed = Number(db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'world_seed'")?.value);
    const cycle = cycleOfTick(world.sim.tick);
    const pool = weak.slice(4);
    const yes = pool.find((x) => rollOf(seed, x.id, cycle) < FAIL_CHANCE) as Company;
    const no = pool.find((x) => rollOf(seed, x.id, cycle) >= FAIL_CHANCE) as Company;
    expect(yes).toBeDefined();
    expect(no).toBeDefined();
    pile(no.id, 14);
    expect(bank(FAIL_CHANCE).step()).toBeNull(); // the dice said no
    expect(row(no.id)).toBeUndefined();
    pile(yes.id, 14);
    expect(bank(FAIL_CHANCE).step()?.id).toBe(yes.id); // the dice said yes for this one, and the other did not get in the way
    expect(row(no.id)).toBeUndefined();
  }, LONG);

  it('BANK-5: only weak SMALL companies made by the game can fail: not the ten original ones, not a big or steady company, not a memecoin', () => {
    const eligible = new Set(weak.map((w) => w.id));
    const hand = world.companies[3] as Company;
    const big = world.companies.find((x) => x.id >= FIRST_FAILING_ID && x.sector !== 'meme' && !FAILING_TIERS.includes(x.tier)) as Company;
    const steady = world.companies.find((x) => x.id >= FIRST_FAILING_ID && x.sector !== 'meme' && FAILING_TIERS.includes(x.tier) && !FAILING_PERSONALITIES.includes(x.personality)) as Company;
    const coin = world.companies.find((x) => x.sector === 'meme') as Company;
    for (const x of [hand, big, steady, coin]) {
      expect(eligible.has(x.id)).toBe(false);
      pile(x.id, 15, -0.05);
    }
    const b = bank();
    expect(b.step()).toBeNull(); // nothing else is piled up, so nobody fails
    for (const x of [hand, big, steady, coin]) {
      expect(b.isBankrupt(x.id)).toBe(false);
      expect(row(x.id)).toBeUndefined();
    }
    expect(b.declare(coin)).toBe(false); // a coin cannot be made to fail even by hand
  }, LONG);

  it('BANK-6: one failure a day (the lowest roll goes first), checked once a day, and three days between two failures', () => {
    const x = co(5);
    const y = co(6);
    pile(x.id, 12);
    pile(y.id, 12);
    const b = bank();
    const first = b.step();
    expect(first).not.toBeNull();
    const seed = Number(db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'world_seed'")?.value);
    const cycle = cycleOfTick(world.sim.tick);
    const lower = rollOf(seed, x.id, cycle) < rollOf(seed, y.id, cycle) ? x : y;
    expect(first?.id).toBe(lower.id);
    expect(b.step()).toBeNull(); // the same day is not checked twice
    // A restarted program checks the day again, and the three-day gap still holds the other company back.
    const again = bank();
    expect(again.step()).toBeNull();
    const other = lower.id === x.id ? y : x;
    expect(again.isBankrupt(lower.id)).toBe(true);
    expect(again.isBankrupt(other.id)).toBe(false);
    expect(again.ids().has(lower.id)).toBe(true);
    expect(again.list().map((r) => r.companyId)).toEqual([lower.id]);
  }, LONG);

  it('BANK-7: a company fails once only, and the failure story does not count as news for the next check', () => {
    const c = weak[7] as Company;
    pile(c.id, 12);
    const b = bank();
    expect(b.step()?.id).toBe(c.id);
    expect(b.declare(c)).toBe(false);
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM bankruptcies WHERE company_id = ?', c.id)?.n).toBe(1);
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM news_items WHERE key LIKE 'bankrupt:%' AND company_id = ?", c.id)?.n).toBe(1);
  }, LONG);
});

describe('What players can do afterwards', () => {
  let trading: Trading;
  let auth: Auth;

  async function players() {
    advance(1);
    trading = new Trading(db, world, rig.clock.now);
    auth = new Auth(db, rig.clock.now, '');
    const alice = (await auth.register(`alice${Math.floor(rig.clock.now() / 1000) % 100000}`, 'correct horse', '127.0.0.1')).user;
    const bob = (await auth.register(`bob${Math.floor(rig.clock.now() / 1000) % 100000}`, 'correct horse', '127.0.0.1')).user;
    return { alice, bob, a: trading.careerAccountOf(alice.id), b: trading.careerAccountOf(bob.id) };
  }
  let n = 0;
  const oid = (): string => `bank-order-${String(++n).padStart(6, '0')}`;

  it('BANK-8: nobody can open a new position in it; a holder can still sell and a short can still cover; the holder loses almost everything, the short wins', async () => {
    const c = weak[8] as Company;
    const { a, b } = await players();
    const mid = world.sim.price(c.id);
    const qty = Math.max(2, Math.floor(30_000 / mid));
    const long = trading.placeOrder({ accountId: a.id, clientOrderId: oid(), companyId: c.id, side: 'buy', qty });
    const cashLong = trading.view(a.id).cashCents;
    const shortOpen = trading.placeOrder({ accountId: b.id, clientOrderId: oid(), companyId: c.id, side: 'sell', short: true, qty });
    const cashShort = trading.view(b.id).cashCents;

    pile(c.id, 12);
    const bk = bank();
    expect(bk.step()?.id).toBe(c.id);
    trading.setBankrupt((id) => bk.isBankrupt(id));
    advance(40);
    expect(world.sim.isDead(c.id)).toBe(true);

    // New positions are refused, in every shape, with the same plain message.
    const refused = (fn: () => unknown): OrderError => {
      try {
        fn();
      } catch (e) {
        expect(e).toBeInstanceOf(OrderError);
        return e as OrderError;
      }
      throw new Error('the order was not refused');
    };
    for (const make of [
      () => trading.placeOrder({ accountId: a.id, clientOrderId: oid(), companyId: c.id, side: 'buy', qty: 1 }),
      () => trading.placeOrder({ accountId: a.id, clientOrderId: oid(), companyId: c.id, side: 'buy', qty: 1, leverage: 5 }),
      () => trading.placeOrder({ accountId: a.id, clientOrderId: oid(), companyId: c.id, side: 'sell', short: true, qty: 1 }),
      () => trading.estimate(a.id, c.id, 'buy', 1),
      () => trading.estimate(null, c.id, 'buy', 1),
      () => trading.estimate(a.id, c.id, 'sell', 1, undefined, 1, true),
    ]) {
      const e = refused(make);
      expect(e.code).toBe('not_allowed');
      expect(e.status).toBe(403);
      expect(e.message).toMatch(/went bankrupt/);
      expect(e.details).toMatchObject({ bankrupt: true });
    }

    // The positions say so, and they are worth almost nothing (long) or a lot (short).
    const posA = trading.view(a.id).positions.find((p) => p.companyId === c.id);
    const posB = trading.view(b.id).positions.find((p) => p.companyId === c.id);
    expect(posA?.bankrupt).toBe(true);
    expect(posB?.bankrupt).toBe(true);
    expect(posA?.valueCents).toBeLessThan(long.trade.totalCents * 0.12);

    // The holder can still sell all of it, at the price it stopped at.
    const sell = trading.placeOrder({ accountId: a.id, clientOrderId: oid(), companyId: c.id, side: 'sell', qty: long.trade.filled });
    expect(sell.trade.filled).toBe(long.trade.filled);
    expect(sell.trade.totalCents).toBeLessThan(long.trade.totalCents * 0.12);
    expect(trading.view(a.id).cashCents).toBeLessThan(cashLong + long.trade.totalCents * 0.12);
    expect(trading.view(a.id).positions.find((p) => p.companyId === c.id)).toBeUndefined();

    // The short can cover, and made most of what it sold for.
    const cover = trading.placeOrder({ accountId: b.id, clientOrderId: oid(), companyId: c.id, side: 'buy', short: true, qty: shortOpen.trade.filled });
    expect(cover.trade.filled).toBe(shortOpen.trade.filled);
    expect(cover.trade.realizedCents).toBeGreaterThan(shortOpen.trade.totalCents * 0.8);
    expect(trading.view(b.id).cashCents).toBeGreaterThan(cashShort + shortOpen.trade.totalCents * 0.8);
    // Cover and sell were not refused although the company is bankrupt, and the price did not move for them either.
    expect(world.sim.isDead(c.id)).toBe(true);
  }, LONG);

  it('BANK-9: a waiting order that would open a position is cancelled and its cash comes back; a new one is refused', async () => {
    const c = weak[9] as Company;
    const { a } = await players();
    const bk = bank();
    trading.setBankrupt((id) => bk.isBankrupt(id));
    const told: string[] = [];
    const limits = new LimitOrders({ db, world, trading, log: rig.log, now: rig.clock.now, isBanned: () => false, onChange: (_u, order, what) => told.push(`${what}:${order.state}`) });
    const q = world.quote(c.id);
    const cash0 = trading.view(a.id).cashCents;
    const placed = limits.place({ accountId: a.id, clientOrderId: oid(), companyId: c.id, side: 'buy', qty: 5, limitPrice: Math.max(1, Math.floor(q.bid / 2)), goodFor: '3d' });
    expect(placed.order.state).toBe('open');
    expect(trading.view(a.id).cashCents).toBeLessThan(cash0); // set aside
    pile(c.id, 12);
    expect(bk.step()?.id).toBe(c.id);
    advance(40);
    limits.step(world.sim.tick);
    const ended = limits.list(a.id, 'all')[0];
    expect(ended?.state).toBe('cancelled');
    expect(ended?.reason).toMatch(/bankrupt/);
    expect(trading.view(a.id).cashCents).toBe(cash0); // the set-aside cash is back
    expect(told.some((t) => t.startsWith('ended'))).toBe(true);
    try {
      limits.place({ accountId: a.id, clientOrderId: oid(), companyId: c.id, side: 'buy', qty: 5, limitPrice: 1, goodFor: '1d' });
      throw new Error('not refused');
    } catch (e) {
      expect(e).toBeInstanceOf(OrderError);
      expect((e as OrderError).code).toBe('not_allowed');
    }
  }, LONG);

  it('BANK-10: the market list and the company page say which companies are bankrupt', () => {
    const c = weak[10] as Company;
    pile(c.id, 12);
    const bk = bank();
    expect(bk.step()?.id).toBe(c.id);
    const views = new MarketViews(world);
    views.setBankrupt(() => bk.ids());
    const rows = views.overview().companies;
    expect(rows[c.id]?.bankrupt).toBe(true);
    expect(rows.filter((r) => r.bankrupt).map((r) => r.id)).toEqual([c.id]);
    expect((views.detail(c.ticker) as { bankrupt: boolean }).bankrupt).toBe(true);
    const plain = new MarketViews(world);
    expect(plain.overview().companies.every((r) => !r.bankrupt)).toBe(true);
  }, LONG);
});

describe('A restart', () => {
  it('BANK-11: after a restart the failed company is still dead at the very same price, and the program still knows it failed', () => {
    const c = weak[11] as Company;
    pile(c.id, 12);
    expect(bank().step()?.id).toBe(c.id);
    advance(40);
    expect(world.sim.isDead(c.id)).toBe(true);
    const price = world.sim.price(c.id);
    const second = rig.open({ companyCount: 66, warmupDays: 8, memecoins: true, news: newsBuilder(rig) });
    second.world.advanceTo(second.world.currentTick(), Infinity);
    expect(second.world.sim.isDead(c.id)).toBe(true);
    expect(second.world.sim.price(c.id)).toBe(price);
    expect(new NewsService({ db: second.db, log: rig.log, now: rig.clock.now }).deadEvents().some((e) => e.key === `bankrupt:${c.id}:fail`)).toBe(true);
    const fresh = new Bankruptcies({ db: second.db, world: second.world, news: null, log: rig.log, now: rig.clock.now });
    expect(fresh.isBankrupt(c.id)).toBe(true);
    expect(fresh.list().map((r) => r.companyId)).toEqual([c.id]);
  }, LONG);
});

describe('How it is wired', () => {
  const read = (...p: string[]): string => readFileSync(resolve(process.cwd(), ...p), 'utf8');

  it('BANK-12: the app creates it, checks it on every tick, tells trading and the market list, and the rug pull and bankruptcy stories are the only dead ones', () => {
    const app = read('server', 'app.ts');
    expect(app).toMatch(/new Bankruptcies\(/);
    expect(app).toMatch(/trading\.setBankrupt\(/);
    expect(app).toMatch(/views\.setBankrupt\(/);
    expect(app).toMatch(/bankruptcies\.step\(\)/);
    const service = read('server', 'news', 'service.ts');
    expect(service).toMatch(/key LIKE 'rug:%:drain' OR key LIKE 'bankrupt:%:fail'/);
    expect(deathTickOf({ key: 'bankrupt:12:fail', companyId: 12, startTick: 100, shape: 'burst', durationTicks: 6 })).toBe(106);
    expect(deathTickOf({ key: 'rug:12:drain', companyId: 12, startTick: 100, shape: 'burst', durationTicks: 6 })).toBe(106);
    expect(deathTickOf({ key: 'admin:abc', companyId: 12, startTick: 100, shape: 'burst', durationTicks: 6 })).toBeNull();
    expect(deathTickOf({ key: 'bankrupt:12:fail', companyId: null, startTick: 100, shape: 'burst', durationTicks: 6 })).toBeNull();
  });

  it('BANK-13: the rule uses no random number generator and the schema has the table', () => {
    const src = read('server', 'bankruptcy.ts');
    expect(src).not.toMatch(/Math\.random|Date\.now/);
    expect(read('server', 'schema.ts')).toMatch(/CREATE TABLE bankruptcies/);
  });
});
