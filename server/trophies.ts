// The trophy room (docs/world.md §36): what a player has won, on one page of his profile card. Nothing here is new data that has to be kept in step with the game: every number is read
// from what the other parts already keep (ranked results, the weekly board's winners, the daily goals and streak, finished matches, the daily prediction, lessons, badges, teams).
// The only things written down for it are the weekly winners (server/social.ts) and the best teams of each week (server/teams.ts), because the weekly board forgets older weeks.
// A trophy room can be asked for by any signed-in player about any real player who is not banned (like the profile card). It never shows money, only places and counts.

import { BADGES } from '../src/shared/badgeCatalog';
import { RANK_TIERS } from '../src/world';
import type { Db } from './sqlite';

export interface TrophyRoom {
  readonly username: string;
  readonly displayName: string;
  /** The highest ranked tier he ever reached (null before his first ranked match) and the finished seasons he placed in. */
  readonly ranked: {
    readonly bestTier: { readonly id: string; readonly name: string; readonly icon: string } | null;
    readonly seasons: readonly { readonly seasonMs: number; readonly place: number; readonly points: number }[];
  };
  /** The weeks he was in the best three of the weekly board, newest first. */
  readonly weekly: { readonly podiums: readonly { readonly weekStartMs: number; readonly place: number; readonly gainPct: number }[]; readonly firsts: number };
  readonly goals: { readonly finished: number; readonly perfectDays: number; readonly bestStreak: number };
  readonly matches: { readonly played: number; readonly wins: number };
  readonly predictions: { readonly made: number; readonly correct: number; readonly bestRun: number };
  readonly lessons: number;
  readonly badges: { readonly earned: number; readonly total: number };
  /** The team he is in now, or null. */
  readonly team: { readonly name: string; readonly tag: string } | null;
  /** The weeks his team won a place in the weekly team race while he was a member, newest first. */
  readonly teamWins: readonly { readonly weekStartMs: number; readonly place: number; readonly teamName: string; readonly teamTag: string }[];
  /** How many things there are in all, for a quick "trophies: 12". */
  readonly count: number;
}

export interface TrophiesDeps {
  readonly db: Db;
}

/** How many finished seasons, weeks and team results one room lists. */
const LIST_SIZE = 12;

export class Trophies {
  constructor(private readonly d: TrophiesDeps) {}

  private n(sql: string, ...params: (string | number)[]): number {
    return this.d.db.get<{ n: number }>(sql, ...params)?.n ?? 0;
  }

  /** The longest run of correct picks, in the order the days were played. A draw is skipped (it neither adds nor breaks). */
  private bestRun(userId: number): number {
    let run = 0;
    let best = 0;
    for (const r of this.d.db.all<{ result: string }>("SELECT result FROM predictions WHERE user_id = ? AND result IS NOT NULL AND result <> 'draw' ORDER BY day", userId)) {
      run = r.result === 'win' ? run + 1 : 0;
      best = Math.max(best, run);
    }
    return best;
  }

  /** The trophy room of one player (the caller has already checked that he is a real player who may be shown). */
  roomOf(userId: number, username: string, displayName: string): TrophyRoom {
    const { db } = this.d;
    const best = db.get<{ best_tier: number }>('SELECT best_tier FROM ranked_player WHERE user_id = ?', userId);
    const tier = best ? RANK_TIERS[best.best_tier] : undefined;
    const seasons = db
      .all<{ season_ms: number; place: number; points: number }>('SELECT season_ms, place, points FROM ranked_season_results WHERE user_id = ? ORDER BY season_ms DESC LIMIT ?', userId, LIST_SIZE)
      .map((r) => ({ seasonMs: r.season_ms, place: r.place, points: r.points }));
    const podiums = db
      .all<{ week_start_ms: number; place: number; gain_pct: number }>('SELECT week_start_ms, place, gain_pct FROM weekly_winners WHERE user_id = ? ORDER BY week_start_ms DESC LIMIT ?', userId, LIST_SIZE)
      .map((r) => ({ weekStartMs: r.week_start_ms, place: r.place, gainPct: r.gain_pct }));
    const firsts = this.n('SELECT COUNT(*) AS n FROM weekly_winners WHERE user_id = ? AND place = 1', userId);
    const teamWins = db
      .all<{ week_start_ms: number; place: number; team_name: string; team_tag: string }>(
        `SELECT m.week_start_ms, m.place, r.team_name, r.team_tag FROM team_week_members m
           JOIN team_week_results r ON r.week_start_ms = m.week_start_ms AND r.place = m.place
          WHERE m.user_id = ? ORDER BY m.week_start_ms DESC LIMIT ?`,
        userId,
        LIST_SIZE,
      )
      .map((r) => ({ weekStartMs: r.week_start_ms, place: r.place, teamName: r.team_name, teamTag: r.team_tag }));
    const team = db.get<{ name: string; tag: string }>('SELECT t.name, t.tag FROM team_members m JOIN teams t ON t.id = m.team_id WHERE m.user_id = ?', userId);
    const made = this.n("SELECT COUNT(*) AS n FROM predictions WHERE user_id = ? AND result IS NOT NULL AND result <> 'draw'", userId);
    const correct = this.n("SELECT COUNT(*) AS n FROM predictions WHERE user_id = ? AND result = 'win'", userId);
    const bestRun = this.bestRun(userId);
    const room = {
      username,
      displayName,
      ranked: { bestTier: tier ? { id: tier.id, name: tier.name, icon: tier.icon } : null, seasons },
      weekly: { podiums, firsts },
      goals: {
        finished: this.n('SELECT COUNT(*) AS n FROM daily_goal_done WHERE user_id = ?', userId),
        perfectDays: this.n('SELECT COUNT(*) AS n FROM daily_bonus WHERE user_id = ?', userId),
        bestStreak: db.get<{ best: number }>('SELECT best FROM streaks WHERE user_id = ?', userId)?.best ?? 0,
      },
      matches: {
        played: this.n("SELECT COUNT(*) AS n FROM match_players WHERE user_id = ? AND result IN ('win', 'loss', 'tie', 'forfeit')", userId),
        wins: this.n("SELECT COUNT(*) AS n FROM match_players WHERE user_id = ? AND result = 'win'", userId),
      },
      predictions: { made, correct, bestRun },
      lessons: db.get<{ lessons_done: number }>('SELECT lessons_done FROM learn_progress WHERE user_id = ?', userId)?.lessons_done ?? 0,
      badges: { earned: this.n('SELECT COUNT(*) AS n FROM user_badges WHERE user_id = ?', userId), total: BADGES.length },
      team: team ? { name: team.name, tag: team.tag } : null,
      teamWins,
    };
    // A short number for the card: finished seasons on the podium, weeks on the weekly podium and team wins, and the best tier.
    const count = seasons.filter((s) => s.place <= 3).length + podiums.length + teamWins.filter((t) => t.place === 1).length + (tier && tier.id !== 'bronze' ? 1 : 0);
    return { ...room, count };
  }
}
