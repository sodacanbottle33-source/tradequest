// A fake repeating timer: nothing happens until a test winds the clock forward.
import type { Scheduler } from '../../src/app/playback';

interface Timer {
  callback: () => void;
  interval: number;
  next: number;
}

export class FakeScheduler implements Scheduler {
  now = 0;
  startCalls = 0;
  private nextId = 1;
  private readonly timers = new Map<number, Timer>();

  start(callback: () => void, intervalMs: number): unknown {
    const id = this.nextId++;
    this.startCalls += 1;
    this.timers.set(id, { callback, interval: intervalMs, next: this.now + intervalMs });
    return id;
  }

  stop(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  get activeTimers(): number {
    return this.timers.size;
  }

  /** Wind the clock forward, firing every timer that comes due, in time order. */
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      let dueId: number | null = null;
      let due: Timer | null = null;
      for (const [id, t] of this.timers) {
        if (t.next <= target && (due === null || t.next < due.next)) {
          dueId = id;
          due = t;
        }
      }
      if (due === null || dueId === null) break;
      this.now = due.next;
      due.next += due.interval;
      due.callback();
    }
    this.now = target;
  }
}
