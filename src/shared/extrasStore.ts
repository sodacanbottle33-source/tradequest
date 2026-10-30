// What the page knows about the daily prediction, the market events and teams (docs/world.md §37, §38, §39). Like the goals, it changes on its own (a guess is judged at midnight,
// an event starts at 21:00 Tokyo time, a teammate joins), so it is kept apart from the market store and only the screens that show it read it.
//
//   • predict: today's featured stock, the player's guess and his record. Asked for when he signs in and when the day changes; the live stream's "predicted" event says a guess was judged.
//   • events: when the next market event starts, the one happening now and the last few. The live stream's "marketevent" event says one started.
//   • teamsVersion: a number that goes up when the live stream says something about the player's team changed ("teams" event); the Teams page asks again when it changes.
//   The server's clock is used for every countdown (the page keeps the difference between the two clocks), so a wrong clock on the player's computer cannot show a wrong time.
import { useEffect, useState, useSyncExternalStore } from 'react';
import { api } from './api';
import type { MarketEventsView, PredictView } from './types';

export interface ExtrasState {
  readonly predict: PredictView | null;
  readonly predictSkewMs: number;
  readonly events: MarketEventsView | null;
  readonly eventsSkewMs: number;
  readonly teamsVersion: number;
}

const EMPTY: ExtrasState = { predict: null, predictSkewMs: 0, events: null, eventsSkewMs: 0, teamsVersion: 0 };

class ExtrasStore {
  private state: ExtrasState = EMPTY;
  private readonly listeners = new Set<() => void>();
  private loadingPredict = false;
  private loadingEvents = false;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): ExtrasState => this.state;

  private set(next: Partial<ExtrasState>): void {
    this.state = { ...this.state, ...next };
    for (const l of this.listeners) l();
  }

  /** Asks the server for today's featured stock (also asked when the day has changed or a guess was judged). Asking also lets the server judge yesterday's guess. */
  async loadPredict(): Promise<void> {
    if (this.loadingPredict) return;
    this.loadingPredict = true;
    try {
      this.setPredict(await api.predict());
    } catch {
      // the prediction is a nicety: the card stays as it was
    } finally {
      this.loadingPredict = false;
    }
  }

  /** The server's answer is the whole new picture (after making the guess). */
  setPredict(view: PredictView): void {
    this.set({ predict: view, predictSkewMs: view.serverMs - Date.now() });
  }

  async loadEvents(): Promise<void> {
    if (this.loadingEvents) return;
    this.loadingEvents = true;
    try {
      const view = await api.marketEvents();
      this.set({ events: view, eventsSkewMs: view.serverMs - Date.now() });
    } catch {
      // the events strip is a nicety: it stays as it was
    } finally {
      this.loadingEvents = false;
    }
  }

  /** The live stream says something about this player's team changed. */
  onTeams(): void {
    this.set({ teamsVersion: this.state.teamsVersion + 1 });
  }

  /** The player signed out: forget everything. */
  clear(): void {
    this.state = EMPTY;
    for (const l of this.listeners) l();
  }
}

export const extrasStore = new ExtrasStore();

/** How often the page looks at the clock for a new day or the time of an event, and counts the time left down. */
export const EXTRAS_CLOCK_MS = 30_000;

/** True while the featured stock of today is there and the player has not made his guess yet (the Goals tab counts it as one more thing to do). */
export function predictOpen(view: PredictView | null, nowMs: number): boolean {
  return view !== null && view.company !== null && view.company.priceCents !== null && view.mine === null && nowMs < view.endMs;
}

/** Today's prediction for a screen, and the server's time now. Asks again by itself when the day has changed. */
export function usePredict(): { view: PredictView | null; nowMs: number } {
  const { predict, predictSkewMs } = useSyncExternalStore(extrasStore.subscribe, extrasStore.getSnapshot, extrasStore.getSnapshot);
  const [, bump] = useState(0);
  useEffect(() => {
    const id = setInterval(() => bump((n) => n + 1), EXTRAS_CLOCK_MS);
    return () => clearInterval(id);
  }, []);
  const nowMs = Date.now() + predictSkewMs;
  const over = predict !== null && nowMs >= predict.endMs;
  useEffect(() => {
    if (over) void extrasStore.loadPredict();
  }, [over]);
  return { view: predict, nowMs };
}

/** The market events for a screen, and the server's time now. Asks again when the time of the next event has passed. */
export function useMarketEvents(): { view: MarketEventsView | null; nowMs: number } {
  const { events, eventsSkewMs } = useSyncExternalStore(extrasStore.subscribe, extrasStore.getSnapshot, extrasStore.getSnapshot);
  const [, bump] = useState(0);
  useEffect(() => {
    const id = setInterval(() => bump((n) => n + 1), EXTRAS_CLOCK_MS);
    return () => clearInterval(id);
  }, []);
  const nowMs = Date.now() + eventsSkewMs;
  const due = events !== null && events.next !== null && nowMs >= events.next.atMs;
  useEffect(() => {
    if (due) void extrasStore.loadEvents();
  }, [due]);
  return { view: events, nowMs };
}

/** A number that goes up when the player's team changed (the Teams page asks again). */
export function useTeamsVersion(): number {
  return useSyncExternalStore(extrasStore.subscribe, extrasStore.getSnapshot, extrasStore.getSnapshot).teamsVersion;
}
