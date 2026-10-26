// The tutorial (docs/world.md §19.1): nine short steps, each with a small hands-on demo and one check question. No AI is involved: it is
// fixed text and fixed demo data, so it works offline and costs nothing. Every number in a question is recomputed by tests/learn-tutorial.test.ts
// with the functions of tutorialMath.ts, so the printed answer cannot be wrong.

import { candlesFromCloses } from './candles';
import { breakEvenBps, cashAfterLosses, COIN_FEE_BPS_TEXT, feeCents, leveragedProfitCents, longProfitCents, shortProfitCents, STOCK_FEE_BPS_TEXT } from './tutorialMath';
import type { LCandle } from './types';

export type DemoKind = 'shares' | 'candles' | 'long' | 'short' | 'fees' | 'leverage' | 'stops' | 'dangers' | 'size';

/** What a question's right answer is worked out from (the tests recompute it). */
export type Calc =
  | { readonly kind: 'long'; readonly shares: number; readonly entry: number; readonly exit: number; readonly expectCents: number }
  | { readonly kind: 'short'; readonly shares: number; readonly entry: number; readonly exit: number; readonly expectCents: number }
  | { readonly kind: 'fee'; readonly valueCents: number; readonly bps: number; readonly expectCents: number }
  | { readonly kind: 'leverage'; readonly marginCents: number; readonly leverage: number; readonly moveBps: number; readonly expectCents: number }
  | { readonly kind: 'losses'; readonly cashCents: number; readonly stakePercent: number; readonly lossPercent: number; readonly n: number; readonly expectCents: number };

export function calcResult(c: Calc): number {
  switch (c.kind) {
    case 'long':
      return longProfitCents(c.shares, c.entry, c.exit);
    case 'short':
      return shortProfitCents(c.shares, c.entry, c.exit);
    case 'fee':
      return feeCents(c.valueCents, c.bps);
    case 'leverage':
      return leveragedProfitCents(c.marginCents, c.leverage, c.moveBps);
    case 'losses':
      return cashAfterLosses(c.cashCents, c.stakePercent, c.lossPercent, c.n);
  }
}

export interface TutorialQuestion {
  readonly text: string;
  readonly options: readonly string[];
  /** The index of the right option. */
  readonly correct: number;
  /** Shown after any answer: why the right one is right. */
  readonly explain: string;
  /** Set when the right answer is a number the tests can recompute. */
  readonly calc?: Calc;
}

export interface TutorialStep {
  /** 1 to 9; this is also the number saved on the server. */
  readonly id: number;
  readonly title: string;
  readonly paragraphs: readonly string[];
  /** A short sentence above the demo telling the player what to try. */
  readonly tryIt: string;
  readonly demo: DemoKind;
  readonly question: TutorialQuestion;
}

// ---- demo data -------------------------------------------------------------------------------------------------------------------

/** The share demo: the player has these shares, bought at this price (cents). */
export const SHARES_DEMO = { shares: 10, entryCents: 2000, minCents: 1000, maxCents: 3000 } as const;

/** Six hand-made candles to click on in the candle demo (cents). */
export const ANATOMY_CANDLES: readonly LCandle[] = [
  { o: 4800, h: 5150, l: 4750, c: 5100 },
  { o: 5100, h: 5200, l: 4900, c: 4950 },
  { o: 4950, h: 5050, l: 4900, c: 5000 },
  { o: 5000, h: 5020, l: 4600, c: 4650 },
  { o: 4650, h: 4900, l: 4500, c: 4660 },
  { o: 4660, h: 5200, l: 4640, c: 5150 },
];

/** The buy-and-sell demo: the price starts at $50.00 and these are the closes of the next candles (cents). */
export const LONG_DEMO = { start: 5000, closes: [4950, 4880, 4800, 4860, 4950, 5080, 5200, 5150, 5280, 5400, 5350, 5250, 5100, 4980], shares: 10, firstShown: 4 } as const;

/** The short demo: the price starts at $50.00 and mostly falls (cents). */
export const SHORT_DEMO = { start: 5000, closes: [5050, 5150, 5100, 4950, 4800, 4850, 4700, 4600, 4650, 4500, 4400, 4450, 4550, 4650], shares: 10, firstShown: 4 } as const;

export function demoCandles(demo: { start: number; closes: readonly number[] }): LCandle[] {
  return candlesFromCloses(demo.start, demo.closes, 0);
}

/** The fee demo's order sizes in dollars. */
export const FEE_DEMO_AMOUNTS = [100, 500, 1000, 5000] as const;

/** The leverage demo: a margin of $100 and the leverages the slider stops at. */
export const LEVERAGE_DEMO = { marginCents: 10_000, stops: [1, 2, 5, 10, 25, 50] as const } as const;

/** The stop demo: a buy at $100 with a stop-loss and a take-profit (cents). */
export const STOP_DEMO = { entry: 10_000, stop: 9_500, target: 11_200, shares: 10 } as const;

/** The size demo: $1,000 of cash, five losing trades in a row, each loses 20 % of what was put at stake. */
export const SIZE_DEMO = { cashCents: 100_000, lossPercent: 20, n: 5, stakes: [100, 50, 25, 10, 5] as const } as const;

/** The dangers the demo lets the player open one by one. */
export const DANGER_CARDS: readonly { readonly key: string; readonly title: string; readonly text: string }[] = [
  {
    key: 'news',
    title: 'News moves prices',
    text: 'A good story pushes a price up, a bad one pushes it down, sometimes within seconds. Read the News tab before you trade. A story can also be a surprise: a company can miss its earnings and fall even in a good market.',
  },
  {
    key: 'coins',
    title: 'Memecoins swing wildly',
    text: 'A stock moves under 1 % in a typical 3 minutes. A memecoin moves 7 % to 45 %. That is why they can make you rich or wipe you out in a minute, and why a small bet is the only sensible bet on a coin.',
  },
  {
    key: 'rug',
    title: 'Rug pulls',
    text: 'Anybody can launch a coin. The person who launched it can take all the money out of its pool (a rug pull). Then the coin is worth almost nothing and cannot be sold. Be careful with coins from players you do not know.',
  },
  {
    key: 'bankrupt',
    title: 'Companies can fail',
    text: 'A weak small company with a long run of bad news can go bankrupt. The price crashes by more than 90 % and stops for good. Nobody can buy or short it any more, but you can still sell what you hold, or cover a short, at that price.',
  },
  {
    key: 'pause',
    title: 'Trading pauses',
    text: 'Like a real stock exchange, the market stops trading a stock for 5 minutes when its price moved too far too fast. Stop-losses cannot fire during a pause, so a stop is not a promise of an exact price.',
  },
];

// ---- the steps -------------------------------------------------------------------------------------------------------------------

const longCalc: Calc = { kind: 'long', shares: 5, entry: 4000, exit: 4600, expectCents: 3000 };
const longLossCalc: Calc = { kind: 'long', shares: 10, entry: 5000, exit: 4400, expectCents: -6000 };
const shortCalc: Calc = { kind: 'short', shares: 10, entry: 5000, exit: 4400, expectCents: 6000 };
const feeCalc: Calc = { kind: 'fee', valueCents: 100_000, bps: COIN_FEE_BPS_TEXT, expectCents: 500 };
const leverageCalc: Calc = { kind: 'leverage', marginCents: 10_000, leverage: 10, moveBps: -1000, expectCents: -10_000 };
const lossesCalc: Calc = { kind: 'losses', cashCents: 100_000, stakePercent: 100, lossPercent: 20, n: 5, expectCents: 32_768 };

export const TUTORIAL: readonly TutorialStep[] = [
  {
    id: 1,
    title: 'Shares and price',
    paragraphs: [
      'A share is a tiny piece of a company. Every company in TradeQuest is made up, and every dollar is pretend. You start with $1,000.',
      'When you buy shares you pay the price they have right now. If the price goes up, your shares are worth more. If it goes down, they are worth less. You only make or lose money when the price moves.',
    ],
    tryIt: 'You own 10 shares that you bought at $20.00. Move the price up and down and watch your profit.',
    demo: 'shares',
    question: {
      text: 'You buy 5 shares at $40 each. The price rises to $46. How much profit do you have?',
      options: ['$6', '$30', '$46', '$230'],
      correct: 1,
      explain: 'Each share gained $6, and you have 5 of them: 5 × $6 = $30.',
      calc: longCalc,
    },
  },
  {
    id: 2,
    title: 'Reading candles',
    paragraphs: [
      'A candle is one slice of time (a minute, an hour, a day). It shows four prices: where the price started (open), where it ended (close), the highest it reached and the lowest it reached.',
      'A green candle means the price went up in that time: it opened low and closed high. A red candle means it went down. The thin lines above and below are called wicks. They show how far the price went before it came back.',
      'Many candles side by side tell a story: is the price climbing, falling or going nowhere?',
    ],
    tryIt: 'Click a candle to see its four prices.',
    demo: 'candles',
    question: {
      text: 'A red candle opens at $52 and closes at $48. What does it tell you?',
      options: ['The price fell $4 during that time', 'The price rose $4 during that time', 'The price did not change', 'The price never went above $48'],
      correct: 0,
      explain: 'Red means the close is lower than the open: $52 down to $48. The wick above the body could even show that the price went higher than $52 for a moment.',
    },
  },
  {
    id: 3,
    title: 'Buy low, sell high',
    paragraphs: [
      'The simplest trade has two moves: you Buy, you wait, you Sell. You win when you sell for more than you paid, and you lose when you sell for less.',
      'Nobody knows the next candle, not even the best traders. They choose a plan, and they accept that some trades lose.',
    ],
    tryIt: 'Press Next candle to let time pass. Press Buy when you think the price will rise, then Sell to take your money back.',
    demo: 'long',
    question: {
      text: 'You buy 10 shares at $50 and sell them at $44. What is the result?',
      options: ['You made $60', 'You lost $60', 'You lost $6', 'You made $6'],
      correct: 1,
      explain: 'You lost $6 on each share and you had 10 of them: 10 × $6 = $60 lost.',
      calc: longLossCalc,
    },
  },
  {
    id: 4,
    title: 'Short selling: win when the price falls',
    paragraphs: [
      'You can also win when a price goes down. This is called a short. You sell shares you do not own, and later you buy them back (that is called Cover).',
      'If the price fell, buying the shares back costs less than you sold them for, and the difference is your profit. If the price rose, you lose.',
      'Be careful: a price can only fall to zero, but it can rise a long way. So a short can lose more than you would first expect.',
    ],
    tryIt: 'This price mostly falls. Press Next candle, then Short at a high price and Cover at a lower one.',
    demo: 'short',
    question: {
      text: 'You short 10 shares at $50. The price falls to $44 and you cover. What is the result?',
      options: ['You made $60', 'You lost $60', 'You made $6', 'You lost $6'],
      correct: 0,
      explain: 'You sold at $50 and bought back at $44, so you kept $6 on each of the 10 shares: $60.',
      calc: shortCalc,
    },
  },
  {
    id: 5,
    title: 'Fees and the gap',
    paragraphs: [
      `Every trade has a cost. TradeQuest takes a small fee on each order: ${STOCK_FEE_BPS_TEXT / 100} % on stocks and ${COIN_FEE_BPS_TEXT / 100} % on memecoins. You pay it when you open a trade and again when you close it.`,
      'There is also a gap between the price you buy at (ask) and the price you sell at (bid). If you buy and sell right away, you lose a little. A player who trades all day pays all day.',
    ],
    tryIt: 'Pick an order size and see what a stock and a memecoin cost you.',
    demo: 'fees',
    question: {
      text: 'You buy $1,000 worth of a memecoin. The fee is 0.5 %. How much fee do you pay on that order?',
      options: ['$0.50', '$5.00', '$50.00', '$0.05'],
      correct: 1,
      explain: '0.5 % is 5 dollars for every 1,000 dollars: $5.00.',
      calc: feeCalc,
    },
  },
  {
    id: 6,
    title: 'Leverage: borrowing to bet bigger',
    paragraphs: [
      'Leverage lets you open a bigger trade than your money allows. With 10×, your $100 controls a $1,000 position.',
      'Wins get bigger, and so do losses. If the price moves against you by about 100 divided by your leverage (in percent), your money for that trade is gone and the market closes the trade for you. This is called liquidation.',
      'In TradeQuest leverage goes from 1× to 50×. You can never lose more than the money you put into that one trade, but you can lose all of it very fast.',
    ],
    tryIt: 'Move the slider. Watch what a small move does at a high leverage.',
    demo: 'leverage',
    question: {
      text: 'You open a trade with $100 at 10× leverage. The price falls 10 %. What happens?',
      options: ['You lose $10', 'You lose all $100 and the trade is closed', 'You lose $1,000', 'Nothing, the price will come back'],
      correct: 1,
      explain: 'At 10× a 10 % fall is a 100 % loss of your own money: $100 is gone and the market closes the trade. (The real game closes it a little earlier, because the loan also costs interest.)',
      calc: leverageCalc,
    },
  },
  {
    id: 7,
    title: 'Stop-loss and take-profit',
    paragraphs: [
      'You can tell the market in advance when to close a trade for you. A stop-loss closes it if the price moves against you to a number you chose, so a bad trade stays small. A take-profit closes it when the price reaches the gain you wanted.',
      'The market closes the whole position at the price it can get at that moment, which is close to your number but not always exactly it. And while trading is paused, a stop has to wait.',
    ],
    tryIt: 'You bought 10 shares at $100.00 with a stop at $95.00 and a target at $112.00. Press a button to see what the price does.',
    demo: 'stops',
    question: {
      text: 'You bought at $100 with a stop-loss at $95 and a take-profit at $112. The price falls to $95. What happens?',
      options: ['The trade is closed for you with a small loss', 'Nothing, the stop only works when you are online', 'The trade is closed with a profit', 'The price is paused for a week'],
      correct: 0,
      explain: 'The stop-loss sells your shares for you at about $95. You lost about 5 % instead of watching the loss grow. That is the whole point of a stop.',
    },
  },
  {
    id: 8,
    title: 'News, coins and other dangers',
    paragraphs: [
      'The market has more traps than a falling price. Open each card below and read it once. You will meet all of them.',
    ],
    tryIt: 'Open each card.',
    demo: 'dangers',
    question: {
      text: 'A company you own shares of goes bankrupt. What can you still do?',
      options: ['Sell your shares at the price where it stopped', 'Buy more shares at the low price', 'Open a new short on it', 'Nothing: the shares disappear'],
      correct: 0,
      explain: 'After a bankruptcy nobody can open a new position. You can still sell what you hold (or cover a short) at the price where it froze. A holder gets very little back; a short opened before the crash wins more than 90 %.',
    },
  },
  {
    id: 9,
    title: 'How much to risk',
    paragraphs: [
      'Even very good traders lose many trades in a row. What keeps them in the game is how much they put on each idea. If you put everything on one trade, one bad run ends it.',
      'A simple habit: put only a small slice of your money on one idea. Then a losing streak hurts, but it does not finish you.',
    ],
    tryIt: 'You lose 5 trades in a row, and each one loses 20 % of what you put at stake. Choose how much of your cash you stake each time.',
    demo: 'size',
    question: {
      text: 'You stake all your cash on each trade and lose 20 % of it every time. After 5 losing trades in a row, about how much is left of $1,000?',
      options: ['About $0', 'About $330', 'About $600', 'About $800'],
      correct: 1,
      explain: 'Each loss leaves 80 % of what you had: $1,000 → $800 → $640 → $512 → $410 → $328. With a smaller stake the same streak would barely scratch you.',
      calc: lossesCalc,
    },
  },
];

export const TUTORIAL_STEPS = TUTORIAL.length;

/** The price the fee demo has to beat to pay back both fees, as a percent text. */
export function breakEvenText(bps: number): string {
  const b = breakEvenBps(bps);
  const whole = Math.floor(b / 100);
  const rest = b % 100;
  return rest === 0 ? `${whole} %` : `${whole}.${rest < 10 ? '0' : ''}${rest} %`;
}
