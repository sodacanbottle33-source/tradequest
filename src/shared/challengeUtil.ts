// Small pure helpers for the friend challenges: how long is left, in words. The server decides everything else (who may challenge whom,
// when a challenge runs out, whether the match can start); the page only counts down what the server said.
import type { ChallengeEntry } from './types';

/** "1:42": minutes and seconds left (never below 0:00). */
export function leftText(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** How much of a challenge is left now: what the server said when the list was received, minus the market ticks (seconds) since. */
export function msLeftNow(entry: ChallengeEntry, receivedTick: number, tick: number): number {
  return Math.max(0, entry.msLeft - Math.max(0, tick - receivedTick) * 1000);
}
