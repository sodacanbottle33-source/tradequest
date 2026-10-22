// Memecoins that players launch. Like pump.fun, MAKING a coin is nearly free: it costs a small fixed launch fee (LAUNCH_FEE_CENTS, $2.00) and
// nothing else, and the player may also buy some of his own coin right away (the "first buy": $0, or from $2.00). The player does NOT pick a
// size class: the size comes from that first buy (with no first buy, the coin is the smallest one).
//
//   - Less money makes a small, thin, wild coin: low liquidity, huge swings, news hits hard.
//   - More money makes a bigger, deeper, calmer coin: more liquidity, smaller swings.
//
// The player does NOT pick a starting price either. Like a fixed-supply token launch, every launched coin has the same number of coins
// (COIN_SUPPLY), so the money sets the market cap and the starting price is simply that cap divided by the coins: put in more money and
// the coin starts at a higher price ($5,000 starts at $2.00; $10,000,000 at $5,500.00). The cheapest a coin can start is $2.00 (so it has
// room to fall to the game's $1.00 floor), so with less than $5,000 the price stays at $2.00 and the coin simply has fewer coins: $100
// makes a coin with 1,600 coins, and the least money, $2.00, buys the single coin it takes to launch.
//
// The first buy is not lost. It is spent at the starting price and the player starts out holding that many whole coins (the launch stake),
// so it can be sold later like any other holding (the 0.5 % coin fee applies to that later trade). It decides the size; it is NOT a real
// pool that backs the price. The launch fee, on the other hand, is simply paid and gone. The coin is sized so that its stake is a real part of its order book (a few times
// smaller than the book): that is what lets the player sell the whole stake in one go (the "rug pull", server/launch.ts) and what makes
// doing so show in the price. Nothing here touches the market; server/launch.ts does that.

import { applyMarkup, bookDepth, pushPreview } from './flow';
import { MEME_FEE_BPS, feeOf } from './fees';
import { HttpError } from './http';
import { executeMarket, ladder, memeAdv, quoteOf, tierOfCap, type CatalogEntry, type MemeProfile } from '../src/world';

/**
 * The least and the most money a first buy can use ($2.00 and $10,000,000, in cents). A first buy has to buy at least one whole coin and
 * the cheapest a coin starts is MIN_COIN_PRICE_CENTS, so $2.00 is the least there can be, except for no first buy at all ($0).
 */
export const MIN_SEED_CENTS = 200;
export const MAX_SEED_CENTS = 1_000_000_000;
/** What making a coin costs, in cents ($2.00), paid from the player's Career cash whatever he buys; it is not refunded and buys nothing. */
export const LAUNCH_FEE_CENTS = 200;
/** The cheapest a launched coin can start ($2.00, in cents): the game's price floor is $1.00, so a coin always has room to fall. */
export const MIN_COIN_PRICE_CENTS = 200;
/**
 * A launched coin has exactly this many coins in circulation, whatever the money, once the money is $5,000 or more. The money sets the
 * market cap (the table below), so the starting price is the cap divided by this: $5,000 → $2.00, $25,000 → about $10, $100,000 → about
 * $40, $10 million → about $5,500. With less money the price stays at the $2.00 minimum and there are fewer coins ({@link supplyFor}).
 */
export const COIN_SUPPLY = 80_000;
export const COIN_NAME_MIN = 3;
export const COIN_NAME_MAX = 40;
export const COIN_DESCRIPTION_MAX = 300;
export const COIN_DEV_MAX = 24;
export const DEFAULT_DEV = 'AnonDev';

export type CoinSizeId = 'micro' | 'small' | 'mid' | 'blue';

interface Anchor {
  /** Money put in, in dollars. */
  readonly seed: number;
  /** Market cap in millions of dollars. */
  readonly capM: number;
  readonly liquidity: number;
  readonly vol3m: number;
  readonly floatFrac: number;
  readonly turnover: number;
  readonly dailyVol: number;
  readonly newsImpact: number;
  readonly driftDay: number;
}

/**
 * Money put in → what the coin is like. Between two rows every number slides smoothly (on a log scale of the money), so $7,000 makes a
 * slightly bigger coin than $6,000. The market cap is about 32–44 times the money, so the launch stake is a few percent of all the coins
 * and a sizeable part (roughly a third) of the order book: big enough to move the price when it is sold, small enough to be sold at once.
 * Liquidity, swings and news sensitivity are the same kinds of numbers the thirty built-in coins have: little money is like the smallest
 * ones (RUGZ, SUSY), a million and up is like the calmer ones.
 */
const ANCHORS: readonly Anchor[] = [
  { seed: 5_000, capM: 0.16, liquidity: 0.1, vol3m: 0.45, floatFrac: 0.4, turnover: 1.6, dailyVol: 0.5, newsImpact: 7, driftDay: 0.12 },
  { seed: 25_000, capM: 0.8, liquidity: 0.17, vol3m: 0.38, floatFrac: 0.45, turnover: 1.4, dailyVol: 0.45, newsImpact: 6.5, driftDay: 0.1 },
  { seed: 100_000, capM: 3.2, liquidity: 0.26, vol3m: 0.3, floatFrac: 0.55, turnover: 1.0, dailyVol: 0.35, newsImpact: 5.5, driftDay: 0.08 },
  { seed: 500_000, capM: 17, liquidity: 0.4, vol3m: 0.22, floatFrac: 0.65, turnover: 0.7, dailyVol: 0.25, newsImpact: 4, driftDay: 0.06 },
  { seed: 2_000_000, capM: 76, liquidity: 0.55, vol3m: 0.16, floatFrac: 0.75, turnover: 0.45, dailyVol: 0.18, newsImpact: 3, driftDay: 0.04 },
  { seed: 10_000_000, capM: 440, liquidity: 0.68, vol3m: 0.11, floatFrac: 0.8, turnover: 0.3, dailyVol: 0.12, newsImpact: 2.5, driftDay: 0.03 },
];

const SIZE_INFO: Readonly<Record<CoinSizeId, { label: string; note: string }>> = {
  micro: { label: 'Micro coin', note: 'Tiny and thin: the price jumps around, one order can move it a lot, and news hits very hard.' },
  small: { label: 'Small coin', note: 'Small and lively: big moves are common.' },
  mid: { label: 'Mid coin', note: 'Medium: still wild, but it takes a bigger order to push it.' },
  blue: { label: 'Blue-chip coin', note: 'Large and deep: the calmest kind of memecoin. It is still far wilder than any stock.' },
};

/** Where the size classes begin, as a market cap in millions of dollars. */
const SIZE_FROM_CAP_M: readonly [CoinSizeId, number][] = [
  ['blue', 100],
  ['mid', 10],
  ['small', 1],
  ['micro', 0],
];

function sizeOfCap(capM: number): CoinSizeId {
  for (const [id, from] of SIZE_FROM_CAP_M) if (capM >= from) return id;
  return 'micro';
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** All the numbers that follow from the money put in. */
interface Profile {
  readonly capDollars: number;
  readonly liquidity: number;
  readonly vol3m: number;
  readonly floatFrac: number;
  readonly turnover: number;
  readonly dailyVol: number;
  readonly newsImpact: number;
  readonly driftDay: number;
}

function profileOf(seedCents: number): Profile {
  // With no first buy ($0) the coin is the smallest one: the same as a $2.00 first buy.
  const seed = Math.max(seedCents, MIN_SEED_CENTS) / 100;
  let i = 0;
  while (i < ANCHORS.length - 2 && seed >= (ANCHORS[i + 1] as Anchor).seed) i += 1;
  const a = ANCHORS[i] as Anchor;
  const b = ANCHORS[i + 1] as Anchor;
  const t = Math.min(1, Math.max(0, (Math.log10(seed) - Math.log10(a.seed)) / (Math.log10(b.seed) - Math.log10(a.seed))));
  const r3 = (x: number): number => Math.round(x * 1000) / 1000;
  // Below the first row the coin is as wild and thin as the $5,000 one, and its cap keeps the same ratio to the money (a straight line down).
  const capDollars = i === 0 && seed < a.seed ? Math.round((a.capM * 1e6 * seed) / a.seed) : Math.round(Math.exp(lerp(Math.log(a.capM), Math.log(b.capM), t)) * 1e6);
  return {
    // The cap grows in step with the money (a straight line on a log scale), so the stake stays the same share of the coin all the way up.
    capDollars,
    liquidity: r3(lerp(a.liquidity, b.liquidity, t)),
    vol3m: r3(lerp(a.vol3m, b.vol3m, t)),
    floatFrac: r3(lerp(a.floatFrac, b.floatFrac, t)),
    turnover: r3(lerp(a.turnover, b.turnover, t)),
    dailyVol: r3(lerp(a.dailyVol, b.dailyVol, t)),
    newsImpact: r3(lerp(a.newsImpact, b.newsImpact, t)),
    driftDay: r3(lerp(a.driftDay, b.driftDay, t)),
  };
}

/** What the screen shows before the player presses Create (and what the coin will be like afterwards). */
export interface CoinPreview {
  readonly seedCents: number;
  /** The starting price (cents): the market cap the money makes, divided by {@link COIN_SUPPLY}. The player does not pick it. */
  readonly priceCents: number;
  /** How many coins the player will hold at the start (the first buy divided by the price, rounded down; 0 with no first buy). */
  readonly stakeShares: number;
  /** What the first buy really costs: whole coins at the starting price (0 with no first buy). */
  readonly spentCents: number;
  /** The launch fee (the same for every coin) and everything that leaves the player's cash: the fee plus the first buy. */
  readonly feeCents: number;
  readonly totalCents: number;
  readonly size: CoinSizeId;
  readonly sizeLabel: string;
  readonly sizeNote: string;
  readonly marketCapCents: number;
  readonly supply: number;
  readonly floatShares: number;
  /** 0 … 100: how easily big orders are absorbed. */
  readonly liquidityPct: number;
  readonly spreadBps: number;
  /** A typical price change over 3 minutes, in percent (one standard deviation). */
  readonly typicalMovePct: number;
  /** The player's share of all coins, in percent. */
  readonly stakePct: number;
  /** Coins in the whole order book when it is calm, and the stake as a share of it (percent). A stake bigger than the book cannot be sold in one go. */
  readonly bookDepthShares: number;
  readonly stakeOfBookPct: number;
  /**
   * What selling the whole stake in one order right after the launch would do (the "rug pull"), worked out with the same rules a real
   * order follows: the share of the stake the book takes (100 = all of it), the cash that comes back after the 0.5 % fee, how much of
   * the value that costs, how far the price falls, and how much the price has to rise first for such a sale to get the money back.
   */
  readonly dumpFilledPct: number;
  readonly dumpReceiveCents: number;
  readonly dumpCostPct: number;
  readonly dumpPriceDropPct: number;
  readonly breakEvenRisePct: number;
}

/**
 * How many coins the money makes: {@link COIN_SUPPLY} when the money is $5,000 or more, fewer below that (the price cannot go under the
 * $2.00 minimum, so a smaller cap means fewer coins, never more than the cap divided by the minimum price).
 */
export function supplyFor(seedCents: number): number {
  const capCents = profileOf(seedCents).capDollars * 100;
  if (capCents / COIN_SUPPLY >= MIN_COIN_PRICE_CENTS) return COIN_SUPPLY;
  return Math.max(1, Math.round(capCents / MIN_COIN_PRICE_CENTS));
}

/** The starting price (cents) the money makes: its market cap divided by the coins, to the nearest cent, never under $2.00. */
export function priceFor(seedCents: number): number {
  return Math.max(MIN_COIN_PRICE_CENTS, Math.round((profileOf(seedCents).capDollars * 100) / COIN_SUPPLY));
}

/** The money of the first buy: nothing at all ($0), or a whole number of cents from $2.00 to $10,000,000. */
export function checkSeed(seed: unknown): number {
  if (typeof seed !== 'number' || !Number.isSafeInteger(seed) || seed < 0 || (seed > 0 && seed < MIN_SEED_CENTS) || seed > MAX_SEED_CENTS) {
    throw new HttpError(
      400,
      'bad_request',
      `The money you put in for your first buy must be $0 (no first buy) or a whole number of cents from $${(MIN_SEED_CENTS / 100).toLocaleString('en-US')} to $${(MAX_SEED_CENTS / 100).toLocaleString('en-US')}.`,
    );
  }
  return seed;
}

/**
 * Sells `stake` coins into the calm book of a coin like this one, at its starting price, with the same rules a real Career order follows
 * (the book's levels, the trader's share of the price push, the 0.5 % fee). Used for the preview only; nothing is traded.
 */
function dumpOf(
  c: { supply: number; turnover: number; liquidity: number; vol3m: number; spreadBps: number },
  priceCents: number,
  stake: number,
): Pick<CoinPreview, 'bookDepthShares' | 'stakeOfBookPct' | 'dumpFilledPct' | 'dumpReceiveCents' | 'dumpCostPct' | 'dumpPriceDropPct' | 'breakEvenRisePct'> {
  const co = { avgDailyVolume: memeAdv(c), liquidity: c.liquidity, vol3m: c.vol3m, spreadBps: c.spreadBps };
  const depth = bookDepth(co);
  // No first buy: nothing is held, so there is nothing to sell.
  if (stake === 0) return { bookDepthShares: depth, stakeOfBookPct: 0, dumpFilledPct: 0, dumpReceiveCents: 0, dumpCostPct: 0, dumpPriceDropPct: 0, breakEvenRisePct: 0 };
  const quote = quoteOf(co, priceCents, 1);
  const levels = ladder(co, quote, 1, 'sell');
  const raw = executeMarket(levels, 'sell', stake, 0, { mid: priceCents });
  const flow = pushPreview(co, 0, 'sell', raw.filledQty);
  const exec = applyMarkup(raw, 'sell', priceCents, levels[0]?.price ?? 0, flow.paid);
  const receive = Math.max(0, exec.totalCents - feeOf(exec.totalCents, MEME_FEE_BPS));
  const worth = exec.filledQty * priceCents;
  const cost = worth > 0 ? Math.min(1, Math.max(0, 1 - receive / worth)) : 1;
  const r1 = (x: number): number => Math.round(x * 10) / 10;
  return {
    bookDepthShares: depth,
    stakeOfBookPct: r1((stake / depth) * 100),
    dumpFilledPct: r1((exec.filledQty / stake) * 100),
    dumpReceiveCents: receive,
    dumpCostPct: r1(cost * 100),
    dumpPriceDropPct: r1(Math.abs(flow.move) * 100),
    breakEvenRisePct: cost >= 1 ? 0 : r1((cost / (1 - cost)) * 100),
  };
}

/** Checks the first buy and works out everything the coin will be, its starting price included. Every problem is a sentence the player can act on. */
export function previewCoin(seedCents: unknown): CoinPreview {
  const seed = checkSeed(seedCents);
  const p = profileOf(seed);
  const priceCents = priceFor(seed);
  const stakeShares = Math.floor(seed / priceCents);
  if (seed > 0 && stakeShares < 1) throw new HttpError(400, 'bad_request', 'The money you put in is less than one coin costs. Put in more.');
  const supply = supplyFor(seed);
  const floatShares = Math.min(supply, Math.max(1, Math.round(supply * p.floatFrac)));
  const lowLiq = 1 - p.liquidity;
  const size = sizeOfCap(p.capDollars / 1e6);
  const spreadBps = Math.round((8 + 150 * lowLiq * lowLiq) * 10) / 10;
  const dump = dumpOf({ supply, turnover: p.turnover, liquidity: p.liquidity, vol3m: p.vol3m, spreadBps }, priceCents, stakeShares);
  return {
    seedCents: seed,
    priceCents,
    stakeShares,
    spentCents: stakeShares * priceCents,
    feeCents: LAUNCH_FEE_CENTS,
    totalCents: LAUNCH_FEE_CENTS + stakeShares * priceCents,
    size,
    sizeLabel: SIZE_INFO[size].label,
    sizeNote: SIZE_INFO[size].note,
    marketCapCents: supply * priceCents,
    supply,
    floatShares,
    liquidityPct: Math.round(p.liquidity * 100),
    spreadBps,
    typicalMovePct: Math.round(p.vol3m * 1000) / 10,
    stakePct: Math.round((stakeShares / supply) * 1e6) / 1e4,
    ...dump,
  };
}

/** The sizes the form lists, so the player can see what a given amount of money buys before typing it. */
export interface CoinOptions {
  /** What making a coin costs (cents), whatever the first buy is. */
  readonly launchFeeCents: number;
  /** The first buy is $0 (none) or from this much (cents) up to {@link maxSeedCents}. */
  readonly minSeedCents: number;
  readonly maxSeedCents: number;
  /** How many coins a launched coin has once the money is {@link fullSupplyFromSeedCents} or more (the price is the market cap the money makes divided by this). */
  readonly supply: number;
  /** The least money that makes a coin with the full number of coins; below it the price stays at {@link minPriceCents} and there are fewer coins. */
  readonly fullSupplyFromSeedCents: number;
  /** The cheapest a coin can start (cents). */
  readonly minPriceCents: number;
  readonly nameMax: number;
  readonly descriptionMax: number;
  readonly devMax: number;
  /** Seconds between pressing Create and the first trade (about). */
  readonly listsInSeconds: number;
  /** What some round amounts of first buy make (the first row is no first buy at all), starting price included. */
  readonly ladder: { seedCents: number; priceCents: number; supply: number; sizeLabel: string; marketCapCents: number; liquidityPct: number; typicalMovePct: number; stakeOfBookPct: number; dumpCostPct: number }[];
}

export function coinOptions(listsInSeconds: number): CoinOptions {
  // No first buy at all, a few small amounts, and the table's own rows.
  const ladder = [0, 200, 10_000, 100_000, ...ANCHORS.map((a) => a.seed * 100)].map((seedCents) => {
    const pv = previewCoin(seedCents);
    return { seedCents, priceCents: pv.priceCents, supply: pv.supply, sizeLabel: pv.sizeLabel, marketCapCents: pv.marketCapCents, liquidityPct: pv.liquidityPct, typicalMovePct: pv.typicalMovePct, stakeOfBookPct: pv.stakeOfBookPct, dumpCostPct: pv.dumpCostPct };
  });
  return {
    launchFeeCents: LAUNCH_FEE_CENTS,
    minSeedCents: MIN_SEED_CENTS,
    maxSeedCents: MAX_SEED_CENTS,
    supply: COIN_SUPPLY,
    fullSupplyFromSeedCents: (ANCHORS[0] as Anchor).seed * 100,
    minPriceCents: MIN_COIN_PRICE_CENTS,
    nameMax: COIN_NAME_MAX,
    descriptionMax: COIN_DESCRIPTION_MAX,
    devMax: COIN_DEV_MAX,
    listsInSeconds,
    ladder,
  };
}

export interface CoinInput {
  readonly name?: unknown;
  readonly ticker?: unknown;
  readonly seedCents?: unknown;
  readonly description?: unknown;
  readonly dev?: unknown;
}

/** The names and tickers already used by the market (names in lower case, tickers in upper case). */
export interface Taken {
  readonly names: ReadonlySet<string>;
  readonly tickers: ReadonlySet<string>;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]+/g;
const NAME_CHARS = /^[\p{L}\p{N}][\p{L}\p{N} &.,'’-]*$/u;
const DEV_CHARS = /^[\p{L}\p{N}][\p{L}\p{N}_.-]*$/u;
const TICKER_CHARS = /^[A-Z]{3,5}$/;

function oneLine(value: unknown, what: string, max: number): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new HttpError(400, 'bad_request', `${what} must be text.`);
  const text = value.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  if (text.length > max) throw new HttpError(400, 'bad_request', `${what} can be at most ${max} characters.`);
  return text;
}

/**
 * Checks what the player typed and turns it into a catalog entry for a memecoin, plus the preview of what it costs and what it will be.
 * The coin states all its own numbers (they are saved with it and never change), and neither the size class nor the starting price is an
 * input: both follow from the money.
 */
export function makeCoinEntry(input: CoinInput, taken: Taken): { entry: CatalogEntry; preview: CoinPreview } {
  const name = oneLine(input.name, 'The name', COIN_NAME_MAX);
  if (name.length < COIN_NAME_MIN) throw new HttpError(400, 'bad_request', `The name needs at least ${COIN_NAME_MIN} characters.`);
  if (!NAME_CHARS.test(name) || !/\p{L}.*\p{L}/u.test(name)) throw new HttpError(400, 'bad_request', 'The name can use letters, numbers, spaces and & . , \' - (and must contain letters).');
  if (taken.names.has(name.toLowerCase())) throw new HttpError(409, 'name_taken', `A company called "${name}" already exists.`);

  const ticker = typeof input.ticker === 'string' ? input.ticker.trim().toUpperCase() : '';
  if (!TICKER_CHARS.test(ticker)) throw new HttpError(400, 'bad_request', 'The ticker is 3 to 5 letters A–Z, for example PEPE.');
  if (taken.tickers.has(ticker)) throw new HttpError(409, 'ticker_taken', `The ticker ${ticker} is already used by another company.`);

  const preview = previewCoin(input.seedCents);
  const dev = oneLine(input.dev, 'The developer name', COIN_DEV_MAX) || DEFAULT_DEV;
  if (!DEV_CHARS.test(dev)) throw new HttpError(400, 'bad_request', 'The developer name can use letters, numbers, _ . and - only (no spaces).');

  // The first word of the name is the "brand" in product names: "Moon Pepe" has the "Moon Swap" and the "Moon Vault".
  const brand = name.split(' ')[0]?.replace(/[^\p{L}\p{N}]/gu, '') || name;
  const products: [string, string] = [`${brand} Swap`, `${brand} Vault`];
  let description = oneLine(input.description, 'The description', COIN_DESCRIPTION_MAX);
  if (description === '') description = `${name} is a brand-new memecoin. Nobody is sure what it is for yet, which is how most of them start.`;

  const p = profileOf(preview.seedCents);
  const meme: MemeProfile = {
    supply: preview.supply,
    floatFrac: p.floatFrac,
    turnover: p.turnover,
    liquidity: p.liquidity,
    vol3m: p.vol3m,
    dailyVol: p.dailyVol,
    newsImpact: p.newsImpact,
    driftDay: p.driftDay,
    dev,
  };
  const entry: CatalogEntry = {
    ticker,
    name,
    sector: 'meme',
    industry: 'Memecoin',
    tier: tierOfCap(preview.supply * (preview.priceCents / 100)),
    price: preview.priceCents,
    personality: 'volatile',
    products,
    description,
    meme,
  };
  return { entry, preview };
}
