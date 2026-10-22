// MKT-87 … MKT-96 — invariants that must hold after EVERY action of random play (docs/rules.md §12.9).
// Each case uses a fixed seed; a failure prints the market seed and the full action list, which
// replayMarketActions() can run again exactly.
import { describe, expect, it } from 'vitest';
import {
  getMarketView,
  marketCandleAt,
  MARKET_START_CASH,
  STOCKS,
  submitMarketOrder,
  TICKERS,
  type MarketState,
} from '../src/engine';
import {
  assertNoFutureMarketCandles,
  forEachRandomMarketRun,
  makeMarket,
  replayMarketActions,
  type MarketAction,
} from './helpers/market';

const RUN = { cases: 60, baseSeed: 20260101, steps: 400 };
// Property tests do tens of thousands of actions; Vitest's default 5 s limit is too tight on slow machines.
const LONG_TEST = 60_000;

/** Cash and shares must be exactly what the trade list implies. */
function expectLedgerBalanced(s: MarketState): void {
  let cash = MARKET_START_CASH;
  const shares: Record<string, number> = Object.fromEntries(TICKERS.map((t) => [t, 0]));
  for (const t of s.trades) {
    cash += t.side === 'BUY' ? -t.amount : t.amount;
    shares[t.ticker] = (shares[t.ticker] ?? 0) + (t.side === 'BUY' ? t.quantity : -t.quantity);
  }
  expect(s.portfolio.cash).toBe(cash);
  for (const t of TICKERS) expect(s.portfolio.positions[t]?.shares).toBe(shares[t]);
}

describe('Invariants under random play', () => {
  it('MKT-87: cash and every share count are whole numbers and never negative', () => {
    forEachRandomMarketRun(RUN, (next) => {
      expect(Number.isSafeInteger(next.portfolio.cash)).toBe(true);
      expect(next.portfolio.cash).toBeGreaterThanOrEqual(0);
      for (const t of TICKERS) {
        const p = next.portfolio.positions[t];
        expect(Number.isSafeInteger(p?.shares)).toBe(true);
        expect(p?.shares ?? -1).toBeGreaterThanOrEqual(0);
        expect(Number.isSafeInteger(p?.costBasis)).toBe(true);
        expect(p?.costBasis ?? -1).toBeGreaterThanOrEqual(0);
        if (p?.shares === 0) expect(p.costBasis).toBe(0);
      }
    });
  }, LONG_TEST);

  it('MKT-88: the ledger balances: cash = start − buys + sells, and shares = bought − sold, for every stock', () => {
    forEachRandomMarketRun(RUN, (next) => expectLedgerBalanced(next));
  }, LONG_TEST);

  it('MKT-89: equity = cash + holdings value, and equity − start = realized + unrealized P&L', () => {
    forEachRandomMarketRun(RUN, (next) => {
      const v = getMarketView(next);
      const holdings = v.stocks.reduce((a, x) => a + x.position.shares * x.markPrice, 0);
      expect(v.account.holdingsValue).toBe(holdings);
      expect(v.account.equity).toBe(v.account.cash + holdings);
      expect(v.account.equity - MARKET_START_CASH).toBe(v.account.realizedPnl + v.account.unrealizedPnl);
      expect(v.account.totalReturn).toBe(v.account.equity - MARKET_START_CASH);
    });
  }, LONG_TEST);

  it('MKT-90: at most one pending order per stock, in strictly increasing placement order', () => {
    forEachRandomMarketRun(RUN, (next) => {
      const tickers = next.pending.map((o) => o.ticker);
      expect(new Set(tickers).size).toBe(tickers.length);
      for (let i = 1; i < next.pending.length; i += 1) {
        expect(next.pending[i]!.seq).toBeGreaterThan(next.pending[i - 1]!.seq);
      }
      for (const o of next.pending) expect(TICKERS.includes(o.ticker)).toBe(true);
      if (next.status === 'FINISHED') expect(next.pending).toEqual([]);
    });
  }, LONG_TEST);

  it('MKT-91: cash set aside for pending buys never exceeds the cash, and available cash is never negative', () => {
    forEachRandomMarketRun(RUN, (next) => {
      const v = getMarketView(next);
      expect(v.account.reservedForPendingBuys).toBeLessThanOrEqual(v.account.cash);
      expect(v.account.availableCash).toBe(v.account.cash - v.account.reservedForPendingBuys);
      expect(v.account.availableCash).toBeGreaterThanOrEqual(0);
    });
  }, LONG_TEST);

  it('MKT-92: cash and positions change only when an advance or a finish fills something', () => {
    forEachRandomMarketRun(RUN, (next, prev, action) => {
      if (action.type === 'submit' || action.type === 'cancel') {
        expect(next.portfolio).toBe(prev.portfolio);
        expect(next.trades).toBe(prev.trades);
        expect(next.k).toBe(prev.k);
      }
    });
  }, LONG_TEST);

  it('MKT-93: a rejected order changes nothing except adding an error notice', () => {
    forEachRandomMarketRun(RUN, (next, prev, action) => {
      if (action.type !== 'submit') return;
      const lastNotice = next.notices[next.notices.length - 1];
      const refused = next.notices.length > 0 && lastNotice?.kind === 'error' && lastNotice !== prev.notices[prev.notices.length - 1];
      if (!refused) return;
      expect(next.portfolio).toBe(prev.portfolio);
      expect(next.pending).toEqual(prev.pending);
      expect(next.nextOrderSeq).toBe(prev.nextOrderSeq);
    });
  }, LONG_TEST);

  it('MKT-94: every player trade is at the OPEN of the candle it names, every liquidation at the final CLOSE', () => {
    forEachRandomMarketRun(RUN, (next) => {
      for (const t of next.trades) {
        const candle = marketCandleAt(next, t.ticker, t.candleIndex);
        if (t.type === 'player') {
          expect(t.price).toBe(candle.open);
          expect(t.candleIndex).toBeGreaterThanOrEqual(11);
        } else {
          expect(t.price).toBe(candle.close);
          expect(t.candleIndex).toBe(70);
        }
        expect(t.amount).toBe(t.quantity * t.price);
        expect(t.side === 'BUY' ? t.tradePnl === null : t.tradePnl !== null).toBe(true);
      }
    });
  }, LONG_TEST);

  it('MKT-95: the view never reveals a candle after k, and the "max buy" amount is accepted while one more is refused', () => {
    let checked = 0;
    let calls = 0;
    forEachRandomMarketRun({ cases: 30, baseSeed: 777, steps: 300 }, (next) => {
      const v = getMarketView(next);
      calls += 1;
      if (calls % 10 === 1) assertNoFutureMarketCandles(v, next); // the full walk is slow, so every 10th step
      if (next.status !== 'PLAYING' || next.k >= 70) return;
      const stock = v.stocks[(next.nextOrderSeq + next.k) % v.stocks.length];
      if (!stock) return;
      if (stock.maxBuyQuantity >= 1) {
        const ok = submitMarketOrder(next, stock.ticker, 'BUY', String(stock.maxBuyQuantity));
        expect(ok.pending.find((o) => o.ticker === stock.ticker)?.quantity).toBe(stock.maxBuyQuantity);
      }
      const tooMany = submitMarketOrder(next, stock.ticker, 'BUY', String(stock.maxBuyQuantity + 1));
      expect(tooMany.pending).toEqual(next.pending);
      checked += 1;
    });
    expect(checked).toBeGreaterThan(1000);
  }, LONG_TEST);

  it('MKT-96: replaying a recorded action list reproduces the final state exactly', () => {
    const recorded: MarketAction[] = [
      { type: 'submit', ticker: 'QLRX', side: 'BUY', qty: '10' },
      { type: 'advance' },
      { type: 'submit', ticker: 'NVRA', side: 'BUY', qty: '5' },
      { type: 'submit', ticker: 'QLRX', side: 'SELL', qty: '4' },
      { type: 'advance' },
      { type: 'cancel', ticker: 'NVRA' },
      { type: 'advance' },
    ];
    expect(replayMarketActions(8, recorded)).toEqual(replayMarketActions(8, recorded));
    expect(replayMarketActions(8, recorded).k).toBe(13);
  });
});

describe('Sanity of the test setup itself', () => {
  it('the random runs really trade: many fills, many rejections, and some rounds are finished', () => {
    let player = 0;
    let liquidations = 0;
    let errors = 0;
    let finished = 0;
    forEachRandomMarketRun({ cases: 30, baseSeed: 99, steps: 400 }, (next, prev) => {
      if (next.trades.length > prev.trades.length) {
        for (const t of next.trades.slice(prev.trades.length)) {
          if (t.type === 'player') player += 1;
          else liquidations += 1;
        }
      }
      if (next.notices.length > 0 && next.notices[next.notices.length - 1]?.kind === 'error' && next.notices !== prev.notices) errors += 1;
      if (next.status === 'FINISHED' && prev.status === 'PLAYING') finished += 1;
    });
    expect(player).toBeGreaterThan(300);
    expect(liquidations).toBeGreaterThan(10);
    expect(errors).toBeGreaterThan(300);
    expect(finished).toBeGreaterThan(5);
  });

  it('all ten stocks are traded by the random player', () => {
    const traded = new Set<string>();
    forEachRandomMarketRun({ cases: 20, baseSeed: 5, steps: 300 }, (next) => {
      for (const t of next.trades) traded.add(t.ticker);
    });
    expect([...traded].sort()).toEqual(STOCKS.map((s) => s.ticker).sort());
  });

  it('a hand-built flat market is used correctly by the helpers', () => {
    const s = makeMarket(5_000);
    expect(getMarketView(s).stocks.every((x) => x.markPrice === 5_000)).toBe(true);
  });
});
