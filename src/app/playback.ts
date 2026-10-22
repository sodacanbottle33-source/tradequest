// Playback timing for live market mode — see docs/rules.md §13.9.
// This is the ONLY place that knows about time. The engine has no clock: playback just asks it for one more
// tick now and then, so speed, pausing and timer jitter can never change which prices come next.

export type Speed = 1 | 2 | 4;
export const SPEEDS: readonly Speed[] = [1, 2, 4];

/** At 1× the market produces one tick per second. */
export const BASE_TICK_MS = 1000;

export function tickIntervalMs(speed: Speed): number {
  return BASE_TICK_MS / speed;
}

export function isSpeed(value: number): value is Speed {
  return value === 1 || value === 2 || value === 4;
}

/** A repeating timer. The browser one wraps setInterval; tests use a fake one they can wind forward by hand. */
export interface Scheduler {
  start(callback: () => void, intervalMs: number): unknown;
  stop(handle: unknown): void;
}

export const browserScheduler: Scheduler = {
  start: (callback, intervalMs) => window.setInterval(callback, intervalMs),
  stop: (handle) => window.clearInterval(handle as number),
};

/**
 * Play / pause / speed. `onTick` is called once per interval and returns whether the market can keep going;
 * when it returns false (for example the session ended) playback pauses itself.
 */
export class Playback {
  private handle: unknown = null;
  private isPlaying = false;
  private currentSpeed: Speed = 1;

  constructor(
    private readonly scheduler: Scheduler,
    private readonly onTick: () => boolean,
    private readonly onChange: () => void,
  ) {}

  get playing(): boolean {
    return this.isPlaying;
  }

  get speed(): Speed {
    return this.currentSpeed;
  }

  play(): void {
    if (this.isPlaying) return; // a second play() must not start a second timer
    this.isPlaying = true;
    this.startTimer();
    this.onChange();
  }

  pause(): void {
    if (!this.isPlaying) return;
    this.isPlaying = false;
    this.stopTimer();
    this.onChange();
  }

  setSpeed(speed: Speed): void {
    if (!isSpeed(speed)) throw new Error(`Unknown speed ${String(speed)}`);
    if (speed === this.currentSpeed) return;
    this.currentSpeed = speed;
    if (this.isPlaying) {
      this.stopTimer();
      this.startTimer();
    }
    this.onChange();
  }

  /** Stops the timer without telling anyone (used when the page goes away). */
  dispose(): void {
    this.isPlaying = false;
    this.stopTimer();
  }

  private startTimer(): void {
    this.handle = this.scheduler.start(() => {
      if (!this.onTick()) this.pause();
    }, tickIntervalMs(this.currentSpeed));
  }

  private stopTimer(): void {
    if (this.handle !== null) this.scheduler.stop(this.handle);
    this.handle = null;
  }
}
