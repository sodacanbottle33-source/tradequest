// BM-1 … BM-12 — Black Monday (src/world/blackMonday.ts, server/admin.ts `blackMonday`, docs/world.md §41). Every year on October 19 (Tokyo time) the whole market crashes at a surprise hour and then takes
// about a week to recover. The properties that matter: the calendar arithmetic is right; the hour is a surprise but always inside the day and the same every time it is asked; the crash is
// two ordinary market-wide stories (so the price engine, the news feed and a restart treat them like any other); every company falls (the risky ones more) and then climbs back over about a week;
// a day that was already written is never rewritten; the owner can start it by hand only with a typed confirm, never twice at once, and it is written once to the admin log; and a restart in the
// middle of the recovery changes no price.
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../server/app';
import { loadConfig } from '../server/config';
import { Logger } from '../server/log';
import {
  CRASH_TICKS,
  CRASH_TOTAL,
  EffectBook,
  NEWS_CYCLE_TICKS,
  RECOVERY_TICKS,
  RECOVERY_TOTAL,
  START_WINDOW_SECONDS,
  WorldSim,
  blackMondayDrafts,
  blackMondayPair,
  blackMondayStartMs,
  buildCatalog,
  daysFromCivil,
  effectsOf,
  weightAt,
  yearOfDays,
  type Company,
  type WorldEvent,
} from '../src/world';
import { Clock } from './helpers/server';

const LONG = 400_000;
const SEED = 777;
const DAY_MS = 86_400_000;
const TOKYO_MS = 9 * 3_600_000;
/** The calendar date in Tokyo of an instant. */
const tokyoDate = (ms: number): string => new Date(ms + TOKYO_MS).toISOString().slice(0, 10);
const eventOfDraft = (d: ReturnType<typeof blackMondayPair>[number]): WorldEvent => ({
  key: d.key,
  kind: d.kind,
  scope: d.scope,
  companyId: d.companyId,
  partnerId: d.partnerId,
  sector: d.sector,
  publishTick: d.publishTick,
  startTick: d.startTick,
  durationTicks: d.durationTicks,
  shape: d.shape,
  realized: d.realized,
  permShare: d.permShare,
});

// ---- the world, in a test ---------------------------------------------------------------------------------------------------------------

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

async function boot(options: { dir?: string; clock?: Clock } = {}): Promise<Running> {
  let dir = options.dir;
  if (dir === undefined) {
    dir = mkdtempSync(join(tmpdir(), 'tq-bm-'));
    dirs.push(dir);
  }
  const clock = options.clock ?? new Clock();
  const config = loadConfig({ TQ_DATA_DIR: dir, TQ_COMPANIES: '12', TQ_WARMUP_DAYS: '0', TQ_PORT: '8787', TQ_OWNER: 'boss' });
  const app = createApp({ config, log: new Logger({ sink: null, now: clock.now }), worldSeed: SEED, now: clock.now, flowGain: 0 });
  const server = createServer(app.handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const r = { app, server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, dir, clock };
  running.push(r);
  return r;
}

/** Runs the market up to the test clock (the real timer is not started in these tests). */
function catchUp(r: Running): void {
  const w = r.app.services.world;
  for (let i = 0; i < 400_000 && w.sim.tick < w.currentTick(); i += 1) w.pump();
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
const rid = (): string => `bm-test-${(counter += 1).toString().padStart(6, '0')}`;
const startBm = (r: Running, cookie: string | undefined, body: Record<string, unknown> = {}) => call(r, '/api/admin/black-monday', { method: 'POST', cookie, body: { requestId: rid(), confirm: 'BLACK MONDAY', ...body } });
const db = (r: Running) => r.app.services.db;
const bmRows = (r: Running) =>
  db(r).all<{ key: string; scope: string; source: string; breaking: number; kind: string; category: string; start_tick: number; publish_tick: number; end_tick: number; duration_ticks: number; shape: string; realized: number; perm_share: number; headline: string; body: string; company_id: number | null }>(
    "SELECT key, scope, source, breaking, kind, category, start_tick, publish_tick, end_tick, duration_ticks, shape, realized, perm_share, headline, body, company_id FROM news_items WHERE key LIKE 'bm:%' ORDER BY key",
  );
const prices = (r: Running): number[] => {
  const w = r.app.services.world;
  return Array.from({ length: w.companies.length }, (_, i) => w.sim.price(i));
};
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number;
const ratios = (a: number[], b: number[]): number[] => a.map((x, i) => x / (b[i] as number));
const GENESIS_2027 = Date.UTC(2027, 9, 18, 15, 0, 0); // 00:00 on October 19, 2027 in Tokyo

// ---- the pure part ---------------------------------------------------------------------------------------------------------------------

describe('Black Monday: the calendar and the surprise hour', () => {
  it('BM-1: the calendar arithmetic agrees with the real calendar for every year from 1970 to 2200, leap days and year ends included', () => {
    for (let y = 1970; y <= 2200; y += 1) {
      expect(daysFromCivil(y, 10, 19)).toBe(Date.UTC(y, 9, 19) / DAY_MS);
      expect(daysFromCivil(y, 1, 1)).toBe(Date.UTC(y, 0, 1) / DAY_MS);
      expect(daysFromCivil(y, 12, 31)).toBe(Date.UTC(y, 11, 31) / DAY_MS);
      expect(yearOfDays(Date.UTC(y, 11, 31) / DAY_MS)).toBe(y);
      expect(yearOfDays(Date.UTC(y, 0, 1) / DAY_MS)).toBe(y);
      expect(yearOfDays(Date.UTC(y, 1, 28) / DAY_MS)).toBe(y);
      expect(yearOfDays(Date.UTC(y, 2, 1) / DAY_MS)).toBe(y);
    }
    expect(daysFromCivil(1970, 1, 1)).toBe(0);
    expect(daysFromCivil(2028, 3, 1) - daysFromCivil(2028, 2, 28)).toBe(2); // 2028 is a leap year
    expect(daysFromCivil(2027, 3, 1) - daysFromCivil(2027, 2, 28)).toBe(1);
    expect(daysFromCivil(2100, 3, 1) - daysFromCivil(2100, 2, 28)).toBe(1); // 2100 is not
    for (let d = -400_000; d <= 900_000; d += 997) expect(yearOfDays(d)).toBe(new Date(d * DAY_MS).getUTCFullYear());
  });

  it('BM-2: the crash starts at a surprise second between 00:00 and 17:30 on October 19 in Tokyo, the same every time it is asked, so it is over before the day ends', () => {
    expect(START_WINDOW_SECONDS + CRASH_TICKS).toBe(86_400);
    const seconds = new Set<number>();
    let sum = 0;
    let count = 0;
    for (const seed of [0, 1, 777, 123_456, 4_294_967_295]) {
      for (let year = 2000; year <= 2200; year += 1) {
        const ms = blackMondayStartMs(seed, year);
        const midnight = Date.UTC(year, 9, 19) - TOKYO_MS; // 00:00 on October 19 in Tokyo
        const offset = (ms - midnight) / 1000;
        expect(offset).toBeGreaterThanOrEqual(0);
        expect(offset).toBeLessThan(START_WINDOW_SECONDS);
        expect(Number.isInteger(offset)).toBe(true);
        expect(tokyoDate(ms)).toBe(`${year}-10-19`);
        expect(tokyoDate(ms + CRASH_TICKS * 1000)).toBe(`${year}-10-19`); // the crash is over before October 20 in Tokyo
        expect(ms + CRASH_TICKS * 1000).toBeLessThanOrEqual(midnight + DAY_MS);
        expect(blackMondayStartMs(seed, year)).toBe(ms);
        if (seed === 777) seconds.add(offset);
        sum += offset / START_WINDOW_SECONDS;
        count += 1;
      }
    }
    expect(seconds.size).toBeGreaterThan(190); // a different second nearly every year: a real surprise
    expect(sum / count).toBeGreaterThan(0.4); // spread over the whole window, not bunched at one end
    expect(sum / count).toBeLessThan(0.6);
    expect(blackMondayStartMs(1, 2027)).not.toBe(blackMondayStartMs(2, 2027)); // another world, another surprise
  });
});

describe('Black Monday: the two stories', () => {
  it('BM-3: exactly one pair per year, in the 24-hour news cycle the crash begins in, on October 19 in Tokyo, never for a day before the world began, and nothing on any other cycle', () => {
    const genesis = Date.UTC(2026, 9, 26, 0, 0, 0); // a whole hour, like the real one
    const found: { cycle: number; keys: string[]; startTick: number }[] = [];
    for (let cycle = 0; cycle < 1_500; cycle += 1) {
      const drafts = blackMondayDrafts(SEED, genesis, cycle);
      if (drafts.length === 0) continue;
      found.push({ cycle, keys: drafts.map((d) => d.key), startTick: (drafts[0] as { startTick: number }).startTick });
      for (const d of drafts) {
        expect(d.cycle).toBe(cycle);
        expect(d.startTick).toBeGreaterThanOrEqual(cycle * NEWS_CYCLE_TICKS);
        expect(d.startTick).toBeLessThan((cycle + 1) * NEWS_CYCLE_TICKS);
      }
    }
    expect(found.map((f) => f.keys)).toEqual([
      ['bm:2027:crash', 'bm:2027:recovery'],
      ['bm:2028:crash', 'bm:2028:recovery'],
      ['bm:2029:crash', 'bm:2029:recovery'],
      ['bm:2030:crash', 'bm:2030:recovery'],
    ]);
    found.forEach((f, i) => {
      const year = 2027 + i;
      const ms = genesis + f.startTick * 1000;
      expect(tokyoDate(ms)).toBe(`${year}-10-19`);
      expect(ms).toBe(blackMondayStartMs(SEED, year));
    });
    // A world that began late on October 19 (23:00 in Tokyo) has no crash for that day (it would have happened before tick 0) but has the next year's.
    const late = Date.UTC(2026, 9, 19, 14, 0, 0);
    const lateFound: string[] = [];
    for (let cycle = 0; cycle < 400; cycle += 1) lateFound.push(...blackMondayDrafts(SEED, late, cycle).map((d) => d.key));
    expect(lateFound).toEqual(['bm:2027:crash', 'bm:2027:recovery']);
    // A world that began a week before it does get that year's crash, after its start.
    const early = Date.UTC(2026, 9, 12, 6, 0, 0);
    const earlyFound: { key: string; startTick: number }[] = [];
    for (let cycle = 0; cycle < 30; cycle += 1) earlyFound.push(...blackMondayDrafts(SEED, early, cycle).map((d) => ({ key: d.key, startTick: d.startTick })));
    expect(earlyFound.map((e) => e.key)).toEqual(['bm:2026:crash', 'bm:2026:recovery']);
    expect(earlyFound[0]?.startTick).toBeGreaterThanOrEqual(1);
  });

  it('BM-4: the crash is a fast, front-heavy fall that lasts 6½ hours and the recovery a week-long climb, both market-wide, both permanent, both starting the same tick the story is published', () => {
    const [crash, recovery] = blackMondayPair({ keyBase: 'bm:test', cycle: 5, startTick: 1_000 }) as [ReturnType<typeof blackMondayPair>[number], ReturnType<typeof blackMondayPair>[number]];
    expect(crash.key).toBe('bm:test:crash');
    expect(recovery.key).toBe('bm:test:recovery');
    for (const d of [crash, recovery]) {
      expect(d.scope).toBe('market');
      expect(d.companyId).toBeNull();
      expect(d.partnerId).toBeNull();
      expect(d.sector).toBeNull();
      expect(d.kind).toBe('macro');
      expect(d.shape).toBe('front');
      expect(d.permShare).toBe(1);
      expect(d.startTick).toBe(1_000);
      expect(d.publishTick).toBe(1_000); // the database requires start ≥ publish
      expect(d.cycle).toBe(5);
      expect(d.credibility).toBeNull();
      expect(d.headline.length).toBeGreaterThan(20);
      expect(d.body.length).toBeGreaterThan(60);
      expect(d.headline + d.body).not.toMatch(/\bDow\b|\bNasdaq\b|\bS&P\b|\bNYSE\b/); // no real index or exchange named
    }
    expect(crash.durationTicks).toBe(23_400);
    expect(CRASH_TICKS).toBe(23_400);
    expect(crash.realized).toBe(CRASH_TOTAL);
    expect(crash.direction).toBe('negative');
    expect(crash.strength).toBe('extreme');
    expect(crash.breaking).toBe(true);
    expect(crash.slot).not.toBe(recovery.slot);
    expect(recovery.durationTicks).toBe(604_800);
    expect(RECOVERY_TICKS).toBe(604_800);
    expect(recovery.realized).toBe(RECOVERY_TOTAL);
    expect(recovery.direction).toBe('positive');
    expect(CRASH_TOTAL).toBeLessThan(0);
    expect(RECOVERY_TOTAL).toBeGreaterThan(0);
    expect(RECOVERY_TOTAL).toBeLessThan(-CRASH_TOTAL); // the recovery story alone never lifts a price above where it was: the market's own pull toward its long-run level does the rest
    // What the engine does with a story: every tick the price is multiplied by (1 + total × the tick's weight). The weights add up to 1 and the early ticks weigh most.
    const logProduct = (total: number, ticks: number): number => {
      let sum = 0;
      let weights = 0;
      for (let k = 0; k < ticks; k += 1) {
        const w = weightAt('front', ticks, k);
        weights += w;
        sum += Math.log(1 + total * w);
      }
      expect(weights).toBeCloseTo(1, 9);
      return sum;
    };
    const crashAlone = Math.exp(logProduct(CRASH_TOTAL, CRASH_TICKS));
    const recoveryAlone = Math.exp(logProduct(RECOVERY_TOTAL, RECOVERY_TICKS));
    expect(crashAlone).toBeGreaterThan(0.76);
    expect(crashAlone).toBeLessThan(0.8);
    expect(recoveryAlone).toBeGreaterThan(1.24);
    expect(recoveryAlone).toBeLessThan(1.28);
    expect(crashAlone * recoveryAlone).toBeGreaterThan(0.95); // the two stories together bring a price back to within a few percent of where it was
    expect(crashAlone * recoveryAlone).toBeLessThan(1);
    expect(weightAt('front', CRASH_TICKS, 0)).toBeGreaterThan(weightAt('front', CRASH_TICKS, CRASH_TICKS - 1) * 100);
  });

  it('BM-5: every listed company is hit by both stories by its own beta (memecoins hardest), and a company that lists after the crash began feels neither', () => {
    const base = buildCatalog(12);
    const companies: Company[] = [
      ...base,
      { ...(base[0] as Company), id: 12, ticker: 'COIN', sector: 'meme', beta: 1.6, listingTick: 0 },
      { ...(base[1] as Company), id: 13, ticker: 'LATE', beta: 1, listingTick: 5_000 }, // lists after the crash began
      { ...(base[2] as Company), id: 14, ticker: 'EXACT', beta: 1, listingTick: 1_000 }, // lists on the very tick it began: already trading
    ];
    const [crash, recovery] = blackMondayPair({ keyBase: 'bm:test', cycle: 0, startTick: 1_000 }).map(eventOfDraft) as [WorldEvent, WorldEvent];
    for (const e of [crash, recovery]) {
      const effects = effectsOf(e, companies);
      expect(effects.map((x) => x.companyId)).toEqual(companies.filter((c) => c.id !== 13).map((c) => c.id));
      for (const x of effects) {
        const c = companies[x.companyId] as Company;
        expect(x.total).toBeCloseTo(e.realized * c.beta, 12);
        expect(x.startTick).toBe(1_000);
      }
    }
    const coin = effectsOf(crash, companies).find((x) => x.companyId === 12) as { total: number };
    const calm = effectsOf(crash, companies).find((x) => x.companyId === 0) as { total: number };
    expect(coin.total).toBeLessThan(calm.total); // both negative: the coin's fall is the bigger one
  });
});

// ---- the real price model --------------------------------------------------------------------------------------------------------------

describe('Black Monday on the real price model', () => {
  it('BM-6: a normal company is about 20% lower after 6½ hours, then climbs back: about 16% lower after a day, 8% after three, a few percent after five and about even after seven; the risky fall most and nothing falls out of bounds', () => {
    // The same world twice from the same seed, once without the stories: the ratio of the two is exactly what the stories did. Four worlds with different moods of the day: the
    // mood moves each number by a few points, so the averages must be where the story says and every single world must stay inside wider limits.
    const companies = buildCatalog(12);
    const START = 20_000;
    const events = blackMondayPair({ keyBase: 'bm:test', cycle: 0, startTick: START }).map(eventOfDraft);
    const marks = [START - 1, START + 23_400, START + 86_400, START + 3 * 86_400, START + 5 * 86_400, START + 7 * 86_400];
    const run = (seed: number, withStories: boolean): number[][] => {
      const sim = new WorldSim(seed, companies);
      const book = new EffectBook(withStories ? events.flatMap((e) => effectsOf(e, companies)) : []);
      const out: number[][] = [];
      for (let t = 1; t <= (marks[marks.length - 1] as number); t += 1) {
        sim.step(book);
        if (marks.includes(t)) out.push(Array.from(sim.P as ArrayLike<number>).slice(0, companies.length));
      }
      return out;
    };
    const seeds = [1, 777, 31_337, 99_999];
    const sums = [0, 0, 0, 0, 0];
    for (const seed of seeds) {
      const control = run(seed, false);
      const crashed = run(seed, true);
      const at = (i: number): number[] => ratios(crashed[i] as number[], control[i] as number[]);
      expect(median(at(0))).toBeCloseTo(1, 9); // nothing before the story
      const path = [1, 2, 3, 4, 5].map((i) => median(at(i)) - 1);
      path.forEach((m, i) => (sums[i] = (sums[i] as number) + m));
      // Each world on its own: about a fifth down at the bottom, and a climb, step by step, from there on.
      expect(path[0] as number).toBeGreaterThan(-0.26);
      expect(path[0] as number).toBeLessThan(-0.15);
      for (let i = 1; i < path.length; i += 1) expect(path[i] as number).toBeGreaterThan(path[i - 1] as number);
      expect(path[4] as number).toBeGreaterThan(-0.06);
      expect(path[4] as number).toBeLessThan(0.04);
      // Everybody falls, the ones with the biggest beta fall most, and nobody loses more than a third.
      const trough = at(1);
      expect(Math.max(...trough)).toBeLessThan(0.92);
      expect(Math.min(...trough)).toBeGreaterThan(0.67);
      const order = companies.map((c, i) => ({ beta: c.beta, ratio: trough[i] as number })).sort((x, y) => x.beta - y.beta);
      expect((order[0] as { ratio: number }).ratio).toBeGreaterThan((order[order.length - 1] as { ratio: number }).ratio);
    }
    const mean = sums.map((x) => x / seeds.length);
    const bands: [number, number][] = [
      [-0.23, -0.17], // after 6½ hours: about 20% lower
      [-0.19, -0.13], // after a day: about 16% lower
      [-0.11, -0.05], // after three days: about 8% lower
      [-0.06, 0], // after five days: a few percent lower
      [-0.03, 0.02], // after a week: about even
    ];
    bands.forEach(([lo, hi], i) => {
      expect(mean[i] as number).toBeGreaterThan(lo);
      expect(mean[i] as number).toBeLessThan(hi);
    });
  }, LONG * 3);
});

// ---- the world on the server -----------------------------------------------------------------------------------------------------------

describe('Black Monday written by the game itself', () => {
  it('BM-7: a world that reaches October 19 writes the two stories by itself at the surprise hour, and prices really fall', async () => {
    const r = await boot({ clock: new Clock(GENESIS_2027) }); // the world begins at 00:00 on October 19, 2027 in Tokyo
    const startMs = blackMondayStartMs(SEED, 2027);
    const startTick = (startMs - GENESIS_2027) / 1000;
    const rows = bmRows(r);
    expect(rows.map((x) => x.key)).toEqual(['bm:2027:crash', 'bm:2027:recovery']);
    const [crash, recovery] = rows as [(typeof rows)[number], (typeof rows)[number]];
    for (const x of rows) {
      expect(x.scope).toBe('market');
      expect(x.source).toBe('generator');
      expect(x.company_id).toBeNull();
      expect(x.start_tick).toBe(startTick);
      expect(x.publish_tick).toBe(startTick);
      expect(x.shape).toBe('front');
      expect(x.perm_share).toBe(1);
    }
    expect(crash.breaking).toBe(1);
    expect(crash.realized).toBe(CRASH_TOTAL);
    expect(crash.end_tick).toBe(startTick + CRASH_TICKS);
    expect(recovery.realized).toBe(RECOVERY_TOTAL);
    expect(recovery.end_tick).toBe(startTick + RECOVERY_TICKS);
    // The market falls: play the world to the tick before the story and to the end of the crash.
    advance(r, startTick - 1);
    const before = prices(r);
    expect(r.app.services.world.sim.tick).toBe(startTick - 1);
    advance(r, CRASH_TICKS + 1);
    const after = prices(r);
    const rs = ratios(after, before);
    expect(median(rs)).toBeLessThan(0.86);
    expect(median(rs)).toBeGreaterThan(0.7);
    expect(rs.filter((x) => x < 1).length).toBeGreaterThanOrEqual(11); // all or nearly all of the 12 (ordinary noise could lift one that is hit lightly)
    // Players see it in the feed once it is published, and it is marked as breaking.
    const feed = await call(r, '/api/news?limit=50');
    const story = feed.json.items.find((i: { headline: string }) => i.headline.startsWith('BLACK MONDAY'));
    expect(story).toBeDefined();
    expect(story.breaking).toBe(true);
    expect(story.direction).toBe('negative');
    expect(story.publishTick).toBe(startTick);
  }, LONG);

  it('BM-8: a day that was already written is never rewritten, so a world that existed before this version keeps its past exactly as it was', async () => {
    const r = await boot({ clock: new Clock(GENESIS_2027) });
    expect(bmRows(r)).toHaveLength(2);
    db(r).run("DELETE FROM news_items WHERE key LIKE 'bm:%'");
    const news = r.app.services.news as NonNullable<typeof r.app.services.news>;
    news.ensureThrough(r.app.services.world.currentTick() + 40_000);
    expect(bmRows(r)).toHaveLength(0); // the cycle is marked as written; only a cycle nobody has written yet gets the stories
    // Even when the companies of that day have to be written again (here: their progress is forgotten and the server restarts), the market stories of a written day are not.
    db(r).run('DELETE FROM news_company_state');
    const dir = r.dir;
    await stop(r);
    const again = await boot({ dir, clock: r.clock });
    expect(db(again).get<{ n: number }>('SELECT COUNT(*) AS n FROM news_company_state')?.n).toBeGreaterThan(0); // the companies really were written again
    expect(bmRows(again)).toHaveLength(0);
    // A second world on another database that has not written that day yet does write them (the same two stories).
    const other = await boot({ clock: new Clock(GENESIS_2027) });
    expect(bmRows(other).map((x) => x.key)).toEqual(['bm:2027:crash', 'bm:2027:recovery']);
  }, LONG);

  it('BM-9: an ordinary day of the year gets no Black Monday story, and the ordinary news of such a day is untouched', async () => {
    const r = await boot(); // the world begins on October 1, 2026
    advance(r, 3_600);
    expect(bmRows(r)).toHaveLength(0);
    const n = db(r).get<{ n: number }>("SELECT COUNT(*) AS n FROM news_items WHERE source = 'generator'")?.n ?? 0;
    expect(n).toBeGreaterThan(30); // the usual stories are all there
  }, LONG);
});

describe('Black Monday started by the owner', () => {
  it('BM-10: only the owner, only with the typed words, written once to the admin log, shown in the feed, and the prices fall by the same amount as on the real day', async () => {
    const r = await boot();
    const player = await signUp(r, 'alice');
    const owner = await signUp(r, 'boss');
    // Not for the signed-out, not for a player.
    expect((await startBm(r, undefined)).status).toBe(401);
    const asPlayer = await startBm(r, player);
    expect(asPlayer.status).toBe(403);
    expect(asPlayer.json.error.code).toBe('owner_only');
    // The owner must type the words.
    for (const confirm of [undefined, '', 'yes', 'black', 'BLACK  MONDAY', 'BLACK MONDAYS', 42, null]) {
      const out = await startBm(r, owner, { confirm });
      expect(out.status).toBe(400);
      expect(out.json.error.code).toBe('bad_request');
    }
    const badId = await call(r, '/api/admin/black-monday', { method: 'POST', cookie: owner, body: { requestId: 'x', confirm: 'BLACK MONDAY' } });
    expect(badId.status).toBe(400);
    expect(bmRows(r)).toHaveLength(0);
    expect(db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM admin_log')?.n).toBe(0);

    const w = r.app.services.world;
    advance(r, 100);
    const control = await boot({ clock: new Clock() });
    await signUp(control, 'boss');
    advance(control, 100);
    const tick = w.sim.tick;
    const first = rid();
    const ok = await startBm(r, owner, { requestId: first, confirm: '  black monday ' }); // capitals and spaces around do not matter
    expect(ok.status).toBe(200);
    expect(ok.json.ok).toBe(true);
    expect(ok.json.duplicate).toBe(false);
    expect(ok.json.startsAtTick).toBe(tick + 4);
    const rows = bmRows(r);
    expect(rows.map((x) => x.key)).toEqual([`bm:now:${first}:crash`, `bm:now:${first}:recovery`]);
    for (const x of rows) {
      expect(x.source).toBe('admin');
      expect(x.scope).toBe('market');
      expect(x.start_tick).toBe(tick + 4);
    }
    // Written once to the owner's log, readable on the admin screen.
    const state = await call(r, '/api/admin/state', { cookie: owner });
    const entries = state.json.log.filter((e: { action: string }) => e.action === 'black_monday');
    expect(entries).toHaveLength(1);
    expect(entries[0].admin).toBe('boss');
    expect(entries[0].target).toBe('market');
    expect(entries[0].detail.startTick).toBe(tick + 4);
    // The same request again does nothing more; a different request while it runs is refused and changes nothing.
    const again = await startBm(r, owner, { requestId: first });
    expect(again.status).toBe(200);
    expect(again.json.duplicate).toBe(true);
    const second = await startBm(r, owner);
    expect(second.status).toBe(409);
    expect(second.json.error.code).toBe('already_running');
    expect(bmRows(r)).toHaveLength(2);
    expect(db(r).get<{ n: number }>("SELECT COUNT(*) AS n FROM admin_log WHERE action = 'black_monday'")?.n).toBe(1);
    // After the crash and the first day of the recovery the prices are where the real day would have put them (the control world never had it).
    advance(r, 4 + CRASH_TICKS);
    advance(control, 4 + CRASH_TICKS);
    expect(w.sim.tick).toBe(control.app.services.world.sim.tick);
    const trough = ratios(prices(r), prices(control));
    expect(median(trough) - 1).toBeGreaterThan(-0.26);
    expect(median(trough) - 1).toBeLessThan(-0.15);
    expect(Math.max(...trough)).toBeLessThan(0.9);
    advance(r, 86_400 - CRASH_TICKS);
    advance(control, 86_400 - CRASH_TICKS);
    const day = ratios(prices(r), prices(control));
    expect(median(day)).toBeGreaterThan(median(trough)); // already climbing
    expect(median(day) - 1).toBeGreaterThan(-0.23);
    expect(median(day) - 1).toBeLessThan(-0.1);
    // The feed shows the headline and marks it breaking.
    const feed = await call(r, '/api/news?limit=50');
    const crash = feed.json.items.find((i: { headline: string }) => i.headline.startsWith('BLACK MONDAY'));
    expect(crash?.breaking).toBe(true);
    expect(feed.json.items.some((i: { headline: string }) => i.headline.startsWith('Black Monday: exchanges stay open'))).toBe(true);
  }, LONG);

  it('BM-11: a Black Monday that is over no longer blocks the next one, and the owner can start another by hand', async () => {
    const r = await boot();
    const owner = await signUp(r, 'boss');
    advance(r, 50);
    expect((await startBm(r, owner)).status).toBe(200);
    expect((await startBm(r, owner)).status).toBe(409);
    // Pretend the week has passed: both stories have ended (the stored rows say so; the running market is not asked to replay a week).
    db(r).run("UPDATE news_items SET end_tick = start_tick + 1 WHERE key LIKE 'bm:now:%'");
    advance(r, 10);
    const next = await startBm(r, owner);
    expect(next.status).toBe(200);
    expect(bmRows(r)).toHaveLength(4);
  }, LONG);

  it('BM-12: a restart in the middle of the recovery changes no price: the market that was stopped and started gives exactly the prices of one that never stopped', async () => {
    const clockA = new Clock();
    const clockB = new Clock();
    const a1 = await boot({ clock: clockA });
    const b = await boot({ clock: clockB });
    const ownerA = await signUp(a1, 'boss');
    const ownerB = await signUp(b, 'boss');
    for (const [r, owner] of [[a1, ownerA], [b, ownerB]] as [Running, string][]) {
      advance(r, 100);
      expect((await startBm(r, owner, { requestId: 'same-black-monday-0001' })).status).toBe(200);
      advance(r, 30 * 3_600); // the crash is over, the recovery is a day and a quarter old, and the last saved candle is earlier than "now"
    }
    expect(a1.app.services.world.sim.tick).toBe(b.app.services.world.sim.tick);
    const dir = a1.dir;
    await stop(a1);
    clockA.advanceSeconds(10); // the server was away for a moment
    const a2 = await boot({ dir, clock: clockA });
    catchUp(a2);
    advance(b, 10);
    for (const r of [a2, b]) advance(r, 2 * 86_400); // two more days of the recovery
    const wa = a2.app.services.world;
    const wb = b.app.services.world;
    expect(wa.sim.tick).toBe(wb.sim.tick);
    expect(prices(a2)).toEqual(prices(b));
    expect(wa.candles(0, 'c10', 200)).toEqual(wb.candles(0, 'c10', 200));
    // The recovery is still in the stored rows and still running after the restart.
    const news = a2.app.services.news as NonNullable<typeof a2.app.services.news>;
    expect(news.eventsActiveAt(wa.sim.tick).map((e) => e.key)).toEqual(['bm:now:same-black-monday-0001:recovery']);
  }, LONG);
});
