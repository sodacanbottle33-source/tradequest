// Automatic trading pauses, like the "circuit breakers" of real stock exchanges: when a company's price has moved too far within
// 5 minutes (up or down), trading in it stops for 5 minutes. The price keeps moving while it is paused; only trading stops.
//
// How far is "too far" depends on the size of the company, as on real exchanges (which use wider bands for riskier stocks): 10 % for
// mega and large companies, 15 % for mid-size, 30 % for small and 45 % for micro. The game's small stocks swing a lot by
// themselves (a micro-cap moves 6 % in 5 minutes as a matter of course and 10 % about a third of the time), so one flat 10 %
// would keep pausing them without anybody doing anything; these bands leave a micro-cap's own wobble alone and still catch a
// whale or a big story.
//
// Memecoins (sector "meme") are never paused: crypto has no circuit breakers, and a coin that moves 20 % in a minute is simply what
// it is. (A pause would also lock a trader inside a crashing coin, which is the opposite of what a stop-loss is for.)
//
// How it works. Every 5 market seconds (ticks) the breaker notes each trading company's price. A company is paused when its
// price is a band or more away from the oldest price it noted in the last 5 minutes. When the pause is over the company reopens
// at the current price and the 5-minute clock starts again. What does NOT count:
//   * the owner's own price moves (events whose key starts with "admin:"): while one of them is running the company is not
//     watched, and the watching starts afresh when it is over;
//   * a company the owner has halted, or while the owner has paused everything;
//   * ticks the market replays while it catches up after the server was off: a pause that would already be over is not made.
// What does count: news stories, market and sector moves, and the pushes of players' own trades (a big seller can only push a price
// down so far before the market stops him for a while).
//
// A pause is a row in the table auto_pauses, so a restart keeps it. The breaker never changes a price and never decides a price:
// it only decides who may trade. It is called from the market's tick loop, which is why it must never throw (the runtime catches
// and logs anything that does, so a bug here cannot stop the market).

import type { EffectBook } from '../src/world/effects';
import type { Halts } from './halts';
import type { Logger } from './log';
import type { WorldSim } from '../src/world';

/** A price this far (as a fraction) from where it was 5 minutes ago pauses trading, by size class of the company. */
export const BREAKER_BANDS: Readonly<Record<string, number>> = { mega: 0.1, large: 0.1, mid: 0.15, small: 0.3, micro: 0.45 };
/** The band for a size class (a class we do not know gets the narrowest). */
export function bandOf(tier: string): number {
  return BREAKER_BANDS[tier] ?? 0.1;
}
/** How far back the price is compared, in ticks (market seconds): 5 minutes. */
export const BREAKER_WINDOW_TICKS = 300;
/** How long trading stays paused, in ticks: 5 minutes. */
export const BREAKER_PAUSE_TICKS = 300;
/** The price is noted every this many ticks. */
export const BREAKER_SAMPLE_EVERY = 5;

/** What the breaker needs from the market (the world runtime provides all of it). */
export interface BreakerWorld {
  readonly sim: Pick<WorldSim, 'P' | 'isListed'>;
  readonly effects: Pick<EffectBook, 'hasActive'>;
  readonly companies: readonly { readonly ticker: string; readonly tier: string; readonly sector?: string }[];
  /** The tick the real-time clock is at now (the market may be behind it while catching up). */
  currentTick(): number;
}

interface Samples {
  ticks: number[];
  prices: number[];
}

export interface BreakerOptions {
  readonly world: BreakerWorld;
  readonly halts: Halts;
  readonly log: Logger;
  /** Called after a pause starts or ends, so open pages can refresh their lists. */
  readonly onChange?: () => void;
}

export class CircuitBreaker {
  private readonly samples = new Map<number, Samples>();

  constructor(private readonly o: BreakerOptions) {}

  /** Call once per market tick, after the tick has been computed. */
  step(tick: number): void {
    if (tick % BREAKER_SAMPLE_EVERY !== 0) return;
    const { world, halts } = this.o;
    let changed = false;

    // Pauses that have run out: release them and start the 5-minute clock afresh.
    for (const id of halts.expireAuto(tick)) {
      this.samples.delete(id);
      changed = true;
    }
    const everythingStopped = halts.allPaused() !== null;
    const n = world.companies.length;
    for (let id = 0; id < n; id += 1) {
      if (!world.sim.isListed(id)) {
        this.samples.delete(id);
        continue;
      }
      const price = world.sim.P[id] as number;
      if (!(price > 0)) continue;
      if (world.companies[id]?.sector === 'meme') continue; // coins are never paused (see the top of this file)
      if (halts.autoPauseOf(id) !== null) continue; // already paused: nothing to watch until it reopens
      // The owner's price moves, and owner halts, are not the market's doing: do not watch while they last.
      if (everythingStopped || halts.isHaltedItself(id) || world.effects.hasActive(id, 'admin:')) {
        this.samples.delete(id);
        continue;
      }
      const s = this.samples.get(id) ?? { ticks: [], prices: [] };
      this.samples.set(id, s);
      while (s.ticks.length > 0 && (s.ticks[0] as number) < tick - BREAKER_WINDOW_TICKS) {
        s.ticks.shift();
        s.prices.shift();
      }
      const ref = s.prices[0];
      if (ref !== undefined && ref > 0) {
        const move = (price - ref) / ref;
        if (Math.abs(move) >= bandOf(world.companies[id]?.tier ?? '')) {
          changed = this.pause(id, tick, ref, price, move) || changed;
          s.ticks.length = 0;
          s.prices.length = 0;
          continue;
        }
      }
      s.ticks.push(tick);
      s.prices.push(price);
    }
    if (changed) this.o.onChange?.();
  }

  private pause(id: number, tick: number, from: number, to: number, move: number): boolean {
    const { world, halts, log } = this.o;
    const until = tick + BREAKER_PAUSE_TICKS;
    // Catching up after the server was off: the market is replaying the past, and a pause that is already over helps nobody.
    if (until <= world.currentTick()) return false;
    const moveBps = Math.round(move * 10_000);
    halts.startAuto({ companyId: id, sinceTick: tick, untilTick: until, fromPrice: from, toPrice: to, moveBps });
    log.info('breaker', `Trading in ${world.companies[id]?.ticker ?? id} is paused for ${BREAKER_PAUSE_TICKS} s: the price went from ${from} to ${to} (${(moveBps / 100).toFixed(1)}%) within ${BREAKER_WINDOW_TICKS} s.`);
    return true;
  }

  /** Forget everything noted so far (after the market state is replaced, and in tests). */
  reset(): void {
    this.samples.clear();
  }
}
