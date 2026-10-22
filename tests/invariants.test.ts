// INV-01 … INV-09, HIST-06, DET-01, FLOW-02 (randomized) and PROP-01 — test-cases.md §11–12.
import { describe, expect, it } from 'vitest';
import {
  candleAt,
  generateCandles,
  getView,
  LAST_INDEX,
  START_CASH,
  type RoundState,
} from '../src/engine';
import { assertNoFutureCandles } from './helpers/exposure';
import { forEachRandomRun, PropertyFailure, replayActions, type Action } from './helpers/property';

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

/** Every invariant from rules.md §7.5, checked after every action. */
function checkInvariants(next: RoundState, prev: RoundState): void {
  const { account: a, trades } = next;
  const v = getView(next);

  // INV-01
  for (const [name, value] of Object.entries(a)) {
    check(Number.isSafeInteger(value), `${name} is not a safe integer: ${value}`);
  }
  check(a.cash >= 0 && a.shares >= 0 && a.costBasis >= 0, `negative value in ${JSON.stringify(a)}`);
  // INV-02
  check((a.shares === 0) === (a.costBasis === 0), `shares/costBasis mismatch ${JSON.stringify(a)}`);
  // INV-03
  check(
    v.account.equity === START_CASH + a.realizedPnl + v.account.unrealizedPnl,
    `equity ${v.account.equity} ≠ start + realized ${a.realizedPnl} + unrealized ${v.account.unrealizedPnl}`,
  );
  // INV-04, INV-05, INV-06
  let cash = START_CASH;
  let shares = 0;
  let realized = 0;
  for (const t of trades) {
    if (t.side === 'BUY') {
      cash -= t.amount;
      shares += t.quantity;
    } else {
      cash += t.amount;
      shares -= t.quantity;
      realized += t.tradePnl ?? Number.NaN;
    }
  }
  check(cash === a.cash, `INV-04: cash ${a.cash} ≠ rebuilt ${cash}`);
  check(shares === a.shares, `INV-05: shares ${a.shares} ≠ rebuilt ${shares}`);
  check(realized === a.realizedPnl, `INV-06: realized ${a.realizedPnl} ≠ Σ tradePnl ${realized}`);
  // INV-07 and HIST-06
  for (const t of trades) {
    if (t.type === 'player') {
      check(t.candleIndex >= 11 && t.candleIndex <= 70, `player trade at candle ${t.candleIndex}`);
      check(t.price === candleAt(next, t.candleIndex).open, `trade ${t.id} price ${t.price} ≠ open`);
    } else {
      check(t.candleIndex === LAST_INDEX, `liquidation at ${t.candleIndex}`);
      check(t.price === candleAt(next, LAST_INDEX).close, `liquidation price ${t.price} ≠ close(70)`);
    }
  }
  // INV-08
  check(next.k >= 10 && next.k <= 70, `k out of range: ${next.k}`);
  // INV-09: if no trade happened (and the round was not reset), the account must be unchanged.
  const reset = next.k < prev.k;
  if (!reset && next.trades.length === prev.trades.length) {
    check(JSON.stringify(next.account) === JSON.stringify(prev.account), 'account changed without a trade');
  }
  // FLOW-14: at most one fill per action.
  if (!reset) check(next.trades.length - prev.trades.length <= 1, 'more than one fill in one action');
}

describe('Invariants under random play (§7.5)', () => {
  it('INV-01 … INV-09, HIST-06, FLOW-14 hold after every action (300 runs × 200 actions)', () => {
    forEachRandomRun({ cases: 300, baseSeed: 20261014, steps: 200 }, checkInvariants);
  });

  it('FLOW-02 (randomized): the view never exposes future candles', () => {
    forEachRandomRun({ cases: 60, baseSeed: 777, steps: 150 }, (next) => assertNoFutureCandles(getView(next), next));
  });

  it('DET-01: candles never depend on player actions (200 seeds)', () => {
    forEachRandomRun({ cases: 200, baseSeed: 4242, steps: 120 }, (next) => {
      check(JSON.stringify(next.candles) === JSON.stringify(generateCandles(next.seed)), 'candles changed');
    });
  });

  it('the random runs actually reach the end of rounds and make trades', () => {
    let finished = 0;
    let liquidations = 0;
    let trades = 0;
    forEachRandomRun({ cases: 100, baseSeed: 99, steps: 200 }, (next, prev) => {
      if (next.status === 'FINISHED' && prev.status === 'PLAYING') {
        finished += 1;
        if (next.trades.some((t) => t.type === 'liquidation')) liquidations += 1;
      }
      if (next.trades.length > prev.trades.length) trades += 1;
    });
    expect(finished).toBeGreaterThan(20);
    expect(liquidations).toBeGreaterThan(5);
    expect(trades).toBeGreaterThan(500);
  });
});

describe('Reproducible failures', () => {
  it('PROP-01: a failure reports the seed and actions, and replayActions reproduces it', () => {
    let failure: PropertyFailure | null = null;
    try {
      forEachRandomRun({ cases: 5, baseSeed: 123, steps: 40 }, (next) => {
        if (next.trades.length > 0) throw new Error('deliberate failure on first trade');
      });
    } catch (err) {
      failure = err as PropertyFailure;
    }
    expect(failure).not.toBeNull();
    const f = failure!;
    expect(f.message).toContain(`market seed ${f.seed}`);
    expect(f.message).toContain(JSON.stringify(f.actions));
    const reproduced = replayActions(f.seed, f.actions as Action[]);
    expect(reproduced.trades.length).toBeGreaterThan(0);
    expect(replayActions(f.seed, f.actions as Action[])).toEqual(reproduced);
  });
});
