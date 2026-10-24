// While a player's own 1v1 match is starting or running, Career is closed (docs/world.md §9.12): the server refuses new Career orders, and the page hides
// the Career button and its tabs so nothing in it can be tried. These are the page's small decisions about that, kept here so they can be tested.
import type { Mode } from '../ui/Header';
import type { Match } from './types';

/**
 * True while the player's match is in its countdown or live and he has not forfeited it. This is the same moment the server uses (`MatchService.inMatch`):
 * the lobby (waiting, or "Ready?") does not count, and a player who forfeited a match against a person gets Career back at once.
 */
export function careerLocked(match: Match | null | undefined): boolean {
  if (!match) return false;
  if (match.phase !== 'countdown' && match.phase !== 'live') return false;
  return match.players.find((p) => p.you)?.forfeited !== true;
}

/** Why the Career button is gone, said on the 1v1 screen while it is. */
export const CAREER_CLOSED_NOTE = 'Career is closed until the match is over, so Career money cannot move the prices this match is scored on.';

/** The mode to show: while Career is closed, a request for Career shows the 1v1 screen instead. */
export function modeShown(mode: Mode, locked: boolean): Mode {
  return locked && mode === 'career' ? 'battle' : mode;
}

/** The sections of the 1v1 screen: the same lists Career has, except Launch (nothing can be launched in a match). */
export type MatchTab = 'market' | 'coins' | 'earnings' | 'news';
export const MATCH_TABS: readonly (readonly [MatchTab, string])[] = [
  ['market', 'Market'],
  ['coins', 'Memecoins'],
  ['earnings', 'Earnings'],
  ['news', 'News'],
];

/**
 * The section that stays under a company page. A coin belongs to Memecoins and a stock to Market; a company opened from the Earnings or News section
 * keeps that section, so "Back" returns to where the player came from.
 */
export function tabAfterOpen(current: MatchTab, isCoin: boolean): MatchTab {
  if (current === 'earnings' || current === 'news') return current;
  return isCoin ? 'coins' : 'market';
}
