// Fine prices for memecoins that players launch.
//
// Every price in the market is a whole number. For the stocks and for the thirty built-in coins that number is CENTS, so the lowest price
// is $1.00 and a price moves in steps of one cent. A real memecoin costs a tiny fraction of a cent (PEPE, SHIB and BONK all cost far less
// than a tenth of a cent), and it has a trillion tokens, not eighty thousand. So a coin can carry a finer unit: its `priceScale` says how
// many price units make ONE CENT. A coin with priceScale 1 (every older company) counts in cents exactly as before; a coin launched with
// priceScale 10^12 counts in units of 10^-14 dollars, so its lowest price is $0.00000000000001 and a free launch can start at
// about $0.00000000006.
//
// Money is always whole cents. A price in units becomes money by  cents = tokens × units ÷ priceScale,  worked out exactly (the product
// can be far larger than a safe whole number, so it is done with BigInt) and rounded in the house's favour: a buyer pays the next whole
// cent up and a seller gets the whole cent below, so rounding can never make money for anybody.

/** Price units in one cent for a coin launched now: 10^12, so one unit is 10^-14 dollars. */
export const COIN_PRICE_SCALE = 1e12;
/** Tokens every coin launched now has: 10^12 (a trillion, like the big real memecoins). Its price in units is then its market cap in cents. */
export const COIN_TOKENS = 1e12;
/** The lowest price of a fine-priced coin (one unit = $0.00000000000001) and the price a coin that was rug pulled is left at. */
export const COIN_MIN_UNITS = 1;
/** The highest price of a fine-priced coin: $1.00. Real memecoins sit far below it. */
export const COIN_MAX_UNITS = 100 * COIN_PRICE_SCALE;

/** How many price units make one cent for a company (1 for every company that counts in cents). */
export function scaleOf(c: { readonly priceScale?: number } | null | undefined): number {
  return c?.priceScale ?? 1;
}

/** A price in units as cents (a float for a fine-priced coin, e.g. 0.0000000064). Display and API only: never feed it back into money. */
export function unitsToCents(units: number, scale: number): number {
  return scale === 1 ? units : units / scale;
}

export type Rounding = 'down' | 'up' | 'nearest';

/**
 * The cents that `units` price units come to, as a whole number: BigInt-exact, rounded down, up or to the nearest cent (halves up). With
 * scale 1 the units already are cents and nothing is rounded. Throws when the result is not a safe whole number.
 */
export function unitsToMoney(units: bigint, scale: number, rounding: Rounding): number {
  if (scale === 1) return fit(units);
  const s = BigInt(scale);
  const q = units / s;
  const r = units % s;
  let out = q;
  if (r !== 0n) {
    if (rounding === 'up') out = q + 1n;
    else if (rounding === 'nearest' && r * 2n >= s) out = q + 1n;
  }
  return fit(out);
}

function fit(v: bigint): number {
  if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < -BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Order value overflow');
  return Number(v);
}

/** What `tokens` tokens at `units` price units each are worth, in whole cents (see {@link unitsToMoney}). */
export function valueOf(tokens: number, units: number, scale: number, rounding: Rounding): number {
  if (scale === 1) {
    const v = tokens * units;
    if (!Number.isSafeInteger(v)) throw new Error('Order value overflow');
    return v;
  }
  return unitsToMoney(BigInt(Math.round(tokens)) * BigInt(Math.round(units)), scale, rounding);
}

/** The most whole tokens that `cents` buy at `units` price units each (rounded down). With scale 1: floor(cents / price). */
export function tokensFor(cents: number, units: number, scale: number): number {
  if (!(units >= 1)) throw new Error(`Bad price ${units}`);
  if (scale === 1) return Math.floor(cents / units);
  const n = (BigInt(Math.round(cents)) * BigInt(scale)) / BigInt(Math.round(units));
  return fit(n);
}
