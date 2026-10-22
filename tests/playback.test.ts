// PLB-01 … PLB-22 — play, pause, step, skip, speed and trading while the market runs
// (docs/rules.md §13.9). A fake timer stands in for the browser's, so "10 seconds" costs no time.
import { describe, expect, it } from 'vitest';
import { LiveController, type LiveSnapshot } from '../src/app/liveController';
import { BASE_TICK_MS, isSpeed, SPEEDS, tickIntervalMs } from '../src/app/playback';
import { createLiveSession, createTickMarket, LIVE_START_CASH, TICKERS } from '../src/engine';
import { FakeScheduler } from './helpers/scheduler';

function setup(options: { seed?: number; durationTicks?: number } = {}) {
  const scheduler = new FakeScheduler();
  const controller = new LiveController(
    createLiveSession(options.seed ?? 12345, options.durationTicks === undefined ? {} : { durationTicks: options.durationTicks }),
    scheduler,
  );
  const seen: LiveSnapshot[] = [];
  controller.subscribe(() => seen.push(controller.getSnapshot()));
  return { scheduler, controller, seen };
}

const tickOf = (c: LiveController): number => c.getSnapshot().view.tick;
const priceOf = (c: LiveController, ticker: string): number => c.getSnapshot().view.stocks.find((s) => s.ticker === ticker)!.price;

describe('Timing constants', () => {
  it('PLB-01: one tick per second at 1×, two at 2×, four at 4×', () => {
    expect(BASE_TICK_MS).toBe(1000);
    expect(SPEEDS).toEqual([1, 2, 4]);
    expect(SPEEDS.map(tickIntervalMs)).toEqual([1000, 500, 250]);
    expect([1, 2, 4, 3, 0, 8, 0.5].map(isSpeed)).toEqual([true, true, true, false, false, false, false]);
  });
});

describe('Play and pause', () => {
  it('PLB-02: the market starts paused and nothing moves however long you wait', () => {
    const { scheduler, controller } = setup();
    expect(controller.getSnapshot()).toMatchObject({ playing: false, speed: 1, canStep: true });
    scheduler.advance(60_000);
    expect(tickOf(controller)).toBe(100);
    expect(scheduler.activeTimers).toBe(0);
  });

  it('PLB-03: playing at 1× gives exactly one tick per second', () => {
    const { scheduler, controller } = setup();
    controller.play();
    scheduler.advance(999);
    expect(tickOf(controller)).toBe(100);
    scheduler.advance(1);
    expect(tickOf(controller)).toBe(101);
    scheduler.advance(9_000);
    expect(tickOf(controller)).toBe(110);
  });

  it('PLB-04: 2× and 4× give two and four ticks per second', () => {
    for (const [speed, perSecond] of [[2, 2], [4, 4]] as const) {
      const { scheduler, controller } = setup();
      controller.setSpeed(speed);
      controller.play();
      scheduler.advance(10_000);
      expect(tickOf(controller)).toBe(100 + 10 * perSecond);
    }
  });

  it('PLB-05: pausing stops the market; resuming carries on from the same tick', () => {
    const { scheduler, controller } = setup();
    controller.play();
    scheduler.advance(3_000);
    controller.pause();
    const frozen = controller.getSnapshot();
    expect(frozen.playing).toBe(false);
    scheduler.advance(30_000);
    expect(tickOf(controller)).toBe(103);
    expect(controller.getSnapshot()).toBe(frozen); // not even a re-render
    controller.play();
    scheduler.advance(2_000);
    expect(tickOf(controller)).toBe(105);
  });

  it('PLB-06: pressing Play twice does not double the speed', () => {
    const { scheduler, controller } = setup();
    controller.play();
    controller.play();
    expect(scheduler.activeTimers).toBe(1);
    scheduler.advance(5_000);
    expect(tickOf(controller)).toBe(105);
  });

  it('PLB-07: pausing twice, or pausing while paused, is harmless', () => {
    const { controller, seen } = setup();
    controller.pause();
    expect(seen).toHaveLength(0);
    controller.play();
    controller.pause();
    controller.pause();
    expect(seen).toHaveLength(2);
  });
});

describe('Step and skip', () => {
  it('PLB-08: Step moves exactly one tick while paused', () => {
    const { controller } = setup();
    for (let i = 1; i <= 12; i += 1) {
      expect(controller.step()).toBe(true);
      expect(tickOf(controller)).toBe(100 + i);
    }
  });

  it('PLB-09: Step and Skip do nothing while the market is playing', () => {
    const { scheduler, controller } = setup();
    controller.play();
    expect(controller.getSnapshot().canStep).toBe(false);
    expect(controller.step()).toBe(false);
    expect(controller.skip()).toBe(false);
    expect(tickOf(controller)).toBe(100);
    scheduler.advance(1_000);
    expect(tickOf(controller)).toBe(101);
  });

  it('PLB-10: Skip runs to the end of the forming candle, or a whole new candle if it just began', () => {
    const { controller } = setup();
    controller.step();
    controller.step();
    controller.skip();
    expect(tickOf(controller)).toBe(110);
    controller.skip();
    expect(tickOf(controller)).toBe(120);
  });

  it('PLB-11: a stepped market shows the same prices as the engine at those ticks', () => {
    const { controller } = setup({ seed: 777 });
    const market = createTickMarket(777);
    for (let i = 0; i < 25; i += 1) {
      controller.step();
      for (const t of TICKERS) expect(priceOf(controller, t)).toBe(market.priceAt(t, tickOf(controller)));
    }
  });
});

describe('Speed changes do not change the prices', () => {
  /** Every (tick, prices) pair the screen showed while a script of play/pause/speed changes ran. */
  function shownPrices(script: (c: LiveController, s: FakeScheduler) => void, seed = 31415) {
    const { scheduler, controller, seen } = setup({ seed });
    script(controller, scheduler);
    return seen.map((snap) => [snap.view.tick, ...snap.view.stocks.map((x) => x.price)]);
  }

  it('PLB-12: whatever the speed, every price shown is the engine\'s price for that tick', () => {
    const market = createTickMarket(31415);
    const rows = shownPrices((c, s) => {
      c.play();
      s.advance(5_000);
      c.setSpeed(4);
      s.advance(5_000);
      c.setSpeed(2);
      s.advance(5_000);
      c.pause();
      c.step();
      c.skip();
      c.setSpeed(1);
      c.play();
      s.advance(8_000);
    });
    expect(rows.length).toBeGreaterThan(45);
    for (const row of rows) {
      const [tick, ...prices] = row as [number, ...number[]];
      expect(prices).toEqual(TICKERS.map((t) => market.priceAt(t, tick)));
    }
  });

  it('PLB-13: the same number of ticks gives the same market at 1×, 2×, 4× and stepping by hand', () => {
    const at = (speed: 1 | 2 | 4, seconds: number) => {
      const { scheduler, controller } = setup({ seed: 2718 });
      controller.setSpeed(speed);
      controller.play();
      scheduler.advance(seconds * 1000);
      return controller.getSnapshot().view;
    };
    const slow = at(1, 40);
    const medium = at(2, 20);
    const fast = at(4, 10);
    const manual = (() => {
      const { controller } = setup({ seed: 2718 });
      for (let i = 0; i < 40; i += 1) controller.step();
      return controller.getSnapshot().view;
    })();
    expect(slow.tick).toBe(140);
    expect(medium).toEqual(slow);
    expect(fast).toEqual(slow);
    expect(manual).toEqual(slow);
  });

  it('PLB-14: changing speed while playing restarts the timer at the new rate, without losing or repeating a tick', () => {
    const { scheduler, controller, seen } = setup();
    controller.play();
    scheduler.advance(2_000); // ticks 101, 102
    controller.setSpeed(4);
    expect(scheduler.activeTimers).toBe(1);
    scheduler.advance(1_000); // four more
    expect(tickOf(controller)).toBe(106);
    const ticks = seen.map((s) => s.view.tick);
    // Time only goes forward, and every tick from 100 to 106 was shown: none lost, none skipped.
    expect(ticks).toEqual([...ticks].sort((a, b) => a - b));
    expect([...new Set(ticks)]).toEqual([100, 101, 102, 103, 104, 105, 106]);
    expect(ticks.filter((t) => t === 104)).toHaveLength(1); // ...and none shown twice by a tick
  });

  it('PLB-15: setting the same speed again does nothing; an impossible speed is refused', () => {
    const { controller, seen } = setup();
    controller.setSpeed(1);
    expect(seen).toHaveLength(0);
    expect(() => controller.setSpeed(3 as never)).toThrow();
    expect(() => controller.setSpeed(0 as never)).toThrow();
  });
});

describe('Candles form while the market plays', () => {
  it('PLB-16: a new candle appears automatically every 10 ticks and the forming one changes every tick', () => {
    const { scheduler, controller } = setup();
    controller.play();
    const counts: number[] = [];
    const forming: number[] = [];
    for (let i = 0; i < 35; i += 1) {
      scheduler.advance(1_000);
      const stock = controller.getSnapshot().view.stocks[0]!;
      counts.push(stock.candles.length);
      forming.push(stock.candles.at(-1)!.ticks);
    }
    expect(counts[0]).toBe(11);
    expect(counts[9]).toBe(12);
    expect(counts[19]).toBe(13);
    expect(counts[29]).toBe(14);
    expect(counts[34]).toBe(14);
    expect(forming.slice(0, 12)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 1, 2]);
  });
});

describe('Trading while the market runs', () => {
  it('PLB-17: a buy while playing fills at the price on screen at that moment', () => {
    const { scheduler, controller } = setup({ seed: 99 });
    controller.play();
    scheduler.advance(4_300);
    const shown = priceOf(controller, 'QLRX');
    controller.order('QLRX', 'BUY', '3');
    const trade = controller.peekStateForTests().trades[0]!;
    expect(trade).toMatchObject({ tick: 104, price: shown, quantity: 3 });
    expect(controller.getSnapshot().view.trades[0]).toEqual(trade);
    expect(tickOf(controller)).toBe(104); // trading does not move time
    expect(controller.getSnapshot().playing).toBe(true);
  });

  it('PLB-18: trading works while paused, at the price of the tick it is paused on', () => {
    const { controller } = setup({ seed: 99 });
    controller.step();
    controller.step();
    const shown = priceOf(controller, 'MRDL');
    controller.order('MRDL', 'BUY', '2');
    expect(controller.getSnapshot().view.trades[0]).toMatchObject({ tick: 102, price: shown });
  });

  it('PLB-19: the chart, cash and holdings stay in step after every tick and trade', () => {
    const { scheduler, controller, seen } = setup({ seed: 5 });
    controller.play();
    controller.setSpeed(4);
    for (let i = 0; i < 30; i += 1) {
      scheduler.advance(250);
      controller.order(TICKERS[i % 10] ?? 'QLRX', i % 4 === 3 ? 'SELL' : 'BUY', String(1 + (i % 3)));
    }
    for (const snap of seen) {
      const v = snap.view;
      const holdings = v.stocks.reduce((a, s) => a + s.position.shares * s.price, 0);
      expect(v.account.holdingsValue).toBe(holdings);
      expect(v.account.equity).toBe(v.account.cash + holdings);
      for (const s of v.stocks) {
        expect(s.candles.at(-1)?.close).toBe(s.price);
        expect(s.candles.length).toBe(Math.floor(v.tick / 10) + 1);
      }
      let cash = LIVE_START_CASH;
      for (const t of v.trades) cash += t.side === 'BUY' ? -t.amount : t.amount;
      expect(v.account.cash).toBe(cash);
    }
  });

  it('PLB-20: all trades are filled at the engine\'s own price for the tick they happened on', () => {
    const { scheduler, controller } = setup({ seed: 2024 });
    const market = createTickMarket(2024);
    controller.play();
    controller.setSpeed(2);
    for (let i = 0; i < 40; i += 1) {
      scheduler.advance(500);
      controller.order(TICKERS[(i * 3) % 10] ?? 'QLRX', 'BUY', '1');
    }
    const trades = controller.getSnapshot().view.trades;
    expect(trades.length).toBeGreaterThan(20);
    for (const t of trades) expect(t.price).toBe(market.priceAt(t.ticker, t.tick));
  });
});

describe('Sessions, endings and clean-up', () => {
  it('PLB-21: a timed session ends while playing: playback pauses itself and trading closes', () => {
    const { scheduler, controller } = setup({ durationTicks: 5 });
    controller.play();
    scheduler.advance(10_000);
    expect(controller.getSnapshot()).toMatchObject({ playing: false, canStep: false });
    expect(controller.getSnapshot().view).toMatchObject({ tick: 105, status: 'ENDED', ticksRemaining: 0 });
    expect(scheduler.activeTimers).toBe(0);
    controller.play();
    expect(controller.getSnapshot().playing).toBe(false);
    expect(controller.step()).toBe(false);
    controller.order('QLRX', 'BUY', '1');
    expect(controller.getSnapshot().view.trades).toHaveLength(0);
    expect(controller.getSnapshot().view.notices.at(-1)?.message).toBe('The session has ended: trading is closed.');
  });

  it('PLB-22: Reset and New session pause the market and start over', () => {
    const { scheduler, controller } = setup({ seed: 8 });
    controller.play();
    scheduler.advance(7_000);
    controller.order('QLRX', 'BUY', '1');
    controller.reset();
    expect(controller.getSnapshot()).toMatchObject({ playing: false });
    expect(controller.getSnapshot().view).toMatchObject({ tick: 100, seed: 8 });
    expect(controller.getSnapshot().view.trades).toEqual([]);
    scheduler.advance(5_000);
    expect(tickOf(controller)).toBe(100);
    controller.newSession(9);
    expect(controller.getSnapshot().view.seed).toBe(9);
    expect(tickOf(controller)).toBe(100);
  });

  it('PLB-23: subscribers are told about every change, can unsubscribe, and the snapshot is stable between changes', () => {
    const { scheduler, controller } = setup();
    let calls = 0;
    const off = controller.subscribe(() => {
      calls += 1;
    });
    const a = controller.getSnapshot();
    expect(controller.getSnapshot()).toBe(a);
    controller.step();
    expect(calls).toBe(1);
    expect(controller.getSnapshot()).not.toBe(a);
    off();
    controller.step();
    expect(calls).toBe(1);
    void scheduler;
  });

  it('PLB-24: dispose stops the timer for good', () => {
    const { scheduler, controller } = setup();
    controller.play();
    scheduler.advance(2_000);
    controller.dispose();
    expect(scheduler.activeTimers).toBe(0);
    scheduler.advance(20_000);
    expect(tickOf(controller)).toBe(102);
  });
});
