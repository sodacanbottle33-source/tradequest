// Live market mode: one trading session — see docs/rules.md §13.
// Every function is pure: it returns a new LiveState and never changes the old one (the TickMarket inside only
// remembers prices it has computed, which can never change them).
// React must not read LiveState directly; it reads getLiveView(state) from liveView.ts.
//
// The engine has no clock. "Playing" is just something outside the engine calling advanceLive() now and then
// (src/app/playback.ts); how often it does so can change how fast the market is SHOWN, never what the prices are.

import { formatCents, formatSignedCents } from './format';
import { liveCandlesAt, formingCandleIndex } from './liveCandles';
import { floorDiv } from './money';
import { parseQuantity, type Side } from './orders';
import { buyFill, initialPortfolio, sellFill, type Portfolio } from './portfolio';
import type { Notice, NoticeKind } from './round';
import { stockByTicker, TICKERS } from './stocks';
import {
  createTickMarket,
  LIVE_ENGINE_VERSION,
  LIVE_HISTORY_TICKS,
  LIVE_START_CASH,
  MAX_TICK,
  TICKS_PER_CANDLE,
  type TickMarket,
} from './ticks';

export type LiveStatus = 'RUNNING' | 'ENDED';

export interface LiveTrade {
  readonly id: number;
  readonly ticker: string;
  readonly side: Side;
  /** The tick at which the order filled; the price is that tick's price. */
  readonly tick: number;
  /** The candle that was forming when the order filled. */
  readonly candleIndex: number;
  readonly quantity: number;
  /** Cents per share — the executable price at `tick`. */
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

export interface LiveOptions {
  /** Starting cash in cents. Default LIVE_START_CASH ($1,000.00). */
  readonly startCash?: number;
  /** Session length in ticks. Leave out for an open-ended session. A 3-minute match at 1 tick per second is 180. */
  readonly durationTicks?: number;
}

export interface LiveState {
  readonly engineVersion: number;
  readonly seed: number;
  /** Prices of every tick, past and future. INTERNAL — never hand this to the UI (see liveView.ts). */
  readonly market: TickMarket;
  /** The tick the session started at (the history before it is already on the chart). */
  readonly startTick: number;
  /** The current tick: prices up to and including this tick have happened. */
  readonly tick: number;
  /** The tick a timed session ends at; null when open-ended. */
  readonly endTick: number | null;
  readonly status: LiveStatus;
  readonly startCash: number;
  readonly portfolio: Portfolio;
  readonly trades: readonly LiveTrade[];
  readonly notices: readonly Notice[];
  readonly nextNoticeId: number;
}

const MAX_NOTICES = 20;

// ----- Creating sessions -----

function checkOptions(options: LiveOptions): { startCash: number; durationTicks: number | null } {
  const startCash = options.startCash ?? LIVE_START_CASH;
  if (!Number.isSafeInteger(startCash) || startCash < 0) throw new Error(`Start cash must be a whole number of cents, got ${startCash}`);
  const durationTicks = options.durationTicks ?? null;
  if (durationTicks !== null && (!Number.isSafeInteger(durationTicks) || durationTicks < 1 || durationTicks > MAX_TICK - LIVE_HISTORY_TICKS)) {
    throw new Error(`Duration must be a whole number of ticks, 1 or more, got ${durationTicks}`);
  }
  return { startCash, durationTicks };
}

/** New live session from a seed (rules.md §13.5). The seed comes from outside the engine. */
export function createLiveSession(seed: number, options: LiveOptions = {}): LiveState {
  return createLiveSessionFromMarket(seed, createTickMarket(seed), options);
}

/** Builds a session on a given market. Used by createLiveSession and by tests that need exact prices. */
export function createLiveSessionFromMarket(seed: number, market: TickMarket, options: LiveOptions = {}): LiveState {
  const { startCash, durationTicks } = checkOptions(options);
  return {
    engineVersion: LIVE_ENGINE_VERSION,
    seed,
    market,
    startTick: LIVE_HISTORY_TICKS,
    tick: LIVE_HISTORY_TICKS,
    endTick: durationTicks === null ? null : LIVE_HISTORY_TICKS + durationTicks,
    status: 'RUNNING',
    startCash,
    portfolio: initialPortfolio(startCash),
    trades: [],
    notices: [],
    nextNoticeId: 1,
  };
}

/** Same seed, same options, everything else reset: identical prices. */
export function resetLive(state: LiveState): LiveState {
  const durationTicks = state.endTick === null ? undefined : state.endTick - state.startTick;
  return createLiveSessionFromMarket(state.seed, state.market, { startCash: state.startCash, durationTicks });
}

// ----- Prices -----

/** The executable price of a stock right now (cents): the price at the current tick. */
export function livePrice(state: LiveState, ticker: string): number {
  return state.market.priceAt(ticker, state.tick);
}

export function liveMarks(state: LiveState): Record<string, number> {
  const marks: Record<string, number> = {};
  for (const ticker of TICKERS) marks[ticker] = livePrice(state, ticker);
  return marks;
}

/** Most shares of `ticker` the cash can buy at the current price. */
export function maxLiveBuy(state: LiveState, ticker: string): number {
  return floorDiv(state.portfolio.cash, livePrice(state, ticker));
}

function addNotice(state: LiveState, kind: NoticeKind, message: string): LiveState {
  const notices = [...state.notices, { id: state.nextNoticeId, kind, message }].slice(-MAX_NOTICES);
  return { ...state, notices, nextNoticeId: state.nextNoticeId + 1 };
}

function sharesWord(n: number): string {
  return n === 1 ? 'share' : 'shares';
}

// ----- Time -----

/**
 * Move the market forward by `count` ticks (default 1). Every price changes exactly once per tick.
 * Timed sessions stop at their end tick and become ENDED; an ended session does not move.
 */
export function advanceLive(state: LiveState, count: number = 1): LiveState {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error(`Tick count must be a whole number, 1 or more, got ${count}`);
  if (state.status !== 'RUNNING') return state;
  const wanted = state.tick + count;
  const tick = state.endTick === null ? wanted : Math.min(wanted, state.endTick);
  if (tick > MAX_TICK) return state;
  const ended = state.endTick !== null && tick >= state.endTick;
  return { ...state, tick, status: ended ? 'ENDED' : 'RUNNING' };
}

/** Ticks until the forming candle is finished; a full candle (10) when a new one has just begun. */
export function ticksToCandleEnd(tick: number): number {
  return TICKS_PER_CANDLE - (tick % TICKS_PER_CANDLE);
}

/** "Skip forward": run on to the end of the candle that is forming (a whole new candle if it has just begun). */
export function skipToCandleEnd(state: LiveState): LiveState {
  return advanceLive(state, ticksToCandleEnd(state.tick));
}

// ----- Trading -----

/**
 * Buy or sell at the CURRENT price (rules.md §13.6): the fill happens now, at the price of the current tick,
 * never at a later tick's price. Whole shares only; a buy needs the cash, a sell needs the shares.
 * A refused order changes nothing except adding an error notice.
 */
export function submitLiveOrder(state: LiveState, ticker: string, side: Side, quantityText: string): LiveState {
  if (state.status !== 'RUNNING') return addNotice(state, 'error', 'The session has ended: trading is closed.');
  if (!stockByTicker(ticker)) return addNotice(state, 'error', `Unknown stock "${ticker}".`);

  const parsed = parseQuantity(quantityText);
  if (!parsed.ok) return addNotice(state, 'error', parsed.reason);
  const quantity = parsed.value;
  const price = livePrice(state, ticker);
  const held = state.portfolio.positions[ticker]?.shares ?? 0;
  const candleIndex = formingCandleIndex(state.tick);

  if (side === 'SELL') {
    if (held === 0) return addNotice(state, 'error', `You don't hold any shares of ${ticker}.`);
    if (quantity > held) return addNotice(state, 'error', `You only hold ${held} ${sharesWord(held)} of ${ticker}.`);
    const fill = sellFill(state.portfolio, ticker, quantity, price);
    return addNotice(
      recordTrade(state, fill.portfolio, { ticker, side, tick: state.tick, candleIndex, quantity, price, amount: fill.proceeds, tradePnl: fill.tradePnl }),
      'success',
      `Sold ${quantity} ${ticker} at ${formatCents(price)}. Realized P&L ${formatSignedCents(fill.tradePnl)}.`,
    );
  }

  const cost = quantity * price;
  if (cost > state.portfolio.cash) {
    const affordable = floorDiv(state.portfolio.cash, price);
    const canDo =
      affordable > 0 ? `You can afford up to ${affordable} ${sharesWord(affordable)} of ${ticker}.` : `You cannot afford even 1 share of ${ticker}.`;
    return addNotice(
      state,
      'error',
      `Not enough cash: ${quantity} ${ticker} costs ${formatCents(cost)} at ${formatCents(price)}, but you have ${formatCents(state.portfolio.cash)}. ${canDo}`,
    );
  }
  const fill = buyFill(state.portfolio, ticker, quantity, price);
  return addNotice(
    recordTrade(state, fill.portfolio, { ticker, side, tick: state.tick, candleIndex, quantity, price, amount: fill.cost, tradePnl: null }),
    'success',
    `Bought ${quantity} ${ticker} at ${formatCents(price)}. Cost ${formatCents(fill.cost)}.`,
  );
}

function recordTrade(state: LiveState, portfolio: Portfolio, t: Omit<LiveTrade, 'id' | 'cashAfter' | 'sharesAfter'>): LiveState {
  const trade: LiveTrade = {
    ...t,
    id: state.trades.length + 1,
    cashAfter: portfolio.cash,
    sharesAfter: portfolio.positions[t.ticker]?.shares ?? 0,
  };
  return { ...state, portfolio, trades: [...state.trades, trade] };
}

/** Candles of a stock as they stand now (used by the view and by tests). */
export function liveCandlesOf(state: LiveState, ticker: string) {
  return liveCandlesAt(state.market, ticker, state.tick);
}
