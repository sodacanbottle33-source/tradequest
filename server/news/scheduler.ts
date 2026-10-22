// The news scheduler: a job that keeps tomorrow's news written before anybody needs it. It runs on a timer inside the server,
// does not depend on any player being online, and starts again by itself after every restart (it simply looks at what is
// missing, so a long downtime is caught up in one go). A lease makes sure only one scheduler works on the database at a time.

import { TICKS_PER_HOUR } from '../../src/world';
import { NEWS_LEASE, type Leases } from '../lease';
import type { Logger } from '../log';
import type { NewsHealth, NewsService } from './service';

export interface SchedulerStatus {
  readonly running: boolean;
  readonly runs: number;
  readonly skipped: number;
  readonly failures: number;
  readonly lastRunMs: number | null;
  readonly lastSuccessMs: number | null;
  readonly lastError: string | null;
  readonly lastErrorMs: number | null;
  readonly holdsLease: boolean;
}

export interface SchedulerOptions {
  readonly service: NewsService;
  readonly leases: Leases;
  readonly log: Logger;
  readonly now: () => number;
  /** The market's clock tick (what time it is in the market), not the simulation's progress. */
  readonly clockTick: () => number;
  readonly intervalMs?: number;
  readonly leaseMs?: number;
  /** How far ahead of the clock news must be written. */
  readonly aheadTicks?: number;
}

export type RunResult = { ran: true; health: NewsHealth } | { ran: false; reason: 'lease' | 'error'; error?: string };

export class NewsScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly intervalMs: number;
  private readonly leaseMs: number;
  private readonly aheadTicks: number;
  private runs = 0;
  private skipped = 0;
  private failures = 0;
  private lastRunMs: number | null = null;
  private lastSuccessMs: number | null = null;
  private lastError: string | null = null;
  private lastErrorMs: number | null = null;
  private holds = false;

  constructor(private readonly o: SchedulerOptions) {
    this.intervalMs = o.intervalMs ?? 30_000;
    this.leaseMs = o.leaseMs ?? 90_000;
    this.aheadTicks = o.aheadTicks ?? 12 * TICKS_PER_HOUR;
  }

  /** One pass: take the lease, write whatever news is missing, check the result. Never throws. */
  runOnce(): RunResult {
    const { service, leases, log } = this.o;
    const nowMs = this.o.now();
    this.lastRunMs = nowMs;
    this.holds = leases.acquire(NEWS_LEASE, this.leaseMs);
    if (!this.holds) {
      this.skipped += 1;
      return { ran: false, reason: 'lease' };
    }
    this.runs += 1;
    try {
      const clock = this.o.clockTick();
      const required = clock + this.aheadTicks;
      service.ensureThrough(required);
      const health = service.health(clock, required);
      if (!health.ok) {
        // Not an exception, but it must never go unnoticed: say exactly what is wrong.
        const why = health.belowMinimum.length > 0 ? `${health.belowMinimum.length} companies have fewer than 3 news items today (${health.belowMinimum.slice(0, 5).join(', ')})` : `news is generated through day ${health.generatedThroughCycle} but day ${health.requiredThroughCycle} is needed`;
        throw new Error(`News check failed after generating: ${why}.`);
      }
      this.lastSuccessMs = this.o.now();
      this.lastError = null;
      return { ran: true, health };
    } catch (error) {
      this.failures += 1;
      this.lastError = error instanceof Error ? error.message : String(error);
      this.lastErrorMs = this.o.now();
      log.error('news', `News scheduler run failed: ${this.lastError}`);
      return { ran: false, reason: 'error', error: this.lastError };
    }
  }

  start(): void {
    if (this.timer) return;
    this.runOnce();
    this.timer = setInterval(() => this.runOnce(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.o.leases.release(NEWS_LEASE);
    this.holds = false;
  }

  status(): SchedulerStatus {
    return {
      running: this.timer !== null,
      runs: this.runs,
      skipped: this.skipped,
      failures: this.failures,
      lastRunMs: this.lastRunMs,
      lastSuccessMs: this.lastSuccessMs,
      lastError: this.lastError,
      lastErrorMs: this.lastErrorMs,
      holdsLease: this.holds,
    };
  }
}
