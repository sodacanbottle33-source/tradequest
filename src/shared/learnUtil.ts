// Small pure helpers for the Learn screens (no React), so tests can check them without a browser.

/** The step the tutorial opens on: the first one not done yet (1-based ids in `done`), or the first one when everything is done. Returns an index. */
export function firstOpenStep(done: readonly number[], total: number): number {
  const set = new Set(done);
  for (let i = 0; i < total; i += 1) if (!set.has(i + 1)) return i;
  return 0;
}

/** How many steps of the tutorial are done (only ids from 1 to `total` count). */
export function doneCount(done: readonly number[], total: number): number {
  return new Set(done.filter((n) => Number.isInteger(n) && n >= 1 && n <= total)).size;
}

/** The text on the tab or banner that sends a new player to the tutorial. */
export function tutorialLabel(done: readonly number[], total: number): string {
  const n = doneCount(done, total);
  if (n >= total) return 'Tutorial (done)';
  return n === 0 ? 'Tutorial' : `Tutorial (${n}/${total})`;
}

// ---- the Learn screen's small decisions ------------------------------------------------------------------------------------------

export type LearnView = 'lessons' | 'tutorial';

/** Which part opens first: the tutorial until the player has finished it or has started answering lessons; the lessons after that. */
export function defaultView(done: readonly number[], total: number, lessonsDone: number): LearnView {
  if (lessonsDone > 0) return 'lessons';
  return doneCount(done, total) >= total ? 'lessons' : 'tutorial';
}

/** The share of a pattern's lessons answered with the best or an acceptable move, as a whole percent; null before the first lesson. */
export function goodPercent(stat: { readonly seen: number; readonly best: number; readonly ok: number }): number | null {
  if (stat.seen <= 0) return null;
  return Math.round(((stat.best + stat.ok) * 100) / stat.seen);
}

/** "3 tries · 67 % good" or "not tried yet". */
export function statText(stat: { readonly seen: number; readonly best: number; readonly ok: number }): string {
  const p = goodPercent(stat);
  if (p === null) return 'not tried yet';
  return `${stat.seen} ${stat.seen === 1 ? 'try' : 'tries'} · ${p} % good`;
}

/** The weakest charts to name in the "come back to these" line: tried at least twice, under 60 % good, worst first (ties by name). At most three. */
export function weakSpots(stats: readonly { readonly name: string; readonly seen: number; readonly best: number; readonly ok: number }[]): string[] {
  return stats
    .map((s) => ({ name: s.name, seen: s.seen, p: goodPercent(s) }))
    .filter((s): s is { name: string; seen: number; p: number } => s.p !== null && s.seen >= 2 && s.p < 60)
    .sort((a, b) => a.p - b.p || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, 3)
    .map((s) => s.name);
}

/** Whether the "tell the teacher why" box may be offered: the AI is on and this player has comments left today. */
export function canExplain(ai: { readonly enabled: boolean; readonly leftToday: number }): boolean {
  return ai.enabled && ai.leftToday > 0;
}

/** What to say in the teacher's box when the server did not give a comment. */
export function coachNote(reason: 'ok' | 'off' | 'limit' | 'failed'): string | null {
  if (reason === 'limit') return "You have used today's AI comments. The notes above still explain this chart; the AI is back tomorrow.";
  if (reason === 'failed') return 'The AI teacher could not answer just now. The notes above still explain this chart.';
  return null;
}

/** How a grade is announced above the result. */
export function gradeBanner(grade: 'best' | 'ok' | 'wrong'): { readonly label: string; readonly tone: 'good' | 'fair' | 'bad' } {
  if (grade === 'best') return { label: 'Best move', tone: 'good' };
  if (grade === 'ok') return { label: 'Acceptable', tone: 'fair' };
  return { label: 'Not this time', tone: 'bad' };
}

/** "+10 XP" or "no XP this time". */
export function xpText(xp: number): string {
  return xp > 0 ? `+${xp} XP` : 'no XP this time';
}

// ---- remembered per browser (never needed; every read and write is guarded) ------------------------------------------------------

const WHY_KEY = 'tq-learn-why';
const SEEN_KEY = 'tq-learn-seen';

function read(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}
function write(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // storage is blocked or full: the page works the same without it
  }
}

/** Whether this browser chose to write a reason with each answer (default: no). */
export function readWhyPref(): boolean {
  return read(WHY_KEY) === 'on';
}
export function writeWhyPref(on: boolean): void {
  write(WHY_KEY, on ? 'on' : 'off');
}
/** Whether this browser has opened the Learn tab before (for the small "New" mark on the tab). */
export function learnSeen(): boolean {
  return read(SEEN_KEY) === 'yes';
}
export function markLearnSeen(): void {
  write(SEEN_KEY, 'yes');
}
