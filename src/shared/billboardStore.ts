// What the page knows about the billboard (docs/world.md §30): the three places and what each one shows. It is separate from the market store because it changes on its
// own (somebody books a place, a booking runs out) and only the strip at the top of the Market and Memecoins tabs and the booking card read it.
//
//   • The list is fetched when the page connects (also for a visitor who is not signed in: the market is public) and again after a reconnect or a sign-in, and kept fresh by
//     the "billboard" event of the live stream. A signed-in player's answer also carries his cash and the companies he launched.
//   • A booking ends by itself. The server does not announce that, so the page works it out from the end time of each booking, using the SERVER's clock (the page keeps the
//     difference between the two clocks, so a wrong clock on the player's computer cannot show a booking too long or hide it too early).
import { useEffect, useState, useSyncExternalStore } from 'react';
import { api } from './api';
import type { BillboardSlotView, BillboardView } from './types';

export interface BillboardState {
  readonly view: BillboardView | null;
  /** Server clock minus this computer's clock (ms) at the moment the list arrived. */
  readonly skewMs: number;
}

const EMPTY: BillboardState = { view: null, skewMs: 0 };

/** The places with every booking that is over by `nowMs` taken out. */
export function liveSlots(slots: readonly BillboardSlotView[], nowMs: number): BillboardSlotView[] {
  return slots.map((s) => (s.rental && s.rental.endsMs > nowMs ? s : { slot: s.slot, rental: null }));
}

class BillboardStore {
  private state: BillboardState = EMPTY;
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): BillboardState => this.state;

  private set(next: BillboardState): void {
    this.state = next;
    for (const l of this.listeners) l();
  }

  /** Loads the billboard (called when the page connects, after a sign-in and after a reconnect, so no change is missed). */
  async load(): Promise<void> {
    try {
      const view = await api.billboard();
      this.set({ view, skewMs: view.serverMs - Date.now() });
    } catch {
      // the billboard is a nicety: the strip simply stays as it was
    }
  }

  /** The player just booked: the server's answer is the whole new picture. */
  setView(view: BillboardView): void {
    this.set({ view, skewMs: view.serverMs - Date.now() });
  }

  /** The live stream says what the three places show now (it never carries a player's own things, so his stay as they are). */
  onEvent(d: { slots: readonly BillboardSlotView[] }): void {
    const cur = this.state.view;
    if (!cur || !Array.isArray(d.slots)) {
      void this.load();
      return;
    }
    this.set({ ...this.state, view: { ...cur, slots: d.slots } });
  }

  /** The player signed out: forget his cash and his companies. */
  clearMine(): void {
    const cur = this.state.view;
    if (cur && cur.mine) this.set({ ...this.state, view: { ...cur, mine: null } });
  }
}

export const billboardStore = new BillboardStore();

/** How often the strip looks at the clock to take out a booking that ended and to count down the time left. */
export const BILLBOARD_CLOCK_MS = 15_000;

/** The billboard for a screen: the places (a booking that is over is already taken out), the server's time now, and the rest of the answer. */
export function useBillboard(): { view: BillboardView | null; slots: BillboardSlotView[]; nowMs: number } {
  const { view, skewMs } = useSyncExternalStore(billboardStore.subscribe, billboardStore.getSnapshot, billboardStore.getSnapshot);
  const [, bump] = useState(0);
  useEffect(() => {
    const id = setInterval(() => bump((n) => n + 1), BILLBOARD_CLOCK_MS);
    return () => clearInterval(id);
  }, []);
  const nowMs = Date.now() + skewMs;
  return { view, slots: view ? liveSlots(view.slots, nowMs) : [], nowMs };
}
