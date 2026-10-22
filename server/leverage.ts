// Leverage: pure rules, shared by trading.ts (orders and estimates) and liquidation.ts (the automatic closing of a position).
// docs/world.md §6.1.
//
// A leveraged BUY pays only a part of the order's value out of the player's own cash: the MARGIN, the value divided by the leverage
// (rounded up to a whole cent). The rest is a DEBT that sits on the position. Selling repays the debt out of the proceeds, and the
// player keeps what is left (never less than nothing: you can lose your margin, never more than it).
//
//   • Leverage is 1× to 50×, whole numbers, on long positions (a buy) and on short positions (see "short selling" below). 1× is an
//     ordinary buy: no debt.
//   • Every position is its own (isolated) margin: a position that is wiped out does not touch the player's other cash or shares.
//   • Interest (margin.ts): in Career the debt costs interest, 10 % a year on a stock and 40 % on a memecoin, added to the debt every
//     minute; a 1v1 match has none. (A memecoin order also pays the trading fee of fees.ts, but that is a fee on the order, the same at
//     any leverage, and it never changes when a position is liquidated.) The other cost is that a small move against you wipes the margin out.
//   • LIQUIDATION. A position is closed by the market itself, at once, when the market price times its shares is no more than its debt
//     (the margin is gone). The player loses the margin and gets nothing back. This is checked at every market tick, also while the
//     server catches up after having been off, so a price that dipped to the liquidation price while nobody watched still wipes it out.
//   • An order is refused when the cost of opening it (spread, thin book, the player's own price push) would eat more than half of
//     its margin, or would leave the position liquidated at once: you cannot be liquidated by the act of buying.

/** The highest leverage (a whole number). */
export const MAX_LEVERAGE = 50;
/** The cost of opening an order above the market price may use at most this share of the margin. */
export const OPEN_COST_LIMIT = 0.5;

/** True for a whole leverage from 1 to MAX_LEVERAGE. */
export function isLeverage(x: unknown): x is number {
  return typeof x === 'number' && Number.isInteger(x) && x >= 1 && x <= MAX_LEVERAGE;
}

/** What the player pays out of his own cash for an order worth `totalCents` at this leverage: the value divided by it, rounded up. */
export function marginOf(totalCents: number, leverage: number): number {
  if (!(leverage > 1)) return totalCents;
  return Number((BigInt(totalCents) + BigInt(leverage) - BigInt(1)) / BigInt(leverage));
}

/** True when a position of `shares` with `debtCents` of debt is wiped out at the market price `mid` (cents): its shares are worth no more than the debt. */
export function isLiquidated(mid: number, shares: number, debtCents: number): boolean {
  if (!(debtCents > 0) || !(shares > 0)) return false;
  return BigInt(Math.round(mid)) * BigInt(shares) <= BigInt(debtCents);
}

/** The highest market price (whole cents) at which the position is wiped out: shares × price ≤ debt. 0 for a position without debt. */
export function liquidationPrice(shares: number, debtCents: number): number {
  if (!(debtCents > 0) || !(shares > 0)) return 0;
  return Number(BigInt(debtCents) / BigInt(shares));
}

/** A part of a position's debt: all of it when all shares go, otherwise in proportion, rounded down (exact with BigInt). */
export function debtShare(debtCents: number, sold: number, held: number): number {
  if (!(debtCents > 0) || !(sold > 0)) return 0;
  if (sold >= held) return debtCents;
  return Number((BigInt(debtCents) * BigInt(sold)) / BigInt(held));
}

// ---- short selling ----------------------------------------------------------------------------------------------------------
//
// A SHORT sells shares the player does not own, hoping to buy them back cheaper. In this game:
//   • Opening a short of `n` shares sells them at the bid for `P` cents. That money is NOT paid out: it is held on the position (the
//     "credit"). The player also puts up a MARGIN of his own cash, `P` divided by the leverage (1× to 50×), rounded up.
//   • The position's COLLATERAL is credit + margin. Buying the shares back ("covering") costs `C`; the player gets back what is left of
//     the collateral, `collateral − C`, never less than nothing. Price down = profit, price up = loss.
//   • LIQUIDATION. The market closes a short by itself, at once, when the price times the shares owed reaches the collateral (the
//     margin is gone). The player loses the margin and gets nothing back. A 1× short is wiped out when the price doubles; a 10× short
//     when it is 10 % up from the sale price. Checked at every tick, also while the server catches up.
//   • Just like a long position, every short is its own isolated margin, and the player can lose his margin but never more. In
//     Career a short pays a borrow fee (margin.ts), taken out of the money from the sale that sits on the position.
//   • A player is either long or short in a company, never both at once.

/** What a short position holds as security: the money from the sale plus the player's own margin. */
export function collateralOf(creditCents: number, costCents: number): number {
  return creditCents + costCents;
}

/** True when buying back `shares` at the market price `mid` (cents) would cost at least the whole collateral: the margin is gone. */
export function isShortLiquidated(mid: number, shares: number, collateralCents: number): boolean {
  if (!(shares > 0) || !(collateralCents > 0)) return false;
  return BigInt(Math.round(mid)) * BigInt(shares) >= BigInt(collateralCents);
}

/** The lowest market price (whole cents) at which a short is wiped out: shares × price ≥ collateral, so collateral ÷ shares rounded up. */
export function shortLiquidationPrice(shares: number, collateralCents: number): number {
  if (!(shares > 0) || !(collateralCents > 0)) return 0;
  const n = BigInt(shares);
  return Number((BigInt(collateralCents) + n - BigInt(1)) / n);
}

/** What a position is worth to its owner at the price `price` (cents), never below nothing: a long's shares minus its debt, a short's collateral minus the cost of buying back. */
export function equityOf(p: { shares: number; costCents: number; debtCents: number; short: boolean; creditCents: number }, price: number): number {
  if (p.short) return Math.max(0, collateralOf(p.creditCents, p.costCents) - price * p.shares);
  return Math.max(0, price * p.shares - p.debtCents);
}

/**
 * The highest leverage a SHORT of `filled` shares sold for `proceeds` cents may use right now: the cost of opening it (selling below the
 * market price) must fit in OPEN_COST_LIMIT of the margin, and the whole position (this order added to what is held) must not be
 * liquidated at the moment it opens. Always at least 1 for an ordinary short that is not refused for the second reason alone.
 */
export function maxShortLeverageFor(proceeds: number, filled: number, mid: number, held: { shares: number; collateralCents: number } | null): number {
  const openCost = Math.max(0, filled * mid - proceeds);
  for (let l = MAX_LEVERAGE; l >= 1; l -= 1) {
    const margin = marginOf(proceeds, l);
    if (l > 1 && openCost > margin * OPEN_COST_LIMIT) continue;
    if (isShortLiquidated(mid, (held?.shares ?? 0) + filled, (held?.collateralCents ?? 0) + proceeds + margin)) continue;
    return l;
  }
  return 1;
}

/**
 * The highest leverage an order of `filled` shares worth `totalCents` may use right now: the opening cost above the market price must
 * fit in OPEN_COST_LIMIT of the margin, and the whole position (this order added to what is held) must not be liquidated at the
 * moment it opens. Always at least 1: an ordinary buy is never refused for this.
 */
export function maxLeverageFor(totalCents: number, filled: number, mid: number, held: { shares: number; debtCents: number } | null): number {
  const openCost = Math.max(0, totalCents - filled * mid);
  for (let l = MAX_LEVERAGE; l > 1; l -= 1) {
    const margin = marginOf(totalCents, l);
    if (openCost > margin * OPEN_COST_LIMIT) continue;
    if (isLiquidated(mid, (held?.shares ?? 0) + filled, (held?.debtCents ?? 0) + (totalCents - margin))) continue;
    return l;
  }
  return 1;
}
