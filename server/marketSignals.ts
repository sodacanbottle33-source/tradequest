// What a market bot is allowed to know when it reacts (docs/world.md §9.11): the same things any player can read.
//
//   • news      — the stories that have been PUBLISHED, with the tone and strength shown on the page (positive / negative / unclear; minor … extreme),
//                 and where they apply (the company, its partner, its sector, the whole market). Never a story that is not out yet, never the hidden
//                 move (`realized`), the permanent share or the source's credibility: this file does not read those columns, and a test checks that.
//   • earnings  — the figures of a published quarterly report (how far profit per share and revenue were above or below what analysts expected).
//   • value     — a stock's price/earnings ratio next to the middle ratio of its sector (the Earnings page shows the same ratio).
//   • crowd     — how much players have been net buying or selling a company lately, which is what tilts the order book (`FlowService.bookTilt`).
//
// A bot turns these into one signed score per company (+ = buy, − = sell or short), where each kind of signal is followed or faded as the bot's
// style says (`Reaction`). Every bot waits its own short, per-story delay after a story comes out (a person needs a moment to read and click).

import type { Company } from '../src/world';
import type { Earnings } from './earnings';
import type { Db } from './sqlite';

/** How much a story counts, by its published strength. */
export const STRENGTH_WEIGHT: Readonly<Record<string, number>> = { minor: 1, moderate: 2, major: 4, extreme: 6 };
/** How much a story about a partner, a whole sector or the whole market counts next to one about the company itself. */
export const PARTNER_WEIGHT = 0.35;
export const SECTOR_WEIGHT = 0.4;
export const MARKET_WEIGHT = 0.2;
/** A book tilt smaller than this is not a crowd; the tilt (−1…1) is scaled by CROWD_SCALE to be comparable with a story's weight. */
export const CROWD_MIN_TILT = 0.15;
export const CROWD_SCALE = 6;
/** A stock this much cheaper than its sector counts for VALUE_SCALE × the gap (a 20 % gap = 2, as much as a moderate story). */
export const VALUE_MIN_GAP = 0.15;
export const VALUE_SCALE = 10;

export type Mode = 'follow' | 'fade' | 'ignore';

/** How one style reacts. */
export interface Reaction {
  readonly news: Mode;
  /** 'value' buys stocks whose price/earnings ratio is low next to their sector. */
  readonly earnings: Mode | 'value';
  readonly crowd: Mode;
  /** The smallest signed score that moves the bot (a minor story is 1, a moderate one 2, a major one 4, an extreme one 6; an old story counts for less, down to half). */
  readonly minScore: number;
  /** Seconds after a story comes out before this bot acts on it (a number of its own for every story). */
  readonly delay: readonly [number, number];
  /** Seconds a story stays worth acting on. */
  readonly window: number;
  /** Chance that a decision looks at the signals at all (otherwise the bot trades as it always did). */
  readonly attention: number;
  /** Closes a position early when a fresh story points the other way. */
  readonly exitOnNews: boolean;
}

export type Why = 'news' | 'earnings' | 'value' | 'crowd';

export interface Candidate {
  readonly companyId: number;
  /** +1 buy, −1 sell/short. */
  readonly dir: 1 | -1;
  /** The size of the signal (always positive). */
  readonly score: number;
  /** The strongest part of the signal. */
  readonly why: Why;
  /** The stories that made it (the bot does not act on them twice). */
  readonly stories: readonly number[];
}

export interface Story {
  readonly id: number;
  readonly companyId: number | null;
  readonly partnerId: number | null;
  readonly sector: string | null;
  readonly scope: string;
  readonly category: string;
  readonly publishTick: number;
  readonly direction: string;
  readonly strength: string;
}

export interface SignalsOptions {
  readonly db: Db;
  readonly earnings: Earnings;
  readonly companies: () => readonly Company[];
  /** The order book's tilt for a company (−1…1), 0 when there is none. */
  readonly tilt: (c: Company, tick: number) => number;
}

/** A whole number from 0 to `n − 1` that depends only on the two numbers (so a bot's delay for a story is the same on every run). */
export function mix(a: number, b: number, n: number): number {
  let h = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return h % n;
}

/** How many ticks this bot waits before acting on this story. */
export function delayFor(userId: number, storyId: number, range: readonly [number, number]): number {
  return range[0] + mix(userId, storyId, range[1] - range[0] + 1);
}

/** A story's weight fades to half over its window. */
export function fade(age: number, window: number): number {
  return window > 0 ? Math.max(0.5, 1 - (age / window) * 0.5) : 1;
}

function sign(direction: string): number {
  return direction === 'positive' ? 1 : direction === 'negative' ? -1 : 0;
}

/** The weight of a report from its published figures: a clear beat or miss of profit (and revenue) per share; in line counts nothing, a mixed report half. */
export function surpriseWeight(kind: string, epsBp: number, revBp: number): number {
  if (kind === 'inline') return 0;
  const size = Math.abs(epsBp);
  const base = size <= 300 ? 1 : size <= 700 ? 2 : size <= 1500 ? 4 : 6;
  const mixed = kind === 'epsBeatRevMiss' || kind === 'epsMissRevBeat';
  const dir = epsBp > 0 ? 1 : epsBp < 0 ? -1 : revBp > 0 ? 1 : revBp < 0 ? -1 : 0;
  return dir * base * (mixed ? 0.5 : 1);
}

interface Parts {
  news: number;
  earnings: number;
  value: number;
  crowd: number;
  stories: number[];
}

export class MarketSignals {
  private readonly db: Db;
  private readonly earnings: Earnings;
  private readonly companies: () => readonly Company[];
  private readonly tilt: (c: Company, tick: number) => number;
  private cache: { tick: number; window: number; stories: Story[]; weights: Map<number, number> } | null = null;
  private tilts: { tick: number; byCompany: Map<number, number> } | null = null;

  constructor(o: SignalsOptions) {
    this.db = o.db;
    this.earnings = o.earnings;
    this.companies = o.companies;
    this.tilt = o.tilt;
  }

  /** Forgets what was read this tick (stories and tilts are read once per tick; call this after a story was stored in the same tick). */
  forget(): void {
    this.cache = null;
    this.tilts = null;
  }

  /** The order book's tilt for a company, looked up once per tick. */
  private tiltOf(c: Company, tick: number): number {
    if (!this.tilts || this.tilts.tick !== tick) this.tilts = { tick, byCompany: new Map() };
    let t = this.tilts.byCompany.get(c.id);
    if (t === undefined) {
      t = this.tilt(c, tick);
      this.tilts.byCompany.set(c.id, t);
    }
    return t;
  }

  /** The stories published in the last `window` ticks, and what each earnings report said in numbers (story id → signed weight). Read once per tick. */
  private fresh(tick: number, window: number): { stories: Story[]; weights: Map<number, number> } {
    if (this.cache && this.cache.tick === tick && this.cache.window >= window) return this.cache;
    const from = tick - window;
    const stories = this.db
      .all<{ id: number; company_id: number | null; partner_id: number | null; sector: string | null; scope: string; category: string; publish_tick: number; direction: string; strength: string }>(
        'SELECT id, company_id, partner_id, sector, scope, category, publish_tick, direction, strength FROM news_items WHERE publish_tick >= ? AND publish_tick <= ? ORDER BY publish_tick, id',
        from,
        tick,
      )
      .map((r) => ({ id: r.id, companyId: r.company_id, partnerId: r.partner_id, sector: r.sector, scope: r.scope, category: r.category, publishTick: r.publish_tick, direction: r.direction, strength: r.strength }));
    const weights = new Map<number, number>();
    if (stories.some((s) => s.category === 'earnings')) {
      for (const r of this.earnings.publishedBetween(from - 1, tick)) {
        // A report from before the figures existed has none: its tone and strength are used like any other story's.
        if (r.kind !== 'legacy' && r.epsBp !== null && r.revBp !== null) weights.set(r.newsId, surpriseWeight(r.kind, r.epsBp, r.revBp));
      }
    }
    this.cache = { tick, window, stories, weights };
    return this.cache;
  }

  /**
   * Every company this bot wants to buy (dir +1) or sell/short (dir −1) right now, strongest first. `seen` holds the stories the bot has
   * already acted on. The caller decides which of them it may trade.
   */
  candidates(react: Reaction, userId: number, tick: number, seen: ReadonlySet<number>): Candidate[] {
    const parts = new Map<number, Parts>();
    const part = (id: number): Parts => {
      let p = parts.get(id);
      if (!p) {
        p = { news: 0, earnings: 0, value: 0, crowd: 0, stories: [] };
        parts.set(id, p);
      }
      return p;
    };
    const companies = this.companies();
    const windowTicks = react.window;
    const fresh = this.fresh(tick, windowTicks);
    const newsMode = react.news === 'follow' ? 1 : react.news === 'fade' ? -1 : 0;
    const earnMode = react.earnings === 'follow' ? 1 : react.earnings === 'fade' ? -1 : 0;
    for (const s of fresh.stories) {
      const age = tick - s.publishTick;
      if (age > windowTicks || seen.has(s.id)) continue;
      if (age < delayFor(userId, s.id, react.delay)) continue;
      const isEarnings = s.category === 'earnings' && s.scope === 'company';
      const mode = isEarnings ? earnMode : newsMode;
      if (mode === 0) continue;
      const base = isEarnings && fresh.weights.has(s.id) ? (fresh.weights.get(s.id) as number) : sign(s.direction) * (STRENGTH_WEIGHT[s.strength] ?? 1);
      if (base === 0) continue;
      const w = base * fade(age, windowTicks) * mode;
      const add = (companyId: number, scale: number): void => {
        const p = part(companyId);
        if (isEarnings) p.earnings += w * scale;
        else p.news += w * scale;
        p.stories.push(s.id);
      };
      if (s.scope === 'company' || s.scope === 'company+partner') {
        if (s.companyId !== null) add(s.companyId, 1);
        if (s.scope === 'company+partner' && s.partnerId !== null) add(s.partnerId, PARTNER_WEIGHT);
      } else if (s.scope === 'sector') {
        for (const c of companies) if (c.sector === s.sector && c.listingTick <= tick) add(c.id, SECTOR_WEIGHT);
      } else if (s.scope === 'market') {
        for (const c of companies) if (c.sector !== 'meme' && c.listingTick <= tick) add(c.id, MARKET_WEIGHT);
      }
    }
    if (react.crowd !== 'ignore') {
      const mode = react.crowd === 'follow' ? 1 : -1;
      for (const c of companies) {
        if (c.listingTick > tick) continue;
        const t = this.tiltOf(c, tick);
        if (Math.abs(t) >= CROWD_MIN_TILT) part(c.id).crowd = t * CROWD_SCALE * mode;
      }
    }
    if (react.earnings === 'value') {
      for (const [id, gap] of this.earnings.relativePe(tick)) if (gap <= -VALUE_MIN_GAP) part(id).value = -gap * VALUE_SCALE;
    }
    const out: Candidate[] = [];
    for (const [companyId, p] of parts) {
      const total = p.news + p.earnings + p.value + p.crowd;
      const score = Math.abs(total);
      if (score < react.minScore) continue;
      const dir = total > 0 ? 1 : -1;
      // The part that pulls the same way as the total and is the biggest names the reason.
      const named: [Why, number][] = [
        ['news', p.news * dir],
        ['earnings', p.earnings * dir],
        ['value', p.value * dir],
        ['crowd', p.crowd * dir],
      ];
      named.sort((a, b) => b[1] - a[1]);
      out.push({ companyId, dir, score, why: (named[0] as [Why, number])[0], stories: p.stories });
    }
    out.sort((a, b) => b.score - a.score || a.companyId - b.companyId);
    return out;
  }
}
