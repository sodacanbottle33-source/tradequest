// A thin, typed wrapper around Node's built-in SQLite (node:sqlite). No npm package is needed, but Node must be new enough
// (22.13 or later without flags). The module is loaded with createRequire so that bundlers and test runners never try to
// resolve "node:sqlite" themselves.

import { createRequire } from 'node:module';

export type SqlValue = string | number | bigint | null | Uint8Array;
export type Row = Record<string, unknown>;

interface NativeStatement {
  run(...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: SqlValue[]): Row | undefined;
  all(...params: SqlValue[]): Row[];
}
interface NativeDatabase {
  exec(sql: string): void;
  prepare(sql: string): NativeStatement;
  close(): void;
}

function loadSqlite(): { DatabaseSync: new (path: string) => NativeDatabase } {
  try {
    const require = createRequire(import.meta.url);
    return require('node:sqlite') as { DatabaseSync: new (path: string) => NativeDatabase };
  } catch (error) {
    throw new Error(
      `TradeQuest's server needs Node 22.13 or newer (it uses the SQLite built into Node). You have Node ${process.versions.node}. ` +
        `Install the current LTS version from https://nodejs.org and try again. (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

export interface RunResult {
  readonly changes: number;
  readonly lastInsertRowid: number;
}

export class Db {
  private readonly native: NativeDatabase;
  private readonly statements = new Map<string, NativeStatement>();
  private depth = 0;
  readonly path: string;

  constructor(path: string) {
    this.path = path;
    const { DatabaseSync } = loadSqlite();
    this.native = new DatabaseSync(path);
    // WAL lets readers continue while the market writes; NORMAL sync is safe against crashes of the program (not of the
    // whole computer losing power in the middle of a write — a restart then replays at most a few seconds of ticks).
    this.native.exec('PRAGMA journal_mode = WAL');
    this.native.exec('PRAGMA synchronous = NORMAL');
    this.native.exec('PRAGMA foreign_keys = ON');
    this.native.exec('PRAGMA busy_timeout = 5000');
  }

  private statement(sql: string): NativeStatement {
    let st = this.statements.get(sql);
    if (!st) {
      st = this.native.prepare(sql);
      this.statements.set(sql, st);
    }
    return st;
  }

  exec(sql: string): void {
    this.native.exec(sql);
  }

  run(sql: string, ...params: SqlValue[]): RunResult {
    const r = this.statement(sql).run(...params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  get<T = Row>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.statement(sql).get(...params) as T | undefined;
  }

  all<T = Row>(sql: string, ...params: SqlValue[]): T[] {
    return this.statement(sql).all(...params) as T[];
  }

  get inTransaction(): boolean {
    return this.depth > 0;
  }

  /**
   * Runs `fn` inside one transaction that takes the write lock immediately (BEGIN IMMEDIATE), so two writers can never
   * interleave. If `fn` throws, everything it did is rolled back and the error is re-thrown. Nested calls join the outer
   * transaction.
   */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.native.exec('BEGIN IMMEDIATE');
    this.depth = 1;
    try {
      const result = fn();
      this.native.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.native.exec('ROLLBACK');
      } catch {
        // The original error is the interesting one.
      }
      throw error;
    } finally {
      this.depth = 0;
    }
  }

  close(): void {
    this.statements.clear();
    this.native.close();
  }
}
