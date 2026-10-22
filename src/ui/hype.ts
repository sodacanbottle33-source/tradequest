// The "hype" helpers behind the price animations: how many times its starting price a company is worth now, which milestone
// (2x, 5x, 10x ...) a rise has just crossed, and the confetti for the celebration. Pure functions, nothing here touches a
// price, an order or the database: the page only LOOKS at the live price it already has.

export interface Milestone {
  /** The multiple of the starting price (2 = doubled). */
  readonly x: number;
  /** The big text of the celebration. */
  readonly label: string;
  /** The line under it. */
  readonly tag: string;
  /** The big symbol that flies up with it. */
  readonly icon: string;
  /** How loud the celebration is: 1 = a small burst, 2 = a big burst, 3 = confetti everywhere, the screen shakes and flashes. */
  readonly level: 1 | 2 | 3;
  /** Confetti pieces and how long the celebration stays on the screen (ms). */
  readonly particles: number;
  readonly durationMs: number;
}

export const MILESTONES: readonly Milestone[] = [
  { x: 2, label: '2x', tag: 'Doubled!', icon: '📈', level: 1, particles: 26, durationMs: 2600 },
  { x: 5, label: '5x', tag: 'Going parabolic!', icon: '🚀', level: 2, particles: 52, durationMs: 3400 },
  { x: 10, label: '10x', tag: 'TO THE MOON!', icon: '🌕', level: 3, particles: 96, durationMs: 4600 },
  { x: 25, label: '25x', tag: 'Absolute madness!', icon: '🔥', level: 3, particles: 110, durationMs: 4800 },
  { x: 50, label: '50x', tag: 'Legendary run!', icon: '👑', level: 3, particles: 120, durationMs: 5000 },
  { x: 100, label: '100x', tag: 'Hall of fame!', icon: '💎', level: 3, particles: 140, durationMs: 5400 },
];

/** How many times its starting price a price is. 0 when either number is not a real price. */
export function multipleOf(priceCents: number, baseCents: number): number {
  if (!(priceCents > 0) || !(baseCents > 0) || !Number.isFinite(priceCents) || !Number.isFinite(baseCents)) return 0;
  return priceCents / baseCents;
}

/** The biggest milestone a multiple has reached (null below 2x). */
export function milestoneFor(multiple: number): Milestone | null {
  let hit: Milestone | null = null;
  for (const m of MILESTONES) if (multiple >= m.x) hit = m;
  return hit;
}

/**
 * The milestones a rise from `before` to `now` crossed (both multiples). A fall crosses nothing, and a milestone that was
 * already reached before is not crossed again. The biggest one is `top`; `all` lists every one that was passed (a jump from
 * 1.5x to 12x passes 2x, 5x and 10x), so the page can mark them all as seen.
 */
export function crossedMilestones(before: number, now: number): { top: Milestone | null; all: readonly Milestone[] } {
  if (!(now > before)) return { top: null, all: [] };
  const all = MILESTONES.filter((m) => before < m.x && now >= m.x);
  return { top: all.length > 0 ? (all[all.length - 1] as Milestone) : null, all };
}

/** "2.4x", "10x", "12.5x", "137x": the multiple as it is shown on the badge. */
export function formatMultiple(multiple: number): string {
  if (!(multiple > 0)) return '—';
  if (multiple >= 100) return `${Math.round(multiple)}x`;
  const rounded = Math.round(multiple * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}x`;
}

export type Direction = 'up' | 'down';

/** Which way a price moved (null: it did not move, or one of the two is not a real price, e.g. a company that has not listed yet). */
export function directionOf(before: number, now: number): Direction | null {
  if (!(before > 0) || !(now > 0) || before === now) return null;
  return now > before ? 'up' : 'down';
}

/** A move worth a floating "+1.2%" label: at least `minBps` (hundredths of a percent) either way. */
export function moveLabel(before: number, now: number, minBps = 25): string | null {
  if (!(before > 0) || !(now > 0)) return null;
  const bps = Math.round(((now - before) / before) * 10_000);
  if (Math.abs(bps) < minBps) return null;
  const pct = Math.abs(bps) / 100;
  return `${bps > 0 ? '+' : '−'}${pct < 10 ? pct.toFixed(2) : pct.toFixed(1)}%`;
}

export interface Piece {
  /** Where it flies to (px from the middle of the burst) and how far it turns. */
  readonly dx: number;
  readonly dy: number;
  readonly rot: number;
  /** Start delay and flight time (ms), size (px) and colour. */
  readonly delay: number;
  readonly time: number;
  readonly size: number;
  readonly color: string;
  /** 0 = a little rectangle, 1 = a circle, 2 = a star-ish diamond. */
  readonly shape: 0 | 1 | 2;
}

const COLORS = ['#22c55e', '#4ade80', '#86efac', '#f5b83d', '#fde68a', '#ffffff', '#60a5fa', '#f472b6'];

/** A small seeded random generator, so the same celebration always scatters the same way (and a test can check it). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** The confetti of one celebration: flies out in all directions, mostly upward, the bigger milestones further. */
export function piecesFor(seed: number, m: Milestone): Piece[] {
  const rnd = mulberry32(seed * 7919 + m.x * 104_729);
  const reach = m.level === 1 ? 190 : m.level === 2 ? 290 : 430;
  const out: Piece[] = [];
  for (let i = 0; i < m.particles; i++) {
    const angle = rnd() * Math.PI * 2;
    const dist = reach * (0.35 + 0.65 * rnd());
    out.push({
      dx: Math.round(Math.cos(angle) * dist),
      // Upwards is stronger than downwards: a fountain, and the pieces drop a little before they fade (the CSS adds the fall).
      dy: Math.round(Math.sin(angle) * dist * (Math.sin(angle) < 0 ? 1 : 0.55)),
      rot: Math.round((rnd() - 0.5) * 900),
      delay: Math.round(rnd() * 260),
      time: Math.round(1300 + rnd() * 1300),
      size: Math.round(6 + rnd() * (m.level === 3 ? 10 : 7)),
      color: COLORS[Math.floor(rnd() * COLORS.length)] as string,
      shape: Math.floor(rnd() * 3) as 0 | 1 | 2,
    });
  }
  return out;
}
