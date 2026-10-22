// The only source of real randomness: picking a seed for a NEW round (rules.md §8).
// It lives outside the engine on purpose — the engine only ever uses the seeded RNG.

export interface RandomValuesSource {
  getRandomValues(array: Uint32Array<ArrayBuffer>): unknown;
}

/** Random unsigned 32-bit seed from crypto.getRandomValues. `source` is replaceable for tests. */
export function randomSeed(source: RandomValuesSource = globalThis.crypto): number {
  const buffer = new Uint32Array(1);
  source.getRandomValues(buffer);
  return buffer[0] ?? 0;
}
