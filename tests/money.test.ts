// R-01 … R-09, PNL-08/09/12 formatting — test-cases.md §1, §8.
import { describe, expect, it } from 'vitest';
import {
  floorDiv,
  formatCents,
  formatPercent,
  formatSignedCents,
  roundHalfUpRatio,
  START_CASH,
} from '../src/engine';
import { Mulberry32 } from '../src/engine';

describe('roundHalfUpRatio (§3.4)', () => {
  it('R-01: 7/2 = 3.5 → 4', () => expect(roundHalfUpRatio(7, 2)).toBe(4));
  it('R-02: 5/2 = 2.5 → 3', () => expect(roundHalfUpRatio(5, 2)).toBe(3));
  it('R-03: 10/3 = 3.33 → 3', () => expect(roundHalfUpRatio(10, 3)).toBe(3));
  it('R-04: 20/3 = 6.67 → 7', () => expect(roundHalfUpRatio(20, 3)).toBe(7));
  it('R-05: 0/5 → 0', () => expect(roundHalfUpRatio(0, 5)).toBe(0));
  it('R-06: 380000/15 = 25333.33 → 25333', () => expect(roundHalfUpRatio(380000, 15)).toBe(25333));
  it('R-07: exact division 38000/1 → 38000', () => expect(roundHalfUpRatio(38000, 1)).toBe(38000));

  it('R-08: large values stay exact (compared with BigInt)', () => {
    const rng = new Mulberry32(2024);
    for (let i = 0; i < 20000; i += 1) {
      const a = Math.floor(rng.next() * 1e15);
      const b = 1 + Math.floor(rng.next() * 1e6);
      const expected = Number((2n * BigInt(a) + BigInt(b)) / (2n * BigInt(b)));
      expect(roundHalfUpRatio(a, b)).toBe(expected);
      expect(floorDiv(a, b)).toBe(Number(BigInt(a) / BigInt(b)));
    }
    // Exact halves at large magnitudes still round up.
    expect(roundHalfUpRatio(2 * 999_999_999_999 + 1, 2)).toBe(1_000_000_000_000);
  });

  it('rejects negative numerators, zero denominators and non-integers', () => {
    expect(() => roundHalfUpRatio(-1, 2)).toThrow();
    expect(() => roundHalfUpRatio(1, 0)).toThrow();
    expect(() => roundHalfUpRatio(1.5, 2)).toThrow();
  });
});

describe('Display formatting (§3.4–3.6)', () => {
  it('R-09: dollar formatting', () => {
    expect(formatCents(253336)).toBe('$2,533.36');
    expect(formatCents(5)).toBe('$0.05');
    expect(formatCents(0)).toBe('$0.00');
    expect(formatCents(-1467)).toBe('−$14.67');
    expect(formatCents(123456789)).toBe('$1,234,567.89');
  });

  it('signed P&L shows + for gains', () => {
    expect(formatSignedCents(467)).toBe('+$4.67');
    expect(formatSignedCents(0)).toBe('$0.00');
    expect(formatSignedCents(-1467)).toBe('−$14.67');
  });

  it('PNL-08: return % for equity 101750 is 1.75%', () => {
    expect(formatPercent(101750 - START_CASH, START_CASH)).toBe('1.75%');
  });

  it('PNL-09: return % for equity 99000 is −1.00%', () => {
    expect(formatPercent(99000 - START_CASH, START_CASH)).toBe('−1.00%');
  });

  it('PNL-12: negative values round their magnitude half-up, then get the sign', () => {
    expect(formatPercent(-5, START_CASH)).toBe('−0.01%');
    expect(formatPercent(5, START_CASH)).toBe('0.01%');
    expect(formatPercent(-4, START_CASH)).toBe('0.00%');
    expect(formatPercent(0, START_CASH)).toBe('0.00%');
  });
});
