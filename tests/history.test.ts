// HIST-01 … HIST-05 — test-cases.md §4. (HIST-06 is in invariants.test.ts; HIST-07 is manual.)
import { describe, expect, it } from 'vitest';
import {
  createCandleStream,
  createRound,
  generateCandles,
  generateCandlesFromRng,
  getView,
  isHistoryIndex,
  Mulberry32,
  roundNumber,
} from '../src/engine';
import { fill, ScriptedRng } from './helpers/rounds';

describe('History candles', () => {
  it('HIST-01: candle 11 uses draws 262–287 and close of candle 10 (hand-computed)', () => {
    // All other draws are 0.5: start = 2000 + floor(0.5 × 3001) = 3500; z = 0 → candles 1–10 close at 3500.
    // Candle 11: zGap (262–273) = 0.25 → z = −3 → open = floor(3500 × 0.994 + 0.5) = 3479
    //            zBody (274–285) = 0.375 → z = −1.5 → close = floor(3479 × 0.9775 + 0.5) = floor(3401.22) = 3401
    //            uUp (286) = 0 → high = 3479; uDown (287) = 0.5 → low = floor(3401 × 0.995 + 0.5) = floor(3384.495) = 3384
    const script: Record<number, number> = { 286: 0, 287: 0.5 };
    fill(script, 262, 12, 0.25);
    fill(script, 274, 12, 0.375);
    const rng = new ScriptedRng(script, 0.5);
    const candles = generateCandlesFromRng(rng, 11);
    expect(candles[9]!.close).toBe(3500);
    expect(candles[10]).toEqual({ index: 11, open: 3479, high: 3479, low: 3384, close: 3401 });
    expect(rng.draws).toBe(287);
  });

  it('HIST-02: no history/playable branch — 10 then 60 from one stream equals all 70', () => {
    const stream = createCandleStream(new Mulberry32(2468));
    const firstTen = Array.from({ length: 10 }, () => stream.next());
    const nextSixty = Array.from({ length: 60 }, () => stream.next());
    expect([...firstTen, ...nextSixty]).toEqual(generateCandles(2468));
  });

  it('HIST-03: at round start candles 1–10 are visible, k = 10, mark = close of candle 10', () => {
    const state = createRound(12345);
    const view = getView(state);
    expect(view.k).toBe(10);
    expect(view.candles.map((c) => c.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(view.markPrice).toBe(generateCandles(12345)[9]!.close);
    expect(view.roundNumber).toBe(0);
  });

  it('HIST-04: indices 1–10 are history and shown as history', () => {
    for (let i = 1; i <= 10; i += 1) expect(isHistoryIndex(i)).toBe(true);
    expect(getView(createRound(1)).candles.every((c) => c.kind === 'history')).toBe(true);
  });

  it('HIST-05: indices 11–70 are playable; round number = index − 10', () => {
    for (let i = 11; i <= 70; i += 1) expect(isHistoryIndex(i)).toBe(false);
    expect(roundNumber(11)).toBe(1);
    expect(roundNumber(70)).toBe(60);
  });
});
