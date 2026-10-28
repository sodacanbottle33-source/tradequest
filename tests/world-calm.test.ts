// CALM — calmer stocks (docs/world.md §26): from a stored tick, the fast jitter of every STOCK is halved. Coins keep theirs, the slow trend and the
// news are untouched, a simulation without the setting is exactly what it always was, and a stop and restart gives the same prices.
import { describe, expect, it } from 'vitest';
import { EffectBook, STOCK_JITTER_CALM, WorldSim, buildCatalog, memeEntries, type CatalogEntry, type Company, type WorldSnapshot } from '../src/world';
import { bookOf, makeEvent } from './helpers/world';

const LONG = 120_000;
const STOCKS = 66;
const COINS = 3;

/** The sixty-six hand-written stocks and three memecoins (ids 66 … 68). */
function mixed(): Company[] {
  const own = new Map<number, CatalogEntry>(memeEntries().slice(0, COINS).map((e, i) => [STOCKS + i, e]));
  return buildCatalog(STOCKS + COINS, () => 0, own);
}

function run(seed: number, companies: readonly Company[], ticks: number, calmFrom?: number, every = 1): { prices: number[][]; fundamentals: number[][]; sim: WorldSim } {
  const sim = calmFrom === undefined ? new WorldSim(seed, companies) : new WorldSim(seed, companies, calmFrom);
  const book = new EffectBook();
  const prices: number[][] = [Array.from(sim.P)];
  const fundamentals: number[][] = [Array.from(sim.F)];
  for (let t = 1; t <= ticks; t += 1) {
    sim.step(book);
    if (t % every === 0) {
      prices.push(Array.from(sim.P));
      fundamentals.push(Array.from(sim.F));
    }
  }
  return { prices, fundamentals, sim };
}

describe('Calmer stocks', () => {
  it('CALM-1: without a calm tick (or with one that never comes) the market is exactly what it always was', () => {
    const companies = mixed();
    const plain = run(21, companies, 2500);
    const never = run(21, companies, 2500, Infinity);
    const late = run(21, companies, 2500, 1_000_000);
    expect(never.prices).toEqual(plain.prices);
    expect(late.prices).toEqual(plain.prices);
    expect(plain.sim.calmFrom).toBe(Infinity);
    expect(late.sim.calmFrom).toBe(1_000_000);
  }, LONG);

  it('CALM-2: nothing before the calm tick changes; from it on the stocks differ and the coins never do', () => {
    const companies = mixed();
    const at = 900;
    const plain = run(22, companies, 3000);
    const calm = run(22, companies, 3000, at);
    // Every price up to and including the tick before it is the same.
    for (let t = 0; t < at; t += 1) expect(calm.prices[t]).toEqual(plain.prices[t]);
    // The calm tick itself is already calm: the very first calm step gives some stock another price.
    let atTheTick = 0;
    for (let i = 0; i < STOCKS; i += 1) if (calm.prices[at]?.[i] !== plain.prices[at]?.[i]) atTheTick += 1;
    expect(atTheTick).toBeGreaterThan(0);
    // After it most stocks have a different price.
    let different = 0;
    for (let i = 0; i < STOCKS; i += 1) if (calm.prices[2000]?.[i] !== plain.prices[2000]?.[i]) different += 1;
    expect(different).toBeGreaterThan(STOCKS * 0.8);
    // The coins: not one price differs, at any tick.
    for (let t = 0; t <= 3000; t += 1) {
      for (let i = STOCKS; i < STOCKS + COINS; i += 1) expect(calm.prices[t]?.[i]).toBe(plain.prices[t]?.[i]);
    }
  }, LONG);

  it('CALM-3: the slow trend (the fundamental value) is untouched; only the jitter around it shrinks', () => {
    const companies = mixed();
    const plain = run(23, companies, 4000);
    const calm = run(23, companies, 4000, 0);
    expect(calm.fundamentals).toEqual(plain.fundamentals);
    expect(calm.prices).not.toEqual(plain.prices);
  }, LONG);

  it('CALM-4: the size of the jitter really is cut: stocks that are mostly jitter move about half as much, and no stock moves more', () => {
    const companies = mixed();
    const ticks = 40_000;
    const spread = (prices: number[][], i: number): number => {
      // The spread of 3-minute moves (180 ticks), from a price every 180 ticks.
      const moves: number[] = [];
      for (let k = 1; k < prices.length; k += 1) {
        const a = prices[k - 1]?.[i] as number;
        const b = prices[k]?.[i] as number;
        moves.push(b / a - 1);
      }
      const mean = moves.reduce((x, y) => x + y, 0) / moves.length;
      return Math.sqrt(moves.reduce((x, y) => x + (y - mean) * (y - mean), 0) / moves.length);
    };
    const plain = run(24, companies, ticks, undefined, 180);
    const calm = run(24, companies, ticks, 0, 180);
    const ratios: number[] = [];
    for (let i = 0; i < STOCKS; i += 1) {
      const r = spread(calm.prices, i) / spread(plain.prices, i);
      expect(r).toBeLessThan(1.1); // never wilder (the rest is luck of a different path, so some room)
      const c = companies[i] as Company;
      if (c.tier === 'micro' || c.tier === 'small') ratios.push(r);
    }
    expect(ratios.length).toBeGreaterThanOrEqual(20);
    ratios.sort((x, y) => x - y);
    const median = ratios[Math.floor(ratios.length / 2)] as number;
    expect(median).toBeGreaterThan(0.4);
    expect(median).toBeLessThan(0.75);
    expect(STOCK_JITTER_CALM).toBe(0.5);
  }, LONG);

  it('CALM-5: stopping on a snapshot and carrying on gives bit-for-bit the same prices, before and after the calm tick, with news running', () => {
    const companies = mixed();
    const calmFrom = 1200;
    const events = [
      makeEvent({ key: 'e1', companyId: 4, startTick: 300, durationTicks: 1500, realized: 0.12, permShare: 0.4 }),
      makeEvent({ key: 'e2', scope: 'market', companyId: null, startTick: 1000, durationTicks: 900, shape: 'ramp', realized: -0.02 }),
    ];
    const straight = new WorldSim(25, companies, calmFrom);
    const bookA = bookOf(events, companies);
    const snaps = new Map<number, WorldSnapshot>();
    for (let t = 1; t <= 2600; t += 1) {
      straight.step(bookA);
      if (t === 700 || t === 1200 || t === 1900) snaps.set(t, JSON.parse(JSON.stringify(straight.snapshot())) as WorldSnapshot);
    }
    for (const at of [700, 1200, 1900]) {
      const restored = WorldSim.restore(25, companies, snaps.get(at) as WorldSnapshot, calmFrom);
      const book = bookOf(events, companies);
      for (let t = at + 1; t <= 2600; t += 1) restored.step(book);
      expect(restored.calmFrom).toBe(calmFrom);
      expect(Array.from(restored.P)).toEqual(Array.from(straight.P));
      expect(JSON.stringify(restored.snapshot())).toBe(JSON.stringify(straight.snapshot()));
    }
    // Forgetting the calm tick on the way back gives other prices from the calm tick on: it is part of the world.
    const forgot = WorldSim.restore(25, companies, snaps.get(700) as WorldSnapshot);
    const book = bookOf(events, companies);
    for (let t = 701; t <= 2600; t += 1) forgot.step(book);
    expect(Array.from(forgot.P)).not.toEqual(Array.from(straight.P));
  }, LONG);

  it('CALM-6: a calm tick must be a whole tick from 0 on (or Infinity)', () => {
    const companies = buildCatalog(3);
    for (const bad of [-1, 1.5, Number.NaN, -Infinity]) expect(() => new WorldSim(1, companies, bad)).toThrow(/calm tick/i);
    expect(() => new WorldSim(1, companies, 0)).not.toThrow();
    expect(() => new WorldSim(1, companies, Infinity)).not.toThrow();
  });

  it('CALM-7: news still moves a calm stock by its full size', () => {
    const companies = buildCatalog(6);
    const total = 0.15;
    const mk = (calmFrom: number | undefined): number => {
      const sim = calmFrom === undefined ? new WorldSim(27, companies) : new WorldSim(27, companies, calmFrom);
      const book = new EffectBook();
      book.add([{ eventKey: 'big', companyId: 2, startTick: 50, durationTicks: 120, shape: 'front', total, permShare: 1 }]);
      const base = new WorldSim(27, companies);
      const none = new EffectBook();
      for (let t = 1; t <= 400; t += 1) {
        sim.step(book);
        base.step(none);
      }
      // The log of the fundamental value against the same market without the news: the full permanent move, give or take the mood of the market.
      return Math.log((sim.F[2] as number) / (base.F[2] as number));
    };
    const plain = mk(undefined);
    const calm = mk(0);
    expect(Math.abs(calm - plain)).toBeLessThan(0.01);
    expect(calm).toBeGreaterThan(0.1);
  }, LONG);
});
