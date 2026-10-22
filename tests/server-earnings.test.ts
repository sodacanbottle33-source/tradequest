// What players may see of quarterly reports (docs/world.md §7.5): the company's earnings page, the calendar, the routes. The numbers come from the pure
// functions of src/world/fundamentals.ts and from the news items that were really published; the hidden side of a report never leaves the server.
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EARNINGS_PERIOD_CYCLES, NEWS_CYCLE_TICKS, TICKS_PER_DAY, TICKS_PER_HOUR, buildCatalog, consensusOf, earningsOutcome, figuresFor, profileOf, trailingEps, type Company } from '../src/world';
import { createApp, type App } from '../server/app';
import { loadConfig } from '../server/config';
import { Earnings } from '../server/earnings';
import { Logger } from '../server/log';
import { NewsService } from '../server/news/service';
import { migrate } from '../server/schema';
import { Db } from '../server/sqlite';
import { Clock, START_MS, makeRig, type Rig } from './helpers/server';

const LONG = 240_000;
const SEED = 424242;
const rigs: Rig[] = [];
afterEach(() => {
  while (rigs.length > 0) rigs.pop()?.cleanup();
});

/** News for forty companies over twelve days, in a database of its own, and an Earnings reader on top of it with every price at its catalog price. */
function setup(days = 12) {
  const r = makeRig();
  rigs.push(r);
  const db = new Db(r.path);
  r.opened.push(db);
  migrate(db);
  const companies = buildCatalog(40);
  const news = new NewsService({ db, log: r.log, now: r.clock.now });
  news.bind({ worldSeed: SEED, companies });
  news.ensureThrough(days * TICKS_PER_DAY - 1);
  const earnings = new Earnings(db, { seed: SEED, companies, msOfTick: (t) => START_MS + t * 1000, priceOf: (id) => (companies[id] as Company).basePriceCents });
  const stocks = companies.filter((c) => c.listingTick === 0 && c.sector !== 'meme');
  return { db, news, companies, earnings, stocks };
}

describe('Earnings: a company page', () => {
  it('EARNSRV-1: the history is the reports that were published, with the numbers of fundamentals.ts; the trailing profit and the P/E follow from them', () => {
    const { db, earnings, stocks } = setup();
    const tick = 8 * TICKS_PER_DAY + 5 * TICKS_PER_HOUR;
    let checked = 0;
    for (const c of stocks) {
      const view = earnings.forCompany(c, tick, 8);
      expect(view.applies).toBe(true);
      const rows = db.all<{ cycle: number; direction: string; strength: string; publish_tick: number; headline: string; id: number }>(
        "SELECT cycle, direction, strength, publish_tick, headline, id FROM news_items WHERE company_id = ? AND category = 'earnings' AND publish_tick <= ? ORDER BY publish_tick DESC",
        c.id,
        tick,
      );
      expect(view.history.map((h) => h.newsId)).toEqual(rows.map((x) => x.id));
      for (const h of view.history) {
        const row = rows.find((x) => x.id === h.newsId);
        const out = earningsOutcome(SEED, c, h.cycle);
        expect(out).not.toBeNull();
        if (!out) continue;
        const f = figuresFor(SEED, c, h.cycle, out);
        expect(h).toMatchObject({ kind: f.kind, epsMills: f.epsMills, epsConsMills: f.epsConsMills, epsBp: f.epsBp, revDollars: f.revDollars, revBp: f.revBp, yoyBp: f.yoyBp, headline: row?.headline });
        // The words of the story and the kind agree.
        if (row?.direction === 'positive') expect(h.kind).toBe('beat');
        if (row?.direction === 'negative') expect(h.kind).toBe('miss');
        expect(h.publishTick).toBeLessThanOrEqual(tick);
        checked += 1;
      }
      // A year of profit per share: the four latest reports; the P/E is the catalog price over it.
      const last = rows[0]?.cycle ?? -1;
      if (rows.length > 0) {
        const ttm = trailingEps(SEED, c, last, (cy) => earningsOutcome(SEED, c, cy));
        expect(view.epsTtmMills).toBe(ttm);
        expect(view.peRatio).toBe(Math.round(((c.basePriceCents * 10) / ttm) * 10) / 10);
        const pe = profileOf(SEED, c).pe;
        expect(view.peRatio as number).toBeGreaterThan(pe * 0.4);
        expect(view.peRatio as number).toBeLessThan(pe * 3);
      }
      expect(view.netMarginBps).toBe(Math.round(profileOf(SEED, c).margin * 10_000));
      expect(view.periodDays).toBe(EARNINGS_PERIOD_CYCLES);
    }
    expect(checked).toBeGreaterThan(40);
  }, LONG);

  it('EARNSRV-2: a report appears at its publish tick and not a tick before; the next report moves on; nothing hidden is in the answer', () => {
    const { db, earnings, stocks } = setup();
    const c = stocks.find((x) => db.get('SELECT 1 AS x FROM news_items WHERE company_id = ? AND category = ? AND cycle >= 4 AND cycle <= 8', x.id, 'earnings')) as Company;
    const row = db.get<{ publish_tick: number; cycle: number }>("SELECT publish_tick, cycle FROM news_items WHERE company_id = ? AND category = 'earnings' AND cycle >= 4 ORDER BY cycle LIMIT 1", c.id) as { publish_tick: number; cycle: number };
    const before = earnings.forCompany(c, row.publish_tick - 1, 8);
    const at = earnings.forCompany(c, row.publish_tick, 8);
    expect(at.history.length).toBe(before.history.length + 1);
    expect(at.history[0]?.cycle).toBe(row.cycle);
    expect(before.history.some((h) => h.cycle === row.cycle)).toBe(false);
    // Before it: the report is "next", with its date and the consensus — and nothing of the result.
    expect(before.next).toMatchObject({ ticker: c.ticker, cycle: row.cycle, publishTick: row.publish_tick });
    expect(before.next?.epsConsMills).toBe(consensusOf(SEED, c, row.cycle).epsMills);
    // At it: the next one is a quarter later.
    expect(at.next?.cycle).toBe(row.cycle + EARNINGS_PERIOD_CYCLES);
    // The trailing profit moves on to the new report only when it is out.
    const outcomeOf = (cy: number) => earningsOutcome(SEED, c, cy);
    expect(at.epsTtmMills).toBe(trailingEps(SEED, c, row.cycle, outcomeOf));
    expect(before.epsTtmMills).toBe(trailingEps(SEED, c, row.cycle - EARNINGS_PERIOD_CYCLES, outcomeOf));
    // Nothing of the hidden side is in the answer.
    const text = JSON.stringify(before);
    for (const word of ['realized', 'direction', 'strength', 'permShare', 'credibility']) expect(text.includes(word)).toBe(false);
    expect(Object.keys(before.next as object).sort()).toEqual(['cycle', 'epsConsMills', 'label', 'name', 'publishTick', 'publishedMs', 'revConsDollars', 'sector', 'ticker']);
    expect(Object.keys(at.history[0] as object).sort()).toEqual(['cycle', 'epsBp', 'epsConsMills', 'epsMills', 'headline', 'kind', 'label', 'newsId', 'publishTick', 'publishedMs', 'reactionBps', 'revBp', 'revConsDollars', 'revDollars', 'yoyBp']);
  }, LONG);

  it('EARNSRV-3: the date of the next report is the date the news will really come out (the stored story, if it has been written already)', () => {
    const { db, earnings, stocks } = setup();
    let seen = 0;
    for (const c of stocks) {
      const tick = 5 * TICKS_PER_DAY;
      const next = earnings.nextOf(c, tick);
      expect(next).not.toBeNull();
      if (!next) continue;
      expect(next.publishTick).toBeGreaterThan(tick);
      expect(next.publishTick - tick).toBeLessThanOrEqual((EARNINGS_PERIOD_CYCLES + 1) * NEWS_CYCLE_TICKS);
      const stored = db.get<{ publish_tick: number }>("SELECT publish_tick FROM news_items WHERE company_id = ? AND category = 'earnings' AND cycle = ?", c.id, next.cycle);
      if (stored) {
        expect(stored.publish_tick).toBe(next.publishTick);
        seen += 1;
      }
    }
    expect(seen).toBeGreaterThan(30);
  }, LONG);

  it('EARNSRV-4: a coin and a company that does not trade yet have no earnings', () => {
    const { earnings, stocks } = setup();
    const c = stocks[0] as Company;
    const coin = { ...c, sector: 'meme' as const };
    expect(earnings.forCompany(coin, 5 * TICKS_PER_DAY)).toMatchObject({ applies: false, history: [], next: null, peRatio: null, epsTtmMills: null });
    const later = { ...c, listingTick: 9 * TICKS_PER_DAY };
    expect(earnings.forCompany(later, 5 * TICKS_PER_DAY)).toMatchObject({ applies: false, history: [], next: null });
  });

  it('EARNSRV-5: a story written before the numbers existed is shown as it was, with no numbers', () => {
    const { db, earnings, stocks } = setup();
    const row = db.get<{ id: number; company_id: number; publish_tick: number; direction: string }>("SELECT id, company_id, publish_tick, direction FROM news_items WHERE category = 'earnings' AND cycle >= 3 AND cycle <= 9 AND direction = 'positive' LIMIT 1");
    expect(row).toBeDefined();
    if (!row) return;
    const c = stocks.find((x) => x.id === row.company_id) as Company;
    db.run("UPDATE news_items SET direction = 'negative' WHERE id = ?", row.id);
    const h = earnings.forCompany(c, 10 * TICKS_PER_DAY, 8).history.find((x) => x.newsId === row.id);
    expect(h).toBeDefined();
    expect(h).toMatchObject({ kind: 'legacy', epsMills: null, epsConsMills: null, epsBp: null, revDollars: null, yoyBp: null, label: '' });
    expect(typeof h?.headline).toBe('string');
  }, LONG);

  it('EARNSRV-6: how the price took a report is the move between the price at the story and at the end of its effect; null while it is still moving', () => {
    const { db, earnings, stocks } = setup();
    const row = db.get<{ id: number; company_id: number; publish_tick: number }>("SELECT id, company_id, publish_tick FROM news_items WHERE category = 'earnings' AND cycle >= 3 AND cycle <= 9 LIMIT 1") as { id: number; company_id: number; publish_tick: number };
    const c = stocks.find((x) => x.id === row.company_id) as Company;
    const tick = 10 * TICKS_PER_DAY;
    expect(earnings.forCompany(c, tick, 8).history.find((x) => x.newsId === row.id)?.reactionBps).toBeNull();
    db.run('UPDATE news_items SET price_at_publish = 2000, price_at_end = 2150 WHERE id = ?', row.id);
    expect(earnings.forCompany(c, tick, 8).history.find((x) => x.newsId === row.id)?.reactionBps).toBe(750);
    db.run('UPDATE news_items SET price_at_publish = 2000, price_at_end = 1900 WHERE id = ?', row.id);
    expect(earnings.forCompany(c, tick, 8).history.find((x) => x.newsId === row.id)?.reactionBps).toBe(-500);
  }, LONG);
});

describe('Earnings: the calendar', () => {
  it('EARNSRV-7: the upcoming reports are those inside the window, soonest first, each company once per quarter, no coins', () => {
    const { earnings, companies } = setup();
    const tick = 6 * TICKS_PER_DAY + 3 * TICKS_PER_HOUR;
    const up = earnings.upcoming(tick, 24, 500);
    for (let i = 1; i < up.length; i += 1) expect((up[i] as { publishTick: number }).publishTick).toBeGreaterThanOrEqual((up[i - 1] as { publishTick: number }).publishTick);
    for (const u of up) {
      expect(u.publishTick).toBeGreaterThan(tick);
      expect(u.publishTick).toBeLessThanOrEqual(tick + 24 * TICKS_PER_HOUR);
    }
    // The same list worked out another way.
    let expected = 0;
    for (const c of companies) {
      if (c.sector === 'meme' || c.listingTick > tick + 24 * TICKS_PER_HOUR) continue;
      for (let cycle = 6; cycle <= 7; cycle += 1) {
        const o = earningsOutcome(SEED, c, cycle);
        if (o && o.publishTick > tick && o.publishTick <= tick + 24 * TICKS_PER_HOUR) expected += 1;
      }
    }
    expect(up.length).toBe(expected);
    expect(up.length).toBeGreaterThan(5);
    expect(new Set(up.map((u) => u.ticker)).size).toBe(up.length);
    // A wider window has all of them, and the limit cuts the list from the far end.
    const wide = earnings.upcoming(tick, 72, 500);
    expect(wide.length).toBeGreaterThan(up.length);
    expect(earnings.upcoming(tick, 72, 3).map((u) => u.ticker)).toEqual(wide.slice(0, 3).map((u) => u.ticker));
  }, LONG);

  it('EARNSRV-8: the recent reports are those published in the window, latest first, with their numbers', () => {
    const { db, earnings } = setup();
    const tick = 7 * TICKS_PER_DAY + 12 * TICKS_PER_HOUR;
    const recent = earnings.recent(tick, 24, 500);
    const rows = db.all<{ id: number }>("SELECT id FROM news_items WHERE category = 'earnings' AND company_id IS NOT NULL AND publish_tick > ? AND publish_tick <= ? ORDER BY publish_tick DESC, id DESC", tick - 24 * TICKS_PER_HOUR, tick);
    expect(recent.map((r) => r.newsId)).toEqual(rows.map((r) => r.id));
    expect(recent.length).toBeGreaterThan(5);
    for (const r of recent) {
      expect(r.kind).not.toBe('legacy');
      expect(typeof r.ticker).toBe('string');
      expect(r.epsMills).not.toBeNull();
    }
    // Nothing from the future.
    expect(earnings.recent(tick - 36 * TICKS_PER_HOUR, 1, 500).every((r) => r.publishTick <= tick - 36 * TICKS_PER_HOUR)).toBe(true);
  }, LONG);
});

// ---- the web routes -----------------------------------------------------------------------------------------------------------

interface Running {
  app: App;
  server: Server;
  base: string;
  dir: string;
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
      // closed already
    }
  }
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

async function boot(): Promise<Running> {
  const dir = mkdtempSync(join(tmpdir(), 'tq-earn-'));
  dirs.push(dir);
  const clock = new Clock();
  const config = loadConfig({ TQ_DATA_DIR: dir, TQ_COMPANIES: '66', TQ_WARMUP_DAYS: '8', TQ_PORT: '8787', TQ_OWNER: 'boss' });
  const app = createApp({ config, log: new Logger({ sink: null, now: clock.now }), worldSeed: 777, now: clock.now, flowGain: 0, autoPauses: false });
  const server = createServer(app.handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const r = { app, server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, dir };
  running.push(r);
  return r;
}

async function get(r: Running, path: string) {
  const res = await fetch(r.base + path);
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

describe('Earnings: over the web API', () => {
  it('EARNSRV-9: the company route and the calendar route work for anyone, refuse nonsense, and say a coin has no earnings', async () => {
    const r = await boot();
    const market = (await get(r, '/api/market')).json.companies as any[];
    const stock = market.find((c) => c.trading && c.sector !== 'meme');
    expect(stock).toBeDefined();
    const one = await get(r, `/api/market/${stock.ticker}/earnings`);
    expect(one.status).toBe(200);
    expect(one.json).toMatchObject({ ticker: stock.ticker, applies: true, periodDays: 3 });
    expect(one.json.next).not.toBeNull();
    expect(one.json.peRatio).toBeGreaterThan(3);
    expect(one.json.epsTtmMills).toBeGreaterThan(0);
    expect(Array.isArray(one.json.history)).toBe(true);
    expect(one.text.includes('realized')).toBe(false);
    expect((await get(r, '/api/market/NOPE/earnings')).status).toBe(404);
    expect((await get(r, `/api/market/${stock.ticker}/earnings?limit=0`)).status).toBe(400);

    const cal = await get(r, '/api/earnings?hours=24');
    expect(cal.status).toBe(200);
    expect(cal.json.hours).toBe(24);
    expect(cal.json.upcoming.length).toBeGreaterThan(0);
    for (const u of cal.json.upcoming) expect(u.publishTick).toBeGreaterThan(cal.json.tick);
    for (const rep of cal.json.recent) expect(rep.publishTick).toBeLessThanOrEqual(cal.json.tick);
    expect((await get(r, '/api/earnings?hours=0')).status).toBe(400);
    expect((await get(r, '/api/earnings?hours=500')).status).toBe(400);
    expect(cal.text.includes('realized')).toBe(false);
    expect(r.app.services.world.health().ok).toBe(true);
  }, LONG);
});
