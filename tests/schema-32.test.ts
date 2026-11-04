// SCHEMA32-1 … SCHEMA32-3 — database version 32 is one empty table that nothing uses (left from a PayPal test that was taken out again; docs/world.md §43). It stays so that a database
// that is already at version 32 still opens. These checks keep it harmless and keep PayPal out of the program.
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS, migrate } from '../server/schema';
import { Db } from '../server/sqlite';

function fresh(): { d: Db; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'tq-schema32-'));
  const d = new Db(join(dir, 'db.sqlite'));
  return {
    d,
    done: () => {
      d.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
    else if (/\.(ts|tsx|css)$/.test(name)) found.push(path);
  }
  return found;
}

describe('database version 32', () => {
  it('SCHEMA32-1: 32 is the last step and it only adds the one unused table and its two indexes (nothing that exists is changed or dropped)', () => {
    const last = MIGRATIONS[MIGRATIONS.length - 1] as (typeof MIGRATIONS)[number];
    expect(last.version).toBe(32);
    expect(last.name).toMatch(/nothing uses/);
    const statements = last.sql.split('\n').filter((line) => !line.startsWith('--')).join('\n');
    expect(statements.match(/CREATE TABLE/g)).toHaveLength(1);
    expect(statements.match(/CREATE INDEX/g)).toHaveLength(2);
    expect(statements).toContain('CREATE TABLE paypal_orders');
    expect(statements).not.toMatch(/ALTER TABLE|DROP |DELETE FROM|UPDATE [a-z_]+ SET|INSERT /); // (ON DELETE CASCADE inside the new table is fine)
    expect(MIGRATIONS.map((m) => m.version)).toEqual(MIGRATIONS.map((_, i) => i + (MIGRATIONS[0] as (typeof MIGRATIONS)[number]).version));
  });

  it('SCHEMA32-2: a database at version 31 upgrades to 32 with the table empty, keeps its players, and a second start changes nothing', () => {
    const { d, done } = fresh();
    try {
      d.tx(() => {
        for (const m of MIGRATIONS.filter((x) => x.version <= 31)) {
          d.exec(m.sql);
          d.exec(`PRAGMA user_version = ${m.version}`);
        }
      });
      d.run("INSERT INTO users(id, username, display_name, pw_hash, role, created_ms) VALUES (1, 'a', 'a', 'x', 'player', 1)");
      expect(migrate(d)).toEqual([32]);
      expect(d.get<{ user_version: number }>('PRAGMA user_version')?.user_version).toBe(32);
      expect(d.get<{ n: number }>('SELECT COUNT(*) AS n FROM paypal_orders')?.n).toBe(0);
      expect(d.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')?.n).toBe(1);
      expect(migrate(d)).toEqual([]);
      // A player can still be deleted: nothing is left waiting on the table.
      d.run('DELETE FROM users WHERE id = 1');
      expect(d.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')?.n).toBe(0);
    } finally {
      done();
    }
  });

  it('SCHEMA32-3: no source file except the database step mentions PayPal: no route, setting, page, style or admin card', () => {
    const roots = ['server', 'src'].map((x) => resolve(process.cwd(), x));
    const mentions = roots.flatMap(sourceFiles).filter((file) => /paypal/i.test(readFileSync(file, 'utf8')));
    expect(mentions.map((file) => file.replace(process.cwd(), '').replace(/\\/g, '/'))).toEqual(['/server/schema.ts']);
  });
});
