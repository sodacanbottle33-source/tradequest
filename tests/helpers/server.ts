// Helpers for the server tests: a temporary database, a clock the test controls, and a way to start/stop a world.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorldEvent } from '../../src/world';
import { Logger } from '../../server/log';
import { migrate } from '../../server/schema';
import { Db } from '../../server/sqlite';
import { WorldRuntime, type NewsHooks } from '../../server/world/runtime';

export const START_MS = Date.UTC(2026, 9, 1, 12, 0, 0);

export class Clock {
  constructor(public ms: number = START_MS) {}
  now = (): number => this.ms;
  advanceSeconds(s: number): void {
    this.ms += s * 1000;
  }
}

export interface Rig {
  dir: string;
  path: string;
  clock: Clock;
  log: Logger;
  open(options?: Partial<OpenOptions>): { db: Db; world: WorldRuntime; news: NewsHooks | null };
  cleanup(): void;
  opened: Db[];
}

export interface OpenOptions {
  companyCount: number;
  warmupDays: number;
  worldSeed: number;
  /** Add the thirty memecoins to the world (once). */
  memecoins: boolean;
  /** Ready-made hooks, or a function that builds them once the database is open (a real NewsService needs the database). */
  news: NewsHooks | ((db: Db) => NewsHooks) | null;
}

export function makeRig(clock: Clock = new Clock()): Rig {
  const dir = mkdtempSync(join(tmpdir(), 'tq-test-'));
  const path = join(dir, 'world.sqlite');
  const log = new Logger({ sink: null, now: clock.now });
  const opened: Db[] = [];
  const rig: Rig = {
    dir,
    path,
    clock,
    log,
    opened,
    open(options = {}) {
      const db = new Db(path);
      opened.push(db);
      migrate(db);
      const hooks = typeof options.news === 'function' ? options.news(db) : (options.news ?? null);
      const world = new WorldRuntime({
        db,
        log,
        now: clock.now,
        companyCount: options.companyCount ?? 12,
        warmupDays: options.warmupDays ?? 1,
        worldSeed: options.worldSeed ?? 12345,
        memecoins: options.memecoins ?? false,
        news: hooks,
      });
      world.init();
      return { db, world, news: hooks };
    },
    cleanup() {
      for (const db of opened) {
        try {
          db.close();
        } catch {
          // already closed
        }
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return rig;
}

/** News that is a fixed list of events (all known in advance), for tests. */
export function fixedNews(events: readonly WorldEvent[]): NewsHooks {
  return {
    ensureThrough: () => undefined,
    eventsActiveAt: (tick) => events.filter((e) => e.startTick <= tick && tick < e.startTick + e.durationTicks),
    eventsStartingIn: (from, through) => events.filter((e) => e.startTick >= from && e.startTick <= through),
  };
}

export function priceVector(world: WorldRuntime): number[] {
  return Array.from(world.sim.P);
}
