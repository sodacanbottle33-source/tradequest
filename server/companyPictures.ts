// Pictures for stocks and memecoins (docs/world.md §20).
//
// A company can have one small picture, like a logo. The player who LAUNCHED the company can set, change and remove it; the owner can do so
// for any company, the built-in ones too. Nobody else can. Everybody (signed in or not) can see every picture: the market is public.
//
// The picture comes from the player's own device. His browser shrinks it to a small square first (src/shared/avatarUtil.ts); this file does not
// trust that. It uses the same checks as a profile picture (server/profile.ts decodePicture): only a real JPEG, PNG or WebP, at most
// AVATAR_MAX_BYTES big and AVATAR_MAX_SIDE pixels on a side, kept exactly as it came. A picture changes nothing about prices, shares or money.
//
// A player may change pictures only so often (the owner is not limited: he may be setting a picture for every company in a row). When the
// owner changes or removes a picture of a company he did not launch himself, it is written to the admin log, once per requestId.

import type { User } from './auth';
import { AVATAR_CHANGES_PER_HOUR, ProfileError, decodePicture, type AvatarMime } from './profile';
import type { Db } from './sqlite';

export interface CompanyPicture {
  readonly mime: AvatarMime;
  readonly data: Uint8Array;
  readonly updatedMs: number;
}

export interface CompanyPictureDeps {
  readonly db: Db;
  readonly now: () => number;
  /** Tells every page (signed in or not) that a picture changed: `v` is its new version, or null when it was removed. */
  readonly publish: (event: string, data: unknown) => void;
  /** Writes the owner's change to the admin log, once per requestId. False when it was already done. */
  readonly audit: (admin: User, requestId: unknown, action: 'company_pic_set' | 'company_pic_remove', target: string, detail: Record<string, unknown>) => boolean;
}

interface CompanyRow {
  readonly id: number;
  readonly ticker: string;
}

export class CompanyPictures {
  private readonly changes = new Map<number, number[]>();

  constructor(private readonly d: CompanyPictureDeps) {}

  private company(ticker: unknown): CompanyRow {
    const t = typeof ticker === 'string' ? ticker.trim() : '';
    const row = t === '' || t.length > 12 ? undefined : (this.d.db.get<CompanyRow>('SELECT id, ticker FROM companies WHERE ticker = ?', t) ?? this.d.db.get<CompanyRow>('SELECT id, ticker FROM companies WHERE ticker = ?', t.toUpperCase()));
    if (!row) throw new ProfileError('no_such_company', 'There is no company with that ticker.', 404);
    return row;
  }

  /** Whether this player launched this company. */
  private launchedBy(companyId: number, userId: number): boolean {
    return this.d.db.get('SELECT 1 AS x FROM launches WHERE company_id = ? AND user_id = ?', companyId, userId) !== undefined;
  }

  /** Every picture there is: ticker -> the time it was set (changes whenever the picture does, so a browser can keep it as long as the number is the same). */
  versions(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.d.db.all<{ ticker: string; updated_ms: number }>('SELECT c.ticker, p.updated_ms FROM company_pictures p JOIN companies c ON c.id = p.company_id ORDER BY c.ticker')) out[r.ticker] = r.updated_ms;
    return out;
  }

  /** The picture of one company, or null. */
  image(ticker: string): CompanyPicture | null {
    const r = this.d.db.get<{ mime: AvatarMime; data: Uint8Array; updated_ms: number }>('SELECT p.mime, p.data, p.updated_ms FROM company_pictures p JOIN companies c ON c.id = p.company_id WHERE c.ticker = ?', ticker);
    return r ? { mime: r.mime, data: r.data, updatedMs: r.updated_ms } : null;
  }

  /** Whether this player may set or remove this company's picture: the owner always, a player only for a company he launched. */
  canChange(me: User, ticker: unknown): { canChange: boolean; ticker: string; hasPicture: boolean } {
    const c = this.company(ticker);
    const has = this.d.db.get('SELECT 1 AS x FROM company_pictures WHERE company_id = ?', c.id) !== undefined;
    return { canChange: me.role === 'owner' || this.launchedBy(c.id, me.id), ticker: c.ticker, hasPicture: has };
  }

  private allowed(me: User, c: CompanyRow): void {
    if (me.role === 'owner' || this.launchedBy(c.id, me.id)) return;
    throw new ProfileError('not_allowed', 'Only the player who launched this company, or the owner, can change its picture.', 403);
  }

  private tooMany(me: User): boolean {
    if (me.role === 'owner') return false;
    const now = this.d.now();
    const list = (this.changes.get(me.id) ?? []).filter((t) => t > now - 3_600_000);
    if (list.length >= AVATAR_CHANGES_PER_HOUR) {
      this.changes.set(me.id, list);
      return true;
    }
    list.push(now);
    this.changes.set(me.id, list);
    return false;
  }

  /** Sets (or replaces) the picture of a company. `requestId` is needed only when the owner changes a company he did not launch. */
  set(me: User, input: { ticker: unknown; image: unknown; requestId?: unknown }): { ok: true; duplicate: boolean; ticker: string; version: number | null } {
    const c = this.company(input.ticker);
    this.allowed(me, c);
    const { mime, data } = decodePicture(input.image);
    const loggable = me.role === 'owner' && !this.launchedBy(c.id, me.id);
    let duplicate = false;
    let version: number | null = null;
    this.d.db.tx(() => {
      if (loggable && !this.d.audit(me, input.requestId, 'company_pic_set', c.ticker, {})) {
        duplicate = true;
        return;
      }
      if (this.tooMany(me)) throw new ProfileError('rate_limited', 'You changed pictures a lot. Wait a while before changing another one.', 429);
      // Two changes in the same millisecond must still give two different numbers.
      const before = this.d.db.get<{ updated_ms: number }>('SELECT updated_ms FROM company_pictures WHERE company_id = ?', c.id)?.updated_ms ?? 0;
      version = Math.max(this.d.now(), before + 1);
      this.d.db.run(
        'INSERT INTO company_pictures(company_id, mime, data, updated_ms, set_by) VALUES (?, ?, ?, ?, ?) ON CONFLICT(company_id) DO UPDATE SET mime = excluded.mime, data = excluded.data, updated_ms = excluded.updated_ms, set_by = excluded.set_by',
        c.id,
        mime,
        data,
        version,
        me.id,
      );
    });
    if (version !== null) this.d.publish('company_picture', { ticker: c.ticker, v: version });
    return { ok: true, duplicate, ticker: c.ticker, version };
  }

  /** Takes the picture of a company away. Removing when there is none changes nothing. */
  clear(me: User, input: { ticker: unknown; requestId?: unknown }): { ok: true; duplicate: boolean; ticker: string } {
    const c = this.company(input.ticker);
    this.allowed(me, c);
    const loggable = me.role === 'owner' && !this.launchedBy(c.id, me.id);
    let duplicate = false;
    let removed = false;
    this.d.db.tx(() => {
      if (loggable && !this.d.audit(me, input.requestId, 'company_pic_remove', c.ticker, {})) {
        duplicate = true;
        return;
      }
      if (this.d.db.get('SELECT 1 AS x FROM company_pictures WHERE company_id = ?', c.id) !== undefined && this.tooMany(me)) {
        throw new ProfileError('rate_limited', 'You changed pictures a lot. Wait a while before changing another one.', 429);
      }
      removed = this.d.db.run('DELETE FROM company_pictures WHERE company_id = ?', c.id).changes > 0;
    });
    if (removed) this.d.publish('company_picture', { ticker: c.ticker, v: null });
    return { ok: true, duplicate, ticker: c.ticker };
  }
}
