// A lease says "this program is running job X right now". It protects against two copies of the server (or of a scheduled job)
// working on the same database at the same time. A lease ends when its owner stops renewing it, or immediately if the owner
// process on this computer no longer exists (so restarting after a crash never has to wait).

import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { Db } from './sqlite';

export const SERVER_LEASE = 'server';
export const NEWS_LEASE = 'news-scheduler';

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface LeaseOptions {
  readonly db: Db;
  readonly now: () => number;
  /** Identity of this program instance (random by default). */
  readonly owner?: string;
  readonly host?: string;
  readonly pid?: number;
  /** For tests: decides whether a pid on this host is alive. */
  readonly alive?: (pid: number) => boolean;
}

export class Leases {
  readonly owner: string;
  private readonly host: string;
  private readonly pid: number;
  private readonly alive: (pid: number) => boolean;

  constructor(private readonly options: LeaseOptions) {
    this.host = options.host ?? hostname();
    this.pid = options.pid ?? process.pid;
    this.owner = options.owner ?? `${this.host}:${this.pid}:${randomBytes(4).toString('hex')}`;
    this.alive = options.alive ?? processAlive;
  }

  /** Takes or renews the lease. Returns false if somebody else holds a valid one. */
  acquire(name: string, ttlMs: number): boolean {
    const { db } = this.options;
    const nowMs = this.options.now();
    return db.tx(() => {
      const row = db.get<{ owner: string; host: string; pid: number; expires_ms: number }>('SELECT owner, host, pid, expires_ms FROM job_leases WHERE name = ?', name);
      if (row && row.owner !== this.owner && row.expires_ms > nowMs) {
        const sameHostDead = row.host === this.host && !this.alive(row.pid);
        if (!sameHostDead) return false;
      }
      db.run(
        'INSERT INTO job_leases(name, owner, host, pid, expires_ms) VALUES (?, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, host = excluded.host, pid = excluded.pid, expires_ms = excluded.expires_ms',
        name,
        this.owner,
        this.host,
        this.pid,
        nowMs + ttlMs,
      );
      return true;
    });
  }

  release(name: string): void {
    this.options.db.run('DELETE FROM job_leases WHERE name = ? AND owner = ?', name, this.owner);
  }

  holder(name: string): { owner: string; expiresMs: number } | null {
    const row = this.options.db.get<{ owner: string; expires_ms: number }>('SELECT owner, expires_ms FROM job_leases WHERE name = ?', name);
    return row ? { owner: row.owner, expiresMs: row.expires_ms } : null;
  }
}
