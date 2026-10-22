// Market-mode round flow — see docs/rules.md §12.
// Every function is pure: it returns a new MarketState and never changes the old one.
// React must not read MarketState directly; it reads getMarketView(state) from marketView.ts.
//
// The single-stock engine (round.ts) is left untouched; this module generalises its rules to ten
// stocks that share one cash balance.

import { roundNumber, type Candle } from './candles';
import { HISTORY_LENGTH, LAST_INDEX, TOTAL_CANDLES } from './constants';
import { formatCents, formatSignedCents } from './format';
import { generateMarket, MARKET_ENGINE_VERSION, type MarketCandles } from './market';
import { floorDiv } from './money';
import { parseQuantity, type Side } from './orders';
import { buyFill, initialPortfolio, sellFill, type Portfolio } from './portfolio';
import type { Notice, NoticeKind, RoundStatus } from './round';
import { TICKERS, stockByTicker } from './stocks';

export interface MarketOrder {
  readonly ticker: string;
  readonly side: Side;
  readonly quantity: number;
  /** Index k when the order was submitted. */
  readonly submittedAt: number;
  /** Placement counter: fills happen in this order within sells and within buys (rules.md §12.6). */
  readonly seq: number;
}

export interface MarketTrade {
  readonly id: number;
  readonly type: 'player' | 'liquidation';
  readonly ticker: string;
  readonly side: Side;
  /** Global candle index 11–70 whose open (player) or close (liquidation) was used. */
  readonly candleIndex: number;
  readonly quantity: number;
  readonly price: number;
  /** Cost (buy) or proceeds (sell), in cents. */
  readonly amount: number;
  /** Sells only; null for buys. */
  readonly tradePnl: number | null;
  /** The ONE shared cash balance after this trade. */
  readonly cashAfter: number;
  /** Shares of THIS stock after this trade. */
  readonly sharesAfter: number;
}

export interface MarketState {
  readonly engineVersion: number;
  readonly seed: number;
  /** All 70 candles of every stock. INTERNAL — never hand this to the UI (see marketView.ts). */
  readonly candles: MarketCandles;
  /** Newest visible candle index (10..70), the same for every stock. */
  readonly k: number;
  readonly status: RoundStatus;
  readonly portfolio: Portfolio;
  /** At most one order per stock, in placement order. */
  readonly pending: readonly MarketOrder[];
  readonly trades: readonly MarketTrade[];
  readonly notices: readonly Notice[];
  readonly nextNoticeId: number;
  readonly nextOrderSeq: number;
}

const MAX_NOTICES = 20;

// ----- Creating rounds -----

/** New market round from a seed (rules.md §12.4). The seed comes from outside the engine (§8). */
export function createMarketRound(seed: number): MarketState {
  return createMarketFromCandles(seed, generateMarket(seed));
}

/** Builds a round from given candles. Used by createMarketRound and by tests that need exact prices. */
export function createMarketFromCandles(seed: number, candles: MarketCandles): MarketState {
  for (const ticker of TICKERS) {
    const list = candles[ticker];
    if (!list) throw new Error(`Missing candles for ${ticker}`);
    if (list.length !== TOTAL_CANDLES) throw new Error(`${ticker} needs ${TOTAL_CANDLES} candles`);
    list.forEach((c, i) => {
      if (c.index !== i + 1) throw new Error(`${ticker} candle at position ${i} has index ${c.index}`);
    });
  }
  return {
    engineVersion: MARKET_ENGINE_VERSION,
    seed,
    candles,
    k: HISTORY_LENGTH,
    status: 'PLAYING',
    portfolio: initialPortfolio(),
    pending: [],
    trades: [],
    notices: [],
    nextNoticeId: 1,
    nextOrderSeq: 1,
  };
}

/** Replay: same seed, everything reset, identical candles. */
export function replayMarket(state: MarketState): MarketState {
  return createMarketRound(state.seed);
}

// ----- Helpers -----

export function marketCandleAt(state: MarketState, ticker: string, index: number): Candle {
  const candle = state.candles[ticker]?.[index - 1];
  if (!candle) throw new Error(`No candle ${index} for ${ticker}`);
  return candle;
}

/** Close of the newest visible candle for one stock. */
export function marketMark(state: MarketState, ticker: string): number {
  return marketCandleAt(state, ticker, state.k).close;
}

/** Marks of every stock. */
export function marketMarks(state: MarketState): Record<string, number> {
  const marks: Record<string, number> = {};
  for (const ticker of TICKERS) marks[ticker] = marketMark(state, ticker);
  return marks;
}

export function pendingFor(state: MarketState, ticker: string): MarketOrder | null {
  return state.pending.find((o) => o.ticker === ticker) ?? null;
}

/**
 * Estimated cost (at the last close) of the pending BUY orders of every stock EXCEPT `exceptTicker`.
 * Nothing is deducted from cash for pending orders (rules.md §12.5); this is only used to stop the
 * player promising the same dollars to several orders.
 */
export function reservedForBuys(state: MarketState, exceptTicker?: string): number {
  let total = 0;
  for (const o of state.pending) {
    if (o.side === 'BUY' && o.ticker !== exceptTicker) total += o.quantity * marketMark(state, o.ticker);
  }
  return total;
}

/** Cash a new BUY of `ticker` may use: all cash minus what OTHER pending buys have set aside (a new order replaces this stock's own). */
export function buyingPower(state: MarketState, ticker: string): number {
  return Math.max(0, state.portfolio.cash - reservedForBuys(state, ticker));
}

/** Most shares of `ticker` a new BUY can ask for right now. */
export function maxAffordable(state: MarketState, ticker: string): number {
  return floorDiv(buyingPower(state, ticker), marketMark(state, ticker));
}

export function describeMarketOrder(side: Side, quantity: number, ticker: string): string {
  return `${side} ${quantity} ${ticker}`;
}

function addNotice(state: MarketState, kind: NoticeKind, message: string): MarketState {
  const notices = [...state.notices, { id: state.nextNoticeId, kind, message }].slice(-MAX_NOTICES);
  return { ...state, notices, nextNoticeId: state.nextNoticeId + 1 };
}

function candleLabel(index: number): string {
  return `candle ${roundNumber(index)}`;
}

function sharesWord(n: number): string {
  return n === 1 ? 'share' : 'shares';
}

// ----- Player actions -----

/** Submit an order for one stock (rules.md §12.6). Replaces that stock's pending order, if any. */
export function submitMarketOrder(state: MarketState, ticker: string, side: Side, quantityText: string): MarketState {
  if (state.status !== 'PLAYING') return state;
  if (state.k >= LAST_INDEX) {
    return addNotice(state, 'error', 'No next candle: this is the final candle. Finish the round to see your results.');
  }
  if (!stockByTicker(ticker)) return addNotice(state, 'error', `Unknown stock "${ticker}".`);

  const parsed = parseQuantity(quantityText);
  if (!parsed.ok) return addNotice(state, 'error', parsed.reason);
  const quantity = parsed.value;
  const position = state.portfolio.positions[ticker];
  const held = position ? position.shares : 0;

  if (side === 'SELL') {
    if (held === 0) return addNotice(state, 'error', `You don't hold any shares of ${ticker}.`);
    if (quantity > held) {
      return addNotice(state, 'error', `You only hold ${held} ${sharesWord(held)} of ${ticker}.`);
    }
  } else {
    const mark = marketMark(state, ticker);
    const estimate = quantity * mark;
    const reserved = reservedForBuys(state, ticker);
    const power = Math.max(0, state.portfolio.cash - reserved);
    if (estimate > power) {
      const affordable = floorDiv(power, mark);
      const canDo =
        affordable > 0
          ? `You can afford up to ${affordable} ${sharesWord(affordable)} of ${ticker}.`
          : `You cannot afford even 1 share of ${ticker}.`;
      const setAside = reserved > 0 ? ` (${formatCents(reserved)} is already set aside for your other pending buys)` : '';
      return addNotice(
        state,
        'error',
        `Not enough cash: ${quantity} ${ticker} would cost about ${formatCents(estimate)} at the last close, but you have ${formatCents(power)} available${setAside}. ${canDo}`,
      );
    }
  }

  const previous = pendingFor(state, ticker);
  const order: MarketOrder = { ticker, side, quantity, submittedAt: state.k, seq: state.nextOrderSeq };
  const next: MarketState = {
    ...state,
    pending: [...state.pending.filter((o) => o.ticker !== ticker), order],
    nextOrderSeq: state.nextOrderSeq + 1,
  };
  const message = previous
    ? `Previous order (${describeMarketOrder(previous.side, previous.quantity, ticker)}) replaced by ${describeMarketOrder(side, quantity, ticker)}.`
    : `Order placed: ${describeMarketOrder(side, quantity, ticker)}. It fills at the next candle's open.`;
  return addNotice(next, 'info', message);
}

/** Cancel one stock's pending order. Nothing to cancel → state unchanged. */
export function cancelMarketOrder(state: MarketState, ticker: string): MarketState {
  const order = pendingFor(state, ticker);
  if (state.status !== 'PLAYING' || order === null) return state;
  const next: MarketState = { ...state, pending: state.pending.filter((o) => o.ticker !== ticker) };
  return addNotice(next, 'info', `Order cancelled: ${describeMarketOrder(order.side, order.quantity, ticker)}.`);
}

/** Reveal the next candle of every stock, filling pending orders at their opens (rules.md §12.6). */
export function advanceMarket(state: MarketState): MarketState {
  if (state.status !== 'PLAYING' || state.k >= LAST_INDEX) return state;

  const nextIndex = state.k + 1;
  let result: MarketState = state;

  // Sells first, then buys; each group in placement order. Sell proceeds are therefore available to the buys.
  const ordered = [...state.pending].sort((a, b) => {
    const rank = (o: MarketOrder) => (o.side === 'SELL' ? 0 : 1);
    return rank(a) - rank(b) || a.seq - b.seq;
  });

  for (const order of ordered) {
    const { ticker, quantity } = order;
    const price = marketCandleAt(state, ticker, nextIndex).open;
    const { portfolio } = result;
    const held = portfolio.positions[ticker]?.shares ?? 0;

    if (order.side === 'BUY') {
      const cost = quantity * price;
      if (cost > portfolio.cash) {
        result = addNotice(
          result,
          'error',
          `Order rejected: ${ticker} opened at ${formatCents(price)}. BUY ${quantity} ${ticker} would cost ${formatCents(cost)}, but you have ${formatCents(portfolio.cash)}.`,
        );
      } else {
        const fill = buyFill(portfolio, ticker, quantity, price);
        result = recordTrade(result, fill.portfolio, {
          type: 'player',
          ticker,
          side: 'BUY',
          candleIndex: nextIndex,
          quantity,
          price,
          amount: fill.cost,
          tradePnl: null,
        });
        result = addNotice(
          result,
          'success',
          `Bought ${quantity} ${ticker} at ${formatCents(price)} (${candleLabel(nextIndex)} open). Cost ${formatCents(fill.cost)}.`,
        );
      }
    } else if (quantity > held) {
      result = addNotice(result, 'error', `Order rejected: you hold only ${held} ${sharesWord(held)} of ${ticker}.`);
    } else {
      const fill = sellFill(portfolio, ticker, quantity, price);
      result = recordTrade(result, fill.portfolio, {
        type: 'player',
        ticker,
        side: 'SELL',
        candleIndex: nextIndex,
        quantity,
        price,
        amount: fill.proceeds,
        tradePnl: fill.tradePnl,
      });
      result = addNotice(
        result,
        'success',
        `Sold ${quantity} ${ticker} at ${formatCents(price)} (${candleLabel(nextIndex)} open). Realized P&L ${formatSignedCents(fill.tradePnl)}.`,
      );
    }
  }

  return { ...result, pending: [], k: nextIndex };
}

/** Finish the round: sell every position at its stock's final close and mark FINISHED. Idempotent. */
export function finishMarket(state: MarketState): MarketState {
  if (state.status !== 'PLAYING' || state.k !== LAST_INDEX) return state;
  let result: MarketState = state;
  let soldAny = false;
  for (const ticker of TICKERS) {
    const held = result.portfolio.positions[ticker]?.shares ?? 0;
    if (held === 0) continue;
    soldAny = true;
    const price = marketCandleAt(state, ticker, LAST_INDEX).close;
    const fill = sellFill(result.portfolio, ticker, held, price);
    result = recordTrade(result, fill.portfolio, {
      type: 'liquidation',
      ticker,
      side: 'SELL',
      candleIndex: LAST_INDEX,
      quantity: held,
      price,
      amount: fill.proceeds,
      tradePnl: fill.tradePnl,
    });
  }
  result = addNotice(
    result,
    'info',
    soldAny ? 'Round finished. Your remaining shares were sold at each stock\'s final close.' : 'Round finished.',
  );
  return { ...result, status: 'FINISHED', pending: [] };
}

function recordTrade(
  state: MarketState,
  portfolio: Portfolio,
  t: Omit<MarketTrade, 'id' | 'cashAfter' | 'sharesAfter'>,
): MarketState {
  const trade: MarketTrade = {
    ...t,
    id: state.trades.length + 1,
    cashAfter: portfolio.cash,
    sharesAfter: portfolio.positions[t.ticker]?.shares ?? 0,
  };
  return { ...state, portfolio, trades: [...state.trades, trade] };
}
