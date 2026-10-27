// Pictures sent in chats (docs/world.md §24): the public chat room, chats between friends, private groups and public groups.
//
// A message can carry ONE small picture (and a caption if the player wants). The picture comes from the player's own device; his browser shrinks it first
// (src/shared/chatPictureUtil.ts). This file does not trust that. It takes only a JPEG, PNG or WebP that is really one (the first bytes and the size are
// checked), at most CHAT_PIC_MAX_BYTES big and CHAT_PIC_MAX_SIDE pixels on a side, and keeps the bytes exactly as they came.
//
// Pictures are small and temporary, because the whole database is copied to the cloud every few minutes and a free disk is small:
//   • a picture is kept for CHAT_PIC_KEEP_MS (7 days), then its bytes are emptied and the message shows "picture expired";
//   • all pictures together are kept up to CHAT_PIC_TOTAL_MAX_BYTES; when there are more, the oldest ones expire early;
//   • a picture in the public chat that somebody reported is kept until the report is closed, so the owner can still look at it.
// Who may send one: nobody while the owner has switched pictures off; a brand-new account waits longer than for text before it may send a picture to
// strangers (the public chat and public groups); and everybody is slowed down (PIC_GAP_MS between pictures, PIC_PER_HOUR in an hour). In a chat between
// two players, only friends may send pictures to each other (a message request is text only).
// The owner and the moderators see no private pictures; the owner sees a picture of a private chat only if a player reported that message
// (the report keeps its own copy).

import { imageSize, type AvatarMime } from './profile';
import type { User } from './auth';
import type { Db } from './sqlite';

/** The most bytes a chat picture may have, and the most pixels on a side. The browser makes a picture of about 30–60 KB and at most 800 pixels. */
export const CHAT_PIC_MAX_BYTES = 90 * 1024;
export const CHAT_PIC_MAX_SIDE = 800;
/** How long the bytes of a picture are kept. */
export const CHAT_PIC_KEEP_MS = 7 * 86_400_000;
/** All the bytes of all pictures together, at most. */
export const CHAT_PIC_TOTAL_MAX_BYTES = 20 * 1024 * 1024;
/** The shortest time between two pictures of one player, and the most in an hour. */
export const PIC_GAP_MS = 15_000;
export const PIC_PER_HOUR = 20;
/** An account must be this old before it sends a picture to strangers (the public chat room and public groups). The owner and the moderators do not wait. */
export const PIC_PUBLIC_WAIT_MS = 60 * 60_000;
/** The text a message has when it is only a picture (a message always has some text in the database). */
export const PICTURE_BODY = '(picture)';
/** The JSON around a picture, plus the text of the message: how big a request that sends a picture may be. */
export const PIC_REQUEST_LIMIT = Math.ceil((CHAT_PIC_MAX_BYTES * 4) / 3) + 4096;
const META_KEY = 'chat_pictures_off';

export type PictureKind = 'chat' | 'pm';
/** What a message shows about its picture: there is one ('ok'), or there was one and it expired. */
export type PictureState = 'ok' | 'expired';
/** Where a picture is sent: to everybody ('public': the chat room, a public group) or to people the sender chose ('friends': a friend, a private group). */
export type PicturePlace = 'public' | 'friends';

export class PictureProblem extends Error {
  constructor(
    readonly code: 'bad_request' | 'bad_image' | 'too_large' | 'pictures_off' | 'too_fast' | 'picture_limit' | 'friends_only' | 'too_new',
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface PictureBytes {
  readonly mime: AvatarMime;
  readonly data: Uint8Array;
}

export interface ChatPictureDeps {
  readonly db: Db;
  readonly now: () => number;
}

const TABLES: Record<PictureKind, string> = { chat: 'chat_message_pictures', pm: 'private_message_pictures' };

export class ChatPictures {
  private readonly sent = new Map<number, number[]>();

  constructor(private readonly d: ChatPictureDeps) {}

  /** Reads "data:image/jpeg;base64,...." into its kind and bytes. Throws PictureProblem for anything that is not a real, small picture. */
  decode(raw: unknown): PictureBytes {
    if (typeof raw !== 'string') throw new PictureProblem('bad_request', 'Send the picture as text ("data:image/jpeg;base64,...").', 400);
    const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(raw);
    if (!m) throw new PictureProblem('bad_image', 'Only JPEG, PNG or WebP pictures can be sent.', 400);
    const mime = m[1] as AvatarMime;
    const encoded = m[2] as string;
    const tooBig = `The picture is too big. It can be at most ${Math.round(CHAT_PIC_MAX_BYTES / 1024)} KB after it is shrunk.`;
    // The size is known before anything is decoded: a long text is refused at once.
    if (encoded.length > Math.ceil((CHAT_PIC_MAX_BYTES * 4) / 3) + 4) throw new PictureProblem('too_large', tooBig, 413);
    const data = new Uint8Array(Buffer.from(encoded, 'base64'));
    if (data.length === 0 || data.length > CHAT_PIC_MAX_BYTES) throw new PictureProblem('too_large', tooBig, 413);
    const size = imageSize(data, mime);
    if (!size || size.width < 1 || size.height < 1) throw new PictureProblem('bad_image', 'That file is not a real picture.', 400);
    if (size.width > CHAT_PIC_MAX_SIDE || size.height > CHAT_PIC_MAX_SIDE) throw new PictureProblem('too_large', `The picture can be at most ${CHAT_PIC_MAX_SIDE} pixels wide and high.`, 413);
    return { mime, data };
  }

  // ---- the owner's switch --------------------------------------------------------------------------------------------

  /** Whether players may send pictures at all right now. */
  enabled(): boolean {
    return this.d.db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', META_KEY)?.value !== '1';
  }

  setEnabled(on: boolean): void {
    if (on) this.d.db.run('DELETE FROM meta WHERE key = ?', META_KEY);
    else this.d.db.run('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', META_KEY, '1');
  }

  // ---- may this player send one now? ---------------------------------------------------------------------------------

  /**
   * Throws PictureProblem unless `me` may send a picture to this kind of place right now. `friends` is false for a chat with a player who is not a
   * friend (a message request is text only). Call noteSent() once the message is saved.
   */
  checkSend(me: User, place: PicturePlace, friends = true): void {
    if (!this.enabled()) throw new PictureProblem('pictures_off', 'The owner has switched pictures off for now. Text still works.', 403);
    if (!friends) throw new PictureProblem('friends_only', 'You can send pictures to friends and in groups. Become friends first.', 403);
    const now = this.d.now();
    const staff = me.role !== 'player';
    if (place === 'public' && !staff && me.createdMs + PIC_PUBLIC_WAIT_MS > now) {
      const left = Math.ceil((me.createdMs + PIC_PUBLIC_WAIT_MS - now) / 60_000);
      throw new PictureProblem('too_new', `New accounts can send pictures to everybody after ${Math.round(PIC_PUBLIC_WAIT_MS / 60_000)} minutes. You can in ${left} ${left === 1 ? 'minute' : 'minutes'}. Pictures to friends and private groups work now.`, 403);
    }
    const mine = (this.sent.get(me.id) ?? []).filter((t) => t > now - 3_600_000);
    this.sent.set(me.id, mine);
    const last = mine[mine.length - 1];
    if (last !== undefined && now - last < PIC_GAP_MS) throw new PictureProblem('too_fast', `Wait ${Math.ceil((PIC_GAP_MS - (now - last)) / 1000)} seconds before sending another picture.`, 429);
    if (!staff && mine.length >= PIC_PER_HOUR) throw new PictureProblem('picture_limit', `You can send ${PIC_PER_HOUR} pictures in an hour. Try again a little later.`, 429);
  }

  noteSent(userId: number): void {
    const list = this.sent.get(userId) ?? [];
    list.push(this.d.now());
    this.sent.set(userId, list);
  }

  // ---- keeping and reading -------------------------------------------------------------------------------------------

  /** Saves the picture of a message that was just saved (call it inside the same transaction). */
  save(kind: PictureKind, messageId: number, picture: PictureBytes): void {
    this.d.db.run(`INSERT INTO ${TABLES[kind]}(message_id, mime, data, created_ms) VALUES (?, ?, ?, ?)`, messageId, picture.mime, picture.data, this.d.now());
  }

  /** The picture of a message, or null when the message has none or it has expired. */
  image(kind: PictureKind, messageId: number): (PictureBytes & { createdMs: number }) | null {
    const r = this.d.db.get<{ mime: AvatarMime; data: Uint8Array | null; created_ms: number }>(`SELECT mime, data, created_ms FROM ${TABLES[kind]} WHERE message_id = ?`, messageId);
    return r && r.data ? { mime: r.mime, data: r.data, createdMs: r.created_ms } : null;
  }

  /** Empties the bytes of one message's picture (the message was deleted). Returns whether there was something to empty. */
  drop(kind: PictureKind, messageId: number): boolean {
    return this.d.db.run(`UPDATE ${TABLES[kind]} SET data = NULL WHERE message_id = ? AND data IS NOT NULL`, messageId).changes > 0;
  }

  /** How many bytes of pictures are kept right now. */
  usedBytes(): number {
    const a = this.d.db.get<{ n: number | null }>('SELECT SUM(length(data)) AS n FROM chat_message_pictures WHERE data IS NOT NULL')?.n ?? 0;
    const b = this.d.db.get<{ n: number | null }>('SELECT SUM(length(data)) AS n FROM private_message_pictures WHERE data IS NOT NULL')?.n ?? 0;
    return a + b;
  }

  /**
   * Lets old pictures expire (older than CHAT_PIC_KEEP_MS) and, while all pictures together are over CHAT_PIC_TOTAL_MAX_BYTES, the oldest ones too.
   * A picture of the public chat with an open report is never emptied here. Returns how many pictures were emptied.
   */
  prune(): number {
    const now = this.d.now();
    const { db } = this.d;
    const unreported = 'NOT EXISTS (SELECT 1 FROM chat_reports r WHERE r.message_id = p.message_id AND r.resolved_ms IS NULL)';
    let emptied = 0;
    db.tx(() => {
      emptied += db.run(`UPDATE chat_message_pictures AS p SET data = NULL WHERE data IS NOT NULL AND created_ms <= ? AND ${unreported}`, now - CHAT_PIC_KEEP_MS).changes;
      emptied += db.run('UPDATE private_message_pictures SET data = NULL WHERE data IS NOT NULL AND created_ms <= ?', now - CHAT_PIC_KEEP_MS).changes;
      let used = this.usedBytes();
      while (used > CHAT_PIC_TOTAL_MAX_BYTES) {
        const oldest = db.all<{ kind: PictureKind; message_id: number; n: number; created_ms: number }>(
          `SELECT kind, message_id, n, created_ms FROM (
             SELECT 'chat' AS kind, p.message_id, length(p.data) AS n, p.created_ms FROM chat_message_pictures p WHERE p.data IS NOT NULL AND ${unreported}
             UNION ALL
             SELECT 'pm' AS kind, p.message_id, length(p.data) AS n, p.created_ms FROM private_message_pictures p WHERE p.data IS NOT NULL
           ) ORDER BY created_ms, message_id LIMIT 20`,
        );
        if (oldest.length === 0) break; // only protected pictures are left
        let progress = false;
        for (const o of oldest) {
          if (used <= CHAT_PIC_TOTAL_MAX_BYTES) break;
          if (this.drop(o.kind, o.message_id)) {
            used -= o.n;
            emptied++;
            progress = true;
          }
        }
        if (!progress) break;
      }
    });
    return emptied;
  }
}
