// Ranked 1v1 (docs/world.md §31). The arithmetic (tiers, points, the floor, the soft reset) is src/world/rankedRules.ts; this file keeps the players' points, settles them
// inside the same transaction that settles a match, starts a new season every Monday 00:00 Tokyo time and answers the ladder.
//
// What counts: a match the lobby made between two REAL players who did not agree on it beforehand. A friend match (a challenge), a match against a bot, a cancelled match and
// an abandoned one (both left) never move points. The same two players earn points from each other at most PAIR_LIMIT times an hour, so friends cannot trade wins.
// Nothing here gives money, changes a price or an order: it is points and a name for them.

import {
  PAIR_LIMIT,
  PAIR_WINDOW_MS,
  RANK_START_POINTS,
  RANK_TIERS,
  SEASON_MIN_MATCHES,
  SEASON_PLACES,
  applyDelta,
  pointsDelta,
  progressOf,
  seasonStartPoints,
  tierIndexOf,
  type MatchOutcome,
  type PlayerResult,
  type RankTier,
} from '../src/world';
import type { User } from './auth';
import type { Logger } from './log';
import { WEEK_MS, weekStartOf } from './social';
import type { Db } from './sqlite';

export interface RankedDeps {
  readonly db: Db;
  readonly now: () => number;
  readonly log: Logger;
}

/** How many players the ladder shows. */
export const LADDER_SIZE = 50;
const SEASON_KEY = 'ranked_season_ms';

export interface RankedPlayerView {
  readonly points: number;
  readonly tier: string;
  readonly tierName: string;
  readonly tierIcon: string;
  /** The tier above (its name and the points it starts at), or null in Diamond. */
  readonly next: { readonly name: string; readonly floor: number } | null;
  /** Points above the bottom of the tier, the size of the tier, and how far across it the player is (0 … 1). */
  readonly into: number;
  readonly span: number;
  readonly fraction: number;
  /** The bottom of the highest tier reached this season: the points can not fall below it. */
  readonly floorPoints: number;
  readonly matches: number;
  readonly wins: number;
  readonly losses: number;
  /** The place on the ladder this season, or null before the first ranked match of the season. */
  readonly place: number | null;
}

export interface LadderEntry {
  readonly place: number;
  readonly username: string;
  readonly displayName: string;
  readonly points: number;
  readonly tier: string;
  readonly tierName: string;
  readonly tierIcon: string;
  readonly matches: number;
  readonly you: boolean;
}

export interface RankedView {
  readonly season: { readonly startMs: number; readonly endMs: number };
  readonly startPoints: number;
  readonly tiers: readonly { readonly id: string; readonly name: string; readonly floor: number; readonly icon: string }[];
  /** The player's own standing. Before his first ranked match it is the starting points. */
  readonly me: RankedPlayerView;
  readonly ladder: readonly LadderEntry[];
  /** How many players have played a ranked match this season. */
  readonly players: number;
  /** The podium of the last finished season, or null. */
  readonly lastSeason: { readonly startMs: number; readonly places: readonly { place: number; username: string; displayName: string; points: number }[] } | null;
  readonly rules: { readonly minMatches: number; readonly pairLimit: number };
}

/** What happened to one player's points in one match. */
export interface RankChange {
  readonly before: number;
  readonly after: number;
  readonly note: 'limit' | null;
}

/** What the match service tells this class when it settles a match (inside its transaction). */
export interface SettledMatch {
  readonly matchId: number;
  /** A match two friends agreed on (a challenge). */
  readonly friends: boolean;
  readonly outcome: MatchOutcome;
  readonly nowMs: number;
  readonly players: readonly { readonly userId: number; readonly bot: boolean; readonly result: PlayerResult }[];
}

interface Row {
  user_id: number;
  season_ms: number;
  points: number;
  peak_tier: number;
  best_tier: number;
  matches: number;
  wins: number;
  losses: number;
}

export class Ranked {
  constructor(private readonly d: RankedDeps) {}

  // ---- the season ---------------------------------------------------------------------------------------------------

  /** The start of the season now running (Monday 00:00 Tokyo time). */
  seasonNow(): number {
    return weekStartOf(this.d.now());
  }

  /**
   * Starts a new season when the week has changed (the game calls this every few seconds; it does nothing until then). The best players of the season that ended are written
   * down for good (the badges read them), then everybody's points move halfway back to the starting points and the season counters start again.
   * Returns true when a season was closed.
   */
  rollSeason(): boolean {
    const { db } = this.d;
    const season = this.seasonNow();
    const stored = Number(db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', SEASON_KEY)?.value ?? 0);
    if (stored === season) return false;
    db.tx(() => {
      if (stored > 0) {
        const top = db.all<{ user_id: number; points: number; matches: number }>(
          `SELECT r.user_id, r.points, r.matches FROM ranked_player r JOIN users u ON u.id = r.user_id
            WHERE r.season_ms = ? AND r.matches >= ? AND u.role <> 'owner'
            ORDER BY r.points DESC, r.wins DESC, r.user_id LIMIT ?`,
          stored,
          SEASON_MIN_MATCHES,
          SEASON_PLACES,
        );
        top.forEach((t, i) => {
          db.run('INSERT OR IGNORE INTO ranked_season_results(season_ms, place, user_id, points, matches) VALUES (?, ?, ?, ?, ?)', stored, i + 1, t.user_id, t.points, t.matches);
        });
        for (const r of db.all<Row>('SELECT user_id, season_ms, points, peak_tier, best_tier, matches, wins, losses FROM ranked_player')) {
          const points = seasonStartPoints(r.points);
          const tier = tierIndexOf(points);
          db.run(
            'UPDATE ranked_player SET season_ms = ?, points = ?, peak_tier = ?, matches = 0, wins = 0, losses = 0, updated_ms = ? WHERE user_id = ?',
            season,
            points,
            tier,
            this.d.now(),
            r.user_id,
          );
        }
        this.d.log.info('ranked', `Ranked season ${new Date(stored).toISOString().slice(0, 10)} is over (${top.length} on the podium list). A new season has started.`);
      }
      db.run('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', SEASON_KEY, String(season));
    });
    return stored > 0;
  }

  // ---- settling a match ---------------------------------------------------------------------------------------------

  /** Whether a match of this kind moves points: two real players from the lobby, not a challenge, not abandoned. */
  static counts(m: Pick<SettledMatch, 'friends' | 'outcome' | 'players'>): boolean {
    return !m.friends && m.outcome !== 'abandoned' && m.players.length === 2 && m.players.every((p) => !p.bot);
  }

  private rowOf(userId: number, season: number): Row {
    const have = this.d.db.get<Row>('SELECT user_id, season_ms, points, peak_tier, best_tier, matches, wins, losses FROM ranked_player WHERE user_id = ?', userId);
    if (have) return have;
    const start = tierIndexOf(RANK_START_POINTS);
    return { user_id: userId, season_ms: season, points: RANK_START_POINTS, peak_tier: start, best_tier: start, matches: 0, wins: 0, losses: 0 };
  }

  /**
   * Moves the points of the two players of a settled match (call inside the settling transaction) and writes down what they were before and after on the match rows. Does
   * nothing for a match that does not count. Returns what happened to each player, or null.
   */
  settle(m: SettledMatch): Map<number, RankChange> | null {
    if (!Ranked.counts(m)) return null;
    const { db } = this.d;
    this.rollSeason();
    const season = this.seasonNow();
    const [a, b] = m.players as readonly [SettledMatch['players'][number], SettledMatch['players'][number]];
    const ra = this.rowOf(a.userId, season);
    const rb = this.rowOf(b.userId, season);
    // The same two players earn points from each other only a few times an hour.
    const recent =
      db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM match_players x JOIN match_players y ON y.match_id = x.match_id AND y.user_id = ?
           JOIN matches mm ON mm.id = x.match_id
          WHERE x.user_id = ? AND x.rank_before IS NOT NULL AND x.rank_note IS NULL AND mm.settled_ms > ? AND mm.id <> ?`,
        b.userId,
        a.userId,
        m.nowMs - PAIR_WINDOW_MS,
        m.matchId,
      )?.n ?? 0;
    const capped = recent >= PAIR_LIMIT;
    const out = new Map<number, RankChange>();
    const one = (me: Row, you: Row, mine: SettledMatch['players'][number]): void => {
      const delta = capped ? 0 : pointsDelta(mine.result, me.points, you.points);
      const next = applyDelta({ points: me.points, peakTier: me.peak_tier }, delta);
      const wins = me.wins + (mine.result === 'win' ? 1 : 0);
      const losses = me.losses + (mine.result === 'loss' || mine.result === 'forfeit' ? 1 : 0);
      db.run(
        `INSERT INTO ranked_player(user_id, season_ms, points, peak_tier, best_tier, matches, wins, losses, updated_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET season_ms = excluded.season_ms, points = excluded.points, peak_tier = excluded.peak_tier, best_tier = excluded.best_tier,
           matches = excluded.matches, wins = excluded.wins, losses = excluded.losses, updated_ms = excluded.updated_ms`,
        mine.userId,
        season,
        next.points,
        next.peakTier,
        Math.max(me.best_tier, next.peakTier),
        me.matches + 1,
        wins,
        losses,
        m.nowMs,
      );
      const note = capped ? 'limit' : null;
      db.run('UPDATE match_players SET rank_before = ?, rank_after = ?, rank_note = ? WHERE match_id = ? AND user_id = ?', me.points, next.points, note, m.matchId, mine.userId);
      out.set(mine.userId, { before: me.points, after: next.points, note });
    };
    one(ra, rb, a);
    one(rb, ra, b);
    return out;
  }

  // ---- reading ------------------------------------------------------------------------------------------------------

  private viewOfRow(r: Row, place: number | null): RankedPlayerView {
    const p = progressOf(r.points);
    return {
      points: r.points,
      tier: p.tier.id,
      tierName: p.tier.name,
      tierIcon: p.tier.icon,
      next: p.next ? { name: p.next.name, floor: p.next.floor } : null,
      into: p.into,
      span: p.span,
      fraction: p.fraction,
      floorPoints: (RANK_TIERS[r.peak_tier] ?? (RANK_TIERS[0] as RankTier)).floor,
      matches: r.matches,
      wins: r.wins,
      losses: r.losses,
      place,
    };
  }

  /** The rows of this season's ladder, best first: players with at least one ranked match this season, without the owner and anybody banned right now. */
  private ladderRows(limit: number): (Row & { username: string; display_name: string })[] {
    return this.d.db.all<Row & { username: string; display_name: string }>(
      `SELECT r.user_id, r.season_ms, r.points, r.peak_tier, r.best_tier, r.matches, r.wins, r.losses, u.username, u.display_name
         FROM ranked_player r JOIN users u ON u.id = r.user_id
        WHERE r.season_ms = ? AND r.matches >= 1 AND u.role <> 'owner'
          AND NOT EXISTS (SELECT 1 FROM user_bans x WHERE x.user_id = r.user_id AND (x.until_ms IS NULL OR x.until_ms > ?))
        ORDER BY r.points DESC, r.wins DESC, r.user_id LIMIT ?`,
      this.seasonNow(),
      this.d.now(),
      limit,
    );
  }

  /** A player's own standing (the starting points if he has not played a ranked match yet). */
  standing(userId: number): RankedPlayerView {
    this.rollSeason();
    const season = this.seasonNow();
    const row = this.rowOf(userId, season);
    let place: number | null = null;
    if (row.matches >= 1 && row.season_ms === season) {
      place =
        1 +
        (this.d.db.get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM ranked_player r JOIN users u ON u.id = r.user_id
            WHERE r.season_ms = ? AND r.matches >= 1 AND u.role <> 'owner'
              AND (r.points > ? OR (r.points = ? AND (r.wins > ? OR (r.wins = ? AND r.user_id < ?))))`,
          season,
          row.points,
          row.points,
          row.wins,
          row.wins,
          userId,
        )?.n ?? 0);
    }
    return this.viewOfRow(row, place);
  }

  view(me: User): RankedView {
    this.rollSeason();
    const season = this.seasonNow();
    const rows = this.ladderRows(LADDER_SIZE);
    const ladder: LadderEntry[] = rows.map((r, i) => {
      const t = progressOf(r.points).tier;
      return { place: i + 1, username: r.username, displayName: r.display_name, points: r.points, tier: t.id, tierName: t.name, tierIcon: t.icon, matches: r.matches, you: r.user_id === me.id };
    });
    const players = this.d.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM ranked_player r JOIN users u ON u.id = r.user_id WHERE r.season_ms = ? AND r.matches >= 1 AND u.role <> 'owner'", season)?.n ?? 0;
    const last = this.d.db.get<{ season_ms: number }>('SELECT MAX(season_ms) AS season_ms FROM ranked_season_results');
    let lastSeason: RankedView['lastSeason'] = null;
    if (last && last.season_ms !== null && last.season_ms !== undefined) {
      const places = this.d.db.all<{ place: number; username: string; display_name: string; points: number }>(
        `SELECT s.place, u.username, u.display_name, s.points FROM ranked_season_results s JOIN users u ON u.id = s.user_id WHERE s.season_ms = ? AND s.place <= 3 ORDER BY s.place`,
        last.season_ms,
      );
      lastSeason = { startMs: last.season_ms, places: places.map((p) => ({ place: p.place, username: p.username, displayName: p.display_name, points: p.points })) };
    }
    return {
      season: { startMs: season, endMs: season + WEEK_MS },
      startPoints: RANK_START_POINTS,
      tiers: RANK_TIERS.map((t) => ({ id: t.id, name: t.name, floor: t.floor, icon: t.icon })),
      me: this.standing(me.id),
      ladder,
      players,
      lastSeason,
      rules: { minMatches: SEASON_MIN_MATCHES, pairLimit: PAIR_LIMIT },
    };
  }

  /** The tier and points of some players this season, for the profile card. A player who has not played a ranked match this season is not in the answer. */
  tiersOf(userIds: readonly number[]): Map<number, { points: number; tier: string; tierName: string; tierIcon: string }> {
    const out = new Map<number, { points: number; tier: string; tierName: string; tierIcon: string }>();
    if (userIds.length === 0) return out;
    const marks = userIds.map(() => '?').join(',');
    for (const r of this.d.db.all<{ user_id: number; points: number }>(`SELECT user_id, points FROM ranked_player WHERE season_ms = ? AND matches >= 1 AND user_id IN (${marks})`, this.seasonNow(), ...userIds)) {
      const t = progressOf(r.points).tier;
      out.set(r.user_id, { points: r.points, tier: t.id, tierName: t.name, tierIcon: t.icon });
    }
    return out;
  }
}
