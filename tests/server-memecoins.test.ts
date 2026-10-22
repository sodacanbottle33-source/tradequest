// The thirty memecoins: the list itself, how wild they are, how they join a running world without changing anything that exists,
// and their news. (docs/world.md §12.)
import { afterEach, describe, expect, it } from 'vitest';
import {
  CURATED,
  MEME_SEEDS,
  SECTORS,
  STOCK_SECTOR_IDS,
  TICKS_PER_DAY,
  buildCatalog,
  companyCycleDrafts,
  marketCycleDrafts,
  memeEntries,
  slotsIn,
  type Company,
  type NewsDraft,
} from '../src/world';
import { MEME_COMPANY_TEMPLATES, MEME_LISTING_TEMPLATES, MEME_SECTOR_TEMPLATES, MEME_VIRAL_TEMPLATES } from '../src/world/memeNews';
import { makeEntry, stockOptions } from '../server/customStock';
import { MEMECOINS_SEEDED } from '../server/world/runtime';
import { Db } from '../server/sqlite';
import { Clock, makeRig, priceVector, type Rig } from './helpers/server';

const LONG = 240_000;
const SEED = 20261015;
const rigs: Rig[] = [];
function rig(clock?: Clock): Rig {
  const r = makeRig(clock);
  rigs.push(r);
  return r;
}
afterEach(() => {
  while (rigs.length > 0) rigs.pop()?.cleanup();
});

function worldWithCoins(first = CURATED.length): Company[] {
  const own = new Map(memeEntries().map((e, i) => [first + i, e]));
  return buildCatalog(first + own.size, () => 0, own);
}

describe('the list of coins', () => {
  it('MEME-1: thirty coins, with their own tickers and names, none of them used by any stock', () => {
    const coins = memeEntries();
    expect(coins.length).toBe(30);
    expect(MEME_SEEDS.length).toBe(30);
    const tickers = new Set(coins.map((c) => c.ticker));
    const names = new Set(coins.map((c) => c.name));
    expect(tickers.size).toBe(30);
    expect(names.size).toBe(30);
    for (const c of coins) {
      expect(/^[A-Z]{3,5}$/.test(c.ticker)).toBe(true);
      expect(c.sector).toBe('meme');
      expect(c.price).toBeGreaterThanOrEqual(300);
      expect(c.price).toBeLessThanOrEqual(20_000);
      expect(c.meme?.supply).toBeGreaterThan(0);
    }
    // The hand-written stocks and a big procedural catalog (what a world grows into) never use a coin's ticker or name.
    const stocks = buildCatalog(1500);
    for (const s of stocks) {
      expect(tickers.has(s.ticker) ? `${s.ticker} is also a coin` : '').toBe('');
      expect(names.has(s.name) ? `${s.name} is also a coin` : '').toBe('');
    }
  });

  it('MEME-2: the coins range from big and calm to tiny and wild, with market caps and liquidity that fit', () => {
    const catalog = worldWithCoins();
    const coins = catalog.slice(CURATED.length);
    expect(coins.length).toBe(30);
    let biggest = 0;
    let smallest = Infinity;
    for (const c of coins) {
      const cap = (c.basePriceCents * c.sharesOutstanding) / 100;
      biggest = Math.max(biggest, cap);
      smallest = Math.min(smallest, cap);
      expect(c.liquidity).toBeGreaterThan(0);
      expect(c.liquidity).toBeLessThan(1);
      expect(c.vol3m).toBeGreaterThanOrEqual(0.06); // a stock's 3-minute move never passes 0.085, a calm stock's is 0.01
      expect(c.floatShares).toBeLessThanOrEqual(c.sharesOutstanding);
      expect(c.spreadBps).toBeGreaterThan(5);
      expect(c.newsSensitivity).toBeGreaterThanOrEqual(2.5);
    }
    expect(biggest).toBeGreaterThan(2e9);
    expect(smallest).toBeLessThan(2e6);
    // The less liquid, the wider the spread.
    const thin = coins.reduce((a, b) => (a.liquidity < b.liquidity ? a : b));
    const deep = coins.reduce((a, b) => (a.liquidity > b.liquidity ? a : b));
    expect(thin.spreadBps).toBeGreaterThan(deep.spreadBps * 3);
    // The wildest coin is far wilder than the wildest stock.
    const stockMax = Math.max(...buildCatalog(500).map((c) => c.vol3m));
    expect(stockMax).toBeLessThanOrEqual(0.085);
    expect(Math.max(...coins.map((c) => c.vol3m))).toBeGreaterThan(stockMax * 4);
  });

  it('MEME-3: the memecoin sector is the last sector, so every older sector keeps its number; the generator never uses it', () => {
    expect(SECTORS[SECTORS.length - 1]?.id).toBe('meme');
    expect(STOCK_SECTOR_IDS.length).toBe(SECTORS.length - 1);
    expect(STOCK_SECTOR_IDS.includes('meme')).toBe(false);
    for (const c of buildCatalog(2000)) expect(c.sector === 'meme').toBe(false);
  });

  it('MEME-4: a coin cannot be built without its own numbers, and a stock cannot be built with them in the wrong sector', () => {
    const coin = memeEntries()[0] as ReturnType<typeof memeEntries>[number];
    const { meme: _meme, ...bare } = coin;
    expect(() => buildCatalog(CURATED.length + 1, () => 0, new Map([[CURATED.length, bare]]))).toThrow(/memecoin/);
    expect(() => buildCatalog(CURATED.length + 1, () => 0, new Map([[CURATED.length, { ...coin, sector: 'tech' as const }]]))).toThrow(/memecoin/);
  });
});

describe('the news about coins', () => {
  it('MEME-5: every coin template uses only known slots; sector templates use none; partnership templates name the partner', () => {
    const allowed = new Set(['co', 'tk', 'prod', 'prod2', 'ceo', 'cfo', 'hq', 'peer', 'sector', 'n', 'pct', 'amt', 'region', 'firm', 'person']);
    const sets = [...Object.values(MEME_COMPANY_TEMPLATES), MEME_LISTING_TEMPLATES, ...Object.values(MEME_VIRAL_TEMPLATES)];
    for (const set of sets) {
      for (const dir of ['positive', 'negative', 'uncertain'] as const) {
        for (const [h, b] of set[dir] ?? []) for (const slot of [...slotsIn(h), ...slotsIn(b)]) expect(allowed.has(slot) ? '' : `{${slot}}`).toBe('');
      }
    }
    for (const dir of ['positive', 'negative', 'uncertain'] as const) {
      expect((MEME_SECTOR_TEMPLATES[dir] ?? []).length).toBeGreaterThanOrEqual(2);
      for (const [h, b] of MEME_SECTOR_TEMPLATES[dir] ?? []) expect(slotsIn(h).length + slotsIn(b).length).toBe(0);
      for (const [h, b] of MEME_COMPANY_TEMPLATES.partnership[dir] ?? []) expect(slotsIn(h + ' ' + b).includes('peer')).toBe(true);
    }
    for (const [name, set] of Object.entries(MEME_COMPANY_TEMPLATES)) {
      expect((set.negative ?? []).length).toBeGreaterThanOrEqual(2);
      if (name !== 'incident') expect((set.positive ?? []).length).toBeGreaterThanOrEqual(2);
    }
  });

  it('MEME-6: every coin gets at least three stories a day, never earnings, always with its own words, and sector stories reach the coin sector', () => {
    const catalog = worldWithCoins();
    const coins = catalog.filter((c) => c.sector === 'meme');
    let sectorStories = 0;
    let viral = 0;
    for (let cycle = 0; cycle < 30; cycle += 1) {
      for (const c of coins) {
        const drafts = companyCycleDrafts(SEED, c, catalog, cycle);
        expect(drafts.length).toBeGreaterThanOrEqual(3);
        for (const d of drafts) {
          expect(d.category === 'earnings').toBe(false);
          expect(`${d.headline} ${d.body}`.includes('{')).toBe(false);
          expect(d.headline.length).toBeGreaterThan(5);
        }
      }
      const market: NewsDraft[] = marketCycleDrafts(SEED, catalog, cycle);
      sectorStories += market.filter((d) => d.scope === 'sector' && d.sector === 'meme').length;
      viral += market.filter((d) => d.category === 'viral').length;
    }
    expect(sectorStories).toBeGreaterThan(5);
    expect(viral).toBeGreaterThan(0);
  });

  it('MEME-7: a market without coins has exactly the sector and economy news it always had (the coin sector draws nothing)', () => {
    const stocks = buildCatalog(CURATED.length);
    for (let cycle = 0; cycle < 12; cycle += 1) {
      const items = marketCycleDrafts(SEED, stocks, cycle);
      expect(items.some((d) => d.sector === 'meme')).toBe(false);
    }
  });

  it('MEME-8: a coin\'s story moves it more than a stock\'s story moves a stock', () => {
    const catalog = worldWithCoins();
    const stockMove: number[] = [];
    const coinMove: number[] = [];
    for (let cycle = 0; cycle < 20; cycle += 1) {
      for (const c of catalog) {
        for (const d of companyCycleDrafts(SEED, c, catalog, cycle)) (c.sector === 'meme' ? coinMove : stockMove).push(Math.abs(d.realized));
      }
    }
    const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean(coinMove)).toBeGreaterThan(mean(stockMove) * 3);
  });
});

describe('the coins in a running world', () => {
  it('MEME-9: a brand-new world with coins has them from the first tick, after the stocks, saved once', () => {
    const r = rig();
    const { world, db } = r.open({ companyCount: CURATED.length, memecoins: true });
    expect(world.companies.length).toBe(CURATED.length + 30);
    for (let i = CURATED.length; i < world.companies.length; i += 1) {
      const c = world.companies[i] as Company;
      expect(c.sector).toBe('meme');
      expect(c.listingTick).toBe(0);
      expect(world.sim.isListed(i)).toBe(true);
      expect(world.sim.price(i)).toBeGreaterThanOrEqual(100);
    }
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM meme_companies')?.n).toBe(30);
    expect(db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', MEMECOINS_SEEDED)).toBeDefined();
    expect(world.companyByTicker('WOOF')?.id).toBe(CURATED.length);
  }, LONG);

  it('MEME-10: a world that has run for a while gets the coins after its last company, listing a few minutes later; every stock price stays exactly the same', () => {
    // Control: a world that never gets coins.
    const a = rig(new Clock());
    const control = a.open({ companyCount: CURATED.length, warmupDays: 1 });
    // The same world, stopped, then started again with coins.
    const b = rig(new Clock());
    b.open({ companyCount: CURATED.length, warmupDays: 1 }).db.close();
    b.clock.advanceSeconds(3600);
    a.clock.advanceSeconds(3600);
    control.world.advanceTo(control.world.currentTick(), Infinity);
    const upgraded = b.open({ companyCount: CURATED.length, warmupDays: 1, memecoins: true });
    expect(upgraded.world.companies.length).toBe(CURATED.length + 30);
    const first = upgraded.world.companies[CURATED.length] as Company;
    expect(first.listingTick).toBeGreaterThan(upgraded.world.currentTick());
    expect(upgraded.world.sim.isListed(CURATED.length)).toBe(false);
    // Run both worlds on together: coins list, trade, and the stocks still match the control tick for tick.
    for (let step = 0; step < 4; step += 1) {
      a.clock.advanceSeconds(300);
      b.clock.advanceSeconds(300);
      control.world.advanceTo(control.world.currentTick(), Infinity);
      upgraded.world.advanceTo(upgraded.world.currentTick(), Infinity);
      expect(upgraded.world.sim.tick).toBe(control.world.sim.tick);
      expect(priceVector(upgraded.world).slice(0, CURATED.length)).toEqual(priceVector(control.world).slice(0, CURATED.length));
    }
    expect(upgraded.world.sim.isListed(CURATED.length)).toBe(true);
    expect(upgraded.world.sim.price(CURATED.length)).toBeGreaterThanOrEqual(100);
  }, LONG);

  it('MEME-11: the coins are added only once; a restart reproduces their prices; the saved numbers survive without the switch', () => {
    const r = rig();
    const first = r.open({ companyCount: CURATED.length, memecoins: true });
    r.clock.advanceSeconds(600);
    first.world.advanceTo(first.world.currentTick(), Infinity);
    const before = priceVector(first.world);
    const tickBefore = first.world.sim.tick;
    first.db.close();
    // Same clock: the world is at the saved tick plus a replay. Open it WITHOUT the switch: the coins are part of the world now.
    const second = r.open({ companyCount: CURATED.length, memecoins: false });
    expect(second.world.companies.length).toBe(CURATED.length + 30);
    expect(second.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM meme_companies')?.n).toBe(30);
    expect(second.world.sim.tick).toBe(tickBefore);
    expect(priceVector(second.world)).toEqual(before);
    second.db.close();
    // And once more WITH the switch: still thirty, not sixty, in the same order.
    const third = r.open({ companyCount: CURATED.length, memecoins: true });
    expect(third.world.companies.length).toBe(CURATED.length + 30);
    expect(third.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM meme_companies')?.n).toBe(30);
    expect(third.world.companies.map((c) => c.ticker)).toEqual(worldWithCoins().map((c) => c.ticker));
    expect(priceVector(third.world)).toEqual(before);
  }, LONG);

  it('MEME-12: a stopped world with coins catches up to exactly the prices a world that never stopped has', () => {
    const live = rig(new Clock());
    const w1 = live.open({ companyCount: CURATED.length, memecoins: true });
    const stop = rig(new Clock());
    stop.open({ companyCount: CURATED.length, memecoins: true }).db.close();
    live.clock.advanceSeconds(7200);
    stop.clock.advanceSeconds(7200);
    w1.world.advanceTo(w1.world.currentTick(), Infinity);
    const w2 = stop.open({ companyCount: CURATED.length, memecoins: true });
    expect(w2.world.sim.tick).toBe(w1.world.sim.tick);
    expect(priceVector(w2.world)).toEqual(priceVector(w1.world));
  }, LONG);

  it('MEME-13: a coin and another company cannot share a name or ticker: adding coins to a world that already uses one is refused with a sentence', () => {
    const r = rig();
    r.open({ companyCount: CURATED.length }).db.close();
    // Pretend the owner had made a company called "MoonWoof" before the coins came.
    const raw = new Db(r.path);
    rigs[rigs.length - 1]?.opened.push(raw);
    raw.run("INSERT INTO users(username, display_name, pw_hash, role, created_ms) VALUES ('boss', 'Boss', 'x', 'owner', 1)");
    const uid = raw.get<{ id: number }>('SELECT id FROM users WHERE username = ?', 'boss')?.id as number;
    raw.run('INSERT INTO companies(id, ticker, name, listing_tick, listed_ms) VALUES (?, ?, ?, ?, ?)', CURATED.length, 'XWOF', 'MoonWoof', 0, 1);
    raw.run(
      'INSERT INTO custom_companies(company_id, ticker, name, sector, industry, tier, personality, price_cents, product1, product2, description, created_ms, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      CURATED.length, 'XWOF', 'MoonWoof', 'tech', 'Software', 'small', 'steady', 5000, 'a', 'b', 'd', 1, uid,
    );
    raw.close();
    expect(() => r.open({ companyCount: CURATED.length, memecoins: true })).toThrow(/MoonWoof/);
  }, LONG);
});

describe('how wild the coins are', () => {
  it('MEME-14: over 20 000 market seconds coins swing many times more than stocks (a calm coin ≈ the wildest stock, a thin one far beyond)', () => {
    const catalog = worldWithCoins();
    const r = rig();
    const { world } = r.open({ companyCount: CURATED.length, memecoins: true, warmupDays: 0 });
    expect(world.companies.length).toBe(catalog.length);
    const n = world.companies.length;
    const prev = Array.from(world.sim.P);
    const sum10 = new Float64Array(n);
    const sq10 = new Float64Array(n);
    const count10 = new Float64Array(n);
    const start = world.sim.tick;
    // Step the simulation directly (no database writes) for speed.
    for (let t = 0; t < 20_000; t += 1) {
      world.sim.step(world.effects);
      if (t % 10 === 9) {
        for (let i = 0; i < n; i += 1) {
          const p = world.sim.P[i] as number;
          const was = prev[i] as number;
          if (was > 0 && p > 0) {
            const r10 = Math.log(p / was);
            sum10[i] = (sum10[i] as number) + r10;
            sq10[i] = (sq10[i] as number) + r10 * r10;
            count10[i] = (count10[i] as number) + 1;
          }
          prev[i] = p;
        }
      }
    }
    expect(world.sim.tick).toBe(start + 20_000);
    const std = (i: number): number => {
      const m = (sum10[i] as number) / (count10[i] as number);
      return Math.sqrt((sq10[i] as number) / (count10[i] as number) - m * m);
    };
    const stockStd = Array.from({ length: CURATED.length }, (_, i) => std(i)).sort((a, b) => a - b);
    const coinStd = Array.from({ length: 30 }, (_, k) => std(CURATED.length + k)).sort((a, b) => a - b);
    const median = (xs: number[]): number => xs[Math.floor(xs.length / 2)] as number;
    expect(median(coinStd)).toBeGreaterThan(median(stockStd) * 4);
    expect(coinStd[0]).toBeGreaterThan(0.01); // even the calmest coin moves 1 % in ten seconds, typically
    expect(coinStd[29]).toBeGreaterThan(0.06); // the wildest: 6 % in ten seconds
    expect(TICKS_PER_DAY).toBeGreaterThan(20_000);
  }, LONG);
});

describe('the owner\'s "make a company" form', () => {
  it('MEME-15: offers only the stock sectors, and refuses the coin sector (coins have their own market)', () => {
    const offered = stockOptions(60).sectors.map((x) => x.id);
    expect(offered).toEqual([...STOCK_SECTOR_IDS]);
    expect(offered.includes('meme')).toBe(false);
    const input = { name: 'Zorlex Holdings', ticker: 'ZRLX', sector: 'meme', tier: 'small', personality: 'steady', priceCents: 5000 };
    const taken = { names: new Set<string>(), tickers: new Set<string>() };
    expect(() => makeEntry(input, taken)).toThrow(/sector/);
    expect(makeEntry({ ...input, sector: 'tech' }, taken).sector).toBe('tech');
  });
});
