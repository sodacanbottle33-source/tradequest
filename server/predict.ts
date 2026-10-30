// The daily prediction (docs/world.md §38). Every day (Tokyo time) one stock is the featured one, the same for everybody. A player may say once, any time that day, whether its
// price will be HIGHER or LOWER when the day ends. The price he saw is kept. When the day is over, the pick is judged against the price then: a right guess pays the same as a
// finished daily goal (Learn XP, Career cash, 1v1 coins), a wrong one costs nothing. There is nothing to bet, so it cannot be used to make money out of money.
//
// The featured stock is chosen once per day and kept (so a restart changes nothing). It is never a memecoin or a company a player launched, and never the same one two days in a
// row. If the server was off at midnight and the judging is more than LATE_MS late, the day is called a draw for everybody (the price then would not be the price at midnight).
// The cash is written in the "cash gifts" list, so the weekly board does not count it as growth (like daily goals).

import { dayOf, dayStartMs, DAY_MS, GOAL_REWARD, type Reward } from '../src/shared/goalCatalog';
import { scaleOf, unitsToCents } from '../src/world';
import type { User } from './auth';
import type { Logger } from './log';
import type { Db } from './sqlite';
import type { WorldRuntime } from './world/runtime';

export class PredictError extends Error {
  constructor(
    readonly code: 'bad_request' | 'already_picked' | 'no_company' | 'cannot_play',
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** A right guess pays the same as one daily goal. */
export const PREDICT_REWARD: Reward = GOAL_REWARD;
/** If the day is judged later than this after it ended, it is a draw. */
export const LATE_MS = 30 * 60_000;

export interface PredictDeps {
  readonly db: Db;
  readonly world: WorldRuntime;
  readonly now: () => number;
  readonly log: Logger;
  /** Pays a reward inside the caller's transaction (Daily.payReward). */
  readonly pay: (userId: number, reward: Reward, nowMs: number, reason: string) => void;
  /** Writes down Career cash the game gave a player (Social.gave), after the transaction. */
  readonly gaveCash?: (userId: number, cents: number) => void;
  /** Tells the pages of one player something. */
  readonly publishTo?: (userId: number, event: string, data: unknown) => void;
  /** Gives a player any badge he has just earned. */
  readonly refreshBadges?: (userId: number) => void;
  /** For tests: the stock of a day instead of the usual choice. */
  readonly companyOfDay?: (day: number) => number | null;
}

export interface PredictCompany {
  readonly id: number;
  readonly ticker: string;
  readonly name: string;
  /** The price now in cents (a decimal number for a coin), or null when it is not trading. */
  readonly priceCents: number | null;
}

export interface PredictPickView {
  readonly pick: 'up' | 'down';
  readonly priceFromCents: number;
  readonly pickedMs: number;
}

export interface PredictLast {
  readonly day: number;
  readonly ticker: string;
  readonly name: string;
  readonly pick: 'up' | 'down';
  readonly result: 'win' | 'loss' | 'draw';
  readonly priceFromCents: number;
  readonly priceToCents: number | null;
}

export interface PredictView {
  readonly day: number;
  /** When the day ends and the pick is judged. */
  readonly endMs: number;
  readonly serverMs: number;
  /** Today's stock, or null when there is none to feature (nothing is trading). */
  readonly company: PredictCompany | null;
  readonly mine: PredictPickView | null;
  /** Yesterday's pick of this player and how it went (null when he did not pick or it is not judged yet). */
  readonly last: PredictLast | null;
  readonly stats: { readonly made: number; readonly correct: number; readonly run: number; readonly bestRun: number };
  readonly reward: Reward;
}

/** What the live stream tells a player when a pick was judged. */
export interface PredictedEvent {
  readonly day: number;
  readonly ticker: string;
  readonly pick: 'up' | 'down';
  readonly result: 'win' | 'loss' | 'draw';
  readonly reward: Reward | null;
}

interface PredictionRow {
  user_id: number;
  day: number;
  company_id: number;
  pick: 'up' | 'down';
  price_from: number;
  picked_ms: number;
  result: 'win' | 'loss' | 'draw' | null;
  price_to: number | null;
}

export class Predict {
  constructor(private readonly d: PredictDeps) {}

  private isBot(userId: number): boolean {
    return this.d.db.get('SELECT 1 AS x FROM bots WHERE user_id = ?', userId) !== undefined;
  }

  // ---- the featured stock --------------------------------------------------------------------------------------------

  /** A company that may be featured: a stock (not a memecoin) of the original market or the owner's, trading now, not launched by a player, not bankrupt. */
  private eligible(): number[] {
    const { world, db } = this.d;
    const out: number[] = [];
    for (const c of world.companies) {
      if (c.sector === 'meme' || !world.isTrading(c.id)) continue;
      if (db.get('SELECT 1 AS x FROM launches WHERE company_id = ?', c.id)) continue;
      if (db.get('SELECT 1 AS x FROM bankruptcies WHERE company_id = ?', c.id)) continue;
      out.push(c.id);
    }
    return out;
  }

  /** The featured company of a day, chosen the first time it is asked for and kept. Null when there is nothing to feature. */
  companyOfDay(day: number): number | null {
    if (this.d.companyOfDay) return this.d.companyOfDay(day);
    const { db } = this.d;
    const have = db.get<{ company_id: number }>('SELECT company_id FROM predict_days WHERE day = ?', day);
    if (have) return have.company_id;
    // Only today (or a day that has a pick waiting) gets a company; a day in the far past or future is not chosen by looking at it.
    const list = this.eligible();
    if (list.length === 0) return null;
    const yesterday = db.get<{ company_id: number }>('SELECT company_id FROM predict_days WHERE day = ?', day - 1)?.company_id;
    const pool = list.length > 1 ? list.filter((id) => id !== yesterday) : list;
    // The same day always gives the same start of the list; the stored row is what keeps it fixed after that.
    const chosen = pool[(Math.imul(day, 2654435761) >>> 0) % pool.length] as number;
    db.run('INSERT OR IGNORE INTO predict_days(day, company_id) VALUES (?, ?)', day, chosen);
    return db.get<{ company_id: number }>('SELECT company_id FROM predict_days WHERE day = ?', day)?.company_id ?? chosen;
  }

  private priceUnits(companyId: number): number | null {
    const { world } = this.d;
    if (!world.companies[companyId] || !world.isTrading(companyId)) return null;
    return world.sim.price(companyId);
  }

  private priceCents(companyId: number): number | null {
    const units = this.priceUnits(companyId);
    const c = this.d.world.companies[companyId];
    return units === null || !c ? null : unitsToCents(units, scaleOf(c));
  }

  private companyView(companyId: number): PredictCompany | null {
    const c = this.d.world.companies[companyId];
    if (!c) return null;
    return { id: c.id, ticker: c.ticker, name: c.name, priceCents: this.priceCents(companyId) };
  }

  // ---- reading ------------------------------------------------------------------------------------------------------

  private statsOf(userId: number): PredictView['stats'] {
    let made = 0;
    let correct = 0;
    let run = 0;
    let bestRun = 0;
    for (const r of this.d.db.all<{ result: string }>("SELECT result FROM predictions WHERE user_id = ? AND result IS NOT NULL AND result <> 'draw' ORDER BY day", userId)) {
      made += 1;
      if (r.result === 'win') {
        correct += 1;
        run += 1;
        bestRun = Math.max(bestRun, run);
      } else {
        run = 0;
      }
    }
    return { made, correct, run, bestRun };
  }

  view(me: User): PredictView {
    this.sweep();
    const { db } = this.d;
    const nowMs = this.d.now();
    const day = dayOf(nowMs);
    const id = this.companyOfDay(day);
    const row = db.get<PredictionRow>('SELECT user_id, day, company_id, pick, price_from, picked_ms, result, price_to FROM predictions WHERE user_id = ? AND day = ?', me.id, day);
    const company = id === null ? null : this.companyView(id);
    const lastRow = db.get<PredictionRow>('SELECT user_id, day, company_id, pick, price_from, picked_ms, result, price_to FROM predictions WHERE user_id = ? AND day < ? AND result IS NOT NULL ORDER BY day DESC LIMIT 1', me.id, day);
    let last: PredictLast | null = null;
    if (lastRow && lastRow.result) {
      const c = this.d.world.companies[lastRow.company_id];
      const scale = scaleOf(c);
      last = {
        day: lastRow.day,
        ticker: c?.ticker ?? '?',
        name: c?.name ?? '?',
        pick: lastRow.pick,
        result: lastRow.result,
        priceFromCents: unitsToCents(lastRow.price_from, scale),
        priceToCents: lastRow.price_to === null ? null : unitsToCents(lastRow.price_to, scale),
      };
    }
    return {
      day,
      endMs: dayStartMs(day) + DAY_MS,
      serverMs: nowMs,
      company,
      mine: row ? { pick: row.pick, priceFromCents: unitsToCents(row.price_from, scaleOf(this.d.world.companies[row.company_id])), pickedMs: row.picked_ms } : null,
      last,
      stats: this.statsOf(me.id),
      reward: PREDICT_REWARD,
    };
  }

  /** True when the featured stock of today is there and this player has not picked yet (the Goals tab counts it as one more thing to do). */
  open(userId: number): boolean {
    if (this.isBot(userId)) return false;
    const day = dayOf(this.d.now());
    const id = this.companyOfDay(day);
    if (id === null || this.priceUnits(id) === null) return false;
    return this.d.db.get('SELECT 1 AS x FROM predictions WHERE user_id = ? AND day = ?', userId, day) === undefined;
  }

  // ---- picking ------------------------------------------------------------------------------------------------------

  pick(me: User, rawPick: unknown): PredictView {
    if (rawPick !== 'up' && rawPick !== 'down') throw new PredictError('bad_request', 'pick must be "up" or "down".', 400);
    if (this.isBot(me.id)) throw new PredictError('cannot_play', 'Computer players do not make predictions.', 403);
    const nowMs = this.d.now();
    const day = dayOf(nowMs);
    const id = this.companyOfDay(day);
    const price = id === null ? null : this.priceUnits(id);
    if (id === null || price === null) throw new PredictError('no_company', 'There is no stock to guess about right now. Try again in a little while.', 409);
    this.d.db.tx(() => {
      if (this.d.db.get('SELECT 1 AS x FROM predictions WHERE user_id = ? AND day = ?', me.id, day)) throw new PredictError('already_picked', 'You already made your guess for today. It cannot be changed.', 409);
      this.d.db.run('INSERT INTO predictions(user_id, day, company_id, pick, price_from, picked_ms) VALUES (?, ?, ?, ?, ?, ?)', me.id, day, id, rawPick, price, nowMs);
    });
    return this.view(me);
  }

  // ---- judging ------------------------------------------------------------------------------------------------------

  /**
   * Judges every pick of a day that has ended (once each) and pays the right ones. The game calls this every few seconds and a player's own page calls it when it asks.
   * Returns the number of picks judged.
   */
  sweep(): number {
    const { db } = this.d;
    const nowMs = this.d.now();
    const today = dayOf(nowMs);
    // Make sure today's stock exists even when nobody has looked yet (and so the next day can avoid repeating it).
    this.companyOfDay(today);
    const days = db.all<{ day: number }>('SELECT DISTINCT day FROM predictions WHERE result IS NULL AND day < ? ORDER BY day', today).map((r) => r.day);
    let judged = 0;
    for (const day of days) {
      const endedMs = dayStartMs(day) + DAY_MS;
      const late = nowMs - endedMs > LATE_MS;
      const rows = db.all<PredictionRow>('SELECT user_id, day, company_id, pick, price_from, picked_ms, result, price_to FROM predictions WHERE day = ? AND result IS NULL', day);
      for (const r of rows) {
        try {
          if (this.judgeOne(r, late, nowMs)) judged += 1;
        } catch (error) {
          this.d.log.warn('predict', `A prediction of player ${r.user_id} could not be judged: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    return judged;
  }

  private judgeOne(r: PredictionRow, late: boolean, nowMs: number): boolean {
    const price = late ? null : this.priceUnits(r.company_id);
    let result: 'win' | 'loss' | 'draw';
    if (price === null || price === r.price_from) result = 'draw';
    else result = (price > r.price_from) === (r.pick === 'up') ? 'win' : 'loss';
    let paid = false;
    this.d.db.tx(() => {
      const done = this.d.db.run('UPDATE predictions SET result = ?, price_to = ?, judged_ms = ? WHERE user_id = ? AND day = ? AND result IS NULL', result, price, nowMs, r.user_id, r.day);
      if (done.changes !== 1) return;
      if (result === 'win') {
        this.d.pay(r.user_id, PREDICT_REWARD, nowMs, 'prediction');
        paid = true;
      }
    });
    if (paid) this.d.gaveCash?.(r.user_id, PREDICT_REWARD.cashCents);
    this.d.refreshBadges?.(r.user_id);
    const c = this.d.world.companies[r.company_id];
    const event: PredictedEvent = { day: r.day, ticker: c?.ticker ?? '?', pick: r.pick, result, reward: paid ? PREDICT_REWARD : null };
    this.d.publishTo?.(r.user_id, 'predicted', event);
    this.d.log.info('predict', `Player ${r.user_id}'s guess for day ${r.day} (${c?.ticker ?? '?'}, ${r.pick}) was judged: ${result}.`);
    return true;
  }
}
