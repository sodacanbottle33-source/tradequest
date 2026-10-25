// The trading fee. MEMECOIN orders pay 0.5 % and STOCK orders 0.1 %, and only in Career: a 1v1 match has no fee, because both players
// start equal and are scored on the published price. docs/world.md §6.6.
//
// Two numbers, changed here and nowhere else, in basis points (hundredths of a percent) of the order's value:
//   MEME_FEE_BPS  50 = 0.5 %.  Set it to 0 to turn the memecoin fee off.
//   STOCK_FEE_BPS 10 = 0.1 %.  Set it to 0 to turn the stock fee off.
// (Everything below is the same for both. The game starts the stock fee in server/main.ts; the Trading class and the app have it off
// unless they are told a rate, like the market bots, so a test of something else is not changed by it.)
//
//   • It is paid on EVERY memecoin or stock order: buying, selling, shorting, covering, and the closing the market does by itself when a
//     stop-loss or take-profit is reached.
//   • The market's own liquidation (the margin is gone) carries no fee: the player has already lost everything he put in.
//   • Opening a position (a buy, or a sell that opens a short) pays the fee ON TOP of the margin, out of the player's cash. Closing one
//     (a sell, or a buy that covers a short) pays it OUT OF the money that comes back. It never takes more than that: a position that
//     comes back with nothing pays no fee.
//   • The fee is measured on the VALUE of the shares traded (what the book fills them for), not on the margin: a 50x order of $10 of cash
//     is a $500 order and pays 0.5 % of $500.
//   • The fee is rounded UP to a whole cent, so any real order pays at least 1 cent. It is not paid to anyone; it just leaves the game.

/** The memecoin trading fee in basis points of the order's value (50 = 0.5 %). */
export const MEME_FEE_BPS = 50;

/** The stock trading fee in basis points of the order's value (10 = 0.1 %), Career only. */
export const STOCK_FEE_BPS = 10;

/** The fee in whole cents on an order worth `totalCents`, rounded UP. BigInt keeps it exact however large the order is. */
export function feeOf(totalCents: number, bps: number): number {
  if (!(bps > 0) || !(totalCents > 0)) return 0;
  return Number((BigInt(totalCents) * BigInt(bps) + BigInt(9_999)) / BigInt(10_000));
}
