// What the page knows about the player's daily goals (docs/world.md §32): today's three goals, the streak and the free looks. It is separate from the market store because it
// changes on its own (a goal is paid while the player trades or learns somewhere else) and only the Goals page and the number on its tab read it.
//
//   • The page asks when it connects or the player signs in. Asking also lets the server pay any goal he has just finished.
//   • The live stream's "goals" event says something was paid: the page asks again.
//   • At 00:00 Tokyo time the goals change. The server does not announce that, so the page works it out from the end time of the day, using the SERVER's clock (the page keeps the
//     difference between the two clocks, so a wrong clock on the player's computer cannot show yesterday's goals for hours).
import { useEffect, useState, useSyncExternalStore } from 'react';
import { api } from './api';
import type { GoalsView } from './types';

export interface GoalsState {
  readonly view: GoalsView | null;
  /** Server clock minus this computer's clock (ms) at the moment the answer arrived. */
  readonly skewMs: number;
}

const EMPTY: GoalsState = { view: null, skewMs: 0 };

class GoalsStore {
  private state: GoalsState = EMPTY;
  private readonly listeners = new Set<() => void>();
  private loading = false;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): GoalsState => this.state;

  private set(next: GoalsState): void {
    this.state = next;
    for (const l of this.listeners) l();
  }

  /** Asks the server for today's goals (also called when the day has changed or a goal was paid). */
  async load(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try {
      this.setView(await api.goals());
    } catch {
      // the Goals page is a nicety: it stays as it was
    } finally {
      this.loading = false;
    }
  }

  /** The server's answer is the whole new picture (after taking a free look). */
  setView(view: GoalsView): void {
    this.set({ view, skewMs: view.serverMs - Date.now() });
  }

  /** The player signed out: forget everything. */
  clear(): void {
    this.set(EMPTY);
  }
}

export const goalsStore = new GoalsStore();

/** How often the page looks at the clock for a new day and counts the time left down. */
export const GOALS_CLOCK_MS = 30_000;

/** The goals for a screen, and the server's time now. Asks again by itself when the day has changed. */
export function useGoals(): { view: GoalsView | null; nowMs: number } {
  const { view, skewMs } = useSyncExternalStore(goalsStore.subscribe, goalsStore.getSnapshot, goalsStore.getSnapshot);
  const [, bump] = useState(0);
  useEffect(() => {
    const id = setInterval(() => bump((n) => n + 1), GOALS_CLOCK_MS);
    return () => clearInterval(id);
  }, []);
  const nowMs = Date.now() + skewMs;
  const over = view !== null && nowMs >= view.endMs;
  useEffect(() => {
    if (over) void goalsStore.load();
  }, [over]);
  return { view, nowMs };
}
