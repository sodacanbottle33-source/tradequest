// How news moves prices: an event becomes one "effect" per affected stock, and every effect spreads its total move over a
// fixed number of ticks with a fixed shape. The weights of a shape add up to exactly 1, so an event is applied exactly
// once in total no matter how long it lasts and no matter how often the engine looks at it (docs/world.md §7).
// An effect is a pure function of (tick − startTick): nothing needs to be remembered between ticks, which is what lets
// the server stop and restart at any moment without applying an event twice or missing it.

import { SENTIMENT_GAIN, SENTIMENT_REF } from './params';
import type { Company, Effect, Shape, WorldEvent } from './types';

/** Ticks over which a 'burst' (the immediate reaction) is spread. */
export const BURST_TICKS = 6;

/** Number of ticks over which a shape actually applies for a nominal duration. */
export function effectiveDuration(shape: Shape, durationTicks: number): number {
  if (!Number.isInteger(durationTicks) || durationTicks < 1) throw new Error(`Bad duration ${durationTicks}`);
  return shape === 'burst' ? Math.min(durationTicks, BURST_TICKS) : durationTicks;
}

/** Sum of the un-normalised triangular weights min(k+1, D−k) for k = 0 … D−1. */
function rampSum(d: number): number {
  const m = Math.floor(d / 2);
  return d % 2 === 0 ? m * (m + 1) : m * (m + 1) + (m + 1);
}

/** Share of the total move that happens at the k-th tick (k = 0 is the effect's start tick). Zero outside the effect. */
export function weightAt(shape: Shape, durationTicks: number, k: number): number {
  const d = effectiveDuration(shape, durationTicks);
  if (k < 0 || k >= d) return 0;
  switch (shape) {
    case 'burst':
      return 1 / d;
    case 'front':
      return (2 * (d - k)) / (d * (d + 1));
    case 'ramp': {
      const up = k + 1;
      const down = d - k;
      return (up < down ? up : down) / rampSum(d);
    }
  }
}

/** Flattens an event into per-stock effects. Companies that are not listed yet at the start tick are not affected. */
export function effectsOf(event: WorldEvent, companies: readonly Company[]): Effect[] {
  const out: Effect[] = [];
  const add = (c: Company, total: number): void => {
    if (c.listingTick > event.startTick) return;
    out.push({
      eventKey: event.key,
      companyId: c.id,
      startTick: event.startTick,
      durationTicks: event.durationTicks,
      shape: event.shape,
      total,
      permShare: event.permShare,
    });
  };
  switch (event.scope) {
    case 'company':
    case 'company+partner': {
      if (event.companyId === null) throw new Error(`Event ${event.key}: company scope needs a company`);
      const c = companies[event.companyId];
      if (!c) throw new Error(`Event ${event.key}: unknown company ${event.companyId}`);
      add(c, event.realized);
      if (event.scope === 'company+partner' && event.partnerId !== null) {
        const partner = companies[event.partnerId];
        if (!partner) throw new Error(`Event ${event.key}: unknown partner ${event.partnerId}`);
        add(partner, event.realized * PARTNER_SPILL);
      }
      break;
    }
    case 'sector':
      if (event.sector === null) throw new Error(`Event ${event.key}: sector scope needs a sector`);
      for (const c of companies) if (c.sector === event.sector) add(c, event.realized * c.beta);
      break;
    case 'market':
      for (const c of companies) add(c, event.realized * c.beta);
      break;
  }
  return out;
}

/** A partner company feels this share of a partnership's effect. */
export const PARTNER_SPILL = 0.35;

/**
 * The effects of a world, ready to be read tick by tick. Ticks must be asked for in increasing order; effects may be added
 * at any time as long as they start after the last tick that was asked for.
 */
export class EffectBook {
  private pending: Effect[] = [];
  private active: Effect[] = [];
  private lastTick = -1;
  /** Effects that have started and finished so far (for monitoring and tests). */
  finished = 0;

  constructor(effects: readonly Effect[] = []) {
    this.add(effects);
  }

  add(effects: readonly Effect[]): void {
    for (const e of effects) {
      if (e.startTick <= this.lastTick) throw new Error(`Effect ${e.eventKey} starts at tick ${e.startTick}, but tick ${this.lastTick} was already processed`);
      this.pending.push(e);
    }
    this.pending.sort((a, b) => a.startTick - b.startTick || a.companyId - b.companyId || (a.eventKey < b.eventKey ? -1 : a.eventKey > b.eventKey ? 1 : 0));
  }

  /** True while an effect on this company is running whose event key starts with `keyPrefix` (e.g. "admin:" for the owner's price moves). */
  hasActive(companyId: number, keyPrefix: string): boolean {
    for (const e of this.active) if (e.companyId === companyId && e.eventKey.startsWith(keyPrefix)) return true;
    return false;
  }

  get activeCount(): number {
    return this.active.length;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  /**
   * Adds this tick's contributions to `transient` and `permanent` (indexed by company id; the caller zeroes them first).
   * `sentiment` is the slow market sentiment and `activity` the per-stock volatility regime; both only scale the effect
   * mildly (docs/world.md §7.3). With sentiment 0 and activity 1 the effect is exactly `total × weight`.
   */
  apply(tick: number, sentiment: number, activity: Float64Array, transient: Float64Array, permanent: Float64Array): void {
    if (tick < this.lastTick) throw new Error(`Ticks must increase: ${tick} after ${this.lastTick}`);
    this.lastTick = tick;
    // Activate everything that starts now (or, after a gap, earlier).
    let take = 0;
    while (take < this.pending.length && (this.pending[take] as Effect).startTick <= tick) take += 1;
    if (take > 0) {
      for (let i = 0; i < take; i += 1) this.active.push(this.pending[i] as Effect);
      this.pending = this.pending.slice(take);
    }
    if (this.active.length === 0) return;
    const tilt = Math.max(-1, Math.min(1, sentiment / SENTIMENT_REF));
    let keep = 0;
    for (let i = 0; i < this.active.length; i += 1) {
      const e = this.active[i] as Effect;
      const k = tick - e.startTick;
      const d = effectiveDuration(e.shape, e.durationTicks);
      if (k >= d) {
        this.finished += 1;
        continue;
      }
      this.active[keep] = e;
      keep += 1;
      const w = weightAt(e.shape, e.durationTicks, k);
      const sign = e.total > 0 ? 1 : e.total < 0 ? -1 : 0;
      const vol = activity[e.companyId] ?? 1;
      const gain = Math.max(0.7, Math.min(1.3, 1 + SENTIMENT_GAIN * sign * tilt)) * (0.85 + 0.15 * vol);
      const move = e.total * w * gain;
      permanent[e.companyId] = (permanent[e.companyId] ?? 0) + move * e.permShare;
      transient[e.companyId] = (transient[e.companyId] ?? 0) + move * (1 - e.permShare);
    }
    this.active.length = keep;
  }
}
