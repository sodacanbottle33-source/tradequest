// The news system on the server: it is written ahead, saved once, shown newest first, moves real prices exactly once,
// survives restarts and downtime, and never fails silently. (docs/world.md §7, requirements 6–10.)
import { afterEach, describe, expect, it } from 'vitest';
import { NEWS_CYCLE_TICKS, TICKS_PER_DAY, TICKS_PER_HOUR, EffectBook, WorldSim, buildCatalog, effectsOf, cycleOfTick } from '../src/world';
import { Leases, NEWS_LEASE } from '../server/lease';
import { NewsScheduler } from '../server/news/scheduler';
import { NewsService } from '../server/news/service';
import { migrate } from '../server/schema';
import { Db } from '../server/sqlite';
import { Clock, START_MS, makeRig, priceVector, type Rig } from './helpers/server';

const LONG = 240_000;
const SEED = 12345;
const rigs: Rig[] = [];
function rig(clock?: Clock): Rig {
  const r = makeRig(clock);
  rigs.push(r);
  return r;
}
afterEach(() => {
  while (rigs.length > 0) rigs.pop()?.cleanup();
});

const msOf = (tick: number): number => START_MS + tick * 1000;

/** A service on its own database without a running world: fast tests of storage, feeds and checks. */
function bare(count = 20, onGenerate?: (cycle: number) => void): { r: Rig; db: Db; news: NewsService; companies: ReturnType<typeof buildCatalog> } {
  const r = rig();
  const db = new Db(r.path);
  r.opened.push(db);
  migrate(db);
  const companies = buildCatalog(count);
  const news = new NewsService({ db, log: r.log, now: r.clock.now, onGenerate });
  news.bind({ worldSeed: SEED, companies });
  return { r, db, news, companies };
}

function factory(r: Rig, onGenerate?: (cycle: number) => void): (db: Db) => NewsService {
  return (db) => new NewsService({ db, log: r.log, now: r.clock.now, onGenerate });
}

function newsRows(db: Db): string {
  return JSON.stringify(
    db.all(
      'SELECT key, company_id, partner_id, sector, scope, kind, category, cycle, slot, publish_tick, start_tick, end_tick, duration_ticks, shape, immediacy, direction, strength, realized, perm_share, credibility, headline, body, breaking, price_at_publish, price_at_end FROM news_items ORDER BY key',
    ),
  );
}

describe('writing news ahead of time', () => {
  it('every company gets at least 3 news items in every day, all saved with the full set of fields', () => {
    const { db, news, companies } = bare(30);
    news.ensureThrough(10 * TICKS_PER_DAY - 1);
    const groups = db.all<{ company_id: number; cycle: number; n: number; h: number; c: number }>(
      'SELECT company_id, cycle, COUNT(*) AS n, COUNT(DISTINCT headline) AS h, COUNT(DISTINCT category) AS c FROM news_items WHERE company_id IS NOT NULL AND slot < 3 GROUP BY company_id, cycle',
    );
    expect(groups).toHaveLength(30 * 10);
    for (const g of groups) {
      expect(g.n).toBe(3);
      expect(g.h).toBe(3); // three different stories, not one repeated
      expect(g.c).toBeGreaterThanOrEqual(2);
    }
    expect(new Set(groups.map((g) => g.company_id)).size).toBe(companies.length);

    const bad = db.all<{ key: string }>(
      `SELECT key FROM news_items WHERE headline = '' OR body = '' OR category = '' OR created_ms IS NULL OR publish_tick < cycle * ${NEWS_CYCLE_TICKS}
         OR start_tick < publish_tick OR end_tick <= start_tick OR direction NOT IN ('positive','negative','uncertain') OR strength NOT IN ('minor','moderate','major','extreme')
         OR immediacy NOT IN ('immediate','gradual')`,
    );
    expect(bad).toEqual([]);
    const state = db.all<{ company_id: number; generated_through: number; items_total: number }>('SELECT company_id, generated_through, items_total FROM news_company_state ORDER BY company_id');
    expect(state).toHaveLength(30);
    for (const s of state) {
      expect(s.generated_through).toBe(9);
      expect(s.items_total).toBeGreaterThanOrEqual(30);
    }
  }, LONG);

  it('the three items of a day are spread through the day, one in each third', () => {
    const { db, news } = bare(15);
    news.ensureThrough(4 * TICKS_PER_DAY - 1);
    const rows = db.all<{ company_id: number; cycle: number; slot: number; publish_tick: number }>('SELECT company_id, cycle, slot, publish_tick FROM news_items WHERE company_id IS NOT NULL AND slot < 3');
    expect(rows).toHaveLength(15 * 4 * 3);
    for (const r of rows) {
      const third = Math.floor((r.publish_tick - r.cycle * TICKS_PER_DAY) / (TICKS_PER_DAY / 3));
      expect(third).toBe(r.slot);
    }
  }, LONG);

  it('running generation again, in any order or from a second copy, never creates duplicates', () => {
    const { db, news, companies, r } = bare(12);
    news.ensureThrough(3 * TICKS_PER_DAY);
    const before = newsRows(db);
    const count = (): number => db.get<{ n: number }>('SELECT COUNT(*) AS n FROM news_items')?.n ?? 0;
    const n0 = count();
    news.ensureThrough(3 * TICKS_PER_DAY);
    news.ensureThrough(0);
    expect(count()).toBe(n0);

    // A second program that has not yet seen the first one's work (stale memory) writes the same days again.
    const stale = new NewsService({ db, log: r.log, now: r.clock.now });
    stale.bind({ worldSeed: SEED, companies });
    stale.ensureThrough(3 * TICKS_PER_DAY);
    expect(count()).toBe(n0);
    expect(newsRows(db)).toBe(before);
    expect(db.all('SELECT key FROM news_items GROUP BY key HAVING COUNT(*) > 1')).toEqual([]);

    // A fresh copy that reads the saved progress does no work at all.
    const fresh = new NewsService({ db, log: r.log, now: () => r.clock.ms + 999, });
    fresh.bind({ worldSeed: SEED, companies });
    fresh.ensureThrough(3 * TICKS_PER_DAY);
    expect(count()).toBe(n0);
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM news_cycles')?.n).toBe(4);
  }, LONG);

  it('the news of a day is the same whichever order days are generated in a run (stored once, never regenerated differently)', () => {
    const a = bare(12);
    a.news.ensureThrough(5 * TICKS_PER_DAY);
    const b = bare(12);
    for (let day = 0; day <= 5; day += 1) b.news.ensureThrough(day * TICKS_PER_DAY + 5);
    expect(newsRows(b.db)).toBe(newsRows(a.db));
  }, LONG);

  it('a day that fails half way is rolled back completely; the next try writes it whole', () => {
    let failing = true;
    const { db, news, r } = bare(12, (cycle) => {
      if (failing && cycle === 2) throw new Error('disk full');
    });
    news.ensureThrough(TICKS_PER_DAY * 2 - 1);
    expect(() => news.ensureThrough(TICKS_PER_DAY * 2 + 10)).toThrow(/disk full/);
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM news_items WHERE cycle = 2')?.n).toBe(0);
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM news_cycles WHERE cycle = 2')?.n).toBe(0);
    expect(db.get<{ m: number }>('SELECT MAX(generated_through) AS m FROM news_company_state')?.m).toBe(1);
    expect(r.log.problems().some((p) => /Generating news for day 2 failed/.test(p.message))).toBe(true);
    failing = false;
    news.ensureThrough(TICKS_PER_DAY * 2 + 10);
    const per = db.all<{ company_id: number; n: number }>('SELECT company_id, COUNT(*) AS n FROM news_items WHERE cycle = 2 AND slot < 3 AND company_id IS NOT NULL GROUP BY company_id');
    expect(per).toHaveLength(12);
    for (const p of per) expect(p.n).toBe(3);
  }, LONG);

  it('a company listed later is introduced with a listing item and gets its own 3 items in that day, nothing before it trades', () => {
    const { db, r } = bare(12);
    const first = new NewsService({ db, log: r.log, now: r.clock.now });
    const small = buildCatalog(12);
    first.bind({ worldSeed: SEED, companies: small });
    first.ensureThrough(2 * TICKS_PER_DAY);
    const listedAt = 2 * TICKS_PER_DAY + 40_000;
    const bigger = buildCatalog(14, (i) => (i >= 12 ? listedAt : 0));
    const second = new NewsService({ db, log: r.log, now: r.clock.now });
    second.bind({ worldSeed: SEED, companies: bigger });
    second.ensureThrough(2 * TICKS_PER_DAY); // the days up to the listing day are already stored; only the new companies are added
    second.ensureThrough(listedAt);
    for (const id of [12, 13]) {
      const rows = db.all<{ category: string; publish_tick: number; cycle: number; slot: number }>('SELECT category, publish_tick, cycle, slot FROM news_items WHERE company_id = ? ORDER BY publish_tick', id);
      expect(rows.length).toBeGreaterThanOrEqual(3);
      expect(cycleOfTick(listedAt)).toBe(2);
      for (const x of rows) {
        expect(x.cycle).toBe(2);
        expect(x.publish_tick).toBeGreaterThanOrEqual(listedAt);
      }
      expect(rows.filter((x) => x.slot < 3).length).toBe(3);
      expect(rows.some((x) => x.category === 'listing')).toBe(true);
      expect(db.get<{ generated_through: number }>('SELECT generated_through FROM news_company_state WHERE company_id = ?', id)?.generated_through).toBe(2);
    }
    // The old companies were not touched by this.
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM news_items WHERE company_id = 3 AND cycle = 2 AND slot < 3')?.n).toBe(3);
  }, LONG);

  it('catching up after missing many days writes every missed day, in one pass', () => {
    const { db, news } = bare(10);
    news.ensureThrough(TICKS_PER_DAY); // days 0–1 exist, then "the computer is off" for 20 days
    news.ensureThrough(22 * TICKS_PER_DAY + 3);
    const cycles = db.all<{ cycle: number }>('SELECT cycle FROM news_cycles ORDER BY cycle').map((x) => x.cycle);
    expect(cycles).toEqual(Array.from({ length: 23 }, (_, i) => i));
    const perDay = db.all<{ cycle: number; n: number }>('SELECT cycle, COUNT(*) AS n FROM news_items WHERE company_id IS NOT NULL AND slot < 3 GROUP BY cycle');
    expect(perDay).toHaveLength(23);
    for (const d of perDay) expect(d.n).toBe(30);
  }, LONG);
});

describe('what players can read', () => {
  it('the feed is newest first, hides unpublished news, and paging returns every item exactly once', () => {
    const { db, news } = bare(15);
    news.ensureThrough(3 * TICKS_PER_DAY);
    const now = 2 * TICKS_PER_DAY + 30_000;
    const seen: number[] = [];
    let before: string | undefined;
    let last = Infinity;
    for (let page = 0; page < 500; page += 1) {
      const r = news.feed({ tick: now, limit: 40, before }, msOf);
      for (const it of r.items) {
        expect(it.publishTick).toBeLessThanOrEqual(now);
        expect(it.publishTick).toBeLessThanOrEqual(last);
        last = it.publishTick;
        seen.push(it.id);
        expect(it.publishedMs).toBe(msOf(it.publishTick));
      }
      if (!r.next) break;
      before = r.next;
    }
    const expected = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM news_items WHERE publish_tick <= ?', now)?.n;
    expect(seen.length).toBe(expected);
    expect(new Set(seen).size).toBe(seen.length);
    const future = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM news_items WHERE publish_tick > ?', now)?.n ?? 0;
    expect(future).toBeGreaterThan(0); // there is unpublished news in the database, and it is not shown
  }, LONG);

  it('players never see the hidden outcome of a story or how credible its source was', () => {
    const { news } = bare(15);
    news.ensureThrough(TICKS_PER_DAY);
    const r = news.feed({ tick: TICKS_PER_DAY, limit: 100 }, msOf);
    expect(r.items.length).toBeGreaterThan(20);
    const text = JSON.stringify(r);
    for (const secret of ['realized', 'credibility', 'permShare', 'perm_share', 'startTick', 'durationTicks']) expect(text).not.toContain(secret);
    expect(r.items.some((i) => i.breaking)).toBe(true);
    for (const i of r.items) expect(i.outcome).toBeNull(); // no price has been recorded yet, so nothing is claimed
  }, LONG);

  it('a company page shows its own news, its partners news, its sector, and the whole-market news — and filters work', () => {
    const { news, companies } = bare(30);
    news.ensureThrough(15 * TICKS_PER_DAY);
    const c = companies[4]!;
    const r = news.feed({ tick: 15 * TICKS_PER_DAY, companyId: c.id, limit: 40 }, msOf);
    expect(r.items.length).toBe(40);
    expect(r.next).not.toBeNull();
    let own = 0;
    let partner = 0;
    let sector = 0;
    let market = 0;
    for (const it of r.items) {
      if (it.ticker === c.ticker) own += 1;
      else if (it.partnerTicker === c.ticker) partner += 1;
      else if (it.scope === 'sector') {
        sector += 1;
        expect(it.sector).toBe(c.sector);
      } else {
        expect(it.scope).toBe('market');
        market += 1;
      }
    }
    expect(own).toBeGreaterThan(10);
    expect(sector + market).toBeGreaterThan(0);
    for (let i = 1; i < r.items.length; i += 1) expect((r.items[i - 1] as { publishTick: number }).publishTick).toBeGreaterThanOrEqual((r.items[i] as { publishTick: number }).publishTick);
    expect(partner).toBeGreaterThanOrEqual(0);

    const products = news.feed({ tick: 15 * TICKS_PER_DAY, category: 'product', limit: 50 }, msOf);
    expect(products.items.length).toBeGreaterThan(0);
    for (const i of products.items) expect(i.category).toBe('product');
    const breaking = news.feed({ tick: 15 * TICKS_PER_DAY, breakingOnly: true, limit: 50 }, msOf);
    expect(breaking.items.length).toBeGreaterThan(0);
    for (const i of breaking.items) expect(i.breaking).toBe(true);
    expect(news.feed({ tick: 15 * TICKS_PER_DAY, companyId: 9999, limit: 5 }, msOf).items).toEqual([]);
    expect(() => news.feed({ tick: 10, before: 'x:y', limit: 5 }, msOf)).toThrow(/cursor/i);
  }, LONG);

  it('news about a company that has not listed yet does not appear on its page', () => {
    const { db, r } = bare(12);
    const bigger = buildCatalog(13, (i) => (i === 12 ? TICKS_PER_DAY + 50_000 : 0));
    const news = new NewsService({ db, log: r.log, now: r.clock.now });
    news.bind({ worldSeed: SEED, companies: bigger });
    news.ensureThrough(TICKS_PER_DAY + 100_000);
    const before = news.feed({ tick: TICKS_PER_DAY + 49_999, companyId: 12, limit: 100 }, msOf);
    for (const it of before.items) expect(it.ticker).not.toBe(bigger[12]!.ticker);
    const after = news.feed({ tick: TICKS_PER_DAY + 100_000, companyId: 12, limit: 100 }, msOf);
    expect(after.items.filter((i) => i.ticker === bigger[12]!.ticker).length).toBeGreaterThanOrEqual(3);
  }, LONG);
});

describe('health checks', () => {
  it('say exactly what is missing, and turn healthy once the news has been written', () => {
    const { news } = bare(8);
    const clock = TICKS_PER_DAY + 100;
    const need = clock + 6 * TICKS_PER_HOUR;
    const sick = news.health(clock, need);
    expect(sick.ok).toBe(false);
    expect(sick.behind.length).toBe(8);
    expect(sick.belowMinimum.length).toBe(8);
    expect(sick.generatedThroughCycle).toBe(-1);
    news.ensureThrough(need);
    const well = news.health(clock, need);
    expect(well.ok).toBe(true);
    expect(well.behind).toEqual([]);
    expect(well.belowMinimum).toEqual([]);
    expect(well.generatedThroughCycle).toBe(1);
    expect(well.items).toBeGreaterThan(48);
    expect(well.itemsPublished).toBeLessThan(well.items);
    expect(well.lastGeneratedMs).not.toBeNull();
  }, LONG);
});

describe('the scheduler', () => {
  function make(ownerName: string, shared: { db: Db; news: NewsService; clock: Clock; log: Rig['log'] }, tick: () => number, options: { alive?: (pid: number) => boolean; pid?: number } = {}): NewsScheduler {
    return new NewsScheduler({
      service: shared.news,
      leases: new Leases({ db: shared.db, now: shared.clock.now, owner: ownerName, host: 'h', pid: options.pid ?? 1, alive: options.alive ?? (() => true) }),
      log: shared.log,
      now: shared.clock.now,
      clockTick: tick,
    });
  }

  it('writes news at least 12 hours ahead of the clock, and catches up after the program was off', () => {
    const { db, news, r } = bare(10);
    const shared = { db, news, clock: r.clock, log: r.log };
    let tick = TICKS_PER_DAY + 100;
    const s = make('a', shared, () => tick);
    const first = s.runOnce();
    expect(first.ran).toBe(true);
    expect(db.get<{ m: number }>('SELECT MAX(cycle) AS m FROM news_cycles')?.m).toBe(1);
    tick = TICKS_PER_DAY + 13 * TICKS_PER_HOUR; // 12 h ahead now reaches the next day
    expect(s.runOnce().ran).toBe(true);
    expect(db.get<{ m: number }>('SELECT MAX(cycle) AS m FROM news_cycles')?.m).toBe(2);
    tick = 40 * TICKS_PER_DAY; // a long stop
    r.clock.advanceSeconds(10_000);
    expect(s.runOnce().ran).toBe(true);
    const cycles = db.all<{ cycle: number }>('SELECT cycle FROM news_cycles ORDER BY cycle').map((x) => x.cycle);
    expect(cycles).toEqual(Array.from({ length: 41 }, (_, i) => i));
    expect(s.status().runs).toBe(3);
    expect(s.status().lastSuccessMs).toBe(r.clock.ms);
    expect(s.status().lastError).toBeNull();
  }, LONG);

  it('only one scheduler works at a time: the other waits, and takes over when the first stops, expires or dies', () => {
    const { db, news, r } = bare(6);
    const shared = { db, news, clock: r.clock, log: r.log };
    const tick = (): number => TICKS_PER_DAY + 5;
    let aliveA = true;
    const a = make('a', shared, tick, { pid: 111, alive: (pid) => (pid === 111 ? aliveA : true) });
    const b = make('b', shared, tick, { pid: 222, alive: (pid) => (pid === 111 ? aliveA : true) });
    expect(a.runOnce().ran).toBe(true);
    const blocked = b.runOnce();
    expect(blocked).toEqual({ ran: false, reason: 'lease' });
    expect(b.status().skipped).toBe(1);
    expect(a.runOnce().ran).toBe(true); // the owner renews its own lease

    a.stop(); // a clean stop hands the job over at once
    expect(b.runOnce().ran).toBe(true);

    // The lease runs out if the owner just disappears (here: the clock passes the expiry).
    expect(a.runOnce().ran).toBe(false);
    r.clock.advanceSeconds(91);
    expect(a.runOnce().ran).toBe(true);

    // Or the owner program is known to be dead on this computer: no need to wait for the expiry.
    aliveA = false;
    expect(b.runOnce().ran).toBe(true);
    expect(new Leases({ db, now: r.clock.now }).holder(NEWS_LEASE)).not.toBeNull();
  }, LONG);

  it('a failing run is reported, counted and logged, and the next run succeeds when the cause is gone', () => {
    let failing = true;
    const { db, news, r } = bare(6, () => {
      if (failing) throw new Error('out of disk space');
    });
    const shared = { db, news, clock: r.clock, log: r.log };
    const s = make('a', shared, () => 5);
    const bad = s.runOnce();
    expect(bad.ran).toBe(false);
    expect(bad).toMatchObject({ reason: 'error' });
    expect(s.status().failures).toBe(1);
    expect(s.status().lastError).toMatch(/out of disk space/);
    expect(r.log.problems().some((p) => /scheduler run failed/.test(p.message))).toBe(true);
    failing = false;
    expect(s.runOnce().ran).toBe(true);
    expect(s.status().lastError).toBeNull();
    expect(s.status().lastSuccessMs).not.toBeNull();
    expect(s.status().failures).toBe(1);
  }, LONG);
});

describe('news moves real prices — once', () => {
  const MARKS_SEED = SEED;

  it('stopping and restarting in the middle of the news gives exactly the prices, candles, news and price records an uninterrupted market has', () => {
    const hours = 7;
    const a = rig();
    const wa = a.open({ news: factory(a) });
    a.clock.advanceSeconds(hours * 3600);
    wa.world.advanceTo(wa.world.currentTick(), Infinity);

    const b = rig();
    const first = b.open({ news: factory(b) });
    b.clock.advanceSeconds(3 * 3600 + 1234); // not on a boundary: a crash with unsaved ticks
    first.world.advanceTo(first.world.currentTick(), Infinity);
    first.db.close();
    b.clock.advanceSeconds(hours * 3600 - (3 * 3600 + 1234));
    const second = b.open({ news: factory(b) });

    expect(second.world.sim.tick).toBe(wa.world.sim.tick);
    expect(priceVector(second.world)).toEqual(priceVector(wa.world));
    expect(newsRows(second.db)).toBe(newsRows(wa.db));
    expect(JSON.stringify(second.db.all('SELECT * FROM candles_c10 ORDER BY company_id, idx'))).toBe(JSON.stringify(wa.db.all('SELECT * FROM candles_c10 ORDER BY company_id, idx')));
    const marked = wa.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM news_items WHERE price_at_end IS NOT NULL')?.n ?? 0;
    expect(marked).toBeGreaterThan(5); // the test really had stories that started and finished inside the window
  }, LONG);

  it('three days of downtime: all the missed news is written and applied, and the market equals one that never stopped', () => {
    const a = rig();
    const wa = a.open({ news: factory(a) });
    a.clock.advanceSeconds(3 * 86400);
    wa.world.advanceTo(wa.world.currentTick(), Infinity);

    const b = rig();
    const first = b.open({ news: factory(b) });
    b.clock.advanceSeconds(600);
    first.world.advanceTo(first.world.currentTick(), Infinity);
    first.db.close();
    b.clock.advanceSeconds(3 * 86400 - 600); // the computer is off; nobody is generating anything
    const second = b.open({ news: factory(b) });

    expect(second.world.sim.tick).toBe(wa.world.sim.tick);
    expect(priceVector(second.world)).toEqual(priceVector(wa.world));
    expect(newsRows(second.db)).toBe(newsRows(wa.db));
    const per = second.db.all<{ cycle: number; company_id: number; n: number }>('SELECT cycle, company_id, COUNT(*) AS n FROM news_items WHERE company_id IS NOT NULL AND slot < 3 GROUP BY cycle, company_id');
    for (const cycle of [0, 1, 2, 3]) expect(per.filter((x) => x.cycle === cycle && x.n >= 3)).toHaveLength(12);
    expect(second.world.health().ok).toBe(true);
  }, LONG);

  it('each recorded price outcome equals an independent replay of the market from stored news; each event is applied once and moves its stock', () => {
    const days = 4;
    const a = rig();
    const run = a.open({ news: factory(a) });
    a.clock.advanceSeconds((days - 1) * 86400 + 3600);
    run.world.advanceTo(run.world.currentTick(), Infinity);
    const finalTick = run.world.sim.tick;

    const events = (run.news as NewsService).eventsStartingIn(0, finalTick + 10 * TICKS_PER_DAY);
    expect(events.length).toBeGreaterThan(100);
    const companies = buildCatalog(12);
    const rows = run.db.all<{ key: string; company_id: number; publish_tick: number; start_tick: number; end_tick: number; realized: number; price_at_publish: number | null; price_at_end: number | null }>(
      'SELECT key, company_id, publish_tick, start_tick, end_tick, realized, price_at_publish, price_at_end FROM news_items WHERE company_id IS NOT NULL ORDER BY key',
    );
    const wantTicks = new Set<number>();
    for (const r of rows) {
      wantTicks.add(Math.max(r.publish_tick - 1, 0));
      wantTicks.add(r.end_tick - 1);
    }
    const ticks = [...wantTicks].filter((t) => t <= finalTick).sort((x, y) => x - y);

    const replay = (withNews: boolean): Map<number, number[]> => {
      const sim = new WorldSim(MARKS_SEED, companies, run.world.calmFrom); // the same calmer stocks the server has
      const book = new EffectBook(withNews ? events.flatMap((e) => effectsOf(e, companies)) : []);
      const out = new Map<number, number[]>();
      let k = 0;
      const record = (): void => {
        while (k < ticks.length && (ticks[k] as number) === sim.tick) {
          out.set(sim.tick, Array.from(sim.P));
          k += 1;
        }
      };
      record();
      while (sim.tick < finalTick) {
        sim.step(book);
        record();
      }
      return out;
    };
    const withNews = replay(true);
    const without = replay(false);

    // The final state of the replay is the final state of the server.
    let verified = 0;
    let signed = 0;
    let n = 0;
    let right = 0;
    for (const r of rows) {
      const pubTick = Math.max(r.publish_tick - 1, 0);
      const endTick = r.end_tick - 1;
      if (r.price_at_publish !== null) {
        expect(r.price_at_publish).toBe((withNews.get(pubTick) as number[])[r.company_id]);
        verified += 1;
      }
      if (r.price_at_end !== null) {
        expect(r.price_at_end).toBe((withNews.get(endTick) as number[])[r.company_id]);
        verified += 1;
      }
      // Marks that are still unwritten belong to ticks the server has not saved yet; all older ones must be there.
      if (endTick <= run.world.savedTick) expect(r.price_at_end).not.toBeNull();
      if (pubTick <= run.world.savedTick) expect(r.price_at_publish).not.toBeNull();
      if (r.price_at_publish !== null && r.price_at_end !== null && endTick <= finalTick) {
        const w0 = (withNews.get(pubTick) as number[])[r.company_id] as number;
        const w1 = (withNews.get(endTick) as number[])[r.company_id] as number;
        const n0 = (without.get(pubTick) as number[])[r.company_id] as number;
        const n1 = (without.get(endTick) as number[])[r.company_id] as number;
        // Compare the stock's change with the news to its change without any news, so market noise cancels out.
        const lift = Math.log(w1 / w0) - Math.log(n1 / n0);
        signed += Math.sign(r.realized) * lift;
        n += 1;
        if (Math.sign(r.realized) * lift > 0) right += 1;
      }
    }
    if (process.env.TQ_VERBOSE) console.log(`replay check: ${verified} recorded prices matched, ${n} finished stories, mean signed lift ${(signed / n * 100).toFixed(3)}%, ${right} of ${n} moved the way their hidden outcome said`);
    expect(verified).toBeGreaterThan(150);
    expect(n).toBeGreaterThan(60);
    // News pushes in the direction of its real outcome on average, but not every time (other news and noise interfere).
    expect(signed / n).toBeGreaterThan(0);
    expect(right / n).toBeGreaterThan(0.9); // measured against the same market without news, the push follows the hidden outcome
    // ...but the headline does not always agree with that outcome: some good-sounding news disappoints, some bad news is shrugged off.
    const misleading = run.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM news_items WHERE company_id IS NOT NULL AND ((direction = 'positive' AND realized < 0) OR (direction = 'negative' AND realized > 0))")?.n ?? 0;
    const directional = run.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM news_items WHERE company_id IS NOT NULL AND direction <> 'uncertain'")?.n ?? 1;
    expect(misleading).toBeGreaterThan(0);
    expect(misleading / directional).toBeLessThan(0.4);
    // Prices really differ from a market without news.
    const last = finalTick;
    expect(priceVector(run.world)).not.toEqual(Array.from(new WorldSim(MARKS_SEED, companies).P));
    expect(last).toBeGreaterThan(0);
  }, LONG);

  it('a new company listed at a restart gets its news and starts trading with it', () => {
    const r = rig();
    const first = r.open({ companyCount: 12, news: factory(r) });
    first.db.close();
    r.clock.advanceSeconds(60);
    const second = r.open({ companyCount: 14, news: factory(r) });
    const listing = second.world.companies[13]!.listingTick;
    r.clock.advanceSeconds(listing - second.world.sim.tick + 3 * 3600);
    second.world.advanceTo(second.world.currentTick(), Infinity);
    for (const id of [12, 13]) {
      const rows = second.db.all<{ category: string; publish_tick: number }>('SELECT category, publish_tick FROM news_items WHERE company_id = ? AND slot < 3', id);
      expect(rows.length).toBeGreaterThanOrEqual(3);
      for (const x of rows) expect(x.publish_tick).toBeGreaterThanOrEqual(second.world.companies[id]!.listingTick);
    }
    expect(second.world.health().ok).toBe(true);
  }, LONG);

  it('if the news cannot be written the market stops visibly, writes nothing half-way, and carries on once it can be written again', () => {
    let failing = false;
    const r = rig();
    const run = r.open({ news: factory(r, (cycle) => { if (failing && cycle >= 2) throw new Error('disk full'); }) });
    const start = run.world.sim.tick;
    failing = true;
    r.clock.advanceSeconds(2 * 86400);
    for (let i = 0; i < 2000 && run.world.health().stalled === null; i += 1) run.world.pump();
    expect(run.world.health().ok).toBe(false);
    expect(run.world.health().stalled).toMatch(/disk full/);
    expect(run.world.sim.tick).toBeGreaterThan(start);
    expect(run.world.sim.tick).toBeLessThan(run.world.currentTick());
    expect(run.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM news_items WHERE cycle >= 2')?.n).toBe(0);
    const stuck = run.world.sim.tick;
    run.world.pump();
    expect(run.world.sim.tick).toBe(stuck);
    failing = false;
    for (let i = 0; i < 40 && run.world.sim.tick < run.world.currentTick(); i += 1) run.world.pump();
    run.world.advanceTo(run.world.currentTick(), Infinity);
    expect(run.world.health().stalled).toBeNull();
    expect(run.world.health().ok).toBe(true);
    expect(run.world.sim.tick).toBe(run.world.currentTick());
    const per = run.db.all<{ n: number }>('SELECT COUNT(*) AS n FROM news_items WHERE cycle = 2 AND slot < 3 AND company_id IS NOT NULL GROUP BY company_id');
    expect(per).toHaveLength(12);
    for (const p of per) expect(p.n).toBe(3);
  }, LONG);
});
