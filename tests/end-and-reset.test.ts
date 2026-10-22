// END-01 … END-09, RST-01 … RST-09, DET-02 … DET-04 — test-cases.md §9–11.
import { describe, expect, it } from 'vitest';
import {
  advance,
  cancelOrder,
  createRound,
  ENGINE_VERSION,
  finishRound,
  generateCandles,
  getResults,
  getView,
  replayRound,
  START_CASH,
  submitOrder,
  type RoundState,
} from '../src/engine';
import { randomSeed } from '../src/app/seed';
import reference from './fixtures/reference-v1.json';
import { applyAction, type Action } from './helpers/property';
import { advanceTo, makeRound } from './helpers/rounds';

/** Holds 10 shares bought at 2500, sitting at k = 70 with close(70) = 2600. */
function atEndHolding10(): RoundState {
  const s = advance(submitOrder(makeRound(2500, { 70: { close: 2600 } }), 'BUY', '10'));
  return advanceTo(s, 70);
}

describe('End of round (§4.5–4.6)', () => {
  it('END-01 / END-09: finishing with shares sells all at close(70) as a liquidation trade', () => {
    const s = finishRound(atEndHolding10());
    const last = s.trades[s.trades.length - 1]!;
    expect(last).toEqual({
      id: 2,
      type: 'liquidation',
      side: 'SELL',
      candleIndex: 70,
      quantity: 10,
      price: 2600,
      amount: 26000,
      tradePnl: 1000,
      cashAfter: 101000,
      sharesAfter: 0,
    });
    expect(s.account.shares).toBe(0);
    expect(s.account.costBasis).toBe(0);
    expect(s.status).toBe('FINISHED');
  });

  it('END-02: finishing with no shares records no liquidation trade', () => {
    const s = finishRound(advanceTo(makeRound(2500), 70));
    expect(s.trades).toHaveLength(0);
    expect(s.status).toBe('FINISHED');
  });

  it('END-03 / END-04: equity is identical before and after liquidation', () => {
    const before = atEndHolding10();
    const equityBefore = getView(before).account.equity;
    const after = finishRound(before);
    const v = getView(after);
    expect(v.account.equity).toBe(equityBefore);
    expect(v.account.unrealizedPnl).toBe(0);
    expect(v.account.equity).toBe(after.account.cash);
    expect(after.account.cash).toBe(START_CASH + after.account.realizedPnl);
  });

  it('END-05: finishing twice changes nothing', () => {
    const once = finishRound(atEndHolding10());
    expect(finishRound(once)).toBe(once);
  });

  it('END-06: finish before k = 70 is not allowed', () => {
    const s = advanceTo(makeRound(2500), 69);
    expect(finishRound(s)).toBe(s);
  });

  it('END-07: after FINISHED, submit, cancel and advance all leave the state unchanged', () => {
    const s = finishRound(atEndHolding10());
    expect(submitOrder(s, 'BUY', '1')).toBe(s);
    expect(cancelOrder(s)).toBe(s);
    expect(advance(s)).toBe(s);
  });

  it('END-08: results data', () => {
    const playing = atEndHolding10();
    expect(getResults(playing)).toBeNull();
    const r = getResults(finishRound(playing))!;
    expect(r.seed).toBe(42);
    expect(r.engineVersion).toBe(ENGINE_VERSION);
    expect(r.finalEquity).toBe(101000);
    expect(r.totalReturn).toBe(1000);
    expect(r.realizedPnl).toBe(1000);
    expect(r.playerTradeCount).toBe(1);
    expect(r.trades).toHaveLength(2);
  });
});

describe('Reset and replay (§8–9)', () => {
  it('RST-01 / RST-05: a new round after trading starts clean (no trades, pending order or notices)', () => {
    let s = submitOrder(advance(submitOrder(createRound(5), 'BUY', '3')), 'BUY', '1');
    expect(s.pending).not.toBeNull();
    s = createRound(6);
    expect(s.k).toBe(10);
    expect(s.trades).toHaveLength(0);
    expect(s.pending).toBeNull();
    expect(s.notices).toHaveLength(0);
    expect(s.account.cash).toBe(START_CASH);
  });

  it('RST-02 / RST-09: new rounds take their seed from crypto.getRandomValues (stubbed here)', () => {
    const fake = {
      getRandomValues(array: Uint32Array<ArrayBuffer>) {
        array[0] = 0xdeadbeef;
        return array;
      },
    };
    const seed = randomSeed(fake);
    expect(seed).toBe(3735928559);
    expect(createRound(seed).seed).toBe(3735928559);
    const real = randomSeed();
    expect(Number.isInteger(real) && real >= 0 && real <= 0xffffffff).toBe(true);
  });

  it('RST-03 / RST-04 / RST-06: replay gives identical candles regardless of trades, from PLAYING or FINISHED', () => {
    let s = advance(submitOrder(createRound(31415), 'BUY', '5'));
    s = advanceTo(s, 70);
    const replayed = replayRound(finishRound(s));
    expect(replayed.status).toBe('PLAYING');
    expect(replayed.k).toBe(10);
    expect(replayed.trades).toHaveLength(0);
    expect(replayed.candles).toEqual(s.candles);
    expect(replayed.candles).toEqual(generateCandles(31415));
    expect(replayRound(s).candles).toEqual(createRound(31415).candles);
  });
});

describe('Determinism (§5.5)', () => {
  const script: Action[] = [
    { type: 'submit', side: 'BUY', qty: '7' },
    { type: 'advance' },
    { type: 'advance' },
    { type: 'submit', side: 'SELL', qty: '3' },
    { type: 'advance' },
    { type: 'submit', side: 'BUY', qty: '2' },
    { type: 'cancel' },
    { type: 'advance' },
  ];

  it('DET-02: waiting between clicks changes nothing', async () => {
    const fast = script.reduce(applyAction, createRound(2718));
    let slow = createRound(2718);
    for (const a of script) {
      await new Promise((r) => setTimeout(r, 3));
      slow = applyAction(slow, a);
    }
    expect(slow).toEqual(fast);
  });

  it('DET-03: same seed + same actions → identical final account and history', () => {
    const a = script.reduce(applyAction, createRound(1618));
    const b = script.reduce(applyAction, createRound(1618));
    expect(a).toEqual(b);
  });

  it('DET-04: the engine version is recorded with the round and matches the golden fixture', () => {
    expect(createRound(1).engineVersion).toBe(ENGINE_VERSION);
    expect(reference.engineVersion).toBe(ENGINE_VERSION);
  });
});
