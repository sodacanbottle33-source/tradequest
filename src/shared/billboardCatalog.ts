// The billboard (docs/world.md §30): three slots at the top of the Market and Memecoins tabs where a player can show a company HE LAUNCHED to everybody, for money.
// This file is only the fixed numbers and a few words; the server decides who may book what (server/billboard.ts) and the screens only show what it says.
// A billboard shows a company's picture, name and live price and opens its page when clicked. It never changes a price, a rank or what anybody may trade.

/** How many places there are on the billboard. */
export const BILLBOARD_SLOTS = 3;
/** What one hour of one place costs, in cents: $5,000. The money comes out of the Career cash and is gone (like the Shop), so net worth and rank go down. */
export const BILLBOARD_CENTS_PER_HOUR = 500_000;
/** The lengths a player may book, in hours. */
export const BILLBOARD_HOURS: readonly number[] = [1, 3, 6, 12, 24];
/** A place can never be booked further ahead than this many hours from now (so nobody can own it for weeks). */
export const BILLBOARD_MAX_HOURS_AHEAD = 24;

/** The price of booking a place for this many hours, in cents. */
export function billboardPriceCents(hours: number): number {
  return BILLBOARD_CENTS_PER_HOUR * hours;
}

/** "1 hour", "3 hours". */
export function hoursText(hours: number): string {
  return hours === 1 ? '1 hour' : `${hours} hours`;
}

/** How long is left until `endsMs`, in a few words: "Ends in 2 h 5 min", "Ends in 12 min", "Ends in less than a minute". */
export function leftText(endsMs: number, nowMs: number): string {
  const left = Math.max(0, endsMs - nowMs);
  const minutes = Math.ceil(left / 60_000);
  if (left <= 0) return 'Ended';
  if (left < 60_000) return 'Ends in less than a minute';
  if (minutes < 60) return `Ends in ${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `Ends in ${h} h` : `Ends in ${h} h ${m} min`;
}
