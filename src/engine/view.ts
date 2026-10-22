// The UI-facing view of a round. React components receive ONLY this object,
// which contains candles 1..k and nothing from the future (rules.md §5.5, test FLOW-02).

import { averageEntry, equity, positionValue, unrealizedPnl } from './account';
import { isHistoryIndex, roundNumber, type Candle } from './candles';
import { LAST_INDEX, ROUND_LENGTH, START_CASH } from './constants';
import { floorDiv } from './money';
import type { PendingOrder } from './orders';
import { markPrice, type Notice, type RoundState, type RoundStatus, type Trade } from './round';

export interface VisibleCandle extends Candle {
  readonly kind: 'history' | 'playable';
}

export interface AccountView {
  readonly cash: number;
  readonly shares: number;
  readonly costBasis: number;
  /** Display only; null when no shares are held. */
  readonly averageEntry: number | null;
  readonly positionValue: number;
  readonly unrealizedPnl: number;
  readonly realizedPnl: number;
  readonly equity: number;
  /** equity − START_CASH. */
  readonly totalReturn: number;
}

export interface RoundView {
  readonly engineVersion: number;
  readonly seed: number;
  readonly status: RoundStatus;
  readonly k: number;
  /** Playable candle number 1..60 of the newest candle; 0 while only history is shown. */
  readonly roundNumber: number;
  readonly roundLength: number;
  /** Candles 1..k only. */
  readonly candles: readonly VisibleCandle[];
  readonly markPrice: number;
  readonly account: AccountView;
  readonly pending: PendingOrder | null;
  readonly trades: readonly Trade[];
  readonly notices: readonly Notice[];
  readonly canSubmit: boolean;
  readonly canAdvance: boolean;
  readonly canFinish: boolean;
  /** "Max" helpers (§6.5). */
  readonly maxBuyQuantity: number;
  readonly maxSellQuantity: number;
  /** maxBuyQuantity × markPrice: the most a buy can cost at the last close. Display only. */
  readonly maxBuyCost: number;
  /**
   * Pending order's value at the last close (quantity × markPrice); 0 when nothing is pending.
   * Display only: the real price is the next candle's open, and cash only changes when the order fills.
   */
  readonly pendingEstimate: number;
  /**
   * Cash not already earmarked by a pending BUY: cash − pendingEstimate for a buy, plain cash otherwise.
   * Display only. Nothing is deducted until the fill, so a replacement order is still checked against ALL cash.
   */
  readonly availableCash: number;
}

export function getView(state: RoundState): RoundView {
  const mark = markPrice(state);
  const { account } = state;
  const eq = equity(account, mark);
  const playing = state.status === 'PLAYING';
  const maxBuyQuantity = floorDiv(account.cash, mark);
  // The mark cannot change while an order is pending (advancing fills or rejects it), so this stays accurate.
  const pendingEstimate = state.pending ? state.pending.quantity * mark : 0;
  const availableCash = state.pending?.side === 'BUY' ? Math.max(0, account.cash - pendingEstimate) : account.cash;

  return {
    engineVersion: state.engineVersion,
    seed: state.seed,
    status: state.status,
    k: state.k,
    roundNumber: Math.max(0, roundNumber(state.k)),
    roundLength: ROUND_LENGTH,
    candles: state.candles.slice(0, state.k).map((c) => ({
      index: c.index,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      kind: isHistoryIndex(c.index) ? 'history' : 'playable',
    })),
    markPrice: mark,
    account: {
      cash: account.cash,
      shares: account.shares,
      costBasis: account.costBasis,
      averageEntry: averageEntry(account),
      positionValue: positionValue(account, mark),
      unrealizedPnl: unrealizedPnl(account, mark),
      realizedPnl: account.realizedPnl,
      equity: eq,
      totalReturn: eq - START_CASH,
    },
    pending: state.pending,
    trades: state.trades,
    notices: state.notices,
    canSubmit: playing && state.k < LAST_INDEX,
    canAdvance: playing && state.k < LAST_INDEX,
    canFinish: playing && state.k === LAST_INDEX,
    maxBuyQuantity,
    maxSellQuantity: account.shares,
    maxBuyCost: maxBuyQuantity * mark,
    pendingEstimate,
    availableCash,
  };
}

export interface RoundResults {
  readonly seed: number;
  readonly engineVersion: number;
  readonly finalEquity: number;
  readonly totalReturn: number;
  readonly realizedPnl: number;
  /** Player trades only (excludes the liquidation). */
  readonly playerTradeCount: number;
  readonly trades: readonly Trade[];
}

/** Results screen data (§4.6). null until the round is finished. */
export function getResults(state: RoundState): RoundResults | null {
  if (state.status !== 'FINISHED') return null;
  const finalEquity = equity(state.account, markPrice(state));
  return {
    seed: state.seed,
    engineVersion: state.engineVersion,
    finalEquity,
    totalReturn: finalEquity - START_CASH,
    realizedPnl: state.account.realizedPnl,
    playerTradeCount: state.trades.filter((t) => t.type === 'player').length,
    trades: state.trades,
  };
}
