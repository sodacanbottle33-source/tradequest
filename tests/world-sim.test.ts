// WSM — the world simulation (docs/world.md §5).
import { describe, expect, it } from 'vitest';
import { EffectBook, MAX_PRICE, MIN_PRICE, TICKS_PER_DAY, WORLD_ENGINE_VERSION, WorldSim, buildCatalog, type WorldSnapshot } from '../src/world';
import { bookOf, makeEvent, priceTable, runWorld } from './helpers/world';

const LONG = 60_000;

describe('World simulation', () => {
  it('WSM-01: the same seed always gives the same prices; another seed gives different ones', () => {
    const a = priceTable(11, 12, 600);
    const b = priceTable(11, 12, 600);
    const c = priceTable(12, 12, 600);
    expect(a).toEqual(b);
    expect(c).not.toEqual(a);
    // Different seeds differ in every stock, not just one.
    let different = 0;
    for (let i = 0; i < 12; i += 1) if (JSON.stringify(a[i]) !== JSON.stringify(c[i])) different += 1;
    expect(different).toBe(12);
  });

  it('WSM-02: tick 0 is the listing price of every company', () => {
    const companies = buildCatalog(30);
    const sim = new WorldSim(5, companies);
    expect(sim.tick).toBe(0);
    companies.forEach((c, i) => expect(sim.price(i)).toBe(c.basePriceCents));
  });

  it('WSM-03: prices are whole cents inside the allowed range and the world only moves forward one tick at a time', () => {
    const companies = buildCatalog(20);
    const sim = new WorldSim(77, companies);
    const book = new EffectBook();
    for (let t = 1; t <= 3000; t += 1) {
      sim.step(book);
      expect(sim.tick).toBe(t);
      for (let i = 0; i < 20; i += 1) {
        const p = sim.price(i);
        expect(Number.isInteger(p)).toBe(true);
        expect(p).toBeGreaterThanOrEqual(MIN_PRICE);
        expect(p).toBeLessThanOrEqual(MAX_PRICE);
      }
    }
  });

  it('WSM-04: stopping and restoring from a snapshot continues bit-for-bit like an uninterrupted run', () => {
    const companies = buildCatalog(25);
    const events = [
      makeEvent({ key: 'e1', companyId: 3, startTick: 150, durationTicks: 400, realized: 0.09, permShare: 0.3 }),
      makeEvent({ key: 'e2', scope: 'market', companyId: null, startTick: 700, durationTicks: 900, shape: 'ramp', realized: -0.02 }),
    ];
    const straight = new WorldSim(321, companies);
    const bookA = bookOf(events, companies);
    const paused = new WorldSim(321, companies);
    let book = bookOf(events, companies);
    let snapshot: WorldSnapshot | null = null;
    for (let t = 1; t <= 1500; t += 1) {
      straight.step(bookA);
      paused.step(book);
      if (t === 480) {
        // "Crash": throw away the simulation and its effect book, rebuild both from stored data only.
        snapshot = JSON.parse(JSON.stringify(paused.snapshot())) as WorldSnapshot;
      }
    }
    expect(snapshot).not.toBeNull();
    const restored = WorldSim.restore(321, companies, snapshot as WorldSnapshot);
    book = bookOf(events, companies);
    for (let t = 481; t <= 1500; t += 1) restored.step(book);
    expect(restored.tick).toBe(1500);
    expect(Array.from(restored.P)).toEqual(Array.from(straight.P));
    expect(Array.from(restored.F)).toEqual(Array.from(straight.F));
    expect(Array.from(restored.D)).toEqual(Array.from(straight.D));
    expect(Array.from(restored.V)).toEqual(Array.from(straight.V));
    expect(restored.S).toBe(straight.S);
    expect(Array.from(restored.sectorS)).toEqual(Array.from(straight.sectorS));
  }, LONG);

  it('WSM-05: a snapshot survives JSON exactly and carries the engine version', () => {
    const { sim } = runWorld(9, 10, 500);
    const snap = sim.snapshot();
    expect(snap.version).toBe(WORLD_ENGINE_VERSION);
    expect(snap.tick).toBe(500);
    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap);
    expect(() => WorldSim.restore(9, buildCatalog(10), { ...snap, version: 99 })).toThrow();
  });

  it('WSM-06: the world is continuous across a day boundary (random streams are re-derived once a day)', () => {
    const companies = buildCatalog(6);
    const sim = new WorldSim(55, companies);
    const book = new EffectBook();
    sim.tick = TICKS_PER_DAY - 3; // jump the clock; the state is the listing state
    let worst = 0;
    let before = sim.price(0);
    for (let k = 0; k < 6; k += 1) {
      sim.step(book);
      worst = Math.max(worst, Math.abs(sim.price(0) / before - 1));
      before = sim.price(0);
    }
    expect(worst).toBeLessThan(0.05);
  });

  it('WSM-07: companies listed later do not trade before their listing tick and start at their listing price', () => {
    const companies = buildCatalog(12, (id) => (id >= 10 ? 40 : 0));
    const sim = new WorldSim(8, companies);
    const book = new EffectBook();
    for (let t = 1; t < 40; t += 1) {
      sim.step(book);
      expect(sim.isListed(10)).toBe(false);
      expect(sim.price(10)).toBe(0);
    }
    sim.step(book); // tick 40
    expect(sim.isListed(10)).toBe(true);
    expect(sim.price(10)).toBe(companies[10]?.basePriceCents);
    expect(sim.price(11)).toBe(companies[11]?.basePriceCents);
    sim.step(book);
    expect(sim.price(10)).not.toBe(0);
    // Adding companies never changes the ones that already existed.
    const small = priceTable(8, 10, 200);
    const big = priceTable(8, 12, 200);
    for (let i = 0; i < 10; i += 1) expect(big[i]).toEqual(small[i]);
  });

  it('WSM-08: restoring a snapshot taken before a company listed lists it at the right time', () => {
    const companies = buildCatalog(12, (id) => (id >= 10 ? 300 : 0));
    const a = new WorldSim(8, companies);
    const book = new EffectBook();
    for (let t = 1; t <= 100; t += 1) a.step(book);
    const b = WorldSim.restore(8, companies, JSON.parse(JSON.stringify(a.snapshot())) as WorldSnapshot);
    const book2 = new EffectBook();
    for (let t = 101; t <= 400; t += 1) {
      a.step(book);
      b.step(book2);
    }
    expect(Array.from(b.P)).toEqual(Array.from(a.P));
    expect(b.isListed(11)).toBe(true);
  });

  it('WSM-09: restoring fails loudly if a company that should be trading has no stored state', () => {
    const companies = buildCatalog(12);
    const sim = new WorldSim(3, companies);
    sim.step(new EffectBook());
    const snap = sim.snapshot();
    snap.stocks[4] = null;
    expect(() => WorldSim.restore(3, companies, snap)).toThrow();
  });

  it('WSM-10: a positive event raises the price on average, a negative one lowers it, and the move is stronger for the event than without', () => {
    let up = 0;
    let down = 0;
    for (let seed = 1; seed <= 12; seed += 1) {
      const base = priceTable(seed, 3, 800);
      const pos = priceTable(seed, 3, 800, [makeEvent({ key: 'p', startTick: 100, durationTicks: 300, realized: 0.1, permShare: 0.5 })]);
      const neg = priceTable(seed, 3, 800, [makeEvent({ key: 'n', startTick: 100, durationTicks: 300, realized: -0.1, permShare: 0.5 })]);
      const at = 450;
      if ((pos[0] as number[])[at]! > (base[0] as number[])[at]!) up += 1;
      if ((neg[0] as number[])[at]! < (base[0] as number[])[at]!) down += 1;
      // Other companies are untouched by a company event except through shared volatility feedback — their prices are identical.
      expect(pos[1]).toEqual(base[1]);
      expect(neg[2]).toEqual(base[2]);
    }
    expect(up).toBe(12);
    expect(down).toBe(12);
  }, LONG);

  it('WSM-11: the permanent part stays in the fundamental value, the temporary part fades', () => {
    const companies = buildCatalog(3);
    const run = (events: ReturnType<typeof makeEvent>[]) => {
      const sim = new WorldSim(21, companies);
      const book = bookOf(events, companies);
      for (let t = 1; t <= 4000; t += 1) sim.step(book);
      return sim;
    };
    const none = run([]);
    const permanent = run([makeEvent({ key: 'perm', startTick: 50, durationTicks: 60, realized: 0.08, permShare: 1 })]);
    const temporary = run([makeEvent({ key: 'temp', startTick: 50, durationTicks: 60, realized: 0.08, permShare: 0 })]);
    expect(permanent.F[0]! / none.F[0]!).toBeGreaterThan(1.06);
    expect(permanent.F[0]! / none.F[0]!).toBeLessThan(1.1);
    expect(Math.abs(temporary.F[0]! / none.F[0]! - 1)).toBeLessThan(0.001);
    // 3,900 ticks later the temporary move has relaxed to almost nothing (deviation half-life ≈ 5 min).
    expect(Math.abs(temporary.D[0]! - none.D[0]!)).toBeLessThan(0.01);
  });

  it('WSM-12: volume is positive, scales with the company and rises while news moves the price', () => {
    const companies = buildCatalog(12);
    const sim = new WorldSim(31, companies);
    const book = bookOf([makeEvent({ key: 'v', companyId: 5, startTick: 1000, durationTicks: 120, realized: 0.12, shape: 'burst', permShare: 0.5 })], companies);
    let quiet = 0;
    let busy = 0;
    for (let t = 1; t <= 1200; t += 1) {
      sim.step(book);
      expect(sim.volume[5]!).toBeGreaterThanOrEqual(0);
      if (t > 900 && t <= 1000) quiet += sim.volume[5]!;
      if (t > 1000 && t <= 1006) busy += sim.volume[5]! * (100 / 6);
    }
    expect(busy).toBeGreaterThan(quiet * 1.2);
  });

  it('WSM-13: trend regimes only take the values −1, 0, +1 and companies end up with different ones', () => {
    const { sim } = runWorld(404, 66, 10);
    const seen = new Set<number>();
    for (let i = 0; i < 66; i += 1) {
      const r = sim.regime[i] as number;
      expect([-1, 0, 1].includes(r)).toBe(true);
      seen.add(r);
    }
    expect(seen.size).toBe(3);
  });

  it('WSM-14: the engine rejects bad seeds and mismatched catalogs', () => {
    const companies = buildCatalog(5);
    expect(() => new WorldSim(-1, companies)).toThrow();
    expect(() => new WorldSim(1.5, companies)).toThrow();
    expect(() => new WorldSim(2 ** 32, companies)).toThrow();
    const broken = companies.map((c, i) => (i === 2 ? { ...c, id: 9 } : c));
    expect(() => new WorldSim(1, broken)).toThrow();
  });
});

describe('World behaviour over longer periods', () => {
  it('WLB-01: prices stay in a sane range over two simulated days — nothing explodes or collapses', () => {
    const table = priceTable(2026, 20, 2 * TICKS_PER_DAY);
    const companies = buildCatalog(20);
    table.forEach((series, i) => {
      const base = companies[i]!.basePriceCents;
      let min = Infinity;
      let max = 0;
      for (const p of series) {
        if (p < min) min = p;
        if (p > max) max = p;
      }
      expect(min / base).toBeGreaterThan(0.3);
      expect(max / base).toBeLessThan(3);
    });
  }, 120_000);

  it('WLB-02: the 3-minute volatility of each company is close to its stated value', () => {
    const ticks = 6 * 3600;
    const table = priceTable(99, 20, ticks);
    const companies = buildCatalog(20);
    let within = 0;
    table.forEach((series, i) => {
      const moves: number[] = [];
      for (let t = 180; t <= ticks; t += 180) moves.push((series[t] as number) / (series[t - 180] as number) - 1);
      const mean = moves.reduce((a, b) => a + b, 0) / moves.length;
      const sd = Math.sqrt(moves.reduce((a, b) => a + (b - mean) * (b - mean), 0) / moves.length);
      const ratio = sd / (companies[i]!.vol3m);
      if (ratio > 0.6 && ratio < 1.6) within += 1;
    });
    expect(within).toBeGreaterThanOrEqual(17);
  }, 120_000);

  it('WLB-03: stocks do not all move together — correlation between companies is clearly below 1', () => {
    const ticks = 4 * 3600;
    const table = priceTable(5, 12, ticks);
    const r = (i: number) => {
      const out: number[] = [];
      for (let t = 60; t <= ticks; t += 60) out.push((table[i] as number[])[t]! / (table[i] as number[])[t - 60]! - 1);
      return out;
    };
    const corr = (a: number[], b: number[]) => {
      const ma = a.reduce((x, y) => x + y, 0) / a.length;
      const mb = b.reduce((x, y) => x + y, 0) / b.length;
      let sab = 0;
      let saa = 0;
      let sbb = 0;
      for (let k = 0; k < a.length; k += 1) {
        sab += (a[k]! - ma) * (b[k]! - mb);
        saa += (a[k]! - ma) ** 2;
        sbb += (b[k]! - mb) ** 2;
      }
      return sab / Math.sqrt(saa * sbb);
    };
    const cs: number[] = [];
    for (let i = 0; i < 12; i += 1) for (let j = i + 1; j < 12; j += 1) cs.push(corr(r(i), r(j)));
    const mean = cs.reduce((a, b) => a + b, 0) / cs.length;
    expect(mean).toBeGreaterThan(-0.05);
    expect(mean).toBeLessThan(0.6);
    expect(Math.max(...cs)).toBeLessThan(0.95);
  }, 120_000);
});
