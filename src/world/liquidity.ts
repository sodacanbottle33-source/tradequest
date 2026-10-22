// Liquidity-aware trading: bid and ask, market depth and the price a market order really gets. See docs/world.md §6.
//
// Every stock has a simulated order book. At the best price rests a number of shares that depends on the company's average
// daily volume and liquidity (and gets thinner when the stock is volatile); each deeper price level is a little further away
// and holds a little more. A market order walks up (buy) or down (sell) this ladder, paying the price of each level it
// consumes — that is the slippage. Orders that need more than the 20 levels hold are only filled as far as the ladder goes;
// the rest is cancelled and reported as unfilled.
//
// The book is the same for everybody, but every player consumes their OWN view of it: depth a player has used up recovers
// slowly (half-life 5 minutes). This is why buying a lot and selling it straight back loses money. Career orders also push the
// shared price for everybody and, while the buying (or selling) lasts, thin one side of the shared book and thicken the other
// (bookScale below; the server decides the tilt, see server/flow.ts and docs/world.md §8.6 and §6.4); a 1v1 match order never does
// either, and a client cannot move anybody's fills: what the book shows is what an order gets.

import { BOOK_LEVELS, IMPACT_RECOVERY_TICKS, LEVEL_GROWTH, MAX_ORDER_SHARES, TOUCH_FRAC_MIN, TOUCH_FRAC_SPAN } from './params';
import type { Company } from './types';

export type Side = 'buy' | 'sell';

export interface Quote {
  /** Mid price (the number charts and market capitalisation use), cents. */
  readonly mid: number;
  readonly bid: number;
  readonly ask: number;
  /** Distance from mid to each side, cents. */
  readonly half: number;
  readonly spreadBps: number;
}

export interface Level {
  readonly price: number;
  /** Shares available at this level. */
  readonly size: number;
}

export interface FillPart {
  readonly price: number;
  readonly qty: number;
}

export interface Execution {
  readonly side: Side;
  readonly requestedQty: number;
  readonly filledQty: number;
  readonly unfilledQty: number;
  /** Total cents paid (buy) or received (sell) for the filled shares. */
  readonly totalCents: number;
  /** Average price per share in cents (0 if nothing filled). */
  readonly avgPrice: number;
  readonly parts: readonly FillPart[];
  /** Price of the first and last share filled (0 if nothing filled). */
  readonly firstPrice: number;
  readonly lastPrice: number;
  /** Cost of crossing the spread: shares × distance from mid to the best price. */
  readonly spreadCostCents: number;
  /** Cost of walking the ladder beyond the best price (including depth this player used up earlier). */
  readonly impactCostCents: number;
  /** Total slippage against mid, in basis points of the mid value. */
  readonly slippageBps: number;
  /** Why the order was not filled completely ('' if it was). */
  readonly note: '' | 'depth' | 'limit';
  /** The player's used-up depth after this order (shares). */
  readonly consumedAfter: number;
}

/** Bid, ask and spread. The spread widens when the stock is more volatile than usual (activity > 1). */
export function quoteOf(c: Pick<Company, 'spreadBps'>, mid: number, activity: number): Quote {
  if (!(mid >= 1)) throw new Error(`Bad mid price ${mid}`);
  const bps = c.spreadBps * (0.5 + 0.5 * activity);
  const half = Math.max(1, Math.ceil((mid * bps) / 20_000));
  return { mid, bid: Math.max(1, mid - half), ask: mid + half, half, spreadBps: Math.round(((2 * half) / mid) * 100_000) / 10 };
}

/** Shares resting at the best price. Thinner when activity is high. */
export function touchShares(c: Pick<Company, 'avgDailyVolume' | 'liquidity'>, activity: number): number {
  const frac = TOUCH_FRAC_MIN + TOUCH_FRAC_SPAN * c.liquidity;
  return Math.max(1, Math.floor((c.avgDailyVolume * frac) / (0.5 + 0.5 * activity)));
}

/** Distance between two price levels, cents (at least 1). */
export function levelStep(c: Pick<Company, 'liquidity'>, mid: number): number {
  const lack = 1 - c.liquidity;
  const bps = 2 + 38 * lack * lack;
  return Math.max(1, Math.round((mid * bps) / 10_000));
}

/** How strongly net buying (or selling) by players thins one side of the book and thickens the other (see bookScale). */
export const BOOK_TILT_GAIN = 0.6;
/** No side of the book ever shrinks below this share of its calm size, or grows beyond the larger one. */
export const BOOK_TILT_MIN = 0.15;
export const BOOK_TILT_MAX = 1.6;

/**
 * The factor by which the sizes on one side of the book are multiplied because players have been buying (tilt > 0) or selling (tilt < 0)
 * the company lately. Net buying eats the asks (they get thinner) and piles up bids (thicker); net selling does the opposite. `tilt` is
 * the players' net pressure divided by the depth of a calm book, between -1 and 1 (server/flow.ts). 1 = the calm book.
 */
export function bookScale(side: Side, tilt: number): number {
  if (!Number.isFinite(tilt)) return 1;
  const t = Math.max(-1, Math.min(1, tilt));
  const f = side === 'buy' ? 1 - BOOK_TILT_GAIN * t : 1 + BOOK_TILT_GAIN * t;
  return Math.max(BOOK_TILT_MIN, Math.min(BOOK_TILT_MAX, f));
}

/**
 * The ladder a market order of this side walks: asks for a buy, bids for a sell (best price first). `scale` multiplies every size
 * (default 1, the calm book): the server passes bookScale() so that the book reacts to what players do.
 */
export function ladder(c: Pick<Company, 'avgDailyVolume' | 'liquidity'>, quote: Quote, activity: number, side: Side, levels = BOOK_LEVELS, scale = 1): Level[] {
  const touch = touchShares(c, activity);
  const step = levelStep(c, quote.mid);
  const out: Level[] = [];
  for (let k = 0; k < levels; k += 1) {
    const price = side === 'buy' ? quote.ask + k * step : quote.bid - k * step;
    if (price < 1) break;
    out.push({ price, size: Math.max(1, Math.floor(touch * (1 + LEVEL_GROWTH * k) * scale)) });
  }
  return out;
}

export function totalDepth(levels: readonly Level[]): number {
  let sum = 0;
  for (const l of levels) sum += l.size;
  return sum;
}

/** Per-tick fraction of used-up depth that is still used up one tick later: 0.5 ^ (1 / half-life). */
const KEEP_PER_TICK = 0.9976921765270234; // exp(−ln 2 / 300)

function powInt(base: number, exponent: number): number {
  let result = 1;
  let b = base;
  let e = exponent;
  while (e > 0) {
    if (e % 2 === 1) result *= b;
    b *= b;
    e = Math.floor(e / 2);
  }
  return result;
}

/** How much of a player's used-up depth remains after `elapsedTicks`. */
export function recoverConsumed(consumed: number, elapsedTicks: number): number {
  if (consumed <= 0 || elapsedTicks < 0) return Math.max(0, consumed);
  if (elapsedTicks > IMPACT_RECOVERY_TICKS * 20) return 0;
  const left = consumed * powInt(KEEP_PER_TICK, elapsedTicks);
  return left < 0.5 ? 0 : left;
}

function checkQty(qty: number): void {
  if (!Number.isSafeInteger(qty) || qty < 1) throw new Error(`Quantity must be a whole number of shares, got ${qty}`);
  if (qty > MAX_ORDER_SHARES) throw new Error(`Quantity ${qty} is above the limit of ${MAX_ORDER_SHARES}`);
}

export interface ExecuteOptions {
  /** A buy is not filled above this price (cents per share), a sell not below it. */
  readonly limitPrice?: number;
  /** Only used to split the cost into spread and impact; defaults to the first level's distance from mid. */
  readonly mid?: number;
}

/**
 * Fills a market order against a ladder. `consumed` is the depth this player has already used up on this side (it is
 * skipped first). Pure: nothing is stored here; the caller keeps `consumedAfter`.
 */
export function executeMarket(levels: readonly Level[], side: Side, qty: number, consumed: number, options: ExecuteOptions = {}): Execution {
  checkQty(qty);
  let skip = Math.max(0, Math.floor(consumed));
  let remaining = qty;
  let total = 0;
  let filled = 0;
  const parts: FillPart[] = [];
  let note: '' | 'depth' | 'limit' = '';
  for (const level of levels) {
    let avail = level.size;
    if (skip > 0) {
      const used = Math.min(skip, avail);
      skip -= used;
      avail -= used;
    }
    if (avail <= 0) continue;
    if (options.limitPrice !== undefined) {
      const worse = side === 'buy' ? level.price > options.limitPrice : level.price < options.limitPrice;
      if (worse) {
        note = 'limit';
        break;
      }
    }
    const take = Math.min(remaining, avail);
    parts.push({ price: level.price, qty: take });
    total += level.price * take;
    filled += take;
    remaining -= take;
    if (remaining === 0) break;
  }
  if (remaining > 0 && note === '') note = 'depth';
  if (!Number.isSafeInteger(total)) throw new Error('Order value overflow');
  const first = parts[0]?.price ?? 0;
  const last = parts[parts.length - 1]?.price ?? 0;
  const touch = levels[0]?.price ?? 0;
  const mid = options.mid ?? touch;
  const half = Math.abs(touch - mid);
  const spreadCost = filled * half;
  // Buy: pay more than touch. Sell: receive less than touch.
  const impactCost = side === 'buy' ? total - filled * touch : filled * touch - total;
  const midValue = filled * mid;
  const slippage = side === 'buy' ? total - midValue : midValue - total;
  return {
    side,
    requestedQty: qty,
    filledQty: filled,
    unfilledQty: qty - filled,
    totalCents: total,
    avgPrice: filled > 0 ? total / filled : 0,
    parts,
    firstPrice: first,
    lastPrice: last,
    spreadCostCents: spreadCost,
    impactCostCents: Math.max(0, impactCost),
    slippageBps: midValue > 0 ? Math.round((slippage / midValue) * 100_000) / 10 : 0,
    note,
    consumedAfter: Math.max(0, Math.floor(consumed)) + filled,
  };
}

/** The most shares a buyer can pay for with `cashCents`, walking the ladder from the player's used-up depth. */
export function maxAffordable(levels: readonly Level[], consumed: number, cashCents: number): { qty: number; costCents: number } {
  if (!Number.isSafeInteger(cashCents) || cashCents < 0) throw new Error(`Bad cash ${cashCents}`);
  let skip = Math.max(0, Math.floor(consumed));
  let cash = cashCents;
  let qty = 0;
  let cost = 0;
  for (const level of levels) {
    let avail = level.size;
    if (skip > 0) {
      const used = Math.min(skip, avail);
      skip -= used;
      avail -= used;
    }
    if (avail <= 0) continue;
    const can = Math.min(avail, Math.floor(cash / level.price));
    if (can > 0) {
      qty += can;
      cost += can * level.price;
      cash -= can * level.price;
    }
    if (can < avail) break; // ran out of cash inside this level
  }
  return { qty: Math.min(qty, MAX_ORDER_SHARES), costCents: cost };
}

export type LiquidityLabel = 'Very high' | 'High' | 'Medium' | 'Low' | 'Very low';

export function liquidityLabel(liquidity: number): LiquidityLabel {
  if (liquidity >= 0.85) return 'Very high';
  if (liquidity >= 0.65) return 'High';
  if (liquidity >= 0.45) return 'Medium';
  if (liquidity >= 0.25) return 'Low';
  return 'Very low';
}
