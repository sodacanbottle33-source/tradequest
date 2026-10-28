// The little marks in the market list: a flame on a company that is up a lot today, an ice cube on one that is down a lot, and a crown on one that is
// at a fresh 24-hour high. Looks only: every number comes from the row the server sent and the live price the page already has, and nothing here
// places an order or changes a price. A halted, bankrupt or not yet listed company gets no mark.

/** "Up (or down) a lot today": 10 % for a stock, 50 % for a memecoin (coins swing far more, so a small move is nothing special for them). */
export const HOT_BPS_STOCK = 1_000;
export const HOT_BPS_COIN = 5_000;
/** A crown needs the price at the 24-hour high and at least this far (1 %) above where the day started, so a company that has just listed is not crowned. */
export const CROWN_MIN_BPS = 100;

export type Mood = 'high' | 'hot' | 'cold';

export interface MoodInput {
  readonly live: boolean;
  readonly coins: boolean;
  readonly halted: boolean;
  readonly bankrupt: boolean;
  /** The change since the day started, in basis points (1 bps = 0.01 %). */
  readonly changeBps: number;
  readonly price: number;
  readonly high24h: number;
}

/** The mark a company deserves right now, or null. The crown beats the flame (both mean "up"). */
export function moodOf(m: MoodInput): Mood | null {
  if (!m.live || m.halted || m.bankrupt || !(m.price > 0)) return null;
  if (m.changeBps >= CROWN_MIN_BPS && m.high24h > 0 && m.price >= m.high24h) return 'high';
  const hot = m.coins ? HOT_BPS_COIN : HOT_BPS_STOCK;
  if (m.changeBps >= hot) return 'hot';
  if (m.changeBps <= -hot) return 'cold';
  return null;
}

export const MOOD_ICON: Readonly<Record<Mood, string>> = { high: '👑', hot: '🔥', cold: '🧊' };
export const MOOD_TEXT: Readonly<Record<Mood, string>> = {
  high: 'At a new 24-hour high',
  hot: 'Hot: up a lot since yesterday',
  cold: 'Cold: down a lot since yesterday',
};
