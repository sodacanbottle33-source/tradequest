// The little show that plays when the server says a player earned a badge: a medal pops in with sparkles. A bronze or silver badge is a small
// card at the bottom of the screen; a gold or diamond one is bigger, in the middle, with a shine and many more sparkles; a secret badge also
// flips from a "?" to its picture. This file is only the rules and the emitter (what to show, how long, where each sparkle flies); the page
// that draws it is BadgeUnlock.tsx.
//
// Looks only. Nothing here gives a badge or changes a number: the server decides who earned what (server/badges.ts), and the page plays the
// show once for the ids the server just announced.
import { BADGES, badgeById, type BadgeTier } from './badgeCatalog';

export interface BadgeShow {
  readonly id: string;
  readonly name: string;
  readonly how: string;
  readonly icon: string;
  readonly tier: BadgeTier;
  readonly secret: boolean;
  /** Gold and diamond badges get the big show in the middle of the screen. */
  readonly big: boolean;
  /** How many sparkles fly out. */
  readonly sparkles: number;
  /** How long the show stays (milliseconds). */
  readonly ms: number;
  /** Makes the sparkles scatter the same way for the same badge. */
  readonly seed: number;
}

/** The sparkles and the time of each tier: bronze, silver, gold, diamond. A secret badge gets a few more sparkles. */
const SPARKLES: readonly number[] = [0, 6, 10, 26, 48];
const SECRET_EXTRA = 8;
const MS: readonly number[] = [0, 2800, 3200, 5000, 6000];
/** At most this many shows wait in line behind the one that is playing (the pop-up lists every badge anyway). */
export const MAX_WAITING = 3;

function seedOf(text: string, n: number): number {
  let h = 29 + n;
  for (let i = 0; i < text.length; i += 1) h = (h * 33 + text.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** The show of one badge, or null for an id this version does not know. */
export function showOf(id: string, n = 0): BadgeShow | null {
  const def = badgeById(id);
  if (!def) return null;
  const secret = def.secret === true;
  return {
    id: def.id,
    name: def.name,
    how: def.how,
    icon: def.icon,
    tier: def.tier,
    secret,
    big: def.tier >= 3,
    sparkles: (SPARKLES[def.tier] as number) + (secret ? SECRET_EXTRA : 0),
    ms: MS[def.tier] as number,
    seed: seedOf(def.id, n),
  };
}

/** At most this many badges of one batch get a show (the pop-up lists all of them): the best one in full, a second one as a quick small card. */
export const MAX_PER_BATCH = 2;

/** The shows of a batch of badges, the best first (by tier, then the order of the catalog); unknown ids are left out. Only the best gets its full show. */
export function showsOf(ids: readonly string[], n = 0): BadgeShow[] {
  const order = new Map(BADGES.map((b, i) => [b.id, i]));
  return ids
    .map((id) => showOf(id, n))
    .filter((s): s is BadgeShow => s !== null)
    .sort((a, b) => b.tier - a.tier || (order.get(a.id) as number) - (order.get(b.id) as number))
    .slice(0, MAX_PER_BATCH)
    .map((s, i) => (i === 0 ? s : { ...s, big: false, sparkles: Math.min(s.sparkles, SPARKLES[2] as number), ms: MS[1] as number }));
}

export interface Sparkle {
  /** Where it flies to, in pixels from the middle of the medal. */
  readonly dx: number;
  readonly dy: number;
  readonly delay: number;
  readonly time: number;
  readonly size: number;
  readonly rot: number;
  readonly shape: 0 | 1 | 2;
  /** 0 = gold, 1 = white, 2 = teal. */
  readonly tone: 0 | 1 | 2;
}

function rng(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Where each sparkle goes: spread round the medal (evenly, with some wobble), nearer for a small show and farther for a big one. The same seed always gives the same sparkles. */
export function sparklesFor(seed: number, count: number, big: boolean): Sparkle[] {
  const rand = rng(seed);
  const out: Sparkle[] = [];
  for (let i = 0; i < count; i += 1) {
    const angle = ((i + rand() * 0.8) / Math.max(1, count)) * Math.PI * 2;
    const reach = big ? 70 + rand() * 120 : 34 + rand() * 40;
    out.push({
      dx: Math.round(Math.cos(angle) * reach),
      dy: Math.round(Math.sin(angle) * reach - (big ? 20 : 8)),
      delay: Math.round(rand() * (big ? 700 : 350)),
      time: Math.round(700 + rand() * 700),
      size: Math.round((big ? 7 : 4) + rand() * (big ? 9 : 4)),
      rot: Math.round(rand() * 360),
      shape: Math.floor(rand() * 3) as 0 | 1 | 2,
      tone: Math.floor(rand() * 3) as 0 | 1 | 2,
    });
  }
  return out;
}

// ---- the page plays them one at a time ----------------------------------------------------------------------------------

type Listener = (shows: readonly BadgeShow[]) => void;
const listeners = new Set<Listener>();
let counter = 0;

/** Plays the show of the badges the player just earned on the page that is open (nothing happens when no page is listening, e.g. in a test). */
export function playBadgeShow(ids: readonly string[]): void {
  counter += 1;
  const shows = showsOf(ids, counter);
  if (shows.length === 0) return;
  for (const l of [...listeners]) l(shows);
}

/** The page's badge layer listens here. Returns the way to stop listening. */
export function onBadgeShow(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
