// The 1v1 lobby and the matches. Everything that matters is decided here, on the server:
//   who is in a lobby, who is ready, when the countdown ends, when the three minutes start and end, who may trade, who
//   won, and what each player is paid (once). A browser can only ask: join, ready, leave. It can never say "the lobby
//   is full" or "the match started".
//
// A match is a WINDOW on the one shared market: it starts at tick S (a multiple of 10) and ends at tick E = S + 180.
// Both players trade the same global prices, news and clock, so they cannot see different markets. Each player trades a
// private match account with exactly $1,000; their orders only touch that account (and their own depth, never the
// market's price), so any number of matches can run at once without affecting each other, and the market never resets.
// Scores are computed from the stored candle at tick E, so the result does not depend on when the server happens to settle.

import {
  COUNTDOWN_TICKS,
  LOSER_REWARD_CENTS,
  MATCH_CASH_CENTS,
  MATCH_TICKS,
  PRESENCE_MS,
  TICKS_PER_CANDLE,
  decideMatch,
  matchStartTick,
  type MatchOutcome,
  type PlayerResult,
} from '../../src/world';
import { equityOf } from '../leverage';
import { BOT_WAIT_MS, freeBot } from './bots';
import type { Logger } from '../log';
import type { Db } from '../sqlite';
import type { AccountRow, Trading } from '../trading';
import type { WorldRuntime } from '../world/runtime';

/** Why a match account cannot trade a company a player launched (shown to the player as it is). */
export const LAUNCHED_IN_MATCH = 'Companies that players launched cannot be traded in a 1v1 match, so nobody can win by pumping their own coin or stock. Pick any other company.';
/** Why a player cannot launch a company while his match is about to start or running. */
export const NO_LAUNCH_IN_MATCH = 'You cannot launch a coin or a stock while your 1v1 match is starting or running. Launch it after the match.';

export type Phase = 'waiting' | 'ready_check' | 'countdown' | 'live' | 'settling' | 'finished' | 'cancelled';

export class LobbyError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface MatchRow {
  id: number;
  state: 'lobby' | 'countdown' | 'live' | 'finished' | 'cancelled';
  created_ms: number;
  start_tick: number | null;
  end_tick: number | null;
  duration_ticks: number;
  start_cash_cents: number;
  settled_ms: number | null;
  outcome: MatchOutcome | null;
  winner_user_id: number | null;
  cancel_reason: string | null;
  /** 1 for a match two friends agreed on (a challenge): a lobby of exactly those two, closed to everybody else. */
  friends: number;
}

interface PlayerRow {
  match_id: number;
  user_id: number;
  display_name: string;
  joined_ms: number;
  last_seen_ms: number;
  ready: number;
  active: number;
  forfeited: number;
  account_id: number | null;
  final_value_cents: number | null;
  profit_cents: number | null;
  result: PlayerResult | null;
  reward_cents: number | null;
  dismissed: number;
  is_bot: number;
}

export interface MatchPlayerView {
  readonly userId: number;
  readonly name: string;
  /** A computer player (docs/world.md §9.9). */
  readonly bot: boolean;
  readonly ready: boolean;
  readonly you: boolean;
  readonly forfeited: boolean;
  /** Only after the match is over. */
  readonly finalValueCents: number | null;
  readonly profitCents: number | null;
  readonly result: PlayerResult | null;
  readonly rewardCents: number | null;
}

export interface MatchView {
  readonly id: number;
  readonly phase: Phase;
  readonly playerCount: number;
  readonly capacity: 2;
  readonly players: readonly MatchPlayerView[];
  readonly message: string;
  readonly startCashCents: number;
  readonly durationTicks: number;
  readonly startTick: number | null;
  readonly endTick: number | null;
  readonly startMs: number | null;
  readonly endMs: number | null;
  /** The market's tick when this view was made. Clients count down from the tick stream, not from their own clocks. */
  readonly tick: number;
  readonly ticksToStart: number | null;
  readonly ticksLeft: number | null;
  readonly outcome: MatchOutcome | null;
  readonly winnerUserId: number | null;
  readonly cancelReason: string | null;
  readonly canTrade: boolean;
  /** True for a match between two friends who agreed to play (a challenge, server/challenges.ts). */
  readonly friendMatch: boolean;
}

export interface HistoryEntry {
  readonly matchId: number;
  readonly state: 'finished' | 'cancelled';
  readonly outcome: MatchOutcome | null;
  readonly endedMs: number | null;
  readonly startTick: number | null;
  readonly you: { profitCents: number | null; finalValueCents: number | null; result: PlayerResult | null; rewardCents: number | null };
  readonly opponent: { name: string | null; bot: boolean; profitCents: number | null; finalValueCents: number | null } | null;
  readonly cancelReason: string | null;
}

export interface WalletView {
  readonly balanceCents: number;
  readonly recent: { id: number; deltaCents: number; reason: string; matchId: number | null; createdMs: number }[];
}

export interface MatchServiceOptions {
  readonly db: Db;
  readonly world: WorldRuntime;
  readonly trading: Trading;
  readonly log: Logger;
  readonly now: () => number;
  /** Called when a player's view of their match changed (join, ready, countdown, start, result...). */
  readonly onChange?: (userId: number, view: MatchView | null) => void;
  /** Computer opponents (docs/world.md §9.9). Off unless the app turns them on: tests of the plain lobby leave them out. */
  readonly bots?: boolean;
  /** How long a player waits alone before a bot joins (default {@link BOT_WAIT_MS}). */
  readonly botWaitMs?: number;
}

const CANCEL_TEXT: Record<string, string> = {
  everyone_left: 'Everybody left this lobby.',
  server_restart: 'The server restarted during this match, so it was cancelled. Nobody won or lost.',
  start_missed: 'The match could not start on time and was cancelled. Nobody won or lost.',
  friend_left: 'Your friend left before the match started, so it was cancelled. Nobody won or lost.',
};

export class MatchService {
  private readonly db: Db;
  private readonly world: WorldRuntime;
  private readonly trading: Trading;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly onChange: (userId: number, view: MatchView | null) => void;
  private readonly botsOn: boolean;
  private readonly botWaitMs: number;
  private lastSettleError = 0;

  constructor(o: MatchServiceOptions) {
    this.db = o.db;
    this.world = o.world;
    this.trading = o.trading;
    this.log = o.log;
    this.now = o.now;
    this.onChange = o.onChange ?? (() => undefined);
    this.botsOn = o.bots === true;
    this.botWaitMs = o.botWaitMs ?? BOT_WAIT_MS;
  }

  /** Whether computer opponents are switched on. */
  get botsEnabled(): boolean {
    return this.botsOn;
  }

  // ---- start-up ----------------------------------------------------------------------------------------------------

  /**
   * A match is only played while the server runs without a break. After a restart, a countdown or a live match cannot be
   * continued fairly (nobody could trade while the server was off), so it is cancelled with no winner and no reward.
   * Lobbies simply wait: players who do not come back are removed by the presence check.
   */
  recover(): number {
    const rows = this.db.all<{ id: number }>("SELECT id FROM matches WHERE state IN ('countdown', 'live')");
    for (const r of rows) this.cancel(r.id, 'server_restart');
    if (rows.length > 0) this.log.warn('lobby', `${rows.length} match(es) were interrupted by the restart and were cancelled without a result.`);
    return rows.length;
  }

  // ---- reading -----------------------------------------------------------------------------------------------------

  private match(id: number): MatchRow {
    const m = this.db.get<MatchRow>('SELECT id, state, created_ms, start_tick, end_tick, duration_ticks, start_cash_cents, settled_ms, outcome, winner_user_id, cancel_reason, friends FROM matches WHERE id = ?', id);
    if (!m) throw new LobbyError(404, 'no_such_match', 'No such match.');
    return m;
  }

  private players(matchId: number): PlayerRow[] {
    return this.db.all<PlayerRow>(
      `SELECT p.match_id, p.user_id, u.display_name, p.joined_ms, p.last_seen_ms, p.ready, p.active, p.forfeited, p.account_id, p.final_value_cents, p.profit_cents, p.result, p.reward_cents, p.dismissed,
              EXISTS (SELECT 1 FROM bots b WHERE b.user_id = p.user_id) AS is_bot
         FROM match_players p JOIN users u ON u.id = p.user_id WHERE p.match_id = ? ORDER BY p.joined_ms, p.user_id`,
      matchId,
    );
  }

  private membership(userId: number): { match_id: number } | undefined {
    return this.db.get<{ match_id: number }>('SELECT match_id FROM match_players WHERE user_id = ? AND active = 1', userId);
  }

  private phaseOf(m: MatchRow, count: number, tick: number): Phase {
    switch (m.state) {
      case 'lobby':
        return count < 2 ? 'waiting' : 'ready_check';
      case 'countdown':
        return 'countdown';
      case 'live':
        return tick < (m.end_tick as number) ? 'live' : 'settling';
      case 'finished':
        return 'finished';
      default:
        return 'cancelled';
    }
  }

  private messageFor(m: MatchRow, phase: Phase, ps: PlayerRow[], userId: number, tick: number): string {
    const me = ps.find((p) => p.user_id === userId);
    const other = ps.find((p) => p.user_id !== userId);
    switch (phase) {
      case 'waiting':
        return this.botsOn
          ? `Looking for an opponent… You are in the lobby alone (1/2). If nobody joins in ${Math.round(this.botWaitMs / 1000)} seconds, a bot will play you, or you can play a bot right now. A real player who arrives first always takes the bot's place. You can leave at any time.`
          : 'Looking for an opponent… You are in the lobby alone (1/2). The match cannot start until a real player joins. You can leave at any time.';
      case 'ready_check':
        if (other?.is_bot === 1) return me?.ready ? `You are ready. ${other.display_name} is ready too.` : `${other.display_name} will play you (2/2). Press Ready when you are ready.`;
        if (m.friends === 1) return me?.ready ? `You are ready. Waiting for your friend ${other?.display_name ?? ''} to be ready.` : `Friend match against ${other?.display_name ?? 'your friend'}. Press Ready when you are ready.`;
        if (me?.ready) return `You are ready. Waiting for ${other?.display_name ?? 'your opponent'} to be ready.`;
        return `${other?.display_name ?? 'An opponent'} has joined (2/2). Press Ready when you are ready.`;
      case 'countdown':
        return `Both players are ready. The market opens for trading in ${Math.max(0, (m.start_tick as number) - tick)} seconds.`;
      case 'live':
        return `Trade now! ${Math.max(0, (m.end_tick as number) - tick)} seconds left.`;
      case 'settling':
        return 'Time is up. Working out the result…';
      case 'finished': {
        const mine = me?.result;
        if (m.outcome === 'abandoned') return 'The match was abandoned: both players left. No result.';
        if (mine === 'win') return `You won! Reward: $${((me?.reward_cents ?? 0) / 100).toFixed(2)}.`;
        if (mine === 'tie') return `It is a tie. Reward: $${((me?.reward_cents ?? 0) / 100).toFixed(2)} each.`;
        if (mine === 'forfeit') return 'You left the match, so you lost. No reward.';
        if (m.outcome === 'forfeit') return 'Your opponent left, so you won.';
        return `You lost. Consolation reward: $${((me?.reward_cents ?? 0) / 100).toFixed(2)}.`;
      }
      default:
        return CANCEL_TEXT[m.cancel_reason ?? ''] ?? 'This match was cancelled. Nobody won or lost.';
    }
  }

  private viewOf(m: MatchRow, userId: number): MatchView {
    const ps = this.players(m.id);
    const active = ps.filter((p) => p.active === 1 || m.state === 'finished' || m.state === 'cancelled');
    const tick = this.world.sim.tick;
    const phase = this.phaseOf(m, ps.filter((p) => p.active === 1).length || ps.length, tick);
    const done = m.state === 'finished';
    const startTick = m.start_tick;
    const endTick = m.end_tick;
    return {
      id: m.id,
      phase,
      playerCount: ps.filter((p) => p.active === 1 || m.state === 'finished').length,
      capacity: 2,
      players: active.map((p) => ({
        userId: p.user_id,
        name: p.display_name,
        bot: p.is_bot === 1,
        ready: p.ready === 1,
        you: p.user_id === userId,
        forfeited: p.forfeited === 1,
        finalValueCents: done ? p.final_value_cents : null,
        profitCents: done ? p.profit_cents : null,
        result: done ? p.result : null,
        rewardCents: done && p.is_bot !== 1 ? p.reward_cents : null, // a bot is never paid, so the results show a dash for it
      })),
      message: this.messageFor(m, phase, ps, userId, tick),
      startCashCents: m.start_cash_cents,
      durationTicks: m.duration_ticks,
      startTick,
      endTick,
      startMs: startTick === null ? null : this.world.msOfTick(startTick),
      endMs: endTick === null ? null : this.world.msOfTick(endTick),
      tick,
      ticksToStart: startTick === null ? null : Math.max(0, startTick - tick),
      ticksLeft: endTick === null || phase === 'finished' || phase === 'cancelled' ? null : Math.max(0, endTick - tick),
      outcome: m.outcome,
      winnerUserId: m.winner_user_id,
      cancelReason: m.cancel_reason,
      canTrade: phase === 'live' && ps.find((p) => p.user_id === userId)?.forfeited === 0,
      friendMatch: m.friends === 1,
    };
  }

  /** The player's current match (lobby, countdown, live, or the result they have not closed yet), or null. Counts as "I am here". */
  current(userId: number): MatchView | null {
    this.advance();
    const mem = this.membership(userId);
    if (mem) {
      this.db.run('UPDATE match_players SET last_seen_ms = ? WHERE match_id = ? AND user_id = ?', this.now(), mem.match_id, userId);
      return this.viewOf(this.match(mem.match_id), userId);
    }
    const last = this.db.get<{ match_id: number }>("SELECT match_id FROM match_players WHERE user_id = ? AND active = 0 AND dismissed = 0 AND (result IS NOT NULL OR match_id IN (SELECT id FROM matches WHERE state = 'cancelled')) ORDER BY match_id DESC LIMIT 1", userId);
    return last ? this.viewOf(this.match(last.match_id), userId) : null;
  }

  /**
   * Whether the player can start a friend match right now: he is in no match, or only waits alone in a lobby (which a friend match
   * replaces; leaving a lobby costs nothing). Not free: a lobby with another real player, a countdown, a live match.
   */
  isFree(userId: number): boolean {
    this.advance();
    return this.free(userId);
  }

  private free(userId: number): boolean {
    const mem = this.membership(userId);
    if (!mem) return true;
    const m = this.match(mem.match_id);
    if (m.state !== 'lobby' || m.friends === 1) return false;
    return this.players(m.id).filter((p) => p.active === 1 && p.is_bot === 0).length === 1;
  }

  /**
   * Opens the match of two friends who agreed to play (server/challenges.ts): a lobby with exactly the two of them, nobody ready yet.
   * They press Ready like in any lobby and the usual countdown follows. A player who was waiting alone for an opponent is taken out of that
   * lobby first. Throws LobbyError 'player_busy' when either is in a match that cannot be left like that.
   */
  openFriendMatch(aId: number, bId: number): number {
    this.advance();
    const matchId = this.db.tx(() => {
      for (const u of [aId, bId]) {
        if (!this.free(u)) throw new LobbyError(409, 'player_busy', 'A player is in another match right now.');
      }
      for (const u of [aId, bId]) {
        const mem = this.membership(u);
        if (mem) this.removeFromLobby(this.match(mem.match_id), u);
        this.db.run('UPDATE match_players SET dismissed = 1 WHERE user_id = ? AND active = 0', u);
      }
      const nowMs = this.now();
      const id = this.db.run("INSERT INTO matches(state, created_ms, duration_ticks, start_cash_cents, friends) VALUES ('lobby', ?, ?, ?, 1)", nowMs, MATCH_TICKS, MATCH_CASH_CENTS).lastInsertRowid;
      for (const u of [aId, bId]) this.db.run('INSERT INTO match_players(match_id, user_id, joined_ms, last_seen_ms) VALUES (?, ?, ?, ?)', id, u, nowMs, nowMs);
      return id;
    });
    this.log.info('lobby', `Friend match ${matchId} opened for players ${aId} and ${bId}.`);
    this.notify(matchId);
    return matchId;
  }

  /** How many players are searching for an opponent right now. */
  searching(): number {
    return this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM matches m WHERE m.state = 'lobby' AND (SELECT COUNT(*) FROM match_players p WHERE p.match_id = m.id AND p.active = 1 AND p.user_id NOT IN (SELECT user_id FROM bots)) = 1")?.n ?? 0;
  }

  // ---- actions -----------------------------------------------------------------------------------------------------

  /** Joins an existing waiting lobby or opens a new one. Doing it twice returns the same lobby. */
  join(userId: number): MatchView {
    this.advance();
    const result = this.db.tx(() => {
      const mem = this.membership(userId);
      if (mem) return { matchId: mem.match_id, changed: false };
      // A finished match the player has not closed does not stop them from searching again: it is closed for them.
      this.db.run('UPDATE match_players SET dismissed = 1 WHERE user_id = ? AND active = 0', userId);
      const nowMs = this.now();
      // A lobby with one real player is open, also when a bot is sitting in it: a real player always takes the bot's place.
      const open = this.db.get<{ id: number }>(
        `SELECT m.id FROM matches m
          WHERE m.state = 'lobby' AND m.friends = 0
            AND (SELECT COUNT(*) FROM match_players p WHERE p.match_id = m.id AND p.active = 1 AND p.user_id NOT IN (SELECT user_id FROM bots)) = 1
            AND NOT EXISTS (SELECT 1 FROM match_players p WHERE p.match_id = m.id AND p.user_id = ?)
          ORDER BY m.id LIMIT 1`,
        userId,
      );
      let matchId: number;
      if (open) {
        matchId = open.id;
        this.db.run('DELETE FROM match_players WHERE match_id = ? AND active = 1 AND user_id IN (SELECT user_id FROM bots)', matchId);
        // A second player arrives: nobody is ready yet.
        this.db.run('UPDATE match_players SET ready = 0 WHERE match_id = ?', matchId);
      } else {
        matchId = this.db.run("INSERT INTO matches(state, created_ms, duration_ticks, start_cash_cents) VALUES ('lobby', ?, ?, ?)", nowMs, MATCH_TICKS, MATCH_CASH_CENTS).lastInsertRowid;
      }
      this.db.run('INSERT INTO match_players(match_id, user_id, joined_ms, last_seen_ms) VALUES (?, ?, ?, ?)', matchId, userId, nowMs, nowMs);
      return { matchId, changed: true };
    });
    if (result.changed) this.notify(result.matchId);
    return this.viewOf(this.match(result.matchId), userId);
  }

  /** Marks the player ready (or not ready). When both are ready the countdown starts. */
  setReady(userId: number, ready: boolean): MatchView {
    this.advance();
    const matchId = this.db.tx(() => {
      const mem = this.membership(userId);
      if (!mem) throw new LobbyError(409, 'not_in_lobby', 'You are not in a lobby. Join one first.');
      const m = this.match(mem.match_id);
      if (m.state !== 'lobby' && m.state !== 'countdown') throw new LobbyError(409, 'too_late', 'The match has already started, so you cannot change your ready state.');
      const ps = this.players(m.id).filter((p) => p.active === 1);
      if (ps.length < 2) throw new LobbyError(409, 'no_opponent', 'You need an opponent before you can be ready. Nobody has joined yet.');
      this.db.run('UPDATE match_players SET ready = ?, last_seen_ms = ? WHERE match_id = ? AND user_id = ?', ready ? 1 : 0, this.now(), m.id, userId);
      if (ready) {
        const everyone = this.players(m.id).filter((p) => p.active === 1).every((p) => p.ready === 1);
        if (everyone && m.state === 'lobby') {
          const start = matchStartTick(this.world.currentTick());
          this.db.run("UPDATE matches SET state = 'countdown', start_tick = ?, end_tick = ? WHERE id = ?", start, start + m.duration_ticks, m.id);
        }
      } else if (m.state === 'countdown') {
        // Somebody changed their mind during the countdown: back to the lobby.
        this.db.run("UPDATE matches SET state = 'lobby', start_tick = NULL, end_tick = NULL WHERE id = ?", m.id);
      }
      return m.id;
    });
    this.notify(matchId);
    return this.viewOf(this.match(matchId), userId);
  }

  /**
   * Leaves the lobby (no consequence) or forfeits a live match (a loss, no reward). After a result, it just closes the
   * results screen. Returns what the player should see next (normally nothing).
   */
  leave(userId: number): MatchView | null {
    this.advance();
    const matchId = this.db.tx((): number | null => {
      const mem = this.membership(userId);
      if (!mem) {
        this.db.run('UPDATE match_players SET dismissed = 1 WHERE user_id = ? AND active = 0', userId);
        return null;
      }
      const m = this.match(mem.match_id);
      if (m.state === 'live') {
        this.db.run('UPDATE match_players SET forfeited = 1 WHERE match_id = ? AND user_id = ?', m.id, userId);
        this.log.info('lobby', `Player ${userId} forfeited match ${m.id}.`);
        return m.id;
      }
      this.removeFromLobby(m, userId);
      return m.id;
    });
    let endedNow = false;
    if (matchId !== null) {
      // Against a bot there is nobody to wait for: the match ends now (the bot wins, nobody is paid), so the player is free at once.
      if (this.db.get("SELECT 1 AS x FROM matches WHERE id = ? AND state = 'live'", matchId) && this.db.get('SELECT 1 AS x FROM match_players p JOIN bots b ON b.user_id = p.user_id WHERE p.match_id = ? AND p.active = 1', matchId)) {
        try {
          endedNow = this.settle(matchId, true);
        } catch (error) {
          this.log.warn('lobby', `Match ${matchId}: the forfeit could not be settled at once (${error instanceof Error ? error.message : String(error)}); it will be settled when the time is up.`);
        }
      }
      this.notify(matchId, userId);
    }
    // After an early end the finished match is returned, so the player sees the result screen; leaving a lobby returns nothing.
    return matchId !== null && (endedNow || this.membership(userId)) ? this.current(userId) : null;
  }

  /** Closes the results screen of a finished or cancelled match. */
  dismiss(userId: number): void {
    this.db.run('UPDATE match_players SET dismissed = 1 WHERE user_id = ? AND active = 0', userId);
  }

  private removeFromLobby(m: MatchRow, userId: number): void {
    this.db.run('DELETE FROM match_players WHERE match_id = ? AND user_id = ? AND active = 1', m.id, userId);
    if (m.friends === 1) {
      // A friend match is only for the two friends. When one goes, the other does not wait for a stranger: the match is cancelled for him.
      this.db.run("UPDATE matches SET state = 'cancelled', cancel_reason = 'friend_left', start_tick = NULL, end_tick = NULL WHERE id = ?", m.id);
      this.db.run('UPDATE match_players SET active = 0, ready = 0 WHERE match_id = ?', m.id);
      return;
    }
    // A bot does not wait for anybody: when the last real player has gone, the bot goes too.
    if (this.players(m.id).filter((p) => p.active === 1 && p.is_bot === 0).length === 0) this.db.run('DELETE FROM match_players WHERE match_id = ? AND active = 1', m.id);
    const left = this.players(m.id).filter((p) => p.active === 1);
    if (left.length === 0) {
      this.db.run("UPDATE matches SET state = 'cancelled', cancel_reason = 'everyone_left' WHERE id = ?", m.id);
    } else {
      // The other player goes back to waiting: not ready, no countdown.
      this.db.run('UPDATE match_players SET ready = 0 WHERE match_id = ?', m.id);
      this.db.run("UPDATE matches SET state = 'lobby', start_tick = NULL, end_tick = NULL WHERE id = ?", m.id);
    }
  }

  private cancel(matchId: number, reason: string): void {
    const userIds = this.db.tx(() => {
      const ps = this.players(matchId);
      this.db.run("UPDATE matches SET state = 'cancelled', cancel_reason = ? WHERE id = ?", reason, matchId);
      this.db.run('UPDATE match_players SET active = 0, ready = 0 WHERE match_id = ?', matchId);
      return ps.map((p) => p.user_id);
    });
    for (const u of userIds) this.onChange(u, this.currentQuiet(u));
  }

  private currentQuiet(userId: number): MatchView | null {
    const last = this.db.get<{ match_id: number }>('SELECT match_id FROM match_players WHERE user_id = ? AND dismissed = 0 ORDER BY match_id DESC LIMIT 1', userId);
    return last ? this.viewOf(this.match(last.match_id), userId) : null;
  }

  private notify(matchId: number, extraUser?: number): void {
    const ids = new Set(this.players(matchId).map((p) => p.user_id));
    if (extraUser !== undefined) ids.add(extraUser);
    for (const u of ids) this.onChange(u, this.currentQuiet(u));
  }

  // ---- time --------------------------------------------------------------------------------------------------------

  /** Moves matches forward in time: removes players who left the lobby unnoticed, starts matches, settles finished ones. */
  advance(): void {
    // A match whose countdown has run out starts even if a player's last sign of life was a moment too long ago;
    // only lobbies and countdowns that are still waiting are checked for people who have gone.
    this.startDue();
    this.sweepPresence();
    this.autoBots();
    this.settleDue(this.world.savedTick);
  }

  /** A real player who has waited alone for a while gets a bot as an opponent. */
  private autoBots(): void {
    if (!this.botsOn) return;
    const cutoff = this.now() - this.botWaitMs;
    const waiting = this.db.all<{ id: number }>(
      `SELECT m.id FROM matches m
        WHERE m.state = 'lobby'
          AND (SELECT COUNT(*) FROM match_players p WHERE p.match_id = m.id AND p.active = 1) = 1
          AND (SELECT COUNT(*) FROM match_players p WHERE p.match_id = m.id AND p.active = 1 AND p.joined_ms <= ? AND p.user_id NOT IN (SELECT user_id FROM bots)) = 1`,
      cutoff,
    );
    for (const w of waiting) this.addBot(w.id);
  }

  /** Puts a bot into a lobby that holds one real player. Returns false when there is nothing to do or every bot is busy. */
  private addBot(matchId: number): boolean {
    const added = this.db.tx(() => {
      const m = this.match(matchId);
      if (m.state !== 'lobby') return false;
      const ps = this.players(matchId).filter((p) => p.active === 1);
      if (ps.length !== 1 || (ps[0] as PlayerRow).is_bot === 1) return false;
      const nowMs = this.now();
      const bot = freeBot(this.db, matchId, nowMs);
      if (bot === null) return false;
      // A bot is ready as soon as it joins; the real player presses Ready when he wants to start.
      this.db.run('INSERT INTO match_players(match_id, user_id, joined_ms, last_seen_ms, ready) VALUES (?, ?, ?, ?, 1)', matchId, bot, nowMs, nowMs);
      return true;
    });
    if (added) {
      this.log.info('lobby', `A bot joined lobby ${matchId}.`);
      this.notify(matchId);
    }
    return added;
  }

  /** "Play a bot now": the player is put in a lobby (as with Find a match) and, if he is alone in it, a bot joins at once. */
  playBot(userId: number): MatchView {
    if (!this.botsOn) throw new LobbyError(409, 'no_bots', 'Bots are switched off on this server.');
    this.join(userId);
    const mem = this.membership(userId) as { match_id: number };
    const m = this.match(mem.match_id);
    const ps = this.players(m.id).filter((p) => p.active === 1);
    if (m.state === 'lobby' && ps.length === 1 && !this.addBot(m.id)) {
      throw new LobbyError(409, 'no_bot_free', 'All the bots are busy in other matches right now. Stay in the lobby: one joins as soon as it is free, or a real player may come.');
    }
    return this.viewOf(this.match(m.id), userId);
  }

  private sweepPresence(): void {
    const cutoff = this.now() - PRESENCE_MS;
    const stale = this.db.all<{ match_id: number; user_id: number }>(
      "SELECT p.match_id, p.user_id FROM match_players p JOIN matches m ON m.id = p.match_id WHERE p.active = 1 AND m.state IN ('lobby', 'countdown') AND p.last_seen_ms < ? AND p.user_id NOT IN (SELECT user_id FROM bots)",
      cutoff,
    );
    for (const s of stale) {
      this.db.tx(() => {
        const m = this.match(s.match_id);
        if (m.state !== 'lobby' && m.state !== 'countdown') return;
        this.log.info('lobby', `Player ${s.user_id} disconnected from lobby ${m.id} and was removed.`);
        this.removeFromLobby(m, s.user_id);
      });
      this.notify(s.match_id, s.user_id);
    }
  }

  private startDue(): void {
    const tick = this.world.sim.tick;
    const due = this.db.all<{ id: number }>("SELECT id FROM matches WHERE state = 'countdown' AND start_tick <= ?", tick);
    for (const d of due) {
      let started = false;
      this.db.tx(() => {
        const m = this.match(d.id);
        if (m.state !== 'countdown') return;
        if (this.world.currentTick() >= (m.end_tick as number)) {
          this.db.run("UPDATE matches SET state = 'cancelled', cancel_reason = 'start_missed' WHERE id = ?", m.id);
          this.db.run('UPDATE match_players SET active = 0 WHERE match_id = ?', m.id);
          return;
        }
        for (const p of this.players(m.id).filter((x) => x.active === 1)) {
          // Match cash is fixed. Nothing about the player's Career account can change it.
          const account = this.trading.createMatchAccount(p.user_id, m.id, m.start_cash_cents);
          this.db.run('UPDATE match_players SET account_id = ? WHERE match_id = ? AND user_id = ?', account.id, m.id, p.user_id);
        }
        this.db.run("UPDATE matches SET state = 'live' WHERE id = ?", m.id);
        started = true;
      });
      this.notify(d.id);
      if (started) this.log.info('lobby', `Match ${d.id} is live.`);
    }
  }

  /** Settles every live match whose last tick is already stored. Safe to call as often as you like. */
  settleDue(savedTick: number): void {
    const due = this.db.all<{ id: number }>("SELECT id FROM matches WHERE state = 'live' AND end_tick <= ?", savedTick);
    for (const d of due) {
      try {
        this.settle(d.id);
      } catch (error) {
        if (this.now() - this.lastSettleError > 10_000) {
          this.lastSettleError = this.now();
          this.log.error('lobby', `Could not settle match ${d.id}: ${error instanceof Error ? error.message : String(error)}. It will be tried again.`);
        }
      }
    }
  }

  /** Scores a finished match and pays the rewards. Happens once: a second call finds the match already finished. */
  settle(matchId: number, early = false): boolean {
    const done = this.db.tx(() => {
      const m = this.match(matchId);
      if (m.state !== 'live') return false;
      const end = m.end_tick as number;
      const ps = this.players(m.id).filter((p) => p.active === 1);
      if (ps.length !== 2) throw new Error(`Match ${m.id} has ${ps.length} players`);
      // At the end of the match the final price is the stored candle that closes at tick E. A forfeit against a bot ends the match early, before
      // that candle exists: then the last finished candle is used for the figures (nobody's result depends on them: the forfeit decides).
      const candle = early ? Math.floor(this.world.savedTick / TICKS_PER_CANDLE) - 1 : Math.floor(end / TICKS_PER_CANDLE);
      const competitors = ps.map((p) => {
        const acc = this.db.get<{ cash_cents: number }>('SELECT cash_cents FROM accounts WHERE id = ?', p.account_id as number);
        if (!acc) throw new Error(`Match ${m.id}: player ${p.user_id} has no account`);
        let value = acc.cash_cents;
        const held = this.db.all<{ company_id: number; shares: number; cost_cents: number; debt_cents: number; short: number; credit_cents: number }>('SELECT company_id, shares, cost_cents, debt_cents, short, credit_cents FROM positions WHERE account_id = ?', p.account_id as number);
        for (const h of held) {
          const c = this.db.get<{ close: number }>('SELECT close FROM candles_c10 WHERE company_id = ? AND idx = ?', h.company_id, candle);
          if (!c) throw new Error(`the final price of company ${h.company_id} (candle ${candle}) is not stored yet`);
          // A position bought with leverage is worth what is left after its debt is repaid, a short one what is left of its collateral after
          // buying the shares back at the final price (never below nothing).
          value += equityOf({ shares: h.shares, costCents: h.cost_cents, debtCents: h.debt_cents, short: h.short === 1, creditCents: h.credit_cents }, c.close);
        }
        return { userId: p.user_id, finalValueCents: value, forfeited: p.forfeited === 1 };
      });
      const verdict = decideMatch(competitors[0] as (typeof competitors)[number], competitors[1] as (typeof competitors)[number], m.start_cash_cents);
      const nowMs = this.now();
      for (const v of verdict.players) {
        const c = competitors.find((x) => x.userId === v.userId) as (typeof competitors)[number];
        this.db.run(
          'UPDATE match_players SET active = 0, final_value_cents = ?, profit_cents = ?, result = ?, reward_cents = ? WHERE match_id = ? AND user_id = ?',
          c.finalValueCents, v.profitCents, v.result, v.rewardCents, m.id, v.userId,
        );
        if (v.rewardCents > 0 && (ps.find((p) => p.user_id === v.userId) as PlayerRow).is_bot === 0) {
          const paid = this.db.run('INSERT OR IGNORE INTO wallet_ledger(user_id, delta_cents, reason, match_id, created_ms) VALUES (?, ?, ?, ?, ?)', v.userId, v.rewardCents, 'match_reward', m.id, nowMs);
          if (paid.changes === 1) {
            this.db.run(
              'INSERT INTO wallets(user_id, balance_cents, updated_ms) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET balance_cents = balance_cents + excluded.balance_cents, updated_ms = excluded.updated_ms',
              v.userId, v.rewardCents, nowMs,
            );
          }
        }
      }
      this.db.run("UPDATE matches SET state = 'finished', outcome = ?, winner_user_id = ?, settled_ms = ? WHERE id = ?", verdict.outcome, verdict.winnerUserId, nowMs, m.id);
      return true;
    });
    if (done) {
      this.notify(matchId);
      this.log.info('lobby', `Match ${matchId} finished.`);
    }
    return done;
  }

  // ---- trading rules -----------------------------------------------------------------------------------------------

  /** The rule for orders: a match account may trade only while its own match is live, and never after it. */
  gate = (account: AccountRow, tick: number): string | null => {
    if (account.kind !== 'match') return null;
    const m = this.db.get<MatchRow>('SELECT id, state, created_ms, start_tick, end_tick, duration_ticks, start_cash_cents, settled_ms, outcome, winner_user_id, cancel_reason, friends FROM matches WHERE id = ?', account.match_id as number);
    if (!m || m.state !== 'live') return 'This match is over, so you can no longer trade in it.';
    const start = m.start_tick as number;
    const end = m.end_tick as number;
    if (tick < start) return 'The match has not started yet.';
    if (tick >= end || this.world.currentTick() >= end) return 'Time is up. The match is over.';
    if (this.world.currentTick() - tick > 3) return 'The market is catching up for a moment. Try again in a second.';
    const me = this.db.get<{ forfeited: number }>('SELECT forfeited FROM match_players WHERE match_id = ? AND account_id = ?', m.id, account.id);
    if (me?.forfeited === 1) return 'You left this match, so you cannot trade in it.';
    return null;
  };

  /** Companies players launched cannot be traded in a match: whoever launched one could push its price with his Career money and win with it. */
  companyRule = (account: AccountRow, companyId: number): string | null => {
    if (account.kind !== 'match') return null;
    if (!this.db.get('SELECT 1 AS x FROM launches WHERE company_id = ?', companyId)) return null;
    return LAUNCHED_IN_MATCH;
  };

  /** True while the player has a match that is about to start (countdown) or is running and has not forfeited it (a player who forfeited cannot trade in it any more). */
  inMatch(userId: number): boolean {
    return this.db.get("SELECT 1 AS x FROM match_players p JOIN matches m ON m.id = p.match_id WHERE p.user_id = ? AND p.active = 1 AND p.forfeited = 0 AND m.state IN ('countdown', 'live')", userId) !== undefined;
  }

  /** The account a player trades in the match: the live one, or the last one (to look at the result). */
  accountFor(userId: number): AccountRow | null {
    this.advance();
    const row = this.db.get<{ account_id: number }>('SELECT account_id FROM match_players WHERE user_id = ? AND account_id IS NOT NULL ORDER BY match_id DESC LIMIT 1', userId);
    return row ? (this.trading.account(row.account_id) ?? null) : null;
  }

  // ---- history and wallet ------------------------------------------------------------------------------------------

  history(userId: number, limit = 20, beforeMatchId?: number): HistoryEntry[] {
    const rows = this.db.all<{ match_id: number }>(
      `SELECT p.match_id FROM match_players p JOIN matches m ON m.id = p.match_id
        WHERE p.user_id = ? AND m.state IN ('finished', 'cancelled') ${beforeMatchId === undefined ? '' : 'AND p.match_id < ?'} ORDER BY p.match_id DESC LIMIT ?`,
      ...(beforeMatchId === undefined ? [userId, limit] : [userId, beforeMatchId, limit]),
    );
    return rows.map((r) => {
      const m = this.match(r.match_id);
      const ps = this.players(r.match_id);
      const me = ps.find((p) => p.user_id === userId) as PlayerRow;
      const other = ps.find((p) => p.user_id !== userId);
      return {
        matchId: m.id,
        state: m.state as 'finished' | 'cancelled',
        outcome: m.outcome,
        endedMs: m.settled_ms,
        startTick: m.start_tick,
        you: { profitCents: me.profit_cents, finalValueCents: me.final_value_cents, result: me.result, rewardCents: me.reward_cents },
        opponent: other ? { name: other.display_name, bot: other.is_bot === 1, profitCents: other.profit_cents, finalValueCents: other.final_value_cents } : null,
        cancelReason: m.cancel_reason,
      };
    });
  }

  wallet(userId: number): WalletView {
    const w = this.db.get<{ balance_cents: number }>('SELECT balance_cents FROM wallets WHERE user_id = ?', userId);
    const recent = this.db.all<{ id: number; delta_cents: number; reason: string; match_id: number | null; created_ms: number }>('SELECT id, delta_cents, reason, match_id, created_ms FROM wallet_ledger WHERE user_id = ? ORDER BY id DESC LIMIT 20', userId);
    return { balanceCents: w?.balance_cents ?? 0, recent: recent.map((r) => ({ id: r.id, deltaCents: r.delta_cents, reason: r.reason, matchId: r.match_id, createdMs: r.created_ms })) };
  }

  /** For health checks. */
  stats(): { lobbies: number; searching: number; countdown: number; live: number; finished: number; cancelled: number } {
    const count = (state: string): number => this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM matches WHERE state = ?', state)?.n ?? 0;
    return { lobbies: count('lobby'), searching: this.searching(), countdown: count('countdown'), live: count('live'), finished: count('finished'), cancelled: count('cancelled') };
  }
}

export { COUNTDOWN_TICKS, LOSER_REWARD_CENTS };
