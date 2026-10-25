// A small celebration for the player's OWN good news: closing a position with a real profit, and launching a company. The same confetti and banner
// as the price milestones of a company page (src/ui/hype.ts, src/shared/PriceFx.tsx), but for something the player did.
//
// Looks only. Nothing here places an order or changes a number: `winOf` reads the trade the server already answered with, and a celebration is an
// event the page plays once (src/shared/WinBurst.tsx).
import type { Milestone } from '../ui/hype';
import { formatCents } from './format';
import type { Trade } from './types';

/** The smallest profit (cents) that is celebrated: $25. A tiny win is not a party. */
export const WIN_MIN_CENTS = 2_500;
/** … and it must also be at least this many percent of the shares that were closed (a profit of WIN_BIG_CENTS or more counts whatever its share). */
export const WIN_MIN_PCT = 5;
/** From these the celebration is bigger (level 2: a big win, level 3: a huge one). */
export const WIN_BIG_CENTS = 10_000;
export const WIN_BIG_PCT = 50;
export const WIN_HUGE_CENTS = 50_000;
export const WIN_HUGE_PCT = 100;

export interface Win {
  readonly kind: 'trade' | 'launch';
  readonly ticker: string;
  /** The big text ("+$123.45"), the line under it, the symbol and how loud it is (1 to 3). */
  readonly label: string;
  readonly tag: string;
  readonly icon: string;
  readonly sub: string;
  readonly level: 1 | 2 | 3;
  /** Makes the confetti scatter the same way for the same win. */
  readonly seed: number;
}

/** True for a trade that closes (part of) a position, so it has a result: a sale of shares, or the cover of a short. */
export function closesPosition(t: Pick<Trade, 'side' | 'short'>): boolean {
  return t.short ? t.side === 'buy' : t.side === 'sell';
}

function seedOf(text: string, n: number): number {
  let h = 17 + n;
  for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * The win a trade deserves a celebration for, or null. Only a trade the player made that CLOSES a position and made at least WIN_MIN_CENTS
 * (after the fee) and either WIN_MIN_PCT of the shares it closed or WIN_BIG_CENTS; a stop-loss, a liquidation or a trade that lost never celebrates.
 */
export function winOf(t: Pick<Trade, 'ticker' | 'side' | 'short' | 'realizedCents' | 'totalCents' | 'liquidated' | 'auto' | 'id'>): Win | null {
  if (!closesPosition(t) || t.liquidated || t.auto === 'stop') return null;
  const profit = t.realizedCents;
  if (!Number.isFinite(profit) || profit < WIN_MIN_CENTS) return null;
  // What the closed shares cost: a sale gave `totalCents` of which `profit` is gain; for a cover the buy-back price is the yardstick.
  const basis = t.short ? t.totalCents : t.totalCents - profit;
  const pct = basis > 0 ? (profit / basis) * 100 : 0;
  if (pct < WIN_MIN_PCT && profit < WIN_BIG_CENTS) return null;
  const level: 1 | 2 | 3 = profit >= WIN_HUGE_CENTS || pct >= WIN_HUGE_PCT ? 3 : profit >= WIN_BIG_CENTS || pct >= WIN_BIG_PCT ? 2 : 1;
  const shown = pct >= 10 ? Math.round(pct) : Math.round(pct * 10) / 10;
  return {
    kind: 'trade',
    ticker: t.ticker,
    label: `+${formatCents(profit)}`,
    tag: level === 3 ? 'HUGE win!' : level === 2 ? 'Big win!' : 'Nice trade!',
    icon: level === 3 ? '🏆' : level === 2 ? '🤑' : '💰',
    sub: `${t.ticker}: ${shown}% on the ${t.short ? 'short you covered' : 'shares you sold'}`,
    level,
    seed: seedOf(t.ticker, t.id),
  };
}

/** The celebration for a company the player just launched. */
export function launchWin(ticker: string, n = 0): Win {
  return { kind: 'launch', ticker, label: ticker, tag: 'Launched!', icon: '🚀', sub: `${ticker} is yours. It starts trading in a few seconds`, level: 2, seed: seedOf(ticker, n) };
}

/** The shape the confetti maker (src/ui/hype.ts `piecesFor`) and the banner need. */
export function milestoneOfWin(w: Win): Milestone {
  const particles = w.level === 1 ? 26 : w.level === 2 ? 52 : 96;
  const durationMs = w.level === 1 ? 2600 : w.level === 2 ? 3400 : 4600;
  return { x: w.kind === 'launch' ? 1 : 0, label: w.label, tag: w.tag, icon: w.icon, level: w.level, particles, durationMs };
}

// ---- the page plays them one at a time ----------------------------------------------------------------------------------

type Listener = (w: Win) => void;
const listeners = new Set<Listener>();
let counter = 0;

/** Plays a celebration on the page that is open (nothing happens when no page is listening, e.g. in a test). */
export function celebrate(w: Win): void {
  counter += 1;
  for (const l of [...listeners]) l({ ...w, seed: w.seed + counter });
}

/** The page's celebration layer listens here. Returns the way to stop listening. */
export function onCelebrate(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Celebrates the result of a market order the player just made, if it deserves it. A repeated request (the server's first answer again) never does. */
export function celebrateTrade(r: { duplicate: boolean; trade: Parameters<typeof winOf>[0] }): Win | null {
  if (r.duplicate) return null;
  const w = winOf(r.trade);
  if (w) celebrate(w);
  return w;
}
