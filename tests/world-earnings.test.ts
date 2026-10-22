// Company fundamentals and quarterly reports (docs/world.md §7.5): what analysts expect, what the company earns, how the news item agrees with the
// numbers, and that nothing here can run away or leak the hidden move of a story.
import { describe, expect, it } from 'vitest';
import {
  EARNINGS_PERIOD_CYCLES,
  MILLS_PER_DOLLAR,
  NEWS_CYCLE_TICKS,
  QUARTERS_PER_YEAR,
  bpText,
  buildCatalog,
  centsText,
  companyCycleDrafts,
  consensusOf,
  earningsDue,
  earningsOutcome,
  epsText,
  figuresFor,
  profileOf,
  quarterLabel,
  quarterOfCycle,
  quarterWord,
  reportCycleAtOrBefore,
  reportsInCycle,
  revenueText,
  surpriseOf,
  trailingEps,
  yoyText,
  type Company,
  type Direction,
  type Strength,
} from '../src/world';

const SEED = 20261015;
const LONG = 120_000;
const companies = buildCatalog(500);
const stocks = companies.filter((c) => c.listingTick === 0 && c.sector !== 'meme').slice(0, 150);
const outcomeFn = (c: Company) => (cycle: number) => earningsOutcome(SEED, c, cycle);

describe('earnings: the numbers', () => {
  it('EARN-1: a company reports on one fixed day of every 3-day quarter; coins, negative days and the listing day never report', () => {
    expect(EARNINGS_PERIOD_CYCLES).toBe(3);
    expect(QUARTERS_PER_YEAR).toBe(4);
    for (const c of stocks.slice(0, 60)) {
      const p = profileOf(SEED, c);
      expect(p.offset).toBeGreaterThanOrEqual(0);
      expect(p.offset).toBeLessThan(EARNINGS_PERIOD_CYCLES);
      const days: number[] = [];
      for (let cycle = 0; cycle < 30; cycle += 1) if (reportsInCycle(SEED, c, cycle)) days.push(cycle);
      expect(days.length).toBe(10);
      for (let i = 1; i < days.length; i += 1) expect((days[i] as number) - (days[i - 1] as number)).toBe(EARNINGS_PERIOD_CYCLES);
      expect(reportsInCycle(SEED, c, -3)).toBe(false);
      // The same answer from the story side.
      for (let cycle = 0; cycle < 12; cycle += 1) expect(earningsDue(SEED, c, cycle)).toBe(reportsInCycle(SEED, c, cycle));
    }
    const coin = companies.find((c) => c.sector === 'meme');
    if (coin) for (let cycle = 0; cycle < 12; cycle += 1) expect(reportsInCycle(SEED, coin, cycle)).toBe(false);
    // A company that lists part-way through a day does not report on that day.
    const later = companies.find((c) => c.listingTick > 0 && c.sector !== 'meme');
    if (later) {
      const listingCycle = Math.floor(later.listingTick / NEWS_CYCLE_TICKS);
      expect(earningsOutcome(SEED, later, listingCycle)).toBeNull();
      for (let cycle = 0; cycle < listingCycle; cycle += 1) expect(earningsOutcome(SEED, later, cycle)).toBeNull();
    }
  });

  it('EARN-2: what analysts expect depends only on the company and the quarter (never on the news) and fits the sector: the price/earnings ratio at the catalog price stays in a sane band', () => {
    for (const c of stocks) {
      const p = profileOf(SEED, c);
      expect(p.pe).toBeGreaterThan(5);
      expect(p.pe).toBeLessThan(80);
      expect(p.margin).toBeGreaterThan(0.03);
      expect(p.margin).toBeLessThan(0.4);
      for (let cycle = 0; cycle < 600; cycle += EARNINGS_PERIOD_CYCLES) {
        const k = consensusOf(SEED, c, cycle);
        expect(k.epsMills).toBeGreaterThanOrEqual(5);
        expect(k.revenue).toBeGreaterThan(0);
        // The price of a year of such earnings, against the catalog price, stays within the swing of the company.
        const ratio = (c.basePriceCents * 10) / (k.epsMills * QUARTERS_PER_YEAR);
        expect(ratio).toBeGreaterThan(p.pe / (1 + p.waveAmp + 0.05));
        expect(ratio).toBeLessThan(p.pe / Math.max(0.3, 1 - p.waveAmp - 0.05) + 5); // (+5: a very cheap share is rounded to a whole mill)
        // Profit = revenue × margin (within the rounding of a dollar).
        const profit = (k.epsMills / MILLS_PER_DOLLAR) * c.sharesOutstanding;
        expect(Math.abs(k.revenue * p.margin - profit)).toBeLessThanOrEqual(1 + p.margin);
      }
      // The same thing twice.
      expect(consensusOf(SEED, c, 33)).toEqual(consensusOf(SEED, c, 33));
    }
    // Another world has other numbers.
    const c = stocks[0] as Company;
    let same = 0;
    for (let cycle = 0; cycle < 120; cycle += 3) if (consensusOf(SEED, c, cycle).epsMills === consensusOf(SEED + 1, c, cycle).epsMills) same += 1;
    expect(same).toBeLessThan(40);
  });

  it('EARN-3: sectors and characters differ: software is priced dearer than banks, a growth stock dearer than a declining one', () => {
    const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
    const peOf = (pred: (c: Company) => boolean): number => mean(stocks.filter(pred).map((c) => profileOf(SEED, c).pe));
    expect(peOf((c) => c.sector === 'ai' || c.sector === 'tech')).toBeGreaterThan(peOf((c) => c.sector === 'finance' || c.sector === 'energy') + 8);
    const growth = stocks.filter((c) => c.personality === 'growth');
    const declining = stocks.filter((c) => c.personality === 'declining');
    expect(growth.length).toBeGreaterThan(5);
    expect(declining.length).toBeGreaterThan(5);
    expect(peOf((c) => c.personality === 'growth')).toBeGreaterThan(peOf((c) => c.personality === 'declining') + 6);
    // A cyclical company's earnings swing more than a steady one's.
    const swing = (c: Company): number => {
      let lo = Infinity;
      let hi = 0;
      for (let q = 0; q < 60; q += 1) {
        const e = consensusOf(SEED, c, q * EARNINGS_PERIOD_CYCLES).epsMills;
        lo = Math.min(lo, e);
        hi = Math.max(hi, e);
      }
      return (hi - lo) / ((hi + lo) / 2);
    };
    const cyc = stocks.filter((c) => c.personality === 'cyclical' && c.basePriceCents > 2000);
    const steady = stocks.filter((c) => c.personality === 'steady' && c.basePriceCents > 2000);
    expect(mean(cyc.map(swing))).toBeGreaterThan(mean(steady.map(swing)) * 2);
  });
});

describe('earnings: the surprise', () => {
  const cases: [Strength, number, number][] = [
    ['minor', 100, 300],
    ['moderate', 300, 700],
    ['major', 700, 1500],
    ['extreme', 1500, 3000],
  ];

  it('EARN-4: a positive report beats and a negative one misses, by an amount that follows the strength of the story; revenue usually goes the same way', () => {
    let revSame = 0;
    let total = 0;
    for (const [strength, lo, hi] of cases) {
      for (const c of stocks.slice(0, 50)) {
        for (let cycle = 0; cycle < 90; cycle += 7) {
          const up = surpriseOf(SEED, c, cycle, 'positive', strength);
          const down = surpriseOf(SEED, c, cycle, 'negative', strength);
          expect(up.kind).toBe('beat');
          expect(down.kind).toBe('miss');
          expect(up.epsBp).toBeGreaterThanOrEqual(lo);
          expect(up.epsBp).toBeLessThan(hi);
          expect(down.epsBp).toBe(-up.epsBp);
          if (up.revBp > 0) revSame += 1;
          total += 1;
        }
      }
    }
    expect(revSame / total).toBeGreaterThan(0.8);
    expect(revSame / total).toBeLessThan(0.97); // now and then revenue goes the other way
  });

  it('EARN-5: an uncertain report is in line, or mixed one way or the other, never a clear beat or miss', () => {
    const kinds = new Map<string, number>();
    for (const c of stocks.slice(0, 80)) {
      for (let cycle = 0; cycle < 90; cycle += 3) {
        const s = surpriseOf(SEED, c, cycle, 'uncertain', 'moderate');
        kinds.set(s.kind, (kinds.get(s.kind) ?? 0) + 1);
        if (s.kind === 'inline') {
          expect(Math.abs(s.epsBp)).toBeLessThanOrEqual(50);
          expect(Math.abs(s.revBp)).toBeLessThanOrEqual(30);
        } else if (s.kind === 'epsBeatRevMiss') {
          expect(s.epsBp).toBeGreaterThanOrEqual(100);
          expect(s.revBp).toBeLessThanOrEqual(-60);
        } else {
          expect(s.kind).toBe('epsMissRevBeat');
          expect(s.epsBp).toBeLessThanOrEqual(-100);
          expect(s.revBp).toBeGreaterThanOrEqual(60);
        }
      }
    }
    expect([...kinds.keys()].sort()).toEqual(['epsBeatRevMiss', 'epsMissRevBeat', 'inline']);
    for (const n of kinds.values()) expect(n).toBeGreaterThan(30);
  });

  it('EARN-6: the numbers of a report: actual = consensus + surprise, at least a mill apart for a beat or a miss; with no report they are the consensus', () => {
    for (const c of stocks.slice(0, 80)) {
      for (const direction of ['positive', 'negative', 'uncertain'] as Direction[]) {
        for (const [strength] of cases) {
          const cycle = 30 + (c.id % 3);
          const f = figuresFor(SEED, c, cycle, { direction, strength });
          const cons = consensusOf(SEED, c, cycle);
          expect(f.epsConsMills).toBe(cons.epsMills);
          expect(f.revConsDollars).toBe(cons.revenue);
          if (f.kind === 'beat') expect(f.epsMills).toBeGreaterThan(f.epsConsMills);
          if (f.kind === 'miss') expect(f.epsMills).toBeLessThan(f.epsConsMills);
          expect(f.epsMills).toBeGreaterThanOrEqual(0);
          expect(f.revDollars).toBe(Math.round(cons.revenue + (cons.revenue * f.revBp) / 10_000));
          const ago = consensusOf(SEED, c, cycle - 12).epsMills;
          expect(f.epsYearAgoMills).toBe(ago);
          expect(f.yoyBp).toBe(Math.round(((f.epsMills - ago) * 10_000) / ago));
        }
      }
      const none = figuresFor(SEED, c, 30, null);
      expect(none).toMatchObject({ kind: 'baseline', epsBp: 0, revBp: 0 });
      expect(none.epsMills).toBe(none.epsConsMills);
      expect(none.revDollars).toBe(none.revConsDollars);
    }
  });

  it('EARN-7: a year of earnings (and with it the price/earnings ratio) stays in a sane band however many quarters pass', () => {
    let lo = Infinity;
    let hi = 0;
    for (const c of stocks) {
      const p = profileOf(SEED, c);
      for (let cycle = 12; cycle < 900; cycle += EARNINGS_PERIOD_CYCLES) {
        if (!reportsInCycle(SEED, c, cycle)) continue;
        const ttm = trailingEps(SEED, c, cycle, outcomeFn(c));
        const ratio = ((c.basePriceCents * 10) / ttm) / p.pe;
        lo = Math.min(lo, ratio);
        hi = Math.max(hi, ratio);
      }
    }
    expect(lo).toBeGreaterThan(0.5);
    expect(hi).toBeLessThan(2.2);
  }, LONG);

  it('EARN-8: the latest report at or before a day is found, and a quarter is never counted twice', () => {
    for (const c of stocks.slice(0, 40)) {
      for (let cycle = 0; cycle < 40; cycle += 1) {
        const last = reportCycleAtOrBefore(SEED, c, cycle);
        expect(last).toBeLessThanOrEqual(cycle);
        expect(cycle - last).toBeLessThan(EARNINGS_PERIOD_CYCLES);
        if (last >= 0) expect(reportsInCycle(SEED, c, last)).toBe(true);
        if (cycle >= 0 && last >= 0) expect(quarterOfCycle(SEED, c, last)).toBe(quarterOfCycle(SEED, c, cycle));
      }
    }
  });
});

describe('earnings: the story', () => {
  const reports: { c: Company; cycle: number }[] = [];
  for (const c of stocks) for (let cycle = 0; cycle < 12; cycle += 1) if (earningsOutcome(SEED, c, cycle)) reports.push({ c, cycle });

  it('EARN-9: the story has the numbers of the report and says what the numbers say', () => {
    expect(reports.length).toBeGreaterThan(300);
    const seen = { positive: 0, negative: 0, inline: 0, epsBeatRevMiss: 0, epsMissRevBeat: 0 };
    for (const { c, cycle } of reports) {
      const item = companyCycleDrafts(SEED, c, companies, cycle).find((i) => i.category === 'earnings');
      expect(item).toBeDefined();
      if (!item) continue;
      const out = earningsOutcome(SEED, c, cycle);
      expect(out).not.toBeNull();
      if (!out) continue;
      // The story is the outcome.
      expect(item.direction).toBe(out.direction);
      expect(item.strength).toBe(out.strength);
      expect(item.publishTick).toBe(out.publishTick);
      expect(item.startTick).toBe(out.startTick);
      expect(item.realized).toBe(out.realized);
      expect(item.kind).toBe('earnings');
      const f = figuresFor(SEED, c, cycle, out);
      const text = `${item.headline} ${item.body}`;
      // The per-share profit is in the story, and (when the story compares it) so is what was expected.
      expect(item.body.includes(epsText(f.epsMills))).toBe(true);
      expect(/\{|undefined|NaN/.test(text)).toBe(false);
      if (out.direction === 'positive') {
        expect(f.epsMills).toBeGreaterThan(f.epsConsMills);
        expect(/miss|disappoint|falls short|loss/i.test(item.headline.replace(c.name, ''))).toBe(false);
        seen.positive += 1;
      } else if (out.direction === 'negative') {
        expect(f.epsMills).toBeLessThan(f.epsConsMills);
        expect(/beat|top|jump|stronger|record/i.test(item.headline.replace(c.name, ''))).toBe(false);
        seen.negative += 1;
      } else {
        // In line / mixed: the story is chosen by the numbers.
        if (f.kind === 'inline') expect(item.headline.includes('in line with forecasts')).toBe(true);
        if (f.kind === 'epsBeatRevMiss') expect(item.headline.startsWith('Mixed results')).toBe(true);
        if (f.kind === 'epsMissRevBeat') expect(item.headline.includes('sales beat but profit lags')).toBe(true);
        if (f.kind === 'inline' || f.kind === 'epsBeatRevMiss' || f.kind === 'epsMissRevBeat') seen[f.kind] += 1;
      }
      // Revenue in the story is the revenue of the report.
      if (/revenue/i.test(text)) expect(text.includes(revenueText(f.revDollars))).toBe(true);
      expect(/quarter quarter/.test(text)).toBe(false);
    }
    for (const n of Object.values(seen)) expect(n).toBeGreaterThan(10);
  }, LONG);

  it('EARN-10: the story never carries the hidden move; two reports with the same public side have the same numbers whatever the price does', () => {
    // figuresFor takes only the public side (direction and strength): the signature cannot even see `realized`.
    const c = stocks[0] as Company;
    const a = figuresFor(SEED, c, 30, { direction: 'positive', strength: 'major' });
    const b = figuresFor(SEED, c, 30, { direction: 'positive', strength: 'major', realized: -0.2 } as { direction: Direction; strength: Strength });
    expect(a).toEqual(b);
  });

  it('EARN-11: a report moves its price more than other company news does, in the same size class', () => {
    let earn = 0;
    let earnN = 0;
    let other = 0;
    let otherN = 0;
    for (const c of stocks.slice(0, 80)) {
      for (let cycle = 0; cycle < 12; cycle += 1) {
        for (const item of companyCycleDrafts(SEED, c, companies, cycle)) {
          if (item.companyId !== c.id) continue;
          if (item.category === 'earnings') {
            earn += Math.abs(item.realized) / c.newsSensitivity;
            earnN += 1;
          } else if (item.category === 'financial' || item.category === 'operations' || item.category === 'product') {
            other += Math.abs(item.realized) / c.newsSensitivity;
            otherN += 1;
          }
        }
      }
    }
    expect(earnN).toBeGreaterThan(100);
    expect(earn / earnN).toBeGreaterThan((other / otherN) * 2);
    // And nothing exceeds the cap on one story.
    for (const { c, cycle } of reports) expect(Math.abs((earningsOutcome(SEED, c, cycle) as { realized: number }).realized)).toBeLessThanOrEqual(0.25);
  });

  it('EARN-12: the report comes out in the middle third of its day, and a company has its three items that day as before', () => {
    for (const { c, cycle } of reports.slice(0, 400)) {
      const out = earningsOutcome(SEED, c, cycle) as { publishTick: number };
      const start = cycle * NEWS_CYCLE_TICKS;
      expect(out.publishTick).toBeGreaterThanOrEqual(start + Math.floor(NEWS_CYCLE_TICKS / 3));
      expect(out.publishTick).toBeLessThan(start + Math.floor((2 * NEWS_CYCLE_TICKS) / 3));
      const items = companyCycleDrafts(SEED, c, companies, cycle).filter((i) => i.companyId === c.id);
      expect(items.length).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('earnings: how numbers read', () => {
  it('EARN-13: the words for money, shares, percentages and quarters', () => {
    expect(epsText(310)).toBe('$0.31');
    expect(epsText(31)).toBe('$0.031');
    expect(epsText(5)).toBe('$0.005');
    expect(epsText(1250)).toBe('$1.25');
    expect(epsText(0)).toBe('$0.000');
    expect(epsText(-120)).toBe('−$0.12');
    expect(centsText(10)).toBe('1 cent');
    expect(centsText(40)).toBe('4 cents');
    expect(centsText(3)).toBe('0.3 cents');
    expect(centsText(-40)).toBe('4 cents');
    expect(bpText(840)).toBe('8.4%');
    expect(bpText(700)).toBe('7%');
    expect(bpText(1240)).toBe('12%');
    expect(bpText(-1240)).toBe('12%');
    expect(yoyText(1200)).toBe('up 12%');
    expect(yoyText(-500)).toBe('down 5%');
    expect(yoyText(20)).toBe('flat');
    expect(yoyText(-49)).toBe('flat');
    expect(revenueText(1.23e9)).toBe('$1.23 billion');
    expect(revenueText(12.34e9)).toBe('$12.3 billion');
    expect(revenueText(345e6)).toBe('$345 million');
    expect(revenueText(12.3e6)).toBe('$12.3 million');
    expect(revenueText(640e3)).toBe('$640 thousand');
    expect(quarterWord(0)).toBe('first-quarter');
    expect(quarterWord(5)).toBe('second-quarter');
    expect(quarterWord(-1)).toBe('fourth-quarter');
    expect(quarterLabel(3)).toBe('Q4');
    expect(quarterLabel(8)).toBe('Q1');
  });
});
