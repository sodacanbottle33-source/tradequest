// Player trades move prices. Every Career buy pushes the price of that company up a little and every sell pushes it down, by an
// amount that depends on how big the order is compared with the company's order book (so thin, small companies move a lot and
// big liquid ones hardly at all). docs/world.md §8.6 explains the model; this file is the whole of it.
//
//   • All players share ONE "pressure" per company: net shares bought minus sold, fading with a half-life of 5 minutes.
//   • The price push for pressure P is  gain × σ × sign(P) × √(|P| / depth)  (the square-root law of real markets), where σ is
//     the company's typical move over 5 minutes and depth is the number of shares in its 20-level book. It depends only on the
//     pressure, never on the order of the trades, so cutting one big order into many small ones changes nothing.
//   • A trade changes the pressure, and the DIFFERENCE in push becomes a stored price event (table flow_events). The price engine
//     reads it exactly like a news story, so a restart replays the same prices. Nothing here touches the engine's own rules.
//   • The trader pays 60 % of the push on top of the book prices; only 40 % reaches the price. So an order always costs the trader
//     more than it moves the price in his favour, and "buy, wait, sell" can never make money by itself.
//   • 1v1 match accounts are left out on purpose: a match is scored on the one published price, and a player must not be able to
//     lift that price with his own order.

import { BOOK_LEVELS, IMPACT_RECOVERY_TICKS, LEVEL_GROWTH, effectiveDuration, touchShares, unitsToMoney, type Company, type Execution, type Side, type WorldEvent } from '../src/world';
import type { Db } from './sqlite';

/**
 * How strongly player trades push prices: ONE fixed strength for every company, the size of the real market (a gain of 1 on the
 * formula above). Only thin, small companies move visibly; a big company hardly moves at all, just like a big company in real life.
 * There is no dial and no per-company setting. (Databases made by older versions may still hold a "flow_level" setting and a
 * per-company "flow_mult" column; both are ignored.)
 */
export const FLOW_GAIN = 1;

/** Pressure fades with this half-life, in ticks (seconds): the same 5 minutes the order book needs to recover. */
export const FLOW_HALF_LIFE_TICKS = IMPACT_RECOVERY_TICKS;
/** A push is spread over this many ticks, strongest first. */
export const FLOW_EVENT_TICKS = 30;
/** The share of a push that stays (the rest fades as the price relaxes); the engine's slow anchor pulls even this back over weeks. */
export const FLOW_PERM_SHARE = 0.25;
/** Of the push, this share reaches the price … */
export const FLOW_MOVE_SHARE = 0.4;
/** … and the trader pays this share on top of the book prices. Paid > move is what rules out risk-free loops. */
export const FLOW_PAID_SHARE = 0.6;
/** One order never pushes by more than this fraction, and pressure never counts for more than this many books. */
export const FLOW_MAX_STEP = 0.25;
export const FLOW_MAX_BOOKS = 3;

/** Shares in the company's full order book (20 levels) when the market is calm. */
export function bookDepth(c: Pick<Company, 'avgDailyVolume' | 'liquidity'>): number {
  let levels = 0;
  for (let k = 0; k < BOOK_LEVELS; k += 1) levels += 1 + LEVEL_GROWTH * k;
  return Math.max(1, touchShares(c, 1) * levels);
}

/** The typical move of the company over one half-life (5 minutes), as a fraction. */
export function horizonSigma(c: Pick<Company, 'vol3m'>): number {
  return c.vol3m * Math.sqrt(FLOW_HALF_LIFE_TICKS / 180);
}

/** The price push (signed fraction) that a net pressure of `shares` stands for. */
export function pushOf(c: Pick<Company, 'avgDailyVolume' | 'liquidity' | 'vol3m'>, shares: number, gain: number): number {
  if (gain <= 0 || shares === 0) return 0;
  const depth = bookDepth(c);
  const capped = Math.min(Math.abs(shares), FLOW_MAX_BOOKS * depth);
  const size = gain * horizonSigma(c) * Math.sqrt(capped / depth);
  return shares > 0 ? size : -size;
}

/** What is left of a pressure after `elapsed` ticks. */
export function fadePressure(shares: number, elapsed: number): number {
  if (shares === 0 || elapsed <= 0) return shares;
  if (elapsed > FLOW_HALF_LIFE_TICKS * 20) return 0;
  const left = shares * 0.5 ** (elapsed / FLOW_HALF_LIFE_TICKS);
  return Math.abs(left) < 0.5 ? 0 : left;
}

/**
 * What an order of `filledQty` shares does to a price when the players' net pressure on the company is `before` (shares, signed): the
 * pure part of {@link FlowService.preview}, which the launch screens also use to show what dumping a stake would cost.
 */
export function pushPreview(c: Pick<Company, 'avgDailyVolume' | 'liquidity' | 'vol3m'>, before: number, side: Side, filledQty: number, gain: number = FLOW_GAIN): FlowPreview {
  if (!(gain > 0) || filledQty <= 0) return NO_FLOW;
  const limit = FLOW_MAX_BOOKS * bookDepth(c);
  const after = Math.max(-limit, Math.min(limit, before + (side === 'buy' ? filledQty : -filledQty)));
  const raw = pushOf(c, after, gain) - pushOf(c, before, gain);
  const push = Math.max(-FLOW_MAX_STEP, Math.min(FLOW_MAX_STEP, raw));
  return { before, after, push, move: FLOW_MOVE_SHARE * push, paid: FLOW_PAID_SHARE * Math.abs(push) };
}

export interface FlowPreview {
  /** Pressure before and after this order (shares, signed). */
  readonly before: number;
  readonly after: number;
  /** The push this order adds (signed fraction). */
  readonly push: number;
  /** How much the price will move because of it (signed fraction). */
  readonly move: number;
  /** How much more the trader pays than the book prices (fraction, ≥ 0). */
  readonly paid: number;
}

export const NO_FLOW: FlowPreview = { before: 0, after: 0, push: 0, move: 0, paid: 0 };

interface FlowRow {
  key: string;
  company_id: number;
  start_tick: number;
  duration_ticks: number;
  total: number;
  perm_share: number;
}

export class FlowService {
  /**
   * `gain` is how many times the real-market size the pushes are. The game always uses FLOW_GAIN; the parameter exists so tests can
   * make a push big enough to see (0 = player trades never move prices).
   */
  constructor(
    private readonly db: Db,
    private readonly gain: number = FLOW_GAIN,
  ) {}

  // ---- pressure ------------------------------------------------------------------------------------------------------

  pressureAt(companyId: number, tick: number): number {
    const row = this.db.get<{ pressure: number; tick: number }>('SELECT pressure, tick FROM flow_state WHERE company_id = ?', companyId);
    return row ? fadePressure(row.pressure, tick - row.tick) : 0;
  }

  /**
   * How much the players have been net buying (> 0) or selling (< 0) a company lately, relative to the depth of its calm book, from -1
   * to 1. The order book uses it to thin the side that was eaten and thicken the other (src/world/liquidity.ts: bookScale).
   */
  bookTilt(c: Pick<Company, 'id' | 'avgDailyVolume' | 'liquidity'>, tick: number): number {
    if (!(this.gain > 0)) return 0;
    const pressure = this.pressureAt(c.id, tick);
    if (pressure === 0) return 0;
    return Math.max(-1, Math.min(1, pressure / bookDepth(c)));
  }

  /** What an order of `filledQty` shares would do right now. Pure reading; nothing is written. */
  preview(c: Company, side: Side, filledQty: number, tick: number): FlowPreview {
    if (!(this.gain > 0) || filledQty <= 0) return NO_FLOW;
    return pushPreview(c, this.pressureAt(c.id, tick), side, filledQty, this.gain);
  }

  /**
   * Stores what a trade did: the new pressure and, if the price is to move, the event that moves it. Call inside the trade's
   * transaction and hand the returned event to the world only AFTER that transaction has committed.
   */
  record(tradeId: number, c: Company, preview: FlowPreview, tick: number, startTick: number, nowMs: number): WorldEvent | null {
    this.db.run(
      'INSERT INTO flow_state(company_id, pressure, tick) VALUES (?, ?, ?) ON CONFLICT(company_id) DO UPDATE SET pressure = excluded.pressure, tick = excluded.tick',
      c.id,
      preview.after,
      tick,
    );
    if (preview.move === 0) return null;
    const event: WorldEvent = {
      key: `f${tradeId}`,
      kind: 'flow',
      scope: 'company',
      companyId: c.id,
      partnerId: null,
      sector: null,
      publishTick: startTick,
      startTick,
      durationTicks: FLOW_EVENT_TICKS,
      shape: 'front',
      realized: preview.move,
      permShare: FLOW_PERM_SHARE,
    };
    this.db.run(
      'INSERT INTO flow_events(key, trade_id, company_id, start_tick, end_tick, duration_ticks, total, perm_share, created_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      event.key,
      tradeId,
      c.id,
      startTick,
      startTick + effectiveDuration(event.shape, event.durationTicks),
      event.durationTicks,
      event.realized,
      event.permShare,
      nowMs,
    );
    return event;
  }

  // ---- giving the stored pushes to the price engine -------------------------------------------------------------------

  private toEvent(r: FlowRow): WorldEvent {
    return {
      key: r.key,
      kind: 'flow',
      scope: 'company',
      companyId: r.company_id,
      partnerId: null,
      sector: null,
      publishTick: r.start_tick,
      startTick: r.start_tick,
      durationTicks: r.duration_ticks,
      shape: 'front',
      realized: r.total,
      permShare: r.perm_share,
    };
  }

  eventsActiveAt(tick: number): WorldEvent[] {
    return this.db
      .all<FlowRow>('SELECT key, company_id, start_tick, duration_ticks, total, perm_share FROM flow_events WHERE start_tick <= ? AND end_tick > ? ORDER BY start_tick, id', tick, tick)
      .map((r) => this.toEvent(r));
  }

  eventsStartingIn(from: number, through: number): WorldEvent[] {
    return this.db
      .all<FlowRow>('SELECT key, company_id, start_tick, duration_ticks, total, perm_share FROM flow_events WHERE start_tick >= ? AND start_tick <= ? ORDER BY start_tick, id', from, through)
      .map((r) => this.toEvent(r));
  }
}

/**
 * Charges the trader his share of the push: every fill price is moved against him by `paid` (a fraction), rounded to whole cents.
 * `touch` is the best price on his side of the book and `mid` the market price, used to split the cost like executeMarket does.
 */
export function applyMarkup(exec: Execution, side: Side, mid: number, touch: number, paid: number, scale = 1): Execution {
  if (!(paid > 0) || exec.filledQty === 0) return exec;
  if (scale !== 1) return applyMarkupScaled(exec, side, mid, touch, paid, scale);
  const parts = exec.parts.map((p) => ({ qty: p.qty, price: side === 'buy' ? Math.max(1, Math.round(p.price * (1 + paid))) : Math.max(1, Math.round(p.price * (1 - paid))) }));
  let total = 0;
  for (const p of parts) total += p.price * p.qty;
  if (!Number.isSafeInteger(total)) throw new Error('Order value overflow');
  const impact = side === 'buy' ? total - exec.filledQty * touch : exec.filledQty * touch - total;
  const midValue = exec.filledQty * mid;
  const slip = side === 'buy' ? total - midValue : midValue - total;
  return {
    ...exec,
    totalCents: total,
    avgPrice: total / exec.filledQty,
    parts,
    firstPrice: parts[0]?.price ?? 0,
    lastPrice: parts[parts.length - 1]?.price ?? 0,
    impactCostCents: Math.max(0, impact),
    slippageBps: midValue > 0 ? Math.round((slip / midValue) * 100_000) / 10 : 0,
  };
}

/** {@link applyMarkup} for a coin whose prices are in units finer than a cent: the same markup on every fill price, with the sums exact (BigInt) and the money rounded against the trader. */
function applyMarkupScaled(exec: Execution, side: Side, mid: number, touch: number, paid: number, scale: number): Execution {
  const parts = exec.parts.map((p) => ({ qty: p.qty, price: side === 'buy' ? Math.max(1, Math.round(p.price * (1 + paid))) : Math.max(1, Math.round(p.price * (1 - paid))) }));
  let totalUnits = 0n;
  for (const p of parts) totalUnits += BigInt(p.price) * BigInt(p.qty);
  const filled = BigInt(exec.filledQty);
  const touchValue = filled * BigInt(touch);
  const impact = side === 'buy' ? totalUnits - touchValue : touchValue - totalUnits;
  const midValue = filled * BigInt(Math.round(mid));
  const slip = side === 'buy' ? totalUnits - midValue : midValue - totalUnits;
  return {
    ...exec,
    totalCents: unitsToMoney(totalUnits, scale, side === 'buy' ? 'up' : 'down'),
    avgPrice: Number(totalUnits) / exec.filledQty,
    parts,
    firstPrice: parts[0]?.price ?? 0,
    lastPrice: parts[parts.length - 1]?.price ?? 0,
    impactCostCents: impact > 0n ? unitsToMoney(impact, scale, 'nearest') : 0,
    slippageBps: midValue > 0n ? Math.round((Number(slip) / Number(midValue)) * 100_000) / 10 : 0,
  };
}
