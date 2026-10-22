// Seeded random number generator — see docs/rules.md §5.1–5.2.
// This is the ONLY file in the engine allowed to use bitwise operators and Math.imul.

export interface RandomSource {
  /** Next number u with 0 ≤ u < 1. */
  next(): number;
}

export class Mulberry32 implements RandomSource {
  private state: number;
  /** How many numbers have been drawn so far (used by tests to check draw order). */
  draws = 0;

  constructor(seed: number) {
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
      throw new Error(`Seed must be an unsigned 32-bit integer, got ${seed}`);
    }
    this.state = seed;
  }

  next(): number {
    this.draws += 1;
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}

/** Approximately standard-normal number: sum of 12 uniforms minus 6. Uses exactly 12 draws (§5.2). */
export function normalZ(rng: RandomSource): number {
  let sum = 0;
  for (let i = 0; i < 12; i += 1) sum += rng.next();
  return sum - 6;
}

/**
 * Derives an independent 32-bit seed for sub-stream `index` from a base seed (market mode, rules.md §12.3).
 * Integer-only (Murmur3 finalizer), so the same (seed, index) always gives the same stream seed.
 */
export function deriveSeed(seed: number, index: number): number {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new Error(`Seed must be an unsigned 32-bit integer, got ${seed}`);
  }
  if (!Number.isInteger(index) || index < 0 || index > 0xffff) throw new Error(`Bad stream index ${index}`);
  let h = (seed + Math.imul(index + 1, 0x9e3779b1)) | 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * The k-th number (k ≥ 1) that `new Mulberry32(seed)` would return, computed directly without drawing the
 * k−1 before it. Mulberry32's state after k draws is simply seed + k·0x6d2b79f5 (mod 2^32), so any draw can be
 * reached in one step. Live market mode (rules.md §13.3) uses this to read any tick of a stock's stream.
 */
export function uniformAt(seed: number, k: number): number {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new Error(`Seed must be an unsigned 32-bit integer, got ${seed}`);
  }
  if (!Number.isInteger(k) || k < 1 || k > 0xffffffff) throw new Error(`Draw number must be 1 or more, got ${k}`);
  const state = (seed + Math.imul(k, 0x6d2b79f5)) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/**
 * The k-th number of a counter-based stream for the persistent world (docs/world.md §5.1): the Murmur3 finalizer applied to
 * seed + k·0x9e3779b1. For a fixed seed the map k → 32-bit value is a bijection (an odd multiplier followed by invertible
 * mixing steps), so over a whole period every value occurs exactly once and the mean is exactly right. Mulberry32 (used by
 * the older engines) is NOT a bijection of its counter and has a tiny but measurable bias (mean ≈ 0.49997), which would
 * add up to a slow drift in a market that runs for months — that is why the world uses this function instead.
 * No argument checks (the inner loop calls this billions of times): the caller guarantees 0 ≤ seed < 2^32, 0 ≤ k < 2^32.
 */
export function hashUniformAt(seed: number, k: number): number {
  let h = (seed + Math.imul(k, 0x9e3779b1)) | 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * A normal-ish number from six consecutive draws k … k+5 of a stream: (sum − 3) · √2 (mean 0, variance 1, never beyond
 * ±4.25). Used by the persistent world (docs/world.md §5.1).
 */
export function normal6At(seed: number, k: number): number {
  const sum =
    hashUniformAt(seed, k) +
    hashUniformAt(seed, k + 1) +
    hashUniformAt(seed, k + 2) +
    hashUniformAt(seed, k + 3) +
    hashUniformAt(seed, k + 4) +
    hashUniformAt(seed, k + 5);
  return (sum - 3) * 1.4142135623730951;
}
