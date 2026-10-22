// Integer-cent helpers — see docs/rules.md §3.

function assertSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be a safe integer, got ${value}`);
  }
}

/**
 * roundHalfUp(a / b) for integers a ≥ 0, b > 0, computed exactly.
 * Formula: floor((2a + b) / (2b)). The floating-point division only gives a
 * first guess; the two correction loops make the result exact.
 */
export function roundHalfUpRatio(a: number, b: number): number {
  assertSafeInteger(a, 'a');
  assertSafeInteger(b, 'b');
  if (a < 0) throw new Error(`roundHalfUpRatio needs a ≥ 0, got ${a}`);
  if (b <= 0) throw new Error(`roundHalfUpRatio needs b > 0, got ${b}`);
  const num = 2 * a + b;
  const den = 2 * b;
  assertSafeInteger(num, '2a + b');
  return floorDiv(num, den);
}

/** floor(a / b) for integers a ≥ 0, b > 0, computed exactly. */
export function floorDiv(a: number, b: number): number {
  assertSafeInteger(a, 'a');
  assertSafeInteger(b, 'b');
  if (a < 0 || b <= 0) throw new Error(`floorDiv needs a ≥ 0 and b > 0, got ${a}, ${b}`);
  let q = Math.floor(a / b);
  while (q * b > a) q -= 1;
  while ((q + 1) * b <= a) q += 1;
  return q;
}

/** roundHalfUp of a positive floating-point price: floor(x + 0.5). Used only by the price engine (§5.4). */
export function roundHalfUpFloat(x: number): number {
  return Math.floor(x + 0.5);
}

/** Development check that a stored money/share value is a safe integer (§3.7). */
export function assertMoney(value: number, name: string): void {
  assertSafeInteger(value, name);
}
