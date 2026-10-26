// Private chats (docs/world.md §16): talking to one player, or to a small group of friends, away from the public chat room.
//
// Who may write to whom is decided here, on the server, and nowhere else:
//   • friends can write to each other at once;
//   • anybody else can send ONE message as a request. The other player accepts it (writing back counts as accepting) or ignores it, and until
//     he accepts, the first player cannot send another. He is never told whether the request was ignored or just not answered yet;
//   • a player who blocked another cannot be written to, asked for friendship or invited by him, and what the other player wrote (and writes)
//     in a conversation they share is hidden from him. Blocking also ends the friendship and closes a waiting request. The blocked player is
//     not told that he was blocked, only that he cannot write to that player;
//   • a group has at most MAX_GROUP_MEMBERS players. Any member invites his own friends (an invitation has to be accepted; you cannot invite
//     somebody else's friend); only its creator removes people and renames it; anybody can leave;
//   • messages are plain one-line text like in the public chat (server/chat.ts: same cleaning, same length, same pause between messages, same
//     burst limit and no repeats), and a brand-new account writes only after NEW_ACCOUNT_WAIT_MS (the owner is exempt).
// Only the members of a conversation can read it. The owner cannot: he sees only what a player REPORTS (that message and the few before it,
// copied at the time of the report), in the admin panel, and can close the report. Only the newest PM_KEEP messages of a conversation are kept.

import { roleSql, type Role, type User } from './auth';
import { CHAT_BURST, CHAT_BURST_MS, CHAT_MAX_LENGTH, MIN_GAP_MS, NEW_ACCOUNT_WAIT_MS, REPEAT_MS, cleanMessage, waitText } from './chat';
import type { Logger } from './log';
import { cleanName } from './social';
import type { Db } from './sqlite';

/** How many messages a conversation shows when it opens (at most PM_PAGE_MAX when asked for more). */
export const PM_PAGE = 50;
export const PM_PAGE_MAX = 100;
/** How many messages of one conversation are kept; older ones are deleted. */
export const PM_KEEP = 1000;
/** A group holds at most this many players (counting the ones who have been invited and not answered). */
export const MAX_GROUP_MEMBERS = 8;
/** The most groups one player can be in. */
export const MAX_GROUPS = 20;
export const MAX_GROUP_TITLE = 40;
/** The most groups one player can make in an hour. */
export const GROUPS_PER_HOUR = 5;
/** The most players one player can ask to talk (send a message request to) in a day, and the most requests he can have waiting. */
export const REQUESTS_PER_DAY = 10;
export const MAX_REQUESTS_OUT = 10;
/** The most requests, and the most group invitations, that can be waiting for one player. */
export const MAX_REQUESTS_IN = 50;
export const MAX_INVITES_WAITING = 10;
/** The most players one player can block. */
export const MAX_BLOCKS = 200;
/** How many messages before a reported one are copied for the owner. */
export const REPORT_CONTEXT = 5;
export const PM_REPORTS_PER_HOUR = 20;

export type MessageErrorCode =
  | 'too_new'
  | 'empty'
  | 'too_long'
  | 'too_fast'
  | 'repeat'
  | 'bad_request'
  | 'no_such_player'
  | 'no_such_conversation'
  | 'no_such_message'
  | 'no_request'
  | 'not_friends'
  | 'blocked'
  | 'cannot_message'
  | 'waiting'
  | 'too_many_requests'
  | 'too_many_groups'
  | 'group_full'
  | 'not_creator'
  | 'rate_limited'
  | 'too_many_blocks';

export class MessageError extends Error {
  constructor(
    readonly code: MessageErrorCode,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface PersonRef {
  readonly username: string;
  readonly displayName: string;
  readonly role: Role;
}

export interface PrivateMessage {
  readonly id: number;
  readonly conversationId: number;
  readonly username: string;
  readonly displayName: string;
  readonly role: Role;
  readonly text: string;
  readonly createdMs: number;
}

/** Whether the player can write at all right now (a brand-new account cannot yet). */
export interface MessagesYou {
  readonly canWrite: boolean;
  readonly reason: 'new_account' | null;
  readonly untilMs: number | null;
  readonly message: string | null;
}

export interface ConversationView {
  readonly id: number;
  readonly kind: 'direct' | 'group';
  /** The other player's name (direct) or the name of the group. */
  readonly title: string;
  /** The other player of a direct chat. */
  readonly other: PersonRef | null;
  /** The players in the conversation (a direct chat: both). */
  readonly members: readonly PersonRef[];
  /** Players invited to a group who have not answered. */
  readonly invited: readonly PersonRef[];
  /** The username of the group's creator. */
  readonly creator: string | null;
  readonly last: PrivateMessage | null;
  readonly lastMs: number;
  readonly unread: number;
  /** Whether the player can write in this conversation, and if not (or if there is something to know), the words that say so. */
  readonly canWrite: boolean;
  readonly note: string | null;
  /** Direct chat: 'incoming' = the other player asked to talk and has not been answered; 'waiting' = you asked and nothing more can be sent yet. */
  readonly requestState: 'incoming' | 'waiting' | null;
  /** Direct chat: the two are friends. */
  readonly friends: boolean;
}

export type RequestView =
  | { readonly kind: 'message'; readonly conversationId: number; readonly from: PersonRef; readonly text: string; readonly sinceMs: number }
  | { readonly kind: 'invite'; readonly conversationId: number; readonly title: string; readonly from: PersonRef; readonly memberCount: number; readonly sinceMs: number };

export interface BlockedView {
  readonly username: string;
  readonly displayName: string;
  readonly sinceMs: number;
}

export interface MessagesLimits {
  readonly maxLength: number;
  readonly minGapMs: number;
  readonly maxGroupMembers: number;
  readonly maxGroups: number;
  readonly maxGroupTitle: number;
}

export interface MessagesView {
  /** Open conversations, newest first. */
  readonly conversations: readonly ConversationView[];
  /** Message requests and group invitations waiting for an answer, newest first. */
  readonly requests: readonly RequestView[];
  readonly blocked: readonly BlockedView[];
  /** Unread messages in all open conversations. */
  readonly unread: number;
  readonly you: MessagesYou;
  readonly limits: MessagesLimits;
}

export interface ConversationPage {
  readonly conversation: ConversationView;
  /** Oldest first. */
  readonly messages: readonly PrivateMessage[];
  readonly more: boolean;
}

export interface SendResult {
  readonly conversationId: number;
  readonly message: PrivateMessage;
  readonly conversation: ConversationView;
  readonly you: MessagesYou;
}

export interface ReportedLine {
  readonly username: string;
  readonly displayName: string;
  readonly text: string;
  readonly createdMs: number;
  /** True for the message that was reported. */
  readonly reported: boolean;
}

export interface PrivateReportEntry {
  readonly messageId: number;
  readonly kind: 'direct' | 'group' | null;
  readonly groupTitle: string | null;
  readonly author: PersonRef;
  readonly reporters: number;
  readonly firstReportedMs: number;
  /** The reported message and up to REPORT_CONTEXT before it, as they were. */
  readonly lines: readonly ReportedLine[];
  /** How many different messages of this author have open reports. */
  readonly authorOpenReports: number;
}

export interface AdminPrivateView {
  readonly reports: readonly PrivateReportEntry[];
}

export interface MessagesDeps {
  readonly db: Db;
  readonly log: Logger;
  readonly now: () => number;
  /** Sends an event to one player's pages. */
  readonly publishTo: (userId: number, event: string, data: unknown) => void;
  /** Whether the owner has banned the player right now. */
  readonly isBanned: (userId: number) => boolean;
  /** Tell the player's other pages that his friends / challenges changed (blocking ends a friendship). */
  readonly notifyFriends?: (userId: number) => void;
  readonly notifyChallenges?: (userId: number) => void;
  /** Writes one moderation action to the admin log. False when that requestId was already used for the same action (do nothing again). */
  readonly audit: (admin: User, requestId: unknown, action: 'pm_dismiss', target: string, detail: Record<string, unknown>) => boolean;
}

interface ConvRow {
  id: number;
  kind: 'direct' | 'group';
  title: string | null;
  direct_a: number | null;
  direct_b: number | null;
  created_by: number | null;
  created_ms: number;
  last_ms: number;
  request: 'pending' | 'accepted' | 'declined' | null;
  requester_id: number | null;
  request_ms: number | null;
  state: 'member' | 'invited';
  invited_by: number | null;
  joined_ms: number;
  since_id: number;
  read_id: number;
}

interface MessageRow {
  id: number;
  conversation_id: number;
  username: string;
  display_name: string;
  role: Role;
  body: string;
  created_ms: number;
}

interface Built {
  readonly view: ConversationView | null;
  readonly request: RequestView | null;
}

interface UserLite {
  readonly id: number;
  readonly username: string;
  readonly displayName: string;
  readonly role: Role;
}

type Check = { readonly ok: true } | { readonly ok: false; readonly code: MessageErrorCode; readonly message: string };

/** What makes a message of a conversation visible to one member: sent after he joined, not deleted by its writer, not by somebody he blocked or the owner banned. */
const VISIBLE = `m.id > cm.since_id
  AND m.deleted_ms IS NULL
  AND NOT EXISTS (SELECT 1 FROM blocks bl WHERE bl.blocker_id = cm.user_id AND bl.blocked_id = m.user_id)
  AND NOT EXISTS (SELECT 1 FROM user_bans ub WHERE ub.user_id = m.user_id AND (ub.until_ms IS NULL OR ub.until_ms > ?))`;

const pair = (a: number, b: number): [number, number] => (a < b ? [a, b] : [b, a]);
const ref = (u: { username: string; display_name: string; role: Role }): PersonRef => ({ username: u.username, displayName: u.display_name, role: u.role });

export class Messages {
  constructor(private readonly d: MessagesDeps) {}

  // ---- who may write -----------------------------------------------------------------------------------------------

  /** Whether the player can write now: a brand-new account waits NEW_ACCOUNT_WAIT_MS (the owner does not). */
  you(me: User): MessagesYou {
    const now = this.d.now();
    if (me.role !== 'owner' && me.createdMs + NEW_ACCOUNT_WAIT_MS > now) {
      const until = me.createdMs + NEW_ACCOUNT_WAIT_MS;
      return {
        canWrite: false,
        reason: 'new_account',
        untilMs: until,
        message: `New accounts can write privately after ${Math.round(NEW_ACCOUNT_WAIT_MS / 60_000)} minutes. You can write in ${waitText(until - now)}. Reading is open now.`,
      };
    }
    return { canWrite: true, reason: null, untilMs: null, message: null };
  }

  // ---- small lookups -----------------------------------------------------------------------------------------------

  private areFriends(a: number, b: number): boolean {
    const [x, y] = pair(a, b);
    return this.d.db.get("SELECT 1 AS x FROM friendships WHERE user_a = ? AND user_b = ? AND status = 'accepted'", x, y) !== undefined;
  }

  private hasBlocked(blocker: number, blocked: number): boolean {
    return this.d.db.get('SELECT 1 AS x FROM blocks WHERE blocker_id = ? AND blocked_id = ?', blocker, blocked) !== undefined;
  }

  /** A real player (no computer player) who is not banned, found by username. */
  private findUser(username: unknown): UserLite {
    if (typeof username !== 'string') throw new MessageError('bad_request', 'username must be the name of a player.', 400);
    const name = cleanName(username);
    const row = name === '' || name.length > 40 ? undefined : this.d.db.get<{ id: number; username: string; display_name: string; role: Role }>(`SELECT u.id, u.username, u.display_name, ${roleSql('u')} AS role FROM users u WHERE u.username = ?`, name);
    if (!row || this.d.db.get('SELECT 1 AS x FROM bots WHERE user_id = ?', row.id) || this.d.isBanned(row.id)) {
      throw new MessageError('no_such_player', name === '' ? 'Type the name of a player.' : `There is no player called "${name}".`, 404);
    }
    return { id: row.id, username: row.username, displayName: row.display_name, role: row.role };
  }

  private userById(id: number): UserLite | undefined {
    const row = this.d.db.get<{ id: number; username: string; display_name: string; role: Role }>(`SELECT u.id, u.username, u.display_name, ${roleSql('u')} AS role FROM users u WHERE u.id = ?`, id);
    return row ? { id: row.id, username: row.username, displayName: row.display_name, role: row.role } : undefined;
  }

  private idOf(value: unknown, what: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new MessageError('bad_request', `${what} must be a number.`, 400);
    return value;
  }

  private rowsOf(me: User, onlyId?: number): ConvRow[] {
    return this.d.db.all<ConvRow>(
      `SELECT c.id, c.kind, c.title, c.direct_a, c.direct_b, c.created_by, c.created_ms, c.last_ms, c.request, c.requester_id, c.request_ms,
              cm.state, cm.invited_by, cm.joined_ms, cm.since_id, cm.read_id
         FROM conversations c JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = ?
        ${onlyId === undefined ? '' : 'WHERE c.id = ?'}
        ORDER BY c.last_ms DESC, c.id DESC`,
      ...(onlyId === undefined ? [me.id] : [me.id, onlyId]),
    );
  }

  private directRow(me: User, otherId: number): ConvRow | undefined {
    const [a, b] = pair(me.id, otherId);
    const c = this.d.db.get<{ id: number }>("SELECT id FROM conversations WHERE kind = 'direct' AND direct_a = ? AND direct_b = ?", a, b);
    return c ? this.rowsOf(me, c.id)[0] : undefined;
  }

  private friendIds(userId: number): Set<number> {
    return new Set(
      this.d.db
        .all<{ id: number }>("SELECT CASE WHEN user_a = ? THEN user_b ELSE user_a END AS id FROM friendships WHERE status = 'accepted' AND (user_a = ? OR user_b = ?)", userId, userId, userId)
        .map((r) => r.id),
    );
  }

  // ---- the rule for writing in a direct chat -----------------------------------------------------------------------

  /** May `me` write to `other`, given the conversation between them (if there is one)? */
  private directCheck(row: ConvRow | undefined, me: number, other: UserLite, friend: boolean): Check {
    if (this.hasBlocked(me, other.id)) return { ok: false, code: 'blocked', message: `You blocked ${other.displayName}. Unblock them to write.` };
    if (this.hasBlocked(other.id, me)) return { ok: false, code: 'cannot_message', message: `You can't write to ${other.displayName}.` };
    if (friend) return { ok: true };
    const waiting: Check = { ok: false, code: 'waiting', message: `${other.displayName} has not accepted your message yet. You can write more when they do.` };
    if (!row || row.request === null || row.request === 'accepted') return { ok: true };
    if (row.request === 'pending' || row.request === 'declined') return row.requester_id === me ? waiting : { ok: true };
    return { ok: true };
  }

  /** The note a direct chat shows above its writing box. */
  private directNote(row: ConvRow | undefined, me: number, other: UserLite, friend: boolean, check: Check): string | null {
    if (!check.ok) return check.message;
    if (friend) return null;
    if (row && (row.request === 'pending' || row.request === 'declined') && row.requester_id !== me) return `${other.displayName} is not your friend. Writing back accepts their message; Block stops them from writing to you.`;
    if (!row || row.request === null) return `${other.displayName} is not your friend. Your message is sent as a request: they can accept it or ignore it, and you can send one more message when they accept.`;
    return null;
  }

  // ---- reading -----------------------------------------------------------------------------------------------------

  private toMessage(r: MessageRow): PrivateMessage {
    return { id: r.id, conversationId: r.conversation_id, username: r.username, displayName: r.display_name, role: r.role, text: r.body, createdMs: r.created_ms };
  }

  /** The views of the given conversations of one player (what the list and the thread header show). */
  private build(me: User, rows: ConvRow[]): Built[] {
    if (rows.length === 0) return [];
    const now = this.d.now();
    const ids = rows.map((r) => r.id);
    const marks = ids.map(() => '?').join(',');
    const people = this.d.db.all<{ conversation_id: number; state: 'member' | 'invited'; id: number; username: string; display_name: string; role: Role; banned: number }>(
      `SELECT cm.conversation_id, cm.state, u.id, u.username, u.display_name, ${roleSql('u')} AS role,
              EXISTS (SELECT 1 FROM user_bans ub WHERE ub.user_id = u.id AND (ub.until_ms IS NULL OR ub.until_ms > ?)) AS banned
         FROM conversation_members cm JOIN users u ON u.id = cm.user_id
        WHERE cm.conversation_id IN (${marks}) ORDER BY cm.joined_ms, u.id`,
      now,
      ...ids,
    );
    const unread = new Map(
      this.d.db
        .all<{ cid: number; n: number }>(
          `SELECT m.conversation_id AS cid, COUNT(*) AS n
             FROM private_messages m JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ? AND cm.state = 'member'
            WHERE m.conversation_id IN (${marks}) AND m.id > cm.read_id AND m.user_id <> cm.user_id AND ${VISIBLE}
            GROUP BY m.conversation_id`,
          me.id,
          ...ids,
          now,
        )
        .map((r) => [r.cid, r.n] as const),
    );
    const lastRows = this.d.db.all<MessageRow>(
      `SELECT lm.id, lm.conversation_id, u.username, u.display_name, ${roleSql('u')} AS role, lm.body, lm.created_ms
         FROM private_messages lm JOIN users u ON u.id = lm.user_id
        WHERE lm.id IN (SELECT MAX(m.id) FROM private_messages m JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ?
                         WHERE m.conversation_id IN (${marks}) AND ${VISIBLE} GROUP BY m.conversation_id)`,
      me.id,
      ...ids,
      now,
    );
    const last = new Map(lastRows.map((r) => [r.conversation_id, this.toMessage(r)] as const));
    const friends = this.friendIds(me.id);
    const out: Built[] = [];
    for (const row of rows) {
      const here = people.filter((p) => p.conversation_id === row.id && p.banned === 0);
      const members = here.filter((p) => p.state === 'member').map(ref);
      const invited = here.filter((p) => p.state === 'invited').map(ref);
      const creator = row.created_by === null ? null : (this.userById(row.created_by)?.username ?? null);
      if (row.kind === 'group') {
        if (row.state === 'invited') {
          const from = row.invited_by === null ? undefined : this.userById(row.invited_by);
          if (!from || this.d.isBanned(from.id)) continue;
          out.push({ view: null, request: { kind: 'invite', conversationId: row.id, title: row.title as string, from: { username: from.username, displayName: from.displayName, role: from.role }, memberCount: members.length, sinceMs: row.joined_ms } });
          continue;
        }
        out.push({
          request: null,
          view: {
            id: row.id,
            kind: 'group',
            title: row.title as string,
            other: null,
            members,
            invited,
            creator,
            last: last.get(row.id) ?? null,
            lastMs: row.last_ms,
            unread: unread.get(row.id) ?? 0,
            canWrite: true,
            note: null,
            requestState: null,
            friends: false,
          },
        });
        continue;
      }
      // a direct chat
      const otherId = row.direct_a === me.id ? (row.direct_b as number) : (row.direct_a as number);
      const o = people.find((p) => p.conversation_id === row.id && p.id === otherId);
      if (!o || o.banned === 1) continue;
      const other: UserLite = { id: o.id, username: o.username, displayName: o.display_name, role: o.role };
      const friend = friends.has(otherId);
      const incoming = !friend && row.request === 'pending' && row.requester_id !== me.id;
      if (!friend && row.request === 'declined' && row.requester_id !== me.id) continue; // he ignored it: it does not clutter his list
      const check = this.directCheck(row, me.id, other, friend);
      const requestState: ConversationView['requestState'] = incoming ? 'incoming' : !friend && (row.request === 'pending' || row.request === 'declined') && row.requester_id === me.id ? 'waiting' : null;
      const person: PersonRef = { username: other.username, displayName: other.displayName, role: other.role };
      const view: ConversationView = {
        id: row.id,
        kind: 'direct',
        title: other.displayName,
        other: person,
        members: [ref({ username: me.username, display_name: me.displayName, role: me.role }), person],
        invited: [],
        creator: null,
        last: last.get(row.id) ?? null,
        lastMs: row.last_ms,
        unread: unread.get(row.id) ?? 0,
        canWrite: check.ok,
        note: this.directNote(row, me.id, other, friend, check),
        requestState,
        friends: friend,
      };
      if (incoming) {
        out.push({ view, request: { kind: 'message', conversationId: row.id, from: person, text: last.get(row.id)?.text ?? '', sinceMs: row.request_ms ?? row.last_ms } });
      } else {
        out.push({ view, request: null });
      }
    }
    return out;
  }

  /** Everything the Messages screen lists: conversations, requests and invitations, the players you blocked. */
  view(me: User): MessagesView {
    const built = this.build(me, this.rowsOf(me));
    const conversations = built.filter((b) => b.view !== null && b.request === null).map((b) => b.view as ConversationView);
    const requests = built.filter((b) => b.request !== null).map((b) => b.request as RequestView);
    requests.sort((x, y) => y.sinceMs - x.sinceMs);
    return {
      conversations,
      requests,
      blocked: this.blockedList(me.id),
      unread: conversations.reduce((sum, c) => sum + c.unread, 0),
      you: this.you(me),
      limits: this.limits(),
    };
  }

  private limits(): MessagesLimits {
    return { maxLength: CHAT_MAX_LENGTH, minGapMs: MIN_GAP_MS, maxGroupMembers: MAX_GROUP_MEMBERS, maxGroups: MAX_GROUPS, maxGroupTitle: MAX_GROUP_TITLE };
  }

  private blockedList(userId: number): BlockedView[] {
    return this.d.db
      .all<{ username: string; display_name: string; created_ms: number }>('SELECT u.username, u.display_name, b.created_ms FROM blocks b JOIN users u ON u.id = b.blocked_id WHERE b.blocker_id = ? ORDER BY b.created_ms DESC, u.username', userId)
      .map((r) => ({ username: r.username, displayName: r.display_name, sinceMs: r.created_ms }));
  }

  /** One conversation of the player (also a request he has not answered yet). Null when he is not in it. */
  private viewOf(me: User, conversationId: number): ConversationView | null {
    const row = this.rowsOf(me, conversationId)[0];
    if (!row || row.state !== 'member') return null;
    return this.build(me, [row])[0]?.view ?? null;
  }

  /** The newest messages of a conversation (oldest first), or the page before `beforeId`. */
  thread(me: User, conversationId: unknown, beforeId?: number, limit = PM_PAGE): ConversationPage {
    const id = this.idOf(conversationId, 'conversation');
    const conversation = this.viewOf(me, id);
    if (!conversation) throw new MessageError('no_such_conversation', 'That conversation is not there.', 404);
    const size = Math.min(Math.max(1, Math.floor(limit) || PM_PAGE), PM_PAGE_MAX);
    const rows = this.d.db.all<MessageRow>(
      `SELECT m.id, m.conversation_id, u.username, u.display_name, ${roleSql('u')} AS role, m.body, m.created_ms
         FROM private_messages m JOIN users u ON u.id = m.user_id JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ?
        WHERE m.conversation_id = ? ${beforeId === undefined ? '' : 'AND m.id < ?'} AND ${VISIBLE}
        ORDER BY m.id DESC LIMIT ?`,
      ...(beforeId === undefined ? [me.id, id, this.d.now(), size + 1] : [me.id, id, beforeId, this.d.now(), size + 1]),
    );
    return { conversation, messages: rows.slice(0, size).reverse().map((r) => this.toMessage(r)), more: rows.length > size };
  }

  // ---- writing -----------------------------------------------------------------------------------------------------

  private checkText(raw: unknown): string {
    if (typeof raw !== 'string') throw new MessageError('bad_request', 'The message must be text.', 400);
    const text = cleanMessage(raw);
    if (text === '') throw new MessageError('empty', 'Type a message first.', 400);
    const length = Array.from(text).length;
    if (length > CHAT_MAX_LENGTH) throw new MessageError('too_long', `Messages can be at most ${CHAT_MAX_LENGTH} characters. Yours is ${length}.`, 400);
    return text;
  }

  /** The pause between messages, the half-minute limit and no repeating the last message of this conversation. */
  private checkPace(me: User, conversationId: number | null, text: string): void {
    const now = this.d.now();
    const mine = this.d.db.all<{ created_ms: number }>('SELECT created_ms FROM private_messages WHERE user_id = ? AND created_ms > ? ORDER BY id DESC LIMIT ?', me.id, now - CHAT_BURST_MS, CHAT_BURST);
    const latest = mine[0];
    if (latest && now - latest.created_ms < MIN_GAP_MS) throw new MessageError('too_fast', 'Slow down: wait a moment between messages.', 429);
    if (mine.length >= CHAT_BURST) throw new MessageError('too_fast', 'You are writing too fast. Wait a few seconds.', 429);
    if (conversationId !== null) {
      const same = this.d.db.get<{ body: string; created_ms: number }>('SELECT body, created_ms FROM private_messages WHERE user_id = ? AND conversation_id = ? ORDER BY id DESC LIMIT 1', me.id, conversationId);
      if (same && same.body.toLowerCase() === text.toLowerCase() && now - same.created_ms < REPEAT_MS) throw new MessageError('repeat', 'You just sent that. Write something different.', 400);
    }
  }

  private checkNewRequest(me: User, other: UserLite): void {
    const now = this.d.now();
    const { db } = this.d;
    const today = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM conversations WHERE requester_id = ? AND request_ms > ?', me.id, now - 86_400_000)?.n ?? 0;
    if (today >= REQUESTS_PER_DAY) throw new MessageError('too_many_requests', `You have asked ${REQUESTS_PER_DAY} players to talk today, the most you can. Try again tomorrow, or become friends first.`, 429);
    const waiting = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM conversations WHERE requester_id = ? AND request = 'pending'", me.id)?.n ?? 0;
    if (waiting >= MAX_REQUESTS_OUT) throw new MessageError('too_many_requests', `You already have ${MAX_REQUESTS_OUT} message requests waiting for an answer. Wait for some of them to be answered.`, 409);
    const theirs = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM conversations WHERE kind = 'direct' AND (direct_a = ? OR direct_b = ?) AND request = 'pending' AND requester_id <> ?", other.id, other.id, other.id)?.n ?? 0;
    if (theirs >= MAX_REQUESTS_IN) throw new MessageError('cannot_message', `${other.displayName} has too many message requests waiting. Try again later.`, 409);
  }

  /**
   * Sends a message, either into a conversation the player is in (`conversationId`) or to a player (`username`): that opens the direct chat
   * with him if there is none, as a request when the two are not friends.
   */
  send(me: User, input: { conversationId?: unknown; username?: unknown; text: unknown }): SendResult {
    const you = this.you(me);
    if (!you.canWrite) throw new MessageError('too_new', you.message as string, 403);
    const text = this.checkText(input.text);
    const now = this.d.now();
    const byId = input.conversationId !== undefined && input.conversationId !== null;
    const done = this.d.db.tx(() => {
      let row: ConvRow | undefined;
      let other: UserLite | null = null;
      if (byId) {
        row = this.rowsOf(me, this.idOf(input.conversationId, 'conversation'))[0];
        if (!row || row.state !== 'member') throw new MessageError('no_such_conversation', 'That conversation is not there.', 404);
        if (row.kind === 'direct') {
          const otherId = row.direct_a === me.id ? (row.direct_b as number) : (row.direct_a as number);
          const found = this.userById(otherId);
          if (!found || this.d.isBanned(found.id)) throw new MessageError('no_such_player', 'That player is not there any more.', 404);
          other = found;
        }
      } else {
        other = this.findUser(input.username);
        if (other.id === me.id) throw new MessageError('bad_request', 'That is you.', 400);
        row = this.directRow(me, other.id);
      }
      let conversationId = row?.id ?? 0;
      if (other) {
        const friend = this.areFriends(me.id, other.id);
        const check = this.directCheck(row, me.id, other, friend);
        if (!check.ok) throw new MessageError(check.code, check.message, 403);
        this.checkPace(me, row?.id ?? null, text);
        const startsRequest = !friend && (!row || row.request === null);
        if (startsRequest) this.checkNewRequest(me, other);
        if (!row) {
          const [a, b] = pair(me.id, other.id);
          conversationId = this.d.db.run(
            "INSERT INTO conversations(kind, direct_a, direct_b, created_by, created_ms, last_ms, request, requester_id, request_ms) VALUES ('direct', ?, ?, ?, ?, ?, ?, ?, ?)",
            a,
            b,
            me.id,
            now,
            now,
            startsRequest ? 'pending' : null,
            startsRequest ? me.id : null,
            startsRequest ? now : null,
          ).lastInsertRowid;
          for (const u of [me.id, other.id]) this.d.db.run("INSERT INTO conversation_members(conversation_id, user_id, state, joined_ms) VALUES (?, ?, 'member', ?)", conversationId, u, now);
        } else if (startsRequest) {
          this.d.db.run("UPDATE conversations SET request = 'pending', requester_id = ?, request_ms = ? WHERE id = ?", me.id, now, row.id);
        } else if (!friend && (row.request === 'pending' || row.request === 'declined') && row.requester_id !== me.id) {
          this.d.db.run("UPDATE conversations SET request = 'accepted' WHERE id = ?", row.id); // writing back is saying yes
        } else if (friend && row.request !== null) {
          this.d.db.run('UPDATE conversations SET request = NULL, requester_id = NULL, request_ms = NULL WHERE id = ?', row.id);
        }
      } else {
        this.checkPace(me, conversationId, text);
      }
      const id = this.d.db.run('INSERT INTO private_messages(conversation_id, user_id, body, created_ms) VALUES (?, ?, ?, ?)', conversationId, me.id, text, now).lastInsertRowid;
      this.d.db.run('UPDATE conversations SET last_ms = ? WHERE id = ?', now, conversationId);
      this.d.db.run('UPDATE conversation_members SET read_id = ? WHERE conversation_id = ? AND user_id = ?', id, conversationId, me.id);
      this.d.db.run(
        'DELETE FROM private_messages WHERE conversation_id = ? AND id <= (SELECT id FROM private_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)',
        conversationId,
        conversationId,
        PM_KEEP,
      );
      return { conversationId, id };
    });
    const message: PrivateMessage = { id: done.id, conversationId: done.conversationId, username: me.username, displayName: me.displayName, role: me.role, text, createdMs: now };
    for (const userId of this.recipients(done.conversationId, me.id)) this.d.publishTo(userId, 'pm', { conversationId: done.conversationId, message });
    const conversation = this.viewOf(me, done.conversationId) as ConversationView;
    return { conversationId: done.conversationId, message, conversation, you: this.you(me) };
  }

  /** Everybody who should get a live copy of a message: the members, except players who blocked its author. */
  private recipients(conversationId: number, authorId: number): number[] {
    return this.d.db
      .all<{ user_id: number }>(
        "SELECT cm.user_id FROM conversation_members cm WHERE cm.conversation_id = ? AND cm.state = 'member' AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id = cm.user_id AND b.blocked_id = ?)",
        conversationId,
        authorId,
      )
      .map((r) => r.user_id);
  }

  private memberIds(conversationId: number, states: readonly ('member' | 'invited')[] = ['member', 'invited']): number[] {
    return this.d.db
      .all<{ user_id: number; state: 'member' | 'invited' }>('SELECT user_id, state FROM conversation_members WHERE conversation_id = ?', conversationId)
      .filter((r) => states.includes(r.state))
      .map((r) => r.user_id);
  }

  private nudge(userIds: readonly number[]): void {
    for (const id of new Set(userIds)) this.d.publishTo(id, 'pm_changed', {});
  }

  /** Marks messages as read up to `upToId` (the newest one when left out). */
  read(me: User, conversationId: unknown, upToId?: unknown): { ok: true } {
    const id = this.idOf(conversationId, 'conversation');
    const row = this.rowsOf(me, id)[0];
    if (!row || row.state !== 'member') throw new MessageError('no_such_conversation', 'That conversation is not there.', 404);
    const upTo = upToId === undefined || upToId === null ? Number.MAX_SAFE_INTEGER : this.idOf(upToId, 'upToId');
    const newest = this.d.db.get<{ m: number | null }>('SELECT MAX(id) AS m FROM private_messages WHERE conversation_id = ? AND id <= ?', id, upTo)?.m ?? 0;
    this.d.db.run('UPDATE conversation_members SET read_id = MAX(read_id, ?) WHERE conversation_id = ? AND user_id = ?', newest, id, me.id);
    this.d.publishTo(me.id, 'pm_changed', {}); // his other pages catch up
    return { ok: true };
  }

  /** Answers a message request (direct chat) or a group invitation. */
  respond(me: User, conversationId: unknown, answer: unknown): MessagesView {
    const id = this.idOf(conversationId, 'conversation');
    if (answer !== 'accept' && answer !== 'decline') throw new MessageError('bad_request', 'answer must be "accept" or "decline".', 400);
    const row = this.rowsOf(me, id)[0];
    if (!row) throw new MessageError('no_request', 'There is nothing waiting for you there.', 404);
    const now = this.d.now();
    if (row.kind === 'direct') {
      if (row.state !== 'member' || row.request !== 'pending' || row.requester_id === me.id) throw new MessageError('no_request', 'There is no message request from that player.', 404);
      this.d.db.run('UPDATE conversations SET request = ? WHERE id = ?', answer === 'accept' ? 'accepted' : 'declined', id);
      if (answer === 'accept') this.nudge(this.memberIds(id));
      else this.nudge([me.id]);
      return this.view(me);
    }
    if (row.state !== 'invited') throw new MessageError('no_request', 'You are already in that group.', 404);
    if (answer === 'decline') {
      this.d.db.run('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?', id, me.id);
      this.nudge([me.id]);
      return this.view(me);
    }
    this.d.db.tx(() => {
      if (this.groupCount(me.id) >= MAX_GROUPS) throw new MessageError('too_many_groups', `You are in ${MAX_GROUPS} groups, the most there can be. Leave one first.`, 409);
      const newest = this.d.db.get<{ m: number | null }>('SELECT MAX(id) AS m FROM private_messages WHERE conversation_id = ?', id)?.m ?? 0;
      this.d.db.run("UPDATE conversation_members SET state = 'member', joined_ms = ?, since_id = ?, read_id = ? WHERE conversation_id = ? AND user_id = ?", now, newest, newest, id, me.id);
    });
    this.nudge(this.memberIds(id));
    return this.view(me);
  }

  // ---- groups ------------------------------------------------------------------------------------------------------

  private groupCount(userId: number): number {
    return this.d.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM conversation_members cm JOIN conversations c ON c.id = cm.conversation_id WHERE cm.user_id = ? AND cm.state = 'member' AND c.kind = 'group'", userId)?.n ?? 0;
  }

  private cleanTitle(raw: unknown): string {
    if (typeof raw !== 'string') throw new MessageError('bad_request', 'The group needs a name.', 400);
    const title = cleanMessage(raw);
    const length = Array.from(title).length;
    if (length === 0) throw new MessageError('bad_request', 'The group needs a name.', 400);
    if (length > MAX_GROUP_TITLE) throw new MessageError('bad_request', `A group name can be at most ${MAX_GROUP_TITLE} characters.`, 400);
    return title;
  }

  /** The group (as the creator sees it) or an error: only the creator may change a group. */
  private ownGroup(me: User, conversationId: unknown): ConvRow {
    const row = this.rowsOf(me, this.idOf(conversationId, 'conversation'))[0];
    if (!row || row.kind !== 'group' || row.state !== 'member') throw new MessageError('no_such_conversation', 'That group is not there.', 404);
    if (row.created_by !== me.id) throw new MessageError('not_creator', 'Only the player who made the group can do that.', 403);
    return row;
  }

  /** The group (as a member sees it) or an error: any member, not only the creator, may invite his own friends. */
  private memberGroup(me: User, conversationId: unknown): ConvRow {
    const row = this.rowsOf(me, this.idOf(conversationId, 'conversation'))[0];
    if (!row || row.kind !== 'group' || row.state !== 'member') throw new MessageError('no_such_conversation', 'That group is not there.', 404);
    return row;
  }

  private checkCanInvite(me: User, friend: UserLite, conversationId: number | null): void {
    if (!this.areFriends(me.id, friend.id)) throw new MessageError('not_friends', `${friend.displayName} is not your friend. You can only invite your friends.`, 403);
    if (this.d.isBanned(friend.id)) throw new MessageError('no_such_player', `There is no player called "${friend.username}".`, 404);
    const waiting = this.d.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM conversation_members cm JOIN conversations c ON c.id = cm.conversation_id WHERE cm.user_id = ? AND cm.state = 'invited' AND c.kind = 'group'", friend.id)?.n ?? 0;
    if (waiting >= MAX_INVITES_WAITING) throw new MessageError('cannot_message', `${friend.displayName} has too many invitations waiting. Try again later.`, 409);
    if (conversationId !== null && this.d.db.get('SELECT 1 AS x FROM conversation_members WHERE conversation_id = ? AND user_id = ?', conversationId, friend.id)) {
      throw new MessageError('bad_request', `${friend.displayName} is already in the group or has been invited.`, 409);
    }
  }

  /** Makes a group and invites friends to it. The creator is a member at once; the others are invited. */
  createGroup(me: User, input: { title: unknown; usernames: unknown }): { conversation: ConversationView } {
    const you = this.you(me);
    if (!you.canWrite) throw new MessageError('too_new', you.message as string, 403);
    const title = this.cleanTitle(input.title);
    if (!Array.isArray(input.usernames) || input.usernames.length === 0) throw new MessageError('bad_request', 'Pick at least one friend to invite.', 400);
    if (input.usernames.length > MAX_GROUP_MEMBERS - 1) throw new MessageError('group_full', `A group has at most ${MAX_GROUP_MEMBERS} players, you and ${MAX_GROUP_MEMBERS - 1} friends.`, 400);
    const now = this.d.now();
    const friends: UserLite[] = [];
    for (const name of input.usernames) {
      const f = this.findUser(name);
      if (f.id === me.id) throw new MessageError('bad_request', 'You are in the group already.', 400);
      if (!friends.some((x) => x.id === f.id)) friends.push(f);
    }
    const id = this.d.db.tx(() => {
      const made = this.d.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM conversations WHERE kind = 'group' AND created_by = ? AND created_ms > ?", me.id, now - 3_600_000)?.n ?? 0;
      if (made >= GROUPS_PER_HOUR) throw new MessageError('rate_limited', `You have made ${GROUPS_PER_HOUR} groups in the last hour. Wait a while.`, 429);
      if (this.groupCount(me.id) >= MAX_GROUPS) throw new MessageError('too_many_groups', `You are in ${MAX_GROUPS} groups, the most there can be. Leave one first.`, 409);
      for (const f of friends) this.checkCanInvite(me, f, null);
      const convId = this.d.db.run("INSERT INTO conversations(kind, title, created_by, created_ms, last_ms) VALUES ('group', ?, ?, ?, ?)", title, me.id, now, now).lastInsertRowid;
      this.d.db.run("INSERT INTO conversation_members(conversation_id, user_id, state, joined_ms) VALUES (?, ?, 'member', ?)", convId, me.id, now);
      for (const f of friends) this.d.db.run("INSERT INTO conversation_members(conversation_id, user_id, state, invited_by, joined_ms) VALUES (?, ?, 'invited', ?, ?)", convId, f.id, me.id, now);
      return convId;
    });
    this.nudge([me.id, ...friends.map((f) => f.id)]);
    return { conversation: this.viewOf(me, id) as ConversationView };
  }

  /** Invites one more friend of the member who asks (any member of the group, not only its creator). The friend still has to accept. */
  invite(me: User, conversationId: unknown, username: unknown): { conversation: ConversationView } {
    const row = this.memberGroup(me, conversationId);
    const friend = this.findUser(username);
    this.d.db.tx(() => {
      if (this.memberIds(row.id).length >= MAX_GROUP_MEMBERS) throw new MessageError('group_full', `A group has at most ${MAX_GROUP_MEMBERS} players.`, 409);
      this.checkCanInvite(me, friend, row.id);
      this.d.db.run("INSERT INTO conversation_members(conversation_id, user_id, state, invited_by, joined_ms) VALUES (?, ?, 'invited', ?, ?)", row.id, friend.id, me.id, this.d.now());
    });
    this.nudge(this.memberIds(row.id));
    return { conversation: this.viewOf(me, row.id) as ConversationView };
  }

  /** The creator takes a player out of the group, or takes back an invitation. */
  removeMember(me: User, conversationId: unknown, username: unknown): { conversation: ConversationView } {
    const row = this.ownGroup(me, conversationId);
    const target = this.findUserAnyState(username);
    if (target.id === me.id) throw new MessageError('bad_request', 'Use Leave to leave your own group.', 400);
    const before = this.memberIds(row.id);
    const gone = this.d.db.run('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?', row.id, target.id).changes;
    if (gone === 0) throw new MessageError('bad_request', `${target.displayName} is not in that group.`, 404);
    this.nudge(before);
    return { conversation: this.viewOf(me, row.id) as ConversationView };
  }

  /** A player by username who may be banned (to take him out of a group). */
  private findUserAnyState(username: unknown): UserLite {
    if (typeof username !== 'string') throw new MessageError('bad_request', 'username must be the name of a player.', 400);
    const name = cleanName(username);
    const row = name === '' || name.length > 40 ? undefined : this.d.db.get<{ id: number }>('SELECT id FROM users WHERE username = ?', name);
    const user = row ? this.userById(row.id) : undefined;
    if (!user) throw new MessageError('no_such_player', `There is no player called "${name}".`, 404);
    return user;
  }

  /** Leaves a group. If the creator leaves, the member who has been there longest takes over; the last one out closes it. */
  leave(me: User, conversationId: unknown): MessagesView {
    const row = this.rowsOf(me, this.idOf(conversationId, 'conversation'))[0];
    if (!row || row.kind !== 'group') throw new MessageError('no_such_conversation', 'That group is not there.', 404);
    const before = this.memberIds(row.id);
    this.d.db.tx(() => {
      this.d.db.run('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?', row.id, me.id);
      const members = this.d.db.all<{ user_id: number }>("SELECT user_id FROM conversation_members WHERE conversation_id = ? AND state = 'member' ORDER BY joined_ms, user_id", row.id);
      const first = members[0];
      if (!first) {
        this.d.db.run('DELETE FROM conversations WHERE id = ?', row.id);
      } else if (row.created_by === me.id) {
        this.d.db.run('UPDATE conversations SET created_by = ? WHERE id = ?', first.user_id, row.id);
      }
    });
    this.nudge(before);
    return this.view(me);
  }

  rename(me: User, conversationId: unknown, title: unknown): { conversation: ConversationView } {
    const row = this.ownGroup(me, conversationId);
    this.d.db.run('UPDATE conversations SET title = ? WHERE id = ?', this.cleanTitle(title), row.id);
    this.nudge(this.memberIds(row.id));
    return { conversation: this.viewOf(me, row.id) as ConversationView };
  }

  // ---- blocking ----------------------------------------------------------------------------------------------------

  /** Blocks a player: ends the friendship and every challenge and invitation between you; he cannot write to you any more. He is not told. */
  block(me: User, username: unknown): MessagesView {
    const target = this.findUserAnyState(username);
    if (target.id === me.id) throw new MessageError('bad_request', 'That is you.', 400);
    const { db } = this.d;
    db.tx(() => {
      if (!this.hasBlocked(me.id, target.id)) {
        const count = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM blocks WHERE blocker_id = ?', me.id)?.n ?? 0;
        if (count >= MAX_BLOCKS) throw new MessageError('too_many_blocks', `You have blocked ${MAX_BLOCKS} players, the most there can be. Unblock some first.`, 409);
        db.run('INSERT INTO blocks(blocker_id, blocked_id, created_ms) VALUES (?, ?, ?)', me.id, target.id, this.d.now());
      }
      const [a, b] = pair(me.id, target.id);
      db.run('DELETE FROM friendships WHERE user_a = ? AND user_b = ?', a, b);
      db.run('DELETE FROM challenges WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)', me.id, target.id, target.id, me.id);
      // A message request he sent me is answered for good: it leaves my list, and he is not told.
      db.run("UPDATE conversations SET request = 'declined' WHERE kind = 'direct' AND request = 'pending' AND requester_id = ? AND (direct_a = ? OR direct_b = ?)", target.id, me.id, me.id);
      // Group invitations either way.
      db.run("DELETE FROM conversation_members WHERE state = 'invited' AND ((user_id = ? AND invited_by = ?) OR (user_id = ? AND invited_by = ?))", me.id, target.id, target.id, me.id);
    });
    this.d.notifyFriends?.(me.id);
    this.d.notifyChallenges?.(me.id);
    this.nudge([me.id]);
    return this.view(me);
  }

  unblock(me: User, username: unknown): MessagesView {
    const target = this.findUserAnyState(username);
    this.d.db.run('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?', me.id, target.id);
    this.nudge([me.id]);
    return this.view(me);
  }

  // ---- reporting ---------------------------------------------------------------------------------------------------

  /** A player reports a message he can see. The owner then gets that message and the few before it. Reporting it twice changes nothing. */
  report(me: User, messageId: unknown): void {
    const id = this.idOf(messageId, 'messageId');
    const now = this.d.now();
    const msg = this.d.db.get<MessageRow & { author_id: number }>(
      `SELECT m.id, m.conversation_id, m.user_id AS author_id, u.username, u.display_name, ${roleSql('u')} AS role, m.body, m.created_ms
         FROM private_messages m JOIN users u ON u.id = m.user_id JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ? AND cm.state = 'member'
        WHERE m.id = ? AND ${VISIBLE}`,
      me.id,
      id,
      now,
    );
    if (!msg) throw new MessageError('no_such_message', 'That message is gone.', 404);
    if (msg.author_id === me.id) throw new MessageError('bad_request', 'That is your own message.', 400);
    if (msg.role === 'owner') throw new MessageError('bad_request', 'Messages of the owner cannot be reported.', 400);
    const recent = this.d.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM private_reports WHERE reporter_id = ? AND created_ms > ?', me.id, now - 3_600_000)?.n ?? 0;
    if (recent >= PM_REPORTS_PER_HOUR) throw new MessageError('rate_limited', 'You have sent a lot of reports. Wait a while before sending more.', 429);
    const before = this.d.db.all<MessageRow>(
      `SELECT m.id, m.conversation_id, u.username, u.display_name, ${roleSql('u')} AS role, m.body, m.created_ms
         FROM private_messages m JOIN users u ON u.id = m.user_id JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ?
        WHERE m.conversation_id = ? AND m.id < ? AND ${VISIBLE} ORDER BY m.id DESC LIMIT ?`,
      me.id,
      msg.conversation_id,
      id,
      now,
      REPORT_CONTEXT,
    );
    const lines: ReportedLine[] = [...before.reverse(), msg].map((r) => ({ username: r.username, displayName: r.display_name, text: r.body, createdMs: r.created_ms, reported: r.id === id }));
    this.d.db.run(
      'INSERT OR IGNORE INTO private_reports(message_id, conversation_id, reporter_id, author_id, created_ms, context_json) VALUES (?, ?, ?, ?, ?, ?)',
      id,
      msg.conversation_id,
      me.id,
      msg.author_id,
      now,
      JSON.stringify(lines),
    );
  }

  /**
   * The writer deletes a message of his own: it disappears for everybody in the chat. A report already made about it keeps its own copy for the
   * owner. Deleting it twice changes nothing. Somebody else's message cannot be deleted (it can be reported or the player blocked).
   */
  deleteOwn(me: User, messageId: unknown): { ok: true } {
    const id = this.idOf(messageId, 'messageId');
    const msg = this.d.db.get<{ user_id: number; conversation_id: number; deleted_ms: number | null }>(
      `SELECT m.user_id, m.conversation_id, m.deleted_ms FROM private_messages m
         JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ? AND cm.state = 'member'
        WHERE m.id = ?`,
      me.id,
      id,
    );
    if (!msg) throw new MessageError('no_such_message', 'That message is gone.', 404);
    if (msg.user_id !== me.id) throw new MessageError('bad_request', 'You can only delete your own messages.', 403);
    if (msg.deleted_ms !== null) return { ok: true };
    this.d.db.run('UPDATE private_messages SET deleted_ms = ? WHERE id = ? AND deleted_ms IS NULL', this.d.now(), id);
    const members = this.memberIds(msg.conversation_id);
    // Every open page takes that one message off the screen at once (an older one it holds is not found again by a refresh of the newest page).
    for (const member of new Set(members)) this.d.publishTo(member, 'pm_deleted', { conversationId: msg.conversation_id, id });
    this.nudge(members);
    return { ok: true };
  }

  // ---- the owner ---------------------------------------------------------------------------------------------------

  /** The open reports, newest first: only what was reported, never the conversations. */
  adminView(): AdminPrivateView {
    const rows = this.d.db.all<{ message_id: number; conversation_id: number; author_id: number; reporters: number; first_ms: number; first_id: number }>(
      `SELECT message_id, conversation_id, author_id, COUNT(*) AS reporters, MIN(created_ms) AS first_ms, MIN(id) AS first_id
         FROM private_reports WHERE resolved_ms IS NULL GROUP BY message_id ORDER BY first_ms DESC, message_id DESC LIMIT 100`,
    );
    const reports = rows.map((r): PrivateReportEntry => {
      const context = this.d.db.get<{ context_json: string }>('SELECT context_json FROM private_reports WHERE id = ?', r.first_id)?.context_json ?? '[]';
      const author = this.userById(r.author_id);
      const conv = this.d.db.get<{ kind: 'direct' | 'group'; title: string | null }>('SELECT kind, title FROM conversations WHERE id = ?', r.conversation_id);
      const open = this.d.db.get<{ n: number }>('SELECT COUNT(DISTINCT message_id) AS n FROM private_reports WHERE author_id = ? AND resolved_ms IS NULL', r.author_id)?.n ?? 0;
      return {
        messageId: r.message_id,
        kind: conv?.kind ?? null,
        groupTitle: conv?.kind === 'group' ? conv.title : null,
        author: author ? { username: author.username, displayName: author.displayName, role: author.role } : { username: '(gone)', displayName: '(gone)', role: 'player' },
        reporters: r.reporters,
        firstReportedMs: r.first_ms,
        lines: JSON.parse(context) as ReportedLine[],
        authorOpenReports: open,
      };
    });
    return { reports };
  }

  /** Closes the reports about a message. */
  dismiss(admin: User, input: { requestId: unknown; messageId: unknown }): { ok: true; duplicate: boolean } {
    const id = this.idOf(input.messageId, 'messageId');
    if (!this.d.db.get('SELECT 1 AS x FROM private_reports WHERE message_id = ?', id)) throw new MessageError('no_such_message', 'There is no report about that message.', 404);
    let duplicate = false;
    this.d.db.tx(() => {
      if (!this.d.audit(admin, input.requestId, 'pm_dismiss', `message ${id}`, { messageId: id })) {
        duplicate = true;
        return;
      }
      this.d.db.run('UPDATE private_reports SET resolved_ms = ? WHERE message_id = ? AND resolved_ms IS NULL', this.d.now(), id);
    });
    return { ok: true, duplicate };
  }
}
