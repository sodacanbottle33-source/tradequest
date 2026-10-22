// Portfolio accounting for market mode — see docs/rules.md §12.5.
// One shared cash balance and one position per stock. The buy/sell arithmetic is NOT repeated here:
// each fill is run through the same applyBuy/applySell (rules.md §7.2–7.3) that the single-stock
// engine uses, by presenting cash + that stock's position as an Account.

import { applyBuy, applySell } from './account';
import { MARKET_START_CASH } from './market';
import { roundHalfUpRatio } from './money';
import { TICKERS } from './stocks';

export interface Position {
  /** Whole shares held. */
  readonly shares: number;
  /** Cents — total cost of the shares currently held. */
  readonly costBasis: number;
  /** Cents — running total of realized P&L on this stock. */
  readonly realizedPnl: number;
}

export interface Portfolio {
  /** Cents — ONE balance shared by all stocks. */
  readonly cash: number;
  /** Every ticker is always present (zero shares when not held). */
  readonly positions: Readonly<Record<string, Position>>;
}

export const EMPTY_POSITION: Position = { shares: 0, costBasis: 0, realizedPnl: 0 };

/** A fresh portfolio: all cash, no shares. Turn-based market mode uses the default; live mode passes LIVE_START_CASH. */
export function initialPortfolio(startCash: number = MARKET_START_CASH): Portfolio {
  if (!Number.isSafeInteger(startCash) || startCash < 0) throw new Error(`Start cash must be a whole number of cents, got ${startCash}`);
  const positions: Record<string, Position> = {};
  for (const ticker of TICKERS) positions[ticker] = EMPTY_POSITION;
  return { cash: startCash, positions };
}

function positionOf(p: Portfolio, ticker: string): Position {
  const pos = p.positions[ticker];
  if (!pos) throw new Error(`Unknown ticker ${ticker}`);
  return pos;
}

function withPosition(p: Portfolio, ticker: string, cash: number, pos: Position): Portfolio {
  return { cash, positions: { ...p.positions, [ticker]: pos } };
}

/** Buy fill for one stock. Callers validate first; this throws only on programming errors. */
export function buyFill(
  p: Portfolio,
  ticker: string,
  quantity: number,
  price: number,
): { portfolio: Portfolio; cost: number } {
  const pos = positionOf(p, ticker);
  const fill = applyBuy({ cash: p.cash, ...pos }, quantity, price);
  const a = fill.account;
  return {
    cost: fill.cost,
    portfolio: withPosition(p, ticker, a.cash, { shares: a.shares, costBasis: a.costBasis, realizedPnl: a.realizedPnl }),
  };
}

/** Sell fill for one stock. */
export function sellFill(
  p: Portfolio,
  ticker: string,
  quantity: number,
  price: number,
): { portfolio: Portfolio; proceeds: number; tradePnl: number } {
  const pos = positionOf(p, ticker);
  const fill = applySell({ cash: p.cash, ...pos }, quantity, price);
  const a = fill.account;
  return {
    proceeds: fill.proceeds,
    tradePnl: fill.tradePnl,
    portfolio: withPosition(p, ticker, a.cash, { shares: a.shares, costBasis: a.costBasis, realizedPnl: a.realizedPnl }),
  };
}

// ----- Derived values (display and scoring; never fed back into fills) -----

export function positionMarketValue(pos: Position, mark: number): number {
  return pos.shares * mark;
}

export function positionUnrealizedPnl(pos: Position, mark: number): number {
  return pos.shares * mark - pos.costBasis;
}

/** Display only. null when no shares are held. */
export function positionAverageEntry(pos: Position): number | null {
  return pos.shares > 0 ? roundHalfUpRatio(pos.costBasis, pos.shares) : null;
}

/** Value of all holdings at the given marks (cents). */
export function holdingsValue(p: Portfolio, marks: Readonly<Record<string, number>>): number {
  let total = 0;
  for (const ticker of TICKERS) total += positionMarketValue(positionOf(p, ticker), markOf(marks, ticker));
  return total;
}

export function portfolioEquity(p: Portfolio, marks: Readonly<Record<string, number>>): number {
  return p.cash + holdingsValue(p, marks);
}

export function totalRealizedPnl(p: Portfolio): number {
  let total = 0;
  for (const ticker of TICKERS) total += positionOf(p, ticker).realizedPnl;
  return total;
}

export function totalUnrealizedPnl(p: Portfolio, marks: Readonly<Record<string, number>>): number {
  let total = 0;
  for (const ticker of TICKERS) total += positionUnrealizedPnl(positionOf(p, ticker), markOf(marks, ticker));
  return total;
}

function markOf(marks: Readonly<Record<string, number>>, ticker: string): number {
  const m = marks[ticker];
  if (m === undefined) throw new Error(`No mark price for ${ticker}`);
  return m;
}
