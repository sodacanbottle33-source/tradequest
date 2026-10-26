// Learn: the tutorial's saved progress and the practice lessons (docs/world.md §19).
//
// What this file does NOT do: it never touches money, shares, prices, orders or the leaderboards. Learning gives XP and a level, nothing else.
//
// A lesson is made by code (src/learn): the chart, the right answer and what happens next. The whole lesson is stored when it starts, so it stays
// the same until it is answered, even if the program is updated in between. The browser only gets the part the player may see; the part that
// happens next comes back with the grade, once. Grading is decided here, by the code in src/learn/grade.ts, never by an AI. The optional AI
// teacher (server/aiClient.ts) is asked afterwards, for a personal comment on an answer that is already graded; if it is off, over its daily
// limit or fails, the player still has the built-in teaching text.

import { randomInt } from 'node:crypto';
import { builtInCoach, buildCoachPrompt, cleanCoachText, cleanReason } from '../src/learn/coach';
import { generate, type Scenario } from '../src/learn/generate';
import { bestIdOf, gradeOf, levelOf, resultsOf, sizeLabel, statKeyOf, titleOf, XP, XP_PER_LEVEL } from '../src/learn/grade';
import { CHOICE_DETAIL, CHOICE_LABEL, PATTERNS, SIZING, statName } from '../src/learn/patterns';
import { TUTORIAL_STEPS } from '../src/learn/tutorial';
import { PATTERN_IDS, STAT_KEYS, type Grade, type PatternId, type StatKey } from '../src/learn/types';
import type { AiStatus, CoachReply, LearnProgress, LearnState, LessonOptionView, LessonResult, LessonView, PatternStat, TutorialReply } from '../src/learn/wire';
import type { User } from './auth';
import type { AiClient } from './aiClient';
import type { Logger } from './log';
import type { Db } from './sqlite';

export class LearnError extends Error {
  constructor(
    readonly code: 'bad_request' | 'no_such_lesson' | 'already_done' | 'not_answered' | 'rate_limited',
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** The most lessons one player can start in an hour, and the most AI comments he can ask for in a minute. */
export const LESSON_STARTS_PER_HOUR = 60;
export const COACH_PER_MINUTE = 6;
/** How many of a player's lessons are kept (the newest). His XP and statistics are kept for good. */
export const LESSONS_KEPT = 40;
/** Size lessons only start after this many answered lessons, and then about one in five. */
export const SIZE_AFTER_LESSONS = 3;
export const SIZE_CHANCE_PERCENT = 20;
const DAY_MS = 86_400_000;

export interface LearnDeps {
  readonly db: Db;
  readonly now: () => number;
  readonly log: Logger;
  /** Null when the AI teacher is off. */
  readonly ai: AiClient | null;
  readonly perUserDaily: number;
  readonly globalDaily: number;
  /** A whole number from 0 up to (not including) n. The game uses node:crypto; a test can use its own. */
  readonly random?: (n: number) => number;
}

interface ProgressRow {
  tutorial_mask: number;
  xp: number;
  streak: number;
  best_streak: number;
  lessons_done: number;
}

interface LessonRow {
  id: number;
  user_id: number;
  kind: 'direction' | 'size';
  pattern: string;
  seed: number;
  scenario: string;
  issued_ms: number;
  answered_ms: number | null;
  skipped_ms: number | null;
  choice: string | null;
  grade: Grade | null;
  reason: string | null;
  coach_text: string | null;
}

function maskSteps(mask: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < TUTORIAL_STEPS; i += 1) if (Math.floor(mask / 2 ** i) % 2 === 1) out.push(i + 1);
  return out;
}

/** How likely each pattern in `pool` is to come next: 3 for one never seen, otherwise 1 (always right) to 4 (always wrong), so weak spots come back more often. */
export function lessonWeights(stats: ReadonlyMap<string, PatternStat>, pool: readonly PatternId[]): number[] {
  return pool.map((p) => {
    const s = stats.get(p);
    if (!s || s.seen === 0) return 3;
    const accuracy = (s.best + s.ok * 0.5) / s.seen;
    return 1 + Math.round(3 * (1 - accuracy));
  });
}

export class Learn {
  private readonly random: (n: number) => number;
  private readonly starts = new Map<number, number[]>();
  private readonly coachCalls = new Map<number, number[]>();
  private readonly inflight = new Map<number, Promise<CoachReply>>();

  constructor(private readonly d: LearnDeps) {
    this.random = d.random ?? ((n) => randomInt(0, n));
  }

  // ---- progress ---------------------------------------------------------------------------------------------------------------------

  private row(userId: number): ProgressRow {
    return this.d.db.get<ProgressRow>('SELECT tutorial_mask, xp, streak, best_streak, lessons_done FROM learn_progress WHERE user_id = ?', userId) ?? { tutorial_mask: 0, xp: 0, streak: 0, best_streak: 0, lessons_done: 0 };
  }

  progress(userId: number): LearnProgress {
    const r = this.row(userId);
    const level = levelOf(r.xp);
    return {
      xp: r.xp,
      level,
      title: titleOf(level),
      xpInLevel: r.xp % XP_PER_LEVEL,
      xpPerLevel: XP_PER_LEVEL,
      streak: r.streak,
      bestStreak: r.best_streak,
      lessonsDone: r.lessons_done,
      tutorialSteps: maskSteps(r.tutorial_mask),
      tutorialTotal: TUTORIAL_STEPS,
    };
  }

  private stats(userId: number): PatternStat[] {
    const rows = new Map(this.d.db.all<{ pattern: string; seen: number; best: number; ok: number; wrong: number }>('SELECT pattern, seen, best, ok, wrong FROM learn_pattern_stats WHERE user_id = ?', userId).map((r) => [r.pattern, r]));
    return STAT_KEYS.map((key) => {
      const r = rows.get(key);
      return { key, name: statName(key), seen: r?.seen ?? 0, best: r?.best ?? 0, ok: r?.ok ?? 0, wrong: r?.wrong ?? 0 };
    });
  }

  // ---- the AI's allowance -----------------------------------------------------------------------------------------------------------

  private day(): number {
    return Math.floor(this.d.now() / DAY_MS);
  }

  aiStatus(userId: number): AiStatus {
    const day = this.day();
    const used = this.d.db.get<{ calls: number }>('SELECT calls FROM learn_ai_usage WHERE day = ? AND user_id = ?', day, userId)?.calls ?? 0;
    const total = this.d.db.get<{ calls: number }>('SELECT calls FROM learn_ai_usage WHERE day = ? AND user_id = 0', day)?.calls ?? 0;
    return {
      enabled: this.d.ai !== null,
      perDay: this.d.perUserDaily,
      leftToday: this.d.ai === null ? 0 : Math.max(0, Math.min(this.d.perUserDaily - used, this.d.globalDaily - total)),
    };
  }

  // ---- state ------------------------------------------------------------------------------------------------------------------------

  state(me: User): LearnState {
    const open = this.openLesson(me.id);
    return { progress: this.progress(me.id), stats: this.stats(me.id), ai: this.aiStatus(me.id), open: open ? this.viewOf(open) : null };
  }

  // ---- the tutorial -----------------------------------------------------------------------------------------------------------------

  /** Marks a tutorial step as finished (the first time it gives XP). The questions are checked in the browser: this is only a bookmark. */
  tutorialDone(me: User, step: unknown): TutorialReply {
    if (typeof step !== 'number' || !Number.isInteger(step) || step < 1 || step > TUTORIAL_STEPS) throw new LearnError('bad_request', `The tutorial has steps 1 to ${TUTORIAL_STEPS}.`, 400);
    let gained = 0;
    this.d.db.tx(() => {
      const r = this.row(me.id);
      const bit = 2 ** (step - 1);
      const had = Math.floor(r.tutorial_mask / bit) % 2 === 1;
      if (had) return;
      gained = XP.tutorialStep;
      this.d.db.run(
        `INSERT INTO learn_progress(user_id, tutorial_mask, xp, updated_ms) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET tutorial_mask = tutorial_mask + ?, xp = xp + ?, updated_ms = excluded.updated_ms`,
        me.id,
        bit,
        gained,
        this.d.now(),
        bit,
        gained,
      );
    });
    return { progress: this.progress(me.id), xpGained: gained };
  }

  // ---- lessons ----------------------------------------------------------------------------------------------------------------------

  private openLesson(userId: number): LessonRow | undefined {
    return this.d.db.get<LessonRow>('SELECT * FROM learn_lessons WHERE user_id = ? AND answered_ms IS NULL AND skipped_ms IS NULL ORDER BY id DESC LIMIT 1', userId);
  }

  private lessonOf(userId: number, id: unknown): LessonRow {
    const lessonId = typeof id === 'number' && Number.isInteger(id) ? id : NaN;
    const row = Number.isNaN(lessonId) ? undefined : this.d.db.get<LessonRow>('SELECT * FROM learn_lessons WHERE id = ? AND user_id = ?', lessonId, userId);
    if (!row) throw new LearnError('no_such_lesson', 'There is no such lesson.', 404);
    return row;
  }

  private viewOf(row: LessonRow): LessonView {
    const s = JSON.parse(row.scenario) as Scenario;
    const options: LessonOptionView[] =
      s.kind === 'size'
        ? s.options.map((o) => ({ id: o.id, label: sizeLabel(o.fractionPct, o.leverage), detail: `$${Math.round(o.fractionPct * 10)} of your $1,000` }))
        : (['buy', 'short', 'wait'] as const).map((c) => ({ id: c, label: CHOICE_LABEL[c], detail: CHOICE_DETAIL[c] }));
    return { id: row.id, kind: s.kind, asset: s.asset, candles: s.visible, story: s.story, question: s.question, options };
  }

  private tooManyStarts(userId: number): boolean {
    const now = this.d.now();
    const list = (this.starts.get(userId) ?? []).filter((t) => t > now - 3_600_000);
    if (list.length >= LESSON_STARTS_PER_HOUR) {
      this.starts.set(userId, list);
      return true;
    }
    list.push(now);
    this.starts.set(userId, list);
    return false;
  }

  /** Which lesson comes next: sometimes a sizing lesson; otherwise a pattern, the ones he is weak at more often, never the same one twice in a row. */
  private chooseNext(userId: number): { kind: 'direction' | 'size'; pattern: PatternId } {
    const done = this.row(userId).lessons_done;
    const recent = this.d.db.all<{ kind: string; pattern: string }>('SELECT kind, pattern FROM learn_lessons WHERE user_id = ? ORDER BY id DESC LIMIT 2', userId);
    const lastWasSize = recent[0]?.kind === 'size';
    if (done >= SIZE_AFTER_LESSONS && !lastWasSize && this.random(100) < SIZE_CHANCE_PERCENT) return { kind: 'size', pattern: 'pullback-up' };
    const stats = new Map(this.stats(userId).map((s) => [s.key, s]));
    const avoid = new Set(recent.map((r) => r.pattern));
    let pool: PatternId[] = PATTERN_IDS.filter((p) => !avoid.has(p));
    if (pool.length === 0) pool = [...PATTERN_IDS];
    const weights = lessonWeights(stats, pool);
    const total = weights.reduce((a, b) => a + b, 0);
    let pick = this.random(total);
    for (let i = 0; i < pool.length; i += 1) {
      pick -= weights[i] as number;
      if (pick < 0) return { kind: 'direction', pattern: pool[i] as PatternId };
    }
    return { kind: 'direction', pattern: pool[pool.length - 1] as PatternId };
  }

  /** The lesson waiting for an answer, or a new one. */
  start(me: User): LessonView {
    const open = this.openLesson(me.id);
    if (open) return this.viewOf(open);
    if (this.tooManyStarts(me.id)) throw new LearnError('rate_limited', 'That is a lot of lessons in a short time. Take a short break and come back.', 429);
    const next = this.chooseNext(me.id);
    const seed = this.random(0x1_0000_0000);
    const scenario = generate(next.kind, next.pattern, seed);
    const key = statKeyOf(scenario);
    const id = Number(
      this.d.db.run('INSERT INTO learn_lessons(user_id, kind, pattern, seed, scenario, issued_ms) VALUES (?, ?, ?, ?, ?, ?)', me.id, scenario.kind, key, seed, JSON.stringify(scenario), this.d.now()).lastInsertRowid,
    );
    return this.viewOf(this.lessonOf(me.id, id));
  }

  /** Gives up the open lesson without an answer: no XP, no statistics, no streak change. */
  skip(me: User, lessonId: unknown): { ok: true } {
    const row = this.lessonOf(me.id, lessonId);
    if (row.answered_ms !== null || row.skipped_ms !== null) throw new LearnError('already_done', 'That lesson is already finished.', 409);
    this.d.db.run('UPDATE learn_lessons SET skipped_ms = ? WHERE id = ?', this.d.now(), row.id);
    return { ok: true };
  }

  /** Grades an answer (once), pays the XP and returns the whole lesson: the grade, what happened next and the teaching text. */
  answer(me: User, input: { lessonId: unknown; choice: unknown; reason: unknown }): LessonResult {
    const row = this.lessonOf(me.id, input.lessonId);
    if (row.answered_ms !== null || row.skipped_ms !== null) throw new LearnError('already_done', 'That lesson is already answered.', 409);
    const scenario = JSON.parse(row.scenario) as Scenario;
    const choice = typeof input.choice === 'string' ? input.choice : '';
    const grade = gradeOf(scenario, choice);
    if (grade === null) throw new LearnError('bad_request', 'That is not one of the choices.', 400);
    const reason = cleanReason(input.reason);
    const xpGained = XP[grade];
    const key = statKeyOf(scenario) as StatKey;
    this.d.db.tx(() => {
      const claimed = this.d.db.run('UPDATE learn_lessons SET answered_ms = ?, choice = ?, grade = ?, reason = ?, outcome_pct = ? WHERE id = ? AND answered_ms IS NULL AND skipped_ms IS NULL', this.d.now(), choice, grade, reason, scenario.outcomePct, row.id);
      if (claimed.changes !== 1) throw new LearnError('already_done', 'That lesson is already answered.', 409);
      const before = this.row(me.id);
      const streak = grade === 'wrong' ? 0 : before.streak + 1;
      this.d.db.run(
        `INSERT INTO learn_progress(user_id, xp, streak, best_streak, lessons_done, updated_ms) VALUES (?, ?, ?, ?, 1, ?)
         ON CONFLICT(user_id) DO UPDATE SET xp = xp + ?, streak = ?, best_streak = ?, lessons_done = lessons_done + 1, updated_ms = excluded.updated_ms`,
        me.id,
        xpGained,
        streak,
        Math.max(before.best_streak, streak),
        this.d.now(),
        xpGained,
        streak,
        Math.max(before.best_streak, streak),
      );
      this.d.db.run(
        `INSERT INTO learn_pattern_stats(user_id, pattern, seen, best, ok, wrong) VALUES (?, ?, 1, ?, ?, ?)
         ON CONFLICT(user_id, pattern) DO UPDATE SET seen = seen + 1, best = best + ?, ok = ok + ?, wrong = wrong + ?`,
        me.id,
        key,
        grade === 'best' ? 1 : 0,
        grade === 'ok' ? 1 : 0,
        grade === 'wrong' ? 1 : 0,
        grade === 'best' ? 1 : 0,
        grade === 'ok' ? 1 : 0,
        grade === 'wrong' ? 1 : 0,
      );
      // Only the newest lessons are kept; his XP and statistics stay.
      this.d.db.run('DELETE FROM learn_lessons WHERE user_id = ? AND id NOT IN (SELECT id FROM learn_lessons WHERE user_id = ? ORDER BY id DESC LIMIT ?)', me.id, me.id, LESSONS_KEPT);
    });
    const results = resultsOf(scenario);
    const coach = builtInCoach(scenario, choice, grade, results);
    return {
      lessonId: row.id,
      kind: scenario.kind,
      asset: scenario.asset,
      grade,
      chosen: choice,
      best: bestIdOf(scenario),
      patternName: scenario.kind === 'size' ? SIZING.name : PATTERNS[scenario.pattern].name,
      outcome: scenario.outcome,
      outcomePct: scenario.outcomePct,
      lines: scenario.lines,
      marks: scenario.marks,
      results,
      headline: coach.headline,
      sections: coach.sections,
      xpGained,
      progress: this.progress(me.id),
      ai: this.aiStatus(me.id),
      reason,
    };
  }

  // ---- the AI teacher ---------------------------------------------------------------------------------------------------------------

  private tooManyCoach(userId: number): boolean {
    const now = this.d.now();
    const list = (this.coachCalls.get(userId) ?? []).filter((t) => t > now - 60_000);
    if (list.length >= COACH_PER_MINUTE) {
      this.coachCalls.set(userId, list);
      return true;
    }
    list.push(now);
    this.coachCalls.set(userId, list);
    return false;
  }

  private spend(userId: number, by: 1 | -1): void {
    const day = this.day();
    for (const id of [userId, 0]) {
      this.d.db.run('INSERT INTO learn_ai_usage(day, user_id, calls) VALUES (?, ?, ?) ON CONFLICT(day, user_id) DO UPDATE SET calls = MAX(0, calls + ?)', day, id, Math.max(by, 0), by);
    }
  }

  /** The AI teacher's comment on an answered lesson (written once and kept). Never throws because of the AI: the answer says why there is no text. */
  async coach(me: User, lessonId: unknown): Promise<CoachReply> {
    const row = this.lessonOf(me.id, lessonId);
    if (row.answered_ms === null || row.choice === null || row.grade === null) throw new LearnError('not_answered', 'Answer the lesson first.', 409);
    if (row.coach_text !== null) return { text: row.coach_text, reason: 'ok', ai: this.aiStatus(me.id) };
    const ai = this.d.ai;
    if (ai === null) return { text: null, reason: 'off', ai: this.aiStatus(me.id) };
    const running = this.inflight.get(row.id);
    if (running) return running;
    const job = this.askAi(me, row, ai).finally(() => this.inflight.delete(row.id));
    this.inflight.set(row.id, job);
    return job;
  }

  private async askAi(me: User, row: LessonRow, ai: AiClient): Promise<CoachReply> {
    const status = this.aiStatus(me.id);
    if (status.leftToday <= 0 || this.tooManyCoach(me.id)) return { text: null, reason: 'limit', ai: status };
    this.spend(me.id, 1);
    try {
      const scenario = JSON.parse(row.scenario) as Scenario;
      const prompt = buildCoachPrompt({ scenario, choiceId: row.choice as string, grade: row.grade as Grade, results: resultsOf(scenario), reason: row.reason });
      const text = cleanCoachText(await ai.complete(prompt.system, prompt.user));
      if (text === null) throw new Error('empty answer');
      this.d.db.run('UPDATE learn_lessons SET coach_text = ?, coach_ms = ? WHERE id = ? AND coach_text IS NULL', text, this.d.now(), row.id);
      return { text, reason: 'ok', ai: this.aiStatus(me.id) };
    } catch (error) {
      // A failed comment does not use up the player's allowance. (The message holds no key and no answer text: see server/aiClient.ts.)
      this.spend(me.id, -1);
      this.d.log.warn('learn', `The AI teacher did not answer: ${error instanceof Error ? error.message : String(error)}`);
      return { text: null, reason: 'failed', ai: this.aiStatus(me.id) };
    }
  }
}
