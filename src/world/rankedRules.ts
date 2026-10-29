// The rules of the ranked 1v1 ladder, as pure functions: which tier a number of points is, how many points a result moves, and where a new season starts.
// Nothing here touches a clock, a database or a random number, so the server, the tests and the screens all use exactly the same arithmetic.
// docs/world.md §31.
//
// The idea: a match against another real player (picked by the lobby, not agreed with a friend, not a bot) moves both players' points. A win gives points, a loss
// takes some away, a tie moves nothing. Beating a stronger player gives more; losing to a weaker one costs more. Points make five tiers. Once a player has reached a tier
// this season he cannot fall below the bottom of it ("the floor"), so one bad evening never throws him back to Bronze. Every Monday 00:00 Tokyo time a new season starts and
// everybody's points move halfway back to the starting points.

/** The five tiers. `floor` is the least number of points in the tier. */
export interface RankTier {
  readonly id: 'bronze' | 'silver' | 'gold' | 'platinum' | 'diamond';
  readonly name: string;
  readonly floor: number;
  /** One character (an emoji) drawn next to the name of the tier. */
  readonly icon: string;
}

export const RANK_TIERS: readonly RankTier[] = [
  { id: 'bronze', name: 'Bronze', floor: 0, icon: '🥉' },
  { id: 'silver', name: 'Silver', floor: 200, icon: '🥈' },
  { id: 'gold', name: 'Gold', floor: 400, icon: '🥇' },
  { id: 'platinum', name: 'Platinum', floor: 650, icon: '💠' },
  { id: 'diamond', name: 'Diamond', floor: 900, icon: '💎' },
];

/** A player's first ranked match starts from here (the middle of Bronze). */
export const RANK_START_POINTS = 100;
/** How far apart two players' points have to be before the stronger one is expected to win about 10 times out of 11. */
export const RANK_SCALE = 600;
/** A win between two equal players is worth this many points; a loss between equals costs LOSS_BASE. (The base is multiplied by how surprising the result was.) */
export const WIN_BASE = 25;
export const LOSS_BASE = 20;
/** Leaving a live match costs this much more than losing it. */
export const FORFEIT_EXTRA = 10;
/** A season needs at least this many ranked matches for a player to finish on the podium. */
export const SEASON_MIN_MATCHES = 5;
/** How many places are kept for each finished season. */
export const SEASON_PLACES = 10;
/** The same two players can earn points from each other this many times an hour, no more (so two friends cannot trade wins). */
export const PAIR_LIMIT = 3;
export const PAIR_WINDOW_MS = 3_600_000;

export type RankResult = 'win' | 'loss' | 'tie' | 'forfeit';

/** The index in RANK_TIERS (0 = Bronze … 4 = Diamond) that this many points is in. */
export function tierIndexOf(points: number): number {
  let at = 0;
  for (let i = 0; i < RANK_TIERS.length; i += 1) if (points >= (RANK_TIERS[i] as RankTier).floor) at = i;
  return at;
}

export function tierOf(points: number): RankTier {
  return RANK_TIERS[tierIndexOf(points)] as RankTier;
}

/** The tier above, or null in Diamond. */
export function nextTierOf(points: number): RankTier | null {
  return RANK_TIERS[tierIndexOf(points) + 1] ?? null;
}

export interface RankProgress {
  readonly tier: RankTier;
  readonly next: RankTier | null;
  /** Points above the bottom of the tier. */
  readonly into: number;
  /** Points from the bottom of this tier to the bottom of the next one (0 in Diamond). */
  readonly span: number;
  /** 0 … 1 across the tier (always 1 in Diamond). */
  readonly fraction: number;
}

export function progressOf(points: number): RankProgress {
  const tier = tierOf(points);
  const next = nextTierOf(points);
  const into = points - tier.floor;
  const span = next ? next.floor - tier.floor : 0;
  return { tier, next, into, span, fraction: next ? Math.max(0, Math.min(1, into / span)) : 1 };
}

/** How likely `mine` is to beat `theirs` (0 … 1), by the points alone. */
export function expectedScore(mine: number, theirs: number): number {
  return 1 / (1 + 10 ** ((theirs - mine) / RANK_SCALE));
}

/**
 * The points a result moves, before the floor. A win is worth 25 between equals (more against a stronger player, less against a weaker one: 13 … 38), a loss costs 20
 * between equals (10 … 30), a tie moves nothing, and a forfeit costs a loss plus FORFEIT_EXTRA.
 */
export function pointsDelta(result: RankResult, mine: number, theirs: number): number {
  const e = expectedScore(mine, theirs);
  switch (result) {
    case 'win':
      return Math.round(WIN_BASE * (1.5 - e));
    case 'loss':
      return -Math.round(LOSS_BASE * (0.5 + e));
    case 'forfeit':
      return -Math.round(LOSS_BASE * (0.5 + e)) - FORFEIT_EXTRA;
    default:
      return 0;
  }
}

export interface RankState {
  readonly points: number;
  /** The highest tier index reached this season (the floor is the bottom of it). */
  readonly peakTier: number;
}

/** The state after a change of `delta` points: never below the bottom of the highest tier reached this season. */
export function applyDelta(state: RankState, delta: number): RankState {
  const floor = (RANK_TIERS[state.peakTier] as RankTier).floor;
  const points = Math.max(floor, state.points + delta);
  return { points, peakTier: Math.max(state.peakTier, tierIndexOf(points)) };
}

/** Where a player starts the next season: halfway between his points and the starting points. */
export function seasonStartPoints(points: number): number {
  return Math.max(0, RANK_START_POINTS + Math.trunc((points - RANK_START_POINTS) / 2));
}

/** "Silver · 312 points" for the screens and messages. */
export function rankText(points: number): string {
  return `${tierOf(points).name} · ${points} points`;
}
