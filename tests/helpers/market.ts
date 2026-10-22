// Test helpers for market mode (engine v2): rounds with exact prices, a random-action generator,
// and the "no future candles" walker for the ten-stock view.

import {
  advanceMarket,
  cancelMarketOrder,
  createMarketFromCandles,
  createMarketRound,
  finishMarket,
  maxAffordable,
  Mulberry32,
  replayMarket,
  submitMarketOrder,
  TICKERS,
  type Candle,
  type MarketCandles,
  type MarketState,
  type MarketView,
  type Side,
} from '../../src/engine';
import { makeCandles } from './rounds';

type CandleOverride = Partial<Omit<Candle, 'index'>>;

/** Per-ticker overrides by global candle index. */
export type MarketOverrides = Readonly<Record<string, Record<number, CandleOverride>>>;

/**
 * Ten flat stocks. `price` is either one price for all tickers or a price per ticker
 * (tickers left out default to 1000 = $10.00).
 */
export function makeMarketCandles(
  price: number | Readonly<Record<string, number>> = 1000,
  overrides: MarketOverrides = {},
): MarketCandles {
  const out: Record<string, Candle[]> = {};
  for (const ticker of TICKERS) {
    const p = typeof price === 'number' ? price : (price[ticker] ?? 1000);
    out[ticker] = makeCandles(p, overrides[ticker] ?? {});
  }
  return out;
}

export function makeMarket(
  price: number | Readonly<Record<string, number>> = 1000,
  overrides: MarketOverrides = {},
  seed = 42,
): MarketState {
  return createMarketFromCandles(seed, makeMarketCandles(price, overrides));
}

/** Advance until the newest visible candle is `k`. */
export function advanceMarketTo(state: MarketState, k: number): MarketState {
  let s = state;
  while (s.k < k) {
    const next = advanceMarket(s);
    if (next === s) throw new Error(`Could not advance past ${s.k}`);
    s = next;
  }
  return s;
}

export const lastMarketNotice = (s: MarketState): string => s.notices[s.notices.length - 1]?.message ?? '';

// ----- Random actions -----

export type MarketAction =
  | { type: 'submit'; ticker: string; side: Side; qty: string }
  | { type: 'cancel'; ticker: string }
  | { type: 'advance' }
  | { type: 'finish' }
  | { type: 'replay' };

export function applyMarketAction(state: MarketState, action: MarketAction): MarketState {
  switch (action.type) {
    case 'submit':
      return submitMarketOrder(state, action.ticker, action.side, action.qty);
    case 'cancel':
      return cancelMarketOrder(state, action.ticker);
    case 'advance':
      return advanceMarket(state);
    case 'finish':
      return finishMarket(state);
    case 'replay':
      return replayMarket(state);
  }
}

export function replayMarketActions(seed: number, actions: readonly MarketAction[]): MarketState {
  return actions.reduce(applyMarketAction, createMarketRound(seed));
}

const INVALID_QUANTITIES = ['0', '-3', '1.5', '', ' ', 'abc', '1e3', '+5', ' 5', '05', '1000001'];

export function randomMarketAction(rng: Mulberry32, state: MarketState): MarketAction {
  const r = rng.next();
  if (state.status === 'FINISHED') return r < 0.5 ? { type: 'replay' } : { type: 'advance' };
  if (state.k === 70 && r < 0.3) return { type: 'finish' };
  if (r < 0.2) return { type: 'advance' };
  const ticker = TICKERS[Math.floor(rng.next() * TICKERS.length)] ?? 'QLRX';
  if (r < 0.82) {
    const side: Side = rng.next() < 0.55 ? 'BUY' : 'SELL';
    const q = rng.next();
    const cap = side === 'BUY' ? maxAffordable(state, ticker) : (state.portfolio.positions[ticker]?.shares ?? 0);
    let qty: string;
    if (q < 0.1) qty = INVALID_QUANTITIES[Math.floor(rng.next() * INVALID_QUANTITIES.length)] ?? '0';
    else if (q < 0.3) qty = String(Math.max(1, cap));
    else qty = String(1 + Math.floor(rng.next() * (cap + 3)));
    return { type: 'submit', ticker, side, qty };
  }
  if (r < 0.93) return { type: 'cancel', ticker };
  if (r < 0.995) return { type: 'advance' };
  return { type: 'replay' };
}

export class MarketPropertyFailure extends Error {
  constructor(
    readonly seed: number,
    readonly actions: readonly MarketAction[],
    cause: unknown,
  ) {
    super(
      `Property failed for market seed ${seed} after ${actions.length} actions.\n` +
        `Reproduce with: replayMarketActions(${seed}, ${JSON.stringify(actions)})\n` +
        `Cause: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'MarketPropertyFailure';
  }
}

export interface MarketPropertyOptions {
  cases: number;
  baseSeed: number;
  steps: number;
}

/** Runs random action sequences; after every action `check(next, prev, action)` runs. */
export function forEachRandomMarketRun(
  options: MarketPropertyOptions,
  check: (next: MarketState, prev: MarketState, action: MarketAction) => void,
): void {
  for (let i = 0; i < options.cases; i += 1) {
    const seed = (options.baseSeed + Math.imul(i, 0x9e3779b1)) >>> 0;
    const actionRng = new Mulberry32((seed ^ 0x5bd1e995) >>> 0);
    const actions: MarketAction[] = [];
    let state = createMarketRound(seed);
    try {
      for (let step = 0; step < options.steps; step += 1) {
        const action = randomMarketAction(actionRng, state);
        actions.push(action);
        const next = applyMarketAction(state, action);
        check(next, state, action);
        state = next;
      }
    } catch (err) {
      throw new MarketPropertyFailure(seed, actions, err);
    }
  }
}

// ----- No future candles -----

function isCandleLike(v: unknown): v is { index: number } {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as Record<string, unknown>).index === 'number' &&
    'open' in v &&
    'close' in v
  );
}

/** Throws if anything in `view` reveals a candle after k, for any stock. */
export function assertNoFutureMarketCandles(view: MarketView, state: MarketState): void {
  const k = state.k;
  const future = new Set<unknown>();
  for (const ticker of TICKERS) for (const c of (state.candles[ticker] ?? []).slice(k)) future.add(c);

  for (const stock of view.stocks) {
    if (stock.candles.length !== k) throw new Error(`${stock.ticker}: view has ${stock.candles.length} candles, expected ${k}`);
  }

  const seen = new Set<unknown>();
  const walk = (value: unknown, path: string): void => {
    if (typeof value !== 'object' || value === null || seen.has(value)) return;
    seen.add(value);
    if (future.has(value)) throw new Error(`future candle object exposed at ${path}`);
    if (value === state.candles) throw new Error(`full candle map exposed at ${path}`);
    for (const ticker of TICKERS) {
      if (value === state.candles[ticker]) throw new Error(`full candle list of ${ticker} exposed at ${path}`);
    }
    if (isCandleLike(value) && value.index > k) throw new Error(`candle ${value.index} exposed at ${path} (k = ${k})`);
    if (Array.isArray(value) && value.length > k && value.some(isCandleLike)) {
      throw new Error(`list of ${value.length} candles exposed at ${path}`);
    }
    for (const [key, child] of Object.entries(value)) walk(child, `${path}.${key}`);
  };
  walk(view, 'view');
}

// ----- Comparison with the Python reference -----

/** The same shape tools/reference_market.py prints as "final". */
export function marketSnapshot(s: MarketState) {
  return {
    k: s.k,
    status: s.status,
    cash: s.portfolio.cash,
    positions: Object.fromEntries(
      TICKERS.map((t) => {
        const p = s.portfolio.positions[t];
        return [t, [p?.shares ?? 0, p?.costBasis ?? 0, p?.realizedPnl ?? 0]];
      }),
    ),
    pending: s.pending.map((o) => [o.ticker, o.side, o.quantity, o.seq]),
    trades: s.trades.map((t) => [
      t.id,
      t.type,
      t.ticker,
      t.side,
      t.candleIndex,
      t.quantity,
      t.price,
      t.amount,
      t.tradePnl,
      t.cashAfter,
      t.sharesAfter,
    ]),
  };
}
