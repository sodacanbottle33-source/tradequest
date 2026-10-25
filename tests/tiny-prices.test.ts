// Prices finer than a cent for coins launched now (src/world/units.ts, WorldSim, executeMarket/maxAffordable, server/customCoin.ts).
//
// A coin launched now counts its price in units of one trillionth of a cent (`priceScale` 10^12) and has a trillion tokens. These tests check
// the pure parts: a price in units becomes money exactly (BigInt) and always in the house's favour, so a tiny price can never make money out
// of rounding; a scaled order fills exactly like the same order in cents; the price floor (one unit, $0.00000000000001) and ceiling ($1.00);
// and a rug-pulled coin drops to the floor and stays there, the same after a restart. The server side is in tests/server-tinycoin.test.ts.
import { describe, expect, it } from 'vitest';
import {
  COIN_MAX_UNITS,
  COIN_MIN_UNITS,
  COIN_PRICE_SCALE,
  COIN_TOKENS,
  WorldSim,
  buildCatalog,
  executeMarket,
  ladder,
  maxAffordable,
  quoteOf,
  scaleOf,
  tokensFor,
  unitsToCents,
  unitsToMoney,
  valueOf,
  type CatalogEntry,
  type WorldSnapshot,
} from '../src/world';
import { Mulberry32 } from '../src/engine/rng';
import { makeCoinEntry } from '../server/customCoin';
import { bookOf, makeEvent } from './helpers/world';

const LONG = 120_000;
const S = COIN_PRICE_SCALE;

describe('units: a price in units becomes whole cents exactly', () => {
  it('TINY-01: the constants and the conversions', () => {
    expect(COIN_PRICE_SCALE).toBe(1e12);
    expect(COIN_TOKENS).toBe(1e12);
    expect(COIN_MIN_UNITS).toBe(1); // $0.00000000000001
    expect(COIN_MAX_UNITS).toBe(100 * S); // $1.00
    expect(scaleOf(undefined)).toBe(1);
    expect(scaleOf({})).toBe(1);
    expect(scaleOf({ priceScale: S })).toBe(S);
    // A price in cents is itself when the scale is 1, and a tiny fraction of a cent otherwise.
    expect(unitsToCents(250, 1)).toBe(250);
    expect(unitsToCents(6400, S)).toBe(6.4e-9);
    expect(unitsToCents(COIN_MIN_UNITS, S)).toBe(1e-12);
    expect(unitsToCents(COIN_MAX_UNITS, S)).toBe(100);
  });

  it('TINY-02: valueOf is exact where it can be and rounds down, up or to the nearest cent where it cannot', () => {
    // $5,000 buys exactly 31.25 billion tokens at 16,000,000 units (the price of the $5,000 launch) and they are worth exactly that.
    expect(valueOf(31_250_000_000, 16_000_000, S, 'down')).toBe(500_000);
    expect(valueOf(31_250_000_000, 16_000_000, S, 'up')).toBe(500_000);
    // One token at the lowest price is worth a trillionth of a cent: nothing, or one cent if the house is rounding up.
    expect(valueOf(1, 1, S, 'down')).toBe(0);
    expect(valueOf(1, 1, S, 'nearest')).toBe(0);
    expect(valueOf(1, 1, S, 'up')).toBe(1);
    // Exactly half a cent: nearest goes up (halves up), down stays, up goes up.
    expect(valueOf(1, S / 2, S, 'nearest')).toBe(1);
    expect(valueOf(1, S / 2, S, 'down')).toBe(0);
    expect(valueOf(1, S / 2, S, 'up')).toBe(1);
    expect(valueOf(1, S / 2 - 1, S, 'nearest')).toBe(0);
    // A trillion tokens at the highest price ($1.00) are worth a trillion dollars.
    expect(valueOf(COIN_TOKENS, COIN_MAX_UNITS, S, 'down')).toBe(1e14);
    // Counted in cents (scale 1) nothing is rounded; a product that is not a safe whole number is refused.
    expect(valueOf(3, 250, 1, 'down')).toBe(750);
    expect(valueOf(3, 250, 1, 'up')).toBe(750);
    expect(() => valueOf(2 ** 40, 2 ** 20, 1, 'down')).toThrow(/overflow/);
    expect(() => valueOf(COIN_TOKENS, 1e16, S, 'down')).toThrow(/overflow/); // $10 trillion of one coin does not fit in a number
    expect(() => unitsToMoney(10n ** 40n, S, 'down')).toThrow(/overflow/);
    expect(unitsToMoney(7n * BigInt(S) + 1n, S, 'down')).toBe(7);
    expect(unitsToMoney(7n * BigInt(S) + 1n, S, 'up')).toBe(8);
  });

  it('TINY-03: the product can be far past 2^53 and is still worked out exactly (BigInt, not floats)', () => {
    const tokens = 999_999_999_999;
    const units = 99_999_999_999_999;
    const exact = BigInt(tokens) * BigInt(units);
    const down = Number(exact / BigInt(S));
    const up = Number((exact + BigInt(S) - 1n) / BigInt(S));
    expect(valueOf(tokens, units, S, 'down')).toBe(down);
    expect(valueOf(tokens, units, S, 'up')).toBe(up);
    expect(up - down).toBe(1);
    // The plain float product would have been wrong here: it is not even a safe integer.
    expect(Number.isSafeInteger(tokens * units)).toBe(false);
  });

  it('TINY-04: tokensFor is the most whole tokens the money buys, and the cost of them never passes the money', () => {
    expect(tokensFor(500_000, 16_000_000, S)).toBe(31_250_000_000);
    expect(tokensFor(200, 6400, S)).toBe(31_250_000_000);
    expect(tokensFor(0, 6400, S)).toBe(0);
    expect(tokensFor(1, 1, S)).toBe(S); // a cent buys a trillion tokens at the lowest price
    expect(tokensFor(100, 5, 1)).toBe(20); // counted in cents: plain division
    expect(() => tokensFor(100, 0, S)).toThrow(/Bad price/);
    expect(() => tokensFor(100, 0.5, S)).toThrow(/Bad price/);
    const rng = new Mulberry32(4242);
    for (let i = 0; i < 2000; i += 1) {
      const cents = 1 + Math.floor(rng.next() * 1_000_000_000);
      const units = 1 + Math.floor(rng.next() * 44_000_000_000);
      const tokens = tokensFor(cents, units, S);
      expect(valueOf(tokens, units, S, 'down')).toBeLessThanOrEqual(cents);
      // One more token would cost more than the money (rounded down is already over, so rounded up is too).
      expect(valueOf(tokens + 1, units, S, 'down') + 1 > cents || valueOf(tokens + 1, units, S, 'up') > cents).toBe(true);
    }
  });

  it('TINY-05: rounding can never make money: a buyer pays the cent up, a seller gets the cent down, so buying and selling the same tokens at one price never gains', () => {
    const rng = new Mulberry32(777);
    for (let i = 0; i < 5000; i += 1) {
      const tokens = 1 + Math.floor(rng.next() * 1_000_000_000_000);
      const units = 1 + Math.floor(rng.next() * Math.pow(10, 1 + Math.floor(rng.next() * 12)));
      const exact = BigInt(tokens) * BigInt(units);
      const pay = valueOf(tokens, units, S, 'up');
      const get = valueOf(tokens, units, S, 'down');
      expect(BigInt(pay) * BigInt(S)).toBeGreaterThanOrEqual(exact);
      expect(BigInt(get) * BigInt(S)).toBeLessThanOrEqual(exact);
      expect(get).toBeLessThanOrEqual(pay);
      expect(pay - get).toBeLessThanOrEqual(1);
    }
  });
});

describe('orders in units fill exactly like the same orders in cents', () => {
  const stock = buildCatalog(66)[7]!;
  const MID = 4000;

  it('TINY-06: a ladder whose prices are exact multiples of the scale fills with the same quantities and the same money as the cents version, buying and selling', () => {
    for (const side of ['buy', 'sell'] as const) {
      const q = quoteOf(stock, MID, 1);
      const levels = ladder(stock, q, 1, side);
      const scaled = levels.map((l) => ({ price: l.price * S, size: l.size }));
      for (const [qty, consumed] of [[1, 0], [50, 0], [5000, 0], [5000, 800], [1_000_000, 0]] as const) {
        const a = executeMarket(levels, side, qty, consumed, { mid: MID });
        const b = executeMarket(scaled, side, qty, consumed, { mid: MID * S, scale: S, maxQty: 10 ** 13 });
        expect(b.filledQty).toBe(a.filledQty);
        expect(b.unfilledQty).toBe(a.unfilledQty);
        expect(b.totalCents).toBe(a.totalCents);
        expect(b.note).toBe(a.note);
        expect(b.consumedAfter).toBe(a.consumedAfter);
        expect(b.parts.map((p) => p.qty)).toEqual(a.parts.map((p) => p.qty));
        expect(b.parts.map((p) => p.price / S)).toEqual(a.parts.map((p) => p.price));
      }
    }
  });

  it('TINY-07: maxAffordable in units is the same as in cents, and the order it allows never costs more than the cash', () => {
    const q = quoteOf(stock, MID, 1);
    const levels = ladder(stock, q, 1, 'buy');
    const scaled = levels.map((l) => ({ price: l.price * S, size: l.size }));
    for (const cash of [0, 1, 3999, 4100, 100_000, 7_654_321, 900_000_000]) {
      const a = maxAffordable(levels, 0, cash);
      const b = maxAffordable(scaled, 0, cash, { scale: S, maxQty: 10 ** 13 });
      expect(b.qty).toBe(a.qty);
      expect(b.costCents).toBe(a.costCents);
      expect(b.costCents).toBeLessThanOrEqual(cash);
    }
  });

  it('TINY-08: at a tiny price the order is limited by the book, not by the money, and a one-token order costs at most one cent', () => {
    // A coin at 6400 units ($0.000000000064): ask a few ten-thousandths above, a book of a million tokens a level.
    const levels = [
      { price: 6500, size: 1_000_000 },
      { price: 6600, size: 1_000_000 },
    ];
    const one = executeMarket(levels, 'buy', 1, 0, { mid: 6400, scale: S, maxQty: COIN_TOKENS });
    expect(one.filledQty).toBe(1);
    expect(one.totalCents).toBe(1); // a buyer's cent is rounded up: even one token costs a whole cent, never nothing
    const sell = executeMarket(levels.map((l) => ({ ...l, price: l.price - 200 })), 'sell', 1, 0, { mid: 6400, scale: S, maxQty: COIN_TOKENS });
    expect(sell.totalCents).toBe(0); // and a seller of one token is given nothing, never a free cent
    // The whole book: 2 million tokens cost well under a cent, so the buyer pays one cent for them.
    const all = executeMarket(levels, 'buy', 2_000_000, 0, { mid: 6400, scale: S, maxQty: COIN_TOKENS });
    expect(all.filledQty).toBe(2_000_000);
    expect(all.totalCents).toBe(1);
    // Asking for more than a coin has is refused, and so is a fraction of a token.
    expect(() => executeMarket(levels, 'buy', COIN_TOKENS + 1, 0, { mid: 6400, scale: S, maxQty: COIN_TOKENS })).toThrow(/above the limit/);
    expect(() => executeMarket(levels, 'buy', 1.5, 0, { mid: 6400, scale: S, maxQty: COIN_TOKENS })).toThrow(/whole number/);
  });
});

// ---- the simulation ---------------------------------------------------------------------------------------------------------------

const FINE_ID = 66;
const OLD_ID = 67;
const TAKEN = () => ({ names: new Set<string>(), tickers: new Set<string>() });

function fineEntry(over: Partial<CatalogEntry> = {}): CatalogEntry {
  return { ...makeCoinEntry({ name: 'Moon Pepe', ticker: 'MPEP', seedCents: 500_000 }, TAKEN()).entry, ...over };
}
/** A coin from before the tiny prices: counted in cents, 80,000 coins at $2.00. */
function oldEntry(): CatalogEntry {
  const e = makeCoinEntry({ name: 'Old Frog', ticker: 'OFRG', seedCents: 500_000 }, TAKEN()).entry;
  const meme = { ...(e.meme as NonNullable<CatalogEntry['meme']>), supply: 80_000 };
  delete (meme as { priceScale?: number }).priceScale;
  return { ...e, price: 200, meme };
}
function world(fine: CatalogEntry = fineEntry(), old: CatalogEntry = oldEntry()) {
  return buildCatalog(68, () => 0, new Map([[FINE_ID, fine], [OLD_ID, old]]));
}

describe('the simulation: floor, ceiling and dead coins', () => {
  it('TINY-09: the entry of a launched coin carries its scale and a company is built from it with the scale, and an old coin has none', () => {
    const companies = world();
    const fine = companies[FINE_ID]!;
    const old = companies[OLD_ID]!;
    expect(fine.priceScale).toBe(S);
    expect(fine.sharesOutstanding).toBe(COIN_TOKENS);
    expect(fine.basePriceCents).toBe(16_000_000);
    expect(old.priceScale).toBeUndefined();
    expect(old.sharesOutstanding).toBe(80_000);
    expect(old.basePriceCents).toBe(200);
    // The saved form of a company (JSON) must not gain a scale of 1: an old coin must compare equal to what a restart builds.
    expect('priceScale' in JSON.parse(JSON.stringify(old))).toBe(false);
  });

  it('TINY-10: a fine coin never goes below one unit or above $1.00 whatever the news does, and its price is always a whole number of units', () => {
    // Start just under the ceiling and hit it with a huge pump, then start at the floor and hit it with crashes.
    const top = world(fineEntry({ price: 99 * S }));
    const low = world(fineEntry({ price: 3 }));
    for (const [companies, realized, mustHit] of [[top, 3, COIN_MAX_UNITS], [low, -0.95, COIN_MIN_UNITS]] as const) {
      const sim = new WorldSim(51, companies);
      const events = [
        makeEvent({ key: 'big1', companyId: FINE_ID, startTick: 20, durationTicks: 200, realized, permShare: 1 }),
        makeEvent({ key: 'big2', companyId: FINE_ID, startTick: 300, durationTicks: 200, realized, permShare: 1 }),
      ];
      const book = bookOf(events, companies);
      let hit = false;
      for (let t = 1; t <= 1500; t += 1) {
        sim.step(book);
        const p = sim.P[FINE_ID] as number;
        expect(Number.isInteger(p)).toBe(true);
        expect(p).toBeGreaterThanOrEqual(COIN_MIN_UNITS);
        expect(p).toBeLessThanOrEqual(COIN_MAX_UNITS);
        if (p === mustHit) hit = true;
      }
      expect(hit).toBe(true); // it really got to the limit and stopped there
    }
  }, LONG);

  it('TINY-11: a dead fine coin drops to one unit at its tick and stays there for good, however hard the news pushes; a dead old coin keeps the price it had', () => {
    const companies = world();
    const sim = new WorldSim(52, companies);
    const events = [
      makeEvent({ key: 'pump-fine', companyId: FINE_ID, startTick: 600, durationTicks: 300, realized: 5, permShare: 1 }),
      makeEvent({ key: 'pump-old', companyId: OLD_ID, startTick: 600, durationTicks: 300, realized: 5, permShare: 1 }),
    ];
    const book = bookOf(events, companies);
    for (let t = 1; t <= 399; t += 1) sim.step(book);
    expect(sim.isDead(FINE_ID)).toBe(false);
    sim.setDeadFrom(FINE_ID, 400);
    sim.setDeadFrom(OLD_ID, 400);
    sim.setDeadFrom(FINE_ID, 400); // the same tick again changes nothing
    expect(() => sim.setDeadFrom(FINE_ID, 401)).toThrow(/already set to die/);
    expect(() => sim.setDeadFrom(999, 400)).toThrow(/Unknown company/);
    expect(() => sim.setDeadFrom(FINE_ID, 0)).toThrow(/Bad tick/);
    let oldAtDeath = -1;
    for (let t = 400; t <= 3000; t += 1) {
      sim.step(book);
      if (t === 400) oldAtDeath = sim.P[OLD_ID] as number;
      if (t >= 400) {
        expect(sim.P[FINE_ID]).toBe(COIN_MIN_UNITS);
        expect(sim.F[FINE_ID]).toBe(COIN_MIN_UNITS);
        expect(sim.P[OLD_ID]).toBe(oldAtDeath);
      }
    }
    expect(sim.isDead(FINE_ID)).toBe(true);
    expect(sim.isDead(OLD_ID)).toBe(true);
    expect(sim.deadFrom().get(FINE_ID)).toBe(400);
    // A dead coin has a nonzero price: the market list still shows it, at the floor.
    expect(unitsToCents(sim.P[FINE_ID] as number, S)).toBe(1e-12);
    // The coin next to it is alive and moving.
    expect(sim.isDead(0)).toBe(false);
  }, LONG);

  it('TINY-12: a rug-pulled coin that has not died yet moves as before until its tick (nothing before the tick is changed)', () => {
    const companies = world();
    const a = new WorldSim(53, companies);
    const b = new WorldSim(53, companies);
    const book = bookOf([], companies);
    b.setDeadFrom(FINE_ID, 500);
    for (let t = 1; t <= 499; t += 1) {
      a.step(book);
      b.step(book);
      expect(b.P[FINE_ID]).toBe(a.P[FINE_ID]);
    }
    a.step(book);
    b.step(book);
    expect(a.P[FINE_ID]).not.toBe(COIN_MIN_UNITS);
    expect(b.P[FINE_ID]).toBe(COIN_MIN_UNITS);
  });

  it('TINY-13: a restart gives the same world: the death tick given again after a restore (from a snapshot before or after the death) continues bit for bit', () => {
    const companies = world();
    const events = [makeEvent({ key: 'e1', companyId: 3, startTick: 100, durationTicks: 500, realized: 0.1, permShare: 0.3 }), makeEvent({ key: 'e2', companyId: OLD_ID, startTick: 300, durationTicks: 400, realized: -0.5, permShare: 1 })];
    const straight = new WorldSim(54, companies);
    const bookS = bookOf(events, companies);
    straight.setDeadFrom(FINE_ID, 800);
    straight.setDeadFrom(OLD_ID, 800);
    const snaps = new Map<number, WorldSnapshot>();
    for (let t = 1; t <= 2000; t += 1) {
      straight.step(bookS);
      if (t === 500 || t === 1200) snaps.set(t, JSON.parse(JSON.stringify(straight.snapshot())) as WorldSnapshot);
    }
    for (const at of [500, 1200]) {
      const restored = WorldSim.restore(54, companies, snaps.get(at) as WorldSnapshot);
      restored.setDeadFrom(FINE_ID, 800);
      restored.setDeadFrom(OLD_ID, 800);
      const book = bookOf(events, companies);
      for (let t = at + 1; t <= 2000; t += 1) restored.step(book);
      expect(restored.tick).toBe(2000);
      expect(Array.from(restored.P)).toEqual(Array.from(straight.P));
      expect(Array.from(restored.F)).toEqual(Array.from(straight.F));
      expect(restored.isDead(FINE_ID)).toBe(true);
      expect(restored.P[FINE_ID]).toBe(COIN_MIN_UNITS);
    }
  }, LONG);

  it('TINY-14: a fine coin is quoted at every price from the floor to the ceiling without a bad number', () => {
    const fine = world()[FINE_ID]!;
    for (const mid of [1, 2, 10, 6400, 16_000_000, 44_000_000_000, COIN_MAX_UNITS]) {
      const q = quoteOf(fine, mid, 1);
      expect(Number.isFinite(q.bid) && Number.isFinite(q.ask)).toBe(true);
      expect(q.bid).toBeLessThanOrEqual(q.mid);
      expect(q.ask).toBeGreaterThan(q.mid);
      expect(Number.isInteger(q.ask)).toBe(true);
      for (const side of ['buy', 'sell'] as const) {
        for (const l of ladder(fine, q, 1, side)) {
          expect(Number.isInteger(l.price)).toBe(true);
          expect(l.price).toBeGreaterThanOrEqual(1);
          expect(l.size).toBeGreaterThanOrEqual(1);
        }
      }
    }
  });
});

describe('an EffectBook with a fine coin', () => {
  it('TINY-15: a company event on a fine coin is a percentage of its price, so it moves a unit price like a cent price', () => {
    const companies = world();
    const sim = new WorldSim(55, companies);
    const ev = [makeEvent({ key: 'up', companyId: FINE_ID, startTick: 10, durationTicks: 120, realized: 0.5, permShare: 1 }), makeEvent({ key: 'up-old', companyId: OLD_ID, startTick: 10, durationTicks: 120, realized: 0.5, permShare: 1 })];
    const b = bookOf(ev, companies);
    const f0 = sim.P[FINE_ID] as number;
    const o0 = sim.P[OLD_ID] as number;
    for (let t = 1; t <= 400; t += 1) sim.step(b);
    // Both rose by about the same share (the coins start with different random walks, so only roughly).
    const fineMove = (sim.P[FINE_ID] as number) / f0;
    const oldMove = (sim.P[OLD_ID] as number) / o0;
    expect(fineMove).toBeGreaterThan(1.1);
    expect(oldMove).toBeGreaterThan(1.1);
    expect(Math.abs(Math.log(fineMove / oldMove))).toBeLessThan(1.5);
  });
});
