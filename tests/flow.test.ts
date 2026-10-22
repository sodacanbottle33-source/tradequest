// FLOW-01 … FLOW-17 — test-cases.md §5. (FLOW-18/19 are manual UI checks.)
import { describe, expect, it } from 'vitest';
import {
  advance,
  cancelOrder,
  createRound,
  generateCandles,
  getView,
  START_CASH,
  submitOrder,
  type RoundState,
} from '../src/engine';
import { roundCounterLabel } from '../src/ui/labels';
import { assertNoFutureCandles } from './helpers/exposure';
import { advanceTo, makeRound } from './helpers/rounds';

const lastNotice = (s: RoundState) => s.notices[s.notices.length - 1]?.message ?? '';

describe('Round flow and timing (§4)', () => {
  it('FLOW-01: a new round starts at k = 10, PLAYING, with starting cash and nothing else', () => {
    const s = createRound(12345);
    expect(s.k).toBe(10);
    expect(s.status).toBe('PLAYING');
    expect(s.account).toEqual({ cash: START_CASH, shares: 0, costBasis: 0, realizedPnl: 0 });
    expect(s.trades).toHaveLength(0);
    expect(s.pending).toBeNull();
    expect(s.notices).toHaveLength(0);
  });

  it('FLOW-02: the UI-facing view never contains future candles (start and every advance)', () => {
    let s = submitOrder(createRound(12345), 'BUY', '3');
    assertNoFutureCandles(getView(s), s);
    while (s.k < 70) {
      s = submitOrder(advance(s), s.account.shares > 0 ? 'SELL' : 'BUY', '1');
      assertNoFutureCandles(getView(s), s);
    }
  });

  it('FLOW-03: advancing with no order reveals candle 11 and changes only the marks', () => {
    const s0 = createRound(12345);
    const s1 = advance(s0);
    expect(s1.k).toBe(11);
    expect(s1.account).toEqual(s0.account);
    expect(getView(s1).markPrice).toBe(generateCandles(12345)[10]!.close);
  });

  it('FLOW-04 / FLOW-16: exactly 60 advances are possible; the 61st is refused', () => {
    let s = createRound(7);
    let count = 0;
    for (;;) {
      const next = advance(s);
      if (next === s) break;
      s = next;
      count += 1;
    }
    expect(count).toBe(60);
    expect(s.k).toBe(70);
  });

  it('FLOW-05: advance at k = 70 returns the state unchanged', () => {
    const s = advanceTo(createRound(7), 70);
    expect(advance(s)).toBe(s);
  });

  it('FLOW-06: a BUY submitted at k = 10 fills at the open of candle 11', () => {
    const s = advance(submitOrder(makeRound(2500, { 11: { open: 2510, close: 2530 } }), 'BUY', '10'));
    expect(s.trades).toHaveLength(1);
    expect(s.trades[0]!.candleIndex).toBe(11);
    expect(s.trades[0]!.price).toBe(2510);
  });

  it('FLOW-07: for every k in 10–69 the fill price is open(k+1), never close(k)', () => {
    const candles = generateCandles(12345);
    let s = createRound(12345);
    let differing = 0;
    while (s.k < 70) {
      const k = s.k;
      s = submitOrder(s, s.account.shares > 0 ? 'SELL' : 'BUY', '1');
      s = advance(s);
      const trade = s.trades[s.trades.length - 1]!;
      expect(trade.candleIndex).toBe(k + 1);
      expect(trade.price).toBe(candles[k]!.open);
      if (candles[k]!.open !== candles[k - 1]!.close) differing += 1;
    }
    expect(s.trades).toHaveLength(60);
    expect(differing).toBeGreaterThan(30); // the seed really has gaps, so open ≠ previous close is tested
  });

  it('FLOW-08: the order fills at open(k+1) and the mark then moves to close(k+1)', () => {
    const s = advance(submitOrder(makeRound(2500, { 11: { open: 2400, close: 2600 } }), 'BUY', '10'));
    expect(s.trades[0]!.price).toBe(2400);
    const v = getView(s);
    expect(v.markPrice).toBe(2600);
    expect(v.account.unrealizedPnl).toBe(10 * 2600 - 24000);
  });

  it('FLOW-09: an order submitted at k = 69 fills at open(70)', () => {
    const s69 = advanceTo(makeRound(2500, { 70: { open: 2555, close: 2560 } }), 69);
    const s70 = advance(submitOrder(s69, 'BUY', '1'));
    expect(s70.trades[0]!.candleIndex).toBe(70);
    expect(s70.trades[0]!.price).toBe(2555);
  });

  it('FLOW-10: submitting at k = 70 is rejected with "no next candle"', () => {
    const s70 = advanceTo(makeRound(2500), 70);
    const after = submitOrder(s70, 'BUY', '1');
    expect(after.pending).toBeNull();
    expect(lastNotice(after)).toMatch(/No next candle/);
  });

  it('FLOW-11: the pending order is always cleared after an advance (filled or rejected)', () => {
    const filled = advance(submitOrder(makeRound(2500), 'BUY', '1'));
    expect(filled.pending).toBeNull();
    const rejected = advance(submitOrder(makeRound(2000, { 11: { open: 2100 } }), 'BUY', '50'));
    expect(rejected.trades).toHaveLength(0);
    expect(rejected.pending).toBeNull();
  });

  it('FLOW-12: submit, cancel, advance → no fill, account unchanged, "Order cancelled"', () => {
    const s0 = makeRound(2500);
    const cancelled = cancelOrder(submitOrder(s0, 'BUY', '5'));
    expect(lastNotice(cancelled)).toBe('Order cancelled.');
    const s1 = advance(cancelled);
    expect(s1.trades).toHaveLength(0);
    expect(s1.account).toEqual(s0.account);
  });

  it('FLOW-13: BUY 5 then BUY 8 → only BUY 8 fills', () => {
    const s = advance(submitOrder(submitOrder(makeRound(2500), 'BUY', '5'), 'BUY', '8'));
    expect(s.trades).toHaveLength(1);
    expect(s.trades[0]!.quantity).toBe(8);
  });

  it('FLOW-14: at most one player fill per advance (60 per round)', () => {
    let s = createRound(55);
    while (s.k < 70) {
      const before = s.trades.length;
      s = advance(submitOrder(submitOrder(s, 'BUY', '1'), 'BUY', '1'));
      expect(s.trades.length - before).toBeLessThanOrEqual(1);
    }
    expect(s.trades.length).toBeLessThanOrEqual(60);
  });

  it('FLOW-15: the mark price is close(k), at the start and after every advance', () => {
    const candles = generateCandles(999);
    let s = createRound(999);
    expect(getView(s).markPrice).toBe(candles[9]!.close);
    while (s.k < 70) {
      s = advance(s);
      expect(getView(s).markPrice).toBe(candles[s.k - 1]!.close);
    }
  });

  it('FLOW-17: the round counter shows "Candle r of 60" with r = k − 10', () => {
    let s = createRound(3);
    expect(roundCounterLabel(getView(s))).toBe('Round starts next candle');
    s = advance(s);
    expect(roundCounterLabel(getView(s))).toBe('Candle 1 of 60');
    s = advanceTo(s, 70);
    expect(roundCounterLabel(getView(s))).toBe('Candle 60 of 60');
  });
});
