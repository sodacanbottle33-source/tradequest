// Friend 1v1 challenges (docs/world.md §14). A player asks a friend to play a 1v1; if the friend says yes, the two of them get a lobby of
// their own (a "friend match", MatchService.openFriendMatch) and press Ready like in any lobby. Nobody else can join that lobby, so friends
// do not have to hope the random matchmaking puts them together.
//
// The rules, all decided here:
//   • only friends can challenge each other, and only a player who has a page open can be challenged (a challenge nobody can see is pointless);
//   • a challenge runs out after CHALLENGE_MS; accepting it later is impossible;
//   • one challenge at a time per player (you cannot flood your friends, and you always know who you are waiting for);
//   • if the friend has already challenged you, challenging him back is the same as accepting;
//   • neither player may be in a match that has a real opponent, a countdown or a running match; a player who only waits alone in the
//     random lobby is taken out of it (leaving a lobby costs nothing);
//   • the match pays the usual rewards. The wallet is only a score, nothing can be bought with it.

import type { User } from './auth';
import type { Logger } from './log';
import { LobbyError, type MatchService, type MatchView } from './lobby/service';
import { cleanName } from './social';
import type { Db } from './sqlite';

/** How long a challenge can be accepted, in milliseconds. */
export const CHALLENGE_MS = 120_000;
/** The most challenges that can wait for one player at the same time. */
export const MAX_WAITING_FOR_ONE = 10;
/** The most challenges one player can send in a minute (a taken-back challenge counts too). */
export const SENDS_PER_MINUTE = 10;

export class ChallengeError extends Error {
  constructor(
    readonly code: 'no_such_player' | 'bad_request' | 'not_friends' | 'no_challenge' | 'already_challenging' | 'busy' | 'offline' | 'player_busy' | 'rate_limited',
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** One open challenge as the player sees it: who the other player is and how long it still can be accepted. */
export interface ChallengeEntry {
  readonly username: string;
  readonly displayName: string;
  readonly sinceMs: number;
  readonly msLeft: number;
}

export interface ChallengesState {
  /** Challenges other players sent to you, newest first. */
  readonly incoming: readonly ChallengeEntry[];
  /** The challenge you sent that nobody has answered yet (at most one). */
  readonly outgoing: readonly ChallengeEntry[];
  readonly limits: { readonly validMs: number };
}

export interface ChallengeDeps {
  readonly db: Db;
  readonly matches: MatchService;
  readonly log: Logger;
  readonly now: () => number;
  /** Whether the player has a page open (a live stream) right now. */
  readonly isOnline: (userId: number) => boolean;
  /** Whether the owner has banned the player right now. */
  readonly isBanned: (userId: number) => boolean;
  /** Tells a player over his live stream that his challenges changed. */
  readonly notify?: (userId: number) => void;
}

interface Target {
  readonly id: number;
  readonly username: string;
  readonly displayName: string;
}

const pair = (a: number, b: number): [number, number] => (a < b ? [a, b] : [b, a]);

export class Challenges {
  private readonly sends = new Map<number, number[]>();

  constructor(private readonly d: ChallengeDeps) {}

  // ---- reading -----------------------------------------------------------------------------------------------------

  /** Removes challenges that ran out and challenges between two players who are no longer friends. */
  private purge(): void {
    this.d.db.run(
      `DELETE FROM challenges
        WHERE expires_ms <= ?
           OR NOT EXISTS (SELECT 1 FROM friendships f WHERE f.user_a = MIN(challenges.from_id, challenges.to_id) AND f.user_b = MAX(challenges.from_id, challenges.to_id) AND f.status = 'accepted')`,
      this.d.now(),
    );
  }

  state(me: User): ChallengesState {
    this.purge();
    const now = this.d.now();
    const rows = this.d.db.all<{ from_id: number; to_id: number; created_ms: number; expires_ms: number; other_id: number; username: string; display_name: string }>(
      `SELECT c.from_id, c.to_id, c.created_ms, c.expires_ms, u.id AS other_id, u.username, u.display_name
         FROM challenges c JOIN users u ON u.id = CASE WHEN c.from_id = ? THEN c.to_id ELSE c.from_id END
        WHERE c.from_id = ? OR c.to_id = ? ORDER BY c.created_ms DESC, c.from_id`,
      me.id,
      me.id,
      me.id,
    );
    const entry = (r: (typeof rows)[number]): ChallengeEntry => ({ username: r.username, displayName: r.display_name, sinceMs: r.created_ms, msLeft: Math.max(0, r.expires_ms - now) });
    const visible = rows.filter((r) => !this.d.isBanned(r.other_id));
    return {
      incoming: visible.filter((r) => r.to_id === me.id).map(entry),
      outgoing: visible.filter((r) => r.from_id === me.id).map(entry),
      limits: { validMs: CHALLENGE_MS },
    };
  }

  // ---- finding people ----------------------------------------------------------------------------------------------

  /** A real player (no computer player) who is not banned. */
  private find(username: string): Target {
    const name = cleanName(username);
    const row = name === '' || name.length > 40 ? undefined : this.d.db.get<{ id: number; username: string; display_name: string }>('SELECT id, username, display_name FROM users WHERE username = ?', name);
    if (!row || this.d.db.get('SELECT 1 AS x FROM bots WHERE user_id = ?', row.id) || this.d.isBanned(row.id)) {
      throw new ChallengeError('no_such_player', name === '' ? 'Type the name of a friend.' : `There is no player called "${name}".`, 404);
    }
    return { id: row.id, username: row.username, displayName: row.display_name };
  }

  /** The id of any user with this name, banned or not (to clean up an old challenge). */
  private findId(username: string): number {
    const name = cleanName(username);
    const row = name === '' || name.length > 40 ? undefined : this.d.db.get<{ id: number }>('SELECT id FROM users WHERE username = ?', name);
    if (!row) throw new ChallengeError('no_such_player', `There is no player called "${name}".`, 404);
    return row.id;
  }

  private areFriends(a: number, b: number): boolean {
    const [x, y] = pair(a, b);
    return this.d.db.get("SELECT 1 AS x FROM friendships WHERE user_a = ? AND user_b = ? AND status = 'accepted'", x, y) !== undefined;
  }

  private has(fromId: number, toId: number): boolean {
    return this.d.db.get('SELECT 1 AS x FROM challenges WHERE from_id = ? AND to_id = ?', fromId, toId) !== undefined;
  }

  private count(column: 'from_id' | 'to_id', userId: number): number {
    return this.d.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM challenges WHERE ${column} = ?`, userId)?.n ?? 0;
  }

  private limitSends(userId: number): void {
    const now = this.d.now();
    const list = (this.sends.get(userId) ?? []).filter((t) => t > now - 60_000);
    if (list.length >= SENDS_PER_MINUTE) throw new ChallengeError('rate_limited', 'You are sending challenges too quickly. Wait a moment.', 429);
    list.push(now);
    this.sends.set(userId, list);
  }

  // ---- changing ----------------------------------------------------------------------------------------------------

  /**
   * Challenges a friend. If that friend has already challenged you, this accepts his challenge instead (then `match` is the new lobby).
   * Asking again while your challenge is still waiting changes nothing.
   */
  send(me: User, username: string): { state: ChallengesState; match: MatchView | null } {
    const target = this.find(username);
    if (target.id === me.id) throw new ChallengeError('bad_request', 'That is you.', 400);
    this.limitSends(me.id);
    const outcome = this.d.db.tx((): 'new' | 'waiting' | 'accept' => {
      this.purge();
      if (!this.areFriends(me.id, target.id)) throw new ChallengeError('not_friends', `${target.displayName} is not your friend yet. Send a friend request first.`, 403);
      if (this.has(target.id, me.id)) return 'accept'; // he asked first: asking him back is the same as saying yes
      if (this.has(me.id, target.id)) return 'waiting';
      if (this.count('from_id', me.id) >= 1) throw new ChallengeError('already_challenging', 'You already challenged another friend. Wait for the answer or cancel that challenge first.', 409);
      if (!this.d.matches.isFree(me.id)) throw new ChallengeError('busy', 'You are in a 1v1 lobby or match right now. Finish or leave it first.', 409);
      if (this.count('to_id', target.id) >= MAX_WAITING_FOR_ONE) throw new ChallengeError('player_busy', `${target.displayName} has too many challenges waiting. Try again later.`, 409);
      if (!this.d.isOnline(target.id)) throw new ChallengeError('offline', `${target.displayName} is not online right now, so there is nobody to answer. Try again when your friend is on TradeQuest.`, 409);
      const nowMs = this.d.now();
      this.d.db.run('INSERT INTO challenges(from_id, to_id, created_ms, expires_ms) VALUES (?, ?, ?, ?)', me.id, target.id, nowMs, nowMs + CHALLENGE_MS);
      return 'new';
    });
    if (outcome === 'accept') return this.accept(me, target.username);
    if (outcome === 'new') this.d.notify?.(target.id);
    return { state: this.state(me), match: null };
  }

  /** Says yes to a challenge. Opens the friend match for both players. */
  accept(me: User, username: string): { state: ChallengesState; match: MatchView | null } {
    const target = this.find(username);
    const dropped: number[] = [];
    this.d.db.tx(() => {
      this.purge();
      if (!this.has(target.id, me.id)) throw new ChallengeError('no_challenge', `${target.displayName} has no challenge waiting for you. It may have run out (${Math.round(CHALLENGE_MS / 1000)} seconds) or been taken back.`, 404);
      if (!this.d.isOnline(target.id)) throw new ChallengeError('offline', `${target.displayName} is not online any more, so the match cannot start. Try again when your friend is back.`, 409);
      if (!this.d.matches.isFree(me.id)) throw new ChallengeError('busy', 'You are in a 1v1 lobby or match right now. Finish or leave it first, then accept.', 409);
      if (!this.d.matches.isFree(target.id)) throw new ChallengeError('busy', `${target.displayName} is in another match right now. Try again in a moment.`, 409);
      // Both are about to play: the challenges either of them still had out are moot (the other players are told below).
      for (const r of this.d.db.all<{ to_id: number }>('SELECT to_id FROM challenges WHERE from_id IN (?, ?)', me.id, target.id)) dropped.push(r.to_id);
      this.d.db.run('DELETE FROM challenges WHERE from_id IN (?, ?)', me.id, target.id);
      try {
        this.d.matches.openFriendMatch(me.id, target.id);
      } catch (error) {
        if (error instanceof LobbyError && error.code === 'player_busy') throw new ChallengeError('busy', 'One of you is in another match right now. Try again in a moment.', 409);
        throw error;
      }
    });
    for (const id of new Set([target.id, me.id, ...dropped])) this.d.notify?.(id);
    this.d.log.info('lobby', `Player ${me.id} accepted a challenge from player ${target.id}.`);
    return { state: this.state(me), match: this.d.matches.current(me.id) };
  }

  /** Says no to a challenge. The challenger just sees it disappear from his list. */
  decline(me: User, username: string): ChallengesState {
    const otherId = this.findId(username);
    this.purge();
    const done = this.d.db.run('DELETE FROM challenges WHERE from_id = ? AND to_id = ?', otherId, me.id).changes;
    if (done === 0) throw new ChallengeError('no_challenge', 'There is no challenge from that player.', 404);
    this.d.notify?.(otherId);
    return this.state(me);
  }

  /** Takes back the challenge you sent. */
  cancel(me: User, username: string): ChallengesState {
    const otherId = this.findId(username);
    this.purge();
    const done = this.d.db.run('DELETE FROM challenges WHERE from_id = ? AND to_id = ?', me.id, otherId).changes;
    if (done === 0) throw new ChallengeError('no_challenge', 'You have no challenge waiting for that player.', 404);
    this.d.notify?.(otherId);
    return this.state(me);
  }
}
