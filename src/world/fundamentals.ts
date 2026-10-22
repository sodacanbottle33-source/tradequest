// What a company earns, quarter by quarter (docs/world.md §7.5). A pure function of (world seed, company, quarter): the same on every machine and
// after every restart, and it needs no price and no stored state.
//
//  • A fiscal quarter is EARNINGS_PERIOD_CYCLES days of the market (3), not 91, so that a player sees reports often. A company reports on the
//    same day of that period for ever; its day is fixed per company.
//  • What analysts expect (the CONSENSUS) is known in advance: it only depends on the company and the quarter. It follows a slow, bounded wave
//    around a level that makes the company's price/earnings ratio fit its sector and character (a software firm is dear, a bank is cheap).
//  • What the company really earns (the ACTUAL) is the consensus plus a SURPRISE. The surprise is tied to the earnings news item: a positive item
//    beats, a negative one misses, an uncertain one is in line or mixed, and the strength of the item says how big. So the numbers in the headline
//    always agree with the headline, and the price follows the news item exactly as it follows every other item (newsgen.ts).
//  • Nothing here grows without bound: the wave is a triangle between −amplitude and +amplitude, so earnings (and the P/E ratio) stay in a sane range.
//
// This file, like the rest of src/world, may only use + − × ÷ and comparisons (plus floor / round / abs / min / max).

import { deriveSeed, hashUniformAt } from '../engine/rng';
import type { Personality, SectorId } from './params';
import type { Company, Direction, Strength } from './types';

/** A fiscal quarter, in news cycles (days). */
export const EARNINGS_PERIOD_CYCLES = 3;
export const QUARTERS_PER_YEAR = 4;
/** Earnings per share are counted in mills: thousandths of a dollar (a tenth of a cent), so that a cheap stock's quarter is not a rounding error. */
export const MILLS_PER_DOLLAR = 1000;

const STREAM_EARNINGS = 0xfe02;

interface SectorFinance {
  /** The price/earnings ratio a typical company of the sector trades at. */
  readonly pe: number;
  /** Net profit as a share of revenue. */
  readonly margin: number;
}

const SECTOR_FINANCE: Readonly<Record<SectorId, SectorFinance>> = {
  tech: { pe: 30, margin: 0.2 },
  ai: { pe: 40, margin: 0.18 },
  robotics: { pe: 28, margin: 0.12 },
  energy: { pe: 12, margin: 0.09 },
  health: { pe: 24, margin: 0.14 },
  finance: { pe: 11, margin: 0.22 },
  transport: { pe: 15, margin: 0.07 },
  consumer: { pe: 20, margin: 0.09 },
  media: { pe: 22, margin: 0.12 },
  industrial: { pe: 15, margin: 0.09 },
  aero: { pe: 20, margin: 0.08 },
  utilities: { pe: 17, margin: 0.1 },
  emerging: { pe: 35, margin: 0.1 },
  // Coins have no earnings; this only keeps the table complete.
  meme: { pe: 20, margin: 0.1 },
};

interface PersonalityFinance {
  /** Growth stocks are priced dearly, declining ones cheaply. */
  readonly peMult: number;
  /** How far earnings swing around their level (a fraction). */
  readonly wave: number;
  readonly marginMult: number;
}

const PERSONALITY_FINANCE: Readonly<Record<Personality, PersonalityFinance>> = {
  steady: { peMult: 1, wave: 0.05, marginMult: 1 },
  income: { peMult: 0.9, wave: 0.04, marginMult: 1.05 },
  growth: { peMult: 1.3, wave: 0.1, marginMult: 1 },
  cyclical: { peMult: 0.85, wave: 0.3, marginMult: 0.95 },
  volatile: { peMult: 1.1, wave: 0.22, marginMult: 0.9 },
  turnaround: { peMult: 0.75, wave: 0.3, marginMult: 0.7 },
  declining: { peMult: 0.55, wave: 0.12, marginMult: 0.85 },
};

/** The size of the surprise, in basis points of the consensus, by the strength of the news item. */
const SURPRISE_BP: Readonly<Record<Strength, readonly [number, number]>> = {
  minor: [100, 300],
  moderate: [300, 700],
  major: [700, 1500],
  extreme: [1500, 3000],
};

function seedOf(worldSeed: number, c: Company): number {
  return deriveSeed(deriveSeed(worldSeed, STREAM_EARNINGS), c.id);
}

/** Draw `j` (0 … 15) of the company's own numbers, or of one cycle's. */
function profileDraw(worldSeed: number, c: Company, j: number): number {
  return hashUniformAt(seedOf(worldSeed, c), j);
}
function cycleDraw(worldSeed: number, c: Company, cycle: number, j: number): number {
  return hashUniformAt(seedOf(worldSeed, c), 16 + cycle * 16 + j);
}

export interface Profile {
  /** The ratio of price to a year's earnings at which the company is priced when its earnings sit at their level. */
  readonly pe: number;
  /** Net profit as a share of revenue. */
  readonly margin: number;
  /** Swing of the earnings around their level (a fraction). */
  readonly waveAmp: number;
  /** Length of the swing in quarters, and where in it the world starts. */
  readonly waveLen: number;
  readonly wavePhase: number;
  /** Which day of the 3-day period the company reports on. */
  readonly offset: number;
}

export function profileOf(worldSeed: number, c: Company): Profile {
  const sec = SECTOR_FINANCE[c.sector];
  const per = PERSONALITY_FINANCE[c.personality];
  const pe = Math.round(sec.pe * per.peMult * (0.8 + 0.4 * profileDraw(worldSeed, c, 0)) * 10) / 10;
  const margin = Math.round(sec.margin * per.marginMult * (0.75 + 0.5 * profileDraw(worldSeed, c, 1)) * 1000) / 1000;
  const waveLen = 12 + Math.floor(profileDraw(worldSeed, c, 2) * 13);
  return {
    pe,
    margin,
    waveAmp: per.wave,
    waveLen,
    wavePhase: Math.floor(profileDraw(worldSeed, c, 3) * waveLen),
    offset: Math.floor(profileDraw(worldSeed, c, 7) * EARNINGS_PERIOD_CYCLES),
  };
}

/** Does a company with a stock report in this cycle (before the listing rule: a company never reports on the day it lists)? */
export function reportsInCycle(worldSeed: number, c: Company, cycle: number): boolean {
  if (c.sector === 'meme' || cycle < 0) return false;
  return (cycle + profileOf(worldSeed, c).offset) % EARNINGS_PERIOD_CYCLES === 0;
}

/** The fiscal quarter the report of this cycle covers, counted from the start of the world (the first possible report is quarter 0 or 1). */
export function quarterOfCycle(worldSeed: number, c: Company, cycle: number): number {
  return Math.floor((cycle + profileOf(worldSeed, c).offset) / EARNINGS_PERIOD_CYCLES);
}

const QUARTER_WORD = ['first', 'second', 'third', 'fourth'] as const;
/** "third-quarter" */
export function quarterWord(quarter: number): string {
  return `${QUARTER_WORD[((quarter % QUARTERS_PER_YEAR) + QUARTERS_PER_YEAR) % QUARTERS_PER_YEAR]}-quarter`;
}
/** "Q3" */
export function quarterLabel(quarter: number): string {
  return `Q${(((quarter % QUARTERS_PER_YEAR) + QUARTERS_PER_YEAR) % QUARTERS_PER_YEAR) + 1}`;
}

/** A triangle between −1 and +1 with period `len`: +1 at the start, −1 half-way. */
function triangle(position: number, len: number): number {
  const t = (((position % len) + len) % len) / len;
  const away = t < 0.5 ? 0.5 - t : t - 0.5;
  return 4 * away - 1;
}

/** What analysts expect for the quarter of the report in `cycle`, before it is out. */
export interface Consensus {
  readonly cycle: number;
  readonly quarter: number;
  /** Earnings per share, in mills. */
  readonly epsMills: number;
  /** Revenue of the quarter, in dollars. */
  readonly revenue: number;
}

export function consensusOf(worldSeed: number, c: Company, cycle: number): Consensus {
  const p = profileOf(worldSeed, c);
  const quarter = quarterOfCycle(worldSeed, c, cycle);
  // A year's earnings at the level that makes the price/earnings ratio `pe` at the catalog price, a quarter of it, and the swing.
  const level = 1 + p.waveAmp * triangle(quarter + p.wavePhase, p.waveLen);
  const epsMills = Math.max(5, Math.round(((c.basePriceCents * 10) / p.pe / QUARTERS_PER_YEAR) * level));
  const profit = (epsMills / MILLS_PER_DOLLAR) * c.sharesOutstanding;
  return { cycle, quarter, epsMills, revenue: Math.round(profit / p.margin) };
}

export type SurpriseKind = 'beat' | 'miss' | 'inline' | 'epsBeatRevMiss' | 'epsMissRevBeat';

export interface Surprise {
  readonly kind: SurpriseKind;
  /** Earnings per share against the consensus, basis points (positive = better). */
  readonly epsBp: number;
  readonly revBp: number;
}

/** How the quarter turned out compared with what was expected, given what the news item said. */
export function surpriseOf(worldSeed: number, c: Company, cycle: number, direction: Direction, strength: Strength): Surprise {
  const u = (j: number): number => cycleDraw(worldSeed, c, cycle, j);
  if (direction === 'uncertain') {
    if (u(1) < 0.4) return { kind: 'inline', epsBp: Math.floor(u(2) * 101) - 50, revBp: Math.floor(u(3) * 61) - 30 };
    const m = 100 + Math.floor(u(3) * 200);
    const r = 60 + Math.floor(u(4) * 140);
    return u(2) < 0.5 ? { kind: 'epsBeatRevMiss', epsBp: m, revBp: -r } : { kind: 'epsMissRevBeat', epsBp: -m, revBp: r };
  }
  const [lo, hi] = SURPRISE_BP[strength];
  const mag = lo + Math.floor(u(0) * (hi - lo));
  const sign = direction === 'positive' ? 1 : -1;
  let rev = Math.floor(mag * 0.35) + Math.floor(u(5) * 101) - 30; // always above 0 (mag ≥ 100)
  if (u(6) < 0.12) rev = -Math.floor(rev / 2); // now and then revenue goes the other way
  return { kind: direction === 'positive' ? 'beat' : 'miss', epsBp: sign * mag, revBp: sign * rev };
}

/** The quarter's numbers once they are out. */
export interface Figures {
  readonly cycle: number;
  readonly quarter: number;
  readonly kind: SurpriseKind | 'baseline';
  readonly epsConsMills: number;
  readonly epsMills: number;
  readonly epsBp: number;
  readonly revConsDollars: number;
  readonly revDollars: number;
  readonly revBp: number;
  /** Earnings per share a year earlier (the consensus level of that quarter), and the change since then in basis points (0 if there was none). */
  readonly epsYearAgoMills: number;
  readonly yoyBp: number;
}

/** What the news item of a report said: only its public side (direction and strength), which is all the numbers depend on. */
export interface ReportOutcome {
  readonly direction: Direction;
  readonly strength: Strength;
}

function actualEps(cons: number, s: Surprise | null): number {
  if (s === null) return cons;
  let eps = cons + Math.round((cons * s.epsBp) / 10_000);
  // A "beat" or a "miss" is at least a mill, whatever the size of the stock.
  if (s.kind === 'beat' && eps <= cons) eps = cons + 1;
  if (s.kind === 'miss' && eps >= cons) eps = cons - 1;
  return Math.max(0, eps);
}

/** The numbers of the report of `cycle`; with no outcome they are the consensus itself (a quarter nobody saw). */
export function figuresFor(worldSeed: number, c: Company, cycle: number, outcome: ReportOutcome | null): Figures {
  const cons = consensusOf(worldSeed, c, cycle);
  const s = outcome === null ? null : surpriseOf(worldSeed, c, cycle, outcome.direction, outcome.strength);
  const eps = actualEps(cons.epsMills, s);
  const revenue = s === null ? cons.revenue : Math.round(cons.revenue + (cons.revenue * s.revBp) / 10_000);
  // A year earlier: the consensus level of the same quarter (not its surprise, so that this number never depends on an item that may be missing).
  const ago = consensusOf(worldSeed, c, cycle - QUARTERS_PER_YEAR * EARNINGS_PERIOD_CYCLES).epsMills;
  return {
    cycle,
    quarter: cons.quarter,
    kind: s === null ? 'baseline' : s.kind,
    epsConsMills: cons.epsMills,
    epsMills: eps,
    epsBp: s === null ? 0 : s.epsBp,
    revConsDollars: cons.revenue,
    revDollars: revenue,
    revBp: s === null ? 0 : s.revBp,
    epsYearAgoMills: ago,
    yoyBp: ago > 0 ? Math.round(((eps - ago) * 10_000) / ago) : 0,
  };
}

/**
 * A year of earnings per share (mills) up to and including the report of `lastCycle`: the sum of that quarter and the three before it. A quarter
 * whose report is not known (`outcomeOf` says nothing) counts at its consensus.
 */
export function trailingEps(worldSeed: number, c: Company, lastCycle: number, outcomeOf: (cycle: number) => ReportOutcome | null): number {
  let sum = 0;
  for (let k = 0; k < QUARTERS_PER_YEAR; k += 1) {
    const cycle = lastCycle - k * EARNINGS_PERIOD_CYCLES;
    sum += figuresFor(worldSeed, c, cycle, outcomeOf(cycle)).epsMills;
  }
  return sum;
}

/** The report cycle at or before `cycle` (the last one that fell due), whether or not its news has been published. */
export function reportCycleAtOrBefore(worldSeed: number, c: Company, cycle: number): number {
  const off = profileOf(worldSeed, c).offset;
  const into = (((cycle + off) % EARNINGS_PERIOD_CYCLES) + EARNINGS_PERIOD_CYCLES) % EARNINGS_PERIOD_CYCLES;
  return cycle - into;
}

// ---- how the numbers read in the news --------------------------------------------------------------------------------

/** "$0.31", and "$0.031" for a small number so that it does not read as zero. */
export function epsText(mills: number): string {
  const neg = mills < 0;
  const abs = Math.abs(mills);
  const dollars = abs / MILLS_PER_DOLLAR;
  const text = abs < 100 ? dollars.toFixed(3) : dollars.toFixed(2);
  return `${neg ? '−' : ''}$${text}`;
}

/** "4 cents", "0.3 cents", "1 cent": how far apart two per-share figures are. */
export function centsText(mills: number): string {
  const cents = Math.abs(mills) / 10;
  if (cents === 1) return '1 cent';
  return `${Number.isInteger(cents) ? String(cents) : cents.toFixed(1)} cents`;
}

/** "8.4%" for 840 basis points. */
export function bpText(bp: number): string {
  const x = Math.abs(bp) / 100;
  return `${x.toFixed(x < 10 ? 1 : 0).replace(/\.0$/, '')}%`;
}

/** "up 12%", "down 5%" or "flat" for a year-on-year change. */
export function yoyText(bp: number): string {
  if (Math.abs(bp) < 50) return 'flat';
  return `${bp > 0 ? 'up' : 'down'} ${bpText(bp)}`;
}

/** Three significant figures: 1.23, 12.3, 123. */
function sig3(x: number): string {
  return x < 10 ? x.toFixed(2) : x < 100 ? x.toFixed(1) : x.toFixed(0);
}

/** "$1.23 billion", "$345 million", "$640 thousand": a company's revenue, with enough figures to tell a beat from a miss. */
export function revenueText(dollars: number): string {
  if (dollars >= 1e9) return `$${sig3(dollars / 1e9)} billion`;
  if (dollars >= 1e6) return `$${sig3(dollars / 1e6)} million`;
  return `$${sig3(Math.max(1, dollars) / 1e3)} thousand`;
}
