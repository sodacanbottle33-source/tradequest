// LIN-01 … LIN-12 — invariants that must hold after EVERY action of random live play (docs/rules.md §13.8).
// Each case uses a fixed seed; a failure prints the seed and the full action list, which replayLiveActions()
// can run again exactly.
import { describe, expect, it } from 'vitest';
import {
  createLiveSession,
  getLiveView,
  livePrice,
  LIVE_START_CASH,
  liveCandlesOf,
  maxLiveBuy,
  submitLiveOrder,
  TICKERS,
  type LiveState,
} from '../src/engine';
import {
  assertNoFutureLive,
  forEachRandomLiveRun,
  liveTo,
  makeLive,
  replayLiveActions,
  type LiveAction,
} from './helpers/live';

const RUN = { cases: 40, baseSeed: 20261015, steps: 400, duration: (i: number) => (i % 3 === 0 ? undefined : 40 + (i % 5) * 30) };
// Property tests do tens of thousands of actions; Vitest's default 5 s limit is too tight on slow machines.
const LONG_TEST = 60_000;

/** Cash and shares must be exactly what the trade list implies. */
function expectLedgerBalanced(s: LiveState): void {
  let cash = s.startCash;
  const shares: Record<string, number> = Object.fromEntries(TICKERS.map((t) => [t, 0]));
  for (const t of s.trades) {
    cash += t.side === 'BUY' ? -t.amount : t.amount;
    shares[t.ticker] = (shares[t.ticker] ?? 0) + (t.side === 'BUY' ? t.quantity : -t.quantity);
  }
  expect(s.portfolio.cash).toBe(cash);
  for (const t of TICKERS) expect(s.portfolio.positions[t]?.shares).toBe(shares[t]);
}

describe('Invariants under random play', () => {
  it('LIN-01: cash and every share count are whole numbers and never negative', () => {
    forEachRandomLiveRun(RUN, (next) => {
      expect(Number.isSafeInteger(next.portfolio.cash)).toBe(true);
      expect(next.portfolio.cash).toBeGreaterThanOrEqual(0);
      for (const t of TICKERS) {
        const p = next.portfolio.positions[t];
        expect(Number.isSafeInteger(p?.shares)).toBe(true);
        expect(p?.shares ?? -1).toBeGreaterThanOrEqual(0);
        expect(p?.costBasis ?? -1).toBeGreaterThanOrEqual(0);
        if (p?.shares === 0) expect(p.costBasis).toBe(0);
      }
    });
  }, LONG_TEST);

  it('LIN-02: the ledger balances: cash = start − buys + sells, and shares = bought − sold, for every stock', () => {
    forEachRandomLiveRun(RUN, (next) => expectLedgerBalanced(next));
  }, LONG_TEST);

  it('LIN-03: equity = cash + holdings value, and equity − start = realised + unrealised profit', () => {
    forEachRandomLiveRun(RUN, (next) => {
      const v = getLiveView(next);
      const holdings = v.stocks.reduce((a, x) => a + x.position.shares * x.price, 0);
      expect(v.account.holdingsValue).toBe(holdings);
      expect(v.account.equity).toBe(v.account.cash + holdings);
      expect(v.account.equity - v.account.startCash).toBe(v.account.realizedPnl + v.account.unrealizedPnl);
      expect(v.account.totalReturn).toBe(v.account.equity - v.account.startCash);
    });
  }, LONG_TEST);

  it('LIN-04: every trade is at the price of the tick it names, in the candle that was forming then', () => {
    forEachRandomLiveRun(RUN, (next) => {
      for (const t of next.trades) {
        expect(t.price).toBe(next.market.priceAt(t.ticker, t.tick));
        expect(t.candleIndex).toBe(Math.floor(t.tick / 10) + 1);
        expect(t.tick).toBeGreaterThanOrEqual(next.startTick);
        expect(t.tick).toBeLessThanOrEqual(next.tick);
        expect(t.amount).toBe(t.quantity * t.price);
        expect(t.side === 'BUY' ? t.tradePnl === null : t.tradePnl !== null).toBe(true);
      }
    });
  }, LONG_TEST);

  it('LIN-05: trades are in time order, ids count up from 1, and nothing is traded after the session ended', () => {
    forEachRandomLiveRun(RUN, (next) => {
      next.trades.forEach((t, i) => {
        expect(t.id).toBe(i + 1);
        if (i > 0) expect(t.tick).toBeGreaterThanOrEqual(next.trades[i - 1]!.tick);
        if (next.endTick !== null) expect(t.tick).toBeLessThan(next.endTick);
      });
    });
  }, LONG_TEST);

  it('LIN-06: time only moves forward, by exactly the requested amount, and only advance/skip/reset move it', () => {
    forEachRandomLiveRun(RUN, (next, prev, action) => {
      if (action.type === 'submit') {
        expect(next.tick).toBe(prev.tick);
        expect(next.status).toBe(prev.status);
      } else if (action.type === 'advance') {
        const wanted = prev.tick + action.count;
        const expected = prev.status === 'ENDED' ? prev.tick : prev.endTick === null ? wanted : Math.min(wanted, prev.endTick);
        expect(next.tick).toBe(expected);
      } else if (action.type === 'reset') {
        expect(next.tick).toBe(100);
      } else {
        expect(next.tick).toBeGreaterThanOrEqual(prev.tick);
        expect(next.tick - prev.tick).toBeLessThanOrEqual(10);
      }
    });
  }, LONG_TEST);

  it('LIN-07: advancing or skipping never changes cash, shares or trades', () => {
    forEachRandomLiveRun(RUN, (next, prev, action) => {
      if (action.type === 'advance' || action.type === 'skip') {
        expect(next.portfolio).toBe(prev.portfolio);
        expect(next.trades).toBe(prev.trades);
      }
    });
  }, LONG_TEST);

  it('LIN-08: a refused order changes nothing except adding an error message', () => {
    forEachRandomLiveRun(RUN, (next, prev, action) => {
      if (action.type !== 'submit') return;
      if (next.trades === prev.trades) {
        expect(next.portfolio).toBe(prev.portfolio);
        expect(next.tick).toBe(prev.tick);
        expect(next.notices.length).toBeGreaterThanOrEqual(prev.notices.length);
        expect(next.notices.at(-1)?.kind).toBe('error');
      } else {
        expect(next.trades.length).toBe(prev.trades.length + 1);
        expect(next.notices.at(-1)?.kind).toBe('success');
      }
    });
  }, LONG_TEST);

  it('LIN-09: the Max buy amount is accepted and one more is refused; Max sell sells everything', () => {
    let checked = 0;
    forEachRandomLiveRun({ cases: 20, baseSeed: 777, steps: 300, duration: (i) => (i % 4 === 0 ? 120 : undefined) }, (next) => {
      if (next.status !== 'RUNNING') return;
      const ticker = TICKERS[(next.trades.length + next.tick) % 10] ?? 'QLRX';
      const max = maxLiveBuy(next, ticker);
      if (max >= 1) {
        const ok = submitLiveOrder(next, ticker, 'BUY', String(max));
        expect(ok.trades.length).toBe(next.trades.length + 1);
        expect(ok.portfolio.cash).toBe(next.portfolio.cash - max * livePrice(next, ticker));
      }
      expect(submitLiveOrder(next, ticker, 'BUY', String(max + 1)).trades.length).toBe(next.trades.length);
      const held = next.portfolio.positions[ticker]?.shares ?? 0;
      if (held > 0) expect(submitLiveOrder(next, ticker, 'SELL', String(held)).portfolio.positions[ticker]?.shares).toBe(0);
      checked += 1;
    });
    expect(checked).toBeGreaterThan(1500);
  }, LONG_TEST);

  it('LIN-10: the view never reveals anything after the current tick', () => {
    let calls = 0;
    forEachRandomLiveRun({ cases: 20, baseSeed: 4242, steps: 250, duration: (i) => (i % 2 === 0 ? 90 : undefined) }, (next) => {
      calls += 1;
      if (calls % 5 === 1) assertNoFutureLive(getLiveView(next), next);
    });
    expect(calls).toBe(20 * 250);
  }, LONG_TEST);

  it('LIN-11: the newest candle always closes at the current price and the chart covers every tick so far', () => {
    forEachRandomLiveRun({ cases: 20, baseSeed: 31, steps: 250 }, (next) => {
      for (const t of TICKERS) {
        const candles = liveCandlesOf(next, t);
        expect(candles.at(-1)?.close).toBe(livePrice(next, t));
        expect(candles.at(-1)?.ticks).toBe(next.tick % 10);
        expect(candles.length).toBe(Math.floor(next.tick / 10) + 1);
      }
    });
  }, LONG_TEST);

  it('LIN-12: replaying a recorded action list reproduces the final state exactly', () => {
    const recorded: LiveAction[] = [
      { type: 'submit', ticker: 'QLRX', side: 'BUY', qty: '10' },
      { type: 'advance', count: 7 },
      { type: 'submit', ticker: 'NVRA', side: 'BUY', qty: '2' },
      { type: 'skip' },
      { type: 'submit', ticker: 'QLRX', side: 'SELL', qty: '4' },
      { type: 'advance', count: 12 },
    ];
    const a = replayLiveActions(8, recorded);
    const b = replayLiveActions(8, recorded);
    expect(getLiveView(a)).toEqual(getLiveView(b));
    expect(a.trades).toEqual(b.trades);
    expect(a.tick).toBe(100 + 7 + 3 + 12);
  });
});

describe('Sanity of the test setup itself', () => {
  it('LIN-13: the random runs really trade: many fills, many refusals, sessions that end, resets', () => {
    let fills = 0;
    let refusals = 0;
    let ended = 0;
    let resets = 0;
    let actionsAfterEnd = 0;
    forEachRandomLiveRun({ cases: 30, baseSeed: 99, steps: 400, duration: (i) => (i % 2 === 0 ? 60 : undefined) }, (next, prev, action) => {
      if (next.trades.length > prev.trades.length) fills += 1;
      if (action.type === 'submit' && next.trades === prev.trades) refusals += 1;
      if (next.status === 'ENDED' && prev.status === 'RUNNING') ended += 1;
      if (prev.status === 'ENDED') actionsAfterEnd += 1;
      if (action.type === 'reset') resets += 1;
    });
    expect(fills).toBeGreaterThan(300);
    expect(refusals).toBeGreaterThan(300);
    expect(ended).toBeGreaterThan(10);
    expect(resets).toBeGreaterThan(10);
    expect(actionsAfterEnd).toBeGreaterThan(100);
  }, LONG_TEST);

  it('LIN-14: all ten stocks are traded by the random player', () => {
    const traded = new Set<string>();
    forEachRandomLiveRun({ cases: 15, baseSeed: 5, steps: 300 }, (next) => {
      for (const t of next.trades) traded.add(t.ticker);
    });
    expect([...traded].sort()).toEqual([...TICKERS].sort());
  }, LONG_TEST);

  it('LIN-15: a hand-built flat market is used correctly by the helpers', () => {
    const s = liveTo(makeLive(5_000), 130);
    expect(getLiveView(s).stocks.every((x) => x.price === 5_000)).toBe(true);
    expect(createLiveSession(1).startCash).toBe(LIVE_START_CASH);
  });
});
