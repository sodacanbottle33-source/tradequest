// The rules of a 1v1 match, as pure functions: who wins and what each player is paid. Nothing here touches a clock, a
// database or a random number, so the server and the tests (and later the screen) all use exactly the same decision.
// docs/world.md §9.

import { MATCH_TICKS } from './params';

export { MATCH_TICKS };

/** Every player starts a match with exactly this much match cash, whatever their Career account holds. */
export const MATCH_CASH_CENTS = 100_000; // $1,000.00
/** What the loser — and each player of a tie — is paid in virtual currency. It is also the least a winner is paid. */
export const LOSER_REWARD_CENTS = 5_000; // $50.00
/** A player who forfeits (leaves a live match) is paid nothing. */
export const FORFEIT_REWARD_CENTS = 0;
/** The countdown between "both ready" and the first tradable tick. The start is moved to the next 10-tick boundary. */
export const COUNTDOWN_TICKS = 10;
/** A player in a lobby who has not been heard from for this long has disconnected and is removed before the match starts. */
export const PRESENCE_MS = 15_000;

export type MatchOutcome = 'win' | 'tie' | 'forfeit' | 'abandoned';
export type PlayerResult = 'win' | 'loss' | 'tie' | 'forfeit';

export interface Competitor {
  readonly userId: number;
  /** Cash plus the market value of all shares at the final tick, in cents. */
  readonly finalValueCents: number;
  /** True if the player left the match while it was running. */
  readonly forfeited: boolean;
}

export interface PlayerVerdict {
  readonly userId: number;
  readonly profitCents: number;
  readonly result: PlayerResult;
  /** Virtual currency paid for this match, in cents. */
  readonly rewardCents: number;
}

export interface Verdict {
  readonly outcome: MatchOutcome;
  readonly winnerUserId: number | null;
  readonly players: readonly [PlayerVerdict, PlayerVerdict];
}

/** A winner is paid their profit, but never less than the loser's consolation reward (so winning can never pay less than losing). */
export function winnerReward(profitCents: number): number {
  return Math.max(profitCents, LOSER_REWARD_CENTS);
}

export function profitOf(finalValueCents: number, startCashCents: number = MATCH_CASH_CENTS): number {
  return finalValueCents - startCashCents;
}

/**
 *  • One player forfeited: the other wins (even with a loss) and the forfeiter is paid nothing.
 *  • Both forfeited: the match is abandoned, nobody wins, nobody is paid.
 *  • Otherwise the greater profit wins. The winner is paid their profit or $50, whichever is more (`winnerReward`); the
 *    loser $50. Exactly equal profit (to the cent) is a tie: nobody wins and both are paid $50.
 */
export function decideMatch(a: Competitor, b: Competitor, startCashCents: number = MATCH_CASH_CENTS): Verdict {
  if (a.userId === b.userId) throw new Error('A match needs two different players.');
  const pa = profitOf(a.finalValueCents, startCashCents);
  const pb = profitOf(b.finalValueCents, startCashCents);
  const make = (c: Competitor, profit: number, result: PlayerResult, reward: number): PlayerVerdict => ({ userId: c.userId, profitCents: profit, result, rewardCents: reward });
  if (a.forfeited && b.forfeited) {
    return { outcome: 'abandoned', winnerUserId: null, players: [make(a, pa, 'forfeit', FORFEIT_REWARD_CENTS), make(b, pb, 'forfeit', FORFEIT_REWARD_CENTS)] };
  }
  if (a.forfeited || b.forfeited) {
    const winner = a.forfeited ? b : a;
    const verdictOf = (c: Competitor, profit: number): PlayerVerdict => (c.userId === winner.userId ? make(c, profit, 'win', winnerReward(profit)) : make(c, profit, 'forfeit', FORFEIT_REWARD_CENTS));
    return { outcome: 'forfeit', winnerUserId: winner.userId, players: [verdictOf(a, pa), verdictOf(b, pb)] };
  }
  if (pa === pb) {
    return { outcome: 'tie', winnerUserId: null, players: [make(a, pa, 'tie', LOSER_REWARD_CENTS), make(b, pb, 'tie', LOSER_REWARD_CENTS)] };
  }
  const aWins = pa > pb;
  return {
    outcome: 'win',
    winnerUserId: aWins ? a.userId : b.userId,
    players: [
      aWins ? make(a, pa, 'win', winnerReward(pa)) : make(a, pa, 'loss', LOSER_REWARD_CENTS),
      aWins ? make(b, pb, 'loss', LOSER_REWARD_CENTS) : make(b, pb, 'win', winnerReward(pb)),
    ],
  };
}

/** First tick at which a match whose countdown begins at `tick` becomes tradable: a multiple of 10, at least COUNTDOWN_TICKS away. */
export function matchStartTick(tick: number): number {
  return Math.ceil((tick + COUNTDOWN_TICKS) / 10) * 10;
}
