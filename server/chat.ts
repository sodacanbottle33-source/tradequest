// The public chat room (docs/world.md §15): one room that every signed-in player can read and write in.
//
// Everything that keeps it usable is decided here, on the server:
//   • a message is one line of plain text, at most CHAT_MAX_LENGTH characters. It is shown as text, never as a page: no markup, no links are
//     made clickable, and hidden direction/zero-width characters are stripped, so nobody can disguise a message;
//   • spam is slowed down for everybody: a pause between messages, a limit per half minute, and the same message cannot be sent twice in a row;
//   • a brand-new account can read at once but writes only after NEW_ACCOUNT_WAIT_MS (the owner is exempt), so a fresh account cannot be made
//     just to spam;
//   • players can report a message; the owner sees the open reports in the admin panel, and can delete a message, mute a player for a while,
//     ban a player from the chat, or lift either. Each of those is written once to the admin log. Muting and banning never touch playing.
// Only the newest CHAT_KEEP messages are kept.

import type { User } from './auth';
import { cleanName } from './social';
import type { Logger } from './log';
import type { Db } from './sqlite';

export const CHAT_MAX_LENGTH = 300;
/** How many messages the chat shows when it opens (at most CHAT_PAGE_MAX when asked for more). */
export const CHAT_PAGE = 50;
export const CHAT_PAGE_MAX = 100;
/** How many messages are kept in all; older ones are deleted. */
export const CHAT_KEEP = 2000;
/** A new account can write this long after it was made. */
export const NEW_ACCOUNT_WAIT_MS = 5 * 60_000;
/** The shortest time between two messages of one player. */
export const MIN_GAP_MS = 1_500;
/** At most CHAT_BURST messages in CHAT_BURST_MS. */
export const CHAT_BURST = 8;
export const CHAT_BURST_MS = 30_000;
/** The same text is refused again for this long. */
export const REPEAT_MS = 60_000;
/** The most reports one player can send in an hour. */
export const REPORTS_PER_HOUR = 20;
/** The longest mute: 30 days. */
export const MAX_MUTE_MINUTES = 60 * 24 * 30;

export class ChatError extends Error {
  constructor(
    readonly code:
      | 'too_new'
      | 'muted'
      | 'chat_banned'
      | 'empty'
      | 'too_long'
      | 'too_fast'
      | 'repeat'
      | 'bad_request'
      | 'no_such_message'
      | 'no_such_player'
      | 'rate_limited'
      | 'cannot_moderate_owner'
      | 'already_banned'
      | 'not_restricted',
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface ChatMessage {
  readonly id: number;
  readonly username: string;
  readonly displayName: string;
  readonly role: 'player' | 'owner';
  readonly text: string;
  readonly createdMs: number;
}

/** Whether the player can write right now, and if not, why and until when. */
export interface ChatYou {
  readonly canWrite: boolean;
  readonly reason: 'new_account' | 'muted' | 'banned' | null;
  /** When writing opens up again (null for a ban, and when the player can write now). */
  readonly untilMs: number | null;
  readonly message: string | null;
}

export interface ChatView {
  /** Oldest first. */
  readonly messages: readonly ChatMessage[];
  /** True when there are older messages than the first one shown. */
  readonly more: boolean;
  readonly you: ChatYou;
  readonly limits: { readonly maxLength: number; readonly minGapMs: number };
}

export interface ChatReportEntry {
  readonly messageId: number;
  readonly text: string;
  readonly username: string;
  readonly displayName: string;
  readonly createdMs: number;
  readonly reporters: number;
  readonly firstReportedMs: number;
  /** The author's chat restriction right now, if any. */
  readonly restriction: 'mute' | 'ban' | null;
}

export interface ChatRestrictionEntry {
  readonly username: string;
  readonly displayName: string;
  readonly kind: 'mute' | 'ban';
  readonly untilMs: number | null;
  readonly reason: string;
  readonly sinceMs: number;
  readonly by: string;
}

export interface AdminChatView {
  readonly reports: readonly ChatReportEntry[];
  readonly restricted: readonly ChatRestrictionEntry[];
}

export interface ChatDeps {
  readonly db: Db;
  readonly log: Logger;
  readonly now: () => number;
  /** Sends an event to every signed-in page. */
  readonly publish: (event: string, data: unknown) => void;
  /** Sends an event to one player's pages. */
  readonly publishTo: (userId: number, event: string, data: unknown) => void;
  /** Writes one moderation action to the admin log. False when that requestId was already used for the same action (do nothing again). */
  readonly audit: (admin: User, requestId: unknown, action: 'chat_delete' | 'chat_mute' | 'chat_ban' | 'chat_lift' | 'chat_dismiss', target: string, detail: Record<string, unknown>) => boolean;
}

interface MessageRow {
  id: number;
  username: string;
  display_name: string;
  role: 'player' | 'owner';
  body: string;
  created_ms: number;
}

interface Restriction {
  readonly kind: 'mute' | 'ban';
  readonly untilMs: number | null;
  readonly reason: string;
}

// Control characters, direction overrides and invisible spaces (but not the joiners that emoji need).
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\x00-\x1f\x7f-\x9f\u{61c}\u{200b}\u{200e}\u{200f}\u{2028}-\u{202e}\u{2060}\u{2066}-\u{2069}\u{feff}]+/gu;

/** What a typed message becomes: one line, single spaces, nothing hidden. */
export function cleanMessage(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim();
}

/** "3 minutes", "less than a minute", "2 hours", "5 days": how long a wait still is. */
export function waitText(ms: number): string {
  if (ms < 60_000) return 'less than a minute';
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 120) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) return `${hours} hours`;
  return `${Math.ceil(hours / 24)} days`;
}

function cleanReason(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new ChatError('bad_request', 'The reason must be text.', 400);
  const text = cleanMessage(value);
  if (text.length > 120) throw new ChatError('bad_request', 'The reason can be at most 120 characters.', 400);
  return text;
}

export class Chat {
  constructor(private readonly d: ChatDeps) {}

  // ---- reading -----------------------------------------------------------------------------------------------------

  private restriction(userId: number): Restriction | null {
    const row = this.d.db.get<{ kind: 'mute' | 'ban'; until_ms: number | null; reason: string }>('SELECT kind, until_ms, reason FROM chat_restrictions WHERE user_id = ?', userId);
    if (!row) return null;
    if (row.kind === 'mute' && (row.until_ms as number) <= this.d.now()) {
      this.d.db.run("DELETE FROM chat_restrictions WHERE user_id = ? AND kind = 'mute' AND until_ms <= ?", userId, this.d.now());
      return null;
    }
    return { kind: row.kind, untilMs: row.until_ms, reason: row.reason };
  }

  /** Whether the player can write now (and the words that say why not). */
  you(me: User): ChatYou {
    const now = this.d.now();
    const r = this.restriction(me.id);
    if (r?.kind === 'ban') return { canWrite: false, reason: 'banned', untilMs: null, message: 'The owner has stopped you from writing in the chat. You can still read it and play.' };
    if (r) return { canWrite: false, reason: 'muted', untilMs: r.untilMs, message: `You are muted for another ${waitText((r.untilMs as number) - now)}. You can still read the chat and play.` };
    if (me.role !== 'owner' && me.createdMs + NEW_ACCOUNT_WAIT_MS > now) {
      const until = me.createdMs + NEW_ACCOUNT_WAIT_MS;
      return { canWrite: false, reason: 'new_account', untilMs: until, message: `New accounts can write in the chat after ${Math.round(NEW_ACCOUNT_WAIT_MS / 60_000)} minutes. You can write in ${waitText(until - now)}. Reading is open now.` };
    }
    return { canWrite: true, reason: null, untilMs: null, message: null };
  }

  private toMessage(r: MessageRow): ChatMessage {
    return { id: r.id, username: r.username, displayName: r.display_name, role: r.role, text: r.body, createdMs: r.created_ms };
  }

  /** The newest messages (oldest first), or the page before `beforeId`. Messages of players the owner banned from the game are left out. */
  recent(me: User, beforeId?: number, limit = CHAT_PAGE): ChatView {
    const size = Math.min(Math.max(1, Math.floor(limit) || CHAT_PAGE), CHAT_PAGE_MAX);
    const now = this.d.now();
    const rows = this.d.db.all<MessageRow>(
      `SELECT m.id, u.username, u.display_name, u.role, m.body, m.created_ms
         FROM chat_messages m JOIN users u ON u.id = m.user_id
        WHERE m.deleted_ms IS NULL ${beforeId === undefined ? '' : 'AND m.id < ?'}
          AND NOT EXISTS (SELECT 1 FROM user_bans b WHERE b.user_id = m.user_id AND (b.until_ms IS NULL OR b.until_ms > ?))
        ORDER BY m.id DESC LIMIT ?`,
      ...(beforeId === undefined ? [now, size + 1] : [beforeId, now, size + 1]),
    );
    const more = rows.length > size;
    const shown = rows.slice(0, size).reverse().map((r) => this.toMessage(r));
    return { messages: shown, more, you: this.you(me), limits: { maxLength: CHAT_MAX_LENGTH, minGapMs: MIN_GAP_MS } };
  }

  // ---- writing -----------------------------------------------------------------------------------------------------

  /** Posts a message. Throws ChatError with the reason when the player cannot write or writes too much. */
  send(me: User, raw: unknown): ChatMessage {
    const now = this.d.now();
    const you = this.you(me);
    if (!you.canWrite) throw new ChatError(you.reason === 'banned' ? 'chat_banned' : you.reason === 'muted' ? 'muted' : 'too_new', you.message as string, 403);
    if (typeof raw !== 'string') throw new ChatError('bad_request', 'The message must be text.', 400);
    const text = cleanMessage(raw);
    if (text === '') throw new ChatError('empty', 'Type a message first.', 400);
    if (Array.from(text).length > CHAT_MAX_LENGTH) throw new ChatError('too_long', `Messages can be at most ${CHAT_MAX_LENGTH} characters. Yours is ${Array.from(text).length}.`, 400);
    const mine = this.d.db.all<{ body: string; created_ms: number }>('SELECT body, created_ms FROM chat_messages WHERE user_id = ? AND created_ms > ? ORDER BY id DESC LIMIT ?', me.id, now - CHAT_BURST_MS, CHAT_BURST);
    const last = mine[0];
    if (last && now - last.created_ms < MIN_GAP_MS) throw new ChatError('too_fast', 'Slow down: wait a moment between messages.', 429);
    if (mine.length >= CHAT_BURST) throw new ChatError('too_fast', 'You are writing too fast. Wait a few seconds.', 429);
    if (last && last.body.toLowerCase() === text.toLowerCase() && now - last.created_ms < REPEAT_MS) throw new ChatError('repeat', 'You just sent that. Write something different.', 400);
    const id = this.d.db.tx(() => {
      const newId = this.d.db.run('INSERT INTO chat_messages(user_id, body, created_ms) VALUES (?, ?, ?)', me.id, text, now).lastInsertRowid;
      this.d.db.run('DELETE FROM chat_messages WHERE id <= ?', newId - CHAT_KEEP);
      return newId;
    });
    const message: ChatMessage = { id, username: me.username, displayName: me.displayName, role: me.role, text, createdMs: now };
    this.d.publish('chat', { message });
    return message;
  }

  /** A player reports a message for the owner to look at. Reporting the same message twice changes nothing. */
  report(me: User, messageId: unknown): void {
    const id = this.messageId(messageId);
    const now = this.d.now();
    const msg = this.d.db.get<{ user_id: number; role: 'player' | 'owner' }>('SELECT m.user_id, u.role FROM chat_messages m JOIN users u ON u.id = m.user_id WHERE m.id = ? AND m.deleted_ms IS NULL', id);
    if (!msg) throw new ChatError('no_such_message', 'That message is gone.', 404);
    if (msg.user_id === me.id) throw new ChatError('bad_request', 'That is your own message.', 400);
    if (msg.role === 'owner') throw new ChatError('bad_request', 'Messages of the owner cannot be reported.', 400);
    const recent = this.d.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM chat_reports WHERE reporter_id = ? AND created_ms > ?', me.id, now - 3_600_000)?.n ?? 0;
    if (recent >= REPORTS_PER_HOUR) throw new ChatError('rate_limited', 'You have sent a lot of reports. Wait a while before sending more.', 429);
    this.d.db.run('INSERT OR IGNORE INTO chat_reports(message_id, reporter_id, created_ms) VALUES (?, ?, ?)', id, me.id, now);
  }

  /**
   * A player deletes a message he wrote himself: it disappears for everybody. If other players had reported it, the owner still sees those
   * reports (with the text) until he closes them, so deleting a message does not make a rule-breaker disappear from his list.
   * Somebody else's message cannot be deleted by a player (the owner uses his own tool). Deleting it twice changes nothing.
   */
  removeOwn(me: User, messageId: unknown): { ok: true } {
    const id = this.messageId(messageId);
    const msg = this.d.db.get<{ user_id: number; deleted_ms: number | null }>('SELECT user_id, deleted_ms FROM chat_messages WHERE id = ?', id);
    if (!msg) throw new ChatError('no_such_message', 'That message is gone.', 404);
    if (msg.user_id !== me.id) throw new ChatError('bad_request', 'You can only delete your own messages.', 403);
    if (msg.deleted_ms !== null) return { ok: true };
    this.d.db.run('UPDATE chat_messages SET deleted_ms = ?, deleted_by = ? WHERE id = ? AND deleted_ms IS NULL', this.d.now(), me.id, id);
    this.d.publish('chat_removed', { id });
    return { ok: true };
  }

  private messageId(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new ChatError('bad_request', 'messageId must be the number of a message.', 400);
    return value;
  }

  // ---- the owner's tools -------------------------------------------------------------------------------------------

  private playerOf(username: unknown): { id: number; username: string; displayName: string; role: 'player' | 'owner' } {
    const name = cleanName(username);
    const row = name === '' || name.length > 40 ? undefined : this.d.db.get<{ id: number; username: string; display_name: string; role: 'player' | 'owner' }>('SELECT id, username, display_name, role FROM users WHERE username = ?', name);
    if (!row) throw new ChatError('no_such_player', 'There is no player with that username.', 404);
    return { id: row.id, username: row.username, displayName: row.display_name, role: row.role };
  }

  /** Removes a message for everybody and closes the reports about it. */
  remove(admin: User, input: { requestId: unknown; messageId: unknown }): { ok: true; duplicate: boolean } {
    const id = this.messageId(input.messageId);
    const msg = this.d.db.get<{ deleted_ms: number | null; username: string }>('SELECT m.deleted_ms, u.username FROM chat_messages m JOIN users u ON u.id = m.user_id WHERE m.id = ?', id);
    if (!msg) throw new ChatError('no_such_message', 'That message is gone.', 404);
    const now = this.d.now();
    let duplicate = false;
    this.d.db.tx(() => {
      if (!this.d.audit(admin, input.requestId, 'chat_delete', `message ${id}`, { messageId: id, author: msg.username })) {
        duplicate = true;
        return;
      }
      this.d.db.run('UPDATE chat_messages SET deleted_ms = ?, deleted_by = ? WHERE id = ? AND deleted_ms IS NULL', now, admin.id, id);
      this.d.db.run('UPDATE chat_reports SET resolved_ms = ? WHERE message_id = ? AND resolved_ms IS NULL', now, id);
    });
    if (!duplicate && msg.deleted_ms === null) this.d.publish('chat_removed', { id });
    return { ok: true, duplicate };
  }

  /** Closes the reports about a message without removing it. */
  dismiss(admin: User, input: { requestId: unknown; messageId: unknown }): { ok: true; duplicate: boolean } {
    const id = this.messageId(input.messageId);
    if (!this.d.db.get('SELECT 1 AS x FROM chat_messages WHERE id = ?', id)) throw new ChatError('no_such_message', 'That message is gone.', 404);
    let duplicate = false;
    this.d.db.tx(() => {
      if (!this.d.audit(admin, input.requestId, 'chat_dismiss', `message ${id}`, { messageId: id })) {
        duplicate = true;
        return;
      }
      this.d.db.run('UPDATE chat_reports SET resolved_ms = ? WHERE message_id = ? AND resolved_ms IS NULL', this.d.now(), id);
    });
    return { ok: true, duplicate };
  }

  /** Stops a player from writing for `minutes`. He can still read and play. */
  mute(admin: User, input: { requestId: unknown; username: unknown; minutes: unknown; reason?: unknown }): { ok: true; duplicate: boolean; username: string; untilMs: number } {
    const target = this.playerOf(input.username);
    if (target.role === 'owner' || target.id === admin.id) throw new ChatError('cannot_moderate_owner', 'The owner cannot be muted.', 400);
    const minutes = input.minutes;
    if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 || minutes > MAX_MUTE_MINUTES) {
      throw new ChatError('bad_request', `A mute lasts a whole number of minutes, from 1 to ${MAX_MUTE_MINUTES.toLocaleString('en-US')} (30 days). For longer, ban the player from the chat.`, 400);
    }
    const reason = cleanReason(input.reason);
    if (this.restriction(target.id)?.kind === 'ban') throw new ChatError('already_banned', `${target.displayName} is banned from the chat. Lift that first if you want a timed mute instead.`, 409);
    const now = this.d.now();
    const untilMs = now + minutes * 60_000;
    let duplicate = false;
    this.d.db.tx(() => {
      if (!this.d.audit(admin, input.requestId, 'chat_mute', target.username, { minutes, reason, untilMs })) {
        duplicate = true;
        return;
      }
      this.d.db.run(
        "INSERT INTO chat_restrictions(user_id, kind, until_ms, reason, created_ms, by_user_id) VALUES (?, 'mute', ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET kind = 'mute', until_ms = excluded.until_ms, reason = excluded.reason, created_ms = excluded.created_ms, by_user_id = excluded.by_user_id",
        target.id,
        untilMs,
        reason,
        now,
        admin.id,
      );
    });
    if (!duplicate) this.d.publishTo(target.id, 'chat_status', {});
    return { ok: true, duplicate, username: target.username, untilMs };
  }

  /** Stops a player from writing until the owner lifts it. */
  ban(admin: User, input: { requestId: unknown; username: unknown; reason?: unknown }): { ok: true; duplicate: boolean; username: string } {
    const target = this.playerOf(input.username);
    if (target.role === 'owner' || target.id === admin.id) throw new ChatError('cannot_moderate_owner', 'The owner cannot be banned from the chat.', 400);
    const reason = cleanReason(input.reason);
    const now = this.d.now();
    let duplicate = false;
    this.d.db.tx(() => {
      if (!this.d.audit(admin, input.requestId, 'chat_ban', target.username, { reason })) {
        duplicate = true;
        return;
      }
      this.d.db.run(
        "INSERT INTO chat_restrictions(user_id, kind, until_ms, reason, created_ms, by_user_id) VALUES (?, 'ban', NULL, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET kind = 'ban', until_ms = NULL, reason = excluded.reason, created_ms = excluded.created_ms, by_user_id = excluded.by_user_id",
        target.id,
        reason,
        now,
        admin.id,
      );
    });
    if (!duplicate) this.d.publishTo(target.id, 'chat_status', {});
    return { ok: true, duplicate, username: target.username };
  }

  /** Lets a muted or banned player write again. */
  lift(admin: User, input: { requestId: unknown; username: unknown }): { ok: true; duplicate: boolean; username: string } {
    const target = this.playerOf(input.username);
    let duplicate = false;
    this.d.db.tx(() => {
      if (!this.d.audit(admin, input.requestId, 'chat_lift', target.username, {})) {
        duplicate = true;
        return;
      }
      if (this.d.db.run('DELETE FROM chat_restrictions WHERE user_id = ?', target.id).changes === 0) throw new ChatError('not_restricted', `${target.displayName} is not muted or banned from the chat.`, 400);
    });
    if (!duplicate) this.d.publishTo(target.id, 'chat_status', {});
    return { ok: true, duplicate, username: target.username };
  }

  /** What the admin panel shows: the open reports (newest first) and everybody who is muted or banned right now. */
  adminView(): AdminChatView {
    const now = this.d.now();
    this.d.db.run("DELETE FROM chat_restrictions WHERE kind = 'mute' AND until_ms <= ?", now);
    const reports = this.d.db.all<{ message_id: number; body: string; created_ms: number; username: string; display_name: string; reporters: number; first_ms: number; kind: 'mute' | 'ban' | null }>(
      `SELECT m.id AS message_id, m.body, m.created_ms, u.username, u.display_name, COUNT(r.id) AS reporters, MIN(r.created_ms) AS first_ms, cr.kind
         FROM chat_reports r JOIN chat_messages m ON m.id = r.message_id JOIN users u ON u.id = m.user_id LEFT JOIN chat_restrictions cr ON cr.user_id = u.id
        WHERE r.resolved_ms IS NULL AND (m.deleted_ms IS NULL OR m.deleted_by = m.user_id)
        GROUP BY m.id ORDER BY first_ms DESC, m.id DESC LIMIT 100`,
    );
    const restricted = this.d.db.all<{ username: string; display_name: string; kind: 'mute' | 'ban'; until_ms: number | null; reason: string; created_ms: number; by: string }>(
      `SELECT u.username, u.display_name, cr.kind, cr.until_ms, cr.reason, cr.created_ms, b.username AS by
         FROM chat_restrictions cr JOIN users u ON u.id = cr.user_id JOIN users b ON b.id = cr.by_user_id ORDER BY cr.created_ms DESC LIMIT 200`,
    );
    return {
      reports: reports.map((r) => ({ messageId: r.message_id, text: r.body, username: r.username, displayName: r.display_name, createdMs: r.created_ms, reporters: r.reporters, firstReportedMs: r.first_ms, restriction: r.kind })),
      restricted: restricted.map((r) => ({ username: r.username, displayName: r.display_name, kind: r.kind, untilMs: r.until_ms, reason: r.reason, sinceMs: r.created_ms, by: r.by })),
    };
  }
}
