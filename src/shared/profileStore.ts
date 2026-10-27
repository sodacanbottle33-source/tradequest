// What the page knows about profile pictures and who is online. It is separate from the market store because it changes on its own
// (a picture is set, a player opens or closes a page) and only small parts of the screens read it.
//
//   • avatars: username -> version of his picture. A player without a picture is not in it. The list is fetched once after signing in and
//     kept fresh by the "avatar" event of the live stream. The picture itself is /api/avatar/<username>?v=<version>: a browser keeps it for
//     good as long as the version stays the same.
//   • online: the usernames that have a page open, fetched while a screen that shows the dots is open (every 20 seconds).
import { useSyncExternalStore } from 'react';
import { api } from './api';

export interface ProfileState {
  readonly avatars: Readonly<Record<string, number>>;
  readonly online: ReadonlySet<string>;
}

/** How often the online list is fetched while a screen shows it. */
export const ONLINE_POLL_MS = 20_000;

const EMPTY: ProfileState = { avatars: {}, online: new Set() };

/** The address of a player's picture. */
export function avatarUrl(username: string, version: number): string {
  return `/api/avatar/${encodeURIComponent(username)}?v=${version}`;
}

class ProfileStore {
  private state: ProfileState = EMPTY;
  private readonly listeners = new Set<() => void>();
  private watchers = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private signedIn = false;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): ProfileState => this.state;

  private set(next: Partial<ProfileState>): void {
    this.state = { ...this.state, ...next };
    for (const l of this.listeners) l();
  }

  /** Called when the player signs in (or the page finds he is signed in): loads the pictures. */
  async start(): Promise<void> {
    this.signedIn = true;
    try {
      const out = await api.avatars();
      if (this.signedIn) this.set({ avatars: out.avatars });
    } catch {
      // the pictures are a nicety: the initials show instead
    }
    if (this.watchers > 0) void this.pollOnline();
  }

  /** Called when the player signs out: forget everything. */
  stop(): void {
    this.signedIn = false;
    this.state = EMPTY;
    for (const l of this.listeners) l();
  }

  /** The live stream says a picture was set (v = its version) or removed (v = null). */
  onAvatar(d: { username: string; v: number | null }): void {
    if (!this.signedIn) return;
    const next = { ...this.state.avatars };
    if (d.v === null) delete next[d.username];
    else next[d.username] = d.v;
    this.set({ avatars: next });
  }

  /** A player changed his username: his picture and his online dot move to the new name. */
  onRenamed(from: string, to: string): void {
    if (!this.signedIn) return;
    const key = Object.keys(this.state.avatars).find((k) => k.toLowerCase() === from.toLowerCase());
    const online = [...this.state.online].find((k) => k.toLowerCase() === from.toLowerCase());
    if (key === undefined && online === undefined) return;
    const avatars = { ...this.state.avatars };
    if (key !== undefined) {
      const version = avatars[key] as number;
      delete avatars[key];
      avatars[to] = version;
    }
    const names = new Set(this.state.online);
    if (online !== undefined) {
      names.delete(online);
      names.add(to);
    }
    this.set({ avatars, online: names });
  }

  private async pollOnline(): Promise<void> {
    if (!this.signedIn) return;
    try {
      const out = await api.online();
      if (this.signedIn) this.set({ online: new Set(out.online) });
    } catch {
      // keep what we had
    }
  }

  /** A screen that shows the online dots calls this while it is open; it returns the function that ends it. */
  watchOnline(): () => void {
    this.watchers += 1;
    if (this.watchers === 1) {
      void this.pollOnline();
      this.timer = setInterval(() => void this.pollOnline(), ONLINE_POLL_MS);
    }
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.watchers -= 1;
      if (this.watchers === 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    };
  }
}

export const profileStore = new ProfileStore();

export function useProfiles(): ProfileState {
  return useSyncExternalStore(profileStore.subscribe, profileStore.getSnapshot, profileStore.getSnapshot);
}
