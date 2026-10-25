// The news system's storage and service. It does three things:
//   1. WRITES news ahead of time, one cycle (day) at a time, all in one transaction per cycle. Every row has a unique key, so
//      running a cycle twice (after a crash, or by two schedulers) can never create duplicates.
//   2. GIVES the price engine the events it must apply (so news is processed by the server, never by a browser).
//   3. SHOWS players what has been published so far: newest first, with the hidden "realised" move never leaving the server.

import {
  CATEGORY_LABEL,
  MIN_ITEMS_PER_CYCLE,
  NEWS_CYCLE_TICKS,
  companyCycleDrafts,
  cycleOfTick,
  effectiveDuration,
  eventOf,
  marketCycleDrafts,
  scaleOf,
  sectorInfo,
  unitsToCents,
  type Category,
  type Company,
  type NewsDraft,
  type WorldEvent,
} from '../../src/world';
import type { Logger } from '../log';
import type { Db } from '../sqlite';
import type { MarkRow, NewsContext, NewsHooks } from '../world/runtime';

interface Row {
  id: number;
  key: string;
  company_id: number | null;
  partner_id: number | null;
  sector: string | null;
  scope: string;
  kind: string;
  category: string;
  cycle: number;
  slot: number;
  publish_tick: number;
  start_tick: number;
  end_tick: number;
  duration_ticks: number;
  shape: string;
  immediacy: string;
  direction: string;
  strength: string;
  realized: number;
  perm_share: number;
  credibility: number | null;
  headline: string;
  body: string;
  breaking: number;
  source: string;
  created_ms: number;
  price_at_publish: number | null;
  price_at_end: number | null;
}

/** What players are allowed to see of a news item. The realised move and the source's credibility are NOT part of it. */
export interface PublicNews {
  readonly id: number;
  readonly headline: string;
  readonly body: string;
  readonly category: string;
  readonly categoryLabel: string;
  readonly kind: string;
  readonly direction: string;
  readonly strength: string;
  readonly breaking: boolean;
  readonly scope: string;
  readonly ticker: string | null;
  readonly partnerTicker: string | null;
  readonly sector: string | null;
  readonly sectorName: string | null;
  readonly immediacy: string;
  readonly publishTick: number;
  readonly publishedMs: number;
  readonly outcome: { priceAtPublish: number; priceAtEnd: number; changeBps: number } | null;
}

export interface FeedQuery {
  /** The market's current tick: nothing published after it is shown. */
  readonly tick: number;
  readonly companyId?: number;
  readonly category?: string;
  readonly breakingOnly?: boolean;
  readonly limit: number;
  /** Cursor "publishTick:id" of the last item of the previous page. */
  readonly before?: string;
}

export interface NewsHealth {
  readonly ok: boolean;
  /** Last day for which sector / economy / viral news exists without gaps (−1 = none). */
  readonly generatedThroughCycle: number;
  /** The day that the market's clock plus the look-ahead requires. */
  readonly requiredThroughCycle: number;
  /** Companies whose news is older than required. */
  readonly behind: { ticker: string; generatedThrough: number }[];
  /** Trading companies with fewer than three core items in the current day (should always be empty). */
  readonly belowMinimum: string[];
  readonly items: number;
  readonly itemsPublished: number;
  readonly lastGeneratedMs: number | null;
}

export interface NewsServiceOptions {
  readonly db: Db;
  readonly log: Logger;
  readonly now: () => number;
  /** For tests: runs inside the transaction of each cycle; throwing aborts the whole cycle. */
  readonly onGenerate?: (cycle: number) => void;
}

const COLUMNS =
  'id, key, company_id, partner_id, sector, scope, kind, category, cycle, slot, publish_tick, start_tick, end_tick, duration_ticks, shape, immediacy, direction, strength, realized, perm_share, credibility, headline, body, breaking, source, created_ms, price_at_publish, price_at_end';

export class NewsService implements NewsHooks {
  private readonly db: Db;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly onGenerate: ((cycle: number) => void) | undefined;
  private worldSeed = 0;
  private companies: readonly Company[] = [];
  private genThrough = new Int32Array(0);
  private marketCycles = new Set<number>();
  private lastAnnounced = -1;
  lastGeneratedMs: number | null = null;

  constructor(options: NewsServiceOptions) {
    this.db = options.db;
    this.log = options.log;
    this.now = options.now;
    this.onGenerate = options.onGenerate;
  }

  // ---- start-up ----------------------------------------------------------------------------------------------------

  bind(context: NewsContext): void {
    this.worldSeed = context.worldSeed;
    this.companies = context.companies;
    this.genThrough = new Int32Array(context.companies.length).fill(-1);
    for (const r of this.db.all<{ company_id: number; generated_through: number }>('SELECT company_id, generated_through FROM news_company_state')) {
      if (r.company_id < this.genThrough.length) this.genThrough[r.company_id] = r.generated_through;
    }
    this.marketCycles = new Set(this.db.all<{ cycle: number }>('SELECT cycle FROM news_cycles').map((r) => r.cycle));
    this.lastGeneratedMs = this.db.get<{ m: number | null }>('SELECT MAX(generated_ms) AS m FROM news_cycles')?.m ?? null;
  }

  // ---- writing ahead ------------------------------------------------------------------------------------------------

  /** The first cycle that still has something missing, up to `needed` (or needed + 1 if everything is there). */
  private firstMissing(needed: number): number {
    let lowest = needed + 1;
    for (let c = 0; c <= needed; c += 1) {
      if (!this.marketCycles.has(c)) {
        lowest = c;
        break;
      }
    }
    for (let i = 0; i < this.companies.length; i += 1) {
      const company = this.companies[i] as Company;
      const listed = cycleOfTick(company.listingTick);
      if (listed > needed) continue;
      const next = Math.max(listed, (this.genThrough[i] as number) + 1);
      if (next < lowest) lowest = next;
    }
    return lowest;
  }

  /** Makes sure all news that starts at or before `tick` exists. Safe to call as often as you like. */
  ensureThrough(tick: number): void {
    const needed = cycleOfTick(Math.max(0, tick));
    for (let c = this.firstMissing(needed); c <= needed; c += 1) this.generateCycle(c);
  }

  private insert(d: NewsDraft, createdMs: number, source = 'generator'): number {
    const end = d.startTick + effectiveDuration(d.shape, d.durationTicks);
    return this.db.run(
      `INSERT OR IGNORE INTO news_items(key, company_id, partner_id, sector, scope, kind, category, cycle, slot, publish_tick, start_tick, end_tick, duration_ticks, shape, immediacy, direction, strength, realized, perm_share, credibility, headline, body, breaking, source, created_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      d.key, d.companyId, d.partnerId, d.sector, d.scope, d.kind, d.category, d.cycle, d.slot, d.publishTick, d.startTick, end, d.durationTicks, d.shape, d.immediacy,
      d.direction, d.strength, d.realized, d.permShare, d.credibility, d.headline, d.body, d.breaking ? 1 : 0, source, createdMs,
    ).changes;
  }

  /**
   * Stores a special event made by the owner (source 'admin'). It is an ordinary news row, so the price engine, the feed and a
   * restart all treat it like any other story. Returns the new row's id, or null if the key already exists (nothing is changed).
   * Call inside the transaction that also writes the admin log.
   */
  addSpecial(draft: NewsDraft, createdMs: number): number | null {
    if (this.insert(draft, createdMs, 'admin') === 0) return null;
    return this.db.get<{ id: number }>('SELECT id FROM news_items WHERE key = ?', draft.key)?.id ?? null;
  }

  /** The world's view of a stored draft (the same conversion the generator's events go through). */
  eventOfDraft(d: NewsDraft): WorldEvent {
    return eventOf(d);
  }

  private generateCycle(cycle: number): void {
    const started = this.now();
    const cycleEnd = (cycle + 1) * NEWS_CYCLE_TICKS;
    const done: { id: number; items: number }[] = [];
    let marketDone = false;
    let total = 0;
    let companiesTouched = 0;
    try {
      this.db.tx(() => {
        this.onGenerate?.(cycle);
        for (const company of this.companies) {
          const i = company.id;
          if ((this.genThrough[i] as number) >= cycle) continue;
          if (company.listingTick >= cycleEnd) continue;
          const drafts = companyCycleDrafts(this.worldSeed, company, this.companies, cycle);
          if (drafts.length < MIN_ITEMS_PER_CYCLE) {
            throw new Error(`News generator produced only ${drafts.length} items for ${company.ticker} on day ${cycle}; at least ${MIN_ITEMS_PER_CYCLE} are required.`);
          }
          let inserted = 0;
          let lastTick = 0;
          for (const d of drafts) {
            inserted += this.insert(d, started);
            if (d.publishTick > lastTick) lastTick = d.publishTick;
          }
          this.db.run(
            `INSERT INTO news_company_state(company_id, generated_through, last_success_ms, items_total, last_item_tick) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(company_id) DO UPDATE SET generated_through = excluded.generated_through, last_success_ms = excluded.last_success_ms,
               items_total = news_company_state.items_total + excluded.items_total, last_item_tick = MAX(news_company_state.last_item_tick, excluded.last_item_tick)`,
            i, cycle, started, inserted, lastTick,
          );
          done.push({ id: i, items: inserted });
          total += inserted;
          companiesTouched += 1;
        }
        if (!this.marketCycles.has(cycle)) {
          let market = 0;
          for (const d of marketCycleDrafts(this.worldSeed, this.companies, cycle)) market += this.insert(d, started);
          this.db.run('INSERT OR IGNORE INTO news_cycles(cycle, generated_ms, items, companies) VALUES (?, ?, ?, ?)', cycle, started, market + total, companiesTouched);
          total += market;
          marketDone = true;
        }
      });
    } catch (error) {
      this.log.error('news', `Generating news for day ${cycle} failed and was rolled back (nothing was half-written): ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
    for (const d of done) this.genThrough[d.id] = cycle;
    if (marketDone) this.marketCycles.add(cycle);
    this.lastGeneratedMs = started;
    if (total > 0) this.log.info('news', `Day ${cycle}: wrote ${total} news items for ${companiesTouched} companies${marketDone ? ' (including sector, economy and viral news)' : ''}.`);
  }

  // ---- giving events to the price engine ----------------------------------------------------------------------------

  private toEvent(r: Row): WorldEvent {
    return {
      key: r.key,
      kind: r.kind as WorldEvent['kind'],
      scope: r.scope as WorldEvent['scope'],
      companyId: r.company_id,
      partnerId: r.partner_id,
      sector: r.sector as WorldEvent['sector'],
      publishTick: r.publish_tick,
      startTick: r.start_tick,
      durationTicks: r.duration_ticks,
      shape: r.shape as WorldEvent['shape'],
      realized: r.realized,
      permShare: r.perm_share,
    };
  }

  eventsActiveAt(tick: number): WorldEvent[] {
    return this.db.all<Row>(`SELECT ${COLUMNS} FROM news_items WHERE start_tick <= ? AND end_tick > ? ORDER BY start_tick, id`, tick, tick).map((r) => this.toEvent(r));
  }

  eventsStartingIn(from: number, through: number): WorldEvent[] {
    return this.db.all<Row>(`SELECT ${COLUMNS} FROM news_items WHERE start_tick >= ? AND start_tick <= ? ORDER BY start_tick, id`, from, through).map((r) => this.toEvent(r));
  }

  /** Every rug pull story (finished ones too): the world reads them to know which coins are dead (src/world/effects.ts `deathTickOf`). */
  deadEvents(): WorldEvent[] {
    return this.db.all<Row>(`SELECT ${COLUMNS} FROM news_items WHERE key LIKE 'rug:%:drain' ORDER BY start_tick, id`).map((r) => this.toEvent(r));
  }

  recordMarks(rows: readonly MarkRow[]): void {
    for (const r of rows) {
      if (r.kind === 'publish') this.db.run('UPDATE news_items SET price_at_publish = ? WHERE key = ?', r.price, r.key);
      else this.db.run('UPDATE news_items SET price_at_end = ? WHERE key = ?', r.price, r.key);
    }
  }

  // ---- showing news to players --------------------------------------------------------------------------------------

  private publicOf(r: Row, msOfTick: (tick: number) => number): PublicNews {
    const company = r.company_id === null ? null : this.companies[r.company_id];
    const partner = r.partner_id === null ? null : this.companies[r.partner_id];
    const outcome =
      r.price_at_publish !== null && r.price_at_end !== null && r.price_at_publish > 0
        ? { priceAtPublish: unitsToCents(r.price_at_publish, scaleOf(company)), priceAtEnd: unitsToCents(r.price_at_end, scaleOf(company)), changeBps: Math.round(((r.price_at_end - r.price_at_publish) / r.price_at_publish) * 10_000) }
        : null;
    return {
      id: r.id,
      headline: r.headline,
      body: r.body,
      category: r.category,
      categoryLabel: CATEGORY_LABEL[r.category as Category] ?? r.category,
      kind: r.kind,
      direction: r.direction,
      strength: r.strength,
      breaking: r.breaking === 1,
      scope: r.scope,
      ticker: company?.ticker ?? null,
      partnerTicker: partner?.ticker ?? null,
      sector: r.sector,
      sectorName: r.sector ? sectorInfo(r.sector as never).name : null,
      immediacy: r.immediacy,
      publishTick: r.publish_tick,
      publishedMs: msOfTick(r.publish_tick),
      outcome,
    };
  }

  /** Published news, newest first. `next` is the cursor for the following page (null at the end). */
  feed(q: FeedQuery, msOfTick: (tick: number) => number): { items: PublicNews[]; next: string | null } {
    const limit = Math.max(1, Math.min(100, q.limit));
    const cursor = q.before ? q.before.split(':').map(Number) : null;
    if (cursor && (cursor.length !== 2 || cursor.some((x) => !Number.isSafeInteger(x)))) throw new Error('Bad cursor');
    const where = (base: string, params: (string | number)[]): { sql: string; params: (string | number)[] } => {
      let sql = `${base} AND publish_tick <= ?`;
      const p = [...params, q.tick];
      if (cursor) {
        sql += ' AND (publish_tick < ? OR (publish_tick = ? AND id < ?))';
        p.push(cursor[0] as number, cursor[0] as number, cursor[1] as number);
      }
      if (q.category) {
        sql += ' AND category = ?';
        p.push(q.category);
      }
      if (q.breakingOnly) sql += ' AND breaking = 1';
      return { sql, params: p };
    };
    const select = (base: string, params: (string | number)[]): { sql: string; params: (string | number)[] } => {
      const w = where(base, params);
      return { sql: `SELECT * FROM (SELECT ${COLUMNS} FROM news_items WHERE ${w.sql} ORDER BY publish_tick DESC, id DESC LIMIT ${limit + 1})`, params: w.params };
    };
    let rows: Row[];
    if (q.companyId === undefined) {
      const s = select('1 = 1', []);
      rows = this.db.all<Row>(`${s.sql} ORDER BY publish_tick DESC, id DESC LIMIT ${limit + 1}`, ...s.params);
    } else {
      const c = this.companies[q.companyId];
      if (!c) return { items: [], next: null };
      const parts = [select('company_id = ?', [c.id]), select('partner_id = ?', [c.id]), select("scope = 'sector' AND sector = ?", [c.sector]), select("scope = 'market'", [])];
      rows = this.db.all<Row>(`${parts.map((x) => x.sql).join(' UNION ALL ')} ORDER BY publish_tick DESC, id DESC LIMIT ${limit + 1}`, ...parts.flatMap((x) => x.params));
    }
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { items: page.map((r) => this.publicOf(r, msOfTick)), next: rows.length > limit && last ? `${last.publish_tick}:${last.id}` : null };
  }

  item(id: number, tick: number, msOfTick: (tick: number) => number): PublicNews | null {
    const r = this.db.get<Row>(`SELECT ${COLUMNS} FROM news_items WHERE id = ? AND publish_tick <= ?`, id, tick);
    return r ? this.publicOf(r, msOfTick) : null;
  }

  /** Items that became public after the last call (for the live push). The first call only remembers the time. */
  publishDue(tick: number, msOfTick: (tick: number) => number): PublicNews[] {
    if (this.lastAnnounced < 0) {
      this.lastAnnounced = tick;
      return [];
    }
    if (tick <= this.lastAnnounced) return [];
    // After a long gap (catch-up) only the last two minutes are pushed; players read the rest from the feed.
    const from = Math.max(this.lastAnnounced, tick - 120);
    const rows = this.db.all<Row>(`SELECT ${COLUMNS} FROM news_items WHERE publish_tick > ? AND publish_tick <= ? ORDER BY publish_tick, id`, from, tick);
    this.lastAnnounced = tick;
    return rows.map((r) => this.publicOf(r, msOfTick));
  }

  /** The owner's debugging view: every item that moves this company's price around now, with the secret numbers. */
  debugEffects(companyId: number, fromTick: number, toTick: number): (PublicNews & { realized: number; permShare: number; startTick: number; endTick: number; credibility: number | null; source: string })[] {
    const c = this.companies[companyId];
    if (!c) return [];
    const rows = this.db.all<Row>(
      `SELECT ${COLUMNS} FROM news_items WHERE end_tick > ? AND start_tick <= ? AND (company_id = ? OR partner_id = ? OR (scope = 'sector' AND sector = ?) OR scope = 'market') ORDER BY start_tick, id`,
      fromTick, toTick, c.id, c.id, c.sector,
    );
    return rows.map((r) => ({ ...this.publicOf(r, (t) => t * 1000), realized: r.realized, permShare: r.perm_share, startTick: r.start_tick, endTick: r.end_tick, credibility: r.credibility, source: r.source }));
  }

  // ---- monitoring ---------------------------------------------------------------------------------------------------

  health(clockTick: number, requiredTick: number): NewsHealth {
    const required = cycleOfTick(Math.max(0, requiredTick));
    let through = -1;
    while (this.marketCycles.has(through + 1)) through += 1;
    const behind: NewsHealth['behind'] = [];
    for (const c of this.companies) {
      if (cycleOfTick(c.listingTick) > required) continue;
      if ((this.genThrough[c.id] as number) < required) behind.push({ ticker: c.ticker, generatedThrough: this.genThrough[c.id] as number });
    }
    const cycle = cycleOfTick(clockTick);
    const counts = new Map(
      this.db.all<{ company_id: number; n: number }>('SELECT company_id, COUNT(*) AS n FROM news_items WHERE cycle = ? AND slot < 3 AND company_id IS NOT NULL GROUP BY company_id', cycle).map((r) => [r.company_id, r.n]),
    );
    const belowMinimum = this.companies.filter((c) => c.listingTick < (cycle + 1) * NEWS_CYCLE_TICKS && (counts.get(c.id) ?? 0) < MIN_ITEMS_PER_CYCLE).map((c) => c.ticker);
    const total = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM news_items')?.n ?? 0;
    const published = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM news_items WHERE publish_tick <= ?', clockTick)?.n ?? 0;
    return {
      ok: behind.length === 0 && belowMinimum.length === 0 && through >= required,
      generatedThroughCycle: through,
      requiredThroughCycle: required,
      behind: behind.slice(0, 50),
      belowMinimum: belowMinimum.slice(0, 50),
      items: total,
      itemsPublished: published,
      lastGeneratedMs: this.lastGeneratedMs,
    };
  }
}
