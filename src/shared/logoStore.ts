// What the page knows about the pictures of stocks and memecoins (docs/world.md §20). It is separate from the market store because it changes
// on its own (a launcher sets a picture) and only the small logos read it.
//
//   • pictures: ticker -> version of its picture. A company without a picture is not in it. The list is fetched when the page connects (also
//     for a visitor who is not signed in: the market is public) and kept fresh by the "company_picture" event of the live stream. The picture
//     itself is /api/company-picture/<ticker>?v=<version>: a browser keeps it for good as long as the version stays the same.
import { useSyncExternalStore } from 'react';
import { api } from './api';

export interface LogoState {
  readonly pictures: Readonly<Record<string, number>>;
}

const EMPTY: LogoState = { pictures: {} };

/** The address of a company's picture. */
export function companyPictureUrl(ticker: string, version: number): string {
  return `/api/company-picture/${encodeURIComponent(ticker)}?v=${version}`;
}

class LogoStore {
  private state: LogoState = EMPTY;
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): LogoState => this.state;

  private set(next: LogoState): void {
    this.state = next;
    for (const l of this.listeners) l();
  }

  /** Loads the list of pictures (called when the page connects, and again after a reconnect so no change is missed). */
  async load(): Promise<void> {
    try {
      const out = await api.companyPictures();
      this.set({ pictures: out.pictures });
    } catch {
      // the pictures are a nicety: the letters show instead
    }
  }

  /** The live stream says a picture was set (v = its version) or removed (v = null). */
  onPicture(d: { ticker: string; v: number | null }): void {
    const next = { ...this.state.pictures };
    if (d.v === null) delete next[d.ticker];
    else next[d.ticker] = d.v;
    this.set({ pictures: next });
  }
}

export const logoStore = new LogoStore();

export function useLogos(): LogoState {
  return useSyncExternalStore(logoStore.subscribe, logoStore.getSnapshot, logoStore.getSnapshot);
}
