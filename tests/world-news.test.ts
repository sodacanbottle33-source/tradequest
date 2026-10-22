// The news generator: three or more distinct items per company per day, spread over the day; headlines are clues, not
// promises; viral events are rare and uneven. (docs/world.md §7; requirements 6–9.)
import { describe, expect, it } from 'vitest';
import {
  COMPANY_TEMPLATES,
  EARNINGS_PERIOD_CYCLES,
  EARNINGS_TEMPLATES,
  LISTING_TEMPLATES,
  MACRO_TEMPLATES,
  MIN_ITEMS_PER_CYCLE,
  NEWS_CYCLE_TICKS,
  SECTOR_TEMPLATES,
  SECTORS,
  VIRAL_FADE_TEMPLATES,
  VIRAL_TEMPLATES,
  buildCatalog,
  companyCycleDrafts,
  effectsOf,
  eventOf,
  fill,
  marketCycleDrafts,
  money,
  slotsIn,
  type Company,
  type NewsDraft,
  type TemplateSet,
} from '../src/world';

const SEED = 20261015;
const LONG = 120_000;
const ALLOWED_SLOTS = new Set(['co', 'tk', 'prod', 'prod2', 'ceo', 'cfo', 'hq', 'peer', 'sector', 'n', 'pct', 'amt', 'region', 'firm', 'person', 'q', 'qn', 'eps', 'epscons', 'epsdiff', 'epscmp', 'surp', 'rev', 'revcons', 'revcmp', 'yoy']);

const companies = buildCatalog(500);

function allSets(): { name: string; set: TemplateSet; extra?: string[] }[] {
  const out: { name: string; set: TemplateSet }[] = [];
  for (const [k, v] of Object.entries(COMPANY_TEMPLATES)) out.push({ name: k, set: v });
  out.push({ name: 'earnings', set: EARNINGS_TEMPLATES }, { name: 'listing', set: LISTING_TEMPLATES }, { name: 'macro', set: MACRO_TEMPLATES }, { name: 'fade', set: VIRAL_FADE_TEMPLATES });
  for (const [k, v] of Object.entries(SECTOR_TEMPLATES)) out.push({ name: `sector:${k}`, set: v });
  for (const [k, v] of Object.entries(VIRAL_TEMPLATES)) out.push({ name: `viral:${k}`, set: v });
  return out;
}

describe('templates', () => {
  it('use only known {slots}; macro and sector templates use none', () => {
    for (const { name, set } of allSets()) {
      for (const dir of ['positive', 'negative', 'uncertain'] as const) {
        for (const [h, b] of set[dir] ?? []) {
          for (const slot of [...slotsIn(h), ...slotsIn(b)]) expect(ALLOWED_SLOTS.has(slot) ? '' : `${name}/${dir}: {${slot}}`).toBe('');
          if (name === 'macro' || name.startsWith('sector:')) expect(slotsIn(h).length + slotsIn(b).length).toBe(0);
        }
      }
    }
  });

  it('every company category has positive, negative and uncertain headlines except incidents (no good incidents)', () => {
    for (const [name, set] of Object.entries(COMPANY_TEMPLATES)) {
      expect((set.negative ?? []).length).toBeGreaterThanOrEqual(3);
      expect((set.uncertain ?? []).length).toBeGreaterThanOrEqual(3);
      if (name !== 'incident') expect((set.positive ?? []).length).toBeGreaterThanOrEqual(4);
    }
    expect(Object.keys(SECTOR_TEMPLATES).length).toBe(SECTORS.length);
  });

  it('every partnership template names the partner, so a partner affected by the news is always mentioned', () => {
    for (const dir of ['positive', 'negative', 'uncertain'] as const) {
      for (const [h, b] of COMPANY_TEMPLATES.partnership[dir] ?? []) expect(slotsIn(h + ' ' + b).includes('peer')).toBe(true);
    }
  });

  it('there are enough different templates to keep the feed varied', () => {
    let n = 0;
    for (const { set } of allSets()) for (const dir of ['positive', 'negative', 'uncertain'] as const) n += (set[dir] ?? []).length;
    expect(n).toBeGreaterThan(280);
  });
});

describe('every company gets at least three items every day', () => {
  it('500 companies × 40 days: ≥ 3, one in each third of the day, all different, none in the wrong cycle', () => {
    for (let cycle = 0; cycle < 40; cycle += 1) {
      const start = cycle * NEWS_CYCLE_TICKS;
      for (const c of companies) {
        const items = companyCycleDrafts(SEED, c, companies, cycle);
        expect(items.length).toBeGreaterThanOrEqual(MIN_ITEMS_PER_CYCLE);
        expect(items.length).toBeLessThanOrEqual(5);
        const core = items.filter((i) => i.slot < 3);
        expect(core.length).toBe(3);
        core.forEach((i, k) => {
          const lo = start + Math.floor((k * NEWS_CYCLE_TICKS) / 3);
          const hi = start + Math.floor(((k + 1) * NEWS_CYCLE_TICKS) / 3);
          expect(i.publishTick >= lo && i.publishTick < hi).toBe(true);
        });
        // gaps between the three core items are at least 45 minutes
        expect((core[1] as NewsDraft).publishTick - (core[0] as NewsDraft).publishTick).toBeGreaterThan(2700);
        expect((core[2] as NewsDraft).publishTick - (core[1] as NewsDraft).publishTick).toBeGreaterThan(2700);
        expect(new Set(items.map((i) => i.headline)).size).toBe(items.length);
        expect(new Set(items.map((i) => i.category)).size).toBe(items.length);
        expect(new Set(items.map((i) => i.key)).size).toBe(items.length);
        for (const i of items) {
          expect(i.companyId).toBe(c.id);
          expect(i.publishTick >= start && i.publishTick < start + NEWS_CYCLE_TICKS).toBe(true);
          expect(i.startTick).toBeGreaterThanOrEqual(i.publishTick);
          expect(i.headline.length).toBeGreaterThan(10);
          expect(i.body.length).toBeGreaterThan(20);
          expect(/[{}]/.test(i.headline + i.body)).toBe(false);
          expect(i.headline.includes('undefined') || i.body.includes('undefined')).toBe(false);
          expect(i.headline.includes('NaN') || i.body.includes('NaN')).toBe(false);
        }
      }
    }
  }, LONG);

  it("possessives of names ending in s are written correctly", () => {
    expect(fill("{co}'s plan", { co: 'Quibiton Networks' })).toBe("Quibiton Networks' plan");
    expect(fill("{co}'s plan", { co: 'Novera Systems' })).toBe("Novera Systems' plan");
    expect(fill("{co}'s plan", { co: 'Verdane Water' })).toBe("Verdane Water's plan");
  });

  it('items mention the company itself (they are company-specific)', () => {
    for (const c of companies.slice(0, 80)) {
      for (const i of companyCycleDrafts(SEED, c, companies, 3)) {
        const text = i.headline + ' ' + i.body;
        const mentions = text.includes(c.name) || text.includes(c.ticker) || (i.scope === 'company+partner' && text.length > 0);
        expect(mentions).toBe(true);
      }
    }
  });

  it('a company that lists during a cycle still gets three items between its listing and the end of that cycle', () => {
    const lateListing = 5 * NEWS_CYCLE_TICKS + 70_000; // 16 400 ticks (4.5 h) before the end of day 5
    const cat = buildCatalog(20, (id) => (id === 15 ? lateListing : 0));
    const c = cat[15] as Company;
    expect(companyCycleDrafts(SEED, c, cat, 4)).toEqual([]);
    const items = companyCycleDrafts(SEED, c, cat, 5);
    expect(items.length).toBeGreaterThanOrEqual(3);
    expect(items[0]?.category).toBe('listing');
    expect(items[0]?.publishTick).toBe(lateListing);
    for (const i of items) {
      expect(i.publishTick).toBeGreaterThanOrEqual(lateListing);
      expect(i.publishTick).toBeLessThan(6 * NEWS_CYCLE_TICKS);
      expect(i.startTick).toBeGreaterThanOrEqual(lateListing);
    }
    expect(companyCycleDrafts(SEED, c, cat, 6).length).toBeGreaterThanOrEqual(3);
  });

  it('even a company listed a few seconds before the end of a cycle gets its three items', () => {
    const cat = buildCatalog(12, (id) => (id === 11 ? 3 * NEWS_CYCLE_TICKS - 40 : 0));
    const items = companyCycleDrafts(SEED, cat[11] as Company, cat, 2);
    expect(items.length).toBeGreaterThanOrEqual(3);
    for (const i of items) expect(i.publishTick).toBeLessThan(3 * NEWS_CYCLE_TICKS);
  });
});

describe('determinism', () => {
  it('the same seed gives the same news; a different seed gives different news', () => {
    const a = JSON.stringify(companies.slice(0, 30).map((c) => companyCycleDrafts(SEED, c, companies, 12)));
    const b = JSON.stringify(companies.slice(0, 30).map((c) => companyCycleDrafts(SEED, c, companies, 12)));
    const other = JSON.stringify(companies.slice(0, 30).map((c) => companyCycleDrafts(SEED + 1, c, companies, 12)));
    expect(a).toBe(b);
    expect(a).not.toBe(other);
    expect(JSON.stringify(marketCycleDrafts(SEED, companies, 9))).toBe(JSON.stringify(marketCycleDrafts(SEED, companies, 9)));
  });

  it('a prefix of the catalog gets exactly the same news whether or not later companies exist', () => {
    const small = buildCatalog(66);
    for (const c of small.slice(0, 20)) {
      expect(JSON.stringify(companyCycleDrafts(SEED, c, small, 7))).toBe(JSON.stringify(companyCycleDrafts(SEED, companies[c.id] as Company, companies, 7)));
    }
  });
});

describe('a headline is a clue, not a promise', () => {
  const sample: NewsDraft[] = [];
  for (let cycle = 0; cycle < 40; cycle += 1) for (const c of companies.slice(0, 150)) sample.push(...companyCycleDrafts(SEED, c, companies, cycle));

  it('about 70–88 % of positive and negative headlines move the price the way they read — never 100 %', () => {
    const directional = sample.filter((i) => i.direction !== 'uncertain' && i.kind === 'ordinary');
    const agree = directional.filter((i) => (i.direction === 'positive') === i.realized > 0).length / directional.length;
    expect(agree).toBeGreaterThan(0.7);
    expect(agree).toBeLessThan(0.88);
    const pos = directional.filter((i) => i.direction === 'positive');
    const neg = directional.filter((i) => i.direction === 'negative');
    expect(pos.filter((i) => i.realized < 0).length / pos.length).toBeGreaterThan(0.1);
    expect(neg.filter((i) => i.realized > 0).length / neg.length).toBeGreaterThan(0.1);
  }, LONG);

  it('uncertain headlines go either way, about equally', () => {
    const unc = sample.filter((i) => i.direction === 'uncertain');
    expect(unc.length).toBeGreaterThan(500);
    const up = unc.filter((i) => i.realized > 0).length / unc.length;
    expect(up).toBeGreaterThan(0.42);
    expect(up).toBeLessThan(0.58);
  });

  it('the market is not biased towards rising: positive and negative outcomes are balanced', () => {
    const ordinary = sample.filter((i) => i.kind === 'ordinary');
    const sum = ordinary.reduce((s, i) => s + i.realized, 0);
    const mean = sum / ordinary.length;
    const meanAbs = ordinary.reduce((s, i) => s + Math.abs(i.realized), 0) / ordinary.length;
    expect(Math.abs(mean)).toBeLessThan(meanAbs * 0.25);
  });

  it('strengths are mostly minor, extreme ones are rare, and extremes are labelled breaking', () => {
    const n = sample.length;
    const share = (s: string): number => sample.filter((i) => i.strength === s).length / n;
    expect(share('minor')).toBeGreaterThan(0.45);
    expect(share('minor')).toBeLessThan(0.7);
    expect(share('extreme')).toBeLessThan(0.025);
    expect(share('extreme')).toBeGreaterThan(0);
    for (const i of sample.filter((x) => x.strength === 'extreme')) expect(i.breaking).toBe(true);
    expect(sample.filter((i) => i.breaking).length / n).toBeLessThan(0.05);
  });

  it('bigger strength means bigger average real moves; no move is ever above the 25 % cap', () => {
    const avg = (s: string): number => {
      const xs = sample.filter((i) => i.strength === s && i.direction !== 'uncertain');
      return xs.reduce((a, i) => a + Math.abs(i.realized), 0) / xs.length;
    };
    expect(avg('moderate')).toBeGreaterThan(avg('minor') * 2);
    expect(avg('major')).toBeGreaterThan(avg('moderate') * 1.8);
    expect(avg('extreme')).toBeGreaterThan(avg('major') * 1.5);
    for (const i of sample) expect(Math.abs(i.realized)).toBeLessThanOrEqual(0.25);
  });

  it('small companies feel news more than giants', () => {
    const tierAvg = (tier: string): number => {
      const xs = sample.filter((i) => companies[i.companyId as number]?.tier === tier);
      return xs.reduce((a, i) => a + Math.abs(i.realized), 0) / Math.max(1, xs.length);
    };
    const micro = tierAvg('micro');
    const large = tierAvg('large');
    expect(micro).toBeGreaterThan(large * 1.4);
  });

  it('three or four items a day: the average is between 3.2 and 3.6', () => {
    const perCompanyCycle = sample.length / (150 * 40);
    expect(perCompanyCycle).toBeGreaterThan(3.2);
    expect(perCompanyCycle).toBeLessThan(3.6);
  });

  it('the same company rarely gets the same headline two days in a row', () => {
    let same = 0;
    let total = 0;
    for (const c of companies.slice(0, 100)) {
      for (let cycle = 1; cycle < 30; cycle += 1) {
        const a = new Set(companyCycleDrafts(SEED, c, companies, cycle - 1).map((i) => i.headline));
        for (const i of companyCycleDrafts(SEED, c, companies, cycle)) {
          total += 1;
          if (a.has(i.headline)) same += 1;
        }
      }
    }
    expect(same / total).toBeLessThan(0.04);
  }, LONG);

  it('growth companies get more good news than declining ones', () => {
    const ofPers = (p: string) => sample.filter((i) => companies[i.companyId as number]?.personality === p && i.direction !== 'uncertain');
    const share = (xs: NewsDraft[]): number => xs.filter((i) => i.direction === 'positive').length / xs.length;
    const growth = ofPers('growth');
    const declining = ofPers('declining');
    expect(growth.length).toBeGreaterThan(200);
    expect(declining.length).toBeGreaterThan(100);
    expect(share(growth)).toBeGreaterThan(share(declining) + 0.1);
  });
});

describe('earnings', () => {
  it('each company reports once every fiscal quarter (3 days), always on the same day of it; all three days are used', () => {
    expect(EARNINGS_PERIOD_CYCLES).toBe(3);
    const days = new Set<number>();
    let n = 0;
    for (const c of companies.slice(0, 120)) {
      if (c.listingTick !== 0 || c.sector === 'meme') continue;
      const reports: number[] = [];
      for (let cycle = 0; cycle < 4 * EARNINGS_PERIOD_CYCLES; cycle += 1) {
        if (companyCycleDrafts(SEED, c, companies, cycle).some((i) => i.category === 'earnings')) reports.push(cycle);
      }
      expect(reports.length).toBe(4);
      for (let i = 1; i < reports.length; i += 1) expect((reports[i] as number) - (reports[i - 1] as number)).toBe(EARNINGS_PERIOD_CYCLES);
      days.add((reports[0] as number) % EARNINGS_PERIOD_CYCLES);
      n += 1;
    }
    expect(n).toBeGreaterThan(50);
    expect(days.size).toBe(EARNINGS_PERIOD_CYCLES); // spread over every day of the quarter
  }, LONG);

  it('an earnings day still has three company items (the report is one of them)', () => {
    for (const c of companies.slice(0, 60)) {
      for (let cycle = 0; cycle < 2 * EARNINGS_PERIOD_CYCLES; cycle += 1) {
        const items = companyCycleDrafts(SEED, c, companies, cycle);
        if (items.some((i) => i.category === 'earnings')) {
          expect(items.length).toBeGreaterThanOrEqual(3);
          expect(items.find((i) => i.category === 'earnings')?.kind).toBe('earnings');
        }
      }
    }
  }, LONG);
});

describe('sector, economy and viral news', () => {
  const cycles = 400;
  const market: NewsDraft[] = [];
  for (let cycle = 0; cycle < cycles; cycle += 1) market.push(...marketCycleDrafts(SEED, companies, cycle));
  const viral = market.filter((i) => i.kind === 'viral' && !i.key.endsWith('f'));

  it('viral events are uncommon: roughly one every two to three days across the whole market', () => {
    const perDay = viral.length / cycles;
    expect(perDay).toBeGreaterThan(0.35);
    expect(perDay).toBeLessThan(0.6);
    // and very rare for any one company
    const hits = new Map<number, number>();
    for (const v of viral) if (v.companyId !== null) hits.set(v.companyId, (hits.get(v.companyId) ?? 0) + 1);
    const perCompanyDay = viral.length / (cycles * companies.length);
    expect(perCompanyDay).toBeLessThan(0.002);
    expect(Math.max(...hits.values())).toBeLessThan(8);
  }, LONG);

  it('viral events are always labelled breaking, come from invented people, and have varied outcomes', () => {
    expect(viral.length).toBeGreaterThan(100);
    for (const v of viral) {
      expect(v.breaking).toBe(true);
      expect(v.credibility).not.toBeNull();
    }
    const pos = viral.filter((v) => v.direction === 'positive');
    expect(pos.filter((v) => v.realized < 0).length).toBeGreaterThan(0);
    expect(viral.filter((v) => v.direction === 'uncertain').length).toBeGreaterThan(10);
    const kinds = new Set(viral.map((v) => v.headline.split(' ').slice(0, 2).join(' ')));
    expect(kinds.size).toBeGreaterThan(20);
    const strengths = new Set(viral.map((v) => v.strength));
    expect(strengths.size).toBe(4);
  });

  it('low-credibility hype fades: a follow-up story pushes the other way', () => {
    const fades = market.filter((i) => i.key.endsWith('f'));
    expect(fades.length).toBeGreaterThan(10);
    for (const f of fades) {
      const first = viral.find((v) => v.key === f.key.slice(0, -1)) as NewsDraft;
      expect(first).toBeDefined();
      expect(first.credibility).toBeLessThan(0.5);
      expect(f.companyId).toBe(first.companyId);
      expect(f.publishTick).toBeGreaterThan(first.publishTick);
      expect(Math.sign(f.realized)).toBe(-Math.sign(first.realized));
      expect(Math.abs(f.realized)).toBeLessThan(Math.abs(first.realized));
      expect(f.breaking).toBe(false);
    }
  });

  it('viral moves are larger than ordinary news on average, and bigger for small, thinly traded companies', () => {
    const company = viral.filter((v) => v.companyId !== null);
    const meanAbs = (xs: NewsDraft[]): number => xs.reduce((a, i) => a + Math.abs(i.realized), 0) / xs.length;
    const ordinary: NewsDraft[] = [];
    for (let cycle = 0; cycle < 20; cycle += 1) for (const c of companies.slice(0, 100)) ordinary.push(...companyCycleDrafts(SEED, c, companies, cycle));
    expect(meanAbs(company)).toBeGreaterThan(meanAbs(ordinary) * 1.8);
    const byTier = (t: string): NewsDraft[] => company.filter((v) => companies[v.companyId as number]?.tier === t);
    const small = [...byTier('micro'), ...byTier('small')];
    const big = [...byTier('large'), ...byTier('mega')];
    expect(small.length).toBeGreaterThan(20);
    expect(big.length).toBeGreaterThan(5);
    expect(meanAbs(small)).toBeGreaterThan(meanAbs(big) * 1.5);
    // credibility matters: more believable sources move prices more
    const hi = company.filter((v) => (v.credibility ?? 0) >= 0.6);
    const lo = company.filter((v) => (v.credibility ?? 1) < 0.4);
    expect(meanAbs(hi)).toBeGreaterThan(meanAbs(lo));
  });

  it('a company is never made viral before it has traded for two hours', () => {
    const cat = buildCatalog(30, (id) => (id >= 20 ? 400 * NEWS_CYCLE_TICKS - 3600 : 0));
    for (let cycle = 395; cycle < 402; cycle += 1) {
      for (const v of marketCycleDrafts(SEED, cat, cycle)) {
        if (v.kind === 'viral' && v.companyId !== null) {
          const c = cat[v.companyId] as Company;
          expect(v.publishTick).toBeGreaterThanOrEqual(c.listingTick + 7200);
        }
      }
    }
  });

  it('sector news: about 0.7 per sector per day; economy news: about 0.65 per day and smaller than company news', () => {
    const sector = market.filter((i) => i.category === 'sector');
    const macro = market.filter((i) => i.category === 'macro');
    expect(sector.length / (cycles * 13)).toBeGreaterThan(0.55);
    expect(sector.length / (cycles * 13)).toBeLessThan(0.8);
    expect(macro.length / cycles).toBeGreaterThan(0.5);
    expect(macro.length / cycles).toBeLessThan(0.8);
    for (const m of macro) expect(m.scope).toBe('market');
    for (const s of sector) expect(s.sector).not.toBeNull();
    const meanAbs = (xs: NewsDraft[]): number => xs.reduce((a, i) => a + Math.abs(i.realized), 0) / xs.length;
    expect(meanAbs(macro)).toBeLessThan(0.01);
  });

  it('no two items anywhere share a key', () => {
    const keys = new Set<string>();
    for (const i of market) {
      expect(keys.has(i.key)).toBe(false);
      keys.add(i.key);
    }
  });
});

describe('news becomes price effects', () => {
  it('every draft converts to an event the price engine accepts; sector and market events reach many stocks, once each', () => {
    const small = buildCatalog(66);
    for (let cycle = 0; cycle < 6; cycle += 1) {
      const drafts = [...small.flatMap((c) => companyCycleDrafts(SEED, c, small, cycle)), ...marketCycleDrafts(SEED, small, cycle)];
      for (const d of drafts) {
        const ev = eventOf(d);
        const effects = effectsOf(ev, small);
        expect(effects.length).toBeGreaterThan(0);
        const perCompany = new Map<number, number>();
        for (const e of effects) perCompany.set(e.companyId, (perCompany.get(e.companyId) ?? 0) + 1);
        for (const n of perCompany.values()) expect(n).toBe(1);
        if (d.scope === 'market') expect(effects.length).toBe(small.length);
        if (d.scope === 'sector') expect(effects.length).toBe(small.filter((c) => c.sector === d.sector).length);
        if (d.scope === 'company+partner') expect(effects.length).toBe(2);
      }
    }
  }, LONG);

  it('partnership news names the partner and affects both companies', () => {
    let found = 0;
    for (let cycle = 0; cycle < 40 && found < 8; cycle += 1) {
      for (const c of companies.slice(0, 100)) {
        for (const d of companyCycleDrafts(SEED, c, companies, cycle)) {
          if (d.scope === 'company+partner') {
            found += 1;
            const partner = companies[d.partnerId as number] as Company;
            expect(partner.id).toBe(c.peerId);
            expect(d.headline + d.body).toContain(partner.name);
          }
        }
      }
    }
    expect(found).toBeGreaterThanOrEqual(8);
  }, LONG);
});

describe('formatting', () => {
  it('amounts read like money', () => {
    expect(money(1_234_000_000)).toBe('$1.2 billion');
    expect(money(850_000_000)).toBe('$850 million');
    expect(money(12_340_000)).toBe('$12.3 million');
    expect(money(640_000)).toBe('$640 thousand');
    expect(money(10)).toBe('$1 thousand');
    expect(money(2_004_000)).toBe('$2 million');
    expect(money(1_000_000_000)).toBe('$1 billion');
  });
});
