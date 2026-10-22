// Market bots that react (docs/world.md §9.11): what they may read, when they may read it, how each style follows or fades it, and what they do in the real market.
// The first part tests the reader (server/marketSignals.ts) on its own on stored stories; the second part runs bots in a whole server.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TICKS_PER_DAY, buildCatalog, earningsOutcome, figuresFor, type Company } from '../src/world';
import { createApp, type App } from '../server/app';
import { loadConfig } from '../server/config';
import { Earnings } from '../server/earnings';
import { Logger } from '../server/log';
import { MARKET_REACTIONS, MARKET_STYLES, type Decision } from '../server/marketBots';
import { CROWD_MIN_TILT, CROWD_SCALE, MARKET_WEIGHT, MarketSignals, PARTNER_WEIGHT, SECTOR_WEIGHT, STRENGTH_WEIGHT, VALUE_MIN_GAP, VALUE_SCALE, delayFor, fade, mix, surpriseWeight, type Reaction } from '../server/marketSignals';
import { PERSONAS } from '../server/lobby/bots';
import { NewsService } from '../server/news/service';
import { migrate } from '../server/schema';
import { Db } from '../server/sqlite';
import { Clock, START_MS, makeRig, type Rig } from './helpers/server';

const LONG = 480_000;
const SEED = 424242;
const rigs: Rig[] = [];
const running: { app: App; server: Server; dir: string }[] = [];
const dirs: string[] = [];
afterEach(async () => {
  while (rigs.length > 0) rigs.pop()?.cleanup();
  while (running.length > 0) {
    const r = running.pop() as { app: App; server: Server };
    await new Promise<void>((done) => {
      r.server.closeAllConnections?.();
      r.server.close(() => done());
    });
    try {
      r.app.close();
    } catch {
      // closed already
    }
  }
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const FOLLOW: Reaction = { news: 'follow', earnings: 'follow', crowd: 'ignore', minScore: 0.5, delay: [0, 0], window: 3600, attention: 1, exitOnNews: false };
const FADE: Reaction = { ...FOLLOW, news: 'fade', earnings: 'fade' };

interface Row {
  id: number;
  company_id: number;
  partner_id: number | null;
  sector: string | null;
  scope: string;
  category: string;
  publish_tick: number;
  direction: string;
  strength: string;
}

function setup(tiltOf: (c: Company, tick: number) => number = () => 0) {
  const r = makeRig();
  rigs.push(r);
  const db = new Db(r.path);
  r.opened.push(db);
  migrate(db);
  const companies = buildCatalog(40);
  const news = new NewsService({ db, log: r.log, now: r.clock.now });
  news.bind({ worldSeed: SEED, companies });
  news.ensureThrough(10 * TICKS_PER_DAY - 1);
  const earnings = new Earnings(db, { seed: SEED, companies, msOfTick: (t) => START_MS + t * 1000, priceOf: (id) => (companies[id] as Company).basePriceCents });
  const signals = new MarketSignals({ db, earnings, companies: () => companies, tilt: tiltOf });
  const stories = (where: string, ...params: (string | number)[]) =>
    db.all<Row>(`SELECT id, company_id, partner_id, sector, scope, category, publish_tick, direction, strength FROM news_items WHERE ${where} ORDER BY publish_tick, id`, ...params);
  /** Leaves exactly one story in the table. */
  const only = (id: number) => db.run('DELETE FROM news_items WHERE id != ?', id);
  return { db, companies, earnings, signals, stories, only };
}

const none: ReadonlySet<number> = new Set();

describe('what a bot may read', () => {
  it('BREACT-1: the reader and the bots never touch the hidden columns of a story (the hidden move, the permanent share, the source credibility)', () => {
    const strip = (file: string): string =>
      readFileSync(resolve(process.cwd(), 'server', file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
    for (const file of ['marketSignals.ts', 'marketBots.ts']) {
      const code = strip(file);
      for (const word of ['realized', 'perm_share', 'permShare', 'credibility', 'price_at_end']) expect(code.includes(word) ? `${file} mentions ${word}` : '').toBe('');
    }
    expect(strip('marketBots.ts').includes('news_items')).toBe(false);
    // The one place that reads stories names its columns.
    const code = strip('marketSignals.ts');
    expect(code).toContain('SELECT id, company_id, partner_id, sector, scope, category, publish_tick, direction, strength FROM news_items');
    expect(code.includes('SELECT *')).toBe(false);
  });

  it('BREACT-2: a story counts from the tick it is published plus the bot\'s own short delay, never before, and not after its window; the delay is the same on every run', () => {
    const { signals, stories, only } = setup();
    const s = stories("scope = 'company' AND category != 'earnings' AND direction = 'positive' AND strength IN ('moderate','major') AND publish_tick > ?", 2 * TICKS_PER_DAY)[0] as Row;
    only(s.id);
    const react: Reaction = { ...FOLLOW, delay: [5, 25], window: 300 };
    const userId = 7;
    const wait = delayFor(userId, s.id, react.delay);
    expect(wait).toBeGreaterThanOrEqual(5);
    expect(wait).toBeLessThanOrEqual(25);
    expect(delayFor(userId, s.id, react.delay)).toBe(wait);
    const reads = (tick: number) => signals.candidates(react, userId, tick, none).filter((c) => c.stories.includes(s.id));
    expect(reads(s.publish_tick - 1)).toHaveLength(0);
    expect(reads(s.publish_tick)).toHaveLength(wait === 0 ? 1 : 0);
    expect(reads(s.publish_tick + wait - 1)).toHaveLength(0);
    const at = reads(s.publish_tick + wait);
    expect(at).toHaveLength(1);
    expect(at[0]).toMatchObject({ companyId: s.company_id, dir: 1, why: 'news' });
    expect(reads(s.publish_tick + 300)).toHaveLength(1);
    expect(reads(s.publish_tick + 301)).toHaveLength(0);
    // A story the bot has already acted on is not acted on again.
    expect(signals.candidates(react, userId, s.publish_tick + wait, new Set([s.id])).filter((c) => c.stories.includes(s.id))).toHaveLength(0);
    // Different bots wait different times for the same story, and the same bot waits different times for different stories.
    const waits = new Set<number>();
    for (let u = 1; u <= 40; u += 1) waits.add(delayFor(u, s.id, [0, 100]));
    expect(waits.size).toBeGreaterThan(20);
    expect(new Set([...Array(40).keys()].map((i) => mix(3, i, 1000))).size).toBeGreaterThan(30);
  });

  it('BREACT-3: nothing that is not published yet is ever read: at no tick does any candidate rest on a story whose publish tick is still to come', () => {
    const { signals, db } = setup();
    const publish = new Map(db.all<{ id: number; publish_tick: number }>('SELECT id, publish_tick FROM news_items').map((r) => [r.id, r.publish_tick]));
    let checked = 0;
    for (let tick = 2 * TICKS_PER_DAY; tick < 6 * TICKS_PER_DAY; tick += 977) {
      for (const react of [FOLLOW, FADE, { ...FOLLOW, minScore: 0.1, window: 20_000 }]) {
        for (const c of signals.candidates(react, 3, tick, none)) {
          for (const id of c.stories) {
            expect(publish.get(id) as number).toBeLessThanOrEqual(tick);
            checked += 1;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('BREACT-4: what is hidden makes no difference: turning the hidden move, the permanent share and the credibility of every story around changes nothing a bot sees', () => {
    const a = setup();
    const b = setup();
    b.db.run('UPDATE news_items SET realized = -realized * 3, perm_share = 1 - perm_share, credibility = CASE WHEN credibility IS NULL THEN NULL ELSE 1 - credibility END');
    let compared = 0;
    for (let tick = 2 * TICKS_PER_DAY; tick < 5 * TICKS_PER_DAY; tick += 1301) {
      const x = a.signals.candidates({ ...FOLLOW, minScore: 0.1, window: 7200 }, 5, tick, none);
      const y = b.signals.candidates({ ...FOLLOW, minScore: 0.1, window: 7200 }, 5, tick, none);
      expect(y).toEqual(x);
      compared += x.length;
    }
    expect(compared).toBeGreaterThan(50);
  });
});

describe('how a bot reads a story', () => {
  it('BREACT-5: following buys good news and sells bad news, fading does the opposite, an unclear story counts for nothing, and a bigger story counts for more', () => {
    const { db, signals, stories, only } = setup();
    const s = stories("scope = 'company' AND category != 'earnings' AND publish_tick > ?", 2 * TICKS_PER_DAY)[0] as Row;
    only(s.id);
    const tick = s.publish_tick;
    const score = (react: Reaction): { dir: number; score: number } | undefined => {
      signals.forget();
      const c = signals.candidates(react, 1, tick, none).find((x) => x.companyId === s.company_id);
      return c ? { dir: c.dir, score: c.score } : undefined;
    };
    for (const strength of ['minor', 'moderate', 'major', 'extreme']) {
      db.run("UPDATE news_items SET direction = 'positive', strength = ? WHERE id = ?", strength, s.id);
      expect(score(FOLLOW)).toEqual({ dir: 1, score: STRENGTH_WEIGHT[strength] });
      expect(score(FADE)).toEqual({ dir: -1, score: STRENGTH_WEIGHT[strength] });
      db.run("UPDATE news_items SET direction = 'negative' WHERE id = ?", s.id);
      expect(score(FOLLOW)).toEqual({ dir: -1, score: STRENGTH_WEIGHT[strength] });
      expect(score(FADE)).toEqual({ dir: 1, score: STRENGTH_WEIGHT[strength] });
    }
    db.run("UPDATE news_items SET direction = 'uncertain', strength = 'extreme' WHERE id = ?", s.id);
    expect(score(FOLLOW)).toBeUndefined();
    expect(score(FADE)).toBeUndefined();
    // A style that ignores news sees none; the smallest score that moves a bot is a threshold.
    db.run("UPDATE news_items SET direction = 'positive', strength = 'moderate' WHERE id = ?", s.id);
    expect(score({ ...FOLLOW, news: 'ignore' })).toBeUndefined();
    expect(score({ ...FOLLOW, minScore: 2 })).toEqual({ dir: 1, score: 2 });
    expect(score({ ...FOLLOW, minScore: 2.01 })).toBeUndefined();
  });

  it('BREACT-6: a story about a partner, a sector or the whole market reaches the other companies, with less weight; a coin ignores the market\'s news', () => {
    const { db, companies, signals, stories, only } = setup();
    const tickOf = (row: Row) => row.publish_tick;
    // The rows are looked up first: `only` empties the table of the others.
    const sec = stories("scope = 'sector' AND publish_tick > ?", 2 * TICKS_PER_DAY)[0] as Row;
    const mk = stories("scope = 'market' AND publish_tick > ?", 2 * TICKS_PER_DAY)[0] as Row;
    // Partner stories.
    const p = stories("scope = 'company+partner' AND partner_id IS NOT NULL AND category != 'earnings' AND publish_tick > ?", 2 * TICKS_PER_DAY)[0];
    if (p) {
      only(p.id);
      db.run("UPDATE news_items SET direction = 'positive', strength = 'major' WHERE id = ?", p.id);
      const cs = signals.candidates(FOLLOW, 1, tickOf(p), none);
      expect(cs.find((c) => c.companyId === p.company_id)?.score).toBe(4);
      expect(cs.find((c) => c.companyId === p.partner_id)?.score).toBeCloseTo(4 * PARTNER_WEIGHT, 9);
    }
    // Sector stories.
    const { db: db2, signals: sig2, only: only2 } = setup();
    only2(sec.id);
    db2.run("UPDATE news_items SET direction = 'negative', strength = 'major' WHERE id = ?", sec.id);
    const cs2 = sig2.candidates(FOLLOW, 1, sec.publish_tick, none);
    const inSector = companies.filter((c) => c.sector === sec.sector && c.listingTick <= sec.publish_tick);
    expect(inSector.length).toBeGreaterThan(0);
    expect(cs2.map((c) => c.companyId).sort((a, b) => a - b)).toEqual(inSector.map((c) => c.id).sort((a, b) => a - b));
    for (const c of cs2) expect(c).toMatchObject({ dir: -1, score: 4 * SECTOR_WEIGHT });
    // Market stories.
    const { db: db3, signals: sig3, only: only3 } = setup();
    only3(mk.id);
    db3.run("UPDATE news_items SET direction = 'positive', strength = 'extreme' WHERE id = ?", mk.id);
    const cs3 = sig3.candidates({ ...FOLLOW, minScore: 1 }, 1, mk.publish_tick, none);
    expect(cs3.length).toBeGreaterThan(20);
    for (const c of cs3) {
      expect(companies[c.companyId]?.sector).not.toBe('meme');
      expect(c.score).toBeCloseTo(6 * MARKET_WEIGHT, 9);
    }
  });

  it('BREACT-7: an old story counts for less (down to half at the end of its window)', () => {
    expect(fade(0, 600)).toBe(1);
    expect(fade(300, 600)).toBe(0.75);
    expect(fade(600, 600)).toBe(0.5);
    expect(fade(9999, 600)).toBe(0.5);
    const { db, signals, stories, only } = setup();
    const s = stories("scope = 'company' AND category != 'earnings' AND publish_tick > ?", 2 * TICKS_PER_DAY)[0] as Row;
    only(s.id);
    db.run("UPDATE news_items SET direction = 'positive', strength = 'extreme' WHERE id = ?", s.id);
    const react = { ...FOLLOW, window: 600 };
    const at = (age: number) => signals.candidates(react, 1, s.publish_tick + age, none).find((c) => c.companyId === s.company_id)?.score as number;
    expect(at(0)).toBe(6);
    expect(at(300)).toBe(4.5);
    expect(at(600)).toBe(3);
  });
});

describe('how a bot reads earnings, value and the crowd', () => {
  it('BREACT-8: a report is read from its figures: a beat counts for buying, a miss for selling, in line for nothing, bigger surprises count more', () => {
    const { signals, stories, companies, db } = setup();
    const reports = stories("category = 'earnings' AND scope = 'company' AND publish_tick > ?", 2 * TICKS_PER_DAY);
    let beats = 0;
    let misses = 0;
    let inline = 0;
    let checked = 0;
    const weights = new Set<number>();
    for (const r of reports) {
      const c = companies[r.company_id] as Company;
      const out = earningsOutcome(SEED, c, db.get<{ cycle: number }>('SELECT cycle FROM news_items WHERE id = ?', r.id)?.cycle as number);
      if (!out) continue;
      const cycle = (db.get<{ cycle: number }>('SELECT cycle FROM news_items WHERE id = ?', r.id) as { cycle: number }).cycle;
      const f = figuresFor(SEED, c, cycle, out);
      const expected = surpriseWeight(f.kind, f.epsBp, f.revBp);
      // Alone in its table, a report read at its own tick is worth exactly its weight.
      const { signals: s1, only } = setup();
      only(r.id);
      const found = s1.candidates({ ...FOLLOW, minScore: 0.01 }, 1, r.publish_tick, none).find((x) => x.companyId === r.company_id);
      if (expected === 0) {
        expect(found).toBeUndefined();
        inline += 1;
      } else {
        expect(found).toMatchObject({ dir: expected > 0 ? 1 : -1, why: 'earnings' });
        expect(found?.score).toBeCloseTo(Math.abs(expected), 9);
        weights.add(Math.abs(expected));
        if (expected > 0) beats += 1;
        else misses += 1;
      }
      // Fading a report is the opposite.
      const faded = s1.candidates({ ...FADE, minScore: 0.01 }, 1, r.publish_tick, none).find((x) => x.companyId === r.company_id);
      if (expected !== 0) expect(faded?.dir).toBe(expected > 0 ? -1 : 1);
      checked += 1;
      if (checked >= 24) break;
    }
    expect(signals).toBeDefined();
    expect(beats).toBeGreaterThan(2);
    expect(misses).toBeGreaterThan(2);
    expect(weights.size).toBeGreaterThan(1);
    expect(inline + beats + misses).toBe(checked);
    // The weights themselves.
    expect(surpriseWeight('inline', 0, 0)).toBe(0);
    expect(surpriseWeight('beat', 250, 100)).toBe(1);
    expect(surpriseWeight('beat', 500, 100)).toBe(2);
    expect(surpriseWeight('miss', -1000, -100)).toBe(-4);
    expect(surpriseWeight('miss', -2500, -300)).toBe(-6);
    expect(surpriseWeight('epsBeatRevMiss', 1000, -300)).toBe(2);
    expect(surpriseWeight('epsMissRevBeat', -1000, 300)).toBe(-2);
  }, LONG);

  it('BREACT-9: value: a stock cheaper than its sector\'s middle price/earnings ratio is a buy, the more the cheaper; dear stocks and sectors with fewer than three stocks are not', () => {
    const { signals, earnings, companies } = setup();
    const tick = 5 * TICKS_PER_DAY;
    const gaps = earnings.relativePe(tick);
    expect(gaps.size).toBeGreaterThan(20);
    let cheap = 0;
    for (const [id, gap] of gaps) {
      expect(gap).toBeGreaterThan(-0.95);
      expect(gap).toBeLessThan(4);
      expect(companies[id]?.sector).not.toBe('meme');
      if (gap <= -VALUE_MIN_GAP) cheap += 1;
    }
    expect(cheap).toBeGreaterThan(0);
    // The middle of each sector is at zero: some above, some below.
    const bySector = new Map<string, number[]>();
    for (const [id, gap] of gaps) bySector.set(companies[id]?.sector as string, [...(bySector.get(companies[id]?.sector as string) ?? []), gap]);
    for (const list of bySector.values()) {
      expect(list.length).toBeGreaterThanOrEqual(3);
      expect(Math.min(...list)).toBeLessThanOrEqual(1e-9);
      expect(Math.max(...list)).toBeGreaterThanOrEqual(-1e-9);
    }
    const value: Reaction = { ...FOLLOW, news: 'ignore', earnings: 'value', minScore: 0.01 };
    const found = signals.candidates(value, 1, tick, none);
    expect(found.length).toBe(cheap);
    for (const c of found) {
      expect(c).toMatchObject({ dir: 1, why: 'value' });
      expect(c.score).toBeCloseTo(-(gaps.get(c.companyId) as number) * VALUE_SCALE, 9);
    }
    // The smallest score decides how cheap is cheap enough.
    expect(signals.candidates({ ...value, minScore: 3 }, 1, tick, none).every((c) => (gaps.get(c.companyId) as number) <= -0.3)).toBe(true);
    // A style that does not look at value sees none.
    expect(signals.candidates({ ...value, earnings: 'ignore' }, 1, tick, none)).toHaveLength(0);
  });

  it('BREACT-10: the crowd: following goes with the book\'s tilt, fading goes against it, a small tilt is no crowd', () => {
    const tilts = new Map<number, number>();
    const { signals, companies } = setup((c) => tilts.get(c.id) ?? 0);
    const stocks = companies.filter((c) => c.sector !== 'meme' && c.listingTick === 0);
    const [a, b, c] = stocks as [Company, Company, Company];
    tilts.set(a.id, 0.5);
    tilts.set(b.id, -0.4);
    tilts.set(c.id, CROWD_MIN_TILT - 0.01);
    const tick = 3 * TICKS_PER_DAY;
    const follow = signals.candidates({ ...FOLLOW, news: 'ignore', earnings: 'ignore', crowd: 'follow', minScore: 0.5 }, 1, tick, none);
    expect(follow.map((x) => [x.companyId, x.dir, x.why])).toEqual([
      [a.id, 1, 'crowd'],
      [b.id, -1, 'crowd'],
    ]);
    expect(follow[0]?.score).toBeCloseTo(0.5 * CROWD_SCALE, 9);
    // The lookup is made once per tick, so a new reader is used for the next reading.
    const fresh = setup((cc) => tilts.get(cc.id) ?? 0);
    const fade2 = fresh.signals.candidates({ ...FOLLOW, news: 'ignore', earnings: 'ignore', crowd: 'fade', minScore: 0.5 }, 1, tick, none);
    expect(fade2.map((x) => [x.companyId, x.dir])).toEqual([
      [a.id, -1],
      [b.id, 1],
    ]);
    const ignore = setup((cc) => tilts.get(cc.id) ?? 0).signals.candidates({ ...FOLLOW, news: 'ignore', earnings: 'ignore', crowd: 'ignore', minScore: 0.01 }, 1, tick, none);
    expect(ignore).toHaveLength(0);
  });

  it('BREACT-11: signals add up: good news and a crowd that is buying agree, good news and a selling crowd pull apart, and the reason named is the bigger part', () => {
    const tilts = new Map<number, number>();
    const { db, signals, stories, only } = setup((c) => tilts.get(c.id) ?? 0);
    const s = stories("scope = 'company' AND category != 'earnings' AND publish_tick > ?", 2 * TICKS_PER_DAY)[0] as Row;
    only(s.id);
    db.run("UPDATE news_items SET direction = 'positive', strength = 'moderate' WHERE id = ?", s.id);
    const react: Reaction = { ...FOLLOW, crowd: 'follow', minScore: 0.1 };
    const read = (tick: number) => signals.candidates(react, 1, tick, none).find((x) => x.companyId === s.company_id);
    tilts.set(s.company_id, 0.5);
    expect(read(s.publish_tick)).toMatchObject({ dir: 1, why: 'crowd' });
    expect(read(s.publish_tick)?.score).toBeCloseTo(2 * fade(0, 3600) + 3, 9);
    tilts.set(s.company_id, -0.2);
    expect(read(s.publish_tick + 1)).toMatchObject({ dir: 1, why: 'news' });
    expect(read(s.publish_tick + 1)?.score).toBeCloseTo(2 * fade(1, 3600) - 1.2, 9);
    tilts.set(s.company_id, -0.5);
    expect(read(s.publish_tick + 2)).toMatchObject({ dir: -1, why: 'crowd' });
  });
});

describe('the eight styles', () => {
  it('BREACT-12: every style has a reaction and the table is sane', () => {
    for (const p of PERSONAS) {
      const r = MARKET_REACTIONS[p.id] as Reaction;
      expect(r ? p.id : `${p.id} has no reaction`).toBe(p.id);
      expect(MARKET_STYLES[p.id]).toBeDefined();
      expect(r.delay[0]).toBeGreaterThanOrEqual(0);
      expect(r.delay[1]).toBeGreaterThanOrEqual(r.delay[0]);
      // A bot may wait for a story only while the story is still worth acting on.
      expect(r.window).toBeGreaterThan(r.delay[1]);
      expect(r.attention).toBeGreaterThan(0);
      expect(r.attention).toBeLessThanOrEqual(1);
      expect(r.minScore).toBeGreaterThanOrEqual(1);
      expect(Object.keys(r).sort()).toEqual(['attention', 'crowd', 'delay', 'earnings', 'exitOnNews', 'minScore', 'news', 'window']);
    }
    // The characters: Rex needs a big story, Sam only reads reports, Hank looks for value, Carl and Hank fade, the others follow.
    expect(MARKET_REACTIONS.rex?.minScore).toBeGreaterThan(2);
    expect(MARKET_REACTIONS.sam?.minScore).toBeGreaterThan(2);
    expect(MARKET_REACTIONS.sam).toMatchObject({ news: 'ignore', earnings: 'follow' });
    expect(MARKET_REACTIONS.hank?.earnings).toBe('value');
    expect(MARKET_REACTIONS.carl).toMatchObject({ news: 'fade', crowd: 'fade' });
    expect(MARKET_REACTIONS.shane).toMatchObject({ news: 'follow', crowd: 'fade' });
    for (const id of ['mia', 'dee', 'rex', 'luna']) expect(MARKET_REACTIONS[id]?.news).toBe('follow');
    // The fast ones react in seconds, the patient ones in minutes.
    expect((MARKET_REACTIONS.rex as Reaction).delay[1]).toBeLessThanOrEqual(15);
    expect((MARKET_REACTIONS.carl as Reaction).delay[0]).toBeGreaterThanOrEqual(60);
  });
});

// ---- in a whole server -------------------------------------------------------------------------------------------------------

interface Running {
  app: App;
  base: string;
  clock: Clock;
  dir: string;
}
async function boot(): Promise<Running> {
  const dir = mkdtempSync(join(tmpdir(), 'tq-react-'));
  dirs.push(dir);
  const clock = new Clock();
  const config = loadConfig({ TQ_DATA_DIR: dir, TQ_COMPANIES: '66', TQ_WARMUP_DAYS: '1', TQ_PORT: '8787', TQ_OWNER: 'boss' });
  const app = createApp({ config, log: new Logger({ sink: null, now: clock.now }), worldSeed: 777, now: clock.now, marketBots: true, memecoins: true });
  const server = createServer(app.handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  running.push({ app, server, dir });
  return { app, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, clock, dir };
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
function gotoTick(r: Running, tick: number): void {
  const w = r.app.services.world;
  while (w.currentTick() < tick) {
    const next = Math.min(tick, w.currentTick() + 2);
    r.clock.ms = w.msOfTick(next);
    for (let i = 0; i < 20_000 && w.sim.tick < w.currentTick(); i += 1) w.pump();
  }
  expect(w.sim.tick).toBe(tick);
}
const elapse = (r: Running, seconds: number) => gotoTick(r, r.app.services.world.currentTick() + seconds);
let counter = 0;
const rid = (): string => `react-${(counter += 1).toString().padStart(8, '0')}`;
const decisions = (r: Running): readonly Decision[] => (r.app.marketBots as NonNullable<App['marketBots']>).decisions();

describe('in the market', () => {
  it('BREACT-13: after a big good story about a stock the fast followers buy it and none of the sellers does; after a big bad story the sellers short it and the dip buyers buy; each reads it only once', async () => {
    const r = await boot();
    const boss = await signUp(r, 'boss');
    const { world, db } = r.app.services;
    await elapse(r, 400); // the bots find their feet
    const stocks = world.companies.filter((c) => c.sector !== 'meme' && world.sim.isListed(c.id));
    const good = stocks[5] as Company;
    const bad = stocks[17] as Company;
    const startTick = world.sim.tick;
    expect((await call(r, '/api/admin/shock', { method: 'POST', cookie: boss, body: { requestId: rid(), ticker: good.ticker, style: 'pump', percent: 40, speed: 'fast', headline: `${good.name} jumps on a surprise deal` } })).status).toBe(200);
    expect((await call(r, '/api/admin/shock', { method: 'POST', cookie: boss, body: { requestId: rid(), ticker: bad.ticker, style: 'crash', percent: -40, speed: 'fast', headline: `${bad.name} slumps on a recall` } })).status).toBe(200);
    for (let i = 0; i < 12; i += 1) elapse(r, 50);
    const after = decisions(r).filter((d) => d.tick >= startTick);
    const onGood = after.filter((d) => d.companyId === good.id && d.action === 'open' && d.why === 'news');
    const onBad = after.filter((d) => d.companyId === bad.id && d.action === 'open' && d.why === 'news');
    expect(onGood.length).toBeGreaterThan(0);
    expect(onBad.length).toBeGreaterThan(0);
    // Whoever follows a good story buys it; whoever follows a bad story shorts it; the dip buyers buy the bad one.
    for (const d of onGood) {
      expect(d.short).toBe(false);
      expect(['mia', 'rex', 'carl', 'hank', 'dee', 'luna', 'shane', 'sam']).toContain(d.persona);
      // Nobody who only sells acts on good news, and nobody who fades good news (Carl and Hank buy only) acts on it.
      expect(['shane', 'carl', 'hank']).not.toContain(d.persona);
    }
    for (const d of onBad) {
      if (d.persona === 'shane') expect(d.short).toBe(true);
      if (d.persona === 'carl' || d.persona === 'hank') expect(d.short).toBe(false);
      expect(['mia', 'rex', 'sam']).not.toContain(d.persona);
    }
    // Each bot acts on a story once.
    for (const list of [onGood, onBad]) expect(new Set(list.map((d) => d.persona)).size).toBe(list.length);
    // The orders are real trades of the bots' Career accounts.
    const trades = db.all<{ persona: string; side: string; short: number; tick: number }>(
      `SELECT b.persona, t.side, t.short, t.tick FROM trades t JOIN accounts a ON a.id = t.account_id AND a.kind = 'career' JOIN bots b ON b.user_id = a.user_id WHERE t.company_id = ? AND t.tick >= ? ORDER BY t.id`,
      good.id,
      startTick,
    );
    for (const d of onGood) expect(trades.some((t) => t.persona === d.persona && t.side === 'buy' && t.short === 0)).toBe(true);
    // They did not all act in the same second (each has a delay of its own).
    expect(new Set(onGood.map((d) => d.tick)).size).toBeGreaterThan(Math.min(1, onGood.length - 1));
  }, LONG);

  it('BREACT-14: a follower leaves a position early when a big story turns against it, within seconds of its delay, and does not act on that story again', async () => {
    const r = await boot();
    const boss = await signUp(r, 'boss');
    const { world, db } = r.app.services;
    const holding = () =>
      db.get<{ persona: string; company_id: number }>(
        `SELECT b.persona, p.company_id FROM positions p JOIN accounts a ON a.id = p.account_id AND a.kind = 'career' JOIN bots b ON b.user_id = a.user_id
          WHERE p.shares > 0 AND p.short = 0 AND b.persona IN ('mia','rex') ORDER BY p.company_id LIMIT 1`,
      );
    let held = holding();
    for (let i = 0; i < 90 && !held; i += 1) {
      elapse(r, 10);
      held = holding();
    }
    expect(held).toBeDefined();
    if (!held) return;
    const company = world.companies[held.company_id] as Company;
    const tick = world.sim.tick;
    // A long holding time, so that the only reason to leave is the story.
    const bots = r.app.marketBots as any;
    const bot = bots.bots.find((b: any) => b.persona.id === held?.persona);
    bot.plans.get(held.company_id).closeAt = tick + 100_000;
    expect((await call(r, '/api/admin/shock', { method: 'POST', cookie: boss, body: { requestId: rid(), ticker: company.ticker, style: 'crash', percent: -30, speed: 'fast', headline: `${company.name} hit by a recall` } })).status).toBe(200);
    for (let i = 0; i < 16 && decisions(r).filter((d) => d.action === 'early-exit').length === 0; i += 1) elapse(r, 15);
    const exits = decisions(r).filter((d) => d.action === 'early-exit' && d.persona === held?.persona && d.companyId === held?.company_id);
    expect(exits.length).toBe(1);
    expect(exits[0]).toMatchObject({ short: false, why: 'news' });
    const react = (await import('../server/marketBots')).MARKET_REACTIONS[held.persona] as Reaction;
    expect((exits[0] as Decision).tick - tick).toBeLessThanOrEqual(react.delay[1] + 130);
    for (let i = 0; i < 8; i += 1) elapse(r, 5);
    expect(db.get('SELECT 1 AS x FROM positions WHERE company_id = ? AND shares > 0 AND account_id = (SELECT id FROM accounts WHERE kind = \'career\' AND user_id = (SELECT user_id FROM bots WHERE persona = ?))', held.company_id, held.persona)).toBeUndefined();
    // Once only: the same story does not make it leave again, and a long position is not opened on a bad story.
    elapse(r, 300);
    expect(decisions(r).filter((d) => d.action === 'early-exit' && d.persona === held?.persona && d.companyId === held?.company_id)).toHaveLength(1);
    expect(decisions(r).filter((d) => d.action === 'open' && d.persona === held?.persona && d.companyId === held?.company_id && d.why === 'news' && !d.short && d.tick > tick)).toHaveLength(0);
  }, LONG);

  it('BREACT-15: the same world reacts the same way twice', async () => {
    const run = async (): Promise<Decision[]> => {
      const r = await boot();
      const boss = await signUp(r, 'boss');
      await elapse(r, 300);
      const { world } = r.app.services;
      const c = world.companies.filter((x) => x.sector !== 'meme' && world.sim.isListed(x.id))[3] as Company;
      expect((await call(r, '/api/admin/shock', { method: 'POST', cookie: boss, body: { requestId: 'react-fixed-0001', ticker: c.ticker, style: 'pump', percent: 30, speed: 'fast' } })).status).toBe(200);
      for (let i = 0; i < 8; i += 1) elapse(r, 50);
      return [...decisions(r)];
    };
    const first = await run();
    const second = await run();
    expect(first.length).toBeGreaterThan(0);
    expect(second).toEqual(first);
  }, LONG);
});
