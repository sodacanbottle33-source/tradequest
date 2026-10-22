// MKT-33 … MKT-62 — orders in market mode (docs/rules.md §12.6): validation, one pending order per
// stock, cash that is set aside across stocks, and fills at the next candle's open.
//
// Prices are whole cents. makeMarket(10_000) makes every stock flat at $100.00; the player starts with
// $10,000.00, so exactly 100 shares of one stock can be bought.
import { describe, expect, it } from 'vitest';
import {
  advanceMarket,
  cancelMarketOrder,
  finishMarket,
  getMarketView,
  MARKET_START_CASH,
  submitMarketOrder,
  TICKERS,
  type MarketState,
} from '../src/engine';
import { advanceMarketTo, lastMarketNotice, makeMarket } from './helpers/market';

const PRICE = 10_000; // $100.00

/** A rejected action must change nothing except adding an error notice. */
function expectRejected(before: MarketState, after: MarketState): void {
  expect(after.portfolio).toBe(before.portfolio);
  expect(after.pending).toEqual(before.pending);
  expect(after.trades).toBe(before.trades);
  expect(after.k).toBe(before.k);
  expect(after.nextOrderSeq).toBe(before.nextOrderSeq);
  expect(after.notices.length === before.notices.length + 1 || after.notices.length === 20).toBe(true);
  expect(after.notices[after.notices.length - 1]?.kind).toBe('error');
}

describe('Validation when an order is placed (§12.6)', () => {
  it('MKT-33: an unknown ticker is refused with a clear message', () => {
    const s = makeMarket(PRICE);
    const next = submitMarketOrder(s, 'NOPE', 'BUY', '1');
    expectRejected(s, next);
    expect(lastMarketNotice(next)).toBe('Unknown stock "NOPE".');
    expect(lastMarketNotice(submitMarketOrder(s, 'qlrx', 'BUY', '1'))).toBe('Unknown stock "qlrx".');
  });

  it('MKT-34: bad quantity text is refused and leaves everything unchanged', () => {
    const s = makeMarket(PRICE);
    for (const text of ['0', '-3', '1.5', '', ' ', 'abc', '1e3', '+5', ' 5', '05', '5 ', '1,000']) {
      const next = submitMarketOrder(s, 'QLRX', 'BUY', text);
      expectRejected(s, next);
      expect(lastMarketNotice(next)).toContain('whole number');
    }
  });

  it('MKT-35: more than the maximum order size is refused', () => {
    const s = makeMarket(PRICE);
    for (const text of ['1000001', '99999999', '123456789012345678901234567890']) {
      const next = submitMarketOrder(s, 'QLRX', 'SELL', text);
      expectRejected(s, next);
      expect(lastMarketNotice(next)).toContain('maximum order size');
    }
  });

  it('MKT-36: a buy that costs more than the cash is refused and says how many shares you can afford', () => {
    const s = makeMarket(PRICE);
    const next = submitMarketOrder(s, 'QLRX', 'BUY', '101');
    expectRejected(s, next);
    expect(lastMarketNotice(next)).toContain('Not enough cash');
    expect(lastMarketNotice(next)).toContain('You can afford up to 100 shares of QLRX.');
  });

  it('MKT-37: a buy that costs exactly all the cash is accepted', () => {
    const s = makeMarket(PRICE);
    const next = submitMarketOrder(s, 'QLRX', 'BUY', '100');
    expect(next.pending).toEqual([{ ticker: 'QLRX', side: 'BUY', quantity: 100, submittedAt: 10, seq: 1 }]);
    expect(lastMarketNotice(next)).toBe("Order placed: BUY 100 QLRX. It fills at the next candle's open.");
  });

  it('MKT-38: when not even one share is affordable the message says so', () => {
    let s = makeMarket(PRICE);
    s = submitMarketOrder(s, 'NVRA', 'BUY', '100'); // sets all the cash aside
    const next = submitMarketOrder(s, 'QLRX', 'BUY', '1');
    expectRejected(s, next);
    expect(lastMarketNotice(next)).toContain('You cannot afford even 1 share of QLRX.');
    expect(lastMarketNotice(next)).toContain('already set aside for your other pending buys');
  });

  it('MKT-39: selling a stock you do not hold is refused', () => {
    const s = makeMarket(PRICE);
    const next = submitMarketOrder(s, 'BRLF', 'SELL', '1');
    expectRejected(s, next);
    expect(lastMarketNotice(next)).toBe("You don't hold any shares of BRLF.");
  });

  it('MKT-40: selling more than you hold is refused, and one share is spelled "share"', () => {
    let s = makeMarket(PRICE);
    s = submitMarketOrder(s, 'BRLF', 'BUY', '5');
    s = advanceMarket(s);
    const tooMany = submitMarketOrder(s, 'BRLF', 'SELL', '6');
    expectRejected(s, tooMany);
    expect(lastMarketNotice(tooMany)).toBe('You only hold 5 shares of BRLF.');
    expect(submitMarketOrder(s, 'BRLF', 'SELL', '5').pending).toHaveLength(1);

    let one = makeMarket(PRICE);
    one = advanceMarket(submitMarketOrder(one, 'BRLF', 'BUY', '1'));
    expect(lastMarketNotice(submitMarketOrder(one, 'BRLF', 'SELL', '2'))).toBe('You only hold 1 share of BRLF.');
  });

  it('MKT-41: placing an order does not change cash or shares (nothing is deducted until it fills)', () => {
    const s0 = makeMarket(PRICE);
    const s1 = submitMarketOrder(s0, 'QLRX', 'BUY', '60');
    expect(s1.portfolio).toBe(s0.portfolio);
    expect(s1.portfolio.cash).toBe(MARKET_START_CASH);
    const v = getMarketView(s1);
    expect(v.account.cash).toBe(MARKET_START_CASH);
    expect(v.account.reservedForPendingBuys).toBe(60 * PRICE);
    expect(v.account.availableCash).toBe(MARKET_START_CASH - 60 * PRICE);
    expect(v.stocks.find((x) => x.ticker === 'QLRX')?.pendingEstimate).toBe(60 * PRICE);
  });
});

describe('One pending order per stock (§12.6)', () => {
  it('MKT-42: a new order for the same stock replaces the old one', () => {
    let s = makeMarket(PRICE);
    s = submitMarketOrder(s, 'QLRX', 'BUY', '5');
    s = submitMarketOrder(s, 'QLRX', 'BUY', '8');
    expect(s.pending).toHaveLength(1);
    expect(s.pending[0]?.quantity).toBe(8);
    expect(lastMarketNotice(s)).toBe('Previous order (BUY 5 QLRX) replaced by BUY 8 QLRX.');
  });

  it('MKT-43: orders for different stocks exist side by side, one per stock', () => {
    let s = makeMarket(PRICE);
    for (const t of TICKERS) s = submitMarketOrder(s, t, 'BUY', '1');
    expect(s.pending).toHaveLength(10);
    expect(new Set(s.pending.map((o) => o.ticker)).size).toBe(10);
    expect(s.pending.map((o) => o.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('MKT-44: a sell can replace a buy of the same stock and the other way round', () => {
    let s = makeMarket(PRICE);
    s = advanceMarket(submitMarketOrder(s, 'ZYRA', 'BUY', '10'));
    s = submitMarketOrder(s, 'ZYRA', 'BUY', '3');
    s = submitMarketOrder(s, 'ZYRA', 'SELL', '4');
    expect(s.pending).toEqual([{ ticker: 'ZYRA', side: 'SELL', quantity: 4, submittedAt: 11, seq: 3 }]);
    s = submitMarketOrder(s, 'ZYRA', 'BUY', '2');
    expect(s.pending).toEqual([{ ticker: 'ZYRA', side: 'BUY', quantity: 2, submittedAt: 11, seq: 4 }]);
  });

  it('MKT-45: a refused replacement leaves the old pending order in place', () => {
    let s = makeMarket(PRICE);
    s = submitMarketOrder(s, 'QLRX', 'BUY', '50');
    const next = submitMarketOrder(s, 'QLRX', 'BUY', '101');
    expectRejected(s, next);
    expect(next.pending).toEqual([{ ticker: 'QLRX', side: 'BUY', quantity: 50, submittedAt: 10, seq: 1 }]);
  });

  it('MKT-46: cancelling removes only that stock\'s order', () => {
    let s = makeMarket(PRICE);
    s = submitMarketOrder(s, 'QLRX', 'BUY', '5');
    s = submitMarketOrder(s, 'NVRA', 'BUY', '6');
    const next = cancelMarketOrder(s, 'QLRX');
    expect(next.pending.map((o) => o.ticker)).toEqual(['NVRA']);
    expect(lastMarketNotice(next)).toBe('Order cancelled: BUY 5 QLRX.');
  });

  it('MKT-47: cancelling when there is nothing to cancel changes nothing at all', () => {
    const s = makeMarket(PRICE);
    expect(cancelMarketOrder(s, 'QLRX')).toBe(s);
    expect(cancelMarketOrder(s, 'NOPE')).toBe(s);
  });
});

describe('Cash set aside across stocks (§12.6)', () => {
  it('MKT-48: pending buys cannot promise the same dollars twice', () => {
    let s = makeMarket(PRICE);
    s = submitMarketOrder(s, 'QLRX', 'BUY', '60'); // $6,000
    const tooMuch = submitMarketOrder(s, 'NVRA', 'BUY', '41'); // $4,100 > $4,000 left
    expectRejected(s, tooMuch);
    expect(lastMarketNotice(tooMuch)).toContain('you have $4,000.00 available');
    expect(lastMarketNotice(tooMuch)).toContain('($6,000.00 is already set aside for your other pending buys)');
    expect(lastMarketNotice(tooMuch)).toContain('You can afford up to 40 shares of NVRA.');
    const fits = submitMarketOrder(s, 'NVRA', 'BUY', '40');
    expect(fits.pending).toHaveLength(2);
  });

  it('MKT-49: replacing an order frees its own set-aside cash but not other stocks\'', () => {
    let s = makeMarket(PRICE);
    s = submitMarketOrder(s, 'QLRX', 'BUY', '60');
    s = submitMarketOrder(s, 'NVRA', 'BUY', '40');
    // QLRX may be replaced by up to 60 (its own 60 is free again, NVRA's 40 stays reserved)...
    expect(submitMarketOrder(s, 'QLRX', 'BUY', '60').pending).toHaveLength(2);
    expectRejected(s, submitMarketOrder(s, 'QLRX', 'BUY', '61'));
    // ...and a smaller QLRX order frees cash for NVRA.
    let smaller = submitMarketOrder(s, 'QLRX', 'BUY', '10');
    smaller = submitMarketOrder(smaller, 'NVRA', 'BUY', '90');
    expect(smaller.pending.map((o) => o.quantity)).toEqual([10, 90]);
  });

  it('MKT-50: cancelling a pending buy frees its cash for other stocks', () => {
    let s = makeMarket(PRICE);
    s = submitMarketOrder(s, 'QLRX', 'BUY', '100');
    expectRejected(s, submitMarketOrder(s, 'NVRA', 'BUY', '1'));
    s = cancelMarketOrder(s, 'QLRX');
    expect(submitMarketOrder(s, 'NVRA', 'BUY', '100').pending).toHaveLength(1);
  });

  it('MKT-51: pending SELL orders do not set cash aside and do not add to buying power at placement', () => {
    let s = makeMarket(PRICE);
    s = advanceMarket(submitMarketOrder(s, 'QLRX', 'BUY', '60'));
    expect(s.portfolio.cash).toBe(MARKET_START_CASH - 60 * PRICE);
    s = submitMarketOrder(s, 'QLRX', 'SELL', '60');
    expect(getMarketView(s).account.reservedForPendingBuys).toBe(0);
    // The sale has not happened yet, so it cannot pay for a bigger buy now.
    const next = submitMarketOrder(s, 'NVRA', 'BUY', '41');
    expectRejected(s, next);
    expect(lastMarketNotice(next)).toContain('You can afford up to 40 shares of NVRA.');
  });
});

describe('Filling orders at the next open (§12.6)', () => {
  it('MKT-52: each order fills at the next candle\'s OPEN of its own stock', () => {
    const s0 = makeMarket(PRICE, {
      QLRX: { 11: { open: 10_100, close: 10_200 } },
      NVRA: { 11: { open: 9_500, close: 9_000 } },
    });
    let s = submitMarketOrder(s0, 'QLRX', 'BUY', '10');
    s = submitMarketOrder(s, 'NVRA', 'BUY', '20');
    s = advanceMarket(s);
    expect(s.k).toBe(11);
    expect(s.pending).toEqual([]);
    expect(s.trades.map((t) => [t.ticker, t.price, t.quantity, t.amount, t.candleIndex])).toEqual([
      ['QLRX', 10_100, 10, 101_000, 11],
      ['NVRA', 9_500, 20, 190_000, 11],
    ]);
    expect(s.portfolio.cash).toBe(MARKET_START_CASH - 101_000 - 190_000);
    expect(s.trades.map((t) => t.cashAfter)).toEqual([MARKET_START_CASH - 101_000, MARKET_START_CASH - 291_000]);
    expect(s.trades.map((t) => t.sharesAfter)).toEqual([10, 20]);
  });

  it('MKT-53: advancing with nothing pending changes only the candle', () => {
    const s0 = makeMarket(PRICE);
    const s1 = advanceMarket(s0);
    expect(s1.k).toBe(11);
    expect(s1.portfolio).toBe(s0.portfolio);
    expect(s1.trades).toEqual([]);
  });

  it('MKT-54: an order is used once; the next advance does not fill it again', () => {
    let s = makeMarket(PRICE);
    s = advanceMarket(submitMarketOrder(s, 'QLRX', 'BUY', '5'));
    const cash = s.portfolio.cash;
    s = advanceMarket(s);
    expect(s.portfolio.cash).toBe(cash);
    expect(s.trades).toHaveLength(1);
  });

  it('MKT-55: sells are filled before buys, so a sale can pay for a buy placed earlier', () => {
    const s0 = makeMarket(PRICE, { NVRA: { 12: { open: 11_000, close: 11_000 } } });
    let s = advanceMarket(submitMarketOrder(s0, 'QLRX', 'BUY', '60')); // cash now $4,000
    s = submitMarketOrder(s, 'NVRA', 'BUY', '40'); // $4,000 estimate fits
    s = submitMarketOrder(s, 'QLRX', 'SELL', '60'); // placed AFTER the buy
    s = advanceMarket(s);
    // NVRA opened at $110, so the buy costs $4,400 — more than the $4,000 cash, but the sale ($6,000) is filled first.
    expect(s.trades.map((t) => `${t.side} ${t.ticker} ${t.quantity}`)).toEqual(['BUY QLRX 60', 'SELL QLRX 60', 'BUY NVRA 40']);
    expect(s.portfolio.cash).toBe(MARKET_START_CASH - 40 * 11_000);
    expect(s.portfolio.positions.NVRA?.shares).toBe(40);
    expect(s.portfolio.positions.QLRX?.shares).toBe(0);
  });

  it('MKT-56: buys are filled in the order they were placed', () => {
    const gap = { 11: { open: 11_000, close: 11_000 } };
    const prices = makeMarket(PRICE, { QLRX: gap, NVRA: gap });
    // Both buys together fit at $100 (60 + 40 shares) but not at $110, where only one of them can still be paid for.
    let a = submitMarketOrder(prices, 'QLRX', 'BUY', '60');
    a = advanceMarket(submitMarketOrder(a, 'NVRA', 'BUY', '40'));
    expect(a.trades.map((t) => t.ticker)).toEqual(['QLRX']);
    expect(lastMarketNotice(a)).toBe('Order rejected: NVRA opened at $110.00. BUY 40 NVRA would cost $4,400.00, but you have $3,400.00.');

    let b = submitMarketOrder(prices, 'NVRA', 'BUY', '40');
    b = advanceMarket(submitMarketOrder(b, 'QLRX', 'BUY', '60'));
    expect(b.trades.map((t) => t.ticker)).toEqual(['NVRA']);
    expect(lastMarketNotice(b)).toContain('Order rejected: QLRX opened at $110.00.');
  });

  it('MKT-57: re-placing an order moves it to the back of the queue', () => {
    const gap = { 11: { open: 11_000, close: 11_000 } };
    let s = makeMarket(PRICE, { QLRX: gap, NVRA: gap });
    s = submitMarketOrder(s, 'QLRX', 'BUY', '60');
    s = submitMarketOrder(s, 'NVRA', 'BUY', '40');
    s = submitMarketOrder(s, 'QLRX', 'BUY', '60'); // QLRX is now placed last
    s = advanceMarket(s);
    expect(s.trades.map((t) => t.ticker)).toEqual(['NVRA']);
  });

  it('MKT-58: a buy that no longer fits at the open is rejected, costs nothing and leaves a clear message', () => {
    let s = makeMarket(PRICE, { NVRA: { 11: { open: 10_500, close: 10_500 } } });
    s = submitMarketOrder(s, 'NVRA', 'BUY', '100'); // exactly all the cash at $100
    s = advanceMarket(s);
    expect(s.k).toBe(11);
    expect(s.portfolio.cash).toBe(MARKET_START_CASH);
    expect(s.portfolio.positions.NVRA?.shares).toBe(0);
    expect(s.trades).toEqual([]);
    expect(s.pending).toEqual([]);
    expect(lastMarketNotice(s)).toBe('Order rejected: NVRA opened at $105.00. BUY 100 NVRA would cost $10,500.00, but you have $10,000.00.');
    expect(s.notices[s.notices.length - 1]?.kind).toBe('error');
  });

  it('MKT-59: one rejected buy does not stop the other orders from filling', () => {
    let s = makeMarket(PRICE, { NVRA: { 11: { open: 10_500, close: 10_500 } } });
    s = submitMarketOrder(s, 'QLRX', 'BUY', '50');
    s = submitMarketOrder(s, 'BRLF', 'BUY', '25');
    s = submitMarketOrder(s, 'NVRA', 'BUY', '25'); // 25 × $105 = $2,625 > $2,500 left after the two buys above
    s = advanceMarket(s);
    expect(s.trades.map((x) => x.ticker)).toEqual(['QLRX', 'BRLF']);
    expect(s.portfolio.cash).toBe(MARKET_START_CASH - 75 * PRICE);
    expect(s.notices.some((n) => n.kind === 'error' && n.message.includes('Order rejected: NVRA'))).toBe(true);
  });
});

describe('Edges of the round (§12.6)', () => {
  it('MKT-60: on the final candle no new order is accepted', () => {
    const s = advanceMarketTo(makeMarket(PRICE), 70);
    const next = submitMarketOrder(s, 'QLRX', 'BUY', '1');
    expectRejected(s, next);
    expect(lastMarketNotice(next)).toContain('No next candle');
    expect(advanceMarket(s)).toBe(s);
  });

  it('MKT-61: after the round is finished every action returns the same state object', () => {
    const done = finishMarket(advanceMarketTo(makeMarket(PRICE), 70));
    expect(done.status).toBe('FINISHED');
    expect(submitMarketOrder(done, 'QLRX', 'BUY', '1')).toBe(done);
    expect(cancelMarketOrder(done, 'QLRX')).toBe(done);
    expect(advanceMarket(done)).toBe(done);
    expect(finishMarket(done)).toBe(done);
  });

  it('MKT-62: placing orders never mutates the previous state', () => {
    const s0 = makeMarket(PRICE);
    const copy = JSON.stringify(s0);
    const s1 = submitMarketOrder(s0, 'QLRX', 'BUY', '3');
    cancelMarketOrder(s1, 'QLRX');
    advanceMarket(s1);
    expect(JSON.stringify(s0)).toBe(copy);
  });
});
