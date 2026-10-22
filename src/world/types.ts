// Shared types of the persistent world. Everything here is plain data so it can be stored as JSON and sent over the wire.

import type { Personality, SectorId, Tier } from './params';

/** One investable company. Everything except `listingTick` is derived from the catalog data and never changes. */
export interface Company {
  /** Stable catalog position. Also selects the company's random streams. Never reused, never renumbered. */
  readonly id: number;
  readonly ticker: string;
  readonly name: string;
  readonly sector: SectorId;
  readonly industry: string;
  readonly description: string;
  readonly personality: Personality;
  readonly tier: Tier;
  /** First tick at which the company trades. 0 for the original listings; later listings (IPOs) start later. */
  readonly listingTick: number;
  readonly basePriceCents: number;
  readonly sharesOutstanding: number;
  /** Shares available to trade freely (an estimate; ≤ sharesOutstanding). */
  readonly floatShares: number;
  /** Average shares traded per day. */
  readonly avgDailyVolume: number;
  /** 0 … 1: how easily large orders are absorbed. */
  readonly liquidity: number;
  /** Typical bid–ask spread in basis points of the price. */
  readonly spreadBps: number;
  readonly beta: number;
  readonly sectorBeta: number;
  /** Typical price change over 3 minutes (one standard deviation, fraction) — shown to players as "volatility". */
  readonly vol3m: number;
  /** Deviation noise per tick (fraction). */
  readonly sigmaD: number;
  /** All short-term noise per tick together (company, market and sector parts); the scale against which a move counts as "big". */
  readonly sigmaTick: number;
  /** Momentum innovation per tick. */
  readonly sigmaM: number;
  /** Fundamental-value noise per tick. */
  readonly sigmaF: number;
  /** Size of the daily drift while in a trend regime (fraction per day). */
  readonly driftDay: number;
  readonly pUp: number;
  readonly pFlat: number;
  readonly pDown: number;
  readonly stickiness: number;
  readonly anchorDir: number;
  /** Offset (ticks) of this company's trend eras, so that not all regimes change on the same tick. */
  readonly eraOffset: number;
  /** How strongly news moves this company (size class × personal factor). */
  readonly newsSensitivity: number;
  // Flavour used by the news generator.
  readonly products: readonly string[];
  readonly ceo: string;
  readonly cfo: string;
  readonly hq: string;
  /** Company id of the closest peer in the same sector, used for "related company" news. */
  readonly peerId: number;
}

/** Everything the simulation remembers about one stock between ticks. */
export interface StockState {
  /** Fundamental value in cents (a float). */
  F: number;
  /** Deviation of the traded price from the fundamental value (fraction). */
  D: number;
  /** Momentum: a slowly fading per-tick return. */
  M: number;
  /** Volatility regime multiplier (1 = normal). */
  V: number;
  /** Order-flow imbalance (positive = net buying). */
  Q: number;
  /** Trend regime: −1 falling, 0 sideways, +1 rising. */
  regime: number;
  /** Long-run anchor the fundamental value is gently pulled toward (cents, float). */
  A: number;
  /** Last traded (mid) price in cents. */
  P: number;
  /** Size of the last tick's move, |P_t / P_(t−1) − 1|. */
  R: number;
}

export interface MarketFactorState {
  /** Slow market sentiment, as a per-tick return. */
  S: number;
  /** Slow sector sentiment per sector (same order as SECTOR_IDS). */
  sector: number[];
}

/** The whole simulation state at the end of tick `tick`. JSON-safe. */
export interface WorldSnapshot {
  version: number;
  tick: number;
  market: MarketFactorState;
  /** Per company id; `null` until the company is listed. */
  stocks: (StockState | null)[];
}

/** What the simulation reports for one stock after a tick. */
export interface TickOutput {
  readonly price: number;
  /** Shares traded during this tick. */
  readonly volume: number;
  /** Volatility regime multiplier (drives spread and depth). */
  readonly activity: number;
}

// ---- events (news) -----------------------------------------------------------------------------------------------

export type EventScope = 'company' | 'company+partner' | 'sector' | 'market';
export type EventKind = 'ordinary' | 'earnings' | 'viral' | 'macro' | 'admin' | 'flow';
export type Direction = 'positive' | 'negative' | 'uncertain';
export type Strength = 'minor' | 'moderate' | 'major' | 'extreme';
export type Immediacy = 'immediate' | 'gradual';

/** How an event's total effect is spread over time (each shape sums to exactly 1). */
export type Shape = 'burst' | 'front' | 'ramp';

/** A news event as the engine sees it. The server adds text and bookkeeping around it. */
export interface WorldEvent {
  /** Unique, deterministic key, e.g. "c12:5:1" (company 12, cycle 5, slot 1). */
  readonly key: string;
  readonly kind: EventKind;
  readonly scope: EventScope;
  /** Affected company (null for sector / market events). */
  readonly companyId: number | null;
  readonly partnerId: number | null;
  readonly sector: SectorId | null;
  /** Tick at which the headline becomes public. */
  readonly publishTick: number;
  /** Tick at which the price effect begins (≥ publishTick). */
  readonly startTick: number;
  readonly durationTicks: number;
  readonly shape: Shape;
  /** Signed fraction of the price the event moves it in total (the REALISED outcome; secret until it has played out). */
  readonly realized: number;
  /** Share of the effect that stays in the fundamental value; the rest fades as the price relaxes. */
  readonly permShare: number;
}

/** One stock's share of an event: when it starts, how long it lasts and how much it moves. */
export interface Effect {
  readonly eventKey: string;
  readonly companyId: number;
  readonly startTick: number;
  readonly durationTicks: number;
  readonly shape: Shape;
  /** Signed total fraction for this stock. */
  readonly total: number;
  readonly permShare: number;
}
