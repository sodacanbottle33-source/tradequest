// Display helpers for the shared market. Display values are never fed back into calculations.
import { formatCents as formatWholeCents } from '../engine';

/**
 * Dollars from cents. Average prices are fractions of a cent (a total divided by a number of shares), which the engine's
 * formatter does not accept, so they are rounded to the nearest cent for display first.
 */
export function formatCents(cents: number): string {
  return formatWholeCents(Number.isInteger(cents) ? cents : Math.round(cents));
}

/** 123456789 cents → "$1.23M"; used for market capitalisation. */
export function formatCap(cents: number): string {
  const dollars = cents / 100;
  const abs = Math.abs(dollars);
  if (abs >= 1e12) return `$${(dollars / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `$${(dollars / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(dollars / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(dollars / 1e3).toFixed(1)}K`;
  return `$${dollars.toFixed(0)}`;
}

/** Share counts and volumes: 1234567 → "1.23M". */
export function formatCount(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

/** 125 basis points → "+1.25%". */
export function formatBps(bps: number): string {
  const text = `${(Math.abs(bps) / 100).toFixed(2)}%`;
  return bps > 0 ? `+${text}` : bps < 0 ? `−${text}` : text;
}

export function toneOf(n: number): string {
  return n > 0 ? 'pos' : n < 0 ? 'neg' : '';
}

/** 75 → "1:15". */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** "3 min ago", "2 h ago", or the date for older stories. */
export function timeAgo(ms: number, nowMs: number): string {
  const s = Math.max(0, Math.round((nowMs - ms) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export const SECTOR_NAMES: Record<string, string> = {
  tech: 'Technology',
  ai: 'Artificial intelligence',
  robotics: 'Robotics & automation',
  energy: 'Energy',
  health: 'Healthcare',
  finance: 'Financials',
  transport: 'Transportation',
  consumer: 'Consumer goods',
  media: 'Entertainment & media',
  industrial: 'Industrials & materials',
  aero: 'Aerospace & defense',
  utilities: 'Utilities & infrastructure',
  emerging: 'Emerging industries',
  meme: 'Memecoins',
};

export const STRENGTH_LABEL: Record<string, string> = { minor: 'Minor', moderate: 'Moderate', major: 'Major', extreme: 'Extreme' };
export const DIRECTION_LABEL: Record<string, string> = { positive: 'Positive', negative: 'Negative', uncertain: 'Mixed' };

export const CATEGORIES: [string, string][] = [
  ['', 'All categories'],
  ['product', 'Products'],
  ['partnership', 'Partnerships'],
  ['management', 'Management'],
  ['legal', 'Legal & regulation'],
  ['operations', 'Operations'],
  ['financial', 'Finance'],
  ['analyst', 'Analysts'],
  ['contract', 'Contracts'],
  ['research', 'Research'],
  ['incident', 'Incidents'],
  ['demand', 'Demand'],
  ['earnings', 'Earnings'],
  ['listing', 'New listings'],
  ['sector', 'Sector'],
  ['macro', 'Economy'],
  ['viral', 'Viral'],
];

/**
 * A price typed by the player ("12", "12.5", "$1,234.50") → whole cents. An empty box means "not set" (null); anything that is not a
 * price with at most two decimals, or is below one cent, is 'bad'.
 */
export function parsePriceInput(text: string): number | null | 'bad' {
  const t = text.trim().replace(/^\$/, '').replace(/,/g, '');
  if (t === '') return null;
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(t)) return 'bad';
  const [dollars = '0', cents = ''] = t.split('.');
  const value = Number(dollars) * 100 + Number(cents.padEnd(2, '0'));
  return value >= 1 ? value : 'bad';
}

/** Whole cents → the text of a price box ("12.50"); 0 (not set) → "". */
export function priceInput(cents: number): string {
  return cents > 0 ? (cents / 100).toFixed(2) : '';
}

// ---- earnings ------------------------------------------------------------------------------------------------------------------

/** Profit per share from mills (thousandths of a dollar): "$0.31", and "$0.031" for a small number so that it does not read as zero. */
export function formatEps(mills: number): string {
  const abs = Math.abs(mills);
  const text = abs < 100 ? (abs / 1000).toFixed(3) : (abs / 1000).toFixed(2);
  return `${mills < 0 ? '−' : ''}$${text}`;
}

/** A company's revenue with three figures: "$1.23 billion", "$345 million". */
export function formatRevenue(dollars: number): string {
  const sig3 = (x: number): string => (x < 10 ? x.toFixed(2) : x < 100 ? x.toFixed(1) : x.toFixed(0));
  if (dollars >= 1e9) return `$${sig3(dollars / 1e9)} billion`;
  if (dollars >= 1e6) return `$${sig3(dollars / 1e6)} million`;
  return `$${sig3(Math.max(1, dollars) / 1e3)} thousand`;
}

/** 840 basis points → "8.4%"; 700 → "7%" (no sign). */
export function plainPercent(bp: number): string {
  const x = Math.abs(bp) / 100;
  return `${x.toFixed(x < 10 ? 1 : 0).replace(/\.0$/, '')}%`;
}

/** The surprise against what was expected: "+8.4%", "−3.1%", "in line". */
export function formatSurprise(bp: number): string {
  if (Math.abs(bp) < 100) return 'in line';
  return `${bp > 0 ? '+' : '−'}${plainPercent(bp)}`;
}

/** What the result was, in a word, for the badge. */
export function resultWord(kind: string): { word: string; tone: 'pos' | 'neg' | '' } {
  switch (kind) {
    case 'beat':
      return { word: 'Beat', tone: 'pos' };
    case 'miss':
      return { word: 'Miss', tone: 'neg' };
    case 'inline':
      return { word: 'In line', tone: '' };
    case 'epsBeatRevMiss':
      return { word: 'Mixed', tone: '' };
    case 'epsMissRevBeat':
      return { word: 'Mixed', tone: '' };
    default:
      return { word: '—', tone: '' };
  }
}

/** "in 5 h 12 min", "in 40 min", "in 1 min", "now" for a time ahead. */
export function formatUntil(ms: number, nowMs: number): string {
  const s = Math.round((ms - nowMs) / 1000);
  if (s <= 30) return 'now';
  const m = Math.max(1, Math.round(s / 60));
  if (m < 60) return `in ${m} min`;
  const h = Math.floor(m / 60);
  return `in ${h} h ${String(m % 60).padStart(2, '0')} min`;
}
