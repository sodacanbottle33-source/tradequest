// Grading a lesson answer and working out what each choice would have done (docs/world.md §19.2). Pure code: the server calls it, and it
// decides the grade alone. The AI teacher never sees a choice without its grade, and cannot change it.

import { roundTo } from './candles';
import type { DirectionScenario, Scenario, SizeScenario } from './generate';
import { CHOICE_DETAIL, CHOICE_LABEL, PATTERNS } from './patterns';
import type { Choice, Grade } from './types';

/** XP for an answer, and for the first time a tutorial step is finished. */
export const XP = { best: 10, ok: 6, wrong: 0, tutorialStep: 5 } as const;
/** XP needed for each level, and the names of the levels. */
export const XP_PER_LEVEL = 100;
export const LEVEL_TITLES: readonly (readonly [number, string])[] = [
  [1, 'Rookie'],
  [2, 'Apprentice'],
  [4, 'Trader'],
  [7, 'Strategist'],
  [11, 'Veteran'],
  [16, 'Master'],
];

export function levelOf(xp: number): number {
  return Math.floor(Math.max(0, xp) / XP_PER_LEVEL) + 1;
}

export function titleOf(level: number): string {
  let title = (LEVEL_TITLES[0] as readonly [number, string])[1];
  for (const [from, name] of LEVEL_TITLES) if (level >= from) title = name;
  return title;
}

export interface OptionResult {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  /** How good the choice was. */
  readonly grade: Grade;
  /** The result at the end, in percent (of the price for a direction lesson, of the whole account for a sizing lesson). */
  readonly changePct: number;
  /** The worst moment on the way, in percent (0 or less). */
  readonly worstPct: number;
  readonly liquidated: boolean;
  /** One plain sentence about what this choice would have done. */
  readonly text: string;
}

/** "+5.3 %" or "−1.8 %" (one decimal). */
export function pctText(x: number): string {
  const r = roundTo(x, 1);
  if (r === 0) return '0.0 %';
  return `${r > 0 ? '+' : '−'}${Math.abs(r).toFixed(1)} %`;
}

export function directionGrade(s: DirectionScenario, choice: Choice): Grade {
  const def = PATTERNS[s.pattern];
  if (choice === def.best) return 'best';
  return def.ok.includes(choice) ? 'ok' : 'wrong';
}

/** What buying, shorting and waiting would each have done in a direction lesson. */
export function directionResults(s: DirectionScenario): OptionResult[] {
  const entry = (s.visible[s.visible.length - 1] as { c: number }).c;
  const end = (s.outcome[s.outcome.length - 1] as { c: number }).c;
  const lowest = Math.min(...s.outcome.map((c) => c.l));
  const highest = Math.max(...s.outcome.map((c) => c.h));
  const up = (end / entry - 1) * 100;
  const dipped = Math.min(0, (lowest / entry - 1) * 100);
  const spiked = Math.min(0, -((highest / entry - 1) * 100));
  const make = (choice: Choice, changePct: number, worstPct: number): OptionResult => {
    const grade = directionGrade(s, choice);
    const text =
      choice === 'wait'
        ? 'You keep your cash. Nothing is won and nothing is lost.'
        : `${choice === 'buy' ? 'Buying' : 'Shorting'} would have ended at ${pctText(changePct)}. On the way, the worst moment was ${pctText(worstPct)}.`;
    return { id: choice, label: CHOICE_LABEL[choice], detail: CHOICE_DETAIL[choice], grade, changePct: roundTo(changePct, 1), worstPct: roundTo(worstPct, 1), liquidated: false, text };
  };
  return [make('buy', up, dipped), make('short', -up, spiked), make('wait', 0, 0)];
}

export function sizeLabel(fractionPct: number, leverage: number): string {
  const part = fractionPct >= 100 ? 'All of my cash' : `${fractionPct} % of my cash`;
  return `${part}, ${leverage}× leverage`;
}

/** What each way of sizing the trade would have done. Isolated margin: a wiped-out trade loses the part of the cash that went into it, no more. */
export function sizeResults(s: SizeScenario): OptionResult[] {
  return s.options.map((o) => {
    const f = o.fractionPct / 100;
    const liquidated = s.adverse >= 1 / o.leverage;
    const end = liquidated ? -f * 100 : f * o.leverage * s.favourable * 100;
    const worst = -f * Math.min(1, o.leverage * s.adverse) * 100;
    const stake = `$${roundTo(f * 1000, 0)}`;
    const text = liquidated
      ? `The market would have closed this trade by itself when the price moved ${pctText(100 / o.leverage).replace('+', '')} against you. You would have lost the ${stake} you put in (${pctText(end)} of your account), before the price turned your way.`
      : `You would have ended at ${pctText(end)} of your account. At the worst moment on the way you were down ${pctText(worst).replace('−', '')} of your account.`;
    return { id: o.id, label: sizeLabel(o.fractionPct, o.leverage), detail: `${stake} of $1,000`, grade: o.grade, changePct: roundTo(end, 1), worstPct: roundTo(worst, 1), liquidated, text };
  });
}

export function resultsOf(s: Scenario): OptionResult[] {
  return s.kind === 'size' ? sizeResults(s) : directionResults(s);
}

/** The grade of the player's choice, or null when the choice is not one of the options. */
export function gradeOf(s: Scenario, choiceId: string): Grade | null {
  if (s.kind === 'size') return s.options.find((o) => o.id === choiceId)?.grade ?? null;
  if (choiceId !== 'buy' && choiceId !== 'short' && choiceId !== 'wait') return null;
  return directionGrade(s, choiceId);
}

/** The id of the best option. */
export function bestIdOf(s: Scenario): string {
  if (s.kind === 'size') return (s.options.find((o) => o.grade === 'best') as { id: string }).id;
  return PATTERNS[s.pattern].best;
}

/** The statistics key a lesson counts under. */
export function statKeyOf(s: Scenario): string {
  return s.kind === 'size' ? 'sizing' : s.pattern;
}

/** XP for a grade. */
export function xpFor(grade: Grade): number {
  return XP[grade];
}
