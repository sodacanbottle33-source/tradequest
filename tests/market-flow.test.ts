// MKT-63 … MKT-86 — a market round from start to results (docs/rules.md §12.4, §12.7–12.8).
import { describe, expect, it } from 'vitest';
import {
  advanceMarket,
  cancelMarketOrder,
  createMarketFromCandles,
  createMarketRound,
  finishMarket,
  generateMarket,
  getMarketResults,
  getMarketView,
  MARKET_ENGINE_VERSION,
  MARKET_START_CASH,
  replayMarket,
  STOCKS,
  submitMarketOrder,
  TICKERS,
  type MarketState,
} from '../src/engine';
import {
  advanceMarketTo,
  assertNoFutureMarketCandles,
  lastMarketNotice,
  makeMarket,
  makeMarketCandles,
} from './helpers/market';

const PRICE = 10_000;

describe('Starting a round', () => {
  it('MKT-63: a new round starts at candle 10, PLAYING, with $10,000 and nothing pending or traded', () => {
    const s = createMarketRound(12345);
    expect(s.engineVersion).toBe(MARKET_ENGINE_VERSION);
    expect(s.seed).toBe(12345);
    expect(s.k).toBe(10);
    expect(s.status).toBe('PLAYING');
    expect(s.portfolio.cash).toBe(MARKET_START_CASH);
    expect(s.pending).toEqual([]);
    expect(s.trades).toEqual([]);
    expect(s.notices).toEqual([]);
  });

  it('MKT-64: the first view shows ten stocks, ten history candles each, and the right buttons', () => {
    const v = getMarketView(createMarketRound(12345));
    expect(v.stocks.map((x) => x.ticker)).toEqual(TICKERS);
    expect(v.stocks.map((x) => x.name)).toEqual(STOCKS.map((x) => x.name));
    for (const stock of v.stocks) {
      expect(stock.candles).toHaveLength(10);
      expect(stock.candles.every((c) => c.kind === 'history')).toBe(true);
      expect(stock.position.shares).toBe(0);
      expect(stock.pending).toBeNull();
    }
    expect(v.k).toBe(10);
    expect(v.roundNumber).toBe(0);
    expect(v.roundLength).toBe(60);
    expect(v.canSubmit).toBe(true);
    expect(v.canAdvance).toBe(true);
    expect(v.canFinish).toBe(false);
    expect(v.account).toMatchObject({
      startCash: MARKET_START_CASH,
      cash: MARKET_START_CASH,
      reservedForPendingBuys: 0,
      availableCash: MARKET_START_CASH,
      holdingsValue: 0,
      unrealizedPnl: 0,
      realizedPnl: 0,
      equity: MARKET_START_CASH,
      totalReturn: 0,
    });
  });

  it('MKT-65: createMarketFromCandles refuses incomplete or mis-indexed candles', () => {
    const good = makeMarketCandles(PRICE);
    expect(() => createMarketFromCandles(1, good)).not.toThrow();
    const missing = { ...good };
    delete (missing as Record<string, unknown>).NVRA;
    expect(() => createMarketFromCandles(1, missing)).toThrow();
    expect(() => createMarketFromCandles(1, { ...good, NVRA: (good.NVRA ?? []).slice(0, 69) })).toThrow();
    const shifted = (good.NVRA ?? []).map((c) => ({ ...c, index: c.index + 1 }));
    expect(() => createMarketFromCandles(1, { ...good, NVRA: shifted })).toThrow();
  });
});

describe('Playing through 60 candles', () => {
  it('MKT-66: sixty advances reveal one candle per stock each time and end at candle 70', () => {
    let s = createMarketRound(2026);
    for (let i = 1; i <= 60; i += 1) {
      s = advanceMarket(s);
      expect(s.k).toBe(10 + i);
      const v = getMarketView(s);
      expect(v.roundNumber).toBe(i);
      for (const stock of v.stocks) {
        expect(stock.candles).toHaveLength(10 + i);
        expect(stock.candles[stock.candles.length - 1]?.kind).toBe('playable');
      }
    }
    const v = getMarketView(s);
    expect(v.canAdvance).toBe(false);
    expect(v.canSubmit).toBe(false);
    expect(v.canFinish).toBe(true);
    expect(advanceMarket(s)).toBe(s);
  });

  it('MKT-67: the view never contains a candle after k, for any stock, at any point of the round', () => {
    for (const seed of [1, 12345, 4294967295]) {
      let s = createMarketRound(seed);
      for (;;) {
        assertNoFutureMarketCandles(getMarketView(s), s);
        if (s.k === 70) break;
        s = submitMarketOrder(s, TICKERS[s.k % 10] ?? 'QLRX', 'BUY', '1');
        s = advanceMarket(s);
      }
      s = finishMarket(s);
      assertNoFutureMarketCandles(getMarketView(s), s);
    }
  });

  it('MKT-68: the candles in the view are exactly candles 1..k of the engine\'s market', () => {
    const seed = 777;
    const market = generateMarket(seed);
    const s = advanceMarketTo(createMarketRound(seed), 37);
    for (const stock of getMarketView(s).stocks) {
      const expected = (market[stock.ticker] ?? []).slice(0, 37);
      expect(stock.candles.map((c) => [c.index, c.open, c.high, c.low, c.close])).toEqual(
        expected.map((c) => [c.index, c.open, c.high, c.low, c.close]),
      );
    }
  });

  it('MKT-69: mark price is the newest close, and the change is measured against the close before it', () => {
    const s0 = makeMarket(PRICE, {
      QLRX: { 10: { open: 9_000, close: 9_500 }, 11: { open: 9_600, close: 9_900 } },
    });
    const before = getMarketView(s0).stocks.find((x) => x.ticker === 'QLRX');
    expect(before?.markPrice).toBe(9_500);
    expect(before?.previousClose).toBe(PRICE);
    expect(before?.change).toBe(-500);
    const after = getMarketView(advanceMarket(s0)).stocks.find((x) => x.ticker === 'QLRX');
    expect(after?.markPrice).toBe(9_900);
    expect(after?.previousClose).toBe(9_500);
    expect(after?.change).toBe(400);
  });

  it('MKT-70: fills use the open of the next candle, never the close the player was looking at', () => {
    const s0 = makeMarket(PRICE, { SKVR: { 11: { open: 12_300, close: 11_000 } } });
    expect(getMarketView(s0).stocks.find((x) => x.ticker === 'SKVR')?.markPrice).toBe(PRICE);
    const s1 = advanceMarket(submitMarketOrder(s0, 'SKVR', 'BUY', '3'));
    expect(s1.trades[0]?.price).toBe(12_300);
    expect(s1.portfolio.cash).toBe(MARKET_START_CASH - 3 * 12_300);
    const v = getMarketView(s1).stocks.find((x) => x.ticker === 'SKVR');
    expect(v?.position).toMatchObject({
      shares: 3,
      costBasis: 36_900,
      averageEntry: 12_300,
      positionValue: 3 * 11_000,
      unrealizedPnl: 3 * 11_000 - 36_900,
      realizedPnl: 0,
    });
  });
});

describe('Cash stays consistent (Stage 1 regressions, now across stocks)', () => {
  it('MKT-71: after each fill the shown cash equals the start cash minus what was spent', () => {
    let s = makeMarket(PRICE);
    let spent = 0;
    for (const [i, t] of TICKERS.entries()) {
      s = submitMarketOrder(s, t, 'BUY', String(i + 1));
      s = advanceMarket(s);
      spent += (i + 1) * PRICE;
      expect(s.portfolio.cash).toBe(MARKET_START_CASH - spent);
      expect(getMarketView(s).account.cash).toBe(MARKET_START_CASH - spent);
    }
    expect(spent).toBe(55 * PRICE);
  });

  it('MKT-72: buying and selling the same stocks over and over leaks no money when prices stand still', () => {
    let s = makeMarket(PRICE);
    for (let round = 0; round < 6; round += 1) {
      for (const t of ['QLRX', 'NVRA', 'HLQN']) s = submitMarketOrder(s, t, 'BUY', '30');
      s = advanceMarket(s);
      for (const t of ['QLRX', 'NVRA', 'HLQN']) s = submitMarketOrder(s, t, 'SELL', '30');
      s = advanceMarket(s);
      expect(s.portfolio.cash).toBe(MARKET_START_CASH);
      for (const t of TICKERS) expect(s.portfolio.positions[t]).toEqual({ shares: 0, costBasis: 0, realizedPnl: 0 });
    }
    expect(s.trades).toHaveLength(36);
  });

  it('MKT-73: the "max" amount in the view is always accepted and one more is always refused', () => {
    for (const seed of [3, 99, 31337]) {
      let s = advanceMarketTo(createMarketRound(seed), 25);
      for (const stock of getMarketView(s).stocks) {
        const max = stock.maxBuyQuantity;
        expect(max).toBe(Math.floor(MARKET_START_CASH / stock.markPrice));
        expect(stock.maxBuyCost).toBe(max * stock.markPrice);
        expect(submitMarketOrder(s, stock.ticker, 'BUY', String(max)).pending).toHaveLength(1);
        expect(submitMarketOrder(s, stock.ticker, 'BUY', String(max + 1)).pending).toHaveLength(0);
      }
      s = submitMarketOrder(s, 'QLRX', 'BUY', '3');
      expect(getMarketView(s).stocks.length).toBe(10);
    }
  });

  it('MKT-74: the pending buy shown in the view is a display-only estimate; cash is untouched until the fill', () => {
    let s = makeMarket(PRICE);
    s = submitMarketOrder(s, 'BRLF', 'BUY', '12');
    let v = getMarketView(s);
    expect(v.account.cash).toBe(MARKET_START_CASH);
    expect(v.account.reservedForPendingBuys).toBe(12 * PRICE);
    expect(v.pendingOrders).toEqual(s.pending);
    s = advanceMarket(s);
    v = getMarketView(s);
    expect(v.account.cash).toBe(MARKET_START_CASH - 12 * PRICE);
    expect(v.account.reservedForPendingBuys).toBe(0);
    expect(v.pendingOrders).toEqual([]);
  });
});

describe('Finishing the round (§12.8)', () => {
  it('MKT-75: finishing before the last candle does nothing', () => {
    const s = advanceMarketTo(makeMarket(PRICE), 40);
    expect(finishMarket(s)).toBe(s);
  });

  it('MKT-76: finishing sells every position at that stock\'s own final close, in stock order', () => {
    const s0 = makeMarket(PRICE, {
      ZYRA: { 70: { open: 10_000, close: 9_000 } },
      HLQN: { 70: { open: 10_000, close: 12_500 } },
    });
    let s = s0;
    s = submitMarketOrder(s, 'ZYRA', 'BUY', '10');
    s = submitMarketOrder(s, 'HLQN', 'BUY', '20');
    s = submitMarketOrder(s, 'QLRX', 'BUY', '5');
    s = advanceMarketTo(advanceMarket(s), 70);
    const done = finishMarket(s);
    expect(done.status).toBe('FINISHED');
    expect(done.pending).toEqual([]);
    const liquidations = done.trades.filter((t) => t.type === 'liquidation');
    expect(liquidations.map((t) => [t.ticker, t.quantity, t.price, t.candleIndex])).toEqual([
      ['QLRX', 5, 10_000, 70],
      ['HLQN', 20, 12_500, 70],
      ['ZYRA', 10, 9_000, 70],
    ]);
    expect(lastMarketNotice(done)).toBe("Round finished. Your remaining shares were sold at each stock's final close.");
    for (const t of TICKERS) expect(done.portfolio.positions[t]?.shares).toBe(0);
  });

  it('MKT-77: after finishing, cash is the start cash plus all realized P&L, and equity equals cash', () => {
    const s = advanceMarketTo(
      ['QLRX', 'NVRA', 'MRDL', 'PLNB'].reduce(
        (acc, t, i) => submitMarketOrder(acc, t, 'BUY', String(3 + i)),
        createMarketRound(4242),
      ),
      70,
    );
    const done = finishMarket(advanceMarketTo(s, 70));
    const v = getMarketView(done);
    expect(v.account.cash).toBe(MARKET_START_CASH + v.account.realizedPnl);
    expect(v.account.equity).toBe(v.account.cash);
    expect(v.account.holdingsValue).toBe(0);
    expect(v.account.unrealizedPnl).toBe(0);
    expect(v.account.totalReturn).toBe(v.account.realizedPnl);
  });

  it('MKT-78: finishing with no shares just ends the round', () => {
    const done = finishMarket(advanceMarketTo(makeMarket(PRICE), 70));
    expect(done.status).toBe('FINISHED');
    expect(done.trades).toEqual([]);
    expect(lastMarketNotice(done)).toBe('Round finished.');
  });

  it('MKT-79: results are not available until the round is finished', () => {
    const s = advanceMarketTo(makeMarket(PRICE), 70);
    expect(getMarketResults(s)).toBeNull();
    expect(getMarketResults(makeMarket(PRICE))).toBeNull();
  });

  it('MKT-80: results add up: per-stock P&L sums to the total, and liquidations are not counted as player trades', () => {
    let s = makeMarket(PRICE, {
      QLRX: { 20: { open: 11_000, close: 11_000 }, 70: { open: 11_000, close: 12_000 } },
      NVRA: { 12: { open: 9_000, close: 9_000 }, 70: { open: 9_000, close: 8_000 } },
    });
    s = submitMarketOrder(s, 'QLRX', 'BUY', '10');
    s = submitMarketOrder(s, 'NVRA', 'BUY', '10');
    s = advanceMarket(s); // QLRX and NVRA bought at $100 (flat so far)
    s = advanceMarketTo(s, 19);
    s = submitMarketOrder(s, 'QLRX', 'SELL', '4'); // fills at candle 20 open = $110 → +$40 each
    s = advanceMarket(s);
    const done = finishMarket(advanceMarketTo(s, 70));
    const r = getMarketResults(done);
    expect(r).not.toBeNull();
    if (!r) return;
    expect(r.startCash).toBe(MARKET_START_CASH);
    expect(r.finalEquity).toBe(done.portfolio.cash);
    expect(r.totalReturn).toBe(r.finalEquity - MARKET_START_CASH);
    expect(r.realizedPnl).toBe(r.perStock.reduce((a, x) => a + x.realizedPnl, 0));
    expect(r.totalReturn).toBe(r.realizedPnl);
    expect(r.playerTradeCount).toBe(3);
    expect(r.trades).toHaveLength(5);
    expect(r.perStock.find((x) => x.ticker === 'QLRX')).toMatchObject({ tradeCount: 2 });
    expect(r.perStock.find((x) => x.ticker === 'NVRA')).toMatchObject({ tradeCount: 1 });
    // QLRX: 4 sold at $110 (+$40 each) and 6 left at the $120 final close (+$20 each).
    expect(r.perStock.find((x) => x.ticker === 'QLRX')?.realizedPnl).toBe(4 * 1_000 + 6 * 2_000);
    // NVRA: 10 bought at $100 and sold at the $80 final close.
    expect(r.perStock.find((x) => x.ticker === 'NVRA')?.realizedPnl).toBe(10 * -2_000);
  });
});

describe('Replay, determinism and notices', () => {
  it('MKT-81: replay restarts the same market from the beginning, even in the middle of a round', () => {
    let s = createMarketRound(555);
    s = submitMarketOrder(s, 'QLRX', 'BUY', '2');
    s = advanceMarketTo(s, 33);
    s = submitMarketOrder(s, 'NVRA', 'BUY', '1');
    const again = replayMarket(s);
    expect(again).toEqual(createMarketRound(555));
    expect(again.k).toBe(10);
    expect(again.pending).toEqual([]);
    expect(again.trades).toEqual([]);
    expect(again.portfolio.cash).toBe(MARKET_START_CASH);
  });

  it('MKT-82: replay works after the round is finished too', () => {
    const done = finishMarket(advanceMarketTo(createMarketRound(9), 70));
    const again = replayMarket(done);
    expect(again.status).toBe('PLAYING');
    expect(again.k).toBe(10);
  });

  it('MKT-83: the same seed and the same actions always give the same result', () => {
    const play = (): MarketState => {
      let s = createMarketRound(31415);
      s = submitMarketOrder(s, 'TVLM', 'BUY', '7');
      s = advanceMarket(s);
      s = submitMarketOrder(s, 'TVLM', 'SELL', '3');
      s = submitMarketOrder(s, 'VRDW', 'BUY', '9');
      s = advanceMarketTo(s, 70);
      return finishMarket(s);
    };
    expect(play()).toEqual(play());
  });

  it('MKT-84: different seeds give different markets for every stock', () => {
    const a = generateMarket(1);
    const b = generateMarket(2);
    for (const t of TICKERS) expect(a[t]).not.toEqual(b[t]);
  });

  it('MKT-85: only the 20 newest notices are kept, with increasing ids', () => {
    let s = makeMarket(PRICE);
    for (let i = 0; i < 30; i += 1) s = submitMarketOrder(s, 'QLRX', 'BUY', String(i + 1));
    expect(s.notices).toHaveLength(20);
    const ids = s.notices.map((n) => n.id);
    expect(ids).toEqual([...ids].sort((x, y) => x - y));
    expect(new Set(ids).size).toBe(20);
    expect(ids[ids.length - 1]).toBe(30);
  });

  it('MKT-86: cancelling a pending order before the advance means nothing is traded', () => {
    let s = makeMarket(PRICE);
    s = submitMarketOrder(s, 'QLRX', 'BUY', '5');
    s = cancelMarketOrder(s, 'QLRX');
    s = advanceMarket(s);
    expect(s.trades).toEqual([]);
    expect(s.portfolio.cash).toBe(MARKET_START_CASH);
  });
});
