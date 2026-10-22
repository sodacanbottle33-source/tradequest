// The UI-facing view of a live session. React components receive ONLY this object, which contains prices and
// candles up to the current tick and nothing from the future (rules.md §13.7).

import type { LiveCandle } from './liveCandles';
import { formingCandleIndex, ticksIntoCandle } from './liveCandles';
import { liveCandlesOf, liveMarks, maxLiveBuy, type LiveState, type LiveStatus, type LiveTrade } from './liveSession';
import type { PositionView } from './marketView';
import {
  holdingsValue,
  portfolioEquity,
  positionAverageEntry,
  positionMarketValue,
  positionUnrealizedPnl,
  totalRealizedPnl,
  totalUnrealizedPnl,
} from './portfolio';
import type { Notice } from './round';
import { STOCKS } from './stocks';
import { TICKS_PER_CANDLE } from './ticks';

export interface LiveStockView {
  readonly ticker: string;
  readonly name: string;
  readonly sector: string;
  /** Finished candles, then the one still forming (last). Never anything after the current tick. */
  readonly candles: readonly LiveCandle[];
  /** The executable price right now. */
  readonly price: number;
  /** The price one tick ago. */
  readonly previousPrice: number;
  /** price − previousPrice. */
  readonly tickChange: number;
  /** The price when the session started. */
  readonly sessionOpen: number;
  /** price − sessionOpen. */
  readonly sessionChange: number;
  readonly position: PositionView;
  /** Most shares a BUY can ask for right now: exactly the number the engine would accept. */
  readonly maxBuyQuantity: number;
  /** maxBuyQuantity × price. */
  readonly maxBuyCost: number;
  readonly maxSellQuantity: number;
}

export interface LiveAccountView {
  readonly startCash: number;
  readonly cash: number;
  /** Shares × current price, summed over all stocks. */
  readonly holdingsValue: number;
  readonly unrealizedPnl: number;
  readonly realizedPnl: number;
  /** Net worth: cash + holdings at the current prices. */
  readonly equity: number;
  /** equity − startCash. */
  readonly totalReturn: number;
}

export interface LiveView {
  readonly engineVersion: number;
  readonly seed: number;
  readonly status: LiveStatus;
  /** The current tick (the market's clock). */
  readonly tick: number;
  /** Ticks since the session started. */
  readonly sessionTick: number;
  /** The candle that is forming (1-based). */
  readonly candleIndex: number;
  /** Ticks already in the forming candle: 0–9. */
  readonly ticksIntoCandle: number;
  readonly ticksPerCandle: number;
  /** Ticks left in a timed session; null when open-ended. */
  readonly ticksRemaining: number | null;
  readonly stocks: readonly LiveStockView[];
  readonly account: LiveAccountView;
  readonly trades: readonly LiveTrade[];
  readonly notices: readonly Notice[];
  readonly canTrade: boolean;
  readonly canAdvance: boolean;
}

export function getLiveView(state: LiveState): LiveView {
  const marks = liveMarks(state);
  const { portfolio } = state;
  const running = state.status === 'RUNNING';
  const equity = portfolioEquity(portfolio, marks);

  const stocks: LiveStockView[] = STOCKS.map((spec) => {
    const price = marks[spec.ticker] ?? 0;
    const previousPrice = state.market.priceAt(spec.ticker, Math.max(0, state.tick - 1));
    const sessionOpen = state.market.priceAt(spec.ticker, state.startTick);
    const pos = portfolio.positions[spec.ticker] ?? { shares: 0, costBasis: 0, realizedPnl: 0 };
    const maxBuy = maxLiveBuy(state, spec.ticker);
    return {
      ticker: spec.ticker,
      name: spec.name,
      sector: spec.sector,
      candles: liveCandlesOf(state, spec.ticker),
      price,
      previousPrice,
      tickChange: price - previousPrice,
      sessionOpen,
      sessionChange: price - sessionOpen,
      position: {
        shares: pos.shares,
        costBasis: pos.costBasis,
        averageEntry: positionAverageEntry(pos),
        positionValue: positionMarketValue(pos, price),
        unrealizedPnl: positionUnrealizedPnl(pos, price),
        realizedPnl: pos.realizedPnl,
      },
      maxBuyQuantity: maxBuy,
      maxBuyCost: maxBuy * price,
      maxSellQuantity: pos.shares,
    };
  });

  return {
    engineVersion: state.engineVersion,
    seed: state.seed,
    status: state.status,
    tick: state.tick,
    sessionTick: state.tick - state.startTick,
    candleIndex: formingCandleIndex(state.tick),
    ticksIntoCandle: ticksIntoCandle(state.tick),
    ticksPerCandle: TICKS_PER_CANDLE,
    ticksRemaining: state.endTick === null ? null : state.endTick - state.tick,
    stocks,
    account: {
      startCash: state.startCash,
      cash: portfolio.cash,
      holdingsValue: holdingsValue(portfolio, marks),
      unrealizedPnl: totalUnrealizedPnl(portfolio, marks),
      realizedPnl: totalRealizedPnl(portfolio),
      equity,
      totalReturn: equity - state.startCash,
    },
    trades: state.trades,
    notices: state.notices,
    canTrade: running,
    canAdvance: running,
  };
}
