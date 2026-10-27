// Accounts and sign-in. Passwords are stored only as salted scrypt hashes; session tokens only as SHA-256 hashes, so a copy
// of the database does not let anyone sign in. The role (player / moderator / owner) is decided here on the server and nowhere else.

import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import type { Db } from './sqlite';

export const START_CASH_CENTS = 100_000; // $1,000.00 for a new Career account
export const SESSION_DAYS = 30;
export const SESSION_COOKIE = 'tq_session';

export type Role = 'player' | 'moderator' | 'owner';

/**
 * SQL that gives a person's role the way the rest of the program sees it: 'owner' if the users row says so, else 'moderator' if the player is on the
 * moderators list (server/moderation.ts), else 'player'. `alias` is what the users table is called in the query. Use it as `${roleSql('u')} AS role`.
 */
export function roleSql(alias: string): string {
  return `(CASE WHEN ${alias}.role = 'owner' THEN 'owner' WHEN EXISTS (SELECT 1 FROM moderators mo WHERE mo.user_id = ${alias}.id) THEN 'moderator' ELSE 'player' END)`;
}

/** Whether somebody is on the staff (the owner or a moderator): the ones who see the moderation tools. */
export function isStaff(role: Role): boolean {
  return role === 'owner' || role === 'moderator';
}

/** A ban a moderator or the owner has put on a player. `untilMs` is null for "until the owner lifts it". A 'kick' is a short ban that ends by itself. */
export interface BanInfo {
  readonly reason: string;
  readonly bannedMs: number;
  readonly untilMs: number | null;
  readonly kind: 'ban' | 'kick';
}

/** The sentence a banned player is shown when he tries to sign in. */
export function banMessage(ban: BanInfo): string {
  const until = ban.untilMs === null ? '' : ` until ${new Date(ban.untilMs).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  if (ban.kind === 'kick') return `You were kicked out for a short time${until}${ban.reason ? `: ${ban.reason}` : '.'} You can sign in again after that.`;
  return `This account is banned${until}${ban.reason ? `: ${ban.reason}` : '.'}`;
}

export interface User {
  readonly id: number;
  readonly username: string;
  readonly displayName: string;
  readonly role: Role;
  readonly createdMs: number;
}

export class AuthError extends Error {
  constructor(
    readonly code: 'bad_username' | 'bad_password' | 'username_taken' | 'bad_login' | 'rate_limited' | 'no_session' | 'banned',
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const USERNAME = /^[A-Za-z0-9_]{3,20}$/;
/** A username a player left (server/rename.ts) is kept for him this long: nobody else can sign up with it meanwhile. */
export const NAME_KEPT_MS = 30 * 86_400_000;

function scrypt(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password.normalize('NFKC'), salt, 64, { N: 16384, r: 8, p: 1 }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, saltHex, keyHex] = stored.split('$');
  if (kind !== 'scrypt' || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Counts recent failures per key and refuses further attempts for a while. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number,
  ) {}

  /** True if the key may try again. */
  allowed(key: string): boolean {
    const list = this.recent(key);
    return list.length < this.limit;
  }

  record(key: string): void {
    const list = this.recent(key);
    list.push(this.now());
    this.hits.set(key, list);
  }

  clear(key: string): void {
    this.hits.delete(key);
  }

  private recent(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length === 0) this.hits.delete(key);
    return list;
  }
}

interface UserRow {
  id: number;
  username: string;
  display_name: string;
  pw_hash: string;
  /** What the users table says: the moderators list is looked at separately. */
  role: 'player' | 'owner';
  created_ms: number;
}

export class Auth {
  private readonly failures: RateLimiter;
  private readonly registrations: RateLimiter;

  constructor(
    private readonly db: Db,
    private readonly now: () => number,
    private readonly ownerUsername: string,
  ) {
    this.failures = new RateLimiter(8, 10 * 60_000, now);
    this.registrations = new RateLimiter(10, 60 * 60_000, now);
  }

  /** The program's view of a users row: the owner stays the owner, a player on the moderators list is a moderator. */
  private toUser(r: UserRow): User {
    const role: Role = r.role === 'owner' ? 'owner' : this.db.get('SELECT 1 AS x FROM moderators WHERE user_id = ?', r.id) !== undefined ? 'moderator' : 'player';
    return { id: r.id, username: r.username, displayName: r.display_name, role, createdMs: r.created_ms };
  }

  async register(username: string, password: string, ip: string): Promise<{ user: User; token: string }> {
    if (typeof username !== 'string' || !USERNAME.test(username)) {
      throw new AuthError('bad_username', 'Pick a username of 3–20 letters, numbers or underscores.', 400);
    }
    if (typeof password !== 'string' || password.length < 8 || password.length > 72) {
      throw new AuthError('bad_password', 'The password must be 8–72 characters long.', 400);
    }
    if (!this.registrations.allowed(ip)) throw new AuthError('rate_limited', 'Too many new accounts from this address. Try again later.', 429);
    this.registrations.record(ip);
    const hash = await hashPassword(password);
    const role: 'player' | 'owner' = this.ownerUsername !== '' && username.toLowerCase() === this.ownerUsername.toLowerCase() ? 'owner' : 'player';
    const nowMs = this.now();
    const created = this.db.tx(() => {
      if (this.db.get('SELECT 1 FROM users WHERE username = ?', username)) throw new AuthError('username_taken', 'That username is taken.', 409);
      if (this.db.get('SELECT 1 FROM username_changes WHERE old_name = ? AND changed_ms > ?', username, nowMs - NAME_KEPT_MS)) throw new AuthError('username_taken', 'That username is taken.', 409);
      const r = this.db.run('INSERT INTO users(username, display_name, pw_hash, role, created_ms) VALUES (?, ?, ?, ?, ?)', username, username, hash, role, nowMs);
      const id = r.lastInsertRowid;
      this.db.run("INSERT INTO accounts(user_id, kind, match_id, cash_cents, start_cash_cents, created_ms) VALUES (?, 'career', NULL, ?, ?, ?)", id, START_CASH_CENTS, START_CASH_CENTS, nowMs);
      return this.db.get<UserRow>('SELECT * FROM users WHERE id = ?', id) as UserRow;
    });
    return { user: this.toUser(created), token: this.createSession(created.id) };
  }

  async login(username: string, password: string, ip: string): Promise<{ user: User; token: string }> {
    const key = `${ip}|${String(username).toLowerCase()}`;
    if (!this.failures.allowed(key)) throw new AuthError('rate_limited', 'Too many failed sign-ins. Wait a few minutes and try again.', 429);
    const row = typeof username === 'string' ? this.db.get<UserRow>('SELECT * FROM users WHERE username = ?', username) : undefined;
    // Always do the hashing work so the response time does not reveal whether the username exists.
    const ok = await verifyPassword(typeof password === 'string' ? password : '', row?.pw_hash ?? 'scrypt$00$00');
    if (!row || !ok) {
      this.failures.record(key);
      throw new AuthError('bad_login', 'Wrong username or password.', 401);
    }
    this.failures.clear(key);
    // Only somebody who knows the password is told that the account is banned (and why).
    const ban = this.banOf(row.id);
    if (ban) throw new AuthError('banned', banMessage(ban), 403);
    return { user: this.toUser(row), token: this.createSession(row.id) };
  }

  private createSession(userId: number): string {
    const token = randomBytes(32).toString('base64url');
    const nowMs = this.now();
    this.db.run('INSERT INTO sessions(token_hash, user_id, created_ms, expires_ms) VALUES (?, ?, ?, ?)', tokenHash(token), userId, nowMs, nowMs + SESSION_DAYS * 86_400_000);
    return token;
  }

  /** The signed-in user for a session token, or null. */
  userFor(token: string | undefined): User | null {
    if (!token) return null;
    const row = this.db.get<UserRow & { expires_ms: number }>(
      'SELECT u.*, s.expires_ms FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?',
      tokenHash(token),
    );
    if (!row) return null;
    if (row.expires_ms <= this.now()) {
      this.db.run('DELETE FROM sessions WHERE token_hash = ?', tokenHash(token));
      return null;
    }
    // A banned player is treated as signed out on every request, whatever cookie the browser still holds.
    if (this.banOf(row.id)) return null;
    return this.toUser(row);
  }

  // ---- bans ----------------------------------------------------------------------------------------------------------

  /** The ban that is in force for a user right now, or null (a ban whose time has passed no longer counts). */
  banOf(userId: number): BanInfo | null {
    const r = this.db.get<{ reason: string; banned_ms: number; until_ms: number | null; kind: 'ban' | 'kick' }>('SELECT reason, banned_ms, until_ms, kind FROM user_bans WHERE user_id = ?', userId);
    if (!r) return null;
    if (r.until_ms !== null && r.until_ms <= this.now()) return null;
    return { reason: r.reason, bannedMs: r.banned_ms, untilMs: r.until_ms, kind: r.kind };
  }

  /** The ban of whoever owns this session cookie (so the page can say why it was signed out), or null. */
  banOfSession(token: string | undefined): BanInfo | null {
    if (!token) return null;
    const row = this.db.get<{ user_id: number; expires_ms: number }>('SELECT user_id, expires_ms FROM sessions WHERE token_hash = ?', tokenHash(token));
    if (!row || row.expires_ms <= this.now()) return null;
    return this.banOf(row.user_id);
  }

  /** Who put the ban that is in force on this player (null when there is none): a moderator may only change what a moderator did. */
  banPlacedBy(userId: number): number | null {
    if (!this.banOf(userId)) return null;
    return this.db.get<{ by_user_id: number }>('SELECT by_user_id FROM user_bans WHERE user_id = ?', userId)?.by_user_id ?? null;
  }

  /** Writes a ban or a kick (a second one for the same player replaces the first). Call inside the transaction that also writes the admin log. */
  setBan(userId: number, reason: string, untilMs: number | null, byUserId: number, kind: 'ban' | 'kick' = 'ban'): void {
    this.db.run(
      'INSERT INTO user_bans(user_id, reason, banned_ms, until_ms, by_user_id, kind) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET reason = excluded.reason, banned_ms = excluded.banned_ms, until_ms = excluded.until_ms, by_user_id = excluded.by_user_id, kind = excluded.kind',
      userId,
      reason,
      this.now(),
      untilMs,
      byUserId,
      kind,
    );
  }

  /** Removes a ban. Returns false if there was none. */
  clearBan(userId: number): boolean {
    return this.db.run('DELETE FROM user_bans WHERE user_id = ?', userId).changes > 0;
  }

  logout(token: string | undefined): void {
    if (token) this.db.run('DELETE FROM sessions WHERE token_hash = ?', tokenHash(token));
  }

  userById(id: number): User | null {
    const row = this.db.get<UserRow>('SELECT * FROM users WHERE id = ?', id);
    return row ? this.toUser(row) : null;
  }

  /**
   * Makes the database agree with the server setting: exactly one owner, the configured username, and nobody else. Called when the
   * server starts. The owner role can never be given through the web: only by the person who runs the server. Returns who is
   * owner afterwards (null = nobody, or the configured user has not registered yet).
   */
  applyOwner(): string | null {
    const wanted = this.ownerUsername;
    return this.db.tx(() => {
      if (wanted === '') this.db.run("UPDATE users SET role = 'player' WHERE role = 'owner'");
      else {
        this.db.run("UPDATE users SET role = 'player' WHERE role = 'owner' AND username <> ? COLLATE NOCASE", wanted);
        this.db.run("UPDATE users SET role = 'owner' WHERE username = ? COLLATE NOCASE AND role <> 'owner'", wanted);
      }
      return this.db.get<{ username: string }>("SELECT username FROM users WHERE role = 'owner'")?.username ?? null;
    });
  }

  /** Removes expired sessions (called now and then). */
  purgeExpired(): number {
    return this.db.run('DELETE FROM sessions WHERE expires_ms <= ?', this.now()).changes;
  }
}

/**
 * Sets a new password for one account and signs that account out everywhere (every old session ends). This is for the person who
 * runs the server (`npm run reset-password`, with the server stopped); there is no way to call it through the web. The role, the
 * money and everything else of the account stay as they are. Returns the account's exact username, or null if there is none.
 */
export async function resetPassword(db: Db, username: string, password: string): Promise<{ username: string; sessionsEnded: number } | null> {
  if (typeof password !== 'string' || password.length < 8 || password.length > 72) {
    throw new AuthError('bad_password', 'The password must be 8–72 characters long.', 400);
  }
  const hash = await hashPassword(password);
  return db.tx(() => {
    let row = db.get<{ id: number; username: string }>('SELECT id, username FROM users WHERE username = ?', username);
    if (!row) {
      const similar = db.all<{ id: number; username: string }>('SELECT id, username FROM users WHERE username = ? COLLATE NOCASE', username);
      if (similar.length === 1) row = similar[0];
    }
    if (!row) return null;
    db.run('UPDATE users SET pw_hash = ? WHERE id = ?', hash, row.id);
    const ended = db.run('DELETE FROM sessions WHERE user_id = ?', row.id).changes;
    return { username: row.username, sessionsEnded: ended };
  });
}
