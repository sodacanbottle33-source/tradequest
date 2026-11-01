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
  /** Where the market gets louder, and how many times louder (a spike). */
  readonly loudFrom?: number;
  readonly loudMul?: number;
  /** From this candle on the wicks on top are long. */
  readonly spikeFrom?: number;
  /** Makes the last candles say what the pattern says (the noise must not hide it). */
  readonly fix?: (levels: number[]) => void;
  /** The price just wanders around where it started (the chart with no pattern). */
  readonly wander?: boolean;
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
        fix: (lv) => {
          // A ceiling (or floor) that holds turns the price back: a close that would end beyond it falls back to the near side, a little less far.
          for (let i = 0; i <= 35; i += 1) {
            const beyond = s * ((lv[i] as number) - L(h)) + 0.1;
            if (beyond > 0) lv[i] = L(h) + s * (-0.1 - beyond * 0.7);
          }
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
        loudFrom: 31,
        loudMul: 1.5,
        spikeFrom: 31,
        fix: (lv) => {
          if ((lv[38] as number) >= (lv[37] as number)) lv[38] = (lv[37] as number) - 2;
          if ((lv[39] as number) >= (lv[38] as number)) lv[39] = (lv[38] as number) - 2;
        },
      };
    }
    case 'choppy':
      return { points: [], lines: [], marks: [], wander: true };
  }
}

// ---- how restless a chart is -----------------------------------------------------------------------------------------------------

/**
 * How restless one chart is. Real prices never run along a ruler: they move in swings that last a few candles, have quiet spells and
 * wild spells, now and then jump on a single candle, and leave wicks of all lengths. A stock can be calm or jumpy; a memecoin is always
 * much wilder. All sizes are in level units (about percent of the first price).
 */
interface Feel {
  /** The size of the candle-to-candle noise. */
  readonly noise: number;
  /** The size of the swings that last several candles. */
  readonly swing: number;
  /** The chance that one candle is a shock, a few times louder than the rest. */
  readonly shock: number;
  /** How long the wicks are, compared with the noise. */
  readonly wick: number;
}

/** How much of the swing carries over from one candle to the next. */
const STICK = 0.68;
/** The swing's push each candle is this share of its size, so that the swing as a whole stays about `feel.swing` big. */
const SWING_PUSH = 0.733;

function feelOf(kind: 'stock' | 'coin', rng: Mulberry32, calm: boolean): Feel {
  const a = rng.next();
  const b = rng.next();
  const f: Feel =
    kind === 'stock'
      ? { noise: 0.9 + 1.1 * a, swing: 0.9 + 0.8 * b, shock: 0.05, wick: 0.9 }
      : { noise: 2.3 + 1.3 * a, swing: 2 + 1.2 * b, shock: 0.08, wick: 1 };
  // The calm version is only the last resort when no restless chart showed its pattern: it is as quiet as the charts used to be.
  return calm ? { noise: f.noise * 0.3, swing: f.swing * 0.25, shock: 0, wick: f.wick * 0.5 } : f;
}

/** The candles where the pattern has its key points: the noise is quieter there, so the peaks and lows can be read. */
function anchorsOf(shape: Shape): ReadonlySet<number> {
  const out = new Set<number>();
  for (const p of shape.points) out.add(p[0]);
  for (const m of shape.marks) out.add(m.t);
  return out;
}

/** One candle's share of the noise: quiet at a key point, a little less quiet next to it, full everywhere else. */
function quietAt(i: number, anchors: ReadonlySet<number>): number {
  if (anchors.has(i)) return 0.45;
  if (anchors.has(i - 1) || anchors.has(i + 1)) return 0.75;
  return 1;
}

/** The wobble of every candle: swings that last a few candles, noise that comes in quiet and wild spells, and now and then a shock. */
function wobbleOf(count: number, rng: Mulberry32, feel: Feel, quiet: (i: number) => number): number[] {
  const out: number[] = [];
  let swing = 0;
  let spell = 1;
  for (let i = 0; i < count; i += 1) {
    spell = clamp(1 + 0.8 * (spell - 1) + 0.3 * normalZ(rng), 0.55, 2.2);
    swing = STICK * swing + SWING_PUSH * feel.swing * normalZ(rng);
    let e = normalZ(rng) * feel.noise * spell;
    if (rng.next() < feel.shock) e *= 2.2 + rng.next() * 1.2;
    out.push((swing + e) * quiet(i));
  }
  return out;
}

/** The closing levels of a shape, one per candle: the waypoints joined by straight lines, plus the wobble. */
function levelsOf(shape: Shape, rng: Mulberry32, feel: Feel): number[] {
  if (shape.wander) {
    // A chart with no pattern: the price wanders around where it started and keeps being pulled back.
    const out: number[] = [];
    let x = 100;
    let spell = 1;
    for (let i = 0; i < VISIBLE_CANDLES; i += 1) {
      spell = clamp(1 + 0.8 * (spell - 1) + 0.3 * normalZ(rng), 0.55, 2.2);
      let push = normalZ(rng) * feel.noise * 1.5 * spell;
      if (rng.next() < feel.shock) push *= 2 + rng.next();
      x = clamp(100 + (x - 100) * 0.8 + push, 88, 114);
      out.push(x);
    }
    return out;
  }
  const out: number[] = [];
  const pts = shape.points;
  const wobble = wobbleOf(VISIBLE_CANDLES, rng, feel, (i) => quietAt(i, anchorsOf(shape)));
  let seg = 0;
  for (let i = 0; i < VISIBLE_CANDLES; i += 1) {
    while (seg < pts.length - 2 && i > (pts[seg + 1] as readonly [number, number])[0]) seg += 1;
    const a = pts[seg] as readonly [number, number];
    const b = pts[seg + 1] as readonly [number, number];
    const span = b[0] - a[0];
    const p = span <= 0 ? 1 : clamp((i - a[0]) / span, 0, 1);
    const base = a[1] + (b[1] - a[1]) * p;
    const loud = shape.loudFrom !== undefined && i >= shape.loudFrom ? (shape.loudMul ?? 1) : 1;
    out.push(base + (wobble[i] as number) * loud);
  }
  shape.fix?.(out);
  return out;
}

/** The two wicks of a candle, as lengths in level units: mostly short, now and then long, sometimes one very long (a hammer or a shooting star). */
function wicksOf(rng: Mulberry32, feel: Feel): [number, number] {
  const a = rng.next();
  const b = rng.next();
  const c = rng.next();
  let up = feel.noise * feel.wick * (0.05 + a * a * 2.2);
  let down = feel.noise * feel.wick * (0.05 + b * b * 2.2);
  if (c < 0.08) up *= 2.4;
  else if (c < 0.16) down *= 2.4;
  return [up, down];
}

/** Turns closing levels into candles at the given scale (price at level 100 = scale × 100). Every candle opens where the one before closed. */
function candlesOf(levels: readonly number[], rng: Mulberry32, scale: number, decimals: number, feel: Feel, spikeFrom: number | undefined): LCandle[] {
  const out: LCandle[] = [];
  let prev = (levels[0] as number) * (1 + (rng.next() * 2 - 1) * 0.002);
  levels.forEach((close, i) => {
    let [up, down] = wicksOf(rng, feel);
    // A spike has long wicks on top: far longer than the calm candles' (about three times the noise against less than one).
    if (spikeFrom !== undefined && i >= spikeFrom) up = feel.noise * (1.6 + rng.next() * 3);
    const hi = Math.max(prev, close) + up;
    const lo = Math.max(Math.min(prev, close) - down, 1);
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

// ---- is the pattern still there? ---------------------------------------------------------------------------------------------------

/** The price of a named line, or null. */
function lineAt(lines: readonly ChartLine[], label: string): number | null {
  const found = lines.find((l) => l.label === label);
  return found ? found.price : null;
}

/**
 * Whether a chart still shows its pattern after the restless noise was added: the rules that the lesson's own words rely on (a breakout
 * closes above the ceiling it kept hitting, the two peaks of a double top match, the head is higher than both shoulders, and so on), and
 * that every mark sits on the extreme it points at. A chart that fails is drawn again with new noise.
 */
function showsPattern(id: PatternId, v: readonly LCandle[], lines: readonly ChartLine[], marks: readonly ChartMark[]): boolean {
  const s = orientation(id);
  const c = (i: number): number => (v[i] as LCandle).c;
  const hi = (i: number): number => (v[i] as LCandle).h;
  const lo = (i: number): number => (v[i] as LCandle).l;
  const end = c(VISIBLE_CANDLES - 1);
  // Every mark sits on (almost) the highest high or the lowest low around it.
  for (const m of marks) {
    for (let j = Math.max(0, m.index - 2); j <= Math.min(VISIBLE_CANDLES - 1, m.index + 2); j += 1) {
      if (m.side === 'above' && hi(j) > hi(m.index) * 1.012) return false;
      if (m.side === 'below' && lo(j) < lo(m.index) * 0.988) return false;
    }
  }
  switch (id) {
    case 'pullback-up':
    case 'bounce-down': {
      const line = lineAt(lines, s > 0 ? 'last low' : 'last high');
      return s * (c(28) / c(0) - 1) > 0.12 && s * (c(28) - c(11)) > 0 && s * (c(28) - c(35)) > 0 && s * (c(39) - c(38)) > 0 && line !== null && s * (end - line) > 0;
    }
    case 'double-top':
    case 'double-bottom': {
      const neck = lineAt(lines, 'neckline');
      if (neck === null) return false;
      const p1 = s > 0 ? hi(13) : lo(13);
      const p2 = s > 0 ? hi(31) : lo(31);
      // Both peaks (or lows) match, and the neckline is on the far side of both.
      const apart = s > 0 ? Math.min(p1, p2) - neck : neck - Math.max(p1, p2);
      return Math.abs(p1 / p2 - 1) < 0.045 && apart > 0 && s * (end - neck) < 0;
    }
    case 'range-top':
    case 'range-bottom': {
      const ceiling = lineAt(lines, 'ceiling');
      const floor = lineAt(lines, 'floor');
      if (ceiling === null || floor === null) return false;
      for (let i = 0; i < VISIBLE_CANDLES; i += 1) if (c(i) > ceiling * 1.025 || c(i) < floor * 0.975) return false;
      return ceiling > floor * 1.07 && Math.abs(end / (s > 0 ? ceiling : floor) - 1) < 0.025;
    }
    case 'breakout':
    case 'breakdown': {
      const level = lineAt(lines, s > 0 ? 'ceiling' : 'floor');
      if (level === null) return false;
      // Before the break the closes stay on the near side of the line (a close beyond it would be a break already).
      for (let i = 0; i <= 35; i += 1) if (s * (c(i) - level) > level * 0.003) return false;
      return s * (c(38) - level) > 0 && s * (end - level) > 0;
    }
    case 'head-shoulders': {
      const neck = lineAt(lines, 'neckline');
      if (neck === null) return false;
      return hi(22) > hi(8) * 1.01 && hi(22) > hi(35) * 1.01 && Math.abs(hi(8) / hi(35) - 1) < 0.06 && end < neck;
    }
    case 'pump-fade': {
      let late = 0;
      for (let i = 30; i < VISIBLE_CANDLES; i += 1) late = Math.max(late, c(i));
      const wick = (i: number): number => (hi(i) - Math.max((v[i] as LCandle).o, c(i))) / c(i);
      let calm = 0;
      for (let i = 0; i < 30; i += 1) calm += wick(i) / 30;
      let spike = 0;
      for (let i = 31; i < 38; i += 1) spike += wick(i) / 7;
      return late > c(30) * 1.35 && c(38) < (v[38] as LCandle).o && c(39) < (v[39] as LCandle).o && spike > calm * 1.8;
    }
    case 'choppy':
      return Math.abs(end / c(0) - 1) < 0.25;
  }
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

/**
 * The candles that follow the player's answer: the price walks the way the chart's own restlessness says (swings, quiet and wild spells, shocks),
 * then the walk is bent so that the last candle closes exactly on `target` (a bridge). If asked, the first candles also start with a move against the trend.
 */
function outcomeCandles(rng: Mulberry32, start: number, target: number, sign: 1 | -1, wobble: boolean, decimals: number, feel: Feel): LCandle[] {
  const shake = [0.009, 0.012, 0.006];
  const unit = start / 100;
  const walk: number[] = [];
  let w = 0;
  let spell = 1;
  let swing = 0;
  for (let t = 1; t <= OUTCOME_CANDLES; t += 1) {
    spell = clamp(1 + 0.8 * (spell - 1) + 0.3 * normalZ(rng), 0.55, 2.2);
    swing = STICK * swing + SWING_PUSH * feel.swing * 0.5 * normalZ(rng);
    let step = normalZ(rng) * feel.noise * 0.9 * spell;
    if (rng.next() < feel.shock) step *= 2.2 + rng.next() * 1.2;
    w += (step + swing) * unit;
    walk.push(w);
  }
  const total = walk[OUTCOME_CANDLES - 1] as number;
  const out: LCandle[] = [];
  let prev = start;
  for (let t = 1; t <= OUTCOME_CANDLES; t += 1) {
    const base = start + ((target - start) * t) / OUTCOME_CANDLES;
    const against = wobble && t <= shake.length ? -sign * start * (shake[t - 1] as number) : 0;
    const bridge = (walk[t - 1] as number) - (total * t) / OUTCOME_CANDLES; // nothing at the last candle: it closes on the target
    const close = Math.max(base + against + bridge, start * 0.2);
    const [up, down] = wicksOf(rng, feel);
    const hi = Math.max(prev, close) + up * unit;
    const lo = Math.max(Math.min(prev, close) - down * unit, start * 0.1);
    out.push({ o: roundTo(prev, decimals), h: roundTo(hi, decimals), l: roundTo(lo, decimals), c: roundTo(close, decimals) });
    prev = close;
  }
  return out;
}

/** The lines that name one specific extreme of the drawn chart are put exactly on it (the noise moved it a little from where the shape had it). */
function snapLines(id: PatternId, lines: readonly ChartLine[], v: readonly LCandle[]): ChartLine[] {
  const hi = (i: number): number => (v[i] as LCandle).h;
  const lo = (i: number): number => (v[i] as LCandle).l;
  const put = (label: string, price: number): ChartLine[] => lines.map((l) => (l.label === label ? { ...l, price } : l));
  switch (id) {
    case 'pullback-up':
      return put('last low', Math.min(...[33, 34, 35, 36, 37].map(lo)));
    case 'bounce-down':
      return put('last high', Math.max(...[33, 34, 35, 36, 37].map(hi)));
    case 'double-top':
      return put('two peaks', Math.max(hi(13), hi(31)));
    case 'double-bottom':
      return put('two lows', Math.min(lo(13), lo(31)));
    default:
      return [...lines];
  }
}

/** How many times a chart is drawn again with new noise when it does not show its pattern (the dice are the seeded ones, so the result is always the same). */
const DRAW_TRIES = 200;

/**
 * A restless chart that still shows its pattern. Noise this big can hide a peak or push a close over a line, so each drawing is checked against
 * the pattern's rules and drawn again if it fails. The quiet version is only the last resort and has not been needed in any test seed.
 */
function drawChart(id: PatternId, shape: Shape, rng: Mulberry32, kind: 'stock' | 'coin', scale: number, decimals: number): { feel: Feel; visible: LCandle[]; lines: ChartLine[] } {
  const base = toLines(shape, scale, decimals);
  const marks = toMarks(shape);
  for (let tries = 0; ; tries += 1) {
    const calm = tries >= DRAW_TRIES;
    const feel = feelOf(kind, rng, calm);
    const levels = levelsOf(shape, rng, feel);
    const visible = candlesOf(levels, rng, scale, decimals, feel, shape.spikeFrom);
    const lines = snapLines(id, base, visible);
    if (calm || showsPattern(id, visible, lines, marks)) return { feel, visible, lines };
  }
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
  const { feel, visible, lines } = drawChart(pattern, shape, rng, def.assetKind, scale, decimals);
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
  const outcome = outcomeCandles(rng, last, target, sign, wobble, decimals, feel);
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
    lines,
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
  const trend: PatternId = dir > 0 ? 'pullback-up' : 'bounce-down';
  const shape = shapeOf(trend, rng, dir);
  const { feel, visible, lines } = drawChart(trend, shape, rng, 'stock', scale, decimals);
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
  // The shake is exact (it is what the lesson is about), the climb after it is as restless as the chart: a bridge from the end of the shake to the final price.
  const unit = entry / 100;
  const deep = dir > 0 ? entry * (1 - dd) : entry * (1 + dd);
  const closes: number[] = [c1, c2, c3];
  const climb = OUTCOME_CANDLES - 3;
  const walk: number[] = [];
  let w = 0;
  for (let k = 1; k <= climb; k += 1) {
    w += normalZ(rng) * feel.noise * 0.8 * unit;
    walk.push(w);
  }
  for (let k = 1; k <= climb; k += 1) {
    const bridge = (walk[k - 1] as number) - ((walk[climb - 1] as number) * k) / climb;
    const close = c3 + ((final - c3) * k) / climb + bridge;
    // The climb never goes back below the deepest point of the shake.
    closes.push(dir > 0 ? Math.max(close, deep * 1.004) : Math.min(close, deep * 0.996));
  }
  const outcome: LCandle[] = [];
  let prev = entry;
  closes.forEach((close, i) => {
    const [up, down] = wicksOf(rng, feel);
    let hi = Math.max(prev, close) + up * unit;
    let lo = Math.min(prev, close) - down * unit;
    if (i === 1) {
      // the deepest point of the shake
      if (against < 0) lo = deep;
      else hi = deep;
    } else if (against < 0) lo = Math.max(lo, deep * 1.003);
    else hi = Math.min(hi, deep * 0.997);
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
    lines,
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
