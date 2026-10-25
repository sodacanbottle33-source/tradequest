// Companies that can fail (docs/world.md §18.2).
//
// A WEAK, SMALL company that is hit by a pile of bad news can go bankrupt. It is rare, and it only happens to the kind of company that could
// plausibly fail: a micro or small company whose character is "declining", "turnaround" or "volatile" and that the game made up (not one of the
// ten original companies with ids 0 to 9, not a memecoin, not a company the owner or a player made). Big companies are safe.
//
// The rule is checked once a day, at the start of each news day, and it only looks at the news players have already seen:
//   - over the last WINDOW_DAYS days the company had at least MIN_NEGATIVE bad stories of its own, and
//   - all its own stories of those days together moved it by SUM_LIMIT or worse (a realised total of -0.18 is about -17 %), and
//   - a dice roll for (company, day) comes under FAIL_CHANCE. The roll is a fixed function of the world seed, the company and the day, so
//     a restart rolls the very same number (nothing here uses a random number generator).
// At most one company fails in a day, and at least GAP_DAYS days pass between two failures, so a failure is an event, not a trend.
//
// A failure is a news story with the key "bankrupt:<id>:fail", written exactly like a rug pull's story: the price falls by CRASH_DROP in a burst
// of a few seconds and then stops moving for good (src/world/effects.ts `deathTickOf`, src/world/sim.ts `setDeadFrom`). The story is a stored
// row, so a restart finds the same fact. A row in `bankruptcies` is what the trading rules read:
//   - nobody can open a new position in the company (no buy, no short, no limit order that would open one) from the moment it fails;
//   - a player who holds it can still SELL it (or cover a short) at the price it stopped at. His shares lost almost all of their value;
//     somebody who sold short before the crash made money. Nothing is taken away or paid out by hand: the price did it.
// A failed company never comes back and never fails twice.

import { TICKS_PER_DAY, adminDraft, cycleOfTick, type Company, type NewsDraft } from '../src/world';
import { solveTotal } from './admin';
import type { Logger } from './log';
import type { NewsService } from './news/service';
import type { Db } from './sqlite';
import type { WorldRuntime } from './world/runtime';

/** How many full days of news the rule looks back over. */
export const WINDOW_DAYS = 5;
/** At least this many of the company's own stories in the window must be bad news. */
export const MIN_NEGATIVE = 9;
/** The company's own stories of the window must add up to this (a log-move) or worse. */
export const SUM_LIMIT = -0.18;
/** The chance that a company that meets the rule fails on a given day. */
export const FAIL_CHANCE = 0.3;
/** A company must have been trading this many days. */
export const MIN_AGE_DAYS = 7;
/** At least this many days pass between two failures in the whole market. */
export const GAP_DAYS = 3;
/** The price falls to this share of what it was, in a burst of CRASH_TICKS ticks, and then stays. */
export const CRASH_MULTIPLIER = 0.04;
export const CRASH_TICKS = 6;
/** The news slot of failure stories (rug pulls use 900, the owner's own moves another one; none of them counts as daily news). */
export const BANKRUPT_SLOT = 901;
/** The ten original companies (ids 0 to 9) never fail. */
export const FIRST_FAILING_ID = 10;
/** Only these kinds of company can fail. */
export const FAILING_TIERS: readonly string[] = ['micro', 'small'];
export const FAILING_PERSONALITIES: readonly string[] = ['declining', 'turnaround', 'volatile'];

/** A number from 0 up to (not including) 1 that depends only on its three inputs. */
export function rollOf(seed: number, companyId: number, cycle: number): number {
  let h = Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul(companyId + 1, 0x85ebca6b) ^ Math.imul(cycle + 1, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

export interface BankruptcyDeps {
  readonly db: Db;
  readonly world: WorldRuntime;
  readonly news: NewsService | null;
  readonly log: Logger;
  readonly now: () => number;
  /** Called after a company failed (the market lists are rebuilt, the pages told). */
  readonly onDeclared?: (company: Company) => void;
  /** For tests: another chance than FAIL_CHANCE for a company that meets the rule (1 = it always fails). The game never sets it. */
  readonly chance?: number;
}

export interface BankruptcyRow {
  readonly companyId: number;
  readonly declaredTick: number;
  readonly declaredMs: number;
  readonly cycle: number;
  readonly negativeStories: number;
  readonly windowTotal: number;
  readonly priceBeforeCents: number;
}

interface Window {
  readonly negative: number;
  readonly total: number;
}

const WORDS: readonly (readonly [string, string])[] = [
  ['{co} files for bankruptcy', '{co} ({ceo}) told its lenders it cannot pay its debts and filed for bankruptcy. The shares collapsed. {tk} is closed to new buyers: people who already hold it can still sell at the last price.'],
  ['{co} collapses into bankruptcy', 'After weeks of bad news, {co} ran out of money and went bankrupt. Its shares lost almost everything. Nobody can open a new position in {tk} any more; holders can still sell what they have.'],
  ['{co} is bankrupt; shares wiped out', '{ceo} said {co} has no way to keep going. The stock fell by more than 90 % and its price has stopped for good. {tk} can no longer be bought or shorted; shares you hold can still be sold.'],
  ['{co} runs out of cash and shuts down', '{co} could not find new money and is shutting down. Its stock crashed and now sits at its last price. {tk} can only be sold from here on (or a short covered). It will not trade normally again.'],
];

export class Bankruptcies {
  private failed: Set<number>;
  private checkedCycle = -1;
  private seedCache: number | null = null;

  constructor(private readonly d: BankruptcyDeps) {
    this.failed = this.load();
  }

  private load(): Set<number> {
    return new Set(this.d.db.all<{ company_id: number }>('SELECT company_id FROM bankruptcies').map((r) => r.company_id));
  }

  /** True for a company that went bankrupt. */
  isBankrupt(companyId: number): boolean {
    return this.failed.has(companyId);
  }

  /** The ids of every company that went bankrupt. */
  ids(): ReadonlySet<number> {
    return this.failed;
  }

  list(): BankruptcyRow[] {
    return this.d.db
      .all<{ company_id: number; declared_tick: number; declared_ms: number; cycle: number; negative_stories: number; window_total: number; price_before_cents: number }>(
        'SELECT company_id, declared_tick, declared_ms, cycle, negative_stories, window_total, price_before_cents FROM bankruptcies ORDER BY declared_tick, company_id',
      )
      .map((r) => ({ companyId: r.company_id, declaredTick: r.declared_tick, declaredMs: r.declared_ms, cycle: r.cycle, negativeStories: r.negative_stories, windowTotal: r.window_total, priceBeforeCents: r.price_before_cents }));
  }

  private seed(): number {
    if (this.seedCache === null) this.seedCache = Number(this.d.db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'world_seed'")?.value ?? '0');
    return this.seedCache;
  }

  /** The ids of the companies that were made by the game (not by the owner, not by a player, not a memecoin) and so can fail. */
  private candidates(): Company[] {
    const own = new Set<number>();
    for (const table of ['custom_companies', 'meme_companies', 'launches']) {
      for (const r of this.d.db.all<{ company_id: number }>(`SELECT company_id FROM ${table}`)) own.add(r.company_id);
    }
    return this.d.world.companies.filter(
      (c) => c.sector !== 'meme' && c.id >= FIRST_FAILING_ID && !own.has(c.id) && FAILING_TIERS.includes(c.tier) && FAILING_PERSONALITIES.includes(c.personality) && !this.failed.has(c.id),
    );
  }

  /** What the news said about each company in the days before `cycle`: how many bad stories, and how much they moved it altogether. */
  private windows(cycle: number): Map<number, Window> {
    const rows = this.d.db.all<{ company_id: number; negative: number; total: number }>(
      `SELECT company_id, SUM(CASE WHEN direction = 'negative' THEN 1 ELSE 0 END) AS negative, SUM(realized) AS total
         FROM news_items
        WHERE source = 'generator' AND scope IN ('company', 'company+partner') AND company_id IS NOT NULL AND cycle >= ? AND cycle < ?
        GROUP BY company_id`,
      cycle - WINDOW_DAYS,
      cycle,
    );
    return new Map(rows.map((r) => [r.company_id, { negative: r.negative, total: r.total }]));
  }

  /**
   * Called on every tick; it does its work once a day, on the first tick of a new news day. Returns the company that failed, if one did.
   * A restart in the middle of a day checks that day again, which finds the same answer (the roll is a fixed number, and a company that failed
   * is not a candidate any more).
   */
  step(): Company | null {
    const tick = this.d.world.sim.tick;
    const cycle = cycleOfTick(tick);
    if (cycle <= this.checkedCycle) return null;
    this.checkedCycle = cycle;
    if (cycle < WINDOW_DAYS) return null;
    const last = this.d.db.get<{ t: number | null }>('SELECT MAX(declared_tick) AS t FROM bankruptcies')?.t ?? null;
    if (last !== null && tick - last < GAP_DAYS * TICKS_PER_DAY) return null;
    const windows = this.windows(cycle);
    const seed = this.seed();
    let pick: { company: Company; roll: number; window: Window } | null = null;
    for (const c of this.candidates()) {
      if (tick - c.listingTick < MIN_AGE_DAYS * TICKS_PER_DAY) continue;
      if (!this.d.world.sim.isListed(c.id) || this.d.world.sim.isDead(c.id)) continue;
      const w = windows.get(c.id);
      if (!w || w.negative < MIN_NEGATIVE || w.total > SUM_LIMIT) continue;
      const roll = rollOf(seed, c.id, cycle);
      if (roll >= (this.d.chance ?? FAIL_CHANCE)) continue;
      if (pick === null || roll < pick.roll) pick = { company: c, roll, window: w };
    }
    if (pick === null) return null;
    return this.declare(pick.company, cycle, pick.window) ? pick.company : null;
  }

  /**
   * Makes a company fail now: writes the story and the row in one transaction and schedules the crash. Returns false when it already failed
   * or the news could not be written. (Tests call this to make a failure without waiting for the news to pile up.)
   */
  declare(company: Company, cycle: number = cycleOfTick(this.d.world.sim.tick), window: Window = { negative: 0, total: 0 }): boolean {
    const { db, world, news, log } = this.d;
    if (!news || this.failed.has(company.id) || company.sector === 'meme' || !world.sim.isListed(company.id)) return false;
    try {
      const publishTick = world.earliestEventStart();
      const priceBefore = world.quote(company.id).mid;
      const base = adminDraft({
        key: `bankrupt:${company.id}:fail`,
        company,
        direction: 'negative',
        strength: 'extreme',
        publishTick,
        realized: 0,
        durationTicks: CRASH_TICKS,
        cycle: cycleOfTick(publishTick),
        slot: BANKRUPT_SLOT,
      });
      const [headline, body] = WORDS[company.id % WORDS.length] as readonly [string, string];
      const fill = (s: string): string => s.replace(/\{co\}/g, company.name).replace(/\{ceo\}/g, company.ceo).replace(/\{tk\}/g, company.ticker);
      const draft: NewsDraft = {
        ...base,
        shape: 'burst',
        immediacy: 'immediate',
        realized: solveTotal(CRASH_MULTIPLIER, 'burst', CRASH_TICKS),
        permShare: 1,
        headline: fill(headline),
        body: fill(body),
        breaking: true,
      };
      let written = false;
      db.tx(() => {
        if (news.addSpecial(draft, this.d.now()) === null) return;
        db.run(
          'INSERT INTO bankruptcies(company_id, declared_tick, declared_ms, cycle, negative_stories, window_total, price_before_cents) VALUES (?, ?, ?, ?, ?, ?, ?)',
          company.id,
          world.sim.tick,
          this.d.now(),
          cycle,
          window.negative,
          window.total,
          Math.round(priceBefore),
        );
        written = true;
      });
      if (!written) return false;
      this.failed = this.load();
      world.scheduleEvent(news.eventOfDraft(draft));
      log.info('bankruptcy', `${company.ticker} (${company.name}) went bankrupt after ${window.negative} bad stories.`);
      this.d.onDeclared?.(company);
      return true;
    } catch (error) {
      this.failed = this.load();
      log.error('bankruptcy', `The bankruptcy of ${company.ticker} could not be written: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }
}
