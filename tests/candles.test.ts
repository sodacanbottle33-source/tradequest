// ENG-01 … ENG-14 — test-cases.md §3.
import { describe, expect, it } from 'vitest';
import {
  DRAWS_PER_ROUND,
  ENGINE_VERSION,
  generateCandles,
  generateCandlesFromRng,
  MAX_GAP,
  MAX_MOVE,
  MIN_PRICE,
  Mulberry32,
  START_PRICE_MAX,
  START_PRICE_MIN,
  type Candle,
} from '../src/engine';
import reference from './fixtures/reference-v1.json';
import { fill, ScriptedRng } from './helpers/rounds';

const SEEDS_1000 = Array.from({ length: 1000 }, (_, i) => (i * 2654435761) >>> 0);

function forEveryCandle(seeds: number[], check: (c: Candle, prev: Candle | undefined, seed: number) => void): void {
  for (const seed of seeds) {
    const candles = generateCandles(seed);
    candles.forEach((c, i) => {
      try {
        check(c, candles[i - 1], seed);
      } catch (err) {
        throw new Error(`seed ${seed}, candle ${c.index}: ${(err as Error).message}`);
      }
    });
  }
}

describe('Candle generation (§5.3–5.6)', () => {
  it('ENG-01: a round has exactly 70 candles indexed 1..70', () => {
    const candles = generateCandles(12345);
    expect(candles).toHaveLength(70);
    candles.forEach((c, i) => expect(c.index).toBe(i + 1));
  });

  it('ENG-02: same seed twice gives identical candles', () => {
    expect(generateCandles(98765)).toEqual(generateCandles(98765));
  });

  it('ENG-03: different seeds give different candles', () => {
    expect(generateCandles(1)).not.toEqual(generateCandles(2));
  });

  it('ENG-04: candles match the independent Python reference for seeds 12345, 1 and 4294967295', () => {
    expect(reference.engineVersion).toBe(ENGINE_VERSION);
    const golden = reference.candles as Record<string, Candle[]>;
    for (const seed of ['12345', '1', '4294967295']) {
      expect(generateCandles(Number(seed))).toEqual(golden[seed]);
    }
  });

  it('ENG-05: one round uses exactly 1821 draws', () => {
    const rng = new Mulberry32(12345);
    generateCandlesFromRng(rng);
    expect(rng.draws).toBe(1821);
    expect(DRAWS_PER_ROUND).toBe(1821);
    expect((reference.drawCounts as Record<string, number>)['12345']).toBe(1821);
  });

  it('ENG-06: open of candle 1 is an integer in [2000, 5000] (1,000 seeds)', () => {
    for (const seed of SEEDS_1000) {
      const open1 = generateCandles(seed)[0]!.open;
      expect(Number.isInteger(open1)).toBe(true);
      expect(open1 >= START_PRICE_MIN && open1 <= START_PRICE_MAX).toBe(true);
    }
  });

  it('ENG-07 / ENG-08: every candle has integer values ≥ 100 and a valid high/low (1,000 seeds)', () => {
    forEveryCandle(SEEDS_1000, (c) => {
      for (const v of [c.open, c.high, c.low, c.close]) {
        if (!Number.isInteger(v) || v < MIN_PRICE) throw new Error(`bad value ${v}`);
      }
      if (c.low > Math.min(c.open, c.close)) throw new Error('low above body');
      if (c.high < Math.max(c.open, c.close)) throw new Error('high below body');
    });
  });

  it('ENG-09 / ENG-10: body moves within ±10% and gaps within ±2% (allowing 1 cent and the floor)', () => {
    forEveryCandle(SEEDS_1000, (c, prev) => {
      if (c.close !== MIN_PRICE && Math.abs(c.close - c.open) > c.open * MAX_MOVE + 1) {
        throw new Error(`body move too large: ${c.open} → ${c.close}`);
      }
      if (prev && c.open !== MIN_PRICE && Math.abs(c.open - prev.close) > prev.close * MAX_GAP + 1) {
        throw new Error(`gap too large: ${prev.close} → ${c.open}`);
      }
    });
  });

  it('ENG-11: extreme negative draws floor every price at 100', () => {
    const candles = generateCandlesFromRng(new ScriptedRng({}, 0));
    expect(candles[0]!.open).toBe(2000);
    for (const c of candles) {
      expect(Math.min(c.open, c.high, c.low, c.close)).toBeGreaterThanOrEqual(MIN_PRICE);
    }
    expect(candles[69]).toEqual({ index: 70, open: 100, high: 100, low: 100, close: 100 });
  });

  it('ENG-12: extreme positive draws stay within the caps and remain safe integers', () => {
    const candles = generateCandlesFromRng(new ScriptedRng({}, 0.9999999999));
    candles.forEach((c, i) => {
      for (const v of [c.open, c.high, c.low, c.close]) expect(Number.isSafeInteger(v)).toBe(true);
      expect(c.close - c.open).toBeLessThanOrEqual(c.open * MAX_MOVE + 1);
      const prev = candles[i - 1];
      if (prev) expect(c.open - prev.close).toBeLessThanOrEqual(prev.close * MAX_GAP + 1);
    });
  });

  it('ENG-13 / ENG-14: hand-computed candles 1 and 2 from scripted draws (candle 2 uses draws 28–53)', () => {
    // Worked out on paper from rules.md §5.4 (also cross-checked with tools/reference_engine.py):
    // draw 1 = 0.25 → start = 2000 + floor(0.25 × 3001) = 2750
    // candle 1: zGap draws 2–13 (0.5, unused); zBody draws 14–25 = 0.625 → z = 1.5 → ret = 0.0225
    //   close = floor(2750 × 1.0225 + 0.5) = floor(2812.375) = 2812
    //   uUp (26) = 0.5 → high = floor(2812 × 1.005 + 0.5) = floor(2826.56) = 2826
    //   uDown (27) = 0.25 → low = floor(2750 × 0.9975 + 0.5) = floor(2743.625) = 2743
    // candle 2: zGap draws 28–39 = 0.25 → z = −3 → gap = −0.006 → open = floor(2812 × 0.994 + 0.5) = 2795
    //   zBody draws 40–51 = 0.375 → z = −1.5 → close = floor(2795 × 0.9775 + 0.5) = floor(2732.61) = 2732
    //   uUp (52) = 0 → high = 2795; uDown (53) = 0.5 → low = floor(2732 × 0.995 + 0.5) = floor(2718.84) = 2718
    const script: Record<number, number> = { 1: 0.25, 26: 0.5, 27: 0.25, 52: 0, 53: 0.5 };
    fill(script, 2, 12, 0.5);
    fill(script, 14, 12, 0.625);
    fill(script, 28, 12, 0.25);
    fill(script, 40, 12, 0.375);
    const rng = new ScriptedRng(script, 0.5);
    const [c1, c2] = generateCandlesFromRng(rng, 2);
    expect(c1).toEqual({ index: 1, open: 2750, high: 2826, low: 2743, close: 2812 });
    expect(c2).toEqual({ index: 2, open: 2795, high: 2795, low: 2718, close: 2732 });
    expect(rng.draws).toBe(53);
  });
});
