// LEARN-1 … LEARN-12 — the tutorial (docs/world.md §19.1): its arithmetic, every number printed in its questions, its demo data and its helpers.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bestLongGain, bestShortGain, candlesFromCloses, priceRange, roundTo } from '../src/learn/candles';
import { geometryOf, gridPrices, CHART_H, CHART_W } from '../src/learn/chartGeometry';
import {
  ANATOMY_CANDLES,
  calcResult,
  DANGER_CARDS,
  demoCandles,
  LEVERAGE_DEMO,
  LONG_DEMO,
  SHORT_DEMO,
  SIZE_DEMO,
  STOP_DEMO,
  TUTORIAL,
  TUTORIAL_STEPS,
  breakEvenText,
} from '../src/learn/tutorial';
import { breakEvenBps, cashAfterLosses, feeCents, leveragedProfitCents, longProfitCents, percentText, shortProfitCents, signedUsd, usd, wipeoutBps } from '../src/learn/tutorialMath';
import { doneCount, firstOpenStep, tutorialLabel } from '../src/shared/learnUtil';

describe('the arithmetic', () => {
  it('LEARN-1: long and short profit are exact and mirror each other', () => {
    expect(longProfitCents(5, 4000, 4600)).toBe(3000);
    expect(longProfitCents(10, 5000, 4400)).toBe(-6000);
    expect(shortProfitCents(10, 5000, 4400)).toBe(6000);
    for (const [a, b] of [[100, 150], [999, 1], [5000, 5000]] as const) expect(shortProfitCents(7, a, b) + 0).toBe(-longProfitCents(7, a, b) + 0);
  });

  it('LEARN-2: the fee is rounded UP to a whole cent like the game (server/fees.ts)', () => {
    expect(feeCents(100_000, 50)).toBe(500);
    expect(feeCents(100_000, 10)).toBe(100);
    expect(feeCents(1, 10)).toBe(1); // a real order pays at least one cent
    expect(feeCents(0, 50)).toBe(0);
    expect(feeCents(5000, 0)).toBe(0);
    expect(feeCents(10_001, 10)).toBe(11);
    expect(breakEvenBps(50)).toBe(100);
    expect(breakEvenText(50)).toBe('1 %');
    expect(breakEvenText(10)).toBe('0.20 %');
  });

  it('LEARN-3: leverage wipes out at 100 / leverage percent and never loses more than the margin', () => {
    expect(wipeoutBps(10)).toBe(1000);
    expect(wipeoutBps(1)).toBe(10000);
    expect(wipeoutBps(50)).toBe(200);
    expect(leveragedProfitCents(10_000, 10, 500)).toBe(5000);
    expect(leveragedProfitCents(10_000, 10, -1000)).toBe(-10_000);
    expect(leveragedProfitCents(10_000, 50, -5000)).toBe(-10_000); // clamped: you cannot lose more than the margin
    expect(leveragedProfitCents(10_000, 1, -500)).toBe(-500);
  });

  it('LEARN-4: losing streaks compound the way the question says', () => {
    expect(cashAfterLosses(100_000, 100, 20, 5)).toBe(32_768);
    expect(cashAfterLosses(100_000, 5, 20, 5)).toBe(95_100); // a 5 % stake barely scratches the account
    expect(cashAfterLosses(100_000, 100, 20, 0)).toBe(100_000);
    let last = 100_000;
    for (let n = 1; n <= 5; n += 1) {
      const next = cashAfterLosses(100_000, 50, 20, n);
      expect(next).toBeLessThan(last);
      last = next;
    }
  });

  it('LEARN-5: money and percent text', () => {
    expect(usd(123_456)).toBe('$1,234.56');
    expect(usd(-3000)).toBe('−$30.00');
    expect(usd(5)).toBe('$0.05');
    expect(signedUsd(3000)).toBe('+$30.00');
    expect(signedUsd(-3000)).toBe('−$30.00');
    expect(signedUsd(0)).toBe('$0.00');
    expect(percentText(1000)).toBe('10 %');
    expect(percentText(1050)).toBe('10.5 %');
    expect(percentText(200)).toBe('2 %');
  });
});

describe('the steps and their questions', () => {
  it('LEARN-6: nine steps numbered 1 to 9, each with a demo, a question and four options', () => {
    expect(TUTORIAL_STEPS).toBe(9);
    expect(TUTORIAL.map((s) => s.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    for (const s of TUTORIAL) {
      expect(s.title.length).toBeGreaterThan(3);
      expect(s.paragraphs.length).toBeGreaterThan(0);
      expect(s.tryIt.length).toBeGreaterThan(10);
      expect(s.question.options).toHaveLength(4);
      expect(new Set(s.question.options).size).toBe(4);
      expect(s.question.correct).toBeGreaterThanOrEqual(0);
      expect(s.question.correct).toBeLessThan(4);
      expect(s.question.explain.length).toBeGreaterThan(20);
    }
    expect(new Set(TUTORIAL.map((s) => s.demo)).size).toBe(9);
  });

  it('LEARN-7: every number printed in a question is recomputed: exactly the marked option holds the right amount', () => {
    let checked = 0;
    for (const s of TUTORIAL) {
      const calc = s.question.calc;
      if (!calc) continue;
      expect(calcResult(calc)).toBe(calc.expectCents);
      const amount = Math.abs(calc.expectCents) / 100;
      // "lost" / "lose" options must match a negative result and "made" / "make" a positive one; options with no verb are only amounts.
      const verb = (o: string): number => (/\b(lost|lose)\b/.test(o) ? -1 : /\b(made|make)\b/.test(o) ? 1 : 0);
      const matching = s.question.options
        .map((o, i) => ({ i, n: Number((/\$([\d,]+(?:\.\d+)?)/.exec(o)?.[1] ?? 'x').replace(/,/g, '')), v: verb(o) }))
        .filter((x) => !Number.isNaN(x.n) && Math.abs(x.n - amount) <= amount * 0.02 && (x.v === 0 || x.v === Math.sign(calc.expectCents)));
      expect(matching.map((m) => m.i), `step ${s.id}`).toEqual([s.question.correct]);
      checked += 1;
    }
    expect(checked).toBe(6); // steps 1, 3, 4, 5, 6 and 9
  });

  it('LEARN-8: the questions that quote a price use the numbers of the text', () => {
    const q = (n: number) => (TUTORIAL[n - 1] as (typeof TUTORIAL)[number]).question.text;
    expect(q(1)).toContain('5 shares at $40');
    expect(q(1)).toContain('$46');
    expect(q(3)).toContain('10 shares at $50');
    expect(q(3)).toContain('$44');
    expect(q(4)).toContain('$50');
    expect(q(5)).toContain('$1,000');
    expect(q(6)).toContain('$100');
    expect(q(6)).toContain('10×');
    expect(q(9)).toContain('20 %');
    expect(q(9)).toContain('$1,000');
  });

  it('LEARN-9: the rates in the fee step are the game\'s own (0.1 % stocks, 0.5 % coins)', () => {
    const fees = readFileSync(resolve(process.cwd(), 'server', 'fees.ts'), 'utf8');
    expect(fees).toMatch(/MEME_FEE_BPS\s*=\s*50\b/);
    expect(fees).toMatch(/STOCK_FEE_BPS\s*=\s*10\b/);
    const step5 = (TUTORIAL[4] as (typeof TUTORIAL)[number]).paragraphs.join(' ');
    expect(step5).toContain('0.1 % on stocks');
    expect(step5).toContain('0.5 % on memecoins');
    const lev = readFileSync(resolve(process.cwd(), 'server', 'leverage.ts'), 'utf8');
    expect(lev).toMatch(/MAX_LEVERAGE\s*=\s*50\b/);
    expect((TUTORIAL[5] as (typeof TUTORIAL)[number]).paragraphs.join(' ')).toContain('1× to 50×');
  });
});

describe('the demo data', () => {
  it('LEARN-10: the candle samples are valid candles and the demo paths are what the text says', () => {
    for (const c of ANATOMY_CANDLES) {
      expect(c.h).toBeGreaterThanOrEqual(Math.max(c.o, c.c));
      expect(c.l).toBeLessThanOrEqual(Math.min(c.o, c.c));
    }
    expect(ANATOMY_CANDLES.some((c) => c.c > c.o)).toBe(true);
    expect(ANATOMY_CANDLES.some((c) => c.c < c.o)).toBe(true);
    // The buy-and-sell demo has a chance to win; the short demo mostly falls.
    expect(bestLongGain([LONG_DEMO.start, ...LONG_DEMO.closes])).toBeGreaterThan(400);
    expect(bestShortGain([SHORT_DEMO.start, ...SHORT_DEMO.closes])).toBeGreaterThan(400);
    expect(LONG_DEMO.firstShown).toBeLessThan(LONG_DEMO.closes.length);
    expect(SHORT_DEMO.firstShown).toBeLessThan(SHORT_DEMO.closes.length);
    for (const demo of [LONG_DEMO, SHORT_DEMO]) {
      const candles = demoCandles(demo);
      expect(candles).toHaveLength(demo.closes.length);
      candles.forEach((c, i) => {
        expect(c.c).toBe(demo.closes[i]);
        expect(c.o).toBe(i === 0 ? demo.start : demo.closes[i - 1]);
        expect(c.h).toBeGreaterThanOrEqual(Math.max(c.o, c.c));
        expect(c.l).toBeLessThanOrEqual(Math.min(c.o, c.c));
      });
    }
    expect(demoCandles(LONG_DEMO)).toEqual(demoCandles(LONG_DEMO)); // the same every time
  });

  it('LEARN-11: the stop demo, the leverage demo and the risk demo make sense', () => {
    expect(STOP_DEMO.stop).toBeLessThan(STOP_DEMO.entry);
    expect(STOP_DEMO.target).toBeGreaterThan(STOP_DEMO.entry);
    expect(longProfitCents(STOP_DEMO.shares, STOP_DEMO.entry, STOP_DEMO.stop)).toBe(-5000);
    expect(longProfitCents(STOP_DEMO.shares, STOP_DEMO.entry, STOP_DEMO.target)).toBe(12_000);
    expect([...LEVERAGE_DEMO.stops]).toEqual([...LEVERAGE_DEMO.stops].sort((a, b) => a - b));
    expect(LEVERAGE_DEMO.stops[0]).toBe(1);
    expect(LEVERAGE_DEMO.stops[LEVERAGE_DEMO.stops.length - 1]).toBe(50);
    // A smaller stake always leaves more after the same streak.
    const left = SIZE_DEMO.stakes.map((s) => cashAfterLosses(SIZE_DEMO.cashCents, s, SIZE_DEMO.lossPercent, SIZE_DEMO.n));
    expect(left).toEqual([...left].sort((a, b) => a - b)); // the stakes go from big to small, so what is left only grows
    expect(left[0]).toBeLessThan(left[left.length - 1] as number);
    expect(DANGER_CARDS.map((d) => d.key)).toEqual(['news', 'coins', 'rug', 'bankrupt', 'pause']);
  });

  it('LEARN-12: the chart helpers: rounding, ranges, geometry and the saved-progress helpers', () => {
    expect(roundTo(1.005, 2)).toBeCloseTo(1, 1);
    expect(roundTo(0.0123456789, 6)).toBe(0.012346);
    expect(priceRange([])).toEqual({ min: 0, max: 1 });
    expect(priceRange([{ o: 5, h: 6, l: 4, c: 5 }], [10, 3])).toEqual({ min: 3, max: 10 });
    const g = geometryOf(candlesFromCloses(100, [101, 99, 103], 0), 3, [95]);
    expect(g.y(g.max)).toBeLessThan(g.y(g.min));
    expect(g.x(0)).toBeLessThan(g.x(1));
    expect(g.x(2)).toBeLessThan(CHART_W);
    expect(g.y(g.min)).toBeLessThan(CHART_H);
    expect(gridPrices(g)).toHaveLength(4);
    expect(firstOpenStep([], 9)).toBe(0);
    expect(firstOpenStep([1, 2, 3], 9)).toBe(3);
    expect(firstOpenStep([1, 2, 4], 9)).toBe(2);
    expect(firstOpenStep([1, 2, 3, 4, 5, 6, 7, 8, 9], 9)).toBe(0);
    expect(doneCount([1, 1, 2, 99, 0, 2.5], 9)).toBe(2);
    expect(tutorialLabel([], 9)).toBe('Tutorial');
    expect(tutorialLabel([1, 2], 9)).toBe('Tutorial (2/9)');
    expect(tutorialLabel([1, 2, 3, 4, 5, 6, 7, 8, 9], 9)).toBe('Tutorial (done)');
  });
});
