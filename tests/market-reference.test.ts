// MKT-97 … MKT-101 — differential tests against the independent Python implementation
// (tools/reference_market.py → tests/fixtures/reference-market-v2.json).
//
// The Python script was written from docs/rules.md §12, not from this TypeScript code. It generates the
// ten stocks' candles AND plays randomised trading sessions with its own copy of the order rules.
// The TypeScript engine must give exactly the same numbers. If one side changes, the fixture has to be
// regenerated together with a MARKET_ENGINE_VERSION bump (rules.md §12.10).
import { describe, expect, it } from 'vitest';
import {
  createMarketRound,
  deriveSeed,
  generateMarket,
  MARKET_ENGINE_VERSION,
  MARKET_START_CASH,
  STOCKS,
  TICKERS,
  type MarketState,
} from '../src/engine';
import reference from './fixtures/reference-market-v2.json';
import { applyMarketAction, marketSnapshot, type MarketAction } from './helpers/market';

type Row = readonly number[]; // [open, high, low, close]
// Property tests do tens of thousands of actions; Vitest's default 5 s limit is too tight on slow machines.
const LONG_TEST = 60_000;

function toAction(raw: readonly string[]): MarketAction {
  switch (raw[0]) {
    case 'submit':
      return { type: 'submit', ticker: raw[1] ?? '', side: raw[2] === 'SELL' ? 'SELL' : 'BUY', qty: raw[3] ?? '' };
    case 'cancel':
      return { type: 'cancel', ticker: raw[1] ?? '' };
    case 'advance':
      return { type: 'advance' };
    case 'finish':
      return { type: 'finish' };
    case 'replay':
      return { type: 'replay' };
    default:
      throw new Error(`Unknown action ${JSON.stringify(raw)}`);
  }
}

const totalRealized = (s: MarketState): number => TICKERS.reduce((a, t) => a + (s.portfolio.positions[t]?.realizedPnl ?? 0), 0);

describe('Market engine vs the independent Python reference', () => {
  it('MKT-97: the fixture is for this engine version, start cash and stock list', () => {
    expect(reference.marketEngineVersion).toBe(MARKET_ENGINE_VERSION);
    expect(reference.startCash).toBe(MARKET_START_CASH);
    expect(reference.tickers).toEqual(STOCKS.map((s) => s.ticker));
  });

  it('MKT-98: derived per-stock seeds match', () => {
    const golden = reference.derivedSeeds as Record<string, number[]>;
    for (const [seed, list] of Object.entries(golden)) {
      expect(STOCKS.map((_, i) => deriveSeed(Number(seed), i))).toEqual(list);
    }
  });

  it('MKT-99: the ten stocks\' candles match for seeds 12345, 1 and 4294967295', () => {
    const golden = reference.candles as Record<string, Record<string, Row[]>>;
    for (const seed of ['12345', '1', '4294967295']) {
      const market = generateMarket(Number(seed));
      for (const ticker of TICKERS) {
        const mine = (market[ticker] ?? []).map((c) => [c.open, c.high, c.low, c.close]);
        expect(mine).toEqual(golden[seed]?.[ticker]);
      }
    }
  });

  it('MKT-100: random trading sessions end in exactly the same state as the Python simulator', () => {
    expect(reference.scenarios.length).toBeGreaterThanOrEqual(8);
    for (const scenario of reference.scenarios) {
      let state = createMarketRound(scenario.seed);
      const cashAfterAdvance: number[] = [];
      const finishes: number[][] = [];
      scenario.actions.forEach((raw, step) => {
        const action = toAction(raw);
        const before = state;
        try {
          state = applyMarketAction(state, action);
        } catch (err) {
          throw new Error(`seed ${scenario.seed}, step ${step} ${JSON.stringify(raw)}: ${(err as Error).message}`);
        }
        // The Python scenario records cash after every advance action (even a no-op one) and after real finishes.
        if (action.type === 'advance') cashAfterAdvance.push(state.portfolio.cash);
        if (action.type === 'finish' && before.status === 'PLAYING' && before.k === 70) {
          finishes.push([state.portfolio.cash, totalRealized(state), state.trades.length]);
        }
      });
      expect(cashAfterAdvance).toEqual(scenario.cashAfterAdvance);
      expect(finishes).toEqual(scenario.finishes);
      expect(marketSnapshot(state)).toEqual(scenario.final);
    }
  }, LONG_TEST);

  it('MKT-101: the reference sessions are rich enough to mean something', () => {
    let trades = 0;
    let finishes = 0;
    let replays = 0;
    for (const scenario of reference.scenarios) {
      trades += scenario.final.trades.length;
      finishes += scenario.finishes.length;
      replays += scenario.replays;
      expect(scenario.actions.length).toBeGreaterThanOrEqual(1000);
      expect(scenario.cashAfterAdvance.length).toBeGreaterThan(150);
    }
    expect(trades).toBeGreaterThan(150);
    expect(finishes).toBeGreaterThanOrEqual(20);
    expect(replays).toBeGreaterThanOrEqual(20);
    const used = new Set<string>();
    for (const scenario of reference.scenarios) {
      for (const t of scenario.final.trades) used.add(String(t[2]));
    }
    expect(used.size).toBeGreaterThanOrEqual(8);
  });
});
