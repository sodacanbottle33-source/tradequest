// The daily quote: which quote and tip a day gets, what "Copy" puts on the clipboard, and the "hide until tomorrow" memory.
// The same calendar day gives every player the same quote and tip (the day is the one on the player's own clock). The words are in
// dailyQuoteData.ts. Nothing here needs the server, and nothing is stored except "I closed the card on this day" in the browser.
import { QUOTES, TIPS } from './dailyQuoteData';

/** Walking through a list with this step visits every line once before any repeats (it has no common factor with 366 or 120), and two days in a row feel unrelated. */
export const DAY_STEP = 7;
/** The browser memory of the day the player closed the card. */
export const HIDE_KEY = 'tq.dailyQuote.hiddenOn';

/** A calendar date as days since 1970-01-01, counted from the date's own year, month and day (so it flips at the player's midnight, not at UTC midnight). */
export function dayNumber(year: number, month: number, day: number): number {
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

/** The day number of a Date on the player's own clock. */
export function dayNumberOf(date: Date): number {
  return dayNumber(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

/** "2026-10-28" for a Date on the player's own clock. */
export function dayKey(date: Date): string {
  const p = (n: number, width: number): string => String(n).padStart(width, '0');
  return `${p(date.getFullYear(), 4)}-${p(date.getMonth() + 1, 2)}-${p(date.getDate(), 2)}`;
}

function wrap(n: number, size: number): number {
  return ((n % size) + size) % size;
}

/** The quote and the tip of a day. */
export function dailyPick(day: number): { quote: string; tip: string; quoteIndex: number; tipIndex: number } {
  const quoteIndex = wrap(day * DAY_STEP, QUOTES.length);
  const tipIndex = wrap(day * DAY_STEP + 3, TIPS.length);
  return { quote: QUOTES[quoteIndex] as string, tip: TIPS[tipIndex] as string, quoteIndex, tipIndex };
}

/** What the Copy button puts on the clipboard. */
export function copyText(quote: string, tip: string | null): string {
  return tip ? `"${quote}"\nTip of the day: ${tip}\n- TradeQuest` : `"${quote}"\n- TradeQuest`;
}

/** True when the card was closed on exactly this day. Tomorrow (or any other day) it shows again. */
export function hiddenToday(stored: string | null, today: string): boolean {
  return stored !== null && stored === today;
}

/** The small part of the browser's storage that this file uses (so tests can hand in a stand-in). */
export interface QuoteStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): QuoteStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // some browsers refuse storage in private windows
  }
}

/** The day the player closed the card, or null (nothing stored, or storage refused). */
export function readHiddenDay(storage: QuoteStorage | null = defaultStorage()): string | null {
  try {
    return storage ? storage.getItem(HIDE_KEY) : null;
  } catch {
    return null;
  }
}

/** Remembers that the card was closed on this day. If the browser refuses, the card is simply closed for this visit only. */
export function writeHiddenDay(day: string, storage: QuoteStorage | null = defaultStorage()): void {
  try {
    storage?.setItem(HIDE_KEY, day);
  } catch {
    // storage refused: nothing to do
  }
}
