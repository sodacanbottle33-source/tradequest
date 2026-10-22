// What players may see of the companies' quarterly reports (docs/world.md §7.5): a company's profit per share, its price/earnings ratio, when it reports next
// and what analysts expect, its last reports, and a calendar of all of them. Everything is worked out from the pure functions in src/world/fundamentals.ts and
// the news items that were really published; nothing is stored here.
//
// What is never shown: the direction and strength of a report that has not come out yet, and the hidden move of any report. The date of the next
// report and the consensus are public (they depend only on the company and the quarter), the numbers of a report appear only from its publish tick.

import {
  EARNINGS_PERIOD_CYCLES,
  QUARTERS_PER_YEAR,
  TICKS_PER_HOUR,
  consensusOf,
  cycleOfTick,
  earningsOutcome,
  figuresFor,
  profileOf,
  quarterLabel,
  reportCycleAtOrBefore,
  trailingEps,
  type Company,
  type Figures,
} from '../src/world';
import type { Db } from './sqlite';

/** What the earnings pages need to know about the market. */
export interface EarningsWorld {
  readonly seed: number;
  readonly companies: readonly Company[];
  msOfTick(tick: number): number;
  /** The price in cents, or 0 while the company does not trade. */
  priceOf(companyId: number): number;
}

/** A report that has come out. `figures` is null for a report from before the quarterly numbers existed (its story has no numbers). */
export interface ReportView {
  readonly cycle: number;
  readonly label: string;
  readonly newsId: number;
  readonly headline: string;
  readonly publishTick: number;
  readonly publishedMs: number;
  /** 'beat', 'miss', 'inline', 'epsBeatRevMiss', 'epsMissRevBeat', or 'legacy' for an old story with no numbers. */
  readonly kind: string;
  readonly epsMills: number | null;
  readonly epsConsMills: number | null;
  readonly epsBp: number | null;
  readonly revDollars: number | null;
  readonly revConsDollars: number | null;
  readonly revBp: number | null;
  readonly yoyBp: number | null;
  /** How the price moved from the story to the end of its effect (basis points); null while it is still moving. */
  readonly reactionBps: number | null;
}

export interface UpcomingView {
  readonly ticker: string;
  readonly name: string;
  readonly sector: string;
  readonly cycle: number;
  readonly label: string;
  readonly publishTick: number;
  readonly publishedMs: number;
  readonly epsConsMills: number;
  readonly revConsDollars: number;
}

export interface CompanyEarnings {
  readonly ticker: string;
  readonly name: string;
  /** False for a memecoin (no earnings) and for a company that does not trade yet. */
  readonly applies: boolean;
  readonly periodDays: number;
  /** A year of profit per share (the last four reports), in mills; null when it does not apply. */
  readonly epsTtmMills: number | null;
  /** Price divided by a year of profit per share (one decimal); null when it does not apply or there is no profit. */
  readonly peRatio: number | null;
  readonly revenueTtmDollars: number | null;
  readonly netMarginBps: number | null;
  readonly next: UpcomingView | null;
  readonly history: ReportView[];
}

interface Row {
  id: number;
  company_id: number;
  cycle: number;
  publish_tick: number;
  headline: string;
  direction: string;
  strength: string;
  price_at_publish: number | null;
  price_at_end: number | null;
}

const ROW_COLUMNS = 'id, company_id, cycle, publish_tick, headline, direction, strength, price_at_publish, price_at_end';

/** The Earnings reader's view of a running world (the world's seed and companies are read when needed, so a restart or a new stock is seen). */
export function earningsWorldOf(world: { readonly seed: number; readonly companies: readonly Company[]; msOfTick(tick: number): number; sim: { isListed(id: number): boolean; price(id: number): number } }): EarningsWorld {
  return {
    get seed() {
      return world.seed;
    },
    get companies() {
      return world.companies;
    },
    msOfTick: (tick) => world.msOfTick(tick),
    priceOf: (id) => (world.sim.isListed(id) ? world.sim.price(id) : 0),
  };
}

export class Earnings {
  private relCache: { tick: number; map: Map<number, number> } | null = null;

  constructor(
    private readonly db: Db,
    private readonly world: EarningsWorld,
  ) {}

  private outcomeFn(c: Company): (cycle: number) => ReturnType<typeof earningsOutcome> {
    return (cycle) => earningsOutcome(this.world.seed, c, cycle);
  }

  private reportOf(c: Company, r: Row): ReportView {
    const out = earningsOutcome(this.world.seed, c, r.cycle);
    // A story written before quarterly numbers existed does not match the numbers the model would give that day.
    const current = out !== null && out.direction === r.direction && out.strength === r.strength && out.publishTick === r.publish_tick;
    const f: Figures | null = current && out ? figuresFor(this.world.seed, c, r.cycle, out) : null;
    const reaction = r.price_at_publish !== null && r.price_at_end !== null && r.price_at_publish > 0 ? Math.round(((r.price_at_end - r.price_at_publish) / r.price_at_publish) * 10_000) : null;
    return {
      cycle: r.cycle,
      label: f ? quarterLabel(f.quarter) : '',
      newsId: r.id,
      headline: r.headline,
      publishTick: r.publish_tick,
      publishedMs: this.world.msOfTick(r.publish_tick),
      kind: f ? f.kind : 'legacy',
      epsMills: f ? f.epsMills : null,
      epsConsMills: f ? f.epsConsMills : null,
      epsBp: f ? f.epsBp : null,
      revDollars: f ? f.revDollars : null,
      revConsDollars: f ? f.revConsDollars : null,
      revBp: f ? f.revBp : null,
      yoyBp: f ? f.yoyBp : null,
      reactionBps: reaction,
    };
  }

  private upcomingOf(c: Company, cycle: number, publishTick: number): UpcomingView {
    const k = consensusOf(this.world.seed, c, cycle);
    return {
      ticker: c.ticker,
      name: c.name,
      sector: c.sector,
      cycle,
      label: quarterLabel(k.quarter),
      publishTick,
      publishedMs: this.world.msOfTick(publishTick),
      epsConsMills: k.epsMills,
      revConsDollars: k.revenue,
    };
  }

  /** The next report of a company that is not out yet (its date and what is expected), or null. */
  nextOf(c: Company, tick: number): UpcomingView | null {
    const first = cycleOfTick(tick);
    for (let cycle = first; cycle <= first + EARNINGS_PERIOD_CYCLES; cycle += 1) {
      const out = earningsOutcome(this.world.seed, c, cycle);
      if (out && out.publishTick > tick) return this.upcomingOf(c, cycle, out.publishTick);
    }
    return null;
  }

  /** The cycle of the latest report that is out: the last one that fell due, or the one before it if today's has not been published yet. */
  private lastReportCycle(c: Company, tick: number): number {
    const seed = this.world.seed;
    let last = reportCycleAtOrBefore(seed, c, cycleOfTick(tick));
    const today = earningsOutcome(seed, c, last);
    if (today && today.publishTick > tick) last -= EARNINGS_PERIOD_CYCLES;
    return last;
  }

  /**
   * How dear each listed stock is next to the others of its sector, from what any player can read on the Earnings page: its price/earnings
   * ratio over the middle ratio of its sector, minus one (−0.3 = 30 % cheaper than the sector, +0.5 = 50 % dearer). Companies with no profit,
   * coins, companies not trading yet and sectors with fewer than three companies are left out. Worked out once per tick.
   */
  relativePe(tick: number): Map<number, number> {
    if (this.relCache && this.relCache.tick === tick) return this.relCache.map;
    const bySector = new Map<string, { id: number; pe: number }[]>();
    for (const c of this.world.companies) {
      if (c.sector === 'meme' || c.listingTick > tick) continue;
      const price = this.world.priceOf(c.id);
      if (price <= 0) continue;
      const ttm = trailingEps(this.world.seed, c, this.lastReportCycle(c, tick), this.outcomeFn(c));
      if (ttm <= 0) continue;
      const list = bySector.get(c.sector) ?? [];
      list.push({ id: c.id, pe: (price * 10) / ttm });
      bySector.set(c.sector, list);
    }
    const map = new Map<number, number>();
    for (const list of bySector.values()) {
      if (list.length < 3) continue;
      const sorted = list.map((x) => x.pe).sort((a, b) => a - b);
      const mid = sorted.length % 2 === 1 ? (sorted[(sorted.length - 1) / 2] as number) : ((sorted[sorted.length / 2 - 1] as number) + (sorted[sorted.length / 2] as number)) / 2;
      for (const x of list) map.set(x.id, x.pe / mid - 1);
    }
    this.relCache = { tick, map };
    return map;
  }

  forCompany(c: Company, tick: number, limit = 8): CompanyEarnings {
    const none: CompanyEarnings = { ticker: c.ticker, name: c.name, applies: false, periodDays: EARNINGS_PERIOD_CYCLES, epsTtmMills: null, peRatio: null, revenueTtmDollars: null, netMarginBps: null, next: null, history: [] };
    if (c.sector === 'meme' || c.listingTick > tick) return none;
    const seed = this.world.seed;
    const last = this.lastReportCycle(c, tick);
    const outcomeOf = this.outcomeFn(c);
    const ttm = trailingEps(seed, c, last, outcomeOf);
    let revenue = 0;
    for (let k = 0; k < QUARTERS_PER_YEAR; k += 1) {
      const cycle = last - k * EARNINGS_PERIOD_CYCLES;
      revenue += figuresFor(seed, c, cycle, outcomeOf(cycle)).revDollars;
    }
    const price = this.world.priceOf(c.id);
    const rows = this.db.all<Row>(`SELECT ${ROW_COLUMNS} FROM news_items WHERE company_id = ? AND category = 'earnings' AND publish_tick <= ? ORDER BY publish_tick DESC, id DESC LIMIT ?`, c.id, tick, Math.max(1, Math.min(40, limit)));
    return {
      ticker: c.ticker,
      name: c.name,
      applies: true,
      periodDays: EARNINGS_PERIOD_CYCLES,
      epsTtmMills: ttm,
      peRatio: ttm > 0 && price > 0 ? Math.round(((price * 10) / ttm) * 10) / 10 : null,
      revenueTtmDollars: revenue,
      netMarginBps: Math.round(profileOf(seed, c).margin * 10_000),
      next: this.nextOf(c, tick),
      history: rows.map((r) => this.reportOf(c, r)),
    };
  }

  /** Reports that come out in the next `hours` hours (soonest first), across the market. */
  upcoming(tick: number, hours: number, limit = 100): UpcomingView[] {
    const until = tick + hours * TICKS_PER_HOUR;
    const out: UpcomingView[] = [];
    const first = cycleOfTick(tick);
    const last = cycleOfTick(until);
    for (const c of this.world.companies) {
      if (c.sector === 'meme' || c.listingTick > until) continue;
      for (let cycle = first; cycle <= last; cycle += 1) {
        const o = earningsOutcome(this.world.seed, c, cycle);
        if (o && o.publishTick > tick && o.publishTick <= until) out.push(this.upcomingOf(c, cycle, o.publishTick));
      }
    }
    out.sort((a, b) => a.publishTick - b.publishTick || a.ticker.localeCompare(b.ticker));
    return out.slice(0, limit);
  }

  /** Reports that came out in the last `hours` hours (latest first), across the market. */
  recent(tick: number, hours: number, limit = 100): (ReportView & { ticker: string; name: string })[] {
    return this.publishedBetween(tick - hours * TICKS_PER_HOUR, tick, limit);
  }

  /** Reports published after tick `from` and up to tick `to` (latest first), with their figures. */
  publishedBetween(from: number, to: number, limit = 300): (ReportView & { ticker: string; name: string })[] {
    const rows = this.db.all<Row>(`SELECT ${ROW_COLUMNS} FROM news_items WHERE category = 'earnings' AND company_id IS NOT NULL AND publish_tick > ? AND publish_tick <= ? ORDER BY publish_tick DESC, id DESC LIMIT ?`, from, to, Math.max(1, Math.min(300, limit)));
    const result: (ReportView & { ticker: string; name: string })[] = [];
    for (const r of rows) {
      const c = this.world.companies[r.company_id];
      if (c) result.push({ ...this.reportOf(c, r), ticker: c.ticker, name: c.name });
    }
    return result;
  }
}

