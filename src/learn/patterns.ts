// The chart patterns of the practice lessons (docs/world.md §19.2) and everything the game itself says about each one. The "textbook answer" of a
// pattern is fixed here, in plain code: a lesson's grade never depends on an AI. The AI teacher only talks about an answer that is already graded.

import type { Choice, PatternId, StatKey } from './types';

export interface PatternDef {
  readonly id: PatternId;
  readonly name: string;
  readonly assetKind: 'stock' | 'coin';
  /** Where the price usually goes after the pattern: 1 up, -1 down, 0 nowhere in particular. */
  readonly dir: 1 | -1 | 0;
  readonly best: Choice;
  /** Choices that are acceptable but not the best. */
  readonly ok: readonly Choice[];
  /** The chance (in percent) that the price does what the pattern says; the rest of the time it does the opposite. */
  readonly followPercent: number;
  /** The size of the move after the pattern, in percent: when it follows and when it does not (low, high). */
  readonly followMove: readonly [number, number];
  readonly failMove: readonly [number, number];
  readonly look: string;
  readonly plan: string;
  readonly why: string;
  readonly mistake: string;
  readonly stopHint: string;
  /** Why each other choice is worse. The entry for the best choice is not used. */
  readonly otherWhy: Readonly<Record<Choice, string>>;
}

export const PATTERNS: Readonly<Record<PatternId, PatternDef>> = {
  'pullback-up': {
    id: 'pullback-up',
    name: 'A dip in an uptrend',
    assetKind: 'stock',
    dir: 1,
    best: 'buy',
    ok: ['wait'],
    followPercent: 70,
    followMove: [4, 9],
    failMove: [3, 7],
    look: 'The price keeps making higher highs and higher lows. Now it dipped a little and is turning back up.',
    plan: 'Buy the dip. Put a stop-loss just under the last low, so that a wrong guess stays small.',
    why: 'In an uptrend the buyers are in control. A small dip is often just a rest before the next climb.',
    mistake: 'Selling or shorting only because the price dipped. A dip inside a trend is usually not the end of the trend.',
    stopHint: 'The stop-loss goes a little under the last low.',
    otherWhy: {
      buy: '',
      short: 'You would be betting against a trend that is still going up. A short works better after the trend has really broken.',
      wait: 'Waiting is safe, but a clear uptrend with a small dip is exactly the place where buying has the best odds.',
    },
  },
  'bounce-down': {
    id: 'bounce-down',
    name: 'A weak bounce in a downtrend',
    assetKind: 'stock',
    dir: -1,
    best: 'short',
    ok: ['wait'],
    followPercent: 70,
    followMove: [4, 9],
    failMove: [3, 7],
    look: 'The price keeps making lower highs and lower lows. It bounced up a little but the bounce is running out of steam.',
    plan: 'Short the bounce. Put a stop-loss just above the last high.',
    why: 'In a downtrend the sellers are in control. Small bounces tend to fade, and then the fall goes on.',
    mistake: 'Buying because the price "looks cheap". A falling price can keep falling.',
    stopHint: 'The stop-loss goes a little above the last high.',
    otherWhy: {
      short: '',
      buy: 'You would be buying in a trend that is still going down. Cheap can get a lot cheaper.',
      wait: 'Waiting is safe, but a clear downtrend with a weak bounce is a good place for a short.',
    },
  },
  'double-top': {
    id: 'double-top',
    name: 'Double top',
    assetKind: 'stock',
    dir: -1,
    best: 'short',
    ok: ['wait'],
    followPercent: 70,
    followMove: [4, 9],
    failMove: [3, 7],
    look: 'The price climbed to a high, fell back, climbed to about the same high again and failed there. Now it is falling away from the second peak.',
    plan: 'Short, with a stop-loss just above the two peaks.',
    why: 'The buyers tried twice to get through the same level and could not. When they give up, the price often drops.',
    mistake: 'Buying near the top because "it went up before". Twice the sellers won at that level.',
    stopHint: 'The stop-loss goes a little above the two peaks.',
    otherWhy: {
      short: '',
      buy: 'The price just failed twice at this level. Buying here means buying exactly where the sellers have won twice.',
      wait: 'Waiting is safe, but this pattern, once the price turns down from the second peak, is a classic place for a short.',
    },
  },
  'double-bottom': {
    id: 'double-bottom',
    name: 'Double bottom',
    assetKind: 'stock',
    dir: 1,
    best: 'buy',
    ok: ['wait'],
    followPercent: 70,
    followMove: [4, 9],
    failMove: [3, 7],
    look: 'The price fell to a low, bounced, fell to about the same low again and held. Now it is moving up from the second low.',
    plan: 'Buy, with a stop-loss just under the two lows.',
    why: 'The sellers tried twice to push lower and could not. When they give up, the price often climbs.',
    mistake: 'Shorting because "it was falling". Twice the buyers defended the same level.',
    stopHint: 'The stop-loss goes a little under the two lows.',
    otherWhy: {
      buy: '',
      short: 'The price just held twice at this level. Shorting here means betting against buyers who have won twice.',
      wait: 'Waiting is safe, but once the price turns up from the second low this pattern is a classic place to buy.',
    },
  },
  'range-top': {
    id: 'range-top',
    name: 'The top of a range',
    assetKind: 'stock',
    dir: -1,
    best: 'short',
    ok: ['wait'],
    followPercent: 70,
    followMove: [3, 6],
    failMove: [3, 7],
    look: 'The price has been bouncing between a floor and a ceiling for a long time. Now it is touching the ceiling again.',
    plan: 'Short near the ceiling with a stop-loss just above it. Waiting for a break is also fine.',
    why: 'Inside a range the price keeps turning around at the same edges. At the ceiling the sellers have won every time so far.',
    mistake: 'Buying at the ceiling in the hope that it breaks through. It can, but most touches bounce back.',
    stopHint: 'The stop-loss goes a little above the ceiling.',
    otherWhy: {
      short: '',
      buy: 'You would be buying at the highest price of the range, where every earlier touch turned back down.',
      wait: 'Waiting is safe. A short at the ceiling has better odds, as long as you keep the stop-loss close.',
    },
  },
  'range-bottom': {
    id: 'range-bottom',
    name: 'The bottom of a range',
    assetKind: 'stock',
    dir: 1,
    best: 'buy',
    ok: ['wait'],
    followPercent: 70,
    followMove: [3, 6],
    failMove: [3, 7],
    look: 'The price has been bouncing between a floor and a ceiling for a long time. Now it is touching the floor again.',
    plan: 'Buy near the floor with a stop-loss just under it. Waiting for a break is also fine.',
    why: 'Inside a range the price keeps turning around at the same edges. At the floor the buyers have won every time so far.',
    mistake: 'Shorting at the floor in the hope that it breaks down. It can, but most touches bounce back.',
    stopHint: 'The stop-loss goes a little under the floor.',
    otherWhy: {
      buy: '',
      short: 'You would be selling at the lowest price of the range, where every earlier touch turned back up.',
      wait: 'Waiting is safe. A buy at the floor has better odds, as long as you keep the stop-loss close.',
    },
  },
  breakout: {
    id: 'breakout',
    name: 'Breakout above a ceiling',
    assetKind: 'stock',
    dir: 1,
    best: 'buy',
    ok: ['wait'],
    followPercent: 70,
    followMove: [4, 9],
    failMove: [3, 7],
    look: 'The price kept hitting the same ceiling and falling back. Now it has closed above it.',
    plan: 'Buy, with a stop-loss back under the old ceiling.',
    why: 'A ceiling that was hit many times held many sellers. When the price gets through, those sellers are gone and buyers pile in.',
    mistake: 'Shorting because "it was always rejected here". This time it was not.',
    stopHint: 'The stop-loss goes a little under the old ceiling. If the price falls back below it, the breakout failed.',
    otherWhy: {
      buy: '',
      short: 'The price just beat a level that held for a long time. Betting against that is fighting the move.',
      wait: 'Waiting is safe, but a clean breakout is a good place to act, with the stop-loss just under the old ceiling.',
    },
  },
  breakdown: {
    id: 'breakdown',
    name: 'Breakdown below a floor',
    assetKind: 'stock',
    dir: -1,
    best: 'short',
    ok: ['wait'],
    followPercent: 70,
    followMove: [4, 9],
    failMove: [3, 7],
    look: 'The price kept hitting the same floor and bouncing. Now it has closed below it.',
    plan: 'Short, with a stop-loss back above the old floor.',
    why: 'A floor that was tested many times held many buyers. When the price falls through, those buyers are gone and sellers rush in.',
    mistake: 'Buying because "it always bounced here". This time it did not.',
    stopHint: 'The stop-loss goes a little above the old floor. If the price climbs back over it, the breakdown failed.',
    otherWhy: {
      short: '',
      buy: 'The price just lost a level that held for a long time. Buying into that is catching a falling knife.',
      wait: 'Waiting is safe, but a clean breakdown is a good place to act, with the stop-loss just above the old floor.',
    },
  },
  'head-shoulders': {
    id: 'head-shoulders',
    name: 'Head and shoulders',
    assetKind: 'stock',
    dir: -1,
    best: 'short',
    ok: ['wait'],
    followPercent: 70,
    followMove: [5, 10],
    failMove: [3, 7],
    look: 'Three peaks: a middle peak (the head) higher than the one on each side (the shoulders). The price has just fallen below the line that joins the dips between them (the neckline).',
    plan: 'Short after the price breaks the neckline, with a stop-loss above the right shoulder.',
    why: 'Each climb ended lower than the head, so the buyers are getting weaker. Falling through the neckline confirms it.',
    mistake: 'Buying the "dip" under the neckline. That dip is the pattern doing its work.',
    stopHint: 'The stop-loss goes a little above the right shoulder.',
    otherWhy: {
      short: '',
      buy: 'The buyers just failed to make a new high and the price broke its neckline. Buying here goes against what the chart is telling you.',
      wait: 'Waiting is safe, but a break of the neckline is the signal this pattern is known for.',
    },
  },
  'pump-fade': {
    id: 'pump-fade',
    name: 'A spike that may fade',
    assetKind: 'coin',
    dir: -1,
    best: 'wait',
    ok: ['short'],
    followPercent: 70,
    followMove: [12, 25],
    failMove: [8, 18],
    look: 'A memecoin that was flat shot up in just a few candles, with long wicks on top, and the latest candles are red.',
    plan: 'Do not chase it. Wait. A short can work, but then keep it small and put the stop-loss above the spike.',
    why: 'Spikes like this are made of excitement, and excitement ends fast. But nobody can guess the exact top, and a spike can run further than you think.',
    mistake: 'Buying because you are afraid of missing out. The people who bought early are the ones who want to sell to you.',
    stopHint: 'If you short, the stop-loss goes above the top of the spike.',
    otherWhy: {
      wait: '',
      buy: 'You would be buying after the big jump, right where the early buyers want to sell. That is the classic way to lose money on a coin.',
      short: 'A fade is likely, but a spike can keep going. A short is acceptable only with a small size and a stop-loss. Waiting is safer.',
    },
  },
  choppy: {
    id: 'choppy',
    name: 'No clear pattern',
    assetKind: 'stock',
    dir: 0,
    best: 'wait',
    ok: [],
    followPercent: 50,
    followMove: [2, 4],
    failMove: [2, 4],
    look: 'The price goes up and down with no clear trend, no ceiling and no floor.',
    plan: 'Wait. When there is no reason to be in a trade, the best trade is no trade.',
    why: 'Without a pattern you are only guessing, and the fees and the gap make guessing cost money.',
    mistake: 'Feeling that you must always be in a trade.',
    stopHint: 'No trade, no stop-loss needed.',
    otherWhy: {
      wait: '',
      buy: 'There was nothing in this chart to lean on. A buy here is a guess, and a guess pays fees.',
      short: 'There was nothing in this chart to lean on. A short here is a guess, and a guess pays fees.',
    },
  },
};

export const PATTERN_LIST: readonly PatternDef[] = Object.values(PATTERNS);

/** The sizing lesson is not a chart pattern: its texts live here. */
export const SIZING = {
  name: 'How much to risk',
  look: 'A clear trend, and you have already decided which way to trade. The question is how big to make the trade.',
  plan: 'Put only a small slice of your cash on the idea and keep the leverage low, so that a normal wiggle against you cannot wipe you out.',
  why: 'Even a good idea gets shaken first: the price often goes against you for a while before it goes your way. A small, low-leverage trade survives the shake. A big, high-leverage trade is closed by the market before the idea has time to work.',
  mistake: 'Going all-in with a lot of leverage because the idea feels sure. The more sure it feels, the more important the stop-loss and the small size are.',
  stopHint: 'A stop-loss makes this even safer: it caps the loss at a number you chose.',
} as const;

/** The name shown for a statistics key. */
export function statName(key: StatKey): string {
  return key === 'sizing' ? SIZING.name : PATTERNS[key].name;
}

export const CHOICE_LABEL: Readonly<Record<Choice, string>> = { buy: 'Buy', short: 'Short', wait: 'Wait (no trade)' };
export const CHOICE_DETAIL: Readonly<Record<Choice, string>> = {
  buy: 'Bet that the price will rise',
  short: 'Bet that the price will fall',
  wait: 'Keep your cash and watch',
};
