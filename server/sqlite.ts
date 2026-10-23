// A thin, typed wrapper around Node's built-in SQLite (node:sqlite). No npm package is needed, but Node must be new enough
// (22.13 or later without flags). The module is loaded with createRequire so that bundlers and test runners never try to
// resolve "node:sqlite" themselves.

import { rmSync } from 'node:fs';
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

/** More pages than any database here will ever have: the whole copy is made in one go. */
const ALL_PAGES = 1_000_000;

interface SqliteModule {
  DatabaseSync: new (path: string) => NativeDatabase;
  /** Node 22.16 and newer: copies a database a few pages at a time, so the program is not frozen while it runs. */
  backup?: (source: NativeDatabase, path: string, options?: { rate?: number }) => Promise<number>;
}

function loadSqlite(): SqliteModule {
  try {
    const require = createRequire(import.meta.url);
    return require('node:sqlite') as SqliteModule;
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
    try {
      // WAL lets readers continue while the market writes; NORMAL sync is safe against crashes of the program (not of the
      // whole computer losing power in the middle of a write — a restart then replays at most a few seconds of ticks).
      this.native.exec('PRAGMA journal_mode = WAL');
      this.native.exec('PRAGMA synchronous = NORMAL');
      this.native.exec('PRAGMA foreign_keys = ON');
      this.native.exec('PRAGMA busy_timeout = 5000');
    } catch (error) {
      // A file that is not a database: let go of it at once. (Windows will not let a file be deleted while it is still open.)
      try {
        this.native.close();
      } catch {
        // The first error is the interesting one.
      }
      throw error;
    }
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

  /**
   * Writes a consistent copy of the whole database (every committed change up to now, nothing half done) to a NEW file, while
   * the program keeps working. The copy is read through a second, short-lived connection to the same file: in WAL mode a reader
   * never holds the writer up, and the copy is one unbroken read, so it can never be restarted by the game's own writes. Node's
   * backup does that work off the main thread. (A database in memory has no file to open twice, and an older Node has no backup
   * function; both use SQLite's own VACUUM INTO, which is quick but holds the program still for the moment it takes.)
   */
  async snapshotTo(path: string): Promise<void> {
    const { backup, DatabaseSync } = loadSqlite();
    const onDisk = this.path !== '' && this.path !== ':memory:' && !this.path.startsWith('file::memory:');
    if (typeof backup === 'function' && onDisk) {
      try {
        const reader = new DatabaseSync(this.path);
        try {
          reader.exec('PRAGMA busy_timeout = 5000');
          await backup(reader, path, { rate: ALL_PAGES });
        } finally {
          reader.close();
        }
        return;
      } catch (error) {
        // Whatever went wrong, leave nothing half written behind and take the plain way instead.
        for (const suffix of ['', '-wal', '-shm', '-journal']) {
          try {
            rmSync(path + suffix, { force: true, maxRetries: 5, retryDelay: 50 });
          } catch {
            // A leftover in a temporary folder is harmless; VACUUM INTO below reports it if it matters.
          }
        }
        if (!(error instanceof Error)) throw error;
      }
    }
    this.native.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
  }

  close(): void {
    this.statements.clear();
    this.native.close();
  }
}
