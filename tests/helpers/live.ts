// Test helpers for live market mode (engine v3): markets with exact prices, a random-action generator,
// the "no future information" walker, and the snapshot shape tools/reference_live.py prints.

import {
  advanceLive,
  createLiveSession,
  createLiveSessionFromMarket,
  createTickMarketFromPrices,
  LIVE_HISTORY_TICKS,
  liveMarks,
  maxLiveBuy,
  Mulberry32,
  portfolioEquity,
  resetLive,
  skipToCandleEnd,
  submitLiveOrder,
  TICKERS,
  TICKS_PER_CANDLE,
  type LiveOptions,
  type LiveState,
  type LiveView,
  type Side,
  type TickMarket,
} from '../../src/engine';

/** A price per tick: a number (flat), a list (index = tick, the last value repeats) or a function. */
export type PriceSpec = number | readonly number[] | ((tick: number) => number);

const SCRIPT_LENGTH = 800;

/**
 * A market with exactly the given prices. `prices` is one spec for all ten stocks or a spec per ticker
 * (tickers left out are flat at 1000 = $10.00).
 */
export function makeTickMarket(prices: PriceSpec | Readonly<Record<string, PriceSpec>> = 1000, length = SCRIPT_LENGTH): TickMarket {
  const isPerTicker = typeof prices === 'object' && !Array.isArray(prices);
  const out: Record<string, number[]> = {};
  for (const ticker of TICKERS) {
    const spec: PriceSpec = isPerTicker ? ((prices as Record<string, PriceSpec>)[ticker] ?? 1000) : (prices as PriceSpec);
    out[ticker] = Array.from({ length }, (_, tick) => {
      if (typeof spec === 'number') return spec;
      if (typeof spec === 'function') return spec(tick);
      return spec[Math.min(tick, spec.length - 1)] ?? 1000;
    });
  }
  return createTickMarketFromPrices(42, out);
}

export function makeLive(
  prices: PriceSpec | Readonly<Record<string, PriceSpec>> = 1000,
  options: LiveOptions = {},
  seed = 42,
): LiveState {
  return createLiveSessionFromMarket(seed, makeTickMarket(prices), options);
}

/** Advance to exactly `tick`. */
export function liveTo(state: LiveState, tick: number): LiveState {
  if (tick < state.tick) throw new Error(`Cannot go back from ${state.tick} to ${tick}`);
  return tick === state.tick ? state : advanceLive(state, tick - state.tick);
}

export const lastLiveNotice = (s: LiveState): string => s.notices[s.notices.length - 1]?.message ?? '';

// ----- Random actions -----

export type LiveAction =
  | { type: 'submit'; ticker: string; side: Side; qty: string }
  | { type: 'advance'; count: number }
  | { type: 'skip' }
  | { type: 'reset' };

export function applyLiveAction(state: LiveState, action: LiveAction): LiveState {
  switch (action.type) {
    case 'submit':
      return submitLiveOrder(state, action.ticker, action.side, action.qty);
    case 'advance':
      return advanceLive(state, action.count);
    case 'skip':
      return skipToCandleEnd(state);
    case 'reset':
      return resetLive(state);
  }
}

export function replayLiveActions(seed: number, actions: readonly LiveAction[], options: LiveOptions = {}): LiveState {
  return actions.reduce(applyLiveAction, createLiveSession(seed, options));
}

const INVALID_QUANTITIES = ['0', '-3', '1.5', '', ' ', 'abc', '1e3', '+5', ' 5', '05', '1000001'];

export function randomLiveAction(rng: Mulberry32, state: LiveState): LiveAction {
  const r = rng.next();
  if (r < 0.1) return { type: 'advance', count: 1 + Math.floor(rng.next() * 12) };
  if (r < 0.14) return { type: 'skip' };
  if (r < 0.143 + (state.status === 'ENDED' ? 0.03 : 0)) return { type: 'reset' };
  const ticker = TICKERS[Math.floor(rng.next() * TICKERS.length)] ?? 'QLRX';
  const side: Side = rng.next() < 0.5 ? 'BUY' : 'SELL';
  const q = rng.next();
  const cap = side === 'BUY' ? maxLiveBuy(state, ticker) : (state.portfolio.positions[ticker]?.shares ?? 0);
  let qty: string;
  if (q < 0.08) qty = INVALID_QUANTITIES[Math.floor(rng.next() * INVALID_QUANTITIES.length)] ?? '0';
  else if (q < 0.3) qty = String(Math.max(1, cap));
  else if (q < 0.38) qty = String(cap + 1);
  else qty = String(1 + Math.floor(rng.next() * (cap + 3)));
  return { type: 'submit', ticker, side, qty };
}

export class LivePropertyFailure extends Error {
  constructor(
    readonly seed: number,
    readonly actions: readonly LiveAction[],
    cause: unknown,
  ) {
    super(
      `Property failed for live seed ${seed} after ${actions.length} actions.\n` +
        `Reproduce with: replayLiveActions(${seed}, ${JSON.stringify(actions)})\n` +
        `Cause: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'LivePropertyFailure';
  }
}

export interface LivePropertyOptions {
  cases: number;
  baseSeed: number;
  steps: number;
  /** Session length for case `i` (ticks); undefined = open-ended. */
  duration?: (caseIndex: number) => number | undefined;
}

/** Runs random action sequences; after every action `check(next, prev, action)` runs. */
export function forEachRandomLiveRun(
  options: LivePropertyOptions,
  check: (next: LiveState, prev: LiveState, action: LiveAction) => void,
): void {
  for (let i = 0; i < options.cases; i += 1) {
    const seed = (options.baseSeed + Math.imul(i, 0x9e3779b1)) >>> 0;
    const actionRng = new Mulberry32((seed ^ 0x5bd1e995) >>> 0);
    const actions: LiveAction[] = [];
    const duration = options.duration?.(i);
    let state = createLiveSession(seed, duration === undefined ? {} : { durationTicks: duration });
    try {
      for (let step = 0; step < options.steps; step += 1) {
        const action = randomLiveAction(actionRng, state);
        actions.push(action);
        const next = applyLiveAction(state, action);
        check(next, state, action);
        state = next;
      }
    } catch (err) {
      throw new LivePropertyFailure(seed, actions, err);
    }
  }
}

// ----- No future information -----

/** Throws if anything in `view` reveals a tick, price or candle after the current tick. */
export function assertNoFutureLive(view: LiveView, state: LiveState): void {
  const t = state.tick;
  const wantCandles = Math.floor(t / TICKS_PER_CANDLE) + 1;
  for (const stock of view.stocks) {
    if (stock.candles.length !== wantCandles) {
      throw new Error(`${stock.ticker}: view has ${stock.candles.length} candles, expected ${wantCandles} at tick ${t}`);
    }
    stock.candles.forEach((c, i) => {
      if (c.index !== i + 1) throw new Error(`${stock.ticker}: candle at position ${i} has index ${c.index}`);
      if (c.openTick + c.ticks > t) throw new Error(`${stock.ticker} candle ${c.index} reaches tick ${c.openTick + c.ticks} > ${t}`);
    });
  }
  const seen = new Set<unknown>();
  const walk = (value: unknown, path: string): void => {
    if (typeof value === 'function') throw new Error(`function exposed at ${path}`);
    if (typeof value !== 'object' || value === null || seen.has(value)) return;
    seen.add(value);
    if (value === state.market) throw new Error(`tick market exposed at ${path}`);
    if (value === state) throw new Error(`engine state exposed at ${path}`);
    if ('priceAt' in value) throw new Error(`price source exposed at ${path}`);
    for (const [key, child] of Object.entries(value)) walk(child, `${path}.${key}`);
  };
  walk(view, 'view');
}

// ----- Comparison with the Python reference -----

/** The same shape tools/reference_live.py prints as "final". */
export function liveSnapshot(s: LiveState) {
  return {
    tick: s.tick,
    status: s.status,
    cash: s.portfolio.cash,
    positions: Object.fromEntries(
      TICKERS.map((t) => {
        const p = s.portfolio.positions[t];
        return [t, [p?.shares ?? 0, p?.costBasis ?? 0, p?.realizedPnl ?? 0]];
      }),
    ),
    trades: s.trades.map((t) => [t.id, t.ticker, t.side, t.tick, t.candleIndex, t.quantity, t.price, t.amount, t.tradePnl, t.cashAfter, t.sharesAfter]),
    equity: portfolioEquity(s.portfolio, liveMarks(s)),
  };
}

export { LIVE_HISTORY_TICKS };
