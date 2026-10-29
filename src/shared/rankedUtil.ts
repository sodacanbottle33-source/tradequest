// The words of the ranked 1v1 screens (docs/world.md §31). The server decides every point; this only turns its answer into sentences. Display values are never fed back into calculations.
import { RANK_TIERS, tierIndexOf, tierOf } from '../world/rankedRules';
import { longUntil } from './goalUtil';
import type { Match, RankedView } from './types';

/** "+25 points", "−20 points", "No points moved". */
export function pointsChangeText(before: number, after: number): string {
  const d = after - before;
  if (d === 0) return 'No points moved';
  return `${d > 0 ? '+' : '−'}${Math.abs(d)} point${Math.abs(d) === 1 ? '' : 's'}`;
}

/** The tier a number of points is in, with its icon: "🥈 Silver". */
export function tierLabel(points: number): string {
  const t = tierOf(points);
  return `${t.icon} ${t.name}`;
}

/** Set when the points moved the player into a higher tier ("Silver"), otherwise null. (He can not fall a tier inside a season: the floor stops that.) */
export function tierReached(before: number, after: number): string | null {
  return tierIndexOf(after) > tierIndexOf(before) ? tierOf(after).name : null;
}

/** Why a finished or running match does not move points, or null when it does. */
export function notRankedReason(match: Pick<Match, 'ranked' | 'friendMatch' | 'players'>): string | null {
  if (match.ranked) return null;
  if (match.friendMatch) return 'a match against a friend';
  if (match.players.some((p) => p.bot && !p.you)) return 'a match against a computer player';
  return 'this match';
}

/** What the lobby says about the match before it starts. */
export function rankedTag(match: Pick<Match, 'ranked' | 'friendMatch' | 'players' | 'playerCount'>): string {
  const why = notRankedReason(match);
  if (why === null) return match.playerCount < 2 ? 'Ranked: points are at stake if a real player joins you' : 'Ranked: points are at stake';
  return `Not ranked: ${why} never moves points`;
}

/** "Season ends in 3 days 4 h". */
export function seasonEndText(view: Pick<RankedView, 'season'>, nowMs: number): string {
  return `Season ends ${longUntil(view.season.endMs, nowMs)}`;
}

/** How many points a player needs for the next tier, as a sentence ("75 more points for Silver"), or a line for the top tier. */
export function nextTierText(me: Pick<RankedView['me'], 'points' | 'next'>): string {
  if (!me.next) return 'You are in the top tier.';
  const need = me.next.floor - me.points;
  return `${need} more point${need === 1 ? '' : 's'} for ${me.next.name}`;
}

export const TIER_FLOORS: readonly number[] = RANK_TIERS.map((t) => t.floor);
