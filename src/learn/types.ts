// Shared types of the Learn feature (docs/world.md §19): the tutorial and the practice lessons.
// Everything in src/learn is plain, deterministic code: no Math.random, no clock, no React, nothing from the server. The server and the
// browser both import it, so the practice charts, the grading and the built-in teaching text exist exactly once.

/** One candle of a practice chart. Prices are dollars (stocks to the cent, coins to a millionth of a dollar). */
export interface LCandle {
  readonly o: number;
  readonly h: number;
  readonly l: number;
  readonly c: number;
}

/** What a player can answer in a direction lesson. */
export type Choice = 'buy' | 'short' | 'wait';

export type Grade = 'best' | 'ok' | 'wrong';

/** A horizontal line drawn on a practice chart after the answer (a ceiling, a floor, a neckline). */
export interface ChartLine {
  readonly price: number;
  readonly label: string;
  readonly tone: 'up' | 'down' | 'accent' | 'muted';
}

/** A small label pointing at one candle (a peak, a low). */
export interface ChartMark {
  readonly index: number;
  readonly label: string;
  readonly side: 'above' | 'below';
}

export const LESSON_KINDS = ['direction', 'size'] as const;
export type LessonKind = (typeof LESSON_KINDS)[number];

/** The ids of the chart patterns. 'sizing' is the lesson about how big to trade, not a pattern. */
export const PATTERN_IDS = [
  'pullback-up',
  'bounce-down',
  'double-top',
  'double-bottom',
  'range-top',
  'range-bottom',
  'breakout',
  'breakdown',
  'head-shoulders',
  'pump-fade',
  'choppy',
] as const;
export type PatternId = (typeof PATTERN_IDS)[number];

/** Every key the player's per-pattern statistics are kept under. */
export const STAT_KEYS = [...PATTERN_IDS, 'sizing'] as const;
export type StatKey = (typeof STAT_KEYS)[number];

/** The made-up thing on the practice chart. */
export interface PracticeAsset {
  readonly kind: 'stock' | 'coin';
  readonly ticker: string;
  readonly name: string;
}
