// WEF — how events become price effects (docs/world.md §7).
import { describe, expect, it } from 'vitest';
import { EffectBook, PARTNER_SPILL, buildCatalog, effectiveDuration, effectsOf, weightAt, type Shape } from '../src/world';
import { makeEvent } from './helpers/world';

const SHAPES: Shape[] = ['burst', 'front', 'ramp'];
const catalog = buildCatalog(66);

function totalWeight(shape: Shape, duration: number): number {
  let sum = 0;
  const d = effectiveDuration(shape, duration);
  for (let k = -2; k < d + 3; k += 1) sum += weightAt(shape, duration, k);
  return sum;
}

describe('Event effects', () => {
  it('WEF-01: every shape adds up to exactly 1 for every duration', () => {
    for (const shape of SHAPES) {
      for (let d = 1; d <= 300; d += 1) expect(Math.abs(totalWeight(shape, d) - 1)).toBeLessThan(1e-9);
      for (const d of [600, 1800, 3600, 7200]) expect(Math.abs(totalWeight(shape, d) - 1)).toBeLessThan(1e-9);
    }
  });

  it('WEF-02: weights are never negative and are zero outside the effect', () => {
    for (const shape of SHAPES) {
      for (const d of [1, 2, 5, 17, 200]) {
        for (let k = -5; k < effectiveDuration(shape, d) + 5; k += 1) expect(weightAt(shape, d, k)).toBeGreaterThanOrEqual(0);
        expect(weightAt(shape, d, -1)).toBe(0);
        expect(weightAt(shape, d, effectiveDuration(shape, d))).toBe(0);
      }
    }
  });

  it('WEF-03: shapes behave as described — burst is flat and short, front decays, ramp rises then falls', () => {
    expect(effectiveDuration('burst', 600)).toBe(6);
    expect(effectiveDuration('burst', 3)).toBe(3);
    expect(weightAt('burst', 600, 0)).toBeCloseTo(1 / 6, 12);
    expect(weightAt('front', 100, 0)).toBeGreaterThan(weightAt('front', 100, 50));
    expect(weightAt('front', 100, 50)).toBeGreaterThan(weightAt('front', 100, 99));
    expect(weightAt('ramp', 100, 10)).toBeGreaterThan(weightAt('ramp', 100, 0));
    expect(weightAt('ramp', 100, 49)).toBeGreaterThan(weightAt('ramp', 100, 10));
    expect(weightAt('ramp', 100, 90)).toBeLessThan(weightAt('ramp', 100, 49));
    expect(weightAt('ramp', 9, 0)).toBeCloseTo(weightAt('ramp', 9, 8), 12); // symmetric
  });

  it('WEF-04: a bad duration is rejected', () => {
    expect(() => effectiveDuration('front', 0)).toThrow();
    expect(() => effectiveDuration('front', 2.5)).toThrow();
  });

  it('WEF-05: company events affect one stock; partnerships also the partner at the spill share', () => {
    const one = effectsOf(makeEvent({ key: 'a', companyId: 4, realized: 0.06 }), catalog);
    expect(one.length).toBe(1);
    expect(one[0]?.companyId).toBe(4);
    expect(one[0]?.total).toBe(0.06);
    const two = effectsOf(makeEvent({ key: 'b', scope: 'company+partner', companyId: 4, partnerId: 11, realized: 0.1 }), catalog);
    expect(two.map((e) => e.companyId)).toEqual([4, 11]);
    expect(two[1]?.total).toBeCloseTo(0.1 * PARTNER_SPILL, 12);
  });

  it('WEF-06: sector events affect exactly the sector; market events affect everyone, scaled by beta', () => {
    const sector = effectsOf(makeEvent({ key: 's', scope: 'sector', companyId: null, sector: 'energy', realized: 0.02 }), catalog);
    const energy = catalog.filter((c) => c.sector === 'energy');
    expect(sector.length).toBe(energy.length);
    for (const e of sector) expect(e.total).toBeCloseTo(0.02 * (catalog[e.companyId]?.beta ?? 0), 12);
    const market = effectsOf(makeEvent({ key: 'm', scope: 'market', companyId: null, realized: -0.01 }), catalog);
    expect(market.length).toBe(66);
    for (const e of market) expect(e.total).toBeCloseTo(-0.01 * (catalog[e.companyId]?.beta ?? 0), 12);
  });

  it('WEF-07: companies that are not listed yet when an event starts are not affected', () => {
    const later = buildCatalog(70, (id) => (id >= 68 ? 1000 : 0));
    const ev = makeEvent({ key: 'x', scope: 'market', companyId: null, startTick: 500 });
    expect(effectsOf(ev, later).length).toBe(68);
    expect(effectsOf({ ...ev, startTick: 1000 }, later).length).toBe(70);
  });

  it('WEF-08: bad events are rejected', () => {
    expect(() => effectsOf(makeEvent({ key: 'n', companyId: null }), catalog)).toThrow();
    expect(() => effectsOf(makeEvent({ key: 'n', companyId: 999 }), catalog)).toThrow();
    expect(() => effectsOf(makeEvent({ key: 'n', scope: 'sector', companyId: null, sector: null }), catalog)).toThrow();
  });

  it('WEF-09: an event is applied exactly once in total — contributions add up to the configured move', () => {
    for (const shape of SHAPES) {
      const book = new EffectBook(effectsOf(makeEvent({ key: shape, shape, realized: 0.07, permShare: 0.4, startTick: 20, durationTicks: 90 }), catalog));
      const trans = new Float64Array(66);
      const perm = new Float64Array(66);
      const activity = new Float64Array(66).fill(1);
      let sumT = 0;
      let sumP = 0;
      for (let t = 1; t <= 400; t += 1) {
        trans.fill(0);
        perm.fill(0);
        book.apply(t, 0, activity, trans, perm);
        sumT += trans[0] as number;
        sumP += perm[0] as number;
        for (let i = 1; i < 66; i += 1) expect((trans[i] as number) + (perm[i] as number)).toBe(0);
      }
      expect(sumP).toBeCloseTo(0.07 * 0.4, 9);
      expect(sumT).toBeCloseTo(0.07 * 0.6, 9);
      expect(book.activeCount).toBe(0);
      expect(book.pendingCount).toBe(0);
      expect(book.finished).toBe(1);
    }
  });

  it('WEF-10: nothing is applied before the start tick or after the end', () => {
    const book = new EffectBook(effectsOf(makeEvent({ key: 'w', startTick: 50, durationTicks: 10, shape: 'front' }), catalog));
    const trans = new Float64Array(66);
    const perm = new Float64Array(66);
    const activity = new Float64Array(66).fill(1);
    const touched: number[] = [];
    for (let t = 1; t <= 100; t += 1) {
      trans.fill(0);
      perm.fill(0);
      book.apply(t, 0, activity, trans, perm);
      if ((trans[0] as number) !== 0 || (perm[0] as number) !== 0) touched.push(t);
    }
    expect(touched).toEqual([50, 51, 52, 53, 54, 55, 56, 57, 58, 59]);
  });

  it('WEF-11: asking for the same effect again from a fresh book at a later tick gives the same contribution (restart safe)', () => {
    const ev = makeEvent({ key: 'r', startTick: 50, durationTicks: 100, shape: 'ramp', realized: 0.05 });
    const live = new EffectBook(effectsOf(ev, catalog));
    const trans = new Float64Array(66);
    const perm = new Float64Array(66);
    const activity = new Float64Array(66).fill(1);
    const seen = new Map<number, number>();
    for (let t = 1; t <= 200; t += 1) {
      trans.fill(0);
      perm.fill(0);
      live.apply(t, 0, activity, trans, perm);
      seen.set(t, (trans[0] as number) + (perm[0] as number));
    }
    const restarted = new EffectBook(effectsOf(ev, catalog));
    for (let t = 90; t <= 200; t += 1) {
      trans.fill(0);
      perm.fill(0);
      restarted.apply(t, 0, activity, trans, perm);
      expect((trans[0] as number) + (perm[0] as number)).toBe(seen.get(t));
    }
  });

  it('WEF-12: sentiment that agrees with the news strengthens it a little, disagreement weakens it, within ±30%', () => {
    const apply = (sentiment: number, total: number): number => {
      const book = new EffectBook(effectsOf(makeEvent({ key: 'g', realized: total, shape: 'burst', durationTicks: 6, permShare: 1, startTick: 1 }), catalog));
      const trans = new Float64Array(66);
      const perm = new Float64Array(66);
      const activity = new Float64Array(66).fill(1);
      book.apply(1, sentiment, activity, trans, perm);
      return perm[0] as number;
    };
    const neutral = apply(0, 0.06);
    expect(neutral).toBeCloseTo(0.06 / 6, 12);
    expect(apply(1e-6, 0.06)).toBeCloseTo(neutral * 1.3, 12);
    expect(apply(-1e-6, 0.06)).toBeCloseTo(neutral * 0.7, 12);
    expect(apply(1e-6, -0.06)).toBeCloseTo(-neutral * 0.7, 12);
    expect(apply(5e-6, 0.06)).toBeCloseTo(neutral * 1.3, 12); // capped
  });

  it('WEF-13: effects cannot be added for ticks that were already processed, and ticks must not go backwards', () => {
    const book = new EffectBook();
    const t = new Float64Array(66);
    const p = new Float64Array(66);
    const a = new Float64Array(66).fill(1);
    book.apply(10, 0, a, t, p);
    expect(() => book.add(effectsOf(makeEvent({ key: 'late', startTick: 10 }), catalog))).toThrow();
    book.add(effectsOf(makeEvent({ key: 'ok', startTick: 11 }), catalog));
    expect(() => book.apply(9, 0, a, t, p)).toThrow();
  });
});
