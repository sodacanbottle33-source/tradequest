// Profile pictures and "who is online" (docs/world.md §18).
//
// A player picks a picture on his own device. His browser shrinks it to a small square first (see src/shared/avatarUtil.ts); this file is the
// server's side and does not trust that: it takes only a JPEG, PNG or WebP that is really one (the first bytes and the stored size are checked),
// at most AVATAR_MAX_BYTES big and at most AVATAR_MAX_SIDE pixels on a side (a tiny file can still be a huge picture that would use a lot of
// memory in every browser that shows it). The bytes are kept exactly as they came. Everybody who is signed in can see every picture;
// a player can remove his own, and the owner can remove anybody's (written to the admin log).
//
// "Online" means the player has a page open right now (the same thing the friend 1v1 challenges and the calls use).

import { roleSql, type Role, type User } from './auth';
import type { Db } from './sqlite';

/** The most bytes a picture may have, and the most pixels on a side. The browser makes about 6 KB and 128 pixels. */
export const AVATAR_MAX_BYTES = 40 * 1024;
export const AVATAR_MAX_SIDE = 256;
/** The most picture changes (new or removed) one player can make in an hour. */
export const AVATAR_CHANGES_PER_HOUR = 20;
/** How many players are listed as online at most. */
export const ONLINE_MAX = 1000;

export type AvatarMime = 'image/jpeg' | 'image/png' | 'image/webp';

export class ProfileError extends Error {
  constructor(
    readonly code: 'bad_request' | 'too_large' | 'bad_image' | 'rate_limited' | 'no_such_player' | 'no_picture' | 'no_such_company' | 'not_allowed',
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface Avatar {
  readonly mime: AvatarMime;
  readonly data: Uint8Array;
  readonly updatedMs: number;
}

export interface ProfileDeps {
  readonly db: Db;
  readonly now: () => number;
  /** The ids of the players who have a page open. */
  readonly onlineIds: () => readonly number[];
  /** Tells every signed-in page that a picture changed. */
  readonly publish: (event: string, data: unknown) => void;
  /** Writes the owner's removal to the admin log, once per requestId. False when it was already done. */
  readonly audit: (admin: User, requestId: unknown, action: 'avatar_remove', target: string, detail: Record<string, unknown>) => boolean;
}

const be16 = (b: Uint8Array, at: number): number => ((b[at] as number) << 8) | (b[at + 1] as number);
const be32 = (b: Uint8Array, at: number): number => (((b[at] as number) << 24) | ((b[at + 1] as number) << 16) | ((b[at + 2] as number) << 8) | (b[at + 3] as number)) >>> 0;
const le16 = (b: Uint8Array, at: number): number => (b[at] as number) | ((b[at + 1] as number) << 8);
const le24 = (b: Uint8Array, at: number): number => (b[at] as number) | ((b[at + 1] as number) << 8) | ((b[at + 2] as number) << 16);
const ascii = (b: Uint8Array, at: number, n: number): string => String.fromCharCode(...Array.from(b.subarray(at, at + n)));

/** The width and height written in the file itself, or null when the bytes are not a picture of that kind. */
export function imageSize(bytes: Uint8Array, mime: AvatarMime): { width: number; height: number } | null {
  if (mime === 'image/png') {
    if (bytes.length < 33 || ascii(bytes, 1, 3) !== 'PNG' || bytes[0] !== 0x89 || ascii(bytes, 12, 4) !== 'IHDR') return null;
    return { width: be32(bytes, 16), height: be32(bytes, 20) };
  }
  if (mime === 'image/jpeg') {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
    let at = 2;
    while (at + 4 <= bytes.length) {
      if (bytes[at] !== 0xff) return null;
      const marker = bytes[at + 1] as number;
      if (marker === 0xff) {
        at += 1; // a filler byte
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        at += 2; // markers without a length
        continue;
      }
      const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrame) return at + 9 <= bytes.length ? { height: be16(bytes, at + 5), width: be16(bytes, at + 7) } : null;
      at += 2 + be16(bytes, at + 2);
    }
    return null;
  }
  if (bytes.length < 30 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') return null;
  const kind = ascii(bytes, 12, 4);
  if (kind === 'VP8 ') {
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    return { width: le16(bytes, 26) & 0x3fff, height: le16(bytes, 28) & 0x3fff };
  }
  if (kind === 'VP8L') {
    if (bytes[20] !== 0x2f) return null;
    const v = ((bytes[21] as number) | ((bytes[22] as number) << 8) | ((bytes[23] as number) << 16) | ((bytes[24] as number) << 24)) >>> 0;
    return { width: (v & 0x3fff) + 1, height: ((v >>> 14) & 0x3fff) + 1 };
  }
  if (kind === 'VP8X') return { width: le24(bytes, 24) + 1, height: le24(bytes, 27) + 1 };
  return null;
}

/** Reads "data:image/jpeg;base64,...." into its kind and bytes. Throws ProfileError for anything else. */
export function decodePicture(raw: unknown): { mime: AvatarMime; data: Uint8Array } {
  if (typeof raw !== 'string') throw new ProfileError('bad_request', 'Send the picture as text ("data:image/jpeg;base64,...").', 400);
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(raw);
  if (!m) throw new ProfileError('bad_image', 'Only JPEG, PNG or WebP pictures can be used.', 400);
  const mime = m[1] as AvatarMime;
  const encoded = m[2] as string;
  // The size is known before anything is decoded: a long text is refused at once.
  if (encoded.length > Math.ceil((AVATAR_MAX_BYTES * 4) / 3) + 4) throw new ProfileError('too_large', `The picture is too big. It can be at most ${Math.round(AVATAR_MAX_BYTES / 1024)} KB after it is shrunk.`, 413);
  const data = new Uint8Array(Buffer.from(encoded, 'base64'));
  if (data.length === 0 || data.length > AVATAR_MAX_BYTES) throw new ProfileError('too_large', `The picture is too big. It can be at most ${Math.round(AVATAR_MAX_BYTES / 1024)} KB after it is shrunk.`, 413);
  const size = imageSize(data, mime);
  if (!size || size.width < 1 || size.height < 1) throw new ProfileError('bad_image', 'That file is not a real picture.', 400);
  if (size.width > AVATAR_MAX_SIDE || size.height > AVATAR_MAX_SIDE) throw new ProfileError('too_large', `The picture can be at most ${AVATAR_MAX_SIDE} pixels wide and high.`, 413);
  return { mime, data };
}

export class Profiles {
  private readonly changes = new Map<number, number[]>();

  constructor(private readonly d: ProfileDeps) {}

  /** Every picture there is: username -> the time it was set (changes whenever the picture does, so a browser can keep it as long as the number is the same). */
  versions(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.d.db.all<{ username: string; updated_ms: number }>('SELECT u.username, a.updated_ms FROM user_avatars a JOIN users u ON u.id = a.user_id ORDER BY u.username')) out[r.username] = r.updated_ms;
    return out;
  }

  /** The picture of one player, or null. */
  image(username: string): Avatar | null {
    const r = this.d.db.get<{ mime: AvatarMime; data: Uint8Array; updated_ms: number }>('SELECT a.mime, a.data, a.updated_ms FROM user_avatars a JOIN users u ON u.id = a.user_id WHERE u.username = ?', username);
    return r ? { mime: r.mime, data: r.data, updatedMs: r.updated_ms } : null;
  }

  private tooMany(userId: number): boolean {
    const now = this.d.now();
    const list = (this.changes.get(userId) ?? []).filter((t) => t > now - 3_600_000);
    if (list.length >= AVATAR_CHANGES_PER_HOUR) {
      this.changes.set(userId, list);
      return true;
    }
    list.push(now);
    this.changes.set(userId, list);
    return false;
  }

  /** Sets (or replaces) the player's own picture. */
  set(me: User, raw: unknown): { version: number } {
    const { mime, data } = decodePicture(raw);
    if (this.tooMany(me.id)) throw new ProfileError('rate_limited', 'You changed your picture a lot. Wait a while before changing it again.', 429);
    // Two changes in the same millisecond must still give two different numbers.
    const before = this.d.db.get<{ updated_ms: number }>('SELECT updated_ms FROM user_avatars WHERE user_id = ?', me.id)?.updated_ms ?? 0;
    const version = Math.max(this.d.now(), before + 1);
    this.d.db.run(
      'INSERT INTO user_avatars(user_id, mime, data, updated_ms) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET mime = excluded.mime, data = excluded.data, updated_ms = excluded.updated_ms',
      me.id,
      mime,
      data,
      version,
    );
    this.d.publish('avatar', { username: me.username, v: version });
    return { version };
  }

  /** Takes the player's own picture away. Removing when there is none changes nothing. */
  clear(me: User): { ok: true } {
    if (this.d.db.run('DELETE FROM user_avatars WHERE user_id = ?', me.id).changes > 0) this.d.publish('avatar', { username: me.username, v: null });
    return { ok: true };
  }

  /** The owner takes anybody's picture away; a moderator takes away the picture of an ordinary player (never the owner's or another moderator's). */
  removeBy(admin: User, input: { requestId: unknown; username: unknown }): { ok: true; duplicate: boolean; username: string } {
    const name = typeof input.username === 'string' ? input.username.trim().replace(/^@+/, '') : '';
    const target = name === '' || name.length > 40 ? undefined : this.d.db.get<{ id: number; username: string; role: Role }>(`SELECT u.id, u.username, ${roleSql('u')} AS role FROM users u WHERE u.username = ?`, name);
    if (!target) throw new ProfileError('no_such_player', 'There is no player with that username.', 404);
    if (admin.role !== 'owner' && target.role !== 'player' && target.id !== admin.id) throw new ProfileError('not_allowed', 'A moderator cannot remove the picture of the owner or of another moderator.', 403);
    let duplicate = false;
    let removed = false;
    this.d.db.tx(() => {
      if (!this.d.audit(admin, input.requestId, 'avatar_remove', target.username, {})) {
        duplicate = true;
        return;
      }
      removed = this.d.db.run('DELETE FROM user_avatars WHERE user_id = ?', target.id).changes > 0;
    });
    if (removed) this.d.publish('avatar', { username: target.username, v: null });
    return { ok: true, duplicate, username: target.username };
  }

  /** Usernames of the players who have a page open right now (the owner's own ban list is respected: a banned player is not shown). */
  online(): string[] {
    const ids = [...new Set(this.d.onlineIds())].slice(0, ONLINE_MAX);
    if (ids.length === 0) return [];
    const marks = ids.map(() => '?').join(',');
    const now = this.d.now();
    return this.d.db
      .all<{ username: string }>(
        `SELECT u.username FROM users u
          WHERE u.id IN (${marks}) AND u.pw_hash <> 'bot'
            AND NOT EXISTS (SELECT 1 FROM user_bans b WHERE b.user_id = u.id AND (b.until_ms IS NULL OR b.until_ms > ?))
          ORDER BY u.username`,
        ...ids,
        now,
      )
      .map((r) => r.username);
  }
}
