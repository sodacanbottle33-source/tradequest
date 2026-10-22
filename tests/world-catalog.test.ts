// WCA — the catalog of companies (docs/world.md §4).
import { describe, expect, it } from 'vitest';
import { STOCKS } from '../src/engine/stocks';
import { MAX_PRICE } from '../src/world/params';
import { CURATED, SECTOR_IDS, STOCK_SECTOR_IDS, TIER_INFO, buildCatalog, marketCapCents, tierOfCap } from '../src/world';

const LONG = 30_000;

describe('World catalog', () => {
  it('WCA-01: the first ten companies are the original ten stocks, in the original order', () => {
    const catalog = buildCatalog(10);
    expect(catalog.map((c) => c.ticker)).toEqual(STOCKS.map((s) => s.ticker));
    expect(catalog.map((c) => c.name)).toEqual(STOCKS.map((s) => s.name));
  });

  it('WCA-02: 500 companies exist with unique tickers and unique names', () => {
    const catalog = buildCatalog(500);
    expect(catalog.length).toBe(500);
    expect(new Set(catalog.map((c) => c.ticker)).size).toBe(500);
    expect(new Set(catalog.map((c) => c.name)).size).toBe(500);
    for (const c of catalog) expect(/^[A-Z]{3,5}$/.test(c.ticker)).toBe(true);
  }, LONG);

  it('WCA-03: the catalog can grow without changing existing companies', () => {
    const small = buildCatalog(80);
    const big = buildCatalog(400);
    for (let i = 0; i < 80; i += 1) expect(JSON.stringify(small[i])).toBe(JSON.stringify(big[i]));
  });

  it('WCA-04: ids equal positions and the hand-written companies come first', () => {
    const catalog = buildCatalog(120);
    catalog.forEach((c, i) => expect(c.id).toBe(i));
    expect(CURATED.length).toBeGreaterThanOrEqual(60);
    CURATED.forEach((entry, i) => expect(catalog[i]?.ticker).toBe(entry.ticker));
  });

  it('WCA-05: every company has all the data the spec asks for and consistent numbers', () => {
    for (const c of buildCatalog(300)) {
      expect(c.name.length).toBeGreaterThan(3);
      expect(c.description.length).toBeGreaterThan(30);
      expect(c.industry.length).toBeGreaterThan(2);
      expect(SECTOR_IDS.includes(c.sector)).toBe(true);
      expect(Number.isSafeInteger(c.basePriceCents)).toBe(true);
      expect(c.basePriceCents).toBeGreaterThanOrEqual(100);
      expect(Number.isSafeInteger(c.sharesOutstanding)).toBe(true);
      expect(c.floatShares).toBeGreaterThan(0);
      expect(c.floatShares).toBeLessThanOrEqual(c.sharesOutstanding);
      expect(c.avgDailyVolume).toBeGreaterThan(0);
      expect(c.liquidity).toBeGreaterThan(0);
      expect(c.liquidity).toBeLessThanOrEqual(1);
      expect(c.spreadBps).toBeGreaterThan(0);
      expect(c.vol3m).toBeGreaterThan(0.004);
      expect(c.vol3m).toBeLessThanOrEqual(0.085);
      expect(c.sigmaTick).toBeGreaterThanOrEqual(c.sigmaD);
      expect(c.products.length).toBe(2);
      expect(c.ceo.includes(' ')).toBe(true);
      expect(c.peerId).toBeGreaterThanOrEqual(0);
      expect(c.peerId).toBeLessThan(300);
    }
  }, LONG);

  it('WCA-06: market capitalisation = price × shares outstanding, and matches the size class', () => {
    for (const c of buildCatalog(300)) {
      const cap = marketCapCents(c.basePriceCents, c);
      expect(cap).toBe(c.basePriceCents * c.sharesOutstanding);
      const info = TIER_INFO[c.tier];
      const dollars = cap / 100;
      // Shares are rounded to thousands, so allow a little slack at the edges of the range.
      expect(dollars).toBeGreaterThanOrEqual(info.capLo * 0.95);
      expect(dollars).toBeLessThanOrEqual(info.capHi * 1.05);
      expect(typeof tierOfCap(dollars)).toBe('string');
    }
  }, LONG);

  it('WCA-07: companies differ — size, volatility, liquidity and spread follow the size class', () => {
    const catalog = buildCatalog(500);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const of = (tier: string, f: (c: (typeof catalog)[number]) => number) => mean(catalog.filter((c) => c.tier === tier).map(f));
    expect(of('mega', (c) => c.liquidity)).toBeGreaterThan(of('large', (c) => c.liquidity));
    expect(of('large', (c) => c.liquidity)).toBeGreaterThan(of('mid', (c) => c.liquidity));
    expect(of('mid', (c) => c.liquidity)).toBeGreaterThan(of('small', (c) => c.liquidity));
    expect(of('small', (c) => c.liquidity)).toBeGreaterThan(of('micro', (c) => c.liquidity));
    expect(of('micro', (c) => c.vol3m)).toBeGreaterThan(of('mid', (c) => c.vol3m));
    expect(of('mid', (c) => c.vol3m)).toBeGreaterThan(of('mega', (c) => c.vol3m));
    expect(of('micro', (c) => c.spreadBps)).toBeGreaterThan(of('large', (c) => c.spreadBps));
    expect(of('micro', (c) => c.newsSensitivity)).toBeGreaterThan(of('mega', (c) => c.newsSensitivity));
    // Within the curated companies, utilities are calmer than emerging-industry start-ups.
    const cur = buildCatalog(CURATED.length);
    const sector = (id: string) => mean(cur.filter((c) => c.sector === id).map((c) => c.vol3m / TIER_INFO[c.tier].vol3m[0]));
    expect(sector('utilities')).toBeLessThan(sector('emerging'));
  });

  it('WCA-08: every sector is represented and every company has a peer in its own sector', () => {
    const catalog = buildCatalog(CURATED.length);
    for (const s of STOCK_SECTOR_IDS) expect(catalog.filter((c) => c.sector === s).length).toBeGreaterThanOrEqual(2);
    for (const c of catalog) {
      const peer = catalog[c.peerId];
      expect(peer?.sector).toBe(c.sector);
      expect(c.peerId === c.id).toBe(false);
    }
  });

  it('WCA-09: bad counts are rejected', () => {
    expect(() => buildCatalog(0)).toThrow();
    expect(() => buildCatalog(1.5)).toThrow();
    expect(() => buildCatalog(100_000)).toThrow();
  });

  it('WCA-10: later listings start later and keep their data', () => {
    const catalog = buildCatalog(70, (id) => (id >= 66 ? 5000 : 0));
    expect(catalog[65]?.listingTick).toBe(0);
    expect(catalog[66]?.listingTick).toBe(5000);
    expect(catalog[69]?.listingTick).toBe(5000);
    expect(catalog[66]?.name).toBe(buildCatalog(70)[66]?.name);
  });

  it('WCA-11: market cap never throws, even for a giant (an owner-made $10 mega-cap) at the highest allowed price', () => {
    const top = MAX_PRICE; // $1,000,000,000.00
    for (const c of buildCatalog(300)) {
      const cap = marketCapCents(top, c);
      expect(Number.isFinite(cap) && cap > 0).toBe(true);
      expect(cap).toBe(top * c.sharesOutstanding);
      // More price never means less market cap.
      expect(cap).toBeGreaterThanOrEqual(marketCapCents(top - 1, c));
    }
    // A $10 mega-cap has about 30 billion shares. At the top price its cap passes the exact whole-number range (2^53 cents), which used
    // to throw and so broke the whole market list for everybody.
    const giant = { sharesOutstanding: 30_000_000_000 };
    expect(Number.isSafeInteger(top * giant.sharesOutstanding)).toBe(false);
    const cap = marketCapCents(top, giant);
    expect(Number.isFinite(cap)).toBe(true);
    expect(cap).toBeGreaterThan(marketCapCents(1_000_000, giant));
    expect(marketCapCents(1000, giant)).toBe(30_000_000_000 * 1000); // still exact when it can be
    expect(() => marketCapCents(-1, giant)).toThrow();
    expect(() => marketCapCents(Number.NaN, giant)).toThrow();
  });
});
