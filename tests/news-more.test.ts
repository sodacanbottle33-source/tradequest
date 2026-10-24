// The size and quality of the news wordings (docs/world.md §4.7): how many different stories the game can tell, that none repeats another, that every
// one reads cleanly once filled in, that the generator really reaches all of them, and that adding wordings changes only words (no price, no number).
import { describe, expect, it } from 'vitest';
import {
  COMPANY_TEMPLATES,
  CURATED,
  EARNINGS_TEMPLATES,
  LISTING_TEMPLATES,
  MACRO_TEMPLATES,
  SECTOR_TEMPLATES,
  VIRAL_FADE_TEMPLATES,
  VIRAL_TEMPLATES,
  buildCatalog,
  companyCycleDrafts,
  fill,
  marketCycleDrafts,
  memeEntries,
  slotsIn,
  type Company,
  type NewsDraft,
  type TemplateSet,
} from '../src/world';
import { MEME_COMPANY_TEMPLATES, MEME_FADE_TEMPLATES, MEME_LISTING_TEMPLATES, MEME_SECTOR_TEMPLATES, MEME_VIRAL_TEMPLATES } from '../src/world/memeNews';
import { plus, plusEach } from '../src/world/templateSets';

const SEED = 20261015;
const LONG = 600_000;
const DIRS = ['positive', 'negative', 'uncertain'] as const;
type T = [string, string];

/** Every list of wordings the generator can draw from, with a name. The coin sector set is the same object in two places, so each list is taken once. */
function lists(kind: 'stock' | 'meme'): Map<T[], string> {
  const out = new Map<T[], string>();
  const add = (name: string, set: TemplateSet): void => {
    for (const d of DIRS) {
      const list = set[d] as T[] | undefined;
      if (list && !out.has(list)) out.set(list, `${name}/${d}`);
    }
  };
  if (kind === 'stock') {
    for (const [k, v] of Object.entries(COMPANY_TEMPLATES)) add(`company:${k}`, v);
    for (const [k, v] of Object.entries(SECTOR_TEMPLATES)) if (v !== MEME_SECTOR_TEMPLATES) add(`sector:${k}`, v);
    add('macro', MACRO_TEMPLATES);
    add('earnings', EARNINGS_TEMPLATES);
    add('listing', LISTING_TEMPLATES);
    add('fade', VIRAL_FADE_TEMPLATES);
    for (const [k, v] of Object.entries(VIRAL_TEMPLATES)) add(`viral:${k}`, v);
  } else {
    // A coin never draws a research story, so that alias is left out.
    for (const [k, v] of Object.entries(MEME_COMPANY_TEMPLATES)) if (k !== 'research') add(`company:${k}`, v);
    add('listing', MEME_LISTING_TEMPLATES);
    add('fade', MEME_FADE_TEMPLATES);
    add('sector', MEME_SECTOR_TEMPLATES);
    for (const [k, v] of Object.entries(MEME_VIRAL_TEMPLATES)) add(`viral:${k}`, v);
  }
  return out;
}
const all = (kind: 'stock' | 'meme'): T[] => [...lists(kind).keys()].flat();

const stockWorld = buildCatalog(500);
const coinWorld: Company[] = (() => {
  const own = new Map(memeEntries().map((e, i) => [CURATED.length + i, e]));
  return buildCatalog(CURATED.length + own.size, () => 0, own);
})();
const coins = coinWorld.filter((c) => c.sector === 'meme');

describe('how many stories the game can tell', () => {
  it('NM-1: at least 550 different stories for stocks and 240 for memecoins, 800 together', () => {
    const stock = all('stock').length;
    const meme = all('meme').length;
    expect(stock).toBeGreaterThanOrEqual(550);
    expect(meme).toBeGreaterThanOrEqual(240);
    expect(stock + meme).toBeGreaterThanOrEqual(800);
  });

  it('NM-2: no two stories of stocks share a headline, none of coins either, and no two stories anywhere share their text', () => {
    for (const kind of ['stock', 'meme'] as const) {
      const heads = all(kind).map(([h]) => h);
      const dup = heads.filter((h, i) => heads.indexOf(h) !== i);
      expect(dup).toEqual([]);
    }
    const bodies = [...all('stock'), ...all('meme')].map(([, b]) => b);
    expect(bodies.filter((b, i) => bodies.indexOf(b) !== i)).toEqual([]);
  });

  it('NM-3: each list is at least as long as before: nothing was removed, the new wordings sit after the old ones', () => {
    const base: TemplateSet = { positive: [['A {co}', 'a one']], negative: [['B {co}', 'b one']] };
    const more: TemplateSet = { positive: [['C {co}', 'c one']], uncertain: [['D {co}', 'd one']] };
    const joined = plus(base, more);
    expect(joined.positive?.map((t) => t[0])).toEqual(['A {co}', 'C {co}']);
    expect(joined.negative?.map((t) => t[0])).toEqual(['B {co}']);
    expect(joined.uncertain?.map((t) => t[0])).toEqual(['D {co}']);
    expect(plus(base, undefined)).toBe(base);
    const each = plusEach({ x: base, y: more }, { x: more });
    expect(each.x.positive?.length).toBe(2);
    expect(each.y).toEqual(more);
  });
});

/** Slots filled with realistic values, built from a real company, so the check sees what a player would read. */
function slotsOf(c: Company, peer: Company, k: number): Record<string, string> {
  return {
    co: c.name,
    tk: c.ticker,
    prod: c.products[k % 2] ?? c.name,
    prod2: c.products[(k + 1) % 2] ?? c.name,
    ceo: c.ceo,
    cfo: c.cfo,
    hq: c.hq,
    peer: peer.name,
    sector: ['technology', 'AI', 'healthcare', 'media and entertainment', 'aerospace and defense', 'meme'][k % 6] as string,
    n: String(3 + ((k * 7) % 45)),
    pct: String(3 + ((k * 5) % 22)),
    amt: '$1.2 million',
    region: ['Northern Europe', 'the Midwest', 'West Africa'][k % 3] as string,
    firm: 'Ashgrove Research',
    person: 'Quentin Dunmore',
    q: 'third-quarter',
    qn: 'third quarter',
    eps: '$1.42',
    epscons: '$1.30',
    epsdiff: '$0.12',
    epscmp: 'above',
    surp: '9.2%',
    rev: '$4.1 billion',
    revcons: '$3.9 billion',
    revcmp: 'above',
    yoy: 'up 12%',
  };
}

describe('stocks and coins keep to their own wordings', () => {
  // The economy stories (MACRO_TEMPLATES) are the one set both markets show: the economy moves everything. Every other kind of story has a stock set and a coin set.
  const coinTalk = /\b(memes?|memecoins?|degens?|airdrops?|mascots?|whales?|rugs?|hodl|wallets?|emojis?|discord|tokens?|coins?)\b/i;
  const companyTalk = /\b(dividends?|earnings|quarterly|quarter|shareholders?|patents?|factory|factories|revenue|antitrust|warehouse|unions?)\b|\{cfo\}|supply chain/i;

  it('NM-8: no coin talk in a story about a stock, no company talk in a story about a coin, and no headline used by both', () => {
    const problems: string[] = [];
    for (const [list, name] of lists('stock')) for (const [h, b] of list) if (coinTalk.test(`${h} ${b}`)) problems.push(`coin talk in a stock story ${name}: ${h}`);
    for (const [list, name] of lists('meme')) for (const [h, b] of list) if (companyTalk.test(`${h} ${b}`)) problems.push(`company talk in a coin story ${name}: ${h}`);
    expect(problems).toEqual([]);
    const stockHeads = new Set(all('stock').map(([h]) => h));
    expect(all('meme').map(([h]) => h).filter((h) => stockHeads.has(h))).toEqual([]);
  });

  it('NM-9: a coin that fades after a viral story gets a coin wording, a stock gets a stock wording', () => {
    // Every list of fade wordings is its own object; the coin ones are not the stock ones.
    const stockFade = new Set<T[]>([VIRAL_FADE_TEMPLATES.positive as T[], VIRAL_FADE_TEMPLATES.negative as T[]]);
    expect(stockFade.has(MEME_FADE_TEMPLATES.positive as T[])).toBe(false);
    expect(stockFade.has(MEME_FADE_TEMPLATES.negative as T[])).toBe(false);
    // Over a long run every fade that comes out for a coin is one of the coin ones, and every one for a stock is a stock one.
    const mark = (set: TemplateSet, tag: string): [T[], T[]][] => {
      const saved: [T[], T[]][] = [];
      for (const d of ['positive', 'negative'] as const) {
        const list = set[d] as T[];
        saved.push([list, list.slice()]);
        list.forEach((_t, i) => (list[i] = [`@@${tag}.${d}.${i}`, 'Body.']));
      }
      return saved;
    };
    const saved = [...mark(VIRAL_FADE_TEMPLATES, 'stock'), ...mark(MEME_FADE_TEMPLATES, 'coin')];
    let stockFades = 0;
    let coinFades = 0;
    try {
      for (let cycle = 0; cycle < 1500; cycle += 1) {
        for (const d of marketCycleDrafts(SEED, stockWorld, cycle)) if (d.key.endsWith('f')) { stockFades += 1; expect(d.headline.startsWith('@@stock.')).toBe(true); }
        for (const d of marketCycleDrafts(SEED, coins, cycle)) if (d.key.endsWith('f')) { coinFades += 1; expect(d.headline.startsWith('@@coin.')).toBe(true); }
      }
    } finally {
      for (const [list, original] of saved) list.splice(0, list.length, ...original);
    }
    expect(stockFades).toBeGreaterThan(30);
    expect(coinFades).toBeGreaterThan(30);
  }, LONG);
});

describe('every story reads cleanly', () => {
  it('NM-4: filled in for real companies and coins, no story has a stray brace, double space, space before a mark, doubled word or a headline over 90 characters', () => {
    const problems: string[] = [];
    for (const kind of ['stock', 'meme'] as const) {
      const pool = kind === 'stock' ? stockWorld : coins;
      for (const [list, name] of lists(kind)) {
        for (const [h, b] of list) {
          for (let k = 0; k < 8; k += 1) {
            const c = pool[(k * 37 + 3) % pool.length] as Company;
            const peer = pool[(k * 37 + 11) % pool.length] as Company;
            const slots = slotsOf(c, peer, k);
            const head = fill(h, slots);
            const body = fill(b, slots);
            const text = `${head} || ${body}`;
            const where = `${kind}/${name}: ${head}`;
            if (/[{}]/.test(text)) problems.push(`brace ${where}`);
            if (/\s{2,}/.test(text)) problems.push(`double space ${where}`);
            if (/ [,.;:!?]/.test(text)) problems.push(`space before mark ${where}`);
            if (/\.\./.test(text)) problems.push(`double dot ${where}`);
            // "ha ha" is a joke in one of the older coin stories, not a slip.
            if (/\b(\w+) \1\b/i.test(text.replace(/\bha ha\b/gi, 'ha'))) problems.push(`repeated word ${where}`);
            if (/undefined|NaN/.test(text)) problems.push(`bad value ${where}`);
            if (/[.!?]$/.test(head)) problems.push(`headline ends with a mark ${where}`);
            if (head.length > 90) problems.push(`long headline ${where}`);
            if (!/[.!?"]$/.test(body)) problems.push(`body does not end with a mark ${where}`);
          }
        }
      }
    }
    expect([...new Set(problems)]).toEqual([]);
  });

  it('NM-5: every wording only uses slots its kind of story is given (sector and economy stories none, partnership stories name the partner)', () => {
    for (const kind of ['stock', 'meme'] as const) {
      for (const [list, name] of lists(kind)) {
        if (name.startsWith('sector:') || name.startsWith('sector/') || name.startsWith('macro')) {
          for (const [h, b] of list) expect(slotsIn(h).length + slotsIn(b).length).toBe(0);
        }
        if (name.startsWith('company:partnership')) for (const [h, b] of list) expect(slotsIn(h + ' ' + b).includes('peer')).toBe(true);
        // A viral story from an official is about a whole sector, so it must not name a company (it has no company in its scope).
        if (name.startsWith('viral:official')) for (const [h, b] of list) expect(slotsIn(h + ' ' + b).filter((s) => ['co', 'tk', 'prod', 'prod2', 'ceo', 'cfo', 'peer'].includes(s))).toEqual([]);
      }
    }
  });
});

/** Everything about the drafts except the words. */
function numbers(drafts: NewsDraft[]): string {
  return JSON.stringify(drafts.map(({ headline: _h, body: _b, ...rest }) => rest));
}
function generate(): NewsDraft[] {
  const out: NewsDraft[] = [];
  for (let cycle = 0; cycle < 30; cycle += 1) {
    for (const c of stockWorld.slice(0, 60)) out.push(...companyCycleDrafts(SEED, c, stockWorld, cycle));
    for (const c of coins.slice(0, 10)) out.push(...companyCycleDrafts(SEED, c, coinWorld, cycle));
    out.push(...marketCycleDrafts(SEED, stockWorld, cycle), ...marketCycleDrafts(SEED, coins, cycle));
  }
  for (let cycle = 30; cycle < 400; cycle += 1) out.push(...marketCycleDrafts(SEED, stockWorld, cycle));
  return out;
}

describe('more wordings change only words', () => {
  it('NM-6: with extra wordings in every list, every price effect, timing, strength and number of every story stays exactly the same', () => {
    const touched: [T[], T[]][] = [];
    for (const kind of ['stock', 'meme'] as const) for (const list of lists(kind).keys()) touched.push([list, list.slice()]);
    const before = generate();
    try {
      for (const [list] of touched) {
        list.push(['Extra headline one', 'Extra body one.'], ['Extra headline two', 'Extra body two.']);
        list.unshift(['Extra headline zero', 'Extra body zero.']);
      }
      const after = generate();
      expect(after.length).toBe(before.length);
      expect(numbers(after)).toBe(numbers(before));
      // ... and the words did change, so the check is not looking at the same thing twice.
      expect(after.some((d, i) => d.headline !== (before[i] as NewsDraft).headline)).toBe(true);
    } finally {
      for (const [list, original] of touched) list.splice(0, list.length, ...original);
    }
  }, LONG);
});

describe('the generator reaches the new wordings', () => {
  it('NM-7: over a long run, at least 95 % of the wordings for stocks and for coins are used at least once', () => {
    const touched = new Map<string, { list: T[]; i: number }>();
    const saved: [T[], T[]][] = [];
    let id = 0;
    for (const kind of ['stock', 'meme'] as const) {
      for (const [list, name] of lists(kind)) {
        saved.push([list, list.slice()]);
        // A listing story is told only on the day a company lists, which depends on launches, so it is not part of this count (it is checked by NM-4).
        if (name.startsWith('listing')) continue;
        list.forEach((_t, i) => {
          const token = `@@${kind}.${(id += 1)}`;
          touched.set(token, { list, i });
          list[i] = [token, 'Body.'];
        });
      }
    }
    const seen = new Set<string>();
    const note = (drafts: NewsDraft[]): void => {
      for (const d of drafts) if (d.headline.startsWith('@@')) seen.add(d.headline);
    };
    try {
      for (let cycle = 0; cycle < 60; cycle += 1) for (const c of stockWorld) note(companyCycleDrafts(SEED, c, stockWorld, cycle));
      for (let cycle = 0; cycle < 300; cycle += 1) for (const c of coins) note(companyCycleDrafts(SEED, c, coinWorld, cycle));
      for (let cycle = 0; cycle < 4000; cycle += 1) {
        note(marketCycleDrafts(SEED, stockWorld, cycle));
        note(marketCycleDrafts(SEED, coins, cycle));
      }
    } finally {
      for (const [list, original] of saved) list.splice(0, list.length, ...original);
    }
    for (const kind of ['stock', 'meme']) {
      const tokens = [...touched.keys()].filter((t) => t.startsWith(`@@${kind}.`));
      const used = tokens.filter((t) => seen.has(t)).length;
      expect(used / tokens.length).toBeGreaterThanOrEqual(0.95);
    }
  }, LONG);
});
