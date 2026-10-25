// What the API shows about the market: overview rows, company pages and order books. Rows are built from the live world
// and cached per tick, so a hundred browsers asking at once cost one computation.

import { BOOK_LEVELS, TICKS_PER_DAY, liquidityLabel, marketCapCents, scaleOf, totalDepth, unitsToCents, type Company, type Level } from '../../src/world';
import type { Halts } from '../halts';
import type { WorldRuntime } from './runtime';

export interface OverviewRow {
  readonly id: number;
  readonly ticker: string;
  readonly name: string;
  readonly sector: string;
  readonly tier: string;
  readonly trading: boolean;
  /** True while the owner has stopped trading in this company (the price still moves). */
  readonly halted: boolean;
  /** Set while the market itself has paused trading in this company after a 10 % move in 5 minutes (it also counts as halted). */
  readonly autoPause: { readonly moveBps: number; readonly reopensInTicks: number } | null;
  /** Ticks until a not-yet-listed company starts trading (0 when trading). */
  readonly listsInTicks: number;
  /** True for a company a player launched. It can be traded in Career but never in a 1v1 match (docs/world.md §9.10). */
  readonly launched: boolean;
  /** The money pool behind a coin that was launched with one (null for every other company): the cash in it, and `dead` once its developer took it all. */
  readonly pool: { readonly cents: number; readonly dead: boolean } | null;
  /** True for a company that went bankrupt (server/bankruptcy.ts): its price stopped for good, nobody can open a new position, holders can still sell. */
  readonly bankrupt: boolean;
  readonly price: number;
  readonly bid: number;
  readonly ask: number;
  readonly spreadBps: number;
  readonly open24h: number;
  readonly changeBps: number;
  readonly high24h: number;
  readonly low24h: number;
  readonly volume24h: number;
  readonly marketCapCents: number;
  readonly liquidity: string;
  readonly mood: string;
}

export interface Overview {
  readonly tick: number;
  readonly ms: number;
  readonly companies: OverviewRow[];
}

export interface DepthSide {
  readonly levels: { price: number; size: number; cumulative: number }[];
  readonly total: number;
}

/** A plain-words label for the stock's current volatility regime (V = 1 is normal). */
export function moodOf(activity: number): string {
  if (activity < 0.8) return 'Calm';
  if (activity < 1.25) return 'Normal';
  if (activity < 1.9) return 'Active';
  return 'Frantic';
}

export class MarketViews {
  private cache: Overview | null = null;
  private cacheTick = -1;

  private halts: Halts | null = null;
  private launchedIds: () => ReadonlySet<number> = () => new Set();
  private pools: () => ReadonlyMap<number, { cents: number; dead: boolean }> = () => new Map();
  private bankruptIds: () => ReadonlySet<number> = () => new Set();

  constructor(private readonly world: WorldRuntime) {}

  setHalts(halts: Halts | null): void {
    this.halts = halts;
    this.invalidate();
  }

  /** Where the ids of the player-launched companies come from (asked once for each set of rows built). */
  setLaunched(source: () => ReadonlySet<number>): void {
    this.launchedIds = source;
    this.invalidate();
  }

  /** Where the money pools of the player-launched coins come from (asked once for each set of rows built). */
  setPools(source: () => ReadonlyMap<number, { cents: number; dead: boolean }>): void {
    this.pools = source;
    this.invalidate();
  }

  /** Where the ids of the companies that went bankrupt come from (asked once for each set of rows built). */
  setBankrupt(source: () => ReadonlySet<number>): void {
    this.bankruptIds = source;
    this.invalidate();
  }

  /** Forget the rows built for this tick (after a halt or resume, so the change shows at once). */
  invalidate(): void {
    this.cache = null;
    this.cacheTick = -1;
  }

  overview(): Overview {
    const w = this.world;
    if (this.cache && this.cacheTick === w.sim.tick) return this.cache;
    const launched = this.launchedIds();
    const pools = this.pools();
    const bankrupt = this.bankruptIds();
    const rows: OverviewRow[] = w.companies.map((c) => this.row(c, launched.has(c.id), pools.get(c.id) ?? null, bankrupt.has(c.id)));
    this.cache = { tick: w.sim.tick, ms: w.msOfTick(w.sim.tick), companies: rows };
    this.cacheTick = w.sim.tick;
    return this.cache;
  }

  private row(c: Company, launched: boolean, pool: { cents: number; dead: boolean } | null, bankrupt: boolean): OverviewRow {
    const w = this.world;
    const i = c.id;
    if (!w.sim.isListed(i)) {
      return {
        id: i, ticker: c.ticker, name: c.name, sector: c.sector, tier: c.tier, trading: false, halted: false, autoPause: null,
        listsInTicks: Math.max(0, c.listingTick - w.sim.tick), launched, pool, bankrupt, price: 0, bid: 0, ask: 0, spreadBps: 0, open24h: 0,
        changeBps: 0, high24h: 0, low24h: 0, volume24h: 0, marketCapCents: 0, liquidity: liquidityLabel(c.liquidity), mood: 'Normal',
      };
    }
    const q = w.quote(i);
    // Prices go out in cents; a fine-priced coin counts in smaller units inside, so its prices are converted (a tiny number of cents).
    const scale = scaleOf(c);
    const cents = (units: number): number => unitsToCents(units, scale);
    const open = w.stats.open24h(i) || c.basePriceCents;
    const range = w.stats.range24h(i);
    const high = Math.max(range.high, w.sim.price(i));
    const low = range.low === 0 ? w.sim.price(i) : Math.min(range.low, w.sim.price(i));
    return {
      id: i,
      ticker: c.ticker,
      name: c.name,
      sector: c.sector,
      tier: c.tier,
      trading: true,
      halted: this.halts?.isHalted(i) ?? false,
      autoPause: this.autoPauseOf(i),
      listsInTicks: 0,
      launched,
      pool,
      bankrupt,
      price: cents(q.mid),
      bid: cents(q.bid),
      ask: cents(q.ask),
      spreadBps: q.spreadBps,
      open24h: cents(open),
      changeBps: Math.round(((q.mid - open) / open) * 10_000),
      high24h: cents(high),
      low24h: cents(low),
      volume24h: w.stats.volume24h(i),
      marketCapCents: marketCapCents(q.mid, c),
      liquidity: liquidityLabel(c.liquidity),
      mood: moodOf(w.sim.activity(i)),
    };
  }

  private autoPauseOf(i: number): { moveBps: number; reopensInTicks: number } | null {
    const p = this.halts?.autoPauseOf(i);
    return p ? { moveBps: p.moveBps, reopensInTicks: Math.max(0, p.untilTick - this.world.sim.tick) } : null;
  }

  /** The company page: overview row plus the facts that do not change tick to tick. */
  detail(ticker: string): (OverviewRow & Record<string, unknown>) | null {
    const c = this.world.companyByTicker(ticker);
    if (!c) return null;
    const row = this.overview().companies[c.id] as OverviewRow;
    return {
      ...row,
      description: c.description,
      industry: c.industry,
      products: c.products,
      ceo: c.ceo,
      cfo: c.cfo,
      hq: c.hq,
      sharesOutstanding: c.sharesOutstanding,
      floatShares: c.floatShares,
      avgDailyVolume: c.avgDailyVolume,
      liquidityScore: Math.round(c.liquidity * 100),
      beta: c.beta,
      listingTick: c.listingTick,
      /** The price it started at (a launched company: its listing price). The page counts "2x, 10x since the start" from it. */
      basePriceCents: unitsToCents(c.basePriceCents, scaleOf(c)),
      listedMs: this.world.msOfTick(c.listingTick),
      turnover24h: row.trading && c.sharesOutstanding > 0 ? Math.round((row.volume24h / c.sharesOutstanding) * 100_000) / 1000 : 0,
      daysOfHistory: Math.floor(Math.max(0, this.world.sim.tick - c.listingTick) / TICKS_PER_DAY),
    };
  }

  depth(ticker: string): { bids: DepthSide; asks: DepthSide; tick: number; pressure: number } | null {
    const c = this.world.companyByTicker(ticker);
    if (!c || !this.world.sim.isListed(c.id)) return null;
    const scale = scaleOf(c);
    const side = (levels: Level[]): DepthSide => {
      let cum = 0;
      return {
        levels: levels.map((l) => {
          cum += l.size;
          return { price: unitsToCents(l.price, scale), size: l.size, cumulative: cum };
        }),
        total: totalDepth(levels),
      };
    };
    // `pressure` (-1 … 1): players have been net buying (> 0, the asks are thinner) or selling (< 0, the bids are thinner) lately.
    return { bids: side(this.world.book(c.id, 'sell', BOOK_LEVELS)), asks: side(this.world.book(c.id, 'buy', BOOK_LEVELS)), tick: this.world.sim.tick, pressure: Math.round(this.world.tiltOf(c.id) * 100) / 100 };
  }
}
