// The arithmetic behind the tutorial's demos and check questions. Money is in whole cents, exact (integers only, no floating point).
// The tutorial tests recompute every answer printed in tutorial.ts with these functions, so a number in the text cannot be wrong.

/** Profit in cents of buying `shares` at `entry` and selling at `exit` (negative = loss). */
export function longProfitCents(shares: number, entryCents: number, exitCents: number): number {
  return shares * (exitCents - entryCents);
}

/** Profit in cents of shorting `shares` at `entry` and covering at `exit` (negative = loss). */
export function shortProfitCents(shares: number, entryCents: number, exitCents: number): number {
  return shares * (entryCents - exitCents);
}

/** The trading fee in whole cents on an order worth `valueCents`, rounded UP (the game's rule, server/fees.ts). */
export function feeCents(valueCents: number, bps: number): number {
  if (!(bps > 0) || !(valueCents > 0)) return 0;
  return Math.floor((valueCents * bps + 9999) / 10000);
}

export const STOCK_FEE_BPS_TEXT = 10;
export const COIN_FEE_BPS_TEXT = 50;

/** How far (in hundredths of a percent) the price must move for a buy and a later sell to pay back both fees. */
export function breakEvenBps(bps: number): number {
  return bps * 2;
}

/**
 * The drop, in hundredths of a percent, that wipes out a leveraged long position (the interest and the fee are ignored here, so the real
 * game wipes it out a little earlier). 10× → 10 % = 1000.
 */
export function wipeoutBps(leverage: number): number {
  return Math.floor(10000 / leverage);
}

/**
 * What a leveraged long position is worth after the price moves by `moveBps` (hundredths of a percent, negative = down), in cents, for a
 * margin of `marginCents`. A position cannot lose more than its margin: it is closed by the market at the wipe-out point.
 */
export function leveragedProfitCents(marginCents: number, leverage: number, moveBps: number): number {
  const raw = Math.trunc((marginCents * leverage * moveBps) / 10000);
  return Math.max(raw, -marginCents);
}

/** Cash left after `n` losing trades in a row, when each trade puts `stakePercent` % of the cash at stake and loses `lossPercent` % of that stake. */
export function cashAfterLosses(cashCents: number, stakePercent: number, lossPercent: number, n: number): number {
  let cash = cashCents;
  for (let i = 0; i < n; i += 1) {
    const stake = Math.floor((cash * stakePercent) / 100);
    const lost = Math.floor((stake * lossPercent) / 100);
    cash -= lost;
  }
  return cash;
}

/** "$1,234.50" or "−$30.00" from cents (a plain formatter, so the tutorial needs nothing else). */
export function usd(cents: number): string {
  const sign = cents < 0 ? '−' : '';
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const rest = abs % 100;
  const grouped = String(dollars).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}$${grouped}.${rest < 10 ? '0' : ''}${rest}`;
}

/** Like usd, with a plus sign for a gain: "+$30.00". */
export function signedUsd(cents: number): string {
  return cents > 0 ? `+${usd(cents)}` : usd(cents);
}

/** A percentage with one decimal from hundredths of a percent: 1050 → "10.5 %". */
export function percentText(bps: number): string {
  const sign = bps < 0 ? '−' : '';
  const abs = Math.abs(bps);
  const whole = Math.floor(abs / 100);
  const tenth = Math.floor((abs % 100) / 10);
  return tenth === 0 ? `${sign}${whole} %` : `${sign}${whole}.${tenth} %`;
}
