// The live market as one object the UI subscribes to: it owns the LiveState privately, runs playback, and
// exposes only the safe view (rules.md §13.7, §13.9). No React in here, so it is tested without a browser.
//
// Every action is synchronous: when a player clicks Buy, the order is filled at whatever tick the market is on
// at that instant, and that is the price the trade record and the screen both show.

import {
  advanceLive,
  createLiveSession,
  getLiveView,
  resetLive,
  skipToCandleEnd,
  submitLiveOrder,
  type LiveOptions,
  type LiveState,
  type LiveView,
  type Side,
} from '../engine';
import { Playback, type Scheduler, type Speed } from './playback';

export interface LiveSnapshot {
  readonly view: LiveView;
  readonly playing: boolean;
  readonly speed: Speed;
  /** Step and Skip are available only while paused and while the session is running. */
  readonly canStep: boolean;
}

export class LiveController {
  private state: LiveState;
  private snapshot: LiveSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly playback: Playback;

  constructor(initial: LiveState, scheduler: Scheduler) {
    this.state = initial;
    this.playback = new Playback(scheduler, () => this.timerTick(), () => this.publish());
    this.snapshot = this.buildSnapshot();
  }

  // ----- For React's useSyncExternalStore -----

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** The same object is returned until something changes. */
  readonly getSnapshot = (): LiveSnapshot => this.snapshot;

  // ----- Playback -----

  play(): void {
    if (this.state.status !== 'RUNNING') return;
    this.playback.play();
  }

  pause(): void {
    this.playback.pause();
  }

  setSpeed(speed: Speed): void {
    this.playback.setSpeed(speed);
  }

  /** Advance exactly one tick. Only while paused. Returns whether a tick happened. */
  step(): boolean {
    if (this.playback.playing || this.state.status !== 'RUNNING') return false;
    this.state = advanceLive(this.state, 1);
    this.publish();
    return true;
  }

  /** Run to the end of the forming candle. Only while paused. Returns whether anything happened. */
  skip(): boolean {
    if (this.playback.playing || this.state.status !== 'RUNNING') return false;
    this.state = skipToCandleEnd(this.state);
    this.publish();
    return true;
  }

  // ----- Trading (allowed while playing or paused) -----

  order(ticker: string, side: Side, quantityText: string): void {
    this.state = submitLiveOrder(this.state, ticker, side, quantityText);
    this.publish();
  }

  // ----- Sessions -----

  /** Back to the start of the same market: same prices, all cash, no shares. Pauses. */
  reset(): void {
    this.playback.pause();
    this.state = resetLive(this.state);
    this.publish();
  }

  /** A different market. Pauses. */
  newSession(seed: number, options: LiveOptions = {}): void {
    this.playback.pause();
    this.state = createLiveSession(seed, options);
    this.publish();
  }

  /** Stops the timer when the page goes away. */
  dispose(): void {
    this.playback.dispose();
  }

  // ----- Internals -----

  private timerTick(): boolean {
    this.state = advanceLive(this.state, 1);
    this.publish();
    return this.state.status === 'RUNNING';
  }

  private buildSnapshot(): LiveSnapshot {
    return {
      view: getLiveView(this.state),
      playing: this.playback.playing,
      speed: this.playback.speed,
      canStep: !this.playback.playing && this.state.status === 'RUNNING',
    };
  }

  private publish(): void {
    this.snapshot = this.buildSnapshot();
    for (const listener of [...this.listeners]) listener();
  }

  /** TEST ONLY: the private state. The UI must never call this. */
  peekStateForTests(): LiveState {
    return this.state;
  }
}
