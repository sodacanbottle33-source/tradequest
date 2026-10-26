// What the server and the browser say to each other about Learn (docs/world.md §19). Plain data; the browser never receives the part of a
// lesson that happens after the answer until the answer has been given.

import type { CoachSection } from './coach';
import type { OptionResult } from './grade';
import type { ChartLine, ChartMark, Grade, LCandle, LessonKind, PracticeAsset, StatKey } from './types';

export interface LearnProgress {
  readonly xp: number;
  readonly level: number;
  readonly title: string;
  /** XP into the current level, and what a level takes. */
  readonly xpInLevel: number;
  readonly xpPerLevel: number;
  readonly streak: number;
  readonly bestStreak: number;
  readonly lessonsDone: number;
  /** The tutorial steps (1 to 9) this player has finished. */
  readonly tutorialSteps: readonly number[];
  readonly tutorialTotal: number;
}

export interface PatternStat {
  readonly key: StatKey;
  readonly name: string;
  readonly seen: number;
  readonly best: number;
  readonly ok: number;
  readonly wrong: number;
}

/** Whether the AI teacher is on, and how many comments this player has left today. */
export interface AiStatus {
  readonly enabled: boolean;
  readonly perDay: number;
  readonly leftToday: number;
}

export interface LessonOptionView {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
}

/** A lesson that waits for an answer: only what the player may see. */
export interface LessonView {
  readonly id: number;
  readonly kind: LessonKind;
  readonly asset: PracticeAsset;
  readonly candles: readonly LCandle[];
  readonly story: string;
  readonly question: string;
  readonly options: readonly LessonOptionView[];
}

export interface LearnState {
  readonly progress: LearnProgress;
  readonly stats: readonly PatternStat[];
  readonly ai: AiStatus;
  readonly open: LessonView | null;
}

/** The answer to an answer: the grade and everything that was hidden. */
export interface LessonResult {
  readonly lessonId: number;
  readonly kind: LessonKind;
  readonly asset: PracticeAsset;
  readonly grade: Grade;
  readonly chosen: string;
  readonly best: string;
  readonly patternName: string;
  readonly outcome: readonly LCandle[];
  readonly outcomePct: number;
  readonly lines: readonly ChartLine[];
  readonly marks: readonly ChartMark[];
  readonly results: readonly OptionResult[];
  readonly headline: string;
  readonly sections: readonly CoachSection[];
  readonly xpGained: number;
  readonly progress: LearnProgress;
  readonly ai: AiStatus;
  /** What the player wrote as his reason (cleaned), or null. */
  readonly reason: string | null;
}

export type CoachReason = 'ok' | 'off' | 'limit' | 'failed';

export interface CoachReply {
  readonly text: string | null;
  readonly reason: CoachReason;
  readonly ai: AiStatus;
}

export interface TutorialReply {
  readonly progress: LearnProgress;
  readonly xpGained: number;
}
