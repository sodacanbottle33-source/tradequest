// LRF-01 … LRF-07 — differential tests against the independent Python implementation
// (tools/reference_live.py → tests/fixtures/reference-live-v3.json).
//
// The Python script was written from docs/rules.md §13, not from this TypeScript code. It draws its random
// numbers one after another (the TypeScript engine jumps straight to any draw), rebuilds candles from plain
// price lists, and plays randomised sessions with its own copy of the trading rules. The TypeScript engine must
// give exactly the same numbers. If one side changes, the fixture has to be regenerated together with a
// LIVE_ENGINE_VERSION bump (rules.md §13.10).
import { describe, expect, it } from 'vitest';
import {
  advanceLive,
  createLiveSession,
  createTickMarket,
  getLiveView,
  LIVE_ENGINE_VERSION,
  LIVE_HISTORY_TICKS,
  LIVE_START_CASH,
  liveCandlesAt,
  resetLive,
  skipToCandleEnd,
  STOCKS,
  submitLiveOrder,
  TICKERS,
  TICKS_PER_CANDLE,
  type LiveState,
} from '../src/engine';
import reference from './fixtures/reference-live-v3.json';
import { liveSnapshot } from './helpers/live';

const LONG_TEST = 60_000;

function applyRaw(state: LiveState, raw: readonly (string | number)[]): LiveState {
  switch (raw[0]) {
    case 'submit':
      return submitLiveOrder(state, String(raw[1]), raw[2] === 'SELL' ? 'SELL' : 'BUY', String(raw[3]));
    case 'advance':
      return advanceLive(state, Number(raw[1]));
    case 'skip':
      return skipToCandleEnd(state);
    case 'reset':
      return resetLive(state);
    default:
      throw new Error(`Unknown action ${JSON.stringify(raw)}`);
  }
}

describe('Live engine vs the independent Python reference', () => {
  it('LRF-01: the fixture is for this engine version, start cash, candle size and stock list', () => {
    expect(reference.liveEngineVersion).toBe(LIVE_ENGINE_VERSION);
    expect(reference.startCash).toBe(LIVE_START_CASH);
    expect(reference.ticksPerCandle).toBe(TICKS_PER_CANDLE);
    expect(reference.historyTicks).toBe(LIVE_HISTORY_TICKS);
    expect(reference.tickers).toEqual(STOCKS.map((s) => s.ticker));
  });

  it('LRF-02: the price of every stock at every tick 0-400 matches, for four seeds', () => {
    const golden = reference.prices as Record<string, Record<string, number[]>>;
    expect(reference.priceSeeds).toEqual([12345, 1, 4294967295, 0]);
    for (const seed of reference.priceSeeds) {
      const market = createTickMarket(seed);
      for (const ticker of TICKERS) {
        const expected = golden[String(seed)]?.[ticker] ?? [];
        expect(expected).toHaveLength(401);
        const mine = expected.map((_, n) => market.priceAt(ticker, n));
        expect(mine).toEqual(expected);
      }
    }
  });

  it('LRF-03: the candles (index, ticks, open, high, low, close) at twelve different ticks match', () => {
    const golden = reference.candles as Record<string, Record<string, Record<string, number[][]>>>;
    for (const seed of reference.priceSeeds) {
      const market = createTickMarket(seed);
      for (const tick of reference.checkTicks) {
        for (const ticker of TICKERS) {
          const mine = liveCandlesAt(market, ticker, tick).map((c) => [c.index, c.ticks, c.open, c.high, c.low, c.close]);
          expect(mine).toEqual(golden[String(seed)]?.[String(tick)]?.[ticker]);
        }
      }
    }
  });

  it('LRF-04: random trading sessions end in exactly the same state as the Python simulator', () => {
    expect(reference.scenarios.length).toBeGreaterThanOrEqual(8);
    for (const scenario of reference.scenarios) {
      let state = createLiveSession(scenario.seed, {
        startCash: scenario.startCash,
        ...(scenario.duration === null ? {} : { durationTicks: scenario.duration }),
      });
      scenario.actions.forEach((raw, step) => {
        try {
          state = applyRaw(state, raw);
        } catch (err) {
          throw new Error(`seed ${scenario.seed}, step ${step} ${JSON.stringify(raw)}: ${(err as Error).message}`);
        }
      });
      expect(liveSnapshot(state)).toEqual(scenario.final);
    }
  }, LONG_TEST);

  it('LRF-05: after EVERY action the tick, the cash and the number of trades match', () => {
    for (const scenario of reference.scenarios) {
      let state = createLiveSession(scenario.seed, {
        startCash: scenario.startCash,
        ...(scenario.duration === null ? {} : { durationTicks: scenario.duration }),
      });
      const trace: number[][] = [];
      for (const raw of scenario.actions) {
        state = applyRaw(state, raw);
        trace.push([state.tick, state.portfolio.cash, state.trades.length]);
      }
      expect(trace).toEqual(scenario.trace);
    }
  }, LONG_TEST);

  it('LRF-06: after every advance and skip, tick, cash and net worth (at the new prices) match', () => {
    for (const scenario of reference.scenarios) {
      let state = createLiveSession(scenario.seed, {
        startCash: scenario.startCash,
        ...(scenario.duration === null ? {} : { durationTicks: scenario.duration }),
      });
      const afterTime: number[][] = [];
      for (const raw of scenario.actions) {
        state = applyRaw(state, raw);
        if (raw[0] === 'advance' || raw[0] === 'skip') afterTime.push([state.tick, state.portfolio.cash, getLiveView(state).account.equity]);
      }
      expect(afterTime).toEqual(scenario.afterTime);
    }
  }, LONG_TEST);

  it('LRF-07: the reference sessions are rich enough to mean something', () => {
    let trades = 0;
    let resets = 0;
    let ended = 0;
    let withCustomCash = 0;
    for (const scenario of reference.scenarios) {
      trades += scenario.totalTrades;
      resets += scenario.resets;
      ended += scenario.actionsWhileEnded;
      if (scenario.startCash !== LIVE_START_CASH) withCustomCash += 1;
      expect(scenario.actions.length).toBeGreaterThanOrEqual(1000);
      expect(scenario.afterTime.length).toBeGreaterThan(100);
    }
    expect(trades).toBeGreaterThan(1000);
    expect(resets).toBeGreaterThanOrEqual(20);
    expect(ended).toBeGreaterThan(300);
    expect(withCustomCash).toBeGreaterThanOrEqual(1);
    const used = new Set<string>();
    for (const scenario of reference.scenarios) for (const t of scenario.final.trades) used.add(String(t[1]));
    expect(used.size).toBeGreaterThanOrEqual(5);
  });
});
