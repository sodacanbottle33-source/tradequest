// LTR-01 … LTR-24 — buying and selling at the current tick price (docs/rules.md §13.5–13.6).
import { describe, expect, it } from 'vitest';
import {
  advanceLive,
  createLiveSession,
  getLiveView,
  livePrice,
  LIVE_START_CASH,
  liveMarks,
  maxLiveBuy,
  portfolioEquity,
  skipToCandleEnd,
  submitLiveOrder,
  TICKERS,
} from '../src/engine';
import { lastLiveNotice, liveTo, makeLive } from './helpers/live';

const stock = (s: ReturnType<typeof makeLive>, ticker: string) => getLiveView(s).stocks.find((x) => x.ticker === ticker)!;

describe('Filling at the current price (§13.5)', () => {
  it('LTR-01: a buy fills at the price shown right now and updates cash, shares and the trade list', () => {
    const s0 = makeLive({ QLRX: (t) => 2000 + t });
    const s1 = liveTo(s0, 103); // QLRX = 2103
    expect(stock(s1, 'QLRX').price).toBe(2103);
    const s2 = submitLiveOrder(s1, 'QLRX', 'BUY', '10');
    expect(s2.portfolio.cash).toBe(LIVE_START_CASH - 21_030);
    expect(s2.portfolio.positions.QLRX).toEqual({ shares: 10, costBasis: 21_030, realizedPnl: 0 });
    expect(s2.trades).toEqual([
      { id: 1, ticker: 'QLRX', side: 'BUY', tick: 103, candleIndex: 11, quantity: 10, price: 2103, amount: 21_030, tradePnl: null, cashAfter: 78_970, sharesAfter: 10 },
    ]);
    expect(lastLiveNotice(s2)).toBe('Bought 10 QLRX at $21.03. Cost $210.30.');
  });

  it('LTR-02: during an unfinished candle the fill is at that tick\'s price, not at the candle\'s later close', () => {
    // Candle 11 runs ticks 101-110; QLRX climbs 10 cents a tick, so the candle closes at 2100 after starting at 2000.
    const live = makeLive({ QLRX: (t) => (t <= 100 ? 2000 : 2000 + (t - 100) * 10) });
    const midCandle = liveTo(live, 104);
    const bought = submitLiveOrder(midCandle, 'QLRX', 'BUY', '1');
    expect(bought.trades[0]?.price).toBe(2040);
    const finished = skipToCandleEnd(bought);
    expect(livePrice(finished, 'QLRX')).toBe(2100);
    expect(finished.trades[0]?.price).toBe(2040); // history is not rewritten
    expect(finished.trades[0]?.candleIndex).toBe(11);
  });

  it('LTR-03: the price in the view at the moment of an order equals the price of the trade, for every stock and many ticks', () => {
    let s = createLiveSession(2468);
    for (let i = 0; i < 40; i += 1) {
      s = advanceLive(s, 1 + (i % 5));
      for (const ticker of TICKERS) {
        const shown = stock(s, ticker).price;
        const after = submitLiveOrder(s, ticker, 'BUY', '1');
        if (after.trades.length > s.trades.length) expect(after.trades.at(-1)?.price).toBe(shown);
      }
    }
  });

  it('LTR-04: a sell fills at the current price and realises profit against the average cost', () => {
    const live = makeLive({ QLRX: (t) => (t < 105 ? 2000 : 2500) });
    let s = liveTo(live, 100);
    s = submitLiveOrder(s, 'QLRX', 'BUY', '10'); // 10 @ 20.00 = 200.00
    s = liveTo(s, 105);
    s = submitLiveOrder(s, 'QLRX', 'SELL', '4'); // 4 @ 25.00 = 100.00; basis 80.00
    expect(s.trades[1]).toMatchObject({ side: 'SELL', quantity: 4, price: 2500, amount: 10_000, tradePnl: 2_000, sharesAfter: 6 });
    expect(s.portfolio.cash).toBe(LIVE_START_CASH - 20_000 + 10_000);
    expect(s.portfolio.positions.QLRX).toEqual({ shares: 6, costBasis: 12_000, realizedPnl: 2_000 });
  });

  it('LTR-05: buying at several prices keeps the right average cost; selling everything leaves no cost basis', () => {
    const live = makeLive({ QLRX: (t) => (t < 101 ? 1000 : t < 102 ? 1200 : 1100) });
    let s = liveTo(live, 100);
    s = submitLiveOrder(s, 'QLRX', 'BUY', '10'); // 10 @ 10.00
    s = liveTo(s, 101);
    s = submitLiveOrder(s, 'QLRX', 'BUY', '10'); // 10 @ 12.00
    expect(getLiveView(s).stocks.find((x) => x.ticker === 'QLRX')?.position.averageEntry).toBe(1100);
    s = liveTo(s, 102);
    s = submitLiveOrder(s, 'QLRX', 'SELL', '20');
    expect(s.portfolio.positions.QLRX).toEqual({ shares: 0, costBasis: 0, realizedPnl: 0 });
    expect(s.portfolio.cash).toBe(LIVE_START_CASH);
  });

  it('LTR-06: one shared cash balance serves all ten stocks', () => {
    let s = makeLive(1000); // every stock $10.00; cash $1,000.00 = 100 shares in total
    s = submitLiveOrder(s, 'QLRX', 'BUY', '60');
    s = submitLiveOrder(s, 'NVRA', 'BUY', '40');
    expect(s.portfolio.cash).toBe(0);
    s = submitLiveOrder(s, 'BRLF', 'BUY', '1');
    expect(s.portfolio.positions.BRLF?.shares).toBe(0);
    expect(lastLiveNotice(s)).toContain('Not enough cash');
    s = submitLiveOrder(s, 'QLRX', 'SELL', '10');
    s = submitLiveOrder(s, 'BRLF', 'BUY', '10');
    expect(s.portfolio.positions.BRLF?.shares).toBe(10);
  });

  it('LTR-07: trading does not move any price, and the price path is the same with or without trades', () => {
    const trader = (() => {
      let s = createLiveSession(909);
      for (let i = 0; i < 30; i += 1) {
        s = advanceLive(s, 3);
        s = submitLiveOrder(s, TICKERS[i % 10] ?? 'QLRX', i % 4 === 3 ? 'SELL' : 'BUY', String(1 + (i % 3)));
      }
      return s;
    })();
    let idle = createLiveSession(909);
    idle = advanceLive(idle, 90);
    expect(trader.tick).toBe(idle.tick);
    expect(liveMarks(trader)).toEqual(liveMarks(idle));
  });
});

describe('Refused orders change nothing but the message (§13.5)', () => {
  const rich = () => liveTo(makeLive(1000), 100);

  it('LTR-08: not enough cash', () => {
    const s0 = rich();
    const s1 = submitLiveOrder(s0, 'QLRX', 'BUY', '101');
    expect(s1.portfolio).toBe(s0.portfolio);
    expect(s1.trades).toBe(s0.trades);
    expect(lastLiveNotice(s1)).toBe('Not enough cash: 101 QLRX costs $1,010.00 at $10.00, but you have $1,000.00. You can afford up to 100 shares of QLRX.');
  });

  it('LTR-09: cannot afford even one share', () => {
    const s0 = liveTo(makeLive(1000, { startCash: 999 }), 100);
    const s1 = submitLiveOrder(s0, 'QLRX', 'BUY', '1');
    expect(s1.portfolio).toBe(s0.portfolio);
    expect(lastLiveNotice(s1)).toContain('You cannot afford even 1 share of QLRX.');
  });

  it('LTR-10: selling shares you do not hold, or more than you hold', () => {
    const s0 = rich();
    const none = submitLiveOrder(s0, 'QLRX', 'SELL', '1');
    expect(none.portfolio).toBe(s0.portfolio);
    expect(lastLiveNotice(none)).toBe("You don't hold any shares of QLRX.");
    const bought = submitLiveOrder(s0, 'QLRX', 'BUY', '3');
    const tooMany = submitLiveOrder(bought, 'QLRX', 'SELL', '4');
    expect(tooMany.portfolio).toBe(bought.portfolio);
    expect(lastLiveNotice(tooMany)).toBe('You only hold 3 shares of QLRX.');
    expect(lastLiveNotice(submitLiveOrder(submitLiveOrder(s0, 'QLRX', 'BUY', '1'), 'QLRX', 'SELL', '2'))).toBe('You only hold 1 share of QLRX.');
  });

  it('LTR-11: bad quantity text is refused', () => {
    for (const text of ['0', '-3', '1.5', '', ' ', 'abc', '1e3', '+5', ' 5', '05', '1000001']) {
      const s0 = rich();
      const s1 = submitLiveOrder(s0, 'QLRX', 'BUY', text);
      expect(s1.portfolio).toBe(s0.portfolio);
      expect(s1.trades).toBe(s0.trades);
      expect(s1.notices.at(-1)?.kind).toBe('error');
    }
  });

  it('LTR-12: unknown ticker is refused', () => {
    const s0 = rich();
    const s1 = submitLiveOrder(s0, 'NOPE', 'BUY', '1');
    expect(s1.portfolio).toBe(s0.portfolio);
    expect(lastLiveNotice(s1)).toBe('Unknown stock "NOPE".');
  });

  it('LTR-13: after the end of a timed session no order is accepted', () => {
    let s = makeLive(1000, { durationTicks: 20 });
    s = submitLiveOrder(s, 'QLRX', 'BUY', '10');
    s = advanceLive(s, 20);
    expect(s.status).toBe('ENDED');
    const refusedBuy = submitLiveOrder(s, 'QLRX', 'BUY', '1');
    const refusedSell = submitLiveOrder(s, 'QLRX', 'SELL', '1');
    expect(refusedBuy.portfolio).toBe(s.portfolio);
    expect(refusedSell.portfolio).toBe(s.portfolio);
    expect(lastLiveNotice(refusedBuy)).toBe('The session has ended: trading is closed.');
  });
});

describe('"Max" and the account view (§13.6)', () => {
  it('LTR-14: the Max buy quantity is accepted and one more is refused, for every stock at many ticks', () => {
    let s = createLiveSession(1357);
    for (let i = 0; i < 25; i += 1) {
      s = advanceLive(s, 1 + (i % 6));
      for (const ticker of TICKERS) {
        const max = stock(s, ticker).maxBuyQuantity;
        expect(max).toBe(maxLiveBuy(s, ticker));
        if (max >= 1) {
          const ok = submitLiveOrder(s, ticker, 'BUY', String(max));
          expect(ok.trades.length).toBe(s.trades.length + 1);
          expect(ok.portfolio.cash).toBeLessThan(stock(s, ticker).price);
        }
        const tooMany = submitLiveOrder(s, ticker, 'BUY', String(max + 1));
        expect(tooMany.trades.length).toBe(s.trades.length);
      }
    }
  });

  it('LTR-15: the Max sell quantity is the number of shares held', () => {
    let s = makeLive(1000);
    s = submitLiveOrder(s, 'MRDL', 'BUY', '7');
    expect(stock(s, 'MRDL').maxSellQuantity).toBe(7);
    expect(stock(s, 'QLRX').maxSellQuantity).toBe(0);
    expect(stock(s, 'MRDL').maxBuyCost).toBe(stock(s, 'MRDL').maxBuyQuantity * 1000);
  });

  it('LTR-16: net worth = cash + holdings at the current prices; return = net worth − start; both follow every tick', () => {
    let s = makeLive({ QLRX: (t) => 2000 + (t - 100) * 5 });
    s = liveTo(s, 100);
    s = submitLiveOrder(s, 'QLRX', 'BUY', '10');
    for (const t of [101, 105, 110, 133]) {
      s = liveTo(s, t);
      const v = getLiveView(s);
      const price = 2000 + (t - 100) * 5;
      expect(v.account.cash).toBe(LIVE_START_CASH - 20_000);
      expect(v.account.holdingsValue).toBe(10 * price);
      expect(v.account.equity).toBe(LIVE_START_CASH - 20_000 + 10 * price);
      expect(v.account.totalReturn).toBe(10 * price - 20_000);
      expect(v.account.unrealizedPnl).toBe(10 * price - 20_000);
      expect(v.account.equity).toBe(portfolioEquity(s.portfolio, liveMarks(s)));
    }
  });

  it('LTR-17: equity − start = realised + unrealised profit after a mix of trades', () => {
    let s = createLiveSession(86);
    for (let i = 0; i < 60; i += 1) {
      s = advanceLive(s, 2);
      const ticker = TICKERS[(i * 7) % 10] ?? 'QLRX';
      s = submitLiveOrder(s, ticker, i % 3 === 2 ? 'SELL' : 'BUY', String(1 + (i % 4)));
      const a = getLiveView(s).account;
      expect(a.equity - a.startCash).toBe(a.realizedPnl + a.unrealizedPnl);
      expect(a.totalReturn).toBe(a.equity - a.startCash);
    }
  });

  it('LTR-18: tick change and session change in the view', () => {
    const live = makeLive({ QLRX: (t) => (t === 100 ? 1000 : t === 101 ? 1020 : t === 102 ? 990 : 1000) });
    const v100 = stock(live, 'QLRX');
    expect(v100.sessionChange).toBe(0);
    const v101 = stock(liveTo(live, 101), 'QLRX');
    expect(v101).toMatchObject({ price: 1020, previousPrice: 1000, tickChange: 20, sessionOpen: 1000, sessionChange: 20 });
    const v102 = stock(liveTo(live, 102), 'QLRX');
    expect(v102).toMatchObject({ price: 990, previousPrice: 1020, tickChange: -30, sessionChange: -10 });
  });

  it('LTR-19: the start cash option sets the cash, the view and the Max amount', () => {
    const s = makeLive(1000, { startCash: 5_000_000 });
    expect(getLiveView(s).account).toMatchObject({ startCash: 5_000_000, cash: 5_000_000, equity: 5_000_000, totalReturn: 0 });
    expect(maxLiveBuy(s, 'QLRX')).toBe(5000);
    expect(() => makeLive(1000, { startCash: -1 })).toThrow();
    expect(() => makeLive(1000, { startCash: 10.5 })).toThrow();
    expect(makeLive(1000, { startCash: 0 }).portfolio.cash).toBe(0);
  });

  it('LTR-20: trade ids count up and each trade records its own tick and candle', () => {
    let s = makeLive(1000);
    s = submitLiveOrder(s, 'QLRX', 'BUY', '1');
    s = liveTo(s, 109);
    s = submitLiveOrder(s, 'NVRA', 'BUY', '1');
    s = liveTo(s, 110);
    s = submitLiveOrder(s, 'QLRX', 'SELL', '1');
    expect(s.trades.map((t) => [t.id, t.tick, t.candleIndex])).toEqual([
      [1, 100, 11],
      [2, 109, 11],
      [3, 110, 12],
    ]);
  });
});
