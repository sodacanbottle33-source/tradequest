// Forgotten passwords: the owner-only reset (`npm run reset-password`) sets a new password, ends the old sign-ins, and changes nothing else.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Auth, resetPassword } from '../server/auth';
import { migrate } from '../server/schema';
import { Db } from '../server/sqlite';

const dbs: Db[] = [];
afterEach(() => {
  while (dbs.length > 0) dbs.pop()?.close();
});

function open(owner = ''): { db: Db; auth: Auth } {
  const db = new Db(':memory:');
  dbs.push(db);
  migrate(db);
  return { db, auth: new Auth(db, () => Date.now(), owner) };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (e) {
    return (e as { code: string }).code;
  }
  return 'no error';
}

describe('resetting a forgotten password', () => {
  it('RPW-1: the new password works, the old one does not, and the old sign-ins end', async () => {
    const { db, auth } = open();
    const alice = await auth.register('alice', 'old password 1', '10.0.0.1');
    const bob = await auth.register('bob', 'bobs password 1', '10.0.0.2');
    expect(auth.userFor(alice.token)?.username).toBe('alice');

    const done = await resetPassword(db, 'alice', 'brand new pass 2');
    expect(done).toEqual({ username: 'alice', sessionsEnded: 1 });

    expect(auth.userFor(alice.token)).toBeNull(); // the old cookie no longer signs anybody in
    expect(await codeOf(auth.login('alice', 'old password 1', '10.0.0.1'))).toBe('bad_login');
    expect((await auth.login('alice', 'brand new pass 2', '10.0.0.1')).user.username).toBe('alice');
    // Somebody else's account is untouched.
    expect(auth.userFor(bob.token)?.username).toBe('bob');
    expect((await auth.login('bob', 'bobs password 1', '10.0.0.2')).user.username).toBe('bob');
  });

  it('RPW-2: the role, the cash and the user id stay exactly as they were', async () => {
    const { db, auth } = open('boss');
    const boss = await auth.register('boss', 'forgotten pass 1', '10.0.0.1');
    expect(boss.user.role).toBe('owner');
    db.run("UPDATE accounts SET cash_cents = 123456 WHERE user_id = ? AND kind = 'career'", boss.user.id);
    const before = db.get<{ id: number; username: string; role: string; created_ms: number }>('SELECT id, username, role, created_ms FROM users WHERE id = ?', boss.user.id);

    await resetPassword(db, 'boss', 'a fresh password');

    const after = db.get<{ id: number; username: string; role: string; created_ms: number }>('SELECT id, username, role, created_ms FROM users WHERE id = ?', boss.user.id);
    expect(after).toEqual(before);
    expect(db.get<{ cash_cents: number }>("SELECT cash_cents FROM accounts WHERE user_id = ? AND kind = 'career'", boss.user.id)?.cash_cents).toBe(123_456);
    const back = await auth.login('boss', 'a fresh password', '10.0.0.1');
    expect(back.user.role).toBe('owner');
  });

  it('RPW-3: an unknown name changes nothing; a bad password is refused; a different spelling of the same name works', async () => {
    const { db, auth } = open();
    await auth.register('Alice_W', 'original pass 1', '10.0.0.1');
    const hashBefore = db.get<{ pw_hash: string }>('SELECT pw_hash FROM users')?.pw_hash;

    expect(await resetPassword(db, 'nobody', 'long enough password')).toBeNull();
    expect(await codeOf(resetPassword(db, 'Alice_W', 'short'))).toBe('bad_password');
    expect(await codeOf(resetPassword(db, 'Alice_W', 'x'.repeat(73)))).toBe('bad_password');
    expect(db.get<{ pw_hash: string }>('SELECT pw_hash FROM users')?.pw_hash).toBe(hashBefore);

    // "alice_w" is the one account "Alice_W" (the exact spelling is reported back).
    expect(await resetPassword(db, 'alice_w', 'new pass for alice')).toEqual({ username: 'Alice_W', sessionsEnded: 1 });
    expect((await auth.login('Alice_W', 'new pass for alice', '10.0.0.1')).user.username).toBe('Alice_W');
  });

  it('RPW-4: the command is wired to the same function, checks that the server is stopped, and is reachable only from the keyboard', () => {
    const tool = readFileSync(resolve(process.cwd(), 'tools', 'reset-password.ts'), 'utf8');
    expect(tool).toContain('resetPassword(db, username, password)');
    expect(tool).toContain('leases.acquire(SERVER_LEASE'); // refuses while the server holds its lease
    expect(tool).toContain('The server is still running');
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['reset-password']).toBe('tsx tools/reset-password.ts');
    // Not an API route: nothing under server/routes or the screens can call it.
    for (const file of ['routes/core.ts', 'routes/admin.ts', 'admin.ts', 'app.ts']) {
      expect(readFileSync(resolve(process.cwd(), 'server', file), 'utf8')).not.toContain('resetPassword');
    }
  });
});
