// MR — who wins a 1v1 match and what each player is paid. Pure functions (docs/world.md §9).
import { describe, expect, it } from 'vitest';
import { COUNTDOWN_TICKS, FORFEIT_REWARD_CENTS, LOSER_REWARD_CENTS, MATCH_CASH_CENTS, MATCH_TICKS, decideMatch, matchStartTick, profitOf } from '../src/world';

const a = (value: number, forfeited = false) => ({ userId: 1, finalValueCents: value, forfeited });
const b = (value: number, forfeited = false) => ({ userId: 2, finalValueCents: value, forfeited });

describe('constants', () => {
  it('a match is exactly 180 ticks (3 minutes of 1-second ticks) with $1,000 and a $50 loser reward', () => {
    expect(MATCH_TICKS).toBe(180);
    expect(MATCH_CASH_CENTS).toBe(100_000);
    expect(LOSER_REWARD_CENTS).toBe(5_000);
    expect(FORFEIT_REWARD_CENTS).toBe(0);
  });
});

describe('profit', () => {
  it('is final value minus the $1,000 start', () => {
    expect(profitOf(100_000)).toBe(0);
    expect(profitOf(123_456)).toBe(23_456);
    expect(profitOf(90_000)).toBe(-10_000);
  });
});

describe('winner and rewards', () => {
  it('the greater profit wins and is paid that profit (when it is more than $50); the loser is paid $50', () => {
    const v = decideMatch(a(130_000), b(105_000));
    expect(v.outcome).toBe('win');
    expect(v.winnerUserId).toBe(1);
    expect(v.players[0]).toMatchObject({ userId: 1, profitCents: 30_000, result: 'win', rewardCents: 30_000 });
    expect(v.players[1]).toMatchObject({ userId: 2, profitCents: 5_000, result: 'loss', rewardCents: 5_000 });
  });

  it('works the same with the players the other way round', () => {
    const v = decideMatch(a(95_000), b(101_234));
    expect(v.winnerUserId).toBe(2);
    expect(v.players[1]).toMatchObject({ result: 'win', profitCents: 1_234, rewardCents: 5_000 }); // a $12.34 win still pays the $50 minimum
    expect(v.players[0]).toMatchObject({ result: 'loss', rewardCents: 5_000, profitCents: -5_000 });
  });

  it('a winner who still lost money is paid the $50 minimum, the same as the loser', () => {
    const v = decideMatch(a(98_000), b(90_000));
    expect(v.winnerUserId).toBe(1);
    expect(v.players[0]).toMatchObject({ result: 'win', profitCents: -2_000, rewardCents: 5_000 });
    expect(v.players[1]).toMatchObject({ result: 'loss', rewardCents: 5_000 });
  });

  it('exactly equal profit (to the cent) is a tie: no winner and both are paid $50', () => {
    const v = decideMatch(a(112_345), b(112_345));
    expect(v.outcome).toBe('tie');
    expect(v.winnerUserId).toBeNull();
    expect(v.players.map((p) => p.result)).toEqual(['tie', 'tie']);
    expect(v.players.map((p) => p.rewardCents)).toEqual([5_000, 5_000]);
  });

  it('two players who never trade tie', () => {
    expect(decideMatch(a(100_000), b(100_000)).outcome).toBe('tie');
  });

  it('one cent more is enough to win', () => {
    expect(decideMatch(a(100_001), b(100_000)).winnerUserId).toBe(1);
  });
});

describe('a win never pays less than a loss', () => {
  it('for every pair of results the winner is paid at least what the loser is paid', () => {
    for (let x = 80_000; x <= 140_000; x += 2_500) {
      for (let y = 80_000; y <= 140_000; y += 3_100) {
        const v = decideMatch(a(x), b(y));
        if (v.outcome !== 'win') continue;
        const win = v.players.find((p) => p.result === 'win');
        const loss = v.players.find((p) => p.result === 'loss');
        expect(win!.rewardCents).toBeGreaterThanOrEqual(loss!.rewardCents);
        expect(win!.rewardCents).toBe(Math.max(win!.profitCents, 5_000));
      }
    }
  });
});

describe('leaving a live match', () => {
  it('the player who left loses and is paid nothing; the other wins even if they are behind in profit', () => {
    const v = decideMatch(a(150_000, true), b(101_000));
    expect(v.outcome).toBe('forfeit');
    expect(v.winnerUserId).toBe(2);
    expect(v.players[0]).toMatchObject({ result: 'forfeit', rewardCents: 0 });
    expect(v.players[1]).toMatchObject({ result: 'win', profitCents: 1_000, rewardCents: 5_000 });
  });

  it('a winner by forfeit with a loss is paid the $50 minimum (the forfeiter still gets nothing)', () => {
    const v = decideMatch(a(80_000), b(70_000, true));
    expect(v.winnerUserId).toBe(1);
    expect(v.players[0]).toMatchObject({ result: 'win', rewardCents: 5_000 });
    expect(v.players[1]).toMatchObject({ result: 'forfeit', rewardCents: 0 });
  });

  it('if both leave the match is abandoned: no winner, no pay', () => {
    const v = decideMatch(a(130_000, true), b(70_000, true));
    expect(v.outcome).toBe('abandoned');
    expect(v.winnerUserId).toBeNull();
    expect(v.players.map((p) => p.rewardCents)).toEqual([0, 0]);
  });
});

describe('guards', () => {
  it('refuses a match of one player against themselves', () => {
    expect(() => decideMatch({ userId: 1, finalValueCents: 1, forfeited: false }, { userId: 1, finalValueCents: 2, forfeited: false })).toThrow(/two different/);
  });

  it('the paid amounts never depend on the order the players are given in', () => {
    for (const [x, y] of [[120_000, 90_000], [100_000, 100_000], [99_999, 100_001]] as const) {
      const v1 = decideMatch(a(x), b(y));
      const v2 = decideMatch(b(y), a(x));
      const byId = (v: typeof v1) => Object.fromEntries(v.players.map((p) => [p.userId, [p.result, p.rewardCents]]));
      expect(byId(v2)).toEqual(byId(v1));
    }
  });
});

describe('the start of a match', () => {
  it('is on a 10-tick boundary at least the countdown away', () => {
    for (let t = 1000; t < 1040; t += 1) {
      const s = matchStartTick(t);
      expect(s % 10).toBe(0);
      expect(s - t).toBeGreaterThanOrEqual(COUNTDOWN_TICKS);
      expect(s - t).toBeLessThan(COUNTDOWN_TICKS + 10);
    }
  });
});
