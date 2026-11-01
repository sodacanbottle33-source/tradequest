// Comments on companies (docs/world.md §40): every stock and every memecoin, the ones that were here from the start, the ones the owner made and the ones players
// launched, has its own comment section. A player writes a short comment, answers somebody else's comment (one level of answers), and likes comments.
//
// Everything that keeps it usable is decided here, on the server, in the same spirit as the public chat room (server/chat.ts):
//   • a comment is one line of plain text, at most COMMENT_MAX_LENGTH characters. It is shown as text, never as a page: no markup, no links are made clickable,
//     and hidden direction/zero-width characters are stripped;
//   • anybody can read; only a signed-in player can write, answer, like and report;
//   • spam is slowed down: a pause between comments (COMMENT_GAP_MS), a cap per day for every player, and the same text cannot be written again for a while;
//   • a player who is muted or banned from the chat (the owner's and the moderators' existing tools) cannot write comments either, but can still read and like;
//   • players can report a comment; the owner and the moderators see the open reports on the admin Chat tab and can delete a comment or close the report. Each of
//     those is written once to the admin log. A moderator works on ordinary players only (never on the owner's or another moderator's comments);
//   • a player can delete his own comment; an answer disappears when the comment it answers is deleted;
//   • only the newest COMMENT_KEEP_PER_COMPANY comments of a company are kept (their answers and likes go with them).
// Comments never touch money, prices or the market.

import { roleSql, type Role, type User } from './auth';
import { cleanMessage, waitText } from './chat';
import type { Logger } from './log';
import type { Db } from './sqlite';

export const COMMENT_MAX_LENGTH = 300;
/** How many comments a company page shows when it opens (at most COMMENT_PAGE_MAX when asked for more). */
export const COMMENT_PAGE = 20;
export const COMMENT_PAGE_MAX = 40;
/** The shortest time between two comments (or answers) of one player. */
export const COMMENT_GAP_MS = 15_000;
/** The most comments and answers one player can write in 24 hours. */
export const COMMENTS_PER_DAY = 60;
/** The same text is refused again for this long. */
export const COMMENT_REPEAT_MS = 10 * 60_000;
/** The newest comments of one company that are kept (answers and likes go with them). */
export const COMMENT_KEEP_PER_COMPANY = 300;
/** The most answers one comment takes. */
export const REPLIES_MAX = 50;
/** The most comment reports one player can send in an hour. */
export const COMMENT_REPORTS_PER_HOUR = 20;
/** How many of the newest comments of the whole market the "Recent comments" list shows. */
export const RECENT_DEFAULT = 20;
export const RECENT_MAX = 50;

export class CommentError extends Error {
  constructor(
    readonly code:
      | 'signed_out'
      | 'muted'
      | 'chat_banned'
      | 'empty'
      | 'too_long'
      | 'too_fast'
      | 'daily_cap'
      | 'repeat'
      | 'thread_full'
      | 'bad_request'
      | 'no_such_company'
      | 'no_such_comment'
      | 'rate_limited'
      | 'cannot_moderate_staff',
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** One comment or answer as the page shows it. */
export interface CommentLine {
  readonly id: number;
  readonly username: string;
  readonly displayName: string;
  readonly role: Role;
  readonly text: string;
  readonly createdMs: number;
  readonly likes: number;
  /** The viewer liked it (always false when signed out). */
  readonly liked: boolean;
  /** The viewer wrote it. */
  readonly mine: boolean;
}

export interface CommentItem extends CommentLine {
  /** The answers to it, oldest first. */
  readonly replies: readonly CommentLine[];
}

/** Whether the viewer can write right now, and if not, why and until when. */
export interface CommentYou {
  readonly canWrite: boolean;
  readonly reason: 'signed_out' | 'muted' | 'banned' | null;
  readonly untilMs: number | null;
  readonly message: string | null;
}

export interface CommentsView {
  readonly ticker: string;
  readonly name: string;
  /** Newest first. */
  readonly comments: readonly CommentItem[];
  /** True when there are older comments than the last one shown. */
  readonly more: boolean;
  /** All comments and answers on this company that anybody can see. */
  readonly total: number;
  readonly you: CommentYou;
  readonly limits: { readonly maxLength: number; readonly gapMs: number };
}

/** One line of the market-wide "Recent comments" list. */
export interface RecentComment {
  readonly id: number;
  readonly ticker: string;
  readonly company: string;
  readonly username: string;
  readonly displayName: string;
  readonly role: Role;
  readonly text: string;
  readonly createdMs: number;
  readonly likes: number;
  /** True for an answer to another comment. */
  readonly reply: boolean;
}

export interface CommentReportEntry {
  readonly commentId: number;
  readonly ticker: string;
  readonly text: string;
  readonly username: string;
  readonly displayName: string;
  readonly createdMs: number;
  readonly reporters: number;
  readonly firstReportedMs: number;
  /** The author's chat restriction right now, if any (it stops comments too). */
  readonly restriction: 'mute' | 'ban' | null;
}

export interface AdminCommentsView {
  readonly reports: readonly CommentReportEntry[];
}

export interface CommentsDeps {
  readonly db: Db;
  readonly log: Logger;
  readonly now: () => number;
  /** Writes one moderation action to the admin log. False when that requestId was already used for the same action (do nothing again). */
  readonly audit: (admin: User, requestId: unknown, action: 'comment_delete' | 'comment_dismiss', target: string, detail: Record<string, unknown>) => boolean;
}

interface LineRow {
  id: number;
  parent_id: number | null;
  user_id: number;
  username: string;
  display_name: string;
  role: Role;
  body: string;
  created_ms: number;
  likes: number;
  liked: number;
}

/** SQL that is true for a comment whose writer is not banned from the game (those comments are hidden, as in the chat). `c` is company_comments; one `?` = now. */
const NOT_BANNED = "NOT EXISTS (SELECT 1 FROM user_bans b WHERE b.user_id = c.user_id AND (b.until_ms IS NULL OR b.until_ms > ?))";
/** SQL that is true for a top-level comment, or for an answer whose comment is still visible (not deleted, its writer not banned from the game). `c` is the answer; one `?` = now. */
const PARENT_VISIBLE = `(c.parent_id IS NULL OR EXISTS (SELECT 1 FROM company_comments p WHERE p.id = c.parent_id AND p.deleted_ms IS NULL
  AND NOT EXISTS (SELECT 1 FROM user_bans b WHERE b.user_id = p.user_id AND (b.until_ms IS NULL OR b.until_ms > ?))))`;
/** The columns of one line; the first `?` is the viewer's id (0 when signed out). */
const LINE_COLUMNS = `c.id, c.parent_id, c.user_id, u.username, u.display_name, ${roleSql('u')} AS role, c.body, c.created_ms,
  (SELECT COUNT(*) FROM comment_likes l WHERE l.comment_id = c.id) AS likes,
  EXISTS (SELECT 1 FROM comment_likes l WHERE l.comment_id = c.id AND l.user_id = ?) AS liked`;

export class Comments {
  constructor(private readonly d: CommentsDeps) {}

  // ---- reading -----------------------------------------------------------------------------------------------------

  private company(tickerRaw: unknown): { id: number; ticker: string; name: string } {
    const ticker = typeof tickerRaw === 'string' ? tickerRaw.trim().toUpperCase() : '';
    const row = ticker === '' || ticker.length > 16 ? undefined : this.d.db.get<{ id: number; ticker: string; name: string }>('SELECT id, ticker, name FROM companies WHERE ticker = ?', ticker);
    if (!row) throw new CommentError('no_such_company', 'There is no company with that ticker.', 404);
    return row;
  }

  private restriction(userId: number): { kind: 'mute' | 'ban'; untilMs: number | null } | null {
    const row = this.d.db.get<{ kind: 'mute' | 'ban'; until_ms: number | null }>('SELECT kind, until_ms FROM chat_restrictions WHERE user_id = ?', userId);
    if (!row) return null;
    if (row.kind === 'mute' && (row.until_ms as number) <= this.d.now()) return null;
    return { kind: row.kind, untilMs: row.until_ms };
  }

  /** Whether the viewer can write now (and the words that say why not). Signed-out visitors can only read. */
  you(me: User | null): CommentYou {
    if (me === null) return { canWrite: false, reason: 'signed_out', untilMs: null, message: 'Sign in on the My account tab to write a comment. Reading is open to everybody.' };
    const r = this.restriction(me.id);
    if (r?.kind === 'ban') return { canWrite: false, reason: 'banned', untilMs: null, message: 'The owner has stopped you from writing in the chat and in comments. You can still read them and play.' };
    if (r) return { canWrite: false, reason: 'muted', untilMs: r.untilMs, message: `You are muted for another ${waitText((r.untilMs as number) - this.d.now())}. You can still read comments and play.` };
    return { canWrite: true, reason: null, untilMs: null, message: null };
  }

  private toLine(r: LineRow, viewerId: number): CommentLine {
    return { id: r.id, username: r.username, displayName: r.display_name, role: r.role, text: r.body, createdMs: r.created_ms, likes: r.likes, liked: r.liked === 1, mine: r.user_id === viewerId };
  }

  /** The comments of one company, newest first, with their answers (oldest first), or the page after `beforeId`. Comments of players the owner banned from the game are left out. */
  list(me: User | null, tickerRaw: unknown, beforeId?: number, limit = COMMENT_PAGE): CommentsView {
    const company = this.company(tickerRaw);
    const size = Math.min(Math.max(1, Math.floor(limit) || COMMENT_PAGE), COMMENT_PAGE_MAX);
    const now = this.d.now();
    const viewer = me?.id ?? 0;
    const tops = this.d.db.all<LineRow>(
      `SELECT ${LINE_COLUMNS}
         FROM company_comments c JOIN users u ON u.id = c.user_id
        WHERE c.company_id = ? AND c.parent_id IS NULL AND c.deleted_ms IS NULL ${beforeId === undefined ? '' : 'AND c.id < ?'} AND ${NOT_BANNED}
        ORDER BY c.id DESC LIMIT ?`,
      ...(beforeId === undefined ? [viewer, company.id, now, size + 1] : [viewer, company.id, beforeId, now, size + 1]),
    );
    const more = tops.length > size;
    const shown = tops.slice(0, size);
    const answers = shown.length === 0
      ? []
      : this.d.db.all<LineRow>(
          `SELECT ${LINE_COLUMNS}
             FROM company_comments c JOIN users u ON u.id = c.user_id
            WHERE c.parent_id IN (${shown.map(() => '?').join(', ')}) AND c.deleted_ms IS NULL AND ${NOT_BANNED}
            ORDER BY c.id ASC`,
          viewer,
          ...shown.map((r) => r.id),
          now,
        );
    const byParent = new Map<number, CommentLine[]>();
    for (const a of answers) {
      const list = byParent.get(a.parent_id as number) ?? [];
      list.push(this.toLine(a, viewer));
      byParent.set(a.parent_id as number, list);
    }
    const total = this.d.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM company_comments c
        WHERE c.company_id = ? AND c.deleted_ms IS NULL AND ${NOT_BANNED} AND ${PARENT_VISIBLE}`,
      company.id,
      now,
      now,
    )?.n ?? 0;
    return {
      ticker: company.ticker,
      name: company.name,
      comments: shown.map((r) => ({ ...this.toLine(r, viewer), replies: byParent.get(r.id) ?? [] })),
      more,
      total,
      you: this.you(me),
      limits: { maxLength: COMMENT_MAX_LENGTH, gapMs: COMMENT_GAP_MS },
    };
  }

  /** The newest comments and answers of the whole market (newest first), with the company each one is about. */
  recent(limit = RECENT_DEFAULT): RecentComment[] {
    const size = Math.min(Math.max(1, Math.floor(limit) || RECENT_DEFAULT), RECENT_MAX);
    const rows = this.d.db.all<LineRow & { ticker: string; company: string }>(
      `SELECT ${LINE_COLUMNS}, co.ticker AS ticker, co.name AS company
         FROM company_comments c JOIN users u ON u.id = c.user_id JOIN companies co ON co.id = c.company_id
        WHERE c.deleted_ms IS NULL AND ${NOT_BANNED} AND ${PARENT_VISIBLE}
        ORDER BY c.id DESC LIMIT ?`,
      0,
      this.d.now(),
      this.d.now(),
      size,
    );
    return rows.map((r) => ({ id: r.id, ticker: r.ticker, company: r.company, username: r.username, displayName: r.display_name, role: r.role, text: r.body, createdMs: r.created_ms, likes: r.likes, reply: r.parent_id !== null }));
  }

  // ---- writing -----------------------------------------------------------------------------------------------------

  private commentId(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new CommentError('bad_request', 'commentId must be the number of a comment.', 400);
    return value;
  }

  /**
   * Writes a comment on a company, or an answer to a comment (`parentId`). An answer to an answer is added to the comment at the top of that thread
   * (there is one level of answers). Throws CommentError with the reason when the player cannot write or writes too much.
   */
  post(me: User, tickerRaw: unknown, raw: unknown, parentId?: unknown): CommentLine {
    const you = this.you(me);
    if (!you.canWrite) throw new CommentError(you.reason === 'banned' ? 'chat_banned' : 'muted', you.message as string, 403);
    if (typeof raw !== 'string') throw new CommentError('bad_request', 'The comment must be text.', 400);
    const text = cleanMessage(raw);
    if (text === '') throw new CommentError('empty', 'Type a comment first.', 400);
    const length = Array.from(text).length;
    if (length > COMMENT_MAX_LENGTH) throw new CommentError('too_long', `Comments can be at most ${COMMENT_MAX_LENGTH} characters. Yours is ${length}.`, 400);
    const company = this.company(tickerRaw);
    const now = this.d.now();
    let top: number | null = null;
    if (parentId !== undefined && parentId !== null) {
      const pid = this.commentId(parentId);
      const p = this.d.db.get<{ company_id: number; parent_id: number | null; deleted_ms: number | null }>('SELECT company_id, parent_id, deleted_ms FROM company_comments WHERE id = ?', pid);
      if (!p || p.deleted_ms !== null || p.company_id !== company.id) throw new CommentError('no_such_comment', 'That comment is gone.', 404);
      top = p.parent_id ?? pid;
      if (p.parent_id !== null) {
        const t = this.d.db.get<{ deleted_ms: number | null }>('SELECT deleted_ms FROM company_comments WHERE id = ?', top);
        if (!t || t.deleted_ms !== null) throw new CommentError('no_such_comment', 'That comment is gone.', 404);
      }
      const answers = this.d.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM company_comments WHERE parent_id = ? AND deleted_ms IS NULL', top)?.n ?? 0;
      if (answers >= REPLIES_MAX) throw new CommentError('thread_full', `This comment already has ${REPLIES_MAX} answers. Write a new comment instead.`, 400);
    }
    const last = this.d.db.get<{ body: string; created_ms: number }>('SELECT body, created_ms FROM company_comments WHERE user_id = ? ORDER BY id DESC LIMIT 1', me.id);
    if (last && now - last.created_ms < COMMENT_GAP_MS) {
      throw new CommentError('too_fast', `Slow down: wait ${Math.max(1, Math.ceil((COMMENT_GAP_MS - (now - last.created_ms)) / 1000))} seconds between comments.`, 429);
    }
    const today = this.d.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM company_comments WHERE user_id = ? AND created_ms > ?', me.id, now - 86_400_000)?.n ?? 0;
    if (today >= COMMENTS_PER_DAY) throw new CommentError('daily_cap', `You have written ${COMMENTS_PER_DAY} comments in the last day. Come back a little later.`, 429);
    if (last && last.body.toLowerCase() === text.toLowerCase() && now - last.created_ms < COMMENT_REPEAT_MS) throw new CommentError('repeat', 'You just wrote that. Write something different.', 400);
    const id = this.d.db.tx(() => {
      const newId = this.d.db.run('INSERT INTO company_comments(company_id, user_id, parent_id, body, created_ms) VALUES (?, ?, ?, ?, ?)', company.id, me.id, top, text, now).lastInsertRowid;
      if (top === null) {
        // Keep only the newest COMMENT_KEEP_PER_COMPANY comments of this company (their answers, likes and reports are deleted with them).
        this.d.db.run(
          `DELETE FROM company_comments WHERE company_id = ? AND parent_id IS NULL
              AND id NOT IN (SELECT id FROM company_comments WHERE company_id = ? AND parent_id IS NULL ORDER BY id DESC LIMIT ?)`,
          company.id,
          company.id,
          COMMENT_KEEP_PER_COMPANY,
        );
      }
      return newId;
    });
    return { id, username: me.username, displayName: me.displayName, role: me.role, text, createdMs: now, likes: 0, liked: false, mine: true };
  }

  /** Likes a comment, or takes the like back when it is already there. Nobody can like his own comment. */
  like(me: User, commentIdRaw: unknown): { liked: boolean; likes: number } {
    const id = this.commentId(commentIdRaw);
    const c = this.d.db.get<{ user_id: number }>('SELECT user_id FROM company_comments WHERE id = ? AND deleted_ms IS NULL', id);
    if (!c) throw new CommentError('no_such_comment', 'That comment is gone.', 404);
    if (c.user_id === me.id) throw new CommentError('bad_request', 'That is your own comment.', 400);
    const had = this.d.db.get('SELECT 1 AS x FROM comment_likes WHERE comment_id = ? AND user_id = ?', id, me.id) !== undefined;
    if (had) this.d.db.run('DELETE FROM comment_likes WHERE comment_id = ? AND user_id = ?', id, me.id);
    else this.d.db.run('INSERT OR IGNORE INTO comment_likes(comment_id, user_id, created_ms) VALUES (?, ?, ?)', id, me.id, this.d.now());
    const likes = this.d.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM comment_likes WHERE comment_id = ?', id)?.n ?? 0;
    return { liked: !had, likes };
  }

  /** A player reports a comment for the owner or a moderator to look at. Reporting the same comment twice changes nothing. */
  report(me: User, commentIdRaw: unknown): void {
    const id = this.commentId(commentIdRaw);
    const now = this.d.now();
    const c = this.d.db.get<{ user_id: number; role: Role }>(`SELECT c.user_id, ${roleSql('u')} AS role FROM company_comments c JOIN users u ON u.id = c.user_id WHERE c.id = ? AND c.deleted_ms IS NULL`, id);
    if (!c) throw new CommentError('no_such_comment', 'That comment is gone.', 404);
    if (c.user_id === me.id) throw new CommentError('bad_request', 'That is your own comment.', 400);
    if (c.role === 'owner') throw new CommentError('bad_request', 'Comments of the owner cannot be reported.', 400);
    const recent = this.d.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM comment_reports WHERE reporter_id = ? AND created_ms > ?', me.id, now - 3_600_000)?.n ?? 0;
    if (recent >= COMMENT_REPORTS_PER_HOUR) throw new CommentError('rate_limited', 'You have sent a lot of reports. Wait a while before sending more.', 429);
    this.d.db.run('INSERT OR IGNORE INTO comment_reports(comment_id, reporter_id, created_ms) VALUES (?, ?, ?)', id, me.id, now);
  }

  /** A player deletes a comment he wrote himself: it disappears for everybody (its answers with it). Open reports about it stay for the staff until they close them. */
  removeOwn(me: User, commentIdRaw: unknown): { ok: true } {
    const id = this.commentId(commentIdRaw);
    const c = this.d.db.get<{ user_id: number; deleted_ms: number | null }>('SELECT user_id, deleted_ms FROM company_comments WHERE id = ?', id);
    if (!c) throw new CommentError('no_such_comment', 'That comment is gone.', 404);
    if (c.user_id !== me.id) throw new CommentError('bad_request', 'You can only delete your own comments.', 403);
    if (c.deleted_ms !== null) return { ok: true };
    this.d.db.run('UPDATE company_comments SET deleted_ms = ?, deleted_by = ? WHERE id = ? AND deleted_ms IS NULL', this.d.now(), me.id, id);
    return { ok: true };
  }

  // ---- the owner's and the moderators' tools ------------------------------------------------------------------------

  /** A moderator works on ordinary players only: never on the owner's or another moderator's comments (docs/world.md §21). */
  private staffOnlyOwner(admin: User, target: { id: number; role: Role }, what: string): void {
    if (admin.role === 'owner') return;
    if (target.id === admin.id) return;
    if (target.role !== 'player') throw new CommentError('cannot_moderate_staff', `A moderator cannot ${what} the owner or another moderator. Ask the owner.`, 403);
  }

  /** Removes a comment for everybody and closes the reports about it. */
  remove(admin: User, input: { requestId: unknown; commentId: unknown }): { ok: true; duplicate: boolean } {
    const id = this.commentId(input.commentId);
    const c = this.d.db.get<{ user_id: number; username: string; role: Role }>(`SELECT c.user_id, u.username, ${roleSql('u')} AS role FROM company_comments c JOIN users u ON u.id = c.user_id WHERE c.id = ?`, id);
    if (!c) throw new CommentError('no_such_comment', 'That comment is gone.', 404);
    this.staffOnlyOwner(admin, { id: c.user_id, role: c.role }, 'delete a comment of');
    const now = this.d.now();
    let duplicate = false;
    this.d.db.tx(() => {
      if (!this.d.audit(admin, input.requestId, 'comment_delete', `comment ${id}`, { commentId: id, author: c.username })) {
        duplicate = true;
        return;
      }
      this.d.db.run('UPDATE company_comments SET deleted_ms = ?, deleted_by = ? WHERE id = ? AND deleted_ms IS NULL', now, admin.id, id);
      this.d.db.run('UPDATE comment_reports SET resolved_ms = ? WHERE comment_id = ? AND resolved_ms IS NULL', now, id);
    });
    return { ok: true, duplicate };
  }

  /** Closes the reports about a comment without removing it. */
  dismiss(admin: User, input: { requestId: unknown; commentId: unknown }): { ok: true; duplicate: boolean } {
    const id = this.commentId(input.commentId);
    const c = this.d.db.get<{ user_id: number; role: Role }>(`SELECT c.user_id, ${roleSql('u')} AS role FROM company_comments c JOIN users u ON u.id = c.user_id WHERE c.id = ?`, id);
    if (!c) throw new CommentError('no_such_comment', 'That comment is gone.', 404);
    this.staffOnlyOwner(admin, { id: c.user_id, role: c.role }, 'close a report about');
    let duplicate = false;
    this.d.db.tx(() => {
      if (!this.d.audit(admin, input.requestId, 'comment_dismiss', `comment ${id}`, { commentId: id })) {
        duplicate = true;
        return;
      }
      this.d.db.run('UPDATE comment_reports SET resolved_ms = ? WHERE comment_id = ? AND resolved_ms IS NULL', this.d.now(), id);
    });
    return { ok: true, duplicate };
  }

  /** What the admin Chat tab shows: the open reports about comments, newest first (a moderator does not see reports about the owner or other moderators). */
  adminView(viewer: User): AdminCommentsView {
    const owner = viewer.role === 'owner';
    const rows = this.d.db.all<{ comment_id: number; ticker: string; body: string; created_ms: number; username: string; display_name: string; reporters: number; first_ms: number; kind: 'mute' | 'ban' | null }>(
      `SELECT c.id AS comment_id, co.ticker, c.body, c.created_ms, u.username, u.display_name, COUNT(r.id) AS reporters, MIN(r.created_ms) AS first_ms, cr.kind
         FROM comment_reports r JOIN company_comments c ON c.id = r.comment_id JOIN companies co ON co.id = c.company_id JOIN users u ON u.id = c.user_id
         LEFT JOIN chat_restrictions cr ON cr.user_id = u.id
        WHERE r.resolved_ms IS NULL AND (c.deleted_ms IS NULL OR c.deleted_by = c.user_id)
          AND (? OR ${roleSql('u')} = 'player')
        GROUP BY c.id ORDER BY first_ms DESC, c.id DESC LIMIT 100`,
      owner ? 1 : 0,
    );
    return {
      reports: rows.map((r) => ({ commentId: r.comment_id, ticker: r.ticker, text: r.body, username: r.username, displayName: r.display_name, createdMs: r.created_ms, reporters: r.reporters, firstReportedMs: r.first_ms, restriction: r.kind })),
    };
  }
}
