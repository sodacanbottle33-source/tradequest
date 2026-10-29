// What the page knows about the "while you were away" card (docs/world.md §33). The page asks the server when it connects (the server only has something to say when the player
// was away for a while), keeps the answer until the player closes the card, and tells the server when he does. The report itself is made on the server; nothing here decides.
import { useSyncExternalStore } from 'react';
import { api } from './api';
import type { AwayView } from './types';

export interface AwayState {
  readonly away: AwayView | null;
}

const EMPTY: AwayState = { away: null };

class AwayStore {
  private state: AwayState = EMPTY;
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): AwayState => this.state;

  private set(next: AwayState): void {
    this.state = next;
    for (const l of this.listeners) l();
  }

  /** Asks whether there is something to tell. A card that is already open is never taken away by this (only closing it does that). */
  async load(): Promise<void> {
    try {
      const res = await api.away();
      if (res.away) this.set({ away: res.away });
    } catch {
      // nothing to say is the safe answer
    }
  }

  /** The player closed the card. */
  async dismiss(): Promise<void> {
    this.set(EMPTY);
    try {
      await api.dismissAway();
    } catch {
      // the next visit shows the card again at worst
    }
  }

  /** The player signed out. */
  clear(): void {
    this.set(EMPTY);
  }
}

export const awayStore = new AwayStore();

export function useAway(): AwayView | null {
  return useSyncExternalStore(awayStore.subscribe, awayStore.getSnapshot, awayStore.getSnapshot).away;
}
