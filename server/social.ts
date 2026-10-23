// Friends, the player list and the richest-players leaderboard (docs/world.md §13).
//
// What other players can see of you: your name and your Career net worth. Never your cash, your holdings, your trades or your orders.
// Friends are only a list: nothing is ever sent from one player to another (no cash, no shares). Everybody trades in the one shared market,
// so what players do already moves the same prices for all of them.
//
// The leaderboard ranks Career net worth, the same number "My account" shows. It leaves out:
//   • the owner (who has far more money than a player can have, and is not playing for a place),
//   • the computer players (the eight bots of the 1v1 lobby, which also trade in Career),
//   • players the owner has banned.
// It is worked out for everybody at once and kept for BOARD_CACHE_MS, so a busy page costs the server one pass over the players every
// half minute, not one per request. A new player or a new ban shows up at once (the cache notices that the player list changed).

import type { User } from './auth';
import type { Db } from './sqlite';
import type { Trading } from './trading';

/** How many players the leaderboard shows. */
export const BOARD_SIZE = 100;
/** How long the worked-out ranking is reused, in milliseconds. */
export const BOARD_CACHE_MS = 30_000;
/** The most friends one player can have, the most requests he can have sent and waiting, and the most that can wait for one player. */
export const MAX_FRIENDS = 100;
export const MAX_OUTGOING = 30;
export const MAX_INCOMING = 100;
/** How many players one page of the player list holds (at most). */
export const PLAYERS_PAGE = 50;
export const PLAYERS_PAGE_MAX = 100;

export type Relation = 'you' | 'friend' | 'outgoing' | 'incoming' | 'none';

export class SocialError extends Error {
  constructor(
    readonly code: 'no_such_player' | 'no_request' | 'not_friends' | 'bad_request' | 'too_many_friends' | 'too_many_requests' | 'player_busy',
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** One line of the player list. `netWorthCents` and `rank` are null for the owner (he is not ranked). */
export interface PlayerEntry {
  readonly username: string;
  readonly displayName: string;
  readonly role: 'player' | 'owner';
  readonly netWorthCents: number | null;
  readonly rank: number | null;
  readonly relation: Relation;
}

export interface PlayerPage {
  readonly players: readonly PlayerEntry[];
  /** How many players match the search (the page is a part of them). */
  readonly total: number;
  readonly offset: number;
  readonly updatedMs: number;
}

export interface BoardEntry {
  readonly rank: number;
  readonly username: string;
  readonly displayName: string;
  readonly netWorthCents: number;
  readonly relation: Relation;
}

export interface Leaderboard {
  readonly scope: 'all' | 'friends';
  /** The best players, richest first (at most BOARD_SIZE). */
  readonly rows: readonly BoardEntry[];
  /** How many players are ranked in this view (everyone, or you and your friends). */
  readonly total: number;
  readonly size: number;
  /** Where the player stands in this view, also when he is not in the top. Null when he is not ranked (the owner). */
  readonly me: { readonly rank: number; readonly netWorthCents: number; readonly inTop: boolean } | null;
  readonly updatedMs: number;
}

export interface FriendEntry {
  readonly username: string;
  readonly displayName: string;
  readonly role: 'player' | 'owner';
  readonly netWorthCents: number | null;
  readonly rank: number | null;
  /** When the request was sent (waiting) or accepted (friend). */
  readonly sinceMs: number;
}

export interface FriendsState {
  readonly friends: readonly FriendEntry[];
  /** Requests other players sent to you, newest first. */
  readonly incoming: readonly FriendEntry[];
  /** Requests you sent that nobody has answered yet, newest first. */
  readonly outgoing: readonly FriendEntry[];
  readonly limits: { readonly maxFriends: number; readonly maxOutgoing: number };
}

interface Person {
  readonly id: number;
  readonly username: string;
  readonly displayName: string;
  readonly owner: boolean;
  readonly createdMs: number;
  /** Null for the owner. */
  readonly netWorthCents: number | null;
  /** Place among the ranked players (1 = richest); null for the owner. */
  rank: number | null;
}

interface Ranking {
  readonly atMs: number;
  readonly signature: string;
  /** Everybody who can be seen: the ranked players richest first, then the owner. */
  readonly people: readonly Person[];
  /** Only the ranked players, richest first. */
  readonly ranked: readonly Person[];
  readonly byId: ReadonlyMap<number, Person>;
}

interface Link {
  readonly other: number;
  readonly status: 'pending' | 'accepted';
  readonly requester: number;
  readonly createdMs: number;
  readonly acceptedMs: number | null;
}

export interface SocialDeps {
  readonly db: Db;
  readonly trading: Trading;
  readonly now: () => number;
  /** Told when something changed for a player that his page should show at once (a request arrived, was accepted, a friend left). */
  readonly notify?: (userId: number) => void;
}

function pair(a: number, b: number): [number, number] {
  return a < b ? [a, b] : [b, a];
}

/** A typed name: spaces and a leading @ do not count. */
export function cleanName(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().replace(/^@+/, '') : '';
}

export class Social {
  private ranking: Ranking | null = null;

  constructor(private readonly d: SocialDeps) {}

  // ---- the ranking -------------------------------------------------------------------------------------------------

  /** Forgets the worked-out ranking (the next question works it out again). */
  invalidate(): void {
    this.ranking = null;
  }

  /** Changes whenever a player is added or a ban starts or ends, so the cache can tell that it is out of date. */
  private signature(): string {
    const { db } = this.d;
    const u = db.get<{ n: number; m: number | null }>('SELECT COUNT(*) AS n, MAX(id) AS m FROM users');
    const b = db.get<{ n: number; s: number | null }>('SELECT COUNT(*) AS n, SUM(user_id) AS s FROM user_bans');
    return `${u?.n ?? 0}:${u?.m ?? 0}:${b?.n ?? 0}:${b?.s ?? 0}`;
  }

  private board(): Ranking {
    const nowMs = this.d.now();
    const signature = this.signature();
    const cached = this.ranking;
    if (cached && cached.signature === signature && nowMs - cached.atMs < BOARD_CACHE_MS && nowMs >= cached.atMs) return cached;
    const rows = this.d.db.all<{ id: number; username: string; display_name: string; role: string; created_ms: number; account_id: number }>(
      // Real players only: no computer player (the "bots" table, and the hash they carry), nobody who is banned right now.
      `SELECT u.id, u.username, u.display_name, u.role, u.created_ms, a.id AS account_id
         FROM users u JOIN accounts a ON a.user_id = u.id AND a.kind = 'career'
        WHERE u.pw_hash <> 'bot'
          AND NOT EXISTS (SELECT 1 FROM bots b WHERE b.user_id = u.id)
          AND NOT EXISTS (SELECT 1 FROM user_bans x WHERE x.user_id = u.id AND (x.until_ms IS NULL OR x.until_ms > ?))
        ORDER BY u.id`,
      nowMs,
    );
    const ranked: Person[] = [];
    const owners: Person[] = [];
    for (const r of rows) {
      const owner = r.role === 'owner';
      const person: Person = {
        id: r.id,
        username: r.username,
        displayName: r.display_name,
        owner,
        createdMs: r.created_ms,
        netWorthCents: owner ? null : this.d.trading.view(r.account_id).netWorthCents,
        rank: null,
      };
      (owner ? owners : ranked).push(person);
    }
    // Richest first; the same money: the older account first, then the lower id, so the order never flickers.
    ranked.sort((x, y) => (y.netWorthCents as number) - (x.netWorthCents as number) || x.createdMs - y.createdMs || x.id - y.id);
    ranked.forEach((p, i) => {
      p.rank = i + 1;
    });
    const people = [...ranked, ...owners];
    this.ranking = { atMs: nowMs, signature, people, ranked, byId: new Map(people.map((p) => [p.id, p])) };
    return this.ranking;
  }

  // ---- friendships -------------------------------------------------------------------------------------------------

  private links(userId: number): Link[] {
    return this.d.db
      .all<{ user_a: number; user_b: number; requester_id: number; status: 'pending' | 'accepted'; created_ms: number; accepted_ms: number | null }>(
        'SELECT user_a, user_b, requester_id, status, created_ms, accepted_ms FROM friendships WHERE user_a = ? OR user_b = ?',
        userId,
        userId,
      )
      .map((r) => ({ other: r.user_a === userId ? r.user_b : r.user_a, status: r.status, requester: r.requester_id, createdMs: r.created_ms, acceptedMs: r.accepted_ms }));
  }

  private linkOf(a: number, b: number): Link | undefined {
    const [x, y] = pair(a, b);
    const r = this.d.db.get<{ requester_id: number; status: 'pending' | 'accepted'; created_ms: number; accepted_ms: number | null }>(
      'SELECT requester_id, status, created_ms, accepted_ms FROM friendships WHERE user_a = ? AND user_b = ?',
      x,
      y,
    );
    return r ? { other: b, status: r.status, requester: r.requester_id, createdMs: r.created_ms, acceptedMs: r.accepted_ms } : undefined;
  }

  private relationOf(meId: number, otherId: number, links: ReadonlyMap<number, Link>): Relation {
    if (meId === otherId) return 'you';
    const l = links.get(otherId);
    if (!l) return 'none';
    if (l.status === 'accepted') return 'friend';
    return l.requester === meId ? 'outgoing' : 'incoming';
  }

  private counts(userId: number): { friends: number; outgoing: number; incoming: number } {
    let friends = 0;
    let outgoing = 0;
    let incoming = 0;
    for (const l of this.links(userId)) {
      if (l.status === 'accepted') friends += 1;
      else if (l.requester === userId) outgoing += 1;
      else incoming += 1;
    }
    return { friends, outgoing, incoming };
  }

  /** A player who can be named in a request: a real player who is not banned. */
  private findPlayer(username: string): Person {
    const name = cleanName(username);
    if (name === '' || name.length > 40) throw new SocialError('no_such_player', 'Type the name of a player.', 404);
    const row = this.d.db.get<{ id: number }>('SELECT id FROM users WHERE username = ?', name);
    const person = row ? this.board().byId.get(row.id) : undefined;
    if (!person) throw new SocialError('no_such_player', `There is no player called "${name}".`, 404);
    return person;
  }

  /** The id of any user with this name, banned or not (to clean up an old request or friendship). */
  private findId(username: string): number {
    const name = cleanName(username);
    const row = name === '' || name.length > 40 ? undefined : this.d.db.get<{ id: number }>('SELECT id FROM users WHERE username = ?', name);
    if (!row) throw new SocialError('no_such_player', `There is no player called "${name}".`, 404);
    return row.id;
  }

  // ---- reading -----------------------------------------------------------------------------------------------------

  /** The player list, richest first (the owner last), optionally only names that contain `search`. */
  players(me: User, search: string, limit: number, offset: number): PlayerPage {
    const b = this.board();
    const needle = search.trim().replace(/^@+/, '').toLowerCase();
    const matching = needle === '' ? b.people : b.people.filter((p) => p.username.toLowerCase().includes(needle));
    const size = Math.min(Math.max(1, Math.floor(limit) || PLAYERS_PAGE), PLAYERS_PAGE_MAX);
    const start = Math.max(0, Math.floor(offset) || 0);
    const links = new Map(this.links(me.id).map((l) => [l.other, l]));
    const players = matching.slice(start, start + size).map(
      (p): PlayerEntry => ({
        username: p.username,
        displayName: p.displayName,
        role: p.owner ? 'owner' : 'player',
        netWorthCents: p.netWorthCents,
        rank: p.rank,
        relation: this.relationOf(me.id, p.id, links),
      }),
    );
    return { players, total: matching.length, offset: start, updatedMs: b.atMs };
  }

  /** The richest players. 'all' = everybody (at most BOARD_SIZE), 'friends' = you and your friends. */
  leaderboard(me: User, scope: 'all' | 'friends'): Leaderboard {
    const b = this.board();
    const links = new Map(this.links(me.id).map((l) => [l.other, l]));
    let view: readonly Person[] = b.ranked;
    if (scope === 'friends') {
      const keep = new Set<number>([me.id]);
      for (const l of links.values()) if (l.status === 'accepted') keep.add(l.other);
      view = b.ranked.filter((p) => keep.has(p.id));
    }
    const entry = (p: Person, i: number): BoardEntry => ({
      rank: i + 1,
      username: p.username,
      displayName: p.displayName,
      netWorthCents: p.netWorthCents as number,
      relation: this.relationOf(me.id, p.id, links),
    });
    const rows = view.slice(0, BOARD_SIZE).map(entry);
    const at = view.findIndex((p) => p.id === me.id);
    const mine = at < 0 ? null : { rank: at + 1, netWorthCents: view[at]?.netWorthCents as number, inTop: at < BOARD_SIZE };
    return { scope, rows, total: view.length, size: BOARD_SIZE, me: mine, updatedMs: b.atMs };
  }

  /** Your friends, the requests waiting for your answer and the ones you sent. */
  friends(me: User): FriendsState {
    const b = this.board();
    const make = (l: Link): FriendEntry | null => {
      const p = b.byId.get(l.other);
      if (!p) return null; // banned or gone: not shown (the link stays, so a ban that ends brings the friend back)
      return { username: p.username, displayName: p.displayName, role: p.owner ? 'owner' : 'player', netWorthCents: p.netWorthCents, rank: p.rank, sinceMs: l.acceptedMs ?? l.createdMs };
    };
    const friends: FriendEntry[] = [];
    const incoming: FriendEntry[] = [];
    const outgoing: FriendEntry[] = [];
    for (const l of this.links(me.id)) {
      const e = make(l);
      if (!e) continue;
      (l.status === 'accepted' ? friends : l.requester === me.id ? outgoing : incoming).push(e);
    }
    friends.sort((x, y) => (y.netWorthCents ?? -Infinity) - (x.netWorthCents ?? -Infinity) || x.username.localeCompare(y.username));
    incoming.sort((x, y) => y.sinceMs - x.sinceMs);
    outgoing.sort((x, y) => y.sinceMs - x.sinceMs);
    return { friends, incoming, outgoing, limits: { maxFriends: MAX_FRIENDS, maxOutgoing: MAX_OUTGOING } };
  }

  // ---- changing -----------------------------------------------------------------------------------------------------

  /**
   * Sends a friend request. If that player has already sent you one, this accepts it instead. Asking again for something that is
   * already so (a request waiting, already friends) changes nothing and answers with how things stand.
   */
  request(me: User, username: string): Relation {
    const target = this.findPlayer(username);
    if (target.id === me.id) throw new SocialError('bad_request', 'That is you.', 400);
    const result = this.d.db.tx((): Relation => {
      const link = this.linkOf(me.id, target.id);
      if (link?.status === 'accepted') return 'friend';
      if (link?.status === 'pending') {
        if (link.requester === me.id) return 'outgoing';
        this.makeFriends(me.id, target.id); // he asked first: asking him back is the same as saying yes
        return 'friend';
      }
      const mine = this.counts(me.id);
      if (mine.friends >= MAX_FRIENDS) throw new SocialError('too_many_friends', `You have ${MAX_FRIENDS} friends, the most there can be. Remove one first.`, 409);
      if (mine.outgoing >= MAX_OUTGOING) throw new SocialError('too_many_requests', `You already have ${MAX_OUTGOING} requests waiting for an answer. Cancel some first.`, 409);
      const theirs = this.counts(target.id);
      if (theirs.friends >= MAX_FRIENDS) throw new SocialError('too_many_friends', `That player already has ${MAX_FRIENDS} friends, the most there can be.`, 409);
      if (theirs.incoming >= MAX_INCOMING) throw new SocialError('player_busy', 'That player has too many requests waiting. Try again later.', 409);
      const [a, b] = pair(me.id, target.id);
      this.d.db.run("INSERT INTO friendships(user_a, user_b, requester_id, status, created_ms) VALUES (?, ?, ?, 'pending', ?)", a, b, me.id, this.d.now());
      return 'outgoing';
    });
    this.d.notify?.(target.id);
    return result;
  }

  /** Says yes to a request another player sent you. */
  accept(me: User, username: string): Relation {
    const target = this.findPlayer(username);
    this.d.db.tx(() => {
      const link = this.linkOf(me.id, target.id);
      if (link?.status === 'accepted') return;
      if (!link || link.requester === me.id) throw new SocialError('no_request', `${target.displayName} has not asked to be your friend.`, 404);
      this.makeFriends(me.id, target.id);
    });
    this.d.notify?.(target.id);
    return 'friend';
  }

  private makeFriends(meId: number, otherId: number): void {
    if (this.counts(meId).friends >= MAX_FRIENDS) throw new SocialError('too_many_friends', `You have ${MAX_FRIENDS} friends, the most there can be. Remove one first.`, 409);
    if (this.counts(otherId).friends >= MAX_FRIENDS) throw new SocialError('too_many_friends', `That player already has ${MAX_FRIENDS} friends, the most there can be.`, 409);
    const [a, b] = pair(meId, otherId);
    this.d.db.run("UPDATE friendships SET status = 'accepted', accepted_ms = ? WHERE user_a = ? AND user_b = ? AND status = 'pending'", this.d.now(), a, b);
  }

  /** Says no to a request another player sent you. The other player gets no notice; the request is just gone from his list the next time it refreshes. */
  decline(me: User, username: string): void {
    const otherId = this.findId(username);
    const [a, b] = pair(me.id, otherId);
    const done = this.d.db.run("DELETE FROM friendships WHERE user_a = ? AND user_b = ? AND status = 'pending' AND requester_id = ?", a, b, otherId).changes;
    if (done === 0) throw new SocialError('no_request', 'There is no request from that player.', 404);
  }

  /** Takes back a request you sent. */
  cancel(me: User, username: string): void {
    const otherId = this.findId(username);
    const [a, b] = pair(me.id, otherId);
    const done = this.d.db.run("DELETE FROM friendships WHERE user_a = ? AND user_b = ? AND status = 'pending' AND requester_id = ?", a, b, me.id).changes;
    if (done === 0) throw new SocialError('no_request', 'You have no request waiting for that player.', 404);
    this.d.notify?.(otherId);
  }

  /** Ends a friendship (for both players). */
  remove(me: User, username: string): void {
    const otherId = this.findId(username);
    const [a, b] = pair(me.id, otherId);
    const done = this.d.db.run("DELETE FROM friendships WHERE user_a = ? AND user_b = ? AND status = 'accepted'", a, b).changes;
    if (done === 0) throw new SocialError('not_friends', 'You are not friends with that player.', 404);
    this.d.notify?.(otherId);
  }
}
