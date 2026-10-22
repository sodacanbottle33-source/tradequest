// Companies the owner makes by hand: what the owner may choose, how the choice is checked, and how it becomes a catalog entry (the
// same kind of entry the hand-written and generated companies have). Nothing here touches the market; server/admin.ts does that.

import { PERSONALITIES, SECTORS, STOCK_SECTOR_IDS, TIERS, TIER_INFO, sectorVocabulary, type CatalogEntry, type Personality, type SectorId, type Tier } from '../src/world';
import { HttpError } from './http';

/** The cheapest and the dearest price the owner may start a company at ($2.00 and $1,000.00, in cents). */
export const MIN_STOCK_PRICE_CENTS = 200;
export const MAX_STOCK_PRICE_CENTS = 100_000;
/** The most companies the owner can make (the market has no way to remove one, so the number is capped). */
export const MAX_OWN_COMPANIES = 400;
export const NAME_MIN = 3;
export const NAME_MAX = 40;
export const DESCRIPTION_MAX = 300;
export const INDUSTRY_MAX = 50;

/** What the screen offers for each size class (the numbers behind it are the same ones every generated company uses). */
const TIER_NOTES: Readonly<Record<Tier, string>> = {
  micro: 'Tiny and thin: the price jumps around and news hits hard.',
  small: 'Small and lively: big moves are common.',
  mid: 'Medium: moves a fair bit, but not wildly.',
  large: 'Large and steady: it takes real news to move it.',
  mega: 'A giant: it hardly moves.',
};

const PERSONALITY_TEXT: Readonly<Record<Personality, readonly [string, string]>> = {
  steady: ['Steady', 'Calm. Drifts slowly, few surprises.'],
  income: ['Income', 'Very calm and slightly rising, like a dividend payer.'],
  growth: ['Growth', 'Tends to climb over time, with bumps.'],
  cyclical: ['Cyclical', 'Rises and falls in waves.'],
  volatile: ['Volatile', 'Big swings in both directions.'],
  turnaround: ['Turnaround', 'A comeback story: it may recover or fail.'],
  declining: ['Declining', 'Tends to slide down over time.'],
};

export interface StockOptions {
  readonly sectors: { id: SectorId; name: string }[];
  readonly tiers: { id: Tier; label: string; note: string }[];
  readonly personalities: { id: Personality; label: string; note: string }[];
  readonly minPriceCents: number;
  readonly maxPriceCents: number;
  readonly nameMax: number;
  readonly descriptionMax: number;
  /** Seconds between pressing Create and the first trade (about). */
  readonly listsInSeconds: number;
}

export function stockOptions(listsInSeconds: number): StockOptions {
  return {
    // Memecoins are their own market (a Memecoins tab with its own coins); the owner makes ordinary companies here.
    sectors: SECTORS.filter((s) => (STOCK_SECTOR_IDS as readonly string[]).includes(s.id)).map((s) => ({ id: s.id, name: s.name })),
    tiers: TIERS.map((t) => ({ id: t, label: TIER_INFO[t].label, note: TIER_NOTES[t] })),
    personalities: (Object.keys(PERSONALITIES) as Personality[]).map((p) => ({ id: p, label: PERSONALITY_TEXT[p][0], note: PERSONALITY_TEXT[p][1] })),
    minPriceCents: MIN_STOCK_PRICE_CENTS,
    maxPriceCents: MAX_STOCK_PRICE_CENTS,
    nameMax: NAME_MAX,
    descriptionMax: DESCRIPTION_MAX,
    listsInSeconds,
  };
}

export interface StockInput {
  readonly name?: unknown;
  readonly ticker?: unknown;
  readonly sector?: unknown;
  readonly tier?: unknown;
  readonly personality?: unknown;
  readonly priceCents?: unknown;
  readonly industry?: unknown;
  readonly description?: unknown;
}

/** The names and tickers already used by the market (names in lower case, tickers in upper case). */
export interface Taken {
  readonly names: ReadonlySet<string>;
  readonly tickers: ReadonlySet<string>;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]+/g;
const NAME_CHARS = /^[\p{L}\p{N}][\p{L}\p{N} &.,'’-]*$/u;
const INDUSTRY_CHARS = /^[\p{L}\p{N}][\p{L}\p{N} &.,'’/-]*$/u;
const TICKER_CHARS = /^[A-Z]{3,5}$/;

function oneLine(value: unknown, what: string, max: number): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new HttpError(400, 'bad_request', `${what} must be text.`);
  const text = value.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  if (text.length > max) throw new HttpError(400, 'bad_request', `${what} can be at most ${max} characters.`);
  return text;
}

function lowerFirst(s: string): string {
  // Keep acronyms such as "AI software" as they are.
  if (s.length > 1 && s.charAt(1) === s.charAt(1).toUpperCase() && /[A-Z]/.test(s.charAt(1))) return s;
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/**
 * Checks what the owner typed and turns it into a catalog entry. Every problem is a 400 with a sentence the owner can act on. The
 * rest of the company (shares, spread, volatility, the CEO's name…) is worked out from its size class, sector and personality by the
 * same code that makes every other company, using the id the company gets, so it behaves like any other stock.
 */
export function makeEntry(input: StockInput, taken: Taken): CatalogEntry {
  const name = oneLine(input.name, 'The name', NAME_MAX);
  if (name.length < NAME_MIN) throw new HttpError(400, 'bad_request', `The name needs at least ${NAME_MIN} characters.`);
  if (!NAME_CHARS.test(name) || !/\p{L}.*\p{L}/u.test(name)) throw new HttpError(400, 'bad_request', 'The name can use letters, numbers, spaces and & . , \' - (and must contain letters).');
  if (taken.names.has(name.toLowerCase())) throw new HttpError(409, 'name_taken', `A company called "${name}" already exists.`);

  const ticker = typeof input.ticker === 'string' ? input.ticker.trim().toUpperCase() : '';
  if (!TICKER_CHARS.test(ticker)) throw new HttpError(400, 'bad_request', 'The ticker is 3 to 5 letters A–Z, for example ZRLX.');
  if (taken.tickers.has(ticker)) throw new HttpError(409, 'ticker_taken', `The ticker ${ticker} is already used by another company.`);

  if (typeof input.sector !== 'string' || !(STOCK_SECTOR_IDS as readonly string[]).includes(input.sector)) throw new HttpError(400, 'bad_request', 'Pick a sector from the list.');
  if (typeof input.tier !== 'string' || !(TIERS as readonly string[]).includes(input.tier)) throw new HttpError(400, 'bad_request', 'Pick a size from the list.');
  if (typeof input.personality !== 'string' || !Object.prototype.hasOwnProperty.call(PERSONALITIES, input.personality)) throw new HttpError(400, 'bad_request', 'Pick a personality from the list.');
  const sector = input.sector as SectorId;
  const tier = input.tier as Tier;
  const personality = input.personality as Personality;

  const price = input.priceCents;
  if (typeof price !== 'number' || !Number.isSafeInteger(price) || price < MIN_STOCK_PRICE_CENTS || price > MAX_STOCK_PRICE_CENTS) {
    throw new HttpError(400, 'bad_request', `The starting price must be a whole number of cents from $${MIN_STOCK_PRICE_CENTS / 100} to $${(MAX_STOCK_PRICE_CENTS / 100).toLocaleString('en-US')}.`);
  }

  const vocab = sectorVocabulary(sector);
  const industry = oneLine(input.industry, 'The industry', INDUSTRY_MAX) || (vocab.industries[0] as string);
  if (!INDUSTRY_CHARS.test(industry)) throw new HttpError(400, 'bad_request', 'The industry can use letters, numbers, spaces and & . , \' / - only.');

  // The first word of the name is the "brand" in product names: "Zorlex Robotics" sells the "Zorlex Arm" and the "Zorlex Walker".
  const brand = name.split(' ')[0]?.replace(/[^\p{L}\p{N}]/gu, '') || name;
  const products: [string, string] = [`${brand} ${vocab.nouns[0] as string}`, `${brand} ${vocab.nouns[1] as string}`];
  let description = oneLine(input.description, 'The description', DESCRIPTION_MAX);
  if (description === '') description = `${name} is a ${TIER_INFO[tier].label.toLowerCase()} ${lowerFirst(industry)} company whose main product, ${products[0]}, is sold mostly to business customers.`;
  return { ticker, name, sector, industry, tier, price, personality, products, description };
}

// ---- stocks any player can launch ----------------------------------------------------------------------------------------
//
// A player does not pick the size class of a stock he launches, and he does not pick its starting price either: both follow from the money
// he puts in, like a coin (server/customCoin.ts). Unlike a coin, a stock cannot be made for free: it needs a real stake (at least
// MIN_STOCK_SEED_CENTS) and costs a launch fee (STOCK_LAUNCH_FEE_CENTS) on top. The money buys shares at the starting price and the player
// starts out holding them (the launch stake), so it is not lost, and he can sell them later like any other holding (that is the "rug pull",
// server/launch.ts); only the fee is gone. Stocks are steady by design, so selling a stake moves the price only a little. The personality is
// fixed to "volatile" (big swings both ways, no hidden slow drift that only the maker would know about).

/** What making a stock costs on top of the money put in ($10.00, in cents): taken from the cash and gone, whatever the money is. */
export const STOCK_LAUNCH_FEE_CENTS = 1_000;
/**
 * The least and the most money one stock launch can put in ($100.00 and $10,000,000, in cents). A stock needs a real stake, unlike a coin
 * (which can be launched for free). At the starting price of the least money ($5.00) that is already 20 shares.
 */
export const MIN_STOCK_SEED_CENTS = 10_000;
export const MAX_STOCK_SEED_CENTS = 1_000_000_000;

/**
 * Money put in (dollars) → starting price (dollars). Between two rows the price grows smoothly (in a straight line on a log–log chart), so
 * more money always starts at a higher price, and a small stock is cheap per share while a big one is dear.
 */
const PRICE_ANCHORS: readonly (readonly [number, number])[] = [
  [100, 5],
  [1_000, 12],
  [10_000, 30],
  [50_000, 60],
  [250_000, 120],
  [1_000_000, 250],
  [5_000_000, 500],
  [10_000_000, 700],
];

/** The starting price (cents, a whole number) that this much money (cents) makes. Never goes down as the money goes up. */
export function stockPriceFor(seedCents: number): number {
  const dollars = seedCents / 100;
  let lo = PRICE_ANCHORS[0] as readonly [number, number];
  for (const next of PRICE_ANCHORS) {
    if (dollars < next[0]) {
      const [s0, p0] = lo;
      const [s1, p1] = next;
      return Math.round(p0 * (p1 / p0) ** (Math.log(dollars / s0) / Math.log(s1 / s0)) * 100);
    }
    lo = next;
  }
  return Math.round(lo[1] * 100);
}

/** Where each size class begins, as money put in in dollars. */
const TIER_FROM_SEED: readonly (readonly [Tier, number])[] = [
  ['mega', 5_000_000],
  ['large', 1_000_000],
  ['mid', 250_000],
  ['small', 50_000],
  ['micro', 0],
];

export function tierOfSeed(seedCents: number): Tier {
  const dollars = seedCents / 100;
  for (const [tier, from] of TIER_FROM_SEED) if (dollars >= from) return tier;
  return 'micro';
}

export interface StockLaunchPreview {
  readonly seedCents: number;
  /** The starting price: the server works it out from the money (the player does not pick it). */
  readonly priceCents: number;
  /** How many shares the player will hold at the start (the money divided by the price, rounded down). */
  readonly stakeShares: number;
  /** What the shares really cost: whole shares at the starting price. */
  readonly spentCents: number;
  /** The launch fee, and what leaves the cash in all (the shares plus the fee). */
  readonly feeCents: number;
  readonly totalCents: number;
  readonly tier: Tier;
  readonly tierLabel: string;
  readonly tierNote: string;
  /** The market cap range of this size class, in cents (the company gets a size inside it). */
  readonly capLoCents: number;
  readonly capHiCents: number;
}

export function checkStockSeed(seed: unknown): number {
  if (typeof seed !== 'number' || !Number.isSafeInteger(seed) || seed < MIN_STOCK_SEED_CENTS || seed > MAX_STOCK_SEED_CENTS) {
    throw new HttpError(400, 'bad_request', `The money you put in must be a whole number of cents from $${(MIN_STOCK_SEED_CENTS / 100).toLocaleString('en-US')} to $${(MAX_STOCK_SEED_CENTS / 100).toLocaleString('en-US')}.`);
  }
  return seed;
}

/** What a launch with this money makes (its starting price too), and what it costs. Every problem is a sentence the player can act on. */
export function previewStock(seedCents: unknown): StockLaunchPreview {
  const seed = checkStockSeed(seedCents);
  const priceCents = stockPriceFor(seed);
  const stakeShares = Math.floor(seed / priceCents);
  if (stakeShares < 1) throw new HttpError(400, 'bad_request', 'The money you put in is less than one share costs. Put in more.');
  const tier = tierOfSeed(seed);
  const spentCents = stakeShares * priceCents;
  return {
    seedCents: seed,
    priceCents,
    stakeShares,
    spentCents,
    feeCents: STOCK_LAUNCH_FEE_CENTS,
    totalCents: STOCK_LAUNCH_FEE_CENTS + spentCents,
    tier,
    tierLabel: TIER_INFO[tier].label,
    tierNote: TIER_NOTES[tier],
    capLoCents: TIER_INFO[tier].capLo * 100,
    capHiCents: TIER_INFO[tier].capHi * 100,
  };
}

export interface StockLaunchOptions {
  readonly sectors: { id: SectorId; name: string }[];
  /** What making a stock costs (cents), paid whatever the money is. */
  readonly launchFeeCents: number;
  readonly minSeedCents: number;
  readonly maxSeedCents: number;
  readonly nameMax: number;
  readonly descriptionMax: number;
  readonly listsInSeconds: number;
  /** The size classes and the money each begins at. */
  readonly tiers: { id: Tier; label: string; note: string; fromSeedCents: number }[];
  /** What some amounts make: the starting price, the shares bought, the size class. */
  readonly ladder: { seedCents: number; priceCents: number; stakeShares: number; tierLabel: string }[];
}

export function stockLaunchOptions(listsInSeconds: number): StockLaunchOptions {
  return {
    sectors: SECTORS.filter((s) => (STOCK_SECTOR_IDS as readonly string[]).includes(s.id)).map((s) => ({ id: s.id, name: s.name })),
    launchFeeCents: STOCK_LAUNCH_FEE_CENTS,
    minSeedCents: MIN_STOCK_SEED_CENTS,
    maxSeedCents: MAX_STOCK_SEED_CENTS,
    nameMax: NAME_MAX,
    descriptionMax: DESCRIPTION_MAX,
    listsInSeconds,
    tiers: [...TIER_FROM_SEED].reverse().map(([id, from]) => ({ id, label: TIER_INFO[id].label, note: TIER_NOTES[id], fromSeedCents: id === 'micro' ? MIN_STOCK_SEED_CENTS : from * 100 })),
    ladder: PRICE_ANCHORS.map(([dollars]) => {
      const p = previewStock(dollars * 100);
      return { seedCents: p.seedCents, priceCents: p.priceCents, stakeShares: p.stakeShares, tierLabel: p.tierLabel };
    }),
  };
}

export interface StockLaunchInput {
  readonly name?: unknown;
  readonly ticker?: unknown;
  readonly sector?: unknown;
  readonly seedCents?: unknown;
  readonly industry?: unknown;
  readonly description?: unknown;
}

/** Checks what a player typed and turns it into a catalog entry for his stock, plus the preview of what it costs and what it will be. */
export function makeLaunchedStockEntry(input: StockLaunchInput, taken: Taken): { entry: CatalogEntry; preview: StockLaunchPreview } {
  const preview = previewStock(input.seedCents);
  const entry = makeEntry({ ...input, tier: preview.tier, personality: 'volatile' satisfies Personality, priceCents: preview.priceCents }, taken);
  return { entry, preview };
}
