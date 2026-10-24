// Voice calls between two friends (docs/world.md §17). The sound never goes through this server: the two browsers connect to each other (WebRTC).
// The server only does what the browsers cannot do alone: it rings a friend who has a page open, lets him answer or refuse, and passes the small
// connection messages ("signals": an offer, an answer, network addresses to try) from one page to the other. Nothing is saved: a call exists only in
// memory, so a restart ends every call, and no word of a call is ever stored.
//
// The rules, all decided here:
//   • only friends can call each other, and only a friend who has a page open can be called (a ring nobody can see is pointless);
//   • nobody who blocked the other, no computer player and nobody the owner banned;
//   • one call at a time per player, ringing included (you always know what you are in, and nobody can be flooded);
//   • a ring runs out after RING_MS; a player whose page has been gone for GONE_GRACE_MS is hung up on (a short loss of connection is forgiven);
//   • a call ends at once when the two stop being friends, when one of them is banned, or when either side hangs up;
//   • only the two players can send signals, only while the call is answered, only the right kind from the right side, and only a few of them;
//   • the owner cannot listen: there is nothing to listen to, and nothing about a call is stored for him to read.

import type { User } from './auth';
import type { IceServer } from './config';
import type { Logger } from './log';
import { cleanName } from './social';
import type { Db } from './sqlite';

/** How long a ring can be answered, in milliseconds. */
export const RING_MS = 30_000;
/** How long a player's page may be gone before the call is ended, in milliseconds. */
export const GONE_GRACE_MS = 15_000;
/** The most calls one player can start in a minute and in an hour (a ring he took back counts too). */
export const INVITES_PER_MINUTE = 5;
export const INVITES_PER_HOUR = 30;
/** The most signals one call can pass on in total (a normal call needs about thirty). */
export const MAX_SIGNALS = 200;
/** The longest offer or answer and the longest network address accepted, in characters. */
export const MAX_SDP = 12_000;
export const MAX_CANDIDATE = 600;

export type CallEndReason = 'declined' | 'cancelled' | 'missed' | 'ended' | 'failed' | 'disconnected' | 'unavailable';

export class CallError extends Error {
  constructor(
    readonly code: 'no_such_player' | 'bad_request' | 'not_friends' | 'cannot_call' | 'offline' | 'busy' | 'player_busy' | 'rate_limited' | 'no_call' | 'not_allowed' | 'not_ringing' | 'not_active',
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface PersonRef {
  readonly username: string;
  readonly displayName: string;
  readonly role: 'player' | 'owner';
}

/** The call as one of its two players sees it. */
export interface CallView {
  readonly id: string;
  readonly state: 'ringing' | 'active';
  readonly direction: 'outgoing' | 'incoming';
  readonly other: PersonRef;
  /** While ringing: how long it can still be answered. Null once answered. */
  readonly msLeft: number | null;
}

export interface CallsReply {
  readonly call: CallView | null;
  /** The servers a browser uses to find a way to the other browser. */
  readonly ice: readonly IceServer[];
  readonly limits: { readonly ringMs: number };
}

/** What a player is told when his call is over. */
export interface CallEnded {
  readonly callId: string;
  readonly reason: CallEndReason;
  readonly other: PersonRef;
  /** Whether this player was the one calling. */
  readonly role: 'caller' | 'callee';
  /** Whether this player's own action ended it (his other pages are told too). */
  readonly byYou: boolean;
}

/** A connection message from one browser for the other, cleaned. */
export type CallSignal =
  | { readonly kind: 'offer'; readonly sdp: string }
  | { readonly kind: 'answer'; readonly sdp: string }
  | { readonly kind: 'candidate'; readonly candidate: string; readonly sdpMid: string | null; readonly sdpMLineIndex: number | null };

export interface CallDeps {
  readonly db: Db;
  readonly log: Logger;
  readonly now: () => number;
  readonly ice: readonly IceServer[];
  /** Whether the player has a page open (a live stream) right now. */
  readonly isOnline: (userId: number) => boolean;
  /** Whether the owner has banned the player right now. */
  readonly isBanned: (userId: number) => boolean;
  /** Sends a live event to all pages of one player. */
  readonly publishTo: (userId: number, event: string, data: unknown) => void;
}

interface Call {
  readonly id: string;
  readonly callerId: number;
  readonly calleeId: number;
  readonly caller: PersonRef;
  readonly callee: PersonRef;
  state: 'ringing' | 'active';
  readonly ringEndsMs: number;
  signals: number;
  /** Since when each player has had no page open (null = has one). */
  callerGone: number | null;
  calleeGone: number | null;
}

interface Target {
  readonly id: number;
  readonly ref: PersonRef;
}

const pair = (a: number, b: number): [number, number] => (a < b ? [a, b] : [b, a]);
const SDP_CHARS = /^[\t\n\r\x20-\x7e]*$/;

/** Checks a signal sent by a player and returns a clean copy. The caller sends the offer, the callee the answer, both send addresses. */
export function cleanSignal(data: unknown, role: 'caller' | 'callee'): CallSignal {
  const bad = (message: string): never => {
    throw new CallError('bad_request', message, 400);
  };
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return bad('That is not a call signal.');
  const o = data as Record<string, unknown>;
  if (o.kind === 'offer' || o.kind === 'answer') {
    if (o.kind === 'offer' && role !== 'caller') return bad('Only the player who called sends the offer.');
    if (o.kind === 'answer' && role !== 'callee') return bad('Only the player who was called sends the answer.');
    if (typeof o.sdp !== 'string' || o.sdp.length < 10 || o.sdp.length > MAX_SDP || !o.sdp.startsWith('v=0') || !SDP_CHARS.test(o.sdp)) return bad('That is not a valid call description.');
    return { kind: o.kind, sdp: o.sdp };
  }
  if (o.kind === 'candidate') {
    if (typeof o.candidate !== 'string' || o.candidate.length > MAX_CANDIDATE || !SDP_CHARS.test(o.candidate)) return bad('That is not a valid network address.');
    const mid = o.sdpMid ?? null;
    if (mid !== null && (typeof mid !== 'string' || mid.length > 64 || !SDP_CHARS.test(mid))) return bad('That is not a valid network address.');
    const index = o.sdpMLineIndex ?? null;
    if (index !== null && (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > 64)) return bad('That is not a valid network address.');
    return { kind: 'candidate', candidate: o.candidate, sdpMid: mid, sdpMLineIndex: index };
  }
  return bad('That is not a call signal.');
}

export class Calls {
  private readonly calls = new Map<string, Call>();
  private readonly byUser = new Map<number, string>();
  private readonly invites = new Map<number, number[]>();
  private seq = 0;
  private readonly epoch: string;

  constructor(private readonly d: CallDeps) {
    // Call numbers start from the clock, so a number from before a restart can never match a new call.
    this.epoch = d.now().toString(36);
  }

  // ---- reading -----------------------------------------------------------------------------------------------------

  private personRef(row: { username: string; display_name: string; role: 'player' | 'owner' }): PersonRef {
    return { username: row.username, displayName: row.display_name, role: row.role };
  }

  private viewFor(call: Call, userId: number): CallView {
    const outgoing = call.callerId === userId;
    return {
      id: call.id,
      state: call.state,
      direction: outgoing ? 'outgoing' : 'incoming',
      other: outgoing ? call.callee : call.caller,
      msLeft: call.state === 'ringing' ? Math.max(0, call.ringEndsMs - this.d.now()) : null,
    };
  }

  private reply(userId: number): CallsReply {
    const id = this.byUser.get(userId);
    const call = id === undefined ? undefined : this.calls.get(id);
    return { call: call ? this.viewFor(call, userId) : null, ice: this.d.ice, limits: { ringMs: RING_MS } };
  }

  /** The player's call (null if none) and the servers a browser needs. */
  view(me: User): CallsReply {
    this.sweep();
    return this.reply(me.id);
  }

  /** The call with this number, if the player is one of its two players. */
  private mine(me: User, callId: unknown): Call {
    const call = typeof callId === 'string' ? this.calls.get(callId) : undefined;
    if (!call || (call.callerId !== me.id && call.calleeId !== me.id)) throw new CallError('no_call', 'That call is over.', 404);
    return call;
  }

  // ---- finding people ----------------------------------------------------------------------------------------------

  /** A real player (no computer player) who is not banned. */
  private find(username: unknown): Target {
    const name = cleanName(username);
    const row = name === '' || name.length > 40 ? undefined : this.d.db.get<{ id: number; username: string; display_name: string; role: 'player' | 'owner' }>('SELECT id, username, display_name, role FROM users WHERE username = ?', name);
    if (!row || this.d.db.get('SELECT 1 AS x FROM bots WHERE user_id = ?', row.id) || this.d.isBanned(row.id)) {
      throw new CallError('no_such_player', name === '' ? 'Type the name of a friend.' : `There is no player called "${name}".`, 404);
    }
    return { id: row.id, ref: this.personRef(row) };
  }

  private areFriends(a: number, b: number): boolean {
    const [x, y] = pair(a, b);
    return this.d.db.get("SELECT 1 AS x FROM friendships WHERE user_a = ? AND user_b = ? AND status = 'accepted'", x, y) !== undefined;
  }

  private blocked(a: number, b: number): boolean {
    return this.d.db.get('SELECT 1 AS x FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)', a, b, b, a) !== undefined;
  }

  private limitInvites(userId: number): void {
    const now = this.d.now();
    const list = (this.invites.get(userId) ?? []).filter((t) => t > now - 3_600_000);
    if (list.length >= INVITES_PER_HOUR) throw new CallError('rate_limited', 'You have made a lot of calls this hour. Try again a little later.', 429);
    if (list.filter((t) => t > now - 60_000).length >= INVITES_PER_MINUTE) throw new CallError('rate_limited', 'You are calling too quickly. Wait a moment.', 429);
    list.push(now);
    this.invites.set(userId, list);
  }

  // ---- changing ----------------------------------------------------------------------------------------------------

  /** Rings a friend. */
  invite(me: User, username: unknown): CallsReply {
    this.sweep();
    const target = this.find(username);
    if (target.id === me.id) throw new CallError('bad_request', 'That is you.', 400);
    this.limitInvites(me.id);
    if (!this.areFriends(me.id, target.id)) throw new CallError('not_friends', `${target.ref.displayName} is not your friend yet. Send a friend request first.`, 403);
    if (this.blocked(me.id, target.id)) throw new CallError('cannot_call', `You can't call ${target.ref.displayName}.`, 403);
    const mine = this.byUser.get(me.id);
    if (mine !== undefined) {
      const call = this.calls.get(mine) as Call;
      if (call.state === 'ringing' && call.calleeId === me.id && call.callerId === target.id) throw new CallError('busy', `${target.ref.displayName} is already calling you. Answer the call.`, 409);
      throw new CallError('busy', 'You are already on a call. Hang up first.', 409);
    }
    if (!this.d.isOnline(me.id)) throw new CallError('offline', 'This page has lost its connection to the server. Wait a moment and try again.', 409);
    if (!this.d.isOnline(target.id)) throw new CallError('offline', `${target.ref.displayName} is not online right now, so there is nobody to answer. Try again when your friend is on TradeQuest.`, 409);
    if (this.byUser.has(target.id)) throw new CallError('player_busy', `${target.ref.displayName} is on another call. Try again in a moment.`, 409);
    this.seq += 1;
    const call: Call = {
      id: `c${this.epoch}-${this.seq}`,
      callerId: me.id,
      calleeId: target.id,
      caller: { username: me.username, displayName: me.displayName, role: me.role },
      callee: target.ref,
      state: 'ringing',
      ringEndsMs: this.d.now() + RING_MS,
      signals: 0,
      callerGone: null,
      calleeGone: null,
    };
    this.calls.set(call.id, call);
    this.byUser.set(me.id, call.id);
    this.byUser.set(target.id, call.id);
    this.d.log.info('calls', `Player ${me.id} is calling player ${target.id}.`);
    this.push(call);
    return this.reply(me.id);
  }

  /** The player who was called says yes. */
  accept(me: User, callId: unknown): CallsReply {
    this.sweep();
    const call = this.mine(me, callId);
    if (call.calleeId !== me.id) throw new CallError('not_allowed', 'Only the player who is called can answer.', 403);
    if (call.state !== 'ringing') throw new CallError('not_ringing', 'That call has already been answered.', 409);
    if (!this.d.isOnline(call.callerId)) throw new CallError('offline', `${call.caller.displayName} is not online any more, so the call cannot start.`, 409);
    call.state = 'active';
    call.callerGone = null;
    call.calleeGone = null;
    this.push(call);
    return this.reply(me.id);
  }

  /**
   * Ends a call: the caller takes back a ring, the callee refuses it, or either hangs up an answered call.
   * `failed` says the browsers could not connect (only for an answered call); the other player is told so.
   */
  hangup(me: User, callId: unknown, failed = false): CallsReply {
    this.sweep();
    const call = this.mine(me, callId);
    const reason: CallEndReason = call.state === 'ringing' ? (call.callerId === me.id ? 'cancelled' : 'declined') : failed ? 'failed' : 'ended';
    this.finish(call, reason, me.id);
    return this.reply(me.id);
  }

  /** Passes one connection message to the other player's pages. */
  signal(me: User, callId: unknown, data: unknown): { ok: true } {
    this.sweep();
    const call = this.mine(me, callId);
    if (call.state !== 'active') throw new CallError('not_active', 'The call has not been answered yet.', 409);
    const signal = cleanSignal(data, call.callerId === me.id ? 'caller' : 'callee');
    if (call.signals >= MAX_SIGNALS) throw new CallError('rate_limited', 'This call has sent too many connection messages.', 429);
    call.signals += 1;
    this.d.publishTo(call.callerId === me.id ? call.calleeId : call.callerId, 'call_signal', { callId: call.id, signal });
    return { ok: true };
  }

  // ---- ending ------------------------------------------------------------------------------------------------------

  /** Ends the call and tells both players (every page of theirs). `byId` is the player whose action ended it, if any. */
  private finish(call: Call, reason: CallEndReason, byId: number | null): void {
    if (this.calls.get(call.id) !== call) return;
    this.calls.delete(call.id);
    if (this.byUser.get(call.callerId) === call.id) this.byUser.delete(call.callerId);
    if (this.byUser.get(call.calleeId) === call.id) this.byUser.delete(call.calleeId);
    this.d.log.info('calls', `A call between players ${call.callerId} and ${call.calleeId} ended: ${reason}.`);
    const ended = (role: 'caller' | 'callee'): CallEnded => ({
      callId: call.id,
      reason,
      other: role === 'caller' ? call.callee : call.caller,
      role,
      byYou: byId === (role === 'caller' ? call.callerId : call.calleeId),
    });
    this.d.publishTo(call.callerId, 'call', { call: null, ended: ended('caller') });
    this.d.publishTo(call.calleeId, 'call', { call: null, ended: ended('callee') });
  }

  private push(call: Call): void {
    this.d.publishTo(call.callerId, 'call', { call: this.viewFor(call, call.callerId) });
    this.d.publishTo(call.calleeId, 'call', { call: this.viewFor(call, call.calleeId) });
  }

  /** Looks again at one player's call after his friends or blocks changed: a call between players who are not friends any more ends at once. */
  recheck(userId: number): void {
    const id = this.byUser.get(userId);
    const call = id === undefined ? undefined : this.calls.get(id);
    if (!call) return;
    if (!this.areFriends(call.callerId, call.calleeId) || this.blocked(call.callerId, call.calleeId) || this.d.isBanned(call.callerId) || this.d.isBanned(call.calleeId)) {
      this.finish(call, 'unavailable', null);
    }
  }

  /** Ends rings that ran out and calls whose player has been gone too long. Called every second and before every request. */
  sweep(): void {
    if (this.calls.size === 0) return;
    const now = this.d.now();
    for (const call of [...this.calls.values()]) {
      if (call.state === 'ringing' && now >= call.ringEndsMs) {
        this.finish(call, 'missed', null);
        continue;
      }
      if (this.d.isBanned(call.callerId) || this.d.isBanned(call.calleeId)) {
        this.finish(call, 'unavailable', null);
        continue;
      }
      call.callerGone = this.d.isOnline(call.callerId) ? null : (call.callerGone ?? now);
      call.calleeGone = this.d.isOnline(call.calleeId) ? null : (call.calleeGone ?? now);
      if ((call.callerGone !== null && now - call.callerGone >= GONE_GRACE_MS) || (call.calleeGone !== null && now - call.calleeGone >= GONE_GRACE_MS)) {
        this.finish(call, 'disconnected', null);
      }
    }
  }

  /** How many calls exist right now (for tests and the log). */
  get size(): number {
    return this.calls.size;
  }
}
