// Daily goals and the streak (docs/world.md §32). Every day (Tokyo time) has three goals, the same for everybody, one from each group: the market, learning and 1v1
// (the list and the rewards are src/shared/goalCatalog.ts). What a player has done today is read from what the game already saved (trades, limit orders, answered
// lessons, finished matches), so no other part of the game has to know about goals. This file notices a finished goal once, pays it once, keeps the streak and hands out
// the free looks for streak milestones.
//
// What a goal pays: a little Learn XP, a little Career cash and a few 1v1 coins. The cash is real in-game money, so it counts in net worth and on the all-time board, but it
// is written in the "cash gifts" list (Social.gave), which the WEEKLY board takes off the gain (that board ranks by percentage and would otherwise reward the smallest accounts).
//
// The streak: a day counts when at least one goal was finished in it. A missed day ends the streak unless a "freeze" covers it (one is earned every 7th day of a streak, two
// are kept at most). Reaching 3, 7, 14 and 30 days gives a free look, once ever: the player chooses which, among the things of that rarity he does not own.

import {
  BONUS_REWARD,
  DAY_MS,
  FREEZE_EVERY,
  GOALS_PER_DAY,
  GOAL_REWARD,
  MAX_FREEZES,
  STREAK_MILESTONES,
  dayOf,
  dayStartMs,
  goalById,
  goalsOfDay,
  type GoalDef,
  type Reward,
} from '../src/shared/goalCatalog';
import { COSMETICS, RARITY_NAMES, cosmeticById } from '../src/shared/cosmeticCatalog';
import type { User } from './auth';
import type { Logger } from './log';
import type { Shop } from './cosmetics';
import type { Db } from './sqlite';

export class DailyError extends Error {
  constructor(
    readonly code: 'bad_request' | 'no_such_item' | 'no_reward' | 'already_claimed' | 'wrong_item' | 'cannot_play',
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface DailyDeps {
  readonly db: Db;
  readonly now: () => number;
  readonly log: Logger;
  /** Tells the pages of ONE player something (his phone and his laptop). */
  readonly publishTo: (userId: number, event: string, data: unknown) => void;
  /** Told after Career cash was given, so the weekly board does not count it as growth and the leaderboards show the new net worth at once. */
  readonly gaveCash?: (userId: number, cents: number) => void;
  readonly shop: Pick<Shop, 'give' | 'ownedBy'>;
  /** Gives the player any badge he has just earned (the sweep otherwise runs every 45 seconds). */
  readonly refreshBadges?: (userId: number) => void;
  /** For tests: the goals of a day (default: {@link goalsOfDay}, the same for everybody). */
  readonly goalsOfDay?: (day: number) => readonly string[];
}

export interface GoalLine {
  readonly id: string;
  readonly icon: string;
  readonly title: string;
  readonly hint: string;
  readonly target: number;
  /** How far he is today, never more than the target. */
  readonly progress: number;
  readonly done: boolean;
  readonly reward: Reward;
}

export interface StreakView {
  /** The streak as it stands now (0 when it has run out). */
  readonly current: number;
  readonly best: number;
  readonly freezes: number;
  /** True when the streak is alive but today's first goal is not done yet. */
  readonly atRisk: boolean;
  /** How many missed days a freeze will cover when he finishes a goal today (0 when none). */
  readonly covers: number;
  /** True when he had a streak that has run out. */
  readonly lost: boolean;
  readonly todayDone: boolean;
  /** Days until the next freeze is earned (0 when he already holds the most). */
  readonly toFreeze: number;
}

export interface MilestoneView {
  readonly days: number;
  readonly rarity: number;
  readonly rarityName: string;
  readonly state: 'locked' | 'ready' | 'claimed';
  /** What he took, once claimed. */
  readonly item: string | null;
  /** For a milestone that is ready: the things he may take. */
  readonly choices: readonly string[];
}

export interface GoalsView {
  readonly day: number;
  readonly startMs: number;
  /** When the goals change: the next 00:00 Tokyo time. */
  readonly endMs: number;
  readonly serverMs: number;
  readonly goals: readonly GoalLine[];
  readonly bonus: { readonly reward: Reward; readonly paid: boolean };
  readonly streak: StreakView;
  readonly milestones: readonly MilestoneView[];
}

/** What the live stream tells a player's pages when something was paid. */
export interface GoalsEvent {
  readonly finished: readonly string[];
  readonly bonus: boolean;
  readonly reward: Reward;
  /** Streak milestones reached just now (a free look is waiting for him). */
  readonly milestones: readonly number[];
  readonly streak: number;
}

interface StreakRow {
  user_id: number;
  current: number;
  best: number;
  last_day: number;
  freezes: number;
  saved: number;
}

const ZERO: Reward = { xp: 0, cashCents: 0, coinCents: 0 };

function plus(a: Reward, b: Reward): Reward {
  return { xp: a.xp + b.xp, cashCents: a.cashCents + b.cashCents, coinCents: a.coinCents + b.coinCents };
}

export class Daily {
  constructor(private readonly d: DailyDeps) {}

  private isBot(userId: number): boolean {
    return this.d.db.get('SELECT 1 AS x FROM bots WHERE user_id = ?', userId) !== undefined;
  }

  private goalIds(day: number): readonly string[] {
    return (this.d.goalsOfDay ?? goalsOfDay)(day);
  }

  // ---- what he has done today ---------------------------------------------------------------------------------------

  private count(sql: string, ...params: (string | number)[]): number {
    return this.d.db.get<{ n: number }>(sql, ...params)?.n ?? 0;
  }

  /** How far a player is with one goal inside the day [from, to). Read from what the game saved. */
  progressOf(userId: number, goal: GoalDef, from: number, to: number): number {
    const career = "FROM trades t JOIN accounts a ON a.id = t.account_id WHERE a.user_id = ? AND a.kind = 'career' AND t.created_ms >= ? AND t.created_ms < ?";
    switch (goal.id) {
      case 'trade_3':
        return this.count(`SELECT COUNT(*) AS n ${career}`, userId, from, to);
      case 'buy_2':
        return this.count(`SELECT COUNT(DISTINCT t.company_id) AS n ${career} AND t.side = 'buy'`, userId, from, to);
      case 'profit_1':
        return this.count(`SELECT COUNT(*) AS n ${career} AND t.realized_cents > 0`, userId, from, to);
      case 'limit_1':
        return this.count("SELECT COUNT(*) AS n FROM limit_orders o JOIN accounts a ON a.id = o.account_id WHERE a.user_id = ? AND a.kind = 'career' AND o.created_ms >= ? AND o.created_ms < ?", userId, from, to);
      case 'lesson_1':
      case 'lesson_3':
        return this.count('SELECT COUNT(*) AS n FROM learn_lessons WHERE user_id = ? AND answered_ms >= ? AND answered_ms < ?', userId, from, to);
      case 'match_1':
        return this.count("SELECT COUNT(*) AS n FROM match_players p JOIN matches m ON m.id = p.match_id WHERE p.user_id = ? AND p.result IN ('win', 'loss', 'tie') AND m.settled_ms >= ? AND m.settled_ms < ?", userId, from, to);
      case 'win_1':
        return this.count("SELECT COUNT(*) AS n FROM match_players p JOIN matches m ON m.id = p.match_id WHERE p.user_id = ? AND p.result = 'win' AND m.settled_ms >= ? AND m.settled_ms < ?", userId, from, to);
      default:
        return 0;
    }
  }

  private doneToday(userId: number, day: number): Set<string> {
    return new Set(this.d.db.all<{ goal: string }>('SELECT goal FROM daily_goal_done WHERE user_id = ? AND day = ?', userId, day).map((r) => r.goal));
  }

  // ---- paying -------------------------------------------------------------------------------------------------------

  private pay(userId: number, r: Reward, nowMs: number): void {
    const { db } = this.d;
    if (r.xp > 0) {
      db.run('INSERT INTO learn_progress(user_id, xp, updated_ms) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET xp = xp + excluded.xp, updated_ms = excluded.updated_ms', userId, r.xp, nowMs);
    }
    if (r.cashCents > 0) db.run("UPDATE accounts SET cash_cents = cash_cents + ? WHERE user_id = ? AND kind = 'career'", r.cashCents, userId);
    if (r.coinCents > 0) {
      db.run("INSERT INTO wallet_ledger(user_id, delta_cents, reason, match_id, created_ms) VALUES (?, ?, 'daily_goal', NULL, ?)", userId, r.coinCents, nowMs);
      db.run(
        'INSERT INTO wallets(user_id, balance_cents, updated_ms) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET balance_cents = balance_cents + excluded.balance_cents, updated_ms = excluded.updated_ms',
        userId,
        r.coinCents,
        nowMs,
      );
    }
  }

  // ---- the streak ---------------------------------------------------------------------------------------------------

  private streakRow(userId: number): StreakRow | undefined {
    return this.d.db.get<StreakRow>('SELECT user_id, current, best, last_day, freezes, saved FROM streaks WHERE user_id = ?', userId);
  }

  /** Counts `day` into the streak (the first goal finished that day). Returns the milestones reached just now. Call inside a transaction. */
  private advance(userId: number, day: number, nowMs: number): number[] {
    const { db } = this.d;
    const row = this.streakRow(userId);
    let current: number;
    let freezes: number;
    let saved: number;
    let best: number;
    if (!row) {
      current = 1;
      freezes = 0;
      saved = 0;
      best = 1;
    } else {
      if (row.last_day >= day) return [];
      const missed = day - row.last_day - 1;
      freezes = row.freezes;
      saved = row.saved;
      if (missed === 0) {
        current = row.current + 1;
      } else if (missed <= freezes) {
        freezes -= missed;
        saved += missed;
        current = row.current + 1;
      } else {
        current = 1;
      }
      best = Math.max(row.best, current);
    }
    if (current > 1 && current % FREEZE_EVERY === 0) freezes = Math.min(MAX_FREEZES, freezes + 1);
    db.run(
      `INSERT INTO streaks(user_id, current, best, last_day, freezes, saved, updated_ms) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET current = excluded.current, best = excluded.best, last_day = excluded.last_day, freezes = excluded.freezes, saved = excluded.saved, updated_ms = excluded.updated_ms`,
      userId,
      current,
      best,
      day,
      freezes,
      saved,
      nowMs,
    );
    const reached: number[] = [];
    for (const m of STREAK_MILESTONES) {
      if (current < m.days) continue;
      const made = db.run('INSERT OR IGNORE INTO streak_rewards(user_id, milestone, earned_ms) VALUES (?, ?, ?)', userId, m.days, nowMs);
      if (made.changes === 1) reached.push(m.days);
    }
    return reached;
  }

  /** The streak as the player sees it on `day`. */
  streakOf(userId: number, day: number): StreakView {
    const row = this.streakRow(userId);
    if (!row) return { current: 0, best: 0, freezes: 0, atRisk: false, covers: 0, lost: false, todayDone: false, toFreeze: FREEZE_EVERY };
    const toFreeze = row.freezes >= MAX_FREEZES ? 0 : FREEZE_EVERY - (row.current % FREEZE_EVERY);
    if (row.last_day >= day) return { current: row.current, best: row.best, freezes: row.freezes, atRisk: false, covers: 0, lost: false, todayDone: true, toFreeze };
    const missed = day - row.last_day - 1;
    if (missed <= 0) return { current: row.current, best: row.best, freezes: row.freezes, atRisk: true, covers: 0, lost: false, todayDone: false, toFreeze };
    if (missed <= row.freezes) return { current: row.current, best: row.best, freezes: row.freezes, atRisk: true, covers: missed, lost: false, todayDone: false, toFreeze };
    return { current: 0, best: row.best, freezes: row.freezes, atRisk: false, covers: 0, lost: row.current > 0, todayDone: false, toFreeze: FREEZE_EVERY };
  }

  // ---- noticing and paying finished goals ----------------------------------------------------------------------------

  /**
   * Looks at today's goals of one player and pays every one that is newly finished (once). Tells his pages. Returns what was paid, or null when nothing was.
   * The game calls this for the players who have a page open every little while, and a player's own Goals page calls it when it opens.
   */
  sweep(userId: number): GoalsEvent | null {
    if (this.isBot(userId)) return null;
    const { db } = this.d;
    const nowMs = this.d.now();
    const day = dayOf(nowMs);
    const from = dayStartMs(day);
    const to = from + DAY_MS;
    const ids = this.goalIds(day);
    const have = this.doneToday(userId, day);
    const newly = ids.filter((id) => {
      if (have.has(id)) return false;
      const g = goalById(id);
      return g !== undefined && this.progressOf(userId, g, from, to) >= g.target;
    });
    if (newly.length === 0) return null;
    let paid: Reward = ZERO;
    const finished: string[] = [];
    let bonus = false;
    let milestones: number[] = [];
    db.tx(() => {
      for (const id of newly) {
        if (db.run('INSERT OR IGNORE INTO daily_goal_done(user_id, day, goal, done_ms) VALUES (?, ?, ?, ?)', userId, day, id, nowMs).changes !== 1) continue;
        this.pay(userId, GOAL_REWARD, nowMs);
        paid = plus(paid, GOAL_REWARD);
        finished.push(id);
      }
      if (finished.length === 0) return;
      milestones = this.advance(userId, day, nowMs);
      const all = this.count('SELECT COUNT(*) AS n FROM daily_goal_done WHERE user_id = ? AND day = ?', userId, day);
      if (all >= GOALS_PER_DAY && db.run('INSERT OR IGNORE INTO daily_bonus(user_id, day, paid_ms) VALUES (?, ?, ?)', userId, day, nowMs).changes === 1) {
        this.pay(userId, BONUS_REWARD, nowMs);
        paid = plus(paid, BONUS_REWARD);
        bonus = true;
      }
    });
    if (finished.length === 0) return null;
    if (paid.cashCents > 0) this.d.gaveCash?.(userId, paid.cashCents);
    this.d.refreshBadges?.(userId);
    const event: GoalsEvent = { finished, bonus, reward: paid, milestones, streak: this.streakOf(userId, day).current };
    this.d.publishTo(userId, 'goals', event);
    this.d.log.info('daily', `Player ${userId} finished ${finished.join(', ')}${bonus ? ' and the day bonus' : ''}; streak ${event.streak}.`);
    return event;
  }

  /** Sweeps many players (the ones with a page open). A failure for one never stops the others. */
  sweepMany(userIds: readonly number[]): number {
    let n = 0;
    for (const id of userIds) {
      try {
        if (this.sweep(id)) n += 1;
      } catch (error) {
        this.d.log.warn('daily', `Goals of player ${id} could not be checked: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return n;
  }

  // ---- reading ------------------------------------------------------------------------------------------------------

  /** The few numbers other screens need ("while you were away"): the streak and how many of today's goals are still open. */
  summary(userId: number): { streak: StreakView; goalsLeft: number } {
    const day = dayOf(this.d.now());
    return { streak: this.streakOf(userId, day), goalsLeft: Math.max(0, GOALS_PER_DAY - this.doneToday(userId, day).size) };
  }

  view(me: User): GoalsView {
    this.sweep(me.id);
    const { db } = this.d;
    const nowMs = this.d.now();
    const day = dayOf(nowMs);
    const from = dayStartMs(day);
    const to = from + DAY_MS;
    const done = this.doneToday(me.id, day);
    const goals: GoalLine[] = this.goalIds(day).map((id) => {
      const g = goalById(id) as GoalDef;
      const isDone = done.has(id);
      const progress = isDone ? g.target : Math.min(g.target, this.progressOf(me.id, g, from, to));
      return { id: g.id, icon: g.icon, title: g.title, hint: g.hint, target: g.target, progress, done: isDone, reward: GOAL_REWARD };
    });
    const streak = this.streakOf(me.id, day);
    const owned = new Set(this.d.shop.ownedBy(me.id));
    const rewards = new Map(db.all<{ milestone: number; item: string | null; claimed_ms: number | null }>('SELECT milestone, item, claimed_ms FROM streak_rewards WHERE user_id = ?', me.id).map((r) => [r.milestone, r]));
    const milestones: MilestoneView[] = STREAK_MILESTONES.map((m) => {
      const r = rewards.get(m.days);
      const state: MilestoneView['state'] = !r ? 'locked' : r.claimed_ms === null ? 'ready' : 'claimed';
      const choices = state === 'ready' ? COSMETICS.filter((c) => c.rarity === m.rarity && c.requiresBadge === undefined && !owned.has(c.id)).map((c) => c.id) : [];
      return { days: m.days, rarity: m.rarity, rarityName: RARITY_NAMES[m.rarity] as string, state, item: r?.item ?? null, choices };
    });
    return {
      day,
      startMs: from,
      endMs: to,
      serverMs: nowMs,
      goals,
      bonus: { reward: BONUS_REWARD, paid: db.get('SELECT 1 AS x FROM daily_bonus WHERE user_id = ? AND day = ?', me.id, day) !== undefined },
      streak,
      milestones,
    };
  }

  // ---- the free looks -----------------------------------------------------------------------------------------------

  /** Takes the free look of a streak milestone that was reached. Once per milestone, for good. */
  claim(me: User, rawMilestone: unknown, rawItem: unknown): GoalsView {
    const ms = typeof rawMilestone === 'number' ? STREAK_MILESTONES.find((m) => m.days === rawMilestone) : undefined;
    if (!ms) throw new DailyError('bad_request', `milestone must be one of: ${STREAK_MILESTONES.map((m) => m.days).join(', ')}.`, 400);
    const def = typeof rawItem === 'string' ? cosmeticById(rawItem) : undefined;
    if (!def) throw new DailyError('no_such_item', 'There is nothing like that in the Shop.', 404);
    if (def.rarity !== ms.rarity) throw new DailyError('wrong_item', `The ${ms.days}-day reward is a ${RARITY_NAMES[ms.rarity]} thing. ${def.name} is ${RARITY_NAMES[def.rarity]}.`, 400);
    if (def.requiresBadge !== undefined) throw new DailyError('wrong_item', `${def.name} needs a badge, so it can not be a free look. Pick another one.`, 400);
    const nowMs = this.d.now();
    this.d.db.tx(() => {
      if (this.isBot(me.id)) throw new DailyError('cannot_play', 'Computer players do not play daily goals.', 403);
      const r = this.d.db.get<{ claimed_ms: number | null }>('SELECT claimed_ms FROM streak_rewards WHERE user_id = ? AND milestone = ?', me.id, ms.days);
      if (!r) throw new DailyError('no_reward', `You have not reached a ${ms.days}-day streak yet.`, 403);
      if (r.claimed_ms !== null) throw new DailyError('already_claimed', `You already took the free look for ${ms.days} days.`, 409);
      this.d.db.run('UPDATE streak_rewards SET item = ?, claimed_ms = ? WHERE user_id = ? AND milestone = ? AND claimed_ms IS NULL', def.id, nowMs, me.id, ms.days);
      // Throws (and so undoes the line above) when he already owns it.
      this.d.shop.give(me, def.id, `a ${ms.days}-day streak`);
    });
    return this.view(me);
  }
}
