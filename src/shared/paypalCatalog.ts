// What a Shop look costs in PayPal TEST money (docs/world.md §43). This file is only data and tiny pure functions, shared by the server (which decides every amount) and the page
// (which only shows it). PayPal is used here in its free sandbox only: the buyer is a made-up test account from PayPal's developer site and no real money ever moves.
// A look bought this way is the same look as one bought with Career cash: it gives no money and no help in trading.

/** The only currency the Shop uses with PayPal. */
export const PAYPAL_CURRENCY = 'USD';

/** Test prices in cents by rarity (index 0 is unused): Common $0.50, Rare $1.00, Epic $2.00, Legendary $5.00. */
export const PAYPAL_PRICE_CENTS: readonly number[] = [0, 50, 100, 200, 500];

/** What a look costs in PayPal test money, in cents. */
export function paypalPriceOf(def: { readonly rarity: number }): number {
  return PAYPAL_PRICE_CENTS[def.rarity] ?? 0;
}

/** "$1.50" for 150 cents. */
export function paypalMoneyText(cents: number): string {
  const whole = Math.trunc(cents / 100);
  const rest = Math.abs(cents % 100);
  return `$${whole.toLocaleString('en-US')}.${String(rest).padStart(2, '0')}`;
}

/** The amount the way PayPal wants it written: text with two decimals ("1.50" for 150 cents). Whole-number maths only, so no rounding surprises. */
export function paypalAmountValue(cents: number): string {
  const whole = Math.trunc(cents / 100);
  const rest = Math.abs(cents % 100);
  return `${whole}.${String(rest).padStart(2, '0')}`;
}

/** The cents in an amount PayPal wrote ("1.50" or "1"), or null when it is anything else (a missing, negative or oddly written amount is never accepted). */
export function centsOfPaypalValue(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(value);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}
