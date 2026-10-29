// The words and small sums of the Goals page, the "while you were away" card and the pop-up when a goal is paid (docs/world.md §32 and §33). The server decides what counts
// and what is paid; this only turns its answer into sentences. Display values are never fed back into calculations.
import { cosmeticById, type AnySlot } from './cosmeticCatalog';
import { formatCents, formatUntil } from './format';
import { goalById, rewardText } from './goalCatalog';
import type { ToastText } from './positionNotice';
import type { AwayReport, GoalsEvent, GoalsView, StreakView } from './types';

/** "+$12.00", "−$3.50", "$0.00". */
export function signedCents(cents: number): string {
  return `${cents > 0 ? '+' : cents < 0 ? '−' : ''}${formatCents(Math.abs(cents))}`;
}

/** "+4.50%", "−12.30%", "0.00%". */
export function signedPercent(pct: number): string {
  const text = `${Math.abs(pct).toFixed(2)}%`;
  return pct > 0 ? `+${text}` : pct < 0 ? `−${text}` : text;
}

/** How long a player was away: "35 minutes", "3 h 20 min", "2 days 4 h". */
export function awayText(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${Math.max(1, m)} minute${m === 1 ? '' : 's'}`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ${String(m % 60).padStart(2, '0')} min`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ${h % 24} h`;
}

/** "in 5 h 12 min", "in 40 min", "now"; from a day on: "in 3 days 4 h". */
export function longUntil(ms: number, nowMs: number): string {
  const left = ms - nowMs;
  if (left < 86_400_000) return formatUntil(ms, nowMs);
  const h = Math.floor(left / 3_600_000);
  const d = Math.floor(h / 24);
  return `in ${d} day${d === 1 ? '' : 's'} ${h % 24} h`;
}

/** A progress bar's width in percent, never outside 0 … 100. */
export function barPercent(progress: number, target: number): number {
  if (!(target > 0)) return 0;
  return Math.max(0, Math.min(100, Math.round((progress / target) * 100)));
}

/** How many things on the Goals page are waiting for the player: goals still open, and free looks ready to take (shown as a number on the tab). */
export function goalsWaiting(view: GoalsView | null): number {
  if (!view) return 0;
  return view.goals.filter((g) => !g.done).length + view.milestones.filter((m) => m.state === 'ready').length;
}

/** One sentence about the streak: what it is and what to do about it. */
export function streakNote(s: StreakView): string {
  if (s.current === 0) return s.lost ? `Your ${s.best}-day streak ended. Finish one goal today to start a new one.` : 'Finish one goal today to start a streak.';
  if (s.todayDone) return s.current === 1 ? 'Streak started. Come back tomorrow to make it 2.' : `${s.current} days in a row. Come back tomorrow to make it ${s.current + 1}.`;
  if (s.covers > 0) return `You missed ${s.covers === 1 ? 'a day' : `${s.covers} days`}. A freeze will cover ${s.covers === 1 ? 'it' : 'them'} when you finish a goal today.`;
  return `Finish one goal today to keep your ${s.current}-day streak.`;
}

/** The name of a look, for the Goals page. */
export function lookName(id: string | null): string {
  return (id ? cosmeticById(id)?.name : undefined) ?? 'a look';
}

/** The pop-up for a goal that was just paid. */
export function goalNotice(e: GoalsEvent): ToastText | null {
  if (e.finished.length === 0) return null;
  const titles = e.finished.map((id) => goalById(id)?.title ?? id).join(' · ');
  const title = e.bonus ? 'All 3 goals done!' : e.finished.length === 1 ? 'Goal done' : `${e.finished.length} goals done`;
  const parts = [`${titles}. You got ${rewardText(e.reward)}.`];
  if (e.streak > 0) parts.push(`Streak: ${e.streak} day${e.streak === 1 ? '' : 's'}.`);
  if (e.milestones.length > 0) parts.push(`A free look is waiting for you in Goals.`);
  return { tone: 'good', title, text: parts.join(' ') };
}

/** The lines of the "while you were away" card, in the order they are shown. Empty when nothing changed (the card then only says welcome back). */
export function awayLines(r: AwayReport): { key: string; tone: 'pos' | 'neg' | ''; text: string }[] {
  const out: { key: string; tone: 'pos' | 'neg' | ''; text: string }[] = [];
  if (r.netWorth) {
    const c = r.netWorth.changeCents;
    out.push({
      key: 'worth',
      tone: c > 0 ? 'pos' : c < 0 ? 'neg' : '',
      text: c === 0 ? `Your net worth stayed at ${formatCents(r.netWorth.nowCents)}.` : `Your net worth went ${c > 0 ? 'up' : 'down'} ${formatCents(Math.abs(c))} (${signedPercent(r.netWorth.changePct)}), to ${formatCents(r.netWorth.nowCents)}.`,
    });
  }
  if (r.rank) {
    const d = r.rank.before - r.rank.now;
    out.push({
      key: 'rank',
      tone: d > 0 ? 'pos' : d < 0 ? 'neg' : '',
      text: d === 0 ? `You are still number ${r.rank.now} on the leaderboard.` : `You ${d > 0 ? 'climbed' : 'dropped'} ${Math.abs(d)} place${Math.abs(d) === 1 ? '' : 's'} on the leaderboard: number ${r.rank.before} → number ${r.rank.now}.`,
    });
  }
  if (r.mover) {
    const m = r.mover;
    const gain = m.changeCents > 0;
    out.push({
      key: 'mover',
      tone: gain ? 'pos' : 'neg',
      text: `${m.ticker} moved your account the most: ${m.short ? 'your short ' : ''}${gain ? 'gained' : 'lost'} ${formatCents(Math.abs(m.changeCents))} (the price went ${m.short ? (m.changePct > 0 ? 'down' : 'up') : m.changePct > 0 ? 'up' : 'down'} ${Math.abs(m.changePct).toFixed(2)}%).`,
    });
  }
  return out;
}

/** The lines about the companies the player launched. */
export function awayCompanyLines(r: AwayReport): { key: string; tone: 'pos' | 'neg' | ''; text: string }[] {
  return r.companies.map((c) => {
    const bits: string[] = [];
    if (c.changePct !== null && Math.abs(c.changePct) >= 0.01) bits.push(`price ${signedPercent(c.changePct)}`);
    if (c.newInvestors > 0) bits.push(`${c.newInvestors} new investor${c.newInvestors === 1 ? '' : 's'}`);
    return { key: c.ticker, tone: c.changePct === null || Math.abs(c.changePct) < 0.01 ? '' : c.changePct > 0 ? 'pos' : 'neg', text: `${c.ticker} (${c.name}): ${bits.join(', ')}` };
  });
}

const KIND_NAMES: Record<AnySlot, string> = {
  color: 'Name colour',
  glow: 'Name glow',
  frame: 'Picture frame',
  title: 'Title',
  candles: 'Candle colours',
  shape: 'Candle shape',
  backdrop: 'Chart background',
  effect: 'Chart effect',
  win: 'Win style',
};

/** What kind of look a Shop thing is ("Name colour", "Win style"), for the free-look picker. */
export function kindName(slot: AnySlot): string {
  return KIND_NAMES[slot];
}
