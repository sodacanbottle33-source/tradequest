// The UI-facing view of a market round. React components receive ONLY this object, which contains
// candles 1..k of every stock and nothing from the future (rules.md §12.7).

import { isHistoryIndex, roundNumber } from './candles';
import { LAST_INDEX, ROUND_LENGTH } from './constants';
import {
  marketMark,
  marketMarks,
  maxAffordable,
  pendingFor,
  reservedForBuys,
  type MarketOrder,
  type MarketState,
  type MarketTrade,
} from './marketRound';
import { MARKET_START_CASH } from './market';
import {
  holdingsValue,
  portfolioEquity,
  positionAverageEntry,
  positionUnrealizedPnl,
  positionMarketValue,
  totalRealizedPnl,
  totalUnrealizedPnl,
} from './portfolio';
import type { Notice, RoundStatus } from './round';
import { STOCKS } from './stocks';
import type { VisibleCandle } from './view';

export interface PositionView {
  readonly shares: number;
  readonly costBasis: number;
  /** Display only; null when no shares are held. */
  readonly averageEntry: number | null;
  readonly positionValue: number;
  readonly unrealizedPnl: number;
  readonly realizedPnl: number;
}

export interface StockView {
  readonly ticker: string;
  readonly name: string;
  readonly sector: string;
  /** Candles 1..k only. */
  readonly candles: readonly VisibleCandle[];
  readonly markPrice: number;
  /** Close of the candle before the newest one. */
  readonly previousClose: number;
  /** markPrice − previousClose. */
  readonly change: number;
  readonly position: PositionView;
  readonly pending: MarketOrder | null;
  /** Pending order's value at the last close (quantity × markPrice); 0 when nothing is pending. Display only. */
  readonly pendingEstimate: number;
  /** Most shares a new BUY of this stock can ask for (uses the cash not set aside by OTHER stocks' pending buys). */
  readonly maxBuyQuantity: number;
  /** maxBuyQuantity × markPrice. Display only. */
  readonly maxBuyCost: number;
  readonly maxSellQuantity: number;
}

export interface MarketAccountView {
  readonly startCash: number;
  /** The one shared cash balance. It only changes when an order fills. */
  readonly cash: number;
  /** Estimated cost of all pending buys. Display only: nothing has been deducted yet. */
  readonly reservedForPendingBuys: number;
  /** cash − reservedForPendingBuys. */
  readonly availableCash: number;
  /** Market value of all holdings. */
  readonly holdingsValue: number;
  readonly unrealizedPnl: number;
  readonly realizedPnl: number;
  readonly equity: number;
  /** equity − startCash. */
  readonly totalReturn: number;
}

export interface MarketView {
  readonly engineVersion: number;
  readonly seed: number;
  readonly status: RoundStatus;
  readonly k: number;
  /** Playable candle number 1..60 of the newest candle; 0 while only history is shown. */
  readonly roundNumber: number;
  readonly roundLength: number;
  readonly stocks: readonly StockView[];
  readonly account: MarketAccountView;
  readonly pendingOrders: readonly MarketOrder[];
  readonly trades: readonly MarketTrade[];
  readonly notices: readonly Notice[];
  readonly canSubmit: boolean;
  readonly canAdvance: boolean;
  readonly canFinish: boolean;
}

export function getMarketView(state: MarketState): MarketView {
  const marks = marketMarks(state);
  const { portfolio } = state;
  const playing = state.status === 'PLAYING';
  const equity = portfolioEquity(portfolio, marks);
  const reserved = reservedForBuys(state);

  const stocks: StockView[] = STOCKS.map((spec) => {
    const list = state.candles[spec.ticker] ?? [];
    const mark = marketMark(state, spec.ticker);
    const prev = list[state.k - 2];
    const pos = portfolio.positions[spec.ticker] ?? { shares: 0, costBasis: 0, realizedPnl: 0 };
    const pending = pendingFor(state, spec.ticker);
    const maxBuy = maxAffordable(state, spec.ticker);
    return {
      ticker: spec.ticker,
      name: spec.name,
      sector: spec.sector,
      candles: list.slice(0, state.k).map((c) => ({
        index: c.index,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        kind: isHistoryIndex(c.index) ? ('history' as const) : ('playable' as const),
      })),
      markPrice: mark,
      previousClose: prev ? prev.close : mark,
      change: mark - (prev ? prev.close : mark),
      position: {
        shares: pos.shares,
        costBasis: pos.costBasis,
        averageEntry: positionAverageEntry(pos),
        positionValue: positionMarketValue(pos, mark),
        unrealizedPnl: positionUnrealizedPnl(pos, mark),
        realizedPnl: pos.realizedPnl,
      },
      pending,
      pendingEstimate: pending ? pending.quantity * mark : 0,
      maxBuyQuantity: maxBuy,
      maxBuyCost: maxBuy * mark,
      maxSellQuantity: pos.shares,
    };
  });

  return {
    engineVersion: state.engineVersion,
    seed: state.seed,
    status: state.status,
    k: state.k,
    roundNumber: Math.max(0, roundNumber(state.k)),
    roundLength: ROUND_LENGTH,
    stocks,
    account: {
      startCash: MARKET_START_CASH,
      cash: portfolio.cash,
      reservedForPendingBuys: reserved,
      availableCash: Math.max(0, portfolio.cash - reserved),
      holdingsValue: holdingsValue(portfolio, marks),
      unrealizedPnl: totalUnrealizedPnl(portfolio, marks),
      realizedPnl: totalRealizedPnl(portfolio),
      equity,
      totalReturn: equity - MARKET_START_CASH,
    },
    pendingOrders: state.pending,
    trades: state.trades,
    notices: state.notices,
    canSubmit: playing && state.k < LAST_INDEX,
    canAdvance: playing && state.k < LAST_INDEX,
    canFinish: playing && state.k === LAST_INDEX,
  };
}

export interface StockResult {
  readonly ticker: string;
  readonly name: string;
  readonly realizedPnl: number;
  readonly tradeCount: number;
}

export interface MarketResults {
  readonly seed: number;
  readonly engineVersion: number;
  readonly startCash: number;
  readonly finalEquity: number;
  readonly totalReturn: number;
  readonly realizedPnl: number;
  /** Player trades only (excludes the liquidations). */
  readonly playerTradeCount: number;
  readonly perStock: readonly StockResult[];
  readonly trades: readonly MarketTrade[];
}

/** Results screen data. null until the round is finished. */
export function getMarketResults(state: MarketState): MarketResults | null {
  if (state.status !== 'FINISHED') return null;
  const finalEquity = portfolioEquity(state.portfolio, marketMarks(state));
  return {
    seed: state.seed,
    engineVersion: state.engineVersion,
    startCash: MARKET_START_CASH,
    finalEquity,
    totalReturn: finalEquity - MARKET_START_CASH,
    realizedPnl: totalRealizedPnl(state.portfolio),
    playerTradeCount: state.trades.filter((t) => t.type === 'player').length,
    perStock: STOCKS.map((s) => ({
      ticker: s.ticker,
      name: s.name,
      realizedPnl: state.portfolio.positions[s.ticker]?.realizedPnl ?? 0,
      tradeCount: state.trades.filter((t) => t.ticker === s.ticker && t.type === 'player').length,
    })),
    trades: state.trades,
  };
}
