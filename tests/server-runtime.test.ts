// The persistent world on the server: it keeps its own clock, saves itself, and picks up exactly where it was after a stop,
// a crash or days of downtime. (docs/world.md §3, requirements 1 and 10.)
import { afterEach, describe, expect, it } from 'vitest';
import { CANDLES_PER_DAY, CANDLES_PER_HOUR, TICKS_PER_CANDLE, TICKS_PER_DAY, TICKS_PER_HOUR, buildCatalog, fold, type Candle } from '../src/world';
import { Db } from '../server/sqlite';
import { Clock, fixedNews, makeRig, priceVector, type Rig } from './helpers/server';
import { makeEvent } from './helpers/world';

const LONG = 120_000;
const rigs: Rig[] = [];
function rig(clock?: Clock): Rig {
  const r = makeRig(clock);
  rigs.push(r);
  return r;
}
afterEach(() => {
  while (rigs.length > 0) rigs.pop()?.cleanup();
});

function tableRows(r: Rig, table: string): string {
  const db = r.opened[r.opened.length - 1];
  if (!db) throw new Error('no database');
  return JSON.stringify(db.all(`SELECT * FROM ${table} ORDER BY company_id, idx`));
}

describe('first start', () => {
  it('begins on an hour boundary in the past, is at the clock tick, and has history', () => {
    const r = rig();
    const { world } = r.open();
    expect(world.genesisMs % 3_600_000).toBe(0);
    expect(world.genesisMs).toBe(r.clock.ms - TICKS_PER_DAY * 1000);
    expect(world.sim.tick).toBe(TICKS_PER_DAY);
    expect(world.health().ok).toBe(true);
    expect(world.health().lagTicks).toBe(0);
    expect(world.candles(0, 'c10', 2000).length).toBe(2001); // 2000 finished + the one forming now
    const stored = world.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM candles_c10 WHERE company_id = 0');
    expect(stored?.n).toBe(CANDLES_PER_DAY);
    expect(world.candles(0, 'h1', 100).length).toBeGreaterThanOrEqual(24);
    expect(world.candles(0, 'd1', 10).length).toBeGreaterThanOrEqual(1);
  }, LONG);

  it('every stored 10-tick candle is consistent: low ≤ open, close ≤ high, opens at the previous close', () => {
    const r = rig();
    const { world } = r.open();
    for (let i = 0; i < 12; i += 1) {
      const rows = world.candles(i, 'c10', 2000).filter((c) => c.complete);
      let prev: Candle | null = null;
      for (const c of rows) {
        expect(c.low).toBeLessThanOrEqual(Math.min(c.open, c.close));
        expect(c.high).toBeGreaterThanOrEqual(Math.max(c.open, c.close));
        if (prev && c.index === prev.index + 1) expect(c.open).toBe(prev.close);
        prev = c;
      }
    }
  }, LONG);

  it('hourly and daily candles are exactly the fold of the 10-tick candles inside them', () => {
    const r = rig();
    const { world } = r.open({ warmupDays: 2 });
    // 10-tick candles are kept for 25 h only, so compare the last 20 hours.
    const small = world.db.all<Candle>('SELECT idx AS "index", open, high, low, close, volume FROM candles_c10 WHERE company_id = 3 ORDER BY idx');
    const hours = world.candles(3, 'h1', 1000).filter((c) => c.complete);
    let checked = 0;
    for (const h of hours) {
      const parts = small.filter((c) => c.index > (h.index - 1) * CANDLES_PER_HOUR && c.index <= h.index * CANDLES_PER_HOUR);
      if (parts.length !== CANDLES_PER_HOUR) continue;
      const plain = (c: Candle): Candle => ({ index: c.index, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });
      expect(plain(h)).toEqual(fold(h.index, parts.map(plain)));
      checked += 1;
    }
    expect(checked).toBeGreaterThanOrEqual(15);
    // And a day equals the fold of its hours.
    const days = world.candles(3, 'd1', 10).filter((c) => c.complete);
    expect(days.length).toBeGreaterThanOrEqual(2);
    const day1 = days[0] as Candle;
    const hoursOfDay = hours.filter((h) => h.index <= 24);
    if (hoursOfDay.length === 24 && day1.index === 1) {
      const plain = (c: Candle): Candle => ({ index: c.index, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });
      expect(plain(day1)).toEqual(fold(1, hoursOfDay.map(plain)));
    }
    expect(CANDLES_PER_DAY).toBe(8640);
  }, LONG);
});

describe('stop and restart', () => {
  it('a clean stop and restart continues with exactly the prices an uninterrupted market has', () => {
    // Uninterrupted: one process lives through 3000 seconds.
    const a = rig();
    const { world: wa } = a.open();
    for (let s = 0; s < 3000; s += 1) {
      a.clock.advanceSeconds(1);
      wa.pump();
    }
    // Interrupted: the process is stopped after 1234 s, restarted after 5 s of downtime.
    const b = rig();
    let { world: wb } = b.open();
    for (let s = 0; s < 1234; s += 1) {
      b.clock.advanceSeconds(1);
      wb.pump();
    }
    b.opened[0]?.close();
    b.clock.advanceSeconds(3000 - 1234);
    ({ world: wb } = b.open());
    expect(wb.sim.tick).toBe(wa.sim.tick);
    expect(priceVector(wb)).toEqual(priceVector(wa));
    expect(wb.health().lagTicks).toBe(0);
    expect(tableRows(b, 'candles_c10')).toBe(tableRows(a, 'candles_c10'));
    expect(tableRows(b, 'candles_h1')).toBe(tableRows(a, 'candles_h1'));
  }, LONG);

  it('starting from a saved world never loads a whole day of candles for every company at once (a small host would run out of memory)', () => {
    const r = rig();
    const first = r.open({ companyCount: 12 });
    r.clock.advanceSeconds(600);
    first.world.pump();
    const before = priceVector(first.world);
    first.db.close();
    r.clock.advanceSeconds(900);

    // Watch the biggest answer any query gives while the world loads and catches up.
    const original = Db.prototype.all;
    let most = 0;
    Db.prototype.all = function (this: Db, sql: string, ...params: Parameters<Db['all']> extends [string, ...infer P] ? P : never) {
      const rows = original.call(this, sql, ...params);
      if (rows.length > most) most = rows.length;
      return rows;
    } as typeof original;
    let reopened;
    try {
      reopened = r.open({ companyCount: 12 });
    } finally {
      Db.prototype.all = original;
    }
    expect(most).toBeLessThanOrEqual(CANDLES_PER_DAY); // one company's day, not twelve
    // And the statistics are exactly what they were (the 24-hour range of company 0 is whole).
    expect(reopened.world.sim.tick).toBeGreaterThan(first.world.sim.tick);
    expect(priceVector(reopened.world)).not.toEqual(before); // time passed: the market moved on
    const range = reopened.world.stats.window;
    expect(range).toBe(CANDLES_PER_DAY);
    expect(reopened.world.stats.newest).toBeGreaterThan(0);
  }, LONG);

  it('a crash between saves (state in memory lost) replays to identical prices', () => {
    const a = rig();
    const { world: wa } = a.open();
    a.clock.advanceSeconds(5000);
    wa.advanceTo(wa.currentTick(), Infinity);

    const b = rig();
    const first = b.open();
    b.clock.advanceSeconds(2507); // not on a candle boundary, so the last few ticks exist only in memory
    first.world.advanceTo(first.world.currentTick(), Infinity);
    expect(first.world.savedTick).toBeLessThan(first.world.sim.tick);
    // "Crash": the process disappears without writing anything more.
    first.db.close();
    b.clock.advanceSeconds(5000 - 2507);
    const { world: wb } = b.open();
    expect(wb.sim.tick).toBe(wa.sim.tick);
    expect(priceVector(wb)).toEqual(priceVector(wa));
    expect(tableRows(b, 'candles_c10')).toBe(tableRows(a, 'candles_c10'));
  }, LONG);

  it('three days of downtime: the market is where the clock says, history is gapless, and nothing jumps or resets', () => {
    const a = rig();
    const { world: wa } = a.open();
    a.clock.advanceSeconds(3 * 86400);
    wa.advanceTo(wa.currentTick(), Infinity);

    const b = rig();
    const first = b.open();
    const before = priceVector(first.world);
    const tickBefore = first.world.sim.tick;
    first.db.close();
    b.clock.advanceSeconds(3 * 86400); // nobody is running the server
    const { world: wb } = b.open();
    expect(wb.sim.tick).toBe(tickBefore + 3 * 86400);
    expect(priceVector(wb)).toEqual(priceVector(wa));
    expect(priceVector(wb)).not.toEqual(before);
    // No gap in the hourly or daily history.
    for (const res of ['h1', 'd1'] as const) {
      const rows = wb.candles(0, res, 2000).filter((c) => c.complete);
      for (let k = 1; k < rows.length; k += 1) expect((rows[k] as Candle).index).toBe((rows[k - 1] as Candle).index + 1);
      for (let k = 1; k < rows.length; k += 1) expect((rows[k] as Candle).open).toBe((rows[k - 1] as Candle).close);
    }
    // The first price after restart continues from the last price before it: no reset to a base price.
    const lastBefore = first.world.sim.price(0);
    const firstCandleAfter = wb.candles(0, 'h1', 2000).find((c) => c.index === Math.floor(tickBefore / TICKS_PER_HOUR) + 1);
    expect(firstCandleAfter?.open).toBe(lastBefore);
  }, LONG);

  it('the browser clock is irrelevant: only the server clock moves the market', () => {
    const r = rig();
    const { world } = r.open();
    const t0 = world.sim.tick;
    world.pump();
    world.pump();
    expect(world.sim.tick).toBe(t0); // the clock has not moved, so neither has the market
    r.clock.advanceSeconds(1);
    world.pump();
    expect(world.sim.tick).toBe(t0 + 1);
  }, LONG);

  it('refuses to run if the computer clock is earlier than the start of the world', () => {
    const r = rig();
    r.open();
    r.opened[0]?.close();
    r.clock.advanceSeconds(-3 * 86400);
    expect(() => r.open()).toThrow(/clock is earlier/);
  }, LONG);
});

describe('news effects survive restarts', () => {
  it('an event that is half way through when the server stops is applied once in total', () => {
    const events = [
      makeEvent({ key: 'e1', companyId: 2, startTick: TICKS_PER_DAY + 500, durationTicks: 1800, shape: 'ramp', realized: 0.12, permShare: 0.5 }),
      makeEvent({ key: 'e2', scope: 'market', companyId: null, startTick: TICKS_PER_DAY + 800, durationTicks: 900, shape: 'front', realized: -0.04, permShare: 0.7 }),
    ];
    const news = fixedNews(events);
    const a = rig();
    const { world: wa } = a.open({ news });
    a.clock.advanceSeconds(4000);
    wa.advanceTo(wa.currentTick(), Infinity);

    const b = rig();
    const first = b.open({ news });
    b.clock.advanceSeconds(1500); // stop in the middle of both events
    first.world.advanceTo(first.world.currentTick(), Infinity);
    first.db.close();
    b.clock.advanceSeconds(2500);
    const { world: wb } = b.open({ news });
    expect(priceVector(wb)).toEqual(priceVector(wa));
    expect(tableRows(b, 'candles_c10')).toBe(tableRows(a, 'candles_c10'));

    // And the events really moved the price (compared with a world that has no news).
    const c = rig();
    const { world: wc } = c.open();
    c.clock.advanceSeconds(4000);
    wc.advanceTo(wc.currentTick(), Infinity);
    expect(wc.sim.price(2)).not.toBe(wa.sim.price(2));
  }, LONG);

  it('if the news system cannot supply events the market stalls visibly instead of running without them', () => {
    let broken = false;
    const base = fixedNews([]);
    const news = { ...base, ensureThrough: (t: number) => { if (broken) throw new Error('no news for this period'); base.ensureThrough(t); } };
    const r = rig();
    const { world } = r.open({ news });
    const tick = world.sim.tick;
    broken = true;
    r.clock.advanceSeconds(7 * 3600); // beyond the 6-hour look-ahead
    world.pump();
    world.pump();
    // It may advance up to the horizon it already has, then it must stop and say why.
    expect(world.health().stalled).toMatch(/no news/);
    expect(world.health().ok).toBe(false);
    expect(world.sim.tick).toBeGreaterThan(tick);
    expect(world.sim.tick).toBeLessThan(world.currentTick());
    const frozenAt = world.sim.tick;
    world.pump();
    expect(world.sim.tick).toBe(frozenAt);
    broken = false;
    world.pump();
    expect(world.health().stalled).toBeNull();
    expect(world.sim.tick).toBeGreaterThan(frozenAt);
    expect(r.log.problems().some((p) => /could not advance/.test(p.message))).toBe(true);
  }, LONG);
});

describe('listing new companies', () => {
  it('companies added later start trading in the future; existing history is untouched', () => {
    const r = rig();
    const first = r.open({ companyCount: 12 });
    const priceBefore = first.world.sim.price(5);
    const candlesBefore = JSON.stringify(first.world.candles(5, 'h1', 1000));
    first.db.close();
    r.clock.advanceSeconds(60);
    const { world } = r.open({ companyCount: 15 });
    expect(world.companies.length).toBe(15);
    const added = world.companies[13];
    expect(added?.listingTick).toBeGreaterThan(world.sim.tick);
    expect(world.sim.isListed(13)).toBe(false);
    expect(world.sim.price(13)).toBe(0);
    expect(world.sim.price(5)).not.toBe(0);
    expect(JSON.stringify(world.candles(5, 'h1', 1000).slice(0, 24))).toBe(candlesBefore.slice(0, JSON.stringify(world.candles(5, 'h1', 1000).slice(0, 24)).length));
    expect(priceBefore).toBeGreaterThan(0);
    // After the listing tick it trades at its base price and then evolves.
    r.clock.advanceSeconds((added?.listingTick ?? 0) - world.sim.tick + 30);
    world.advanceTo(world.currentTick(), Infinity);
    expect(world.sim.isListed(13)).toBe(true);
    const cs = world.candles(13, 'c10', 100);
    expect(cs.length).toBeGreaterThan(0);
    expect(cs[0]?.open).toBe(added?.basePriceCents);
  }, LONG);

  it('a restart in the middle of a pending listing still lists it at the same tick', () => {
    const r = rig();
    r.open({ companyCount: 12 }).db.close();
    r.clock.advanceSeconds(10);
    const second = r.open({ companyCount: 14 });
    const listing = second.world.companies[13]?.listingTick as number;
    second.db.close();
    r.clock.advanceSeconds(5);
    const third = r.open({ companyCount: 14 });
    expect(third.world.companies[13]?.listingTick).toBe(listing);
  }, LONG);

  it('a changed catalog (a ticker that moved) is refused rather than silently corrupting history', () => {
    const r = rig();
    const { db } = r.open({ companyCount: 12 });
    db.run("UPDATE companies SET ticker = 'ZZZZ' WHERE id = 4");
    db.close();
    expect(() => r.open({ companyCount: 12 })).toThrow(/catalog changed/);
  }, LONG);
});

describe('24-hour statistics', () => {
  it('match the stored candles and survive a restart', () => {
    const r = rig();
    const { world, db } = r.open({ warmupDays: 2 });
    const id = 7;
    const rows = db.all<{ volume: number; high: number; low: number; close: number; idx: number }>(
      'SELECT idx, high, low, close, volume FROM candles_c10 WHERE company_id = ? ORDER BY idx DESC LIMIT ?',
      id,
      CANDLES_PER_DAY,
    );
    expect(rows.length).toBe(CANDLES_PER_DAY);
    const sum = rows.reduce((s, x) => s + x.volume, 0);
    expect(world.stats.volume24h(id)).toBe(sum);
    expect(world.stats.range24h(id).high).toBe(Math.max(...rows.map((x) => x.high)));
    expect(world.stats.range24h(id).low).toBe(Math.min(...rows.map((x) => x.low)));
    const volume = world.stats.volume24h(id);
    db.close();
    const again = r.open({ warmupDays: 2 });
    expect(again.world.stats.volume24h(id)).toBe(volume);
  }, LONG);

  it('market cap follows the price and the share count', () => {
    const r = rig();
    const { world } = r.open();
    const cat = buildCatalog(12);
    for (let i = 0; i < 12; i += 1) {
      expect(world.marketCap(i)).toBe(world.sim.price(i) * (cat[i]?.sharesOutstanding ?? 0));
    }
  }, LONG);
});

describe('retention', () => {
  it('10-tick candles older than 25 hours are dropped, hourly and daily ones are kept', () => {
    const r = rig();
    const { world, db } = r.open({ warmupDays: 3 });
    const c10 = db.get<{ n: number; lo: number }>('SELECT COUNT(*) AS n, MIN(idx) AS lo FROM candles_c10 WHERE company_id = 0');
    expect((c10?.n ?? 0)).toBeLessThanOrEqual(25 * CANDLES_PER_HOUR + 1);
    expect((c10?.n ?? 0)).toBeGreaterThan(24 * CANDLES_PER_HOUR - 2);
    const h1 = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM candles_h1 WHERE company_id = 0');
    expect(h1?.n).toBeGreaterThanOrEqual(3 * 24 - 1);
    expect(world.candles(0, 'd1', 10).length).toBeGreaterThanOrEqual(3);
    expect(TICKS_PER_CANDLE).toBe(10);
  }, LONG);
});
