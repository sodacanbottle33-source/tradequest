// Achievement badges (docs/world.md §22). The list of badges, with their names and how to get them, is src/shared/badgeCatalog.ts; this file has
// the rule for each one and gives a badge to a player once his play shows he earned it. A badge is never taken back, even if the player's money is
// reset later. Badges are only for fun: they give no money, change no price and are not part of the market simulation.
//
// How a badge is given: every little while (and when a player opens his Badges page) each rule asks the database "who qualifies?" in one query,
// the players who do not have the badge yet get it, and each of them is told over his live stream. The rules read only things the game saved
// anyway (trades, friendships, launches, Learn progress, match results...), so no other part of the game has to know about badges.

import { TUTORIAL_STEPS } from '../src/learn/tutorial';
import { STOCK_SECTOR_IDS } from '../src/world/params';
import { BADGES, bestBadges } from '../src/shared/badgeCatalog';
import type { Db } from './sqlite';

export interface BadgeDeps {
  readonly db: Db;
  readonly now: () => number;
  /** Tells one player's pages something happened. */
  readonly publishTo: (userId: number, event: string, data: unknown) => void;
  /** How far a Career account is above its start (cents; negative when below): the same number the account page shows as profit. */
  readonly profitOf: (accountId: number) => number;
  /** The sector of a company (for the sector badges), or undefined when it is not known. Without it the two sector badges are simply never given. */
  readonly sectorOf?: (companyId: number) => string | undefined;
}

/** One line of the Badges page. */
export interface BadgeLine {
  readonly id: string;
  /** When this player got it, or null. */
  readonly earnedMs: number | null;
  /** How many real players have it. */
  readonly owners: number;
}

export interface BadgesView {
  readonly badges: readonly BadgeLine[];
  /** How many real players there are (so a page can say "12% of players"). */
  readonly players: number;
}

const DAY_MS = 86_400_000;

/** Computer players are not people: they never get badges and do not count as "other players". */
const REAL = "u.pw_hash <> 'bot' AND NOT EXISTS (SELECT 1 FROM bots bt WHERE bt.user_id = u.id)";

/** A rule is SQL that returns the ids of the players (column user_id) who qualify right now. `now` is a whole number, so it is safe to write into the text. */
type Rule = (now: number) => string;

const accepted = 'SELECT user_a AS user_id FROM friendships WHERE status = \'accepted\' UNION ALL SELECT user_b FROM friendships WHERE status = \'accepted\'';
const careerTrades = "FROM trades t JOIN accounts a ON a.id = t.account_id WHERE a.kind = 'career'";
const wonMatches = "FROM match_players WHERE result = 'win'";
/** Buyers of a launched company who are real people other than the one who launched it. */
const buyersOfLaunched =
  "FROM launches l JOIN trades t ON t.company_id = l.company_id AND t.side = 'buy' JOIN accounts a ON a.id = t.account_id AND a.kind = 'career' AND a.user_id <> l.user_id JOIN users u ON u.id = a.user_id WHERE u.pw_hash <> 'bot' AND NOT EXISTS (SELECT 1 FROM bots bt WHERE bt.user_id = u.id)";
const TUTORIAL_FULL = 2 ** TUTORIAL_STEPS - 1;

/** The rule of every badge except the profit ones (those need a price lookup and are done in code below). */
const RULES: Record<string, Rule> = {
  first_trade: () => `SELECT DISTINCT a.user_id ${careerTrades}`,
  trades_10: () => `SELECT a.user_id ${careerTrades} GROUP BY a.user_id HAVING COUNT(*) >= 10`,
  trades_100: () => `SELECT a.user_id ${careerTrades} GROUP BY a.user_id HAVING COUNT(*) >= 100`,
  first_profit: () => `SELECT DISTINCT a.user_id ${careerTrades} AND t.realized_cents > 0`,
  limit_filled: () => "SELECT DISTINCT a.user_id FROM limit_orders o JOIN accounts a ON a.id = o.account_id WHERE a.kind = 'career' AND o.fills > 0",
  launch_stock: () => "SELECT DISTINCT user_id FROM launches WHERE kind = 'stock'",
  launch_coin: () => "SELECT DISTINCT user_id FROM launches WHERE kind = 'coin'",
  company_logo: () => 'SELECT DISTINCT l.user_id FROM launches l JOIN company_pictures cp ON cp.company_id = l.company_id WHERE cp.set_by = l.user_id',
  first_investor: () => `SELECT DISTINCT l.user_id ${buyersOfLaunched}`,
  ten_investors: () => `SELECT l.user_id ${buyersOfLaunched} GROUP BY l.company_id, l.user_id HAVING COUNT(DISTINCT a.user_id) >= 10`,
  welcome: () => 'SELECT id AS user_id FROM users',
  first_friend: () => `SELECT DISTINCT user_id FROM (${accepted})`,
  five_friends: () => `SELECT user_id FROM (${accepted}) GROUP BY user_id HAVING COUNT(*) >= 5`,
  first_group: () => "SELECT DISTINCT cm.user_id FROM conversation_members cm JOIN conversations c ON c.id = cm.conversation_id WHERE c.kind = 'group' AND cm.state = 'member'",
  first_chat: () => 'SELECT DISTINCT user_id FROM chat_messages',
  profile_pic: () => 'SELECT user_id FROM user_avatars',
  week_one: (now) => `SELECT id AS user_id FROM users WHERE created_ms <= ${now - 7 * DAY_MS}`,
  month_one: (now) => `SELECT id AS user_id FROM users WHERE created_ms <= ${now - 30 * DAY_MS}`,
  first_lesson: () => 'SELECT user_id FROM learn_progress WHERE lessons_done >= 1',
  lessons_10: () => 'SELECT user_id FROM learn_progress WHERE lessons_done >= 10',
  lessons_50: () => 'SELECT user_id FROM learn_progress WHERE lessons_done >= 50',
  streak_5: () => 'SELECT user_id FROM learn_progress WHERE best_streak >= 5',
  tutorial_done: () => `SELECT user_id FROM learn_progress WHERE tutorial_mask >= ${TUTORIAL_FULL}`,
  first_match: () => "SELECT DISTINCT user_id FROM match_players WHERE result IN ('win', 'loss', 'tie')",
  first_win: () => `SELECT DISTINCT user_id ${wonMatches}`,
  wins_5: () => `SELECT user_id ${wonMatches} GROUP BY user_id HAVING COUNT(*) >= 5`,
  // ---- the second batch (docs/world.md §28)
  trades_1000: () => `SELECT a.user_id ${careerTrades} GROUP BY a.user_id HAVING COUNT(*) >= 1000`,
  winners_10: () => `SELECT a.user_id ${careerTrades} AND t.realized_cents > 0 GROUP BY a.user_id HAVING COUNT(*) >= 10`,
  home_run: () => `SELECT DISTINCT a.user_id ${careerTrades} AND t.realized_cents >= ${HOME_RUN_CENTS}`,
  // A long position that is still open, that was first bought at least a week ago, and that was never sold from (not even a little). A company that went bankrupt does not count.
  hold_7d: (now) =>
    `SELECT DISTINCT a.user_id FROM positions p JOIN accounts a ON a.id = p.account_id
      WHERE a.kind = 'career' AND p.short = 0
        AND EXISTS (SELECT 1 FROM trades b WHERE b.account_id = p.account_id AND b.company_id = p.company_id AND b.side = 'buy' AND b.short = 0 AND b.created_ms <= ${now - 7 * DAY_MS})
        AND NOT EXISTS (SELECT 1 FROM trades s WHERE s.account_id = p.account_id AND s.company_id = p.company_id AND s.side = 'sell' AND s.short = 0)
        AND NOT EXISTS (SELECT 1 FROM bankruptcies bk WHERE bk.company_id = p.company_id)`,
  trade_days_7: () => `SELECT a.user_id ${careerTrades} GROUP BY a.user_id HAVING COUNT(DISTINCT t.created_ms / ${DAY_MS}) >= 7`,
  // A long buy of a company that went bankrupt after that buy.
  lesson_learned: () =>
    `SELECT DISTINCT a.user_id ${careerTrades} AND t.side = 'buy' AND t.short = 0 AND EXISTS (SELECT 1 FROM bankruptcies bk WHERE bk.company_id = t.company_id AND bk.declared_ms > t.created_ms)`,
  launch_3: () => 'SELECT user_id FROM launches GROUP BY user_id HAVING COUNT(*) >= 3',
  fan_club: () => `SELECT l.user_id ${buyersOfLaunched} GROUP BY l.company_id, l.user_id HAVING COUNT(DISTINCT a.user_id) >= 25`,
  friends_25: () => `SELECT user_id FROM (${accepted}) GROUP BY user_id HAVING COUNT(*) >= 25`,
  chatterbox: () => 'SELECT user_id FROM chat_messages WHERE deleted_ms IS NULL GROUP BY user_id HAVING COUNT(*) >= 100',
  lessons_100: () => 'SELECT user_id FROM learn_progress WHERE lessons_done >= 100',
  wins_25: () => `SELECT user_id ${wonMatches} GROUP BY user_id HAVING COUNT(*) >= 25`,
  // ---- the third batch (docs/world.md §31 and §32): daily goals, the streak and ranked 1v1
  streak_3: () => 'SELECT user_id FROM streaks WHERE best >= 3',
  streak_7: () => 'SELECT user_id FROM streaks WHERE best >= 7',
  streak_14: () => 'SELECT user_id FROM streaks WHERE best >= 14',
  streak_30: () => 'SELECT user_id FROM streaks WHERE best >= 30',
  perfect_day: () => 'SELECT DISTINCT user_id FROM daily_bonus',
  goals_50: () => 'SELECT user_id FROM daily_goal_done GROUP BY user_id HAVING COUNT(*) >= 50',
  rank_silver: () => 'SELECT user_id FROM ranked_player WHERE best_tier >= 1',
  rank_gold: () => 'SELECT user_id FROM ranked_player WHERE best_tier >= 2',
  rank_platinum: () => 'SELECT user_id FROM ranked_player WHERE best_tier >= 3',
  rank_diamond: () => 'SELECT user_id FROM ranked_player WHERE best_tier >= 4',
  season_podium: () => 'SELECT DISTINCT user_id FROM ranked_season_results WHERE place <= 3',
  season_champion: () => 'SELECT DISTINCT user_id FROM ranked_season_results WHERE place = 1',
};

/** One closed trade with at least this much profit is a Home Run: $500 (the same size the game calls a huge win). */
export const HOME_RUN_CENTS = 50_000;

/** The profit badges: how far above the start (cents) the Career account has to be. */
const PROFIT_BADGES: readonly (readonly [string, number])[] = [
  ['profit_1k', 100_000],
  ['profit_10k', 1_000_000],
  ['profit_100k', 10_000_000],
  ['profit_1m', 100_000_000],
];

/** The sector badges: how many different stock sectors (memecoins do not count) a player has bought. Done in code because a company's sector is not in the database. */
const SECTOR_BADGES: readonly (readonly [string, number])[] = [
  ['sectors_5', 5],
  ['all_sectors', STOCK_SECTOR_IDS.length],
];

/** Every badge id that has a rule here (a test checks this against the catalog, so a badge can never be listed without one). */
export const RULE_IDS: readonly string[] = [...Object.keys(RULES), ...PROFIT_BADGES.map(([id]) => id), ...SECTOR_BADGES.map(([id]) => id)];

export class Badges {
  constructor(private readonly d: BadgeDeps) {}

  /**
   * Gives every badge that somebody has earned and does not have yet; `onlyUserId` looks at one player only. Returns how many were given.
   * The players are told over their live streams after everything is saved.
   */
  sweep(onlyUserId?: number): number {
    const { db } = this.d;
    const now = this.d.now();
    const given = new Map<number, string[]>();
    const give = (userId: number, badge: string): void => {
      db.run('INSERT OR IGNORE INTO user_badges(user_id, badge, earned_ms) VALUES (?, ?, ?)', userId, badge, now);
      const list = given.get(userId) ?? [];
      list.push(badge);
      given.set(userId, list);
    };
    const only = onlyUserId === undefined ? '' : ' AND q.user_id = ?';
    db.tx(() => {
      for (const badge of Object.keys(RULES)) {
        const rule = RULES[badge] as Rule;
        const params: (string | number)[] = onlyUserId === undefined ? [badge] : [onlyUserId, badge];
        const rows = db.all<{ user_id: number }>(
          `SELECT DISTINCT q.user_id FROM (${rule(now)}) q JOIN users u ON u.id = q.user_id
            WHERE ${REAL}${only} AND NOT EXISTS (SELECT 1 FROM user_badges b WHERE b.user_id = q.user_id AND b.badge = ?)`,
          ...params,
        );
        for (const r of rows) give(r.user_id, badge);
      }
      // Profit needs the price of what the player holds, so it is worked out one account at a time (only accounts that traded and still lack a profit badge).
      const lacking = PROFIT_BADGES.map(([id]) => `NOT EXISTS (SELECT 1 FROM user_badges b WHERE b.user_id = a.user_id AND b.badge = '${id}')`).join(' OR ');
      const accounts = db.all<{ user_id: number; account_id: number }>(
        `SELECT a.user_id, a.id AS account_id FROM accounts a JOIN users u ON u.id = a.user_id
          WHERE a.kind = 'career' AND ${REAL} AND EXISTS (SELECT 1 FROM trades t WHERE t.account_id = a.id) AND (${lacking})${onlyUserId === undefined ? '' : ' AND a.user_id = ?'}`,
        ...(onlyUserId === undefined ? [] : [onlyUserId]),
      );
      for (const acc of accounts) {
        const profit = this.d.profitOf(acc.account_id);
        for (const [id, need] of PROFIT_BADGES) {
          if (profit < need) continue;
          if (db.get('SELECT 1 AS x FROM user_badges WHERE user_id = ? AND badge = ?', acc.user_id, id) !== undefined) continue;
          give(acc.user_id, id);
        }
      }
      // The sector badges: the different sectors of the companies a player has bought (long buys in the Career account). Only players who still lack one of them are looked at.
      const sectorOf = this.d.sectorOf;
      if (sectorOf !== undefined) {
        const lackingSector = SECTOR_BADGES.map(([id]) => `NOT EXISTS (SELECT 1 FROM user_badges b WHERE b.user_id = a.user_id AND b.badge = '${id}')`).join(' OR ');
        const bought = db.all<{ user_id: number; company_id: number }>(
          `SELECT DISTINCT a.user_id, t.company_id FROM trades t JOIN accounts a ON a.id = t.account_id JOIN users u ON u.id = a.user_id
            WHERE a.kind = 'career' AND t.side = 'buy' AND t.short = 0 AND ${REAL} AND (${lackingSector})${onlyUserId === undefined ? '' : ' AND a.user_id = ?'}`,
          ...(onlyUserId === undefined ? [] : [onlyUserId]),
        );
        const sectors = new Map<number, Set<string>>();
        for (const row of bought) {
          const sector = sectorOf(row.company_id);
          if (sector === undefined || sector === 'meme') continue;
          const set = sectors.get(row.user_id) ?? new Set<string>();
          set.add(sector);
          sectors.set(row.user_id, set);
        }
        for (const [userId, set] of sectors) {
          for (const [id, need] of SECTOR_BADGES) {
            if (set.size < need) continue;
            if (db.get('SELECT 1 AS x FROM user_badges WHERE user_id = ? AND badge = ?', userId, id) !== undefined) continue;
            give(userId, id);
          }
        }
      }
    });
    let total = 0;
    for (const [userId, list] of given) {
      total += list.length;
      this.d.publishTo(userId, 'badges', { earned: list });
    }
    return total;
  }

  /** The Badges page of one player: every badge, when he got it (if he did) and how many players have it. */
  view(me: { id: number }): BadgesView {
    this.sweep(me.id);
    const { db } = this.d;
    const mine = new Map(db.all<{ badge: string; earned_ms: number }>('SELECT badge, earned_ms FROM user_badges WHERE user_id = ?', me.id).map((r) => [r.badge, r.earned_ms]));
    const owners = new Map(
      db.all<{ badge: string; n: number }>(`SELECT b.badge, COUNT(*) AS n FROM user_badges b JOIN users u ON u.id = b.user_id WHERE ${REAL} GROUP BY b.badge`).map((r) => [r.badge, r.n]),
    );
    const players = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM users u WHERE ${REAL}`)?.n ?? 0;
    return { badges: BADGES.map((b) => ({ id: b.id, earnedMs: mine.get(b.id) ?? null, owners: owners.get(b.id) ?? 0 })), players };
  }

  /** Every badge one player has earned, highest tier first (for the profile card). */
  earnedBy(userId: number): string[] {
    return bestBadges(
      this.d.db.all<{ badge: string }>('SELECT badge FROM user_badges WHERE user_id = ?', userId).map((r) => r.badge),
      BADGES.length,
    );
  }

  /** The best badges (at most three, best first) of each of these players, for the Players list. A player with none is not in the answer. */
  best(userIds: readonly number[]): Map<number, string[]> {
    const out = new Map<number, string[]>();
    if (userIds.length === 0) return out;
    const marks = userIds.map(() => '?').join(',');
    const all = new Map<number, string[]>();
    for (const r of this.d.db.all<{ user_id: number; badge: string }>(`SELECT user_id, badge FROM user_badges WHERE user_id IN (${marks})`, ...userIds)) {
      const list = all.get(r.user_id) ?? [];
      list.push(r.badge);
      all.set(r.user_id, list);
    }
    for (const [id, list] of all) {
      const top = bestBadges(list);
      if (top.length > 0) out.set(id, top);
    }
    return out;
  }
}
