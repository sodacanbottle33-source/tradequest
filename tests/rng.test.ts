// RNG-01 … RNG-08 — test-cases.md §2.
import { describe, expect, it } from 'vitest';
import { Mulberry32, normalZ } from '../src/engine';
import reference from './fixtures/reference-v1.json';
import { ScriptedRng } from './helpers/rounds';

function take(seed: number, n: number): number[] {
  const rng = new Mulberry32(seed);
  return Array.from({ length: n }, () => rng.next());
}

describe('Mulberry32 (§5.1)', () => {
  it('RNG-01: same seed gives the same 10,000 outputs', () => {
    expect(take(777, 10000)).toEqual(take(777, 10000));
  });

  it('RNG-02: every output is in [0, 1)', () => {
    for (const seed of [0, 1, 12345, 4294967295, 99999]) {
      for (const u of take(seed, 10000)) {
        expect(u >= 0 && u < 1).toBe(true);
      }
    }
  });

  it('RNG-03: seeds 1 and 2 give different sequences', () => {
    expect(take(1, 10)).not.toEqual(take(2, 10));
  });

  it('RNG-04: edge seeds 0 and 4294967295 work without NaN', () => {
    for (const seed of [0, 4294967295]) {
      for (const u of take(seed, 1000)) expect(Number.isNaN(u)).toBe(false);
    }
  });

  it('RNG-04b: invalid seeds are refused', () => {
    expect(() => new Mulberry32(-1)).toThrow();
    expect(() => new Mulberry32(4294967296)).toThrow();
    expect(() => new Mulberry32(1.5)).toThrow();
  });

  it('RNG-05: outputs match the independent Python reference (tools/reference_engine.py)', () => {
    const golden = reference.rngFirstFive as Record<string, number[]>;
    for (const seed of ['12345', '0', '4294967295']) {
      expect(take(Number(seed), 5)).toEqual(golden[seed]);
    }
  });

  it('RNG-06: mean of 100,000 outputs ≈ 0.5', () => {
    const values = take(4242, 100000);
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    expect(Math.abs(mean - 0.5)).toBeLessThan(0.01);
  });
});

describe('normalZ (§5.2)', () => {
  it('RNG-07: uses exactly 12 draws and stays within [−6, 6]', () => {
    const stub = new ScriptedRng({}, 0.999999);
    const z = normalZ(stub);
    expect(stub.draws).toBe(12);
    expect(z).toBeLessThanOrEqual(6);
    expect(normalZ(new ScriptedRng({}, 0))).toBe(-6);
    const rng = new Mulberry32(5);
    for (let i = 0; i < 10000; i += 1) {
      const v = normalZ(rng);
      expect(v >= -6 && v <= 6).toBe(true);
    }
  });

  it('RNG-08: mean ≈ 0 and standard deviation ≈ 1 over 100,000 values', () => {
    const rng = new Mulberry32(31337);
    const n = 100000;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < n; i += 1) {
      const z = normalZ(rng);
      sum += z;
      sumSq += z * z;
    }
    const mean = sum / n;
    const sd = Math.sqrt(sumSq / n - mean * mean);
    expect(Math.abs(mean)).toBeLessThan(0.02);
    expect(Math.abs(sd - 1)).toBeLessThan(0.02);
  });
});
