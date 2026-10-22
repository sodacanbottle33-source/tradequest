// Stage 1 regression tests — "balance doesn't decrease when I buy" (Bug A) and
// "I can only buy ~$20 worth" (Bug B).
//
// All prices are integer cents. makeRound(price, overrides) builds 70 flat candles at `price`;
// the player starts at k = 10 and the first order can fill at the open of candle 11.
//
// NOTE: Milestone 1 has ONE fictional instrument (QLRX) and one cash balance, so "several stocks
// share one cash balance" is covered here as "several purchases at different prices all draw on
// the same cash balance" (S1-A9). There is no second instrument to test yet.
import { describe, expect, it } from 'vitest';
import {
  advance,
  cancelOrder,
  createRound,
  finishRound,
  getView,
  replayRound,
  START_CASH,
  submitOrder,
  type RoundState,
} from '../src/engine';
import { advanceTo, makeRound } from './helpers/rounds';

const lastNotice = (s: RoundState) => s.notices[s.notices.length - 1]?.message ?? '';

/** The ledger must always balance: cash and shares are exactly what the trade list implies. */
function expectLedgerBalanced(s: RoundState): void {
  const sum = (side: 'BUY' | 'SELL', pick: (t: RoundState['trades'][number]) => number) =>
    s.trades.filter((t) => t.side === side).reduce((acc, t) => acc + pick(t), 0);
  const spent = sum('BUY', (t) => t.amount);
  const received = sum('SELL', (t) => t.amount);
  expect(s.account.cash).toBe(START_CASH - spent + received);
  expect(s.account.shares).toBe(sum('BUY', (t) => t.quantity) - sum('SELL', (t) => t.quantity));
  expect(Number.isInteger(s.account.cash)).toBe(true);
  expect(s.account.cash).toBeGreaterThanOrEqual(0);
  expect(s.account.shares).toBeGreaterThanOrEqual(0);
  const v = getView(s);
  expect(v.account.equity).toBe(v.account.cash + v.account.positionValue);
}

describe('Stage 1 / Bug A — cash accounting for buys and sells', () => {
  it('S1-A1: a filled buy deducts exactly quantity × fill price from cash, and nothing else changes', () => {
    const placed = submitOrder(makeRound(5000), 'BUY', '10');
    const filled = advance(placed);
    expect(filled.account.cash).toBe(START_CASH - 10 * 5000);
    expect(filled.account.shares).toBe(10);
    expect(filled.account.costBasis).toBe(10 * 5000);
    expect(filled.trades).toHaveLength(1);
    expect(filled.trades[0]).toMatchObject({ side: 'BUY', quantity: 10, price: 5000, amount: 50000, cashAfter: 50000 });
    // Flat price: converting cash into shares must not change total equity.
    expect(getView(filled).account.equity).toBe(START_CASH);
    expectLedgerBalanced(filled);
  });

  it('S1-A2: right after PLACING a buy the view shows the money as set aside; settled cash only changes at the fill', () => {
    const placed = getView(submitOrder(makeRound(5000), 'BUY', '10'));
    expect(placed.account.cash).toBe(START_CASH); // settled cash: nothing has been bought yet
    expect(placed.pendingEstimate).toBe(50000); // 10 × last close
    expect(placed.availableCash).toBe(START_CASH - 50000); // what is still free to spend
    expect(placed.account.equity).toBe(START_CASH); // placing an order is not a loss

    const filled = getView(advance(submitOrder(makeRound(5000), 'BUY', '10')));
    expect(filled.account.cash).toBe(50000);
    expect(filled.pendingEstimate).toBe(0);
    expect(filled.availableCash).toBe(filled.account.cash); // nothing pending → available == cash
  });

  it('S1-A3: a pending order is never deducted twice — resubmitting replaces it, and the fill charges once', () => {
    let s = makeRound(5000);
    s = submitOrder(s, 'BUY', '10');
    s = submitOrder(s, 'BUY', '10');
    s = submitOrder(s, 'BUY', '10');
    expect(s.account.cash).toBe(START_CASH); // submitting never touches cash
    expect(getView(s).availableCash).toBe(START_CASH - 50000); // one reservation, not three
    expect(lastNotice(s)).toBe('Previous order (BUY 10) replaced by BUY 10.');
    s = advance(s);
    expect(s.account.cash).toBe(START_CASH - 50000); // charged once
    expect(s.account.shares).toBe(10);
    expect(s.trades).toHaveLength(1);
    expectLedgerBalanced(s);
  });

  it('S1-A3b: a replacement is checked against ALL cash, not against cash minus the order it replaces', () => {
    let s = makeRound(5000); // $1,000 buys 20 shares
    s = submitOrder(s, 'BUY', '15');
    s = submitOrder(s, 'BUY', '20'); // would be refused if the old 15 were deducted first
    expect(s.pending).toMatchObject({ side: 'BUY', quantity: 20 });
    expect(lastNotice(s)).toBe('Previous order (BUY 15) replaced by BUY 20.');
    s = advance(s);
    expect(s.account.cash).toBe(0);
    expect(s.account.shares).toBe(20);
  });

  it('S1-A4: a filled sell adds proceeds to cash at once and books realized P&L', () => {
    let s = makeRound(5000, { 12: { open: 6000, close: 6000 } });
    s = advance(submitOrder(s, 'BUY', '10')); // k = 11, filled at 50.00
    s = advance(submitOrder(s, 'SELL', '10')); // k = 12, filled at 60.00
    expect(s.account.cash).toBe(50000 + 10 * 6000);
    expect(s.account.shares).toBe(0);
    expect(s.account.costBasis).toBe(0);
    expect(s.account.realizedPnl).toBe(10 * (6000 - 5000));
    expect(getView(s).account.equity).toBe(110000);
    expectLedgerBalanced(s);
  });

  it('S1-A5: average entry, unrealized P&L, realized P&L and equity are right after two buys at different prices', () => {
    let s = makeRound(5000, { 12: { open: 6000, close: 6000 } });
    s = advance(submitOrder(s, 'BUY', '8')); // 8 @ 50.00 = 40,000
    s = advance(submitOrder(s, 'BUY', '8')); // 8 @ 60.00 = 48,000
    const a = getView(s).account;
    expect(a.cash).toBe(START_CASH - 40000 - 48000);
    expect(a.shares).toBe(16);
    expect(a.costBasis).toBe(88000);
    expect(a.averageEntry).toBe(5500);
    expect(a.positionValue).toBe(16 * 6000);
    expect(a.unrealizedPnl).toBe(16 * 6000 - 88000);
    expect(a.realizedPnl).toBe(0);
    expect(a.equity).toBe(a.cash + a.positionValue);
    expect(a.totalReturn).toBe(a.equity - START_CASH);
  });

  it('S1-A6: refused, cancelled and rejected orders leave cash, shares, cost basis and P&L untouched', () => {
    const base = makeRound(5000, { 11: { open: 5100 } }); // candle 11 gaps UP to 51.00

    // refused at submission (cannot afford 21 × 50.00)
    const refused = submitOrder(base, 'BUY', '21');
    expect(refused.account).toEqual(base.account);
    expect(refused.pending).toBeNull();
    expect(refused.trades).toHaveLength(0);
    expect(lastNotice(refused)).toMatch(/Not enough cash/);

    // sell with nothing to sell
    const noShares = submitOrder(base, 'SELL', '1');
    expect(noShares.account).toEqual(base.account);
    expect(lastNotice(noShares)).toMatch(/don't hold any shares/);

    // cancelled
    const cancelled = cancelOrder(submitOrder(base, 'BUY', '20'));
    expect(cancelled.account).toEqual(base.account);
    expect(cancelled.pending).toBeNull();
    expect(advance(cancelled).account).toEqual(base.account);

    // accepted at the last close, then rejected at fill because the open gapped up (rule D8)
    const gapped = advance(submitOrder(base, 'BUY', '20')); // 20 × 51.00 = 1,020.00 > 1,000.00
    expect(gapped.account).toEqual(base.account);
    expect(gapped.trades).toHaveLength(0);
    expect(gapped.pending).toBeNull();
    expect(gapped.notices.some((n) => n.kind === 'error' && n.message.startsWith('Order rejected'))).toBe(true);
    expectLedgerBalanced(gapped);
  });

  it('S1-A7: a pending SELL reserves no cash and adds none until it fills', () => {
    let s = advance(submitOrder(makeRound(5000), 'BUY', '10')); // cash 50,000, 10 shares
    s = submitOrder(s, 'SELL', '10');
    const v = getView(s);
    expect(v.account.cash).toBe(50000);
    expect(v.availableCash).toBe(50000); // proceeds are not spendable before they arrive
    expect(v.pendingEstimate).toBe(10 * 5000);
    s = advance(s);
    expect(s.account.cash).toBe(START_CASH);
  });

  it('S1-A8: across whole rounds the cash/share ledger balances after EVERY step', () => {
    for (const seed of [1, 2, 3, 77, 12345, 99999]) {
      let s = createRound(seed);
      while (s.k < 70) {
        const v = getView(s);
        switch ((s.k + seed) % 6) {
          case 0: s = submitOrder(s, 'BUY', String(v.maxBuyQuantity)); break; // all-in
          case 1: s = submitOrder(s, 'BUY', '1'); break;
          case 2: s = submitOrder(s, 'SELL', String(v.maxSellQuantity)); break; // sell everything
          case 3: s = submitOrder(s, 'SELL', String(Math.floor(v.maxSellQuantity / 2) || 1)); break;
          case 4: s = cancelOrder(submitOrder(s, 'BUY', '2')); break;
          default: break; // no order
        }
        s = advance(s);
        expectLedgerBalanced(s);
      }
      s = finishRound(s);
      expectLedgerBalanced(s);
      expect(s.account.shares).toBe(0);
      expect(getView(s).account.equity).toBe(s.account.cash);
    }
  });

  it('S1-A9: several purchases at different prices all draw on the one cash balance', () => {
    let s = makeRound(2500, { 12: { open: 3000, close: 3000 }, 13: { open: 4000, close: 4000 } });
    s = advance(submitOrder(s, 'BUY', '10')); // 10 @ 25.00 = 25,000
    s = advance(submitOrder(s, 'BUY', '10')); // 10 @ 30.00 = 30,000
    s = advance(submitOrder(s, 'BUY', '10')); // 10 @ 40.00 = 40,000
    expect(s.account.cash).toBe(START_CASH - 25000 - 30000 - 40000);
    expect(s.account.shares).toBe(30);
    expect(getView(s).maxBuyQuantity).toBe(Math.floor(5000 / 4000)); // 5,000 left → 1 share at 40.00
    expectLedgerBalanced(s);
  });

  it('S1-A10: finishing a round settles everything; replaying starts clean and plays out identically', () => {
    const play = (start: RoundState): RoundState => {
      let s = advance(submitOrder(start, 'BUY', String(getView(start).maxBuyQuantity)));
      s = advanceTo(s, 40);
      s = advance(submitOrder(s, 'SELL', String(Math.floor(s.account.shares / 2))));
      return finishRound(advanceTo(s, 70));
    };
    const first = play(createRound(2024));
    expectLedgerBalanced(first);
    expect(first.status).toBe('FINISHED');
    expect(first.account.shares).toBe(0);
    expect(getView(first).account.equity).toBe(first.account.cash);

    const replayed = replayRound(first);
    expect(replayed.account).toEqual({ cash: START_CASH, shares: 0, costBasis: 0, realizedPnl: 0 });
    expect(replayed.trades).toHaveLength(0);
    expect(replayed.pending).toBeNull();
    expect(replayed.k).toBe(10);
    expect(getView(replayed).availableCash).toBe(START_CASH);

    const second = play(replayed);
    expectLedgerBalanced(second);
    expect(second.account).toEqual(first.account); // same seed + same moves → same money, to the cent
    expect(second.trades).toEqual(first.trades);
  });
});

describe('Stage 1 / Bug B — order size is limited by cash and whole shares only', () => {
  it('S1-B1: a small order (1 share) fills', () => {
    const s = advance(submitOrder(makeRound(5000), 'BUY', '1'));
    expect(s.account.shares).toBe(1);
    expect(s.account.cash).toBe(START_CASH - 5000);
  });

  it('S1-B2: there is no dollar cap — the Max buy is as many whole shares as cash allows, and it fills', () => {
    for (const price of [101, 500, 999, 2000, 3333, 4920, 5475, 12345, 50000, 99999, 100000]) {
      const round = makeRound(price);
      const v = getView(round);
      const max = Math.floor(START_CASH / price);
      expect(v.maxBuyQuantity).toBe(max);
      expect(v.maxBuyCost).toBe(max * price);
      expect(v.maxBuyCost).toBeLessThanOrEqual(START_CASH);
      expect(v.maxBuyCost + price).toBeGreaterThan(START_CASH); // one more share would not fit

      const filled = advance(submitOrder(round, 'BUY', String(max)));
      expect(filled.account.shares).toBe(max);
      expect(filled.account.cash).toBe(START_CASH - max * price);
      expect(filled.account.cash).toBeLessThan(price); // cash is used up to less than one share
      expectLedgerBalanced(filled);
    }
  });

  it('S1-B3: a large order is not cut down to ~$20 — 50 shares at $20.00 uses the whole $1,000', () => {
    const s = advance(submitOrder(makeRound(2000), 'BUY', '50'));
    expect(s.account.shares).toBe(50);
    expect(s.account.cash).toBe(0);
    expect(s.trades[0]?.amount).toBe(100000);
  });

  it('S1-B4: one share too many is refused up front, with a reason that names the limit', () => {
    const round = makeRound(3333); // max 30 shares (99,990)
    const refused = submitOrder(round, 'BUY', '31');
    expect(refused.pending).toBeNull();
    expect(refused.account).toEqual(round.account);
    expect(lastNotice(refused)).toMatch(/Not enough cash/);
    expect(lastNotice(refused)).toMatch(/\$1,033\.23/); // what 31 shares would cost
    expect(lastNotice(refused)).toMatch(/\$1,000\.00/); // what the player has
    expect(lastNotice(refused)).toMatch(/up to 30 shares/); // what the player CAN do
  });

  it('S1-B5: with too little cash for even one share the reason says so', () => {
    const broke = advance(submitOrder(makeRound(3333), 'BUY', '30')); // leaves $0.10
    const refused = submitOrder(broke, 'BUY', '1');
    expect(refused.pending).toBeNull();
    expect(lastNotice(refused)).toMatch(/Not enough cash/);
    expect(lastNotice(refused)).toMatch(/cannot afford even 1 share/i);
    expect(getView(broke).maxBuyQuantity).toBe(0);
  });

  it('S1-B6: after spending, Max is recalculated from the cash that is left', () => {
    const s = advance(submitOrder(makeRound(5000), 'BUY', '12')); // 60,000 spent → 40,000 left
    expect(getView(s).maxBuyQuantity).toBe(8);
    const again = advance(submitOrder(s, 'BUY', '8'));
    expect(again.account.cash).toBe(0);
    expect(again.account.shares).toBe(20);
  });

  it('S1-B7: purchases on different candles ADD UP (this is how you build a bigger position)', () => {
    let s = makeRound(2000);
    for (let i = 0; i < 5; i += 1) s = advance(submitOrder(s, 'BUY', '10'));
    expect(s.account.shares).toBe(50);
    expect(s.account.cash).toBe(0);
    expectLedgerBalanced(s);
  });

  it('S1-B8: two orders within ONE candle do not add up — the second replaces the first, and the player is told so', () => {
    // This is rule D9. It is what makes "I bought 1 share and then 5 more, but only got 5" look like a cap.
    let s = makeRound(2000);
    s = submitOrder(s, 'BUY', '1');
    s = submitOrder(s, 'BUY', '5');
    expect(lastNotice(s)).toBe('Previous order (BUY 1) replaced by BUY 5.');
    s = advance(s);
    expect(s.account.shares).toBe(5);
  });

  it('S1-B9: Max with a pending order still offers all cash, because a new order REPLACES the pending one', () => {
    const round = makeRound(5000);
    const pending = submitOrder(round, 'BUY', '5');
    expect(getView(pending).maxBuyQuantity).toBe(getView(round).maxBuyQuantity);
    expect(getView(pending).maxBuyQuantity).toBe(20);
  });

  it('S1-B10: a gap-down open buys the same shares for LESS and leaves more cash', () => {
    const s = advance(submitOrder(makeRound(5000, { 11: { open: 4000 } }), 'BUY', '20'));
    expect(s.account.shares).toBe(20);
    expect(s.account.cash).toBe(START_CASH - 20 * 4000);
  });
});
