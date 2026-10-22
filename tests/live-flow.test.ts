// LFL-01 … LFL-20 — starting, moving through time, ending and resetting a live session (docs/rules.md §13.4).
import { describe, expect, it } from 'vitest';
import {
  advanceLive,
  createLiveSession,
  getLiveView,
  LIVE_ENGINE_VERSION,
  LIVE_HISTORY_TICKS,
  LIVE_START_CASH,
  liveMarks,
  resetLive,
  skipToCandleEnd,
  submitLiveOrder,
  ticksToCandleEnd,
  TICKERS,
} from '../src/engine';
import { assertNoFutureLive, liveTo, makeLive } from './helpers/live';

describe('A new session (§13.4)', () => {
  it('LFL-01: starts at tick 100 with $1,000, no shares, no trades, running and open-ended', () => {
    const s = createLiveSession(12345);
    expect(s).toMatchObject({ engineVersion: LIVE_ENGINE_VERSION, seed: 12345, startTick: 100, tick: 100, endTick: null, status: 'RUNNING', startCash: LIVE_START_CASH });
    expect(s.portfolio.cash).toBe(100_000);
    expect(TICKERS.every((t) => s.portfolio.positions[t]?.shares === 0)).toBe(true);
    expect(s.trades).toEqual([]);
    expect(s.notices).toEqual([]);
    expect(LIVE_HISTORY_TICKS).toBe(100);
  });

  it('LFL-02: the view of a new session: tick, candle, ticks into candle, nothing remaining', () => {
    const v = getLiveView(createLiveSession(1));
    expect(v).toMatchObject({ status: 'RUNNING', tick: 100, sessionTick: 0, candleIndex: 11, ticksIntoCandle: 0, ticksPerCandle: 10, ticksRemaining: null, canTrade: true, canAdvance: true });
    expect(v.account).toMatchObject({ cash: 100_000, holdingsValue: 0, equity: 100_000, totalReturn: 0, realizedPnl: 0, unrealizedPnl: 0 });
    expect(v.stocks).toHaveLength(10);
  });

  it('LFL-03: two sessions from the same seed show the same prices; different seeds differ', () => {
    expect(liveMarks(createLiveSession(77))).toEqual(liveMarks(createLiveSession(77)));
    expect(liveMarks(createLiveSession(77))).not.toEqual(liveMarks(createLiveSession(78)));
  });
});

describe('Moving through time (§13.4)', () => {
  it('LFL-04: advancing one tick produces exactly one tick', () => {
    let s = createLiveSession(5);
    for (let i = 1; i <= 25; i += 1) {
      const next = advanceLive(s);
      expect(next.tick).toBe(s.tick + 1);
      expect(getLiveView(next).sessionTick).toBe(i);
      s = next;
    }
  });

  it('LFL-05: advancing by n moves exactly n ticks and equals n single steps', () => {
    const a = advanceLive(createLiveSession(9), 37);
    let b = createLiveSession(9);
    for (let i = 0; i < 37; i += 1) b = advanceLive(b);
    expect(a.tick).toBe(137);
    expect(liveMarks(a)).toEqual(liveMarks(b));
    expect(getLiveView(a)).toEqual(getLiveView(b));
  });

  it('LFL-06: the route taken to a tick (steps, skips, jumps) does not change the prices or any candle', () => {
    const jump = advanceLive(createLiveSession(321), 63);
    let route = createLiveSession(321);
    route = advanceLive(route, 1);
    route = skipToCandleEnd(route); // 100 -> 110
    route = advanceLive(route, 5);
    route = skipToCandleEnd(route); // 115 -> 120
    route = advanceLive(route, 3);
    route = advanceLive(route, 40);
    expect(route.tick).toBe(jump.tick);
    expect(getLiveView(route)).toEqual(getLiveView(jump));
  });

  it('LFL-07: skip runs to the end of the forming candle, or one whole candle when a new one has just begun', () => {
    expect(ticksToCandleEnd(100)).toBe(10);
    expect(ticksToCandleEnd(101)).toBe(9);
    expect(ticksToCandleEnd(109)).toBe(1);
    expect(ticksToCandleEnd(110)).toBe(10);
    const start = createLiveSession(2);
    expect(skipToCandleEnd(start).tick).toBe(110);
    expect(skipToCandleEnd(advanceLive(start, 3)).tick).toBe(110);
    expect(skipToCandleEnd(advanceLive(start, 9)).tick).toBe(110);
    expect(skipToCandleEnd(advanceLive(start, 10)).tick).toBe(120);
  });

  it('LFL-08: a bad tick count is refused', () => {
    const s = createLiveSession(1);
    for (const n of [0, -1, 1.5, NaN, Infinity]) expect(() => advanceLive(s, n)).toThrow();
  });

  it('LFL-09: advancing never changes cash or shares', () => {
    let s = makeLive(1000);
    s = submitLiveOrder(s, 'QLRX', 'BUY', '5');
    const after = advanceLive(s, 50);
    expect(after.portfolio).toBe(s.portfolio);
    expect(after.trades).toBe(s.trades);
  });

  it('LFL-10: the state before an advance is not modified (the engine is pure)', () => {
    const s = createLiveSession(4);
    const frozen = JSON.stringify(getLiveView(s));
    advanceLive(s, 30);
    submitLiveOrder(s, 'QLRX', 'BUY', '1');
    expect(JSON.stringify(getLiveView(s))).toBe(frozen);
    expect(s.tick).toBe(100);
  });
});

describe('Timed sessions (§13.1 L7)', () => {
  it('LFL-11: a timed session knows its end tick and the ticks remaining', () => {
    const s = createLiveSession(8, { durationTicks: 180 });
    expect(s.endTick).toBe(280);
    expect(getLiveView(s).ticksRemaining).toBe(180);
    expect(getLiveView(advanceLive(s, 30)).ticksRemaining).toBe(150);
  });

  it('LFL-12: the session ends exactly at the end tick and does not move afterwards', () => {
    let s = createLiveSession(8, { durationTicks: 25 });
    s = advanceLive(s, 24);
    expect(s.status).toBe('RUNNING');
    s = advanceLive(s);
    expect(s).toMatchObject({ tick: 125, status: 'ENDED' });
    expect(advanceLive(s)).toBe(s);
    expect(advanceLive(s, 10)).toBe(s);
    expect(skipToCandleEnd(s)).toBe(s);
  });

  it('LFL-13: a jump past the end stops at the end', () => {
    const s = advanceLive(createLiveSession(8, { durationTicks: 25 }), 1000);
    expect(s).toMatchObject({ tick: 125, status: 'ENDED' });
    expect(getLiveView(s)).toMatchObject({ ticksRemaining: 0, canTrade: false, canAdvance: false });
  });

  it('LFL-14: skip near the end is cut short by the end', () => {
    const s = skipToCandleEnd(advanceLive(createLiveSession(8, { durationTicks: 4 }), 2));
    expect(s).toMatchObject({ tick: 104, status: 'ENDED' });
  });

  it('LFL-15: the final net worth is cash + shares at the final tick price (no forced sale)', () => {
    let s = makeLive({ QLRX: (t) => 2000 + (t - 100) * 10 }, { durationTicks: 20 });
    s = submitLiveOrder(s, 'QLRX', 'BUY', '10');
    s = advanceLive(s, 20);
    const a = getLiveView(s).account;
    expect(s.portfolio.positions.QLRX?.shares).toBe(10);
    expect(a.equity).toBe(100_000 - 20_000 + 10 * 2200);
    expect(a.totalReturn).toBe(2_000);
  });

  it('LFL-16: duration must be a whole number of ticks, 1 or more', () => {
    for (const d of [0, -5, 2.5, NaN]) expect(() => createLiveSession(1, { durationTicks: d })).toThrow();
  });
});

describe('Reset (§13.4)', () => {
  it('LFL-17: reset returns to tick 100 with all cash and no trades, and shows the same prices as before', () => {
    const fresh = createLiveSession(606);
    let s = advanceLive(fresh, 47);
    s = submitLiveOrder(s, 'NVRA', 'BUY', '1');
    const again = resetLive(s);
    expect(again.tick).toBe(100);
    expect(again.portfolio.cash).toBe(100_000);
    expect(again.trades).toEqual([]);
    expect(getLiveView(again)).toEqual(getLiveView(fresh));
    expect(getLiveView(advanceLive(again, 47)).stocks.map((x) => x.price)).toEqual(getLiveView(advanceLive(fresh, 47)).stocks.map((x) => x.price));
  });

  it('LFL-18: reset of a timed session starts it again; of an ended one makes it run', () => {
    let s = advanceLive(createLiveSession(3, { durationTicks: 10 }), 10);
    expect(s.status).toBe('ENDED');
    s = resetLive(s);
    expect(s).toMatchObject({ status: 'RUNNING', tick: 100, endTick: 110 });
  });

  it('LFL-19: reset keeps a custom start cash', () => {
    const s = resetLive(submitLiveOrder(makeLive(1000, { startCash: 7_777_00 }), 'QLRX', 'BUY', '5'));
    expect(s.portfolio.cash).toBe(777_700);
    expect(s.startCash).toBe(777_700);
  });
});

describe('What the screen may see (§13.7)', () => {
  it('LFL-20: nothing after the current tick is reachable from the view — including after trades and at the end', () => {
    let s = createLiveSession(1999, { durationTicks: 60 });
    for (let i = 0; i < 12; i += 1) {
      s = advanceLive(s, 5);
      s = submitLiveOrder(s, TICKERS[i % 10] ?? 'QLRX', 'BUY', '1');
      assertNoFutureLive(getLiveView(s), s);
    }
    expect(s.status).toBe('ENDED');
    expect(() => liveTo(s, 50)).toThrow(); // helper refuses to go back in time
  });
});
