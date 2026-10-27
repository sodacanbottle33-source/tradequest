// Changing your username (docs/world.md §25).
//
// A player can pick a new username for RENAME_COST_CENTS ($4,000), taken from the cash of his Career account and gone (like a launch fee), and only once every
// RENAME_WAIT_MS (7 days). The new name follows the same rules as a name at sign-up (3–20 letters, numbers or underscores, not taken) plus a few more:
//   • the owner's name is set by whoever runs the server, so the owner cannot change it here, and nobody can take that name;
//   • a few official-sounding names (admin, moderator, support...) cannot be chosen;
//   • the name a player leaves is kept for him for RENAME_KEEP_MS (30 days): nobody else can sign up with it or change to it in that time, so a name cannot be
//     copied to pretend to be somebody (he can take it back himself, for the same price);
//   • only a real player changes his name (computer players never do).
// Everything else follows the player's id, not his name: money, shares, friends, groups, badges, pictures, messages. His sessions stay valid. Every page is told
// ("user_renamed") so lists that show the old name update.

import { NAME_KEPT_MS, type User } from './auth';
import type { Logger } from './log';
import { waitText } from './chat';
import type { Db } from './sqlite';

/** $4,000. */
export const RENAME_COST_CENTS = 400_000;
export const RENAME_WAIT_MS = 7 * 86_400_000;
export const RENAME_KEEP_MS = NAME_KEPT_MS;
const USERNAME = /^[A-Za-z0-9_]{3,20}$/;
/** Names that sound like staff or like the game itself (compared without case). */
const OFFICIAL = new Set(['admin', 'administrator', 'owner', 'moderator', 'mod', 'staff', 'support', 'system', 'tradequest', 'official', 'root', 'server', 'bot', 'help']);

export class RenameError extends Error {
  constructor(
    readonly code: 'bad_request' | 'bad_username' | 'username_taken' | 'name_reserved' | 'same_name' | 'too_soon' | 'not_enough_cash' | 'cannot_rename',
    message: string,
    readonly status: number,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export interface RenameDeps {
  readonly db: Db;
  readonly now: () => number;
  readonly log: Logger;
  /** The username the server setting makes the owner ('' = none). */
  readonly ownerUsername: string;
  /** Tells every signed-in page. */
  readonly publish: (event: string, data: unknown) => void;
}

/** What the Account page shows about changing the username. */
export interface RenameStatus {
  readonly costCents: number;
  readonly waitMs: number;
  /** He may change it now. */
  readonly canChange: boolean;
  /** Why not (null when he can). */
  readonly reason: string | null;
  /** When he may change it again (null if he can now, or never could). */
  readonly nextAllowedMs: number | null;
  readonly cashCents: number;
  readonly lastChangeMs: number | null;
}

export class Renames {
  constructor(private readonly d: RenameDeps) {}

  private isBot(userId: number): boolean {
    return this.d.db.get('SELECT 1 AS x FROM bots WHERE user_id = ?', userId) !== undefined;
  }

  private accountOf(userId: number): { id: number; cash: number } | null {
    const a = this.d.db.get<{ id: number; cash_cents: number }>("SELECT id, cash_cents FROM accounts WHERE user_id = ? AND kind = 'career'", userId);
    return a ? { id: a.id, cash: a.cash_cents } : null;
  }

  private cashOf(userId: number): { id: number; cash: number } {
    const a = this.accountOf(userId);
    if (!a) throw new RenameError('cannot_rename', 'You have no Career account to pay from.', 409);
    return a;
  }

  private lastChange(userId: number): number | null {
    return this.d.db.get<{ changed_ms: number }>('SELECT changed_ms FROM username_changes WHERE user_id = ? ORDER BY changed_ms DESC, id DESC LIMIT 1', userId)?.changed_ms ?? null;
  }

  /** Why this player cannot change his name at all, or null. */
  private blocked(me: User): string | null {
    if (me.role === 'owner') return "The owner's username is set on the server, so it cannot be changed here.";
    if (this.isBot(me.id)) return 'Computer players keep their names.';
    return null;
  }

  status(me: User): RenameStatus {
    const now = this.d.now();
    const last = this.lastChange(me.id);
    const account = this.accountOf(me.id);
    const cash = account?.cash ?? 0;
    const next = last === null ? null : last + RENAME_WAIT_MS;
    let reason = this.blocked(me);
    if (reason === null && account === null) reason = 'You have no Career account to pay from.';
    if (reason === null && next !== null && next > now) reason = `You changed your username recently. You can change it again in ${waitText(next - now)}.`;
    if (reason === null && cash < RENAME_COST_CENTS) reason = `A new username costs $${(RENAME_COST_CENTS / 100).toLocaleString('en-US')} of Career cash, and you have $${(cash / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}.`;
    return { costCents: RENAME_COST_CENTS, waitMs: RENAME_WAIT_MS, canChange: reason === null, reason, nextAllowedMs: next !== null && next > now ? next : null, cashCents: cash, lastChangeMs: last };
  }

  /** Why `name` cannot be the new username of `me`, or null when it can. Case-only changes of his own name are fine. */
  private nameProblem(me: User, name: string): { code: RenameError['code']; message: string; status: number } | null {
    if (!USERNAME.test(name)) return { code: 'bad_username', message: 'Pick a username of 3–20 letters, numbers or underscores.', status: 400 };
    if (name === me.username) return { code: 'same_name', message: 'That is already your username.', status: 400 };
    if (OFFICIAL.has(name.toLowerCase())) return { code: 'name_reserved', message: 'That name sounds like the staff or the game itself. Pick another.', status: 409 };
    if (this.d.ownerUsername !== '' && name.toLowerCase() === this.d.ownerUsername.toLowerCase()) return { code: 'username_taken', message: 'That username is taken.', status: 409 };
    if (this.d.db.get('SELECT 1 AS x FROM users WHERE username = ? AND id <> ?', name, me.id)) return { code: 'username_taken', message: 'That username is taken.', status: 409 };
    if (this.d.db.get('SELECT 1 AS x FROM username_changes WHERE old_name = ? AND user_id <> ? AND changed_ms > ?', name, me.id, this.d.now() - RENAME_KEEP_MS)) {
      return { code: 'name_reserved', message: 'Another player had that name a short while ago and it is kept for them. Pick another.', status: 409 };
    }
    return null;
  }

  /** Changes the username: checks everything again inside one transaction, takes the cost, writes the change. */
  change(me: User, rawName: unknown): { username: string; previous: string; costCents: number; cashCents: number; nextAllowedMs: number } {
    if (typeof rawName !== 'string') throw new RenameError('bad_request', 'username must be text.', 400);
    const name = rawName.trim();
    const now = this.d.now();
    const done = this.d.db.tx(() => {
      const why = this.blocked(me);
      if (why) throw new RenameError('cannot_rename', why, 403);
      const problem = this.nameProblem(me, name);
      if (problem) throw new RenameError(problem.code, problem.message, problem.status);
      const last = this.lastChange(me.id);
      if (last !== null && last + RENAME_WAIT_MS > now) {
        throw new RenameError('too_soon', `You changed your username recently. You can change it again in ${waitText(last + RENAME_WAIT_MS - now)}.`, 429, { nextAllowedMs: last + RENAME_WAIT_MS });
      }
      const { id, cash } = this.cashOf(me.id);
      if (cash < RENAME_COST_CENTS) {
        throw new RenameError('not_enough_cash', `A new username costs $${(RENAME_COST_CENTS / 100).toLocaleString('en-US')} of Career cash, and you have $${(cash / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}.`, 400, {
          cashCents: cash,
          needCents: RENAME_COST_CENTS,
        });
      }
      this.d.db.run('UPDATE users SET username = ?, display_name = ? WHERE id = ?', name, name, me.id);
      this.d.db.run('UPDATE accounts SET cash_cents = cash_cents - ? WHERE id = ?', RENAME_COST_CENTS, id);
      this.d.db.run('INSERT INTO username_changes(user_id, old_name, new_name, changed_ms, cost_cents) VALUES (?, ?, ?, ?, ?)', me.id, me.username, name, now, RENAME_COST_CENTS);
      return { cashCents: cash - RENAME_COST_CENTS };
    });
    this.d.log.info('account', `${me.username} changed his username to ${name} (cost $${RENAME_COST_CENTS / 100}).`);
    this.d.publish('user_renamed', { from: me.username, to: name });
    return { username: name, previous: me.username, costCents: RENAME_COST_CENTS, cashCents: done.cashCents, nextAllowedMs: now + RENAME_WAIT_MS };
  }
}
