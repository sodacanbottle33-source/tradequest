// The practice-chart generator (docs/world.md §19.2): a pattern id and a 32-bit seed give back one complete lesson, always the same one.
// The chart, the right answer and what happens next are made here, by plain code, so the answer is always correct and the lesson costs nothing.
// (The AI teacher only talks about the player's answer afterwards.) Only +, -, *, / and the basic Math functions are used.

import { Mulberry32, normalZ } from '../engine/rng';
import { clamp, roundTo } from './candles';
import { PRACTICE_COINS, PRACTICE_STOCKS } from './names';
import { PATTERNS, type PatternDef } from './patterns';
import type { ChartLine, ChartMark, Grade, LCandle, LessonKind, PatternId, PracticeAsset } from './types';

/** How many candles the player sees, and how many happen after his answer. */
export const VISIBLE_CANDLES = 40;
export const OUTCOME_CANDLES = 8;

export interface SizeOption {
  readonly id: 'o0' | 'o1' | 'o2';
  /** Percent of the cash that goes into the trade. */
  readonly fractionPct: number;
  readonly leverage: number;
  readonly grade: Grade;
}

interface ScenarioBase {
  readonly seed: number;
  readonly asset: PracticeAsset;
  readonly visible: readonly LCandle[];
  readonly outcome: readonly LCandle[];
  readonly lines: readonly ChartLine[];
  readonly marks: readonly ChartMark[];
  /** What the player reads above the chart, and the question under it. */
  readonly story: string;
  readonly question: string;
}

export interface DirectionScenario extends ScenarioBase {
  readonly kind: 'direction';
  readonly pattern: PatternId;
  /** True when the price did what the pattern says (it does about 7 times in 10). */
  readonly follow: boolean;
  /** From the last candle the player saw to the last candle of the outcome, in percent (one decimal). */
  readonly outcomePct: number;
}

export interface SizeScenario extends ScenarioBase {
  readonly kind: 'size';
  /** 1 = the player decided to buy, -1 = to short. */
  readonly dir: 1 | -1;
  readonly options: readonly SizeOption[];
  /** Where the trade starts: the last price of the visible chart. */
  readonly entry: number;
  /** The biggest move against the trade (fraction, 0.09 = 9 %) and the move in its favour at the end (fraction). */
  readonly adverse: number;
  readonly favourable: number;
  readonly outcomePct: number;
}

export type Scenario = DirectionScenario | SizeScenario;

export function kindOf(s: Scenario): LessonKind {
  return s.kind;
}

// ---- shapes ----------------------------------------------------------------------------------------------------------------------

interface Shape {
  /** [candle number, level] waypoints; level 100 is the first price. */
  readonly points: readonly (readonly [number, number])[];
  readonly lines: readonly { level: number; label: string; tone: ChartLine['tone'] }[];
  readonly marks: readonly { t: number; label: string; side: 'above' | 'below' }[];
  /** Noise in level units (about percent). */
  readonly noise: number;
  /** Where the noise gets louder, and how loud (a spike). */
  readonly loudFrom?: number;
  readonly loudNoise?: number;
  /** From this candle on the wicks on top are long. */
  readonly spikeFrom?: number;
  /** Makes the last candles say what the pattern says (the noise must not hide it). */
  readonly fix?: (levels: number[]) => void;
  /** A path instead of waypoints (the chart with no pattern). */
  readonly direct?: readonly number[];
}

type Jitter = (amount: number) => number;

function shapeOf(id: PatternId, rng: Mulberry32, s: 1 | -1): Shape {
  const J: Jitter = (a) => (rng.next() * 2 - 1) * a;
  const L = (d: number): number => 100 + s * d;
  const side = (above: boolean): 'above' | 'below' => (above ? 'above' : 'below');
  switch (id) {
    case 'pullback-up':
    case 'bounce-down': {
      const d1 = 8 + J(2);
      const d2 = 4.5 + J(1.5);
      const d3 = 21 + J(2);
      const d4 = d3 - (6 + J(1.5));
      const d5 = d4 + 3;
      return {
        points: [[0, 100], [11, L(d1)], [16, L(d2)], [28, L(d3)], [35, L(d4)], [39, L(d5)]],
        lines: [s > 0 ? { level: L(d4), label: 'last low', tone: 'up' } : { level: L(d4), label: 'last high', tone: 'down' }],
        marks: [{ t: 35, label: s > 0 ? 'the dip' : 'the bounce', side: side(s < 0) }],
        noise: 0.42,
        fix: (lv) => {
          if (s * ((lv[39] as number) - (lv[38] as number)) < 0.6) lv[39] = (lv[38] as number) + s * 0.6;
        },
      };
    }
    case 'double-top':
    case 'double-bottom': {
      const p1 = 20 + J(2);
      const n = 9 + J(1.5);
      const p2 = p1 + J(1.2);
      const mid = (p2 + n) / 2;
      const peak = Math.max(p1, p2);
      return {
        points: [[0, 100], [13, L(p1)], [20, L(n)], [31, L(p2)], [36, L(mid)], [39, L(n - 1.5)]],
        lines: [
          { level: L(n), label: 'neckline', tone: 'accent' },
          s > 0 ? { level: L(peak), label: 'two peaks', tone: 'down' } : { level: L(peak), label: 'two lows', tone: 'up' },
        ],
        marks: [
          { t: 13, label: s > 0 ? 'peak 1' : 'low 1', side: side(s > 0) },
          { t: 31, label: s > 0 ? 'peak 2' : 'low 2', side: side(s > 0) },
        ],
        noise: 0.4,
        fix: (lv) => {
          if (s * ((lv[39] as number) - L(n)) > -0.5) lv[39] = L(n) - s * 0.5;
        },
      };
    }
    case 'range-top':
    case 'range-bottom': {
      const c = 12 + J(1.5);
      const f = J(1);
      const ceilingLabel = s > 0 ? 'ceiling' : 'floor';
      const floorLabel = s > 0 ? 'floor' : 'ceiling';
      return {
        points: [[0, L((c + f) / 2)], [5, L(f)], [11, L(c)], [17, L(f + 0.5)], [23, L(c - 0.5)], [29, L(f + 1)], [35, L(c - 0.3)], [39, L(c - 0.3)]],
        lines: [
          { level: L(c), label: ceilingLabel, tone: s > 0 ? 'down' : 'up' },
          { level: L(f), label: floorLabel, tone: s > 0 ? 'up' : 'down' },
        ],
        marks: [11, 23, 35].map((t) => ({ t, label: 'touch', side: side(s > 0) })),
        noise: 0.38,
      };
    }
    case 'breakout':
    case 'breakdown': {
      const h = 12 + J(1.5);
      const touches = [7, 17, 27];
      return {
        points: [[0, 100], [7, L(h)], [11, L(h - 6)], [17, L(h)], [21, L(h - 5)], [27, L(h)], [31, L(h - 4)], [35, L(h - 1)], [37, L(h + 1.5)], [39, L(h + 3.5)]],
        lines: [s > 0 ? { level: L(h), label: 'ceiling', tone: 'down' } : { level: L(h), label: 'floor', tone: 'up' }],
        marks: touches.map((t) => ({ t, label: 'touch', side: side(s > 0) })),
        noise: 0.38,
        fix: (lv) => {
          for (const t of touches) if (s * ((lv[t] as number) - L(h)) > 0.2) lv[t] = L(h) + s * 0.2;
          if (s * ((lv[38] as number) - L(h)) < 0.8) lv[38] = L(h) + s * 0.8;
          if (s * ((lv[39] as number) - L(h)) < 2) lv[39] = L(h) + s * 2;
        },
      };
    }
    case 'head-shoulders': {
      const hs = 14 + J(1.5);
      const hd = 25 + J(2);
      const rs = hs + J(1.5);
      const n = 5 + J(1);
      return {
        points: [[0, 100], [8, 100 + hs], [13, 100 + n], [22, 100 + hd], [30, 100 + n], [35, 100 + rs], [38, 100 + n - 0.5], [39, 100 + n - 2]],
        lines: [{ level: 100 + n, label: 'neckline', tone: 'accent' }],
        marks: [
          { t: 8, label: 'left shoulder', side: 'above' },
          { t: 22, label: 'head', side: 'above' },
          { t: 35, label: 'right shoulder', side: 'above' },
        ],
        noise: 0.4,
        fix: (lv) => {
          if ((lv[39] as number) > 100 + n - 0.8) lv[39] = 100 + n - 0.8;
        },
      };
    }
    case 'pump-fade': {
      return {
        points: [[0, 100], [15, 98.5 + J(0.8)], [30, 100.5 + J(0.8)], [31, 106], [33, 121 + J(2)], [35, 140 + J(3)], [37, 150 + J(3)], [38, 145], [39, 138 + J(2)]],
        lines: [{ level: 100, label: 'before the spike', tone: 'muted' }],
        marks: [{ t: 37, label: 'top of the spike', side: 'above' }],
        noise: 0.35,
        loudFrom: 31,
        loudNoise: 1,
        spikeFrom: 31,
        fix: (lv) => {
          if ((lv[38] as number) >= (lv[37] as number)) lv[38] = (lv[37] as number) - 2;
          if ((lv[39] as number) >= (lv[38] as number)) lv[39] = (lv[38] as number) - 2;
        },
      };
    }
    case 'choppy': {
      const path: number[] = [];
      let x = 100;
      for (let i = 0; i < VISIBLE_CANDLES; i += 1) {
        x = clamp(100 + (x - 100) * 0.82 + normalZ(rng) * 1.7, 88, 114);
        path.push(x);
      }
      return { points: [], lines: [], marks: [], noise: 0, direct: path };
    }
  }
}

/** The closing levels of a shape, one per candle: the waypoints joined by straight lines, plus noise. */
function levelsOf(shape: Shape, rng: Mulberry32): number[] {
  if (shape.direct) return [...shape.direct];
  const out: number[] = [];
  const pts = shape.points;
  let seg = 0;
  for (let i = 0; i < VISIBLE_CANDLES; i += 1) {
    while (seg < pts.length - 2 && i > (pts[seg + 1] as readonly [number, number])[0]) seg += 1;
    const a = pts[seg] as readonly [number, number];
    const b = pts[seg + 1] as readonly [number, number];
    const span = b[0] - a[0];
    const p = span <= 0 ? 1 : clamp((i - a[0]) / span, 0, 1);
    const base = a[1] + (b[1] - a[1]) * p;
    const loud = shape.loudFrom !== undefined && i >= shape.loudFrom;
    const amp = loud ? (shape.loudNoise ?? shape.noise) : shape.noise;
    out.push(base + normalZ(rng) * amp);
  }
  shape.fix?.(out);
  return out;
}

/** Turns closing levels into candles at the given scale (price at level 100 = scale × 100). */
function candlesOf(levels: readonly number[], rng: Mulberry32, scale: number, decimals: number, spikeFrom: number | undefined): LCandle[] {
  const out: LCandle[] = [];
  let prev = (levels[0] as number) * (1 + (rng.next() * 2 - 1) * 0.002);
  levels.forEach((close, i) => {
    const spike = spikeFrom !== undefined && i >= spikeFrom;
    // A spike has long wicks on top: always longer than the calm candles' (0.05 to 0.5 against 0.9 to 2.5).
    const up = spike ? 0.9 + rng.next() * 1.6 : rng.next() * 0.45 + 0.05;
    const down = rng.next() * 0.45 + 0.05;
    const hi = Math.max(prev, close) + up;
    const lo = Math.min(prev, close) - down;
    out.push({
      o: roundTo(prev * scale, decimals),
      h: roundTo(hi * scale, decimals),
      l: roundTo(lo * scale, decimals),
      c: roundTo(close * scale, decimals),
    });
    prev = close;
  });
  return out;
}

function pickAsset(rng: Mulberry32, kind: 'stock' | 'coin'): PracticeAsset {
  const list = kind === 'stock' ? PRACTICE_STOCKS : PRACTICE_COINS;
  const [ticker, name] = list[Math.floor(rng.next() * list.length)] as readonly [string, string];
  return { kind, ticker, name };
}

/** The price at level 100: dollars for a stock, a fraction of a dollar for a coin. */
function startPrice(rng: Mulberry32, kind: 'stock' | 'coin'): { price: number; decimals: number } {
  if (kind === 'stock') return { price: roundTo(15 + rng.next() * 185, 2), decimals: 2 };
  return { price: roundTo(0.004 + rng.next() * 0.056, 4), decimals: 6 };
}

function timeframe(kind: 'stock' | 'coin'): string {
  return kind === 'stock' ? 'one day' : 'one hour';
}

function pickInt(rng: Mulberry32, range: readonly [number, number]): number {
  return range[0] + rng.next() * (range[1] - range[0]);
}

/** The candles that follow the player's answer: a straight-ish walk to `target` with a little noise (and, if asked, a first move against the trend). */
function outcomeCandles(rng: Mulberry32, start: number, target: number, sign: 1 | -1, wobble: boolean, decimals: number): LCandle[] {
  const shake = [0.009, 0.012, 0.006];
  const out: LCandle[] = [];
  let prev = start;
  for (let t = 1; t <= OUTCOME_CANDLES; t += 1) {
    const base = start + ((target - start) * t) / OUTCOME_CANDLES;
    const against = wobble && t <= shake.length ? -sign * start * (shake[t - 1] as number) : 0;
    const noise = t === OUTCOME_CANDLES ? 0 : normalZ(rng) * start * 0.0035;
    const close = Math.max(base + against + noise, start * 0.2);
    const hi = Math.max(prev, close) + rng.next() * start * 0.006;
    const lo = Math.min(prev, close) - rng.next() * start * 0.006;
    out.push({ o: roundTo(prev, decimals), h: roundTo(hi, decimals), l: roundTo(Math.max(lo, start * 0.1), decimals), c: roundTo(close, decimals) });
    prev = close;
  }
  return out;
}

function toLines(shape: Shape, scale: number, decimals: number): ChartLine[] {
  return shape.lines.map((l) => ({ price: roundTo(l.level * scale, decimals), label: l.label, tone: l.tone }));
}

function toMarks(shape: Shape): ChartMark[] {
  return shape.marks.map((m) => ({ index: m.t, label: m.label, side: m.side }));
}

/** The sign (1 = up) of the pattern's mirror: the "down" patterns are the same shapes upside down. */
function orientation(id: PatternId): 1 | -1 {
  return id === 'bounce-down' || id === 'double-bottom' || id === 'range-bottom' || id === 'breakdown' ? -1 : 1;
}

export function describeAsset(a: PracticeAsset): string {
  return `${a.name} (${a.ticker})`;
}

/** One direction lesson. The same (pattern, seed) always gives the same lesson. */
export function generateDirection(pattern: PatternId, seed: number): DirectionScenario {
  const def: PatternDef = PATTERNS[pattern];
  const rng = new Mulberry32(seed);
  const asset = pickAsset(rng, def.assetKind);
  const { price, decimals } = startPrice(rng, def.assetKind);
  const scale = price / 100;
  const shape = shapeOf(pattern, rng, orientation(pattern));
  const levels = levelsOf(shape, rng);
  const visible = candlesOf(levels, rng, scale, decimals, shape.spikeFrom);
  // After the answer: does the price do what the pattern says?
  const roll = rng.next() * 100;
  const follow = roll < def.followPercent;
  let sign: 1 | -1;
  if (def.dir === 0) sign = rng.next() < 0.5 ? 1 : -1;
  else sign = follow ? def.dir : (-def.dir as 1 | -1);
  const range = follow || def.dir === 0 ? def.followMove : def.failMove;
  const magnitude = pickInt(rng, range);
  const wobble = rng.next() < 0.5;
  const last = (visible[visible.length - 1] as LCandle).c;
  const target = last * (1 + (sign * magnitude) / 100);
  const outcome = outcomeCandles(rng, last, target, sign, wobble, decimals);
  const end = (outcome[outcome.length - 1] as LCandle).c;
  const unit = timeframe(def.assetKind);
  const story =
    def.assetKind === 'stock'
      ? `Practice chart: ${describeAsset(asset)} is an invented company, not one of the game's. Each candle is ${unit}. This is its last ${VISIBLE_CANDLES} days.`
      : `Practice chart: ${describeAsset(asset)} is an invented memecoin, not one of the game's. Each candle is ${unit}. This is its last ${VISIBLE_CANDLES} hours.`;
  return {
    kind: 'direction',
    seed,
    pattern,
    asset,
    visible,
    outcome,
    lines: toLines(shape, scale, decimals),
    marks: toMarks(shape),
    story,
    question: 'What do you do now?',
    follow: def.dir === 0 ? true : follow,
    outcomePct: roundTo((end / last - 1) * 100, 1),
  };
}

const SIZE_SETS: readonly (readonly [number, number, Grade][])[] = [
  [[100, 25, 'wrong'], [50, 5, 'ok'], [10, 2, 'best']],
  [[100, 20, 'wrong'], [25, 5, 'ok'], [10, 3, 'best']],
  [[100, 15, 'wrong'], [40, 4, 'ok'], [5, 5, 'best']],
];

/** One sizing lesson: the player has decided which way to trade and must pick how big. The price first shakes against him, then goes his way. */
export function generateSize(seed: number): SizeScenario {
  const rng = new Mulberry32(seed);
  const asset = pickAsset(rng, 'stock');
  const { price, decimals } = startPrice(rng, 'stock');
  const scale = price / 100;
  const dir: 1 | -1 = rng.next() < 0.5 ? 1 : -1;
  const shape = shapeOf(dir > 0 ? 'pullback-up' : 'bounce-down', rng, dir);
  const levels = levelsOf(shape, rng);
  const visible = candlesOf(levels, rng, scale, decimals, undefined);
  // The options: one of three sets, in a shuffled order so the right one is not always in the same place.
  const set = SIZE_SETS[Math.floor(rng.next() * SIZE_SETS.length)] as readonly [number, number, Grade][];
  const order = [0, 1, 2];
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng.next() * (i + 1));
    const tmp = order[i] as number;
    order[i] = order[j] as number;
    order[j] = tmp;
  }
  const ids = ['o0', 'o1', 'o2'] as const;
  const options: SizeOption[] = order.map((k, pos) => {
    const [fractionPct, leverage, grade] = set[k] as [number, number, Grade];
    return { id: ids[pos] as SizeOption['id'], fractionPct, leverage, grade };
  });
  // What happens: a shake against the trade of 7.5 to 10 %, then a move his way of 6 to 12 %.
  const entry = (visible[visible.length - 1] as LCandle).c;
  const dd = 0.075 + rng.next() * 0.025;
  const m = 0.06 + rng.next() * 0.06;
  const against = -dir; // the direction the price takes during the shake
  const final = entry * (1 + dir * m);
  const c1 = entry * (1 + against * dd * 0.45);
  const c2 = entry * (1 + against * dd * 0.8);
  const c3 = entry * (1 + against * dd * 0.35);
  const closes: number[] = [c1, c2, c3];
  for (let t = 4; t <= OUTCOME_CANDLES; t += 1) closes.push(c3 + ((final - c3) * (t - 3)) / (OUTCOME_CANDLES - 3));
  const outcome: LCandle[] = [];
  let prev = entry;
  closes.forEach((close, i) => {
    let hi = Math.max(prev, close) + rng.next() * entry * 0.004;
    let lo = Math.min(prev, close) - rng.next() * entry * 0.004;
    if (i === 1) {
      // the deepest point of the shake
      if (against < 0) lo = entry * (1 - dd);
      else hi = entry * (1 + dd);
    }
    outcome.push({ o: roundTo(prev, decimals), h: roundTo(hi, decimals), l: roundTo(lo, decimals), c: roundTo(close, decimals) });
    prev = close;
  });
  const lastClose = (outcome[outcome.length - 1] as LCandle).c;
  const adverse = dir > 0 ? Math.max(0, 1 - Math.min(...outcome.map((c) => c.l)) / entry) : Math.max(0, Math.max(...outcome.map((c) => c.h)) / entry - 1);
  const favourable = dir > 0 ? lastClose / entry - 1 : 1 - lastClose / entry;
  const word = dir > 0 ? 'buy' : 'short';
  return {
    kind: 'size',
    seed,
    asset,
    visible,
    outcome,
    lines: toLines(shape, scale, decimals),
    marks: toMarks(shape),
    story: `Practice chart: ${describeAsset(asset)} is an invented company, not one of the game's. Each candle is one day. The trend is clear and you have decided to ${word}. You have $1,000 of cash.`,
    question: 'How do you open the trade?',
    dir,
    options,
    entry,
    adverse: roundTo(adverse, 4),
    favourable: roundTo(favourable, 4),
    outcomePct: roundTo(((lastClose / entry) - 1) * 100, 1),
  };
}

/** Any lesson from its kind, pattern and seed (a 'size' lesson ignores the pattern). */
export function generate(kind: LessonKind, pattern: PatternId, seed: number): Scenario {
  return kind === 'size' ? generateSize(seed) : generateDirection(pattern, seed);
}

/** A price as the practice chart shows it. */
export function lessonPrice(kind: 'stock' | 'coin', price: number): string {
  if (kind === 'stock') return `$${price.toFixed(2)}`;
  return price < 0.01 ? `$${price.toFixed(5)}` : `$${price.toFixed(4)}`;
}
