// The words and small decisions of the rematch button, the trophy room, teams, the daily prediction and market events (docs/world.md §35 to §39). The server decides everything
// (who may ask, what counts, who wins, what is paid); these only turn its answers into sentences. Plain functions, so they can be tested without drawing anything.
import { cosmeticById } from './cosmeticCatalog';
import { formatCents } from './format';
import { rewardText } from './goalCatalog';
import { signedPercent } from './goalUtil';
import type { ToastText } from './positionNotice';
import type { EarnedEvent, MarketEventLine, MarketEventPush, Match, PredictedEvent, PredictView, TrophyRoom } from './types';

// ---- rematch ----------------------------------------------------------------------------------------------------------------------

export type RematchState = 'none' | 'ask' | 'waiting' | 'asked';

/** What the rematch part of a result should show: nothing, an Ask button, "waiting for the other player" or "the other player asked, say yes". */
export function rematchState(m: Pick<Match, 'phase' | 'rematch'>, msLeft: number): RematchState {
  if (m.phase !== 'finished' || m.rematch === null || msLeft <= 0) return 'none';
  if (m.rematch.youAsked) return 'waiting';
  if (m.rematch.theyAsked) return 'asked';
  return 'ask';
}

/** "1:45" for the time left of an offer. */
export function offerClock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The sentence under the rematch button. */
export function rematchText(state: RematchState, otherName: string, ranked: boolean): string {
  switch (state) {
    case 'ask':
      return ranked ? `Play ${otherName} again. It counts for your ranked points, like any lobby match.` : `Play ${otherName} again. Nothing changes your ranked points: it is a friend match.`;
    case 'waiting':
      return `You asked. Waiting for ${otherName} to say yes.`;
    case 'asked':
      return `${otherName} wants a rematch. Press the button to say yes.`;
    default:
      return '';
  }
}

// ---- pop-ups -----------------------------------------------------------------------------------------------------------------------

/** The pop-up when looks he earned were just given to him. */
export function earnedNotice(e: EarnedEvent): ToastText | null {
  const names = e.items.map((i) => cosmeticById(i.id)?.name ?? i.name).filter((n) => n !== '');
  if (names.length === 0) return null;
  return { tone: 'good', title: names.length === 1 ? 'New look earned' : `${names.length} new looks earned`, text: `${names.join(' · ')} (${e.reason}). Put ${names.length === 1 ? 'it' : 'them'} on in the Shop.` };
}

/** The pop-up when one of his daily guesses was judged. */
export function predictedNotice(e: PredictedEvent): ToastText {
  const pick = e.pick === 'up' ? 'higher' : 'lower';
  if (e.result === 'win') return { tone: 'good', title: 'Right guess!', text: `${e.ticker} ended ${pick}, as you said.${e.reward ? ` You got ${rewardText(e.reward)}.` : ''}` };
  if (e.result === 'loss') return { tone: 'neutral', title: 'Not this time', text: `${e.ticker} did not end ${pick}. A wrong guess costs nothing. Try again today.` };
  return { tone: 'neutral', title: 'A draw', text: `${e.ticker} ended where it began (or the day could not be judged). Nothing was paid and your record did not change.` };
}

/** The pop-up when a market event starts. */
export function marketEventNotice(e: MarketEventPush): ToastText {
  return { tone: 'neutral', title: `${e.icon} ${e.name}`, text: `${e.blurb} Check the News and the Market page.` };
}

// ---- the daily prediction ----------------------------------------------------------------------------------------------------------

/** "Higher" or "Lower". */
export function pickName(pick: 'up' | 'down'): string {
  return pick === 'up' ? 'Higher' : 'Lower';
}

/** The sentence about how yesterday's guess went. */
export function lastGuessText(last: NonNullable<PredictView['last']>): string {
  const guess = `You said ${last.ticker} would end ${last.pick === 'up' ? 'higher' : 'lower'}.`;
  const move = last.priceToCents === null ? '' : ` It went from ${formatCents(last.priceFromCents)} to ${formatCents(last.priceToCents)}.`;
  if (last.result === 'win') return `${guess}${move} Right!`;
  if (last.result === 'loss') return `${guess}${move} Not this time.`;
  return `${guess}${move} A draw: nothing was paid.`;
}

/** The record line: "5 right out of 8 (62%), best run 3". */
export function recordText(s: PredictView['stats']): string {
  if (s.made === 0) return 'No judged guesses yet.';
  const pct = Math.round((s.correct / s.made) * 100);
  return `${s.correct} right out of ${s.made} (${pct}%) · best run ${s.bestRun}`;
}

// ---- market events -----------------------------------------------------------------------------------------------------------------

/** "21:00" in Tokyo time, for the time an event starts (the game runs on Tokyo days). */
export function eventClock(atMs: number): string {
  const d = new Date(atMs + 9 * 3_600_000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/** The headline moves of an event as short text: "+8.2% ACME". Largest moves first, at most `n`. */
export function movesText(line: Pick<MarketEventLine, 'moves'>, n = 4): string {
  return [...line.moves]
    .sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct))
    .slice(0, n)
    .map((m) => `${signedPercent(m.pct)} ${m.ticker}`)
    .join(' · ');
}

// ---- the trophy room ---------------------------------------------------------------------------------------------------------------

/** "1st", "2nd", "3rd", "7th". */
export function placeText(place: number): string {
  const mod100 = place % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${place}th`;
  switch (place % 10) {
    case 1:
      return `${place}st`;
    case 2:
      return `${place}nd`;
    case 3:
      return `${place}rd`;
    default:
      return `${place}th`;
  }
}

/** "5 Oct" for the start of a week or a season. */
export function shortDay(ms: number): string {
  return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/** The lines of a trophy room, in the order they are shown. Only things he has; an empty room gives an empty list. */
export function trophyLines(t: TrophyRoom): { key: string; icon: string; text: string }[] {
  const out: { key: string; icon: string; text: string }[] = [];
  if (t.ranked.bestTier && t.ranked.bestTier.id !== 'bronze') out.push({ key: 'tier', icon: t.ranked.bestTier.icon, text: `Reached ${t.ranked.bestTier.name} in ranked 1v1` });
  for (const s of t.ranked.seasons.filter((x) => x.place <= 3)) out.push({ key: `season-${s.seasonMs}`, icon: s.place === 1 ? '🏆' : '🎖️', text: `${placeText(s.place)} in the ranked season of ${shortDay(s.seasonMs)}` });
  for (const w of t.weekly.podiums) out.push({ key: `week-${w.weekStartMs}`, icon: w.place === 1 ? '👑' : '📊', text: `${placeText(w.place)} on the weekly board, week of ${shortDay(w.weekStartMs)} (${signedPercent(w.gainPct)})` });
  for (const w of t.teamWins) out.push({ key: `team-${w.weekStartMs}`, icon: w.place === 1 ? '🛡️' : '🤝', text: `${placeText(w.place)} in the team race with ${w.teamName} [${w.teamTag}], week of ${shortDay(w.weekStartMs)}` });
  return out;
}

/** The small facts under the trophies. */
export function trophyFacts(t: TrophyRoom): { key: string; label: string; value: string }[] {
  const winPct = t.matches.played === 0 ? '—' : `${Math.round((t.matches.wins / t.matches.played) * 100)}%`;
  return [
    { key: 'matches', label: '1v1 wins', value: `${t.matches.wins} of ${t.matches.played} (${winPct})` },
    { key: 'goals', label: 'Daily goals', value: `${t.goals.finished} done · ${t.goals.perfectDays} perfect days` },
    { key: 'streak', label: 'Best streak', value: `${t.goals.bestStreak} day${t.goals.bestStreak === 1 ? '' : 's'}` },
    { key: 'predict', label: 'Predictions', value: t.predictions.made === 0 ? '—' : `${t.predictions.correct} of ${t.predictions.made} right · best run ${t.predictions.bestRun}` },
    { key: 'lessons', label: 'Lessons', value: String(t.lessons) },
    { key: 'badges', label: 'Badges', value: `${t.badges.earned} of ${t.badges.total}` },
  ];
}

// ---- teams -------------------------------------------------------------------------------------------------------------------------

/** "+4.20%" for a team's score, or why it has none. */
export function teamScoreText(scorePct: number | null, scored: number, minScored: number): string {
  if (scorePct !== null) return signedPercent(scorePct);
  const need = Math.max(0, minScored - scored);
  return need === 0 ? '—' : `needs ${need} more player${need === 1 ? '' : 's'} on the weekly board`;
}
