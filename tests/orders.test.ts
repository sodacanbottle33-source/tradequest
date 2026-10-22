// ORD-01 … ORD-21 — test-cases.md §6.
import { describe, expect, it } from 'vitest';
import { advance, finishRound, getView, parseQuantity, submitOrder, type RoundState } from '../src/engine';
import { advanceTo, makeRound } from './helpers/rounds';

const lastNotice = (s: RoundState) => s.notices[s.notices.length - 1]?.message ?? '';

/** Round at k = 10 with close(10) = 2500 that already holds 10 shares bought at open(11) = 2500, now at k = 11. */
function holding10(): RoundState {
  return advance(submitOrder(makeRound(2500), 'BUY', '10'));
}

describe('Quantity input (§6.2 rule 2)', () => {
  it('ORD-01 … ORD-05, ORD-21: invalid quantity texts are rejected', () => {
    for (const text of ['0', '-3', '−3', '1.5', '', ' ', 'abc', '1e3', '+5', ' 5', '5 ', '05', '1000001', '99999999999']) {
      expect(parseQuantity(text).ok).toBe(false);
      const s = submitOrder(makeRound(2500), 'BUY', text);
      expect(s.pending).toBeNull();
    }
  });

  it('accepts whole positive numbers up to 1,000,000', () => {
    expect(parseQuantity('1')).toEqual({ ok: true, value: 1 });
    expect(parseQuantity('1000000')).toEqual({ ok: true, value: 1000000 });
  });
});

describe('Validation at submission (§6.2)', () => {
  it('ORD-06: BUY 1 with enough cash is accepted as pending', () => {
    expect(submitOrder(makeRound(2500), 'BUY', '1').pending).toEqual({ side: 'BUY', quantity: 1, submittedAt: 10 });
  });

  it('ORD-07: SELL with 0 shares is rejected', () => {
    const s = submitOrder(makeRound(2500), 'SELL', '1');
    expect(s.pending).toBeNull();
    expect(lastNotice(s)).toMatch(/don't hold any shares/);
  });

  it('ORD-08: SELL more than held is rejected', () => {
    const s = submitOrder(holding10(), 'SELL', '11');
    expect(s.pending).toBeNull();
    expect(lastNotice(s)).toMatch(/only hold 10 shares/);
  });

  it('ORD-09: SELL exactly the shares held is accepted', () => {
    expect(submitOrder(holding10(), 'SELL', '10').pending?.quantity).toBe(10);
  });

  it('ORD-10: BUY whose estimate exceeds cash is rejected', () => {
    const s = submitOrder(makeRound(2500), 'BUY', '41'); // 41 × 2500 = 102500 > 100000
    expect(s.pending).toBeNull();
    expect(lastNotice(s)).toMatch(/Not enough cash/);
  });

  it('ORD-11: BUY whose estimate equals cash is accepted', () => {
    expect(submitOrder(makeRound(2500), 'BUY', '40').pending?.quantity).toBe(40);
  });

  it('ORD-16: submitting after FINISHED changes nothing', () => {
    const finished = finishRound(advanceTo(makeRound(2500), 70));
    expect(submitOrder(finished, 'BUY', '1')).toBe(finished);
  });

  it('ORD-17: the Max buy helper is floor(cash / close(k)), and 0 when cash < close(k)', () => {
    expect(getView(makeRound(3000)).maxBuyQuantity).toBe(33);
    const allIn = advance(submitOrder(makeRound(2500), 'BUY', '40'));
    expect(allIn.account.cash).toBe(0);
    expect(getView(allIn).maxBuyQuantity).toBe(0);
  });

  it('ORD-18: the first order at k = 10 uses close(10) for the estimate', () => {
    const s = makeRound(2500, { 10: { close: 2000 } });
    expect(submitOrder(s, 'BUY', '50').pending?.quantity).toBe(50); // 50 × 2000 = 100000 OK
    expect(submitOrder(s, 'BUY', '51').pending).toBeNull(); //         51 × 2000 = 102000 too much
  });

  it('ORD-19: replacing a pending order shows a replacement notice', () => {
    const s = submitOrder(submitOrder(makeRound(2500), 'BUY', '5'), 'BUY', '8');
    expect(s.pending?.quantity).toBe(8);
    expect(lastNotice(s)).toBe('Previous order (BUY 5) replaced by BUY 8.');
  });

  it('ORD-20: an invalid submission keeps the existing pending order', () => {
    const s = submitOrder(submitOrder(makeRound(2500), 'BUY', '5'), 'BUY', 'abc');
    expect(s.pending).toEqual({ side: 'BUY', quantity: 5, submittedAt: 10 });
  });
});

describe('Validation at fill (§6.3)', () => {
  it('ORD-12: a gap up that makes the BUY unaffordable rejects the whole order', () => {
    const s0 = submitOrder(makeRound(2000, { 11: { open: 2010 } }), 'BUY', '50'); // estimate 100000 = cash
    expect(s0.pending?.quantity).toBe(50);
    const s1 = advance(s0);
    expect(s1.trades).toHaveLength(0);
    expect(s1.account).toEqual(s0.account);
    expect(lastNotice(s1)).toBe(
      'Order rejected: the price opened at $20.10. This order would cost $1,005.00, but you have $1,000.00.',
    );
  });

  it('ORD-13: a BUY costing exactly the cash at fill is filled, leaving 0 cash', () => {
    const s = advance(submitOrder(makeRound(2500), 'BUY', '40'));
    expect(s.trades).toHaveLength(1);
    expect(s.account.cash).toBe(0);
  });

  it('ORD-14: a gap down fills at the lower open', () => {
    const s = advance(submitOrder(makeRound(2500, { 11: { open: 2400 } }), 'BUY', '40'));
    expect(s.trades[0]!.price).toBe(2400);
    expect(s.trades[0]!.amount).toBe(96000);
    expect(s.account.cash).toBe(4000);
  });

  it('ORD-15: a rejected order is not in trade history but appears as a notice', () => {
    const s = advance(submitOrder(makeRound(2000, { 11: { open: 2100 } }), 'BUY', '50'));
    expect(s.trades).toHaveLength(0);
    expect(s.notices.some((n) => n.kind === 'error' && n.message.startsWith('Order rejected'))).toBe(true);
  });
});
