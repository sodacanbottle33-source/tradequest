// The news generator: a pure function of (world seed, catalog, cycle). It decides WHAT happens, WHEN it is announced, how
// strong it sounds, and — secretly — how the market will really react. The server stores the result once; the stored rows,
// not this function, are what the market follows (docs/world.md §7).
//
//  • Every company gets at least three company-specific items in every 24-hour cycle, one in each third of the day, plus
//    sometimes more. A company that lists during a cycle gets its three items between its listing and the end of the cycle.
//  • Each item has a PUBLIC side (category, direction, strength: what the headline says) and a HIDDEN side (the realised
//    move). The two agree only most of the time, so a headline is a clue and never a guarantee.
//  • Rare viral events with invented people can move a stock more than ordinary news — and sometimes fade again.

import { deriveSeed, hashUniformAt } from '../engine/rng';
import { NEWS_CYCLE_TICKS, SECTORS, type SectorId } from './params';
import {
  ADMIN_TEMPLATES,
  ANALYST_FIRMS,
  COMPANY_TEMPLATES,
  EARNINGS_TEMPLATES,
  LISTING_TEMPLATES,
  MACRO_TEMPLATES,
  PERSON_FIRST,
  PERSON_LAST,
  REGIONS,
  SECTOR_TEMPLATES,
  VIRAL_FADE_TEMPLATES,
  VIRAL_KINDS,
  VIRAL_TEMPLATES,
  fill,
  type Category,
  type CompanyCategory,
  type Template,
  type TemplateSet,
} from './newsText';
import { MEME_COMPANY_TEMPLATES, MEME_FADE_TEMPLATES, MEME_LISTING_TEMPLATES, MEME_VIRAL_TEMPLATES } from './memeNews';
import { bpText, centsText, epsText, figuresFor, quarterWord, reportsInCycle, revenueText, yoyText, type Figures, type ReportOutcome } from './fundamentals';
import type { Company, Direction, EventKind, EventScope, Immediacy, Shape, Strength, WorldEvent } from './types';

/** Every company gets at least this many company-specific items per cycle. */
export const MIN_ITEMS_PER_CYCLE = 3;
export const CORE_SLOTS = 3;
/** Largest single move a news item may cause (fraction of price). */
export const MAX_REALIZED = 0.25;

const STREAM_COMPANY = 0xfe00;
const STREAM_MARKET = 0xfe01;
// 0xfe02 belongs to fundamentals.ts.
const STREAM_EARNINGS_NEWS = 0xfe03;

export interface NewsDraft {
  readonly key: string;
  readonly kind: EventKind;
  readonly category: Category;
  readonly scope: EventScope;
  readonly companyId: number | null;
  readonly partnerId: number | null;
  readonly sector: SectorId | null;
  readonly cycle: number;
  readonly slot: number;
  readonly publishTick: number;
  readonly startTick: number;
  readonly durationTicks: number;
  readonly shape: Shape;
  readonly immediacy: Immediacy;
  /** What the headline says (public). */
  readonly direction: Direction;
  readonly strength: Strength;
  /** What the market will really do (hidden). */
  readonly realized: number;
  readonly permShare: number;
  readonly headline: string;
  readonly body: string;
  readonly breaking: boolean;
  /** How believable a viral source is (0 … 1); null for ordinary news. */
  readonly credibility: number | null;
}

class Draws {
  private k = 0;
  constructor(private readonly seed: number) {}
  u(): number {
    const v = hashUniformAt(this.seed, this.k);
    this.k += 1;
    return v;
  }
  int(n: number): number {
    return Math.floor(this.u() * n);
  }
  range(lo: number, hi: number): number {
    return lo + this.int(hi - lo + 1);
  }
  pick<T>(list: readonly T[]): T {
    return list[this.int(list.length)] as T;
  }
  /** Index chosen with probability proportional to the weights (all weights may be zero → index 0). */
  weighted(weights: readonly number[]): number {
    let total = 0;
    for (const w of weights) total += w;
    if (total <= 0) return 0;
    let x = this.u() * total;
    for (let i = 0; i < weights.length; i += 1) {
      x -= weights[i] as number;
      if (x < 0) return i;
    }
    return weights.length - 1;
  }
}

const STRENGTHS: readonly Strength[] = ['minor', 'moderate', 'major', 'extreme'];
const DIRECTIONS: readonly Direction[] = ['positive', 'negative', 'uncertain'];

/** Total move of an item, as a fraction of the price, before the company's own sensitivity. */
const MAGNITUDE: Readonly<Record<Strength, number>> = { minor: 0.002, moderate: 0.007, major: 0.02, extreme: 0.05 };
/** A report moves a price more than other company news: a miss or a beat is the news a stock waits for. */
const EARNINGS_MAGNITUDE: Readonly<Record<Strength, number>> = { minor: 0.008, moderate: 0.02, major: 0.045, extreme: 0.09 };
const SECTOR_MAGNITUDE: Readonly<Record<Strength, number>> = { minor: 0.0015, moderate: 0.005, major: 0.014, extreme: 0.035 };
const MACRO_MAGNITUDE: Readonly<Record<Strength, number>> = { minor: 0.0012, moderate: 0.004, major: 0.012, extreme: 0.03 };
const VIRAL_MAGNITUDE: Readonly<Record<Strength, number>> = { minor: 0.004, moderate: 0.012, major: 0.03, extreme: 0.07 };

const GRADUAL_SECONDS: Readonly<Record<Strength, readonly [number, number]>> = {
  minor: [120, 360],
  moderate: [300, 900],
  major: [600, 1800],
  extreme: [900, 2700],
};

interface CategoryRule {
  readonly weight: number;
  /** Weights of positive / negative / uncertain headlines. */
  readonly dir: readonly [number, number, number];
  /** Weights of minor / moderate / major / extreme. */
  readonly strength: readonly [number, number, number, number];
  /** Probability that the market reacts the way the headline suggests. */
  readonly follow: number;
  readonly immediate: number;
  readonly shape: Shape;
  readonly permShare: number;
}

const RULES: Readonly<Record<CompanyCategory, CategoryRule>> = {
  product: { weight: 14, dir: [50, 25, 25], strength: [55, 30, 13, 2], follow: 0.78, immediate: 0.35, shape: 'ramp', permShare: 0.6 },
  partnership: { weight: 8, dir: [55, 20, 25], strength: [50, 32, 16, 2], follow: 0.78, immediate: 0.35, shape: 'front', permShare: 0.6 },
  management: { weight: 8, dir: [45, 30, 25], strength: [50, 33, 15, 2], follow: 0.76, immediate: 0.4, shape: 'front', permShare: 0.55 },
  legal: { weight: 8, dir: [40, 35, 25], strength: [45, 35, 17, 3], follow: 0.75, immediate: 0.5, shape: 'front', permShare: 0.6 },
  operations: { weight: 12, dir: [45, 35, 20], strength: [55, 30, 13, 2], follow: 0.78, immediate: 0.3, shape: 'ramp', permShare: 0.55 },
  financial: { weight: 12, dir: [50, 30, 20], strength: [50, 33, 15, 2], follow: 0.78, immediate: 0.5, shape: 'front', permShare: 0.7 },
  analyst: { weight: 12, dir: [45, 35, 20], strength: [70, 25, 5, 0], follow: 0.7, immediate: 0.8, shape: 'front', permShare: 0.45 },
  contract: { weight: 10, dir: [50, 30, 20], strength: [45, 35, 18, 2], follow: 0.8, immediate: 0.35, shape: 'ramp', permShare: 0.7 },
  research: { weight: 8, dir: [45, 30, 25], strength: [45, 30, 20, 5], follow: 0.76, immediate: 0.35, shape: 'front', permShare: 0.65 },
  incident: { weight: 4, dir: [0, 70, 30], strength: [40, 35, 20, 5], follow: 0.82, immediate: 0.7, shape: 'front', permShare: 0.5 },
  demand: { weight: 10, dir: [45, 35, 20], strength: [60, 30, 9, 1], follow: 0.78, immediate: 0.3, shape: 'ramp', permShare: 0.6 },
};

const RESEARCH_SECTORS: ReadonlySet<SectorId> = new Set<SectorId>(['tech', 'ai', 'robotics', 'energy', 'health', 'aero', 'emerging', 'industrial']);

/** The phrase used in "the {sector} industry". */
const SECTOR_WORD: Readonly<Record<SectorId, string>> = {
  tech: 'technology',
  ai: 'AI',
  robotics: 'robotics',
  energy: 'energy',
  health: 'healthcare',
  finance: 'financial',
  transport: 'transportation',
  consumer: 'consumer goods',
  media: 'media and entertainment',
  industrial: 'industrial and materials',
  aero: 'aerospace and defense',
  utilities: 'utilities',
  emerging: 'emerging-technology',
  meme: 'meme',
};

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

function strengthOf(d: Draws, weights: readonly number[]): Strength {
  return STRENGTHS[d.weighted(weights)] as Strength;
}

function capStrength(s: Strength, max: Strength): Strength {
  return STRENGTHS.indexOf(s) > STRENGTHS.indexOf(max) ? max : s;
}

/** "$1.2 billion", "$85 million", "$640 thousand". */
export function money(dollars: number): string {
  const tidy = (x: number): string => x.toFixed(1).replace(/\.0$/, '');
  if (dollars >= 1e9) return `$${tidy(Math.round(dollars / 1e8) / 10)} billion`;
  if (dollars >= 1e8) return `$${Math.round(dollars / 1e6)} million`;
  if (dollars >= 1e6) return `$${tidy(Math.round(dollars / 1e5) / 10)} million`;
  return `$${Math.max(1, Math.round(dollars / 1e3))} thousand`;
}

function capDollars(c: Company): number {
  return (c.basePriceCents * c.sharesOutstanding) / 100;
}

interface Timing {
  readonly startTick: number;
  readonly durationTicks: number;
  readonly shape: Shape;
  readonly immediacy: Immediacy;
}

function timingOf(d: Draws, publishTick: number, strength: Strength, immediateProb: number, gradualShape: Shape): Timing {
  if (d.u() < immediateProb) return { startTick: publishTick + d.int(3), durationTicks: 6, shape: 'burst', immediacy: 'immediate' };
  const [lo, hi] = GRADUAL_SECONDS[strength];
  return { startTick: publishTick + d.range(20, 90), durationTicks: d.range(lo, hi), shape: gradualShape, immediacy: 'gradual' };
}

function templatesFor(set: TemplateSet, direction: Direction): readonly Template[] {
  const list = set[direction];
  if (!list || list.length === 0) throw new Error(`No ${direction} templates`);
  return list;
}

function companySlots(d: Draws, c: Company, partner: Company | null): Record<string, string> {
  const flip = d.u() < 0.5;
  return {
    co: c.name,
    tk: c.ticker,
    prod: (flip ? c.products[0] : c.products[1]) ?? c.name,
    prod2: (flip ? c.products[1] : c.products[0]) ?? c.name,
    ceo: c.ceo,
    cfo: c.cfo,
    hq: c.hq,
    peer: partner ? partner.name : 'a partner',
    sector: SECTOR_WORD[c.sector],
    n: String(d.range(3, 48)),
    pct: String(d.range(3, 25)),
    amt: money(capDollars(c) * (d.range(2, 30) / 1000)),
    region: d.pick(REGIONS),
    firm: d.pick(ANALYST_FIRMS),
    person: `${d.pick(PERSON_FIRST)} ${d.pick(PERSON_LAST)}`,
  };
}

function isBreaking(kind: EventKind, strength: Strength, scope: EventScope): boolean {
  if (kind === 'viral') return true;
  if (strength === 'extreme') return true;
  if ((kind === 'macro' || scope === 'market') && strength === 'major') return true;
  return false;
}

function realizedOf(d: Draws, direction: Direction, magnitude: number, follow: number): number {
  const base = magnitude * (0.6 + 0.9 * d.u());
  let sign: number;
  let mag = base;
  if (direction === 'uncertain') {
    sign = d.u() < 0.5 ? 1 : -1;
    mag = base * 0.6;
  } else {
    const followed = d.u() < follow;
    sign = (direction === 'positive') === followed ? 1 : -1;
  }
  return clamp(sign * mag, -MAX_REALIZED, MAX_REALIZED);
}

// ---- company items ---------------------------------------------------------------------------------------------------

/** Chooses `count` different categories for a company (weighted, without repeats). */
function chooseCategories(d: Draws, c: Company, partner: Company | null, count: number): CompanyCategory[] {
  const cats = Object.keys(RULES) as CompanyCategory[];
  const chosen: CompanyCategory[] = [];
  for (let n = 0; n < count; n += 1) {
    const weights = cats.map((cat) => {
      if (chosen.includes(cat)) return 0;
      if (cat === 'partnership' && partner === null) return 0;
      if (cat === 'research' && !RESEARCH_SECTORS.has(c.sector)) return 0;
      return RULES[cat].weight;
    });
    chosen.push(cats[d.weighted(weights)] as CompanyCategory);
  }
  return chosen;
}

function directionFor(d: Draws, c: Company, rule: readonly [number, number, number]): Direction {
  const tilt = clamp(c.anchorDir, -1, 1);
  const weights = [rule[0] * (1 + 0.4 * tilt), rule[1] * (1 - 0.4 * tilt), rule[2]];
  return DIRECTIONS[d.weighted(weights)] as Direction;
}

function companySeedBase(worldSeed: number): number {
  return deriveSeed(worldSeed, STREAM_COMPANY);
}

/** Does the company report in this cycle? (A fixed day of every fiscal quarter; never on the day it lists, and a coin never.) */
export function earningsDue(worldSeed: number, c: Company, cycle: number): boolean {
  return earningsOutcome(worldSeed, c, cycle) !== null;
}

/** The public side of one report, and — hidden until it is published — how the market will take it. */
export interface EarningsOutcome extends ReportOutcome {
  readonly cycle: number;
  readonly publishTick: number;
  readonly startTick: number;
  readonly durationTicks: number;
  readonly shape: Shape;
  readonly immediacy: Immediacy;
  /** HIDDEN: the move the price will make. */
  readonly realized: number;
}

/**
 * What the company's report of `cycle` is: when it comes out, whether it is good news, bad news or mixed, how strongly, and the hidden move. A pure
 * function of (world seed, company, cycle) drawn from its own stream, so the numbers of fundamentals.ts can be worked out for any past cycle without
 * generating the rest of that day's news. Null when the company does not report that day.
 */
export function earningsOutcome(worldSeed: number, c: Company, cycle: number): EarningsOutcome | null {
  if (cycle < 0) return null;
  const cycleStart = cycle * NEWS_CYCLE_TICKS;
  const cycleEnd = cycleStart + NEWS_CYCLE_TICKS;
  if (c.listingTick >= cycleEnd) return null;
  const listing = c.listingTick > 0 && c.listingTick >= cycleStart;
  if (listing || !reportsInCycle(worldSeed, c, cycle)) return null;
  const d = new Draws(deriveSeed(deriveSeed(deriveSeed(worldSeed, STREAM_EARNINGS_NEWS), c.id), cycle));
  const winStart = Math.max(cycleStart, c.listingTick);
  const width = cycleEnd - winStart;
  // The report is the second of the day's three core items: it sits in the middle third of the window.
  const lo = winStart + Math.floor(width / CORE_SLOTS);
  const hi = winStart + Math.floor((2 * width) / CORE_SLOTS);
  const margin = Math.floor((hi - lo) * 0.1);
  const publishTick = Math.min(lo + margin + d.int(Math.max(1, hi - lo - 2 * margin)), cycleEnd - 1);
  const direction = directionFor(d, c, EARNINGS_RULE.dir);
  let strength = strengthOf(d, EARNINGS_RULE.strength);
  if (direction === 'uncertain') strength = capStrength(strength, 'moderate');
  const timing = timingOf(d, publishTick, strength, EARNINGS_RULE.immediate, EARNINGS_RULE.shape);
  const realized = realizedOf(d, direction, EARNINGS_MAGNITUDE[strength] * c.newsSensitivity, EARNINGS_RULE.follow);
  return {
    cycle,
    direction,
    strength,
    publishTick,
    startTick: Math.max(timing.startTick, c.listingTick),
    durationTicks: timing.durationTicks,
    shape: timing.shape,
    immediacy: timing.immediacy,
    realized,
  };
}

/** The words and numbers of a report's story. */
function earningsSlots(fig: Figures): Record<string, string> {
  const revSmall = fig.revBp > -30 && fig.revBp < 30;
  return {
    q: quarterWord(fig.quarter),
    qn: `${quarterWord(fig.quarter).replace('-', ' ')}`,
    eps: epsText(fig.epsMills),
    epscons: epsText(fig.epsConsMills),
    epsdiff: centsText(fig.epsMills - fig.epsConsMills),
    epscmp: Math.abs(fig.epsBp) < 100 || fig.epsMills === fig.epsConsMills ? 'in line with' : fig.epsMills > fig.epsConsMills ? 'ahead of' : 'below',
    surp: bpText(fig.epsBp),
    rev: revenueText(fig.revDollars),
    revcons: revenueText(fig.revConsDollars),
    revcmp: revSmall ? 'in line with' : fig.revBp > 0 ? 'above' : 'below',
    yoy: yoyText(fig.yoyBp),
  };
}

/** All items for one company in one cycle (≥ 3 if the company trades during the cycle). Ordered by slot. */
export function companyCycleDrafts(worldSeed: number, c: Company, all: readonly Company[], cycle: number): NewsDraft[] {
  const cycleStart = cycle * NEWS_CYCLE_TICKS;
  const cycleEnd = cycleStart + NEWS_CYCLE_TICKS;
  if (c.listingTick >= cycleEnd) return [];
  const winStart = Math.max(cycleStart, c.listingTick);
  const width = cycleEnd - winStart;
  const d = new Draws(deriveSeed(deriveSeed(companySeedBase(worldSeed), c.id), cycle));
  const listing = c.listingTick > 0 && c.listingTick >= cycleStart;
  // A coin has no quarterly results; nor does a company on the day it lists.
  const earn = earningsOutcome(worldSeed, c, cycle);
  const earnings = earn !== null;

  const peer = c.peerId !== c.id ? (all[c.peerId] ?? null) : null;
  const partnerOk = (startTick: number): Company | null => (peer !== null && peer.listingTick <= startTick ? peer : null);

  // Extra items: one more with 30 %, a second with 7 %.
  const extras = (d.u() < 0.3 ? 1 : 0) + (d.u() < 0.07 ? 1 : 0);
  const ordinaryCount = CORE_SLOTS - (listing ? 1 : 0) - (earnings ? 1 : 0) + extras;
  const partnerNow = peer !== null && peer.listingTick <= winStart ? peer : null;
  const categories = chooseCategories(d, c, partnerNow, ordinaryCount);

  const out: NewsDraft[] = [];
  let catIndex = 0;
  for (let slot = 0; slot < CORE_SLOTS + extras; slot += 1) {
    // Core slots sit in the three thirds of the window; extras anywhere.
    let publishTick: number;
    if (slot < CORE_SLOTS) {
      const lo = winStart + Math.floor((slot * width) / CORE_SLOTS);
      const hi = winStart + Math.floor(((slot + 1) * width) / CORE_SLOTS);
      const w = hi - lo;
      const margin = Math.floor(w * 0.1);
      publishTick = lo + margin + d.int(Math.max(1, w - 2 * margin));
    } else {
      publishTick = winStart + d.int(Math.max(1, width - 600));
    }
    publishTick = Math.min(publishTick, cycleEnd - 1);

    let category: Category;
    let templates: TemplateSet;
    if (slot === 0 && listing) {
      category = 'listing';
      templates = c.sector === 'meme' ? MEME_LISTING_TEMPLATES : LISTING_TEMPLATES;
      publishTick = c.listingTick;
    } else if (slot === 1 && earnings) {
      category = 'earnings';
      templates = EARNINGS_TEMPLATES;
    } else {
      category = categories[catIndex] as CompanyCategory;
      catIndex += 1;
      templates = (c.sector === 'meme' ? MEME_COMPANY_TEMPLATES : COMPANY_TEMPLATES)[category as CompanyCategory];
    }

    const rule = category === 'listing' ? null : category === 'earnings' ? EARNINGS_RULE : RULES[category as CompanyCategory];
    // A report is drawn from its own stream (earningsOutcome), so that the numbers of fundamentals.ts can be worked out without the rest of the day.
    const report = category === 'earnings' ? earn : null;
    if (report) publishTick = report.publishTick;
    const direction: Direction = report ? report.direction : rule === null ? 'uncertain' : directionFor(d, c, rule.dir);
    let strength: Strength = report ? report.strength : rule === null ? 'minor' : strengthOf(d, rule.strength);
    if (!report && direction === 'uncertain') strength = capStrength(strength, 'moderate');
    const timing: Timing = report
      ? { startTick: report.startTick, durationTicks: report.durationTicks, shape: report.shape, immediacy: report.immediacy }
      : rule === null
        ? ({ startTick: publishTick + 1, durationTicks: 60, shape: 'front', immediacy: 'gradual' } as Timing)
        : timingOf(d, publishTick, strength, rule.immediate, rule.shape);
    const realized = report ? report.realized : rule === null ? realizedOf(d, 'uncertain', MAGNITUDE.minor * c.newsSensitivity, 0.5) : realizedOf(d, direction, MAGNITUDE[strength] * c.newsSensitivity, rule.follow);
    const startTick = Math.max(timing.startTick, c.listingTick);

    const partner = category === 'partnership' ? partnerOk(startTick) : null;
    const list = templatesFor(templates, direction);
    const pick = d.int(list.length);
    const figures = report ? figuresFor(worldSeed, c, cycle, report) : null;
    // A report that is neither good nor bad is "in line" or "mixed"; the story has to say which of the two the numbers are.
    const template = (figures && direction === 'uncertain' ? list[UNCERTAIN_KIND.indexOf(figures.kind) % list.length] : list[(pick + cycle) % list.length]) as Template;
    const slots = { ...companySlots(d, c, partner), ...(figures ? earningsSlots(figures) : {}) };
    const kind: EventKind = category === 'earnings' ? 'earnings' : 'ordinary';
    const scope: EventScope = partner ? 'company+partner' : 'company';
    out.push({
      key: `c${c.id}:${cycle}:${slot}`,
      kind,
      category,
      scope,
      companyId: c.id,
      partnerId: partner ? partner.id : null,
      sector: null,
      cycle,
      slot,
      publishTick,
      startTick,
      durationTicks: timing.durationTicks,
      shape: timing.shape,
      immediacy: timing.immediacy,
      direction,
      strength,
      realized,
      permShare: rule === null ? 0.5 : rule.permShare,
      headline: fill(template[0], slots),
      body: fill(template[1], slots),
      breaking: isBreaking(kind, strength, scope),
      credibility: null,
    });
  }
  return out;
}

const EARNINGS_RULE: CategoryRule = { weight: 0, dir: [40, 30, 30], strength: [15, 50, 30, 5], follow: 0.75, immediate: 0.5, shape: 'ramp', permShare: 0.8 };
/** Which of the three "neither good nor bad" stories fits the numbers: in line, EPS beat but revenue short, revenue beat but EPS short. */
const UNCERTAIN_KIND: readonly string[] = ['inline', 'epsBeatRevMiss', 'epsMissRevBeat'];

// ---- sector, economy and viral items -------------------------------------------------------------------------------------

function marketSeedBase(worldSeed: number): number {
  return deriveSeed(worldSeed, STREAM_MARKET);
}

/** Sector news, economy news and rare viral events for one cycle. Items have no company of their own (viral ones do). */
export function marketCycleDrafts(worldSeed: number, all: readonly Company[], cycle: number): NewsDraft[] {
  const cycleStart = cycle * NEWS_CYCLE_TICKS;
  const d = new Draws(deriveSeed(marketSeedBase(worldSeed), cycle));
  const out: NewsDraft[] = [];
  const tradingAt = (tick: number): Company[] => all.filter((c) => c.listingTick <= tick);

  // Sector news: about 0.7 items per sector per day.
  SECTORS.forEach((s, si) => {
    const members = tradingAt(cycleStart).filter((c) => c.sector === s.id);
    // The memecoin sector draws only once it has coins, so a market without coins keeps exactly the news it always had.
    if (s.id === 'meme' && members.length === 0) return;
    const count = (d.u() < 0.55 ? 1 : 0) + (d.u() < 0.12 ? 1 : 0);
    if (members.length === 0) return;
    for (let j = 0; j < count; j += 1) {
      const publishTick = cycleStart + d.int(NEWS_CYCLE_TICKS - 600);
      const direction = DIRECTIONS[d.weighted([40, 36, 24])] as Direction;
      const strength = capStrength(strengthOf(d, [55, 35, 9, 1]), direction === 'uncertain' ? 'moderate' : 'extreme');
      const timing = timingOf(d, publishTick, strength, 0.4, 'front');
      const set = SECTOR_TEMPLATES[s.id];
      const list = templatesFor(set, direction);
      const template = list[d.int(list.length)] as Template;
      // Coins swing far more than stocks, so a memecoin-sector story is four times as strong.
      const realized = realizedOf(d, direction, SECTOR_MAGNITUDE[strength] * (s.id === 'meme' ? 4 : 1) * (0.7 + 0.6 * d.u()), 0.75);
      out.push({
        key: `s${si}:${cycle}:${j}`,
        kind: 'ordinary',
        category: 'sector',
        scope: 'sector',
        companyId: null,
        partnerId: null,
        sector: s.id,
        cycle,
        slot: 10 + si * 2 + j,
        publishTick,
        startTick: timing.startTick,
        durationTicks: timing.durationTicks,
        shape: timing.shape,
        immediacy: timing.immediacy,
        direction,
        strength,
        realized,
        permShare: 0.6,
        headline: fill(template[0], {}),
        body: fill(template[1], {}),
        breaking: isBreaking('ordinary', strength, 'sector'),
        credibility: null,
      });
    }
  });

  // Economy news: about 0.65 items per day, each moving the whole market a little.
  const macroCount = (d.u() < 0.55 ? 1 : 0) + (d.u() < 0.1 ? 1 : 0);
  for (let j = 0; j < macroCount; j += 1) {
    const publishTick = cycleStart + d.int(NEWS_CYCLE_TICKS - 600);
    const direction = DIRECTIONS[d.weighted([38, 38, 24])] as Direction;
    const strength = capStrength(strengthOf(d, [45, 38, 15, 2]), direction === 'uncertain' ? 'moderate' : 'extreme');
    const timing = timingOf(d, publishTick, strength, 0.55, 'front');
    const list = templatesFor(MACRO_TEMPLATES, direction);
    const template = list[d.int(list.length)] as Template;
    out.push({
      key: `m:${cycle}:${j}`,
      kind: 'macro',
      category: 'macro',
      scope: 'market',
      companyId: null,
      partnerId: null,
      sector: null,
      cycle,
      slot: 50 + j,
      publishTick,
      startTick: timing.startTick,
      durationTicks: timing.durationTicks,
      shape: timing.shape,
      immediacy: timing.immediacy,
      direction,
      strength,
      realized: realizedOf(d, direction, MACRO_MAGNITUDE[strength] * (0.7 + 0.6 * d.u()), 0.75),
      permShare: 0.7,
      headline: fill(template[0], {}),
      body: fill(template[1], {}),
      breaking: isBreaking('macro', strength, 'market'),
      credibility: null,
    });
  }

  // Viral and important-person events: rare. On average one every two to three days across the whole market.
  const viralCount = d.u() < 0.62 ? 0 : d.u() < 0.8 ? 1 : 2;
  for (let j = 0; j < viralCount; j += 1) out.push(...viralDrafts(d, all, cycle, j, cycleStart));
  return out;
}

const SUSCEPTIBLE_AFTER = 7200; // a company must have traded for two hours before it can go viral

function viralDrafts(d: Draws, all: readonly Company[], cycle: number, j: number, cycleStart: number): NewsDraft[] {
  const publishTick = cycleStart + d.int(NEWS_CYCLE_TICKS - 7200);
  const eligible = all.filter((c) => c.listingTick + SUSCEPTIBLE_AFTER <= publishTick);
  if (eligible.length === 0) return [];
  const kind = d.pick(VIRAL_KINDS);
  const c = d.pick(eligible);
  const credibility = Math.round((0.2 + 0.8 * d.u()) * 100) / 100;
  const direction = DIRECTIONS[d.weighted([45, 33, 22])] as Direction;
  const baseStrength = strengthOf(d, [20, 40, 30, 10]);
  const strength = direction === 'uncertain' ? capStrength(baseStrength, 'moderate') : baseStrength;
  const official = kind === 'official';
  const set = (c.sector === 'meme' ? MEME_VIRAL_TEMPLATES : VIRAL_TEMPLATES)[kind];
  const list = templatesFor(set, direction);
  const template = list[d.int(list.length)] as Template;
  const others = all.filter((o) => o.id !== c.id && o.listingTick <= publishTick);
  const peer = others.length > 0 ? d.pick(others) : null;
  const slots = { ...companySlots(d, c, peer), sector: SECTOR_WORD[c.sector] };
  const timing = timingOf(d, publishTick, strength, 0.45, 'front');

  const liqMult = 1 + 0.6 * (1 - c.liquidity);
  const volMult = clamp(0.8 + 8 * c.vol3m, 0.8, 1.4);
  const follow = 0.5 + 0.4 * credibility;
  const move = VIRAL_MAGNITUDE[strength] * (official ? 0.6 : c.newsSensitivity * liqMult * volMult) * (0.5 + credibility) * (0.8 + 0.4 * d.u());
  const realized = realizedOf(d, direction, move, follow);

  const first: NewsDraft = {
    key: `v:${cycle}:${j}`,
    kind: 'viral',
    category: 'viral',
    scope: official ? 'sector' : 'company',
    companyId: official ? null : c.id,
    partnerId: null,
    sector: official ? c.sector : null,
    cycle,
    slot: 100 + j,
    publishTick,
    startTick: timing.startTick,
    durationTicks: timing.durationTicks,
    shape: timing.shape,
    immediacy: timing.immediacy,
    direction,
    strength,
    realized,
    permShare: 0.25,
    headline: fill(template[0], slots),
    body: fill(template[1], slots),
    breaking: true,
    credibility,
  };
  const out: NewsDraft[] = [first];

  // A low-credibility story often fades: a follow-up item pulls the price back.
  if (credibility < 0.5 && direction !== 'uncertain' && strength !== 'minor' && !official) {
    const fadeDirection: Direction = direction === 'positive' ? 'negative' : 'positive';
    const fadeList = templatesFor(c.sector === 'meme' ? MEME_FADE_TEMPLATES : VIRAL_FADE_TEMPLATES, fadeDirection);
    const fadeTemplate = fadeList[d.int(fadeList.length)] as Template;
    const fadePublish = Math.min(cycleStart + NEWS_CYCLE_TICKS - 1, publishTick + d.range(1200, 3600));
    const fadeRealized = clamp(-realized * (0.5 + 0.4 * d.u()), -MAX_REALIZED, MAX_REALIZED);
    out.push({
      key: `v:${cycle}:${j}f`,
      kind: 'viral',
      category: 'viral',
      scope: 'company',
      companyId: c.id,
      partnerId: null,
      sector: null,
      cycle,
      slot: 200 + j,
      publishTick: fadePublish,
      startTick: fadePublish + d.range(10, 40),
      durationTicks: d.range(600, 1200),
      shape: 'front',
      immediacy: 'gradual',
      direction: fadeDirection,
      strength: 'moderate',
      realized: fadeRealized,
      permShare: 0.1,
      headline: fill(fadeTemplate[0], slots),
      body: fill(fadeTemplate[1], slots),
      breaking: false,
      credibility,
    });
  }
  return out;
}

/** A draft as the price engine sees it. */
export function eventOf(d: NewsDraft): WorldEvent {
  return {
    key: d.key,
    kind: d.kind,
    scope: d.scope,
    companyId: d.companyId,
    partnerId: d.partnerId,
    sector: d.sector,
    publishTick: d.publishTick,
    startTick: d.startTick,
    durationTicks: d.durationTicks,
    shape: d.shape,
    realized: d.realized,
    permShare: d.permShare,
  };
}

/** Builds the draft for a special event created by the owner (admin panel). Always labelled as such. */
export function adminDraft(options: {
  key: string;
  company: Company;
  direction: Direction;
  strength: Strength;
  publishTick: number;
  realized: number;
  durationTicks: number;
  cycle: number;
  slot: number;
}): NewsDraft {
  const { company: c, direction } = options;
  const template = templatesFor(ADMIN_TEMPLATES, direction)[0] as Template;
  const slots = { co: c.name };
  return {
    key: options.key,
    kind: 'admin',
    category: 'admin',
    scope: 'company',
    companyId: c.id,
    partnerId: null,
    sector: null,
    cycle: options.cycle,
    slot: options.slot,
    publishTick: options.publishTick,
    startTick: options.publishTick + 1,
    durationTicks: options.durationTicks,
    shape: 'front',
    immediacy: 'gradual',
    direction,
    strength: options.strength,
    realized: clamp(options.realized, -MAX_REALIZED, MAX_REALIZED),
    permShare: 0.3,
    headline: fill(template[0], slots),
    body: fill(template[1], slots),
    breaking: true,
    credibility: null,
  };
}

