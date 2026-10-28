// Persistent world — fixed parameters. See docs/world.md.
// The world is a pure function of (world seed, catalog, stored events). Changing ANY value in this file changes every
// price the world produces from then on, so WORLD_ENGINE_VERSION must be bumped and a running world needs a migration.
// This file (like the rest of src/world) may only use + − × ÷ and comparisons on numbers: no Math.exp/log/pow/sqrt,
// no clock, no randomness except the seeded streams from ../engine/rng (tests/static.test.ts enforces this).

export const WORLD_ENGINE_VERSION = 4;

// ---- time -------------------------------------------------------------------------------------------------------
/** One market tick is one second of real time. */
export const TICK_MS = 1000;
/** Every candlestick covers exactly this many ticks (same rule as the live market, rules.md §13.4). */
export const TICKS_PER_CANDLE = 10;
export const TICKS_PER_HOUR = 3600;
export const TICKS_PER_DAY = 86_400;
export const CANDLES_PER_HOUR = TICKS_PER_HOUR / TICKS_PER_CANDLE; // 360
export const CANDLES_PER_DAY = TICKS_PER_DAY / TICKS_PER_CANDLE; // 8640
/** Length of one news cycle: at least three news items per company are scheduled inside every cycle. */
export const NEWS_CYCLE_TICKS = TICKS_PER_DAY;
/** A 1v1 match lasts exactly 3 minutes of market time. */
export const MATCH_TICKS = 180;

// ---- prices -----------------------------------------------------------------------------------------------------
export const MIN_PRICE = 100; // $1.00 in cents
/**
 * The highest price a share can reach: $1,000,000.00. The most expensive real share (Berkshire Hathaway A) costs around $700,000, so
 * this is as high as real stocks go, with a little room. It was $50,000, then $1,000,000,000 while the owner could pump a company
 * almost without limit. Prices are whole cents and the server multiplies a price by a number of shares, so some ceiling has to
 * exist; the order, gift and account code is safe at it (server/trading.ts `maxOrderShares`, server/admin.ts `adjustShares`).
 */
export const MAX_PRICE = 100_000_000;
/** Deviation of the traded price from the fundamental value can never exceed this fraction. */
export const DEVIATION_CAP = 0.35;
/**
 * Calmer stocks. From the tick `calmFrom` of a world (stored with it: `calm_from_tick`, 0 in a world made after this change, the first tick
 * after the upgrade in an older one) the FAST jitter of every stock (the noise, momentum and order-flow terms around its fundamental value;
 * not the market or sector noise, not the slow trend, not the news) is multiplied by this. Memecoins keep theirs. Without a `calmFrom` a
 * simulation is exactly what it always was, so the engine version stays 4 and nothing that already happened is recomputed differently.
 */
export const STOCK_JITTER_CALM = 0.5;

// ---- random draws -----------------------------------------------------------------------------------------------
/** Uniform draws consumed per stock per tick: four 6-draw normals + one plain uniform. */
export const DRAWS_PER_TICK = 25;
/** Uniform draws per tick for the market-wide streams (two normals). */
export const MARKET_DRAWS_PER_TICK = 12;
/** First draw number (inside a stock's day stream) reserved for once-a-day decisions (regime changes). */
export const DAILY_DRAW_BASE = TICKS_PER_DAY * DRAWS_PER_TICK + 1;
/** Stream index reserved for the market-wide streams. Stocks use indexes 0 … MAX_COMPANIES − 1. */
export const MARKET_STREAM_INDEX = 0xffff;
export const SECTOR_STREAM_BASE = 0xff00;
export const MAX_COMPANIES = 0xfe00; // 65 024
/** sqrt(2): a normal-ish number is (sum of 6 uniforms − 3) · SQRT2 (variance 1, bounded at ±4.24). */
export const SQRT2 = 1.4142135623730951;

// ---- model dynamics (per tick) ----------------------------------------------------------------------------------
export const THETA_D = 1 / 450; // pull of the traded price back toward fundamental value (half-life ≈ 5 min)
export const THETA_M = 1 / 900; // fading of momentum
export const THETA_Q = 1 / 120; // fading of order-flow imbalance
export const THETA_V = 0.025; // volatility regime returns to normal (time constant ≈ 110 ticks)
export const SHOCK_V = 0.02; // how strongly a big move raises volatility (must stay below THETA_V / 0.8 or volatility runs away)
export const V_MIN = 0.5;
export const V_MAX = 3;
export const ANCHOR_PULL = 1 / (25 * TICKS_PER_DAY); // slow pull of fundamentals toward the company's long-run anchor
export const ANCHOR_DRIFT_DAY = 0.0004; // anchors of growth companies rise this fraction per day, decliners fall
export const ERA_TICKS = 3 * TICKS_PER_DAY; // trend regimes last 3 days, then may change
export const THETA_MARKET = 1 / 30_000; // market sentiment fades with a half-life of ≈ 5.8 hours
export const SIGMA_MARKET_SLOW = 1.1e-9; // innovation of the slow market sentiment (per tick); stationary std ≈ 1.4e-7, i.e. ≈ 1% a day
export const SIGMA_MARKET_FAST = 0.0006; // market-wide noise per tick
export const THETA_SECTOR = 1 / 20_000;
export const SIGMA_SECTOR_SLOW = 9e-10; // same for each sector
export const SIGMA_SECTOR_FAST = 0.0003;
/** Calibration factor between a company's 3-minute volatility and its per-tick deviation noise: 1/√180. */
export const SIGMA_FROM_VOL3M = 0.0648;
/** 1/√86400: converts a daily volatility to a per-tick one. */
export const SIGMA_FROM_DAILY = 0.003402069087198859;
/** Order-flow imbalance: innovation size, and the price pressure it exerts as a multiple of the company's own noise. */
export const FLOW_NOISE = 0.1;
export const FLOW_PRESSURE = 0.08;
/** Market sentiment that counts as "fully optimistic" when it scales the effect of news (per tick). */
export const SENTIMENT_REF = 3e-7;
/** News is felt up to this much more (or less) strongly when sentiment agrees (or disagrees) with the news. */
export const SENTIMENT_GAIN = 0.3;

// ---- liquidity ---------------------------------------------------------------------------------------------------
export const BOOK_LEVELS = 20;
/** Share of average daily volume resting at the best price, as liquidity goes from 0 to 1: 0.04% … 0.30%. */
export const TOUCH_FRAC_MIN = 0.0004;
export const TOUCH_FRAC_SPAN = 0.0026;
/** Each deeper level holds this much more than the one before (fraction of the touch size). */
export const LEVEL_GROWTH = 0.35;
/** The player's own consumed depth recovers with this half-life. */
export const IMPACT_RECOVERY_TICKS = 300;
export const MAX_ORDER_SHARES = 100_000_000;

// ---- sectors ----------------------------------------------------------------------------------------------------
export type SectorId =
  | 'tech'
  | 'ai'
  | 'robotics'
  | 'energy'
  | 'health'
  | 'finance'
  | 'transport'
  | 'consumer'
  | 'media'
  | 'industrial'
  | 'aero'
  | 'utilities'
  | 'emerging'
  | 'meme';

export interface SectorInfo {
  readonly id: SectorId;
  readonly name: string;
  /** Multiplies a company's volatility. */
  readonly volMult: number;
  /** How strongly the company follows its sector's own sentiment (0 … 1). */
  readonly sectorBeta: number;
}

export const SECTORS: readonly SectorInfo[] = [
  { id: 'tech', name: 'Technology', volMult: 1.0, sectorBeta: 0.8 },
  { id: 'ai', name: 'Artificial intelligence', volMult: 1.25, sectorBeta: 0.9 },
  { id: 'robotics', name: 'Robotics & automation', volMult: 1.1, sectorBeta: 0.8 },
  { id: 'energy', name: 'Energy', volMult: 1.05, sectorBeta: 0.9 },
  { id: 'health', name: 'Healthcare', volMult: 1.0, sectorBeta: 0.6 },
  { id: 'finance', name: 'Financials', volMult: 0.9, sectorBeta: 0.8 },
  { id: 'transport', name: 'Transportation', volMult: 1.0, sectorBeta: 0.8 },
  { id: 'consumer', name: 'Consumer goods', volMult: 0.8, sectorBeta: 0.6 },
  { id: 'media', name: 'Entertainment & media', volMult: 1.05, sectorBeta: 0.7 },
  { id: 'industrial', name: 'Industrials & materials', volMult: 0.9, sectorBeta: 0.8 },
  { id: 'aero', name: 'Aerospace & defense', volMult: 0.95, sectorBeta: 0.7 },
  { id: 'utilities', name: 'Utilities & infrastructure', volMult: 0.7, sectorBeta: 0.5 },
  { id: 'emerging', name: 'Emerging industries', volMult: 1.4, sectorBeta: 0.9 },
  // Added after the market was running: it is LAST so every earlier sector keeps its number and its random stream, and so no
  // existing price changes. Its coins carry their own numbers (see memecoins.ts), so volMult is not used for them.
  { id: 'meme', name: 'Memecoins', volMult: 1.0, sectorBeta: 1.0 },
];

export const SECTOR_IDS: readonly SectorId[] = SECTORS.map((s) => s.id);
/**
 * The sectors the procedural company generator and the owner's "make a company" form use: all of them except the memecoins, which
 * only exist as the hand-made coins of memecoins.ts. (Companies the generator made in existing worlds must never change, so it keeps
 * cycling through the original thirteen.)
 */
export const STOCK_SECTOR_IDS: readonly SectorId[] = SECTOR_IDS.filter((s) => s !== 'meme');

export function sectorIndex(id: SectorId): number {
  const i = SECTOR_IDS.indexOf(id);
  if (i < 0) throw new Error(`Unknown sector ${id}`);
  return i;
}

export function sectorInfo(id: SectorId): SectorInfo {
  const s = SECTORS[sectorIndex(id)];
  if (!s) throw new Error(`Unknown sector ${id}`);
  return s;
}

// ---- size classes ------------------------------------------------------------------------------------------------
export type Tier = 'micro' | 'small' | 'mid' | 'large' | 'mega';
export const TIERS: readonly Tier[] = ['micro', 'small', 'mid', 'large', 'mega'];

export interface TierInfo {
  readonly tier: Tier;
  readonly label: string;
  /** Market capitalisation range in whole dollars. */
  readonly capLo: number;
  readonly capHi: number;
  /** Share of all shares traded per day (average daily volume / shares outstanding). */
  readonly turnover: number;
  /** Share of outstanding shares that is freely tradable. */
  readonly floatFrac: number;
  readonly liquidity: readonly [number, number];
  /** Price change over 3 minutes (one standard deviation, fraction). */
  readonly vol3m: readonly [number, number];
  /** Fundamental value change per day (one standard deviation, fraction). */
  readonly dailyVol: readonly [number, number];
  /** How strongly news moves a company of this size. */
  readonly impact: number;
  readonly beta: number;
  /** Size of a trend regime's daily drift, fraction per day. */
  readonly drift: number;
}

export const TIER_INFO: Readonly<Record<Tier, TierInfo>> = {
  micro: { tier: 'micro', label: 'Micro-cap', capLo: 25e6, capHi: 250e6, turnover: 0.012, floatFrac: 0.55, liquidity: [0.12, 0.3], vol3m: [0.05, 0.075], dailyVol: [0.04, 0.06], impact: 1.9, beta: 1.35, drift: 0.0045 },
  small: { tier: 'small', label: 'Small-cap', capLo: 300e6, capHi: 2e9, turnover: 0.009, floatFrac: 0.65, liquidity: [0.3, 0.52], vol3m: [0.03, 0.048], dailyVol: [0.028, 0.042], impact: 1.4, beta: 1.2, drift: 0.0035 },
  mid: { tier: 'mid', label: 'Mid-cap', capLo: 2e9, capHi: 10e9, turnover: 0.006, floatFrac: 0.78, liquidity: [0.5, 0.74], vol3m: [0.02, 0.032], dailyVol: [0.018, 0.028], impact: 1.0, beta: 1.0, drift: 0.0028 },
  large: { tier: 'large', label: 'Large-cap', capLo: 10e9, capHi: 80e9, turnover: 0.0045, floatFrac: 0.88, liquidity: [0.72, 0.9], vol3m: [0.012, 0.02], dailyVol: [0.012, 0.019], impact: 0.7, beta: 0.9, drift: 0.002 },
  mega: { tier: 'mega', label: 'Mega-cap', capLo: 100e9, capHi: 500e9, turnover: 0.0035, floatFrac: 0.93, liquidity: [0.88, 0.97], vol3m: [0.007, 0.012], dailyVol: [0.009, 0.014], impact: 0.5, beta: 0.85, drift: 0.0014 },
};

/** Size class of a market capitalisation in dollars (display and sensitivity use this, not the stored tier). */
export function tierOfCap(capDollars: number): Tier {
  if (capDollars < 300e6) return 'micro';
  if (capDollars < 2e9) return 'small';
  if (capDollars < 10e9) return 'mid';
  if (capDollars < 100e9) return 'large';
  return 'mega';
}

// ---- personalities ------------------------------------------------------------------------------------------------
export type Personality = 'steady' | 'growth' | 'cyclical' | 'volatile' | 'turnaround' | 'declining' | 'income';

export interface PersonalityInfo {
  readonly volMult: number;
  /** Probabilities of entering an up / flat / down trend when a new trend regime is drawn. */
  readonly pUp: number;
  readonly pFlat: number;
  readonly pDown: number;
  /** Probability that the current regime simply continues when an era ends. */
  readonly stickiness: number;
  /** Direction of the slowly moving long-run anchor: +1 rises, −1 falls, 0 stays. */
  readonly anchorDir: number;
}

export const PERSONALITIES: Readonly<Record<Personality, PersonalityInfo>> = {
  steady: { volMult: 0.8, pUp: 0.25, pFlat: 0.5, pDown: 0.25, stickiness: 0.5, anchorDir: 0.3 },
  income: { volMult: 0.65, pUp: 0.2, pFlat: 0.6, pDown: 0.2, stickiness: 0.6, anchorDir: 0.2 },
  growth: { volMult: 1.1, pUp: 0.55, pFlat: 0.28, pDown: 0.17, stickiness: 0.55, anchorDir: 1 },
  cyclical: { volMult: 1.0, pUp: 0.4, pFlat: 0.2, pDown: 0.4, stickiness: 0.3, anchorDir: 0 },
  volatile: { volMult: 1.4, pUp: 0.4, pFlat: 0.2, pDown: 0.4, stickiness: 0.35, anchorDir: 0 },
  turnaround: { volMult: 1.2, pUp: 0.4, pFlat: 0.25, pDown: 0.35, stickiness: 0.4, anchorDir: 0.3 },
  declining: { volMult: 1.0, pUp: 0.15, pFlat: 0.3, pDown: 0.55, stickiness: 0.55, anchorDir: -0.8 },
};
