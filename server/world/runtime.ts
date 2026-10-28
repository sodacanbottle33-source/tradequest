// The authoritative world: owns the clock, the simulation, the candles and their storage. Everything a player sees about the
// market comes from here, and only the server's clock decides what time it is in the market (docs/world.md §3, §8).
//
//   • tick = floor((server time − genesis) / 1 s). Browsers can't influence it.
//   • The simulation state is saved with the candles of the same moment in ONE database transaction at candle boundaries,
//     so the database is always consistent. After a crash or a stop the server loads the last saved state and replays the
//     missing ticks; because the simulation is a pure function of (seed, catalog, stored events) the replay produces the
//     exact prices it would have produced had it never stopped. No reset, no jump.

import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
  CANDLES_PER_DAY,
  CANDLES_PER_HOUR,
  CandleBuilder,
  EffectBook,
  TICKS_PER_CANDLE,
  TICKS_PER_DAY,
  TICKS_PER_HOUR,
  WORLD_ENGINE_VERSION,
  WorldSim,
  CURATED,
  bookScale,
  buildCatalog,
  deathTickOf,
  effectiveDuration,
  effectsOf,
  fold,
  ladder,
  marketCapCents,
  memeEntries,
  quoteOf,
  scaleOf,
  tickAtMs,
  type Candle,
  type CatalogEntry,
  type Company,
  type Level,
  type Quote,
  type Side,
  type WorldEvent,
  type WorldSnapshot,
} from '../../src/world';
import type { Logger } from '../log';
import type { Db } from '../sqlite';
import { Rollup, type RollupState } from './rollup';
import { RollingStats } from './stats';

/** 10-tick candles are kept this long (25 hours); hourly and daily candles forever. */
export const RETENTION_C10_TICKS = 90_000;
/** While catching up, state is saved every hour of market time. */
export const CATCHUP_CHUNK_TICKS = TICKS_PER_HOUR;
/** The meta key that says the thirty memecoins were added to this world. */
export const MEMECOINS_SEEDED = 'memecoins_seeded';
/**
 * The tick from which stocks have calmer fast jitter (src/world/params.ts `STOCK_JITTER_CALM`). A world made after that change has 0; an older
 * world gets the first tick after the moment it was first started by this program, so everything that happened before stays as it was.
 */
export const CALM_FROM_TICK = 'calm_from_tick';
/** A company added to the catalog later starts trading this many ticks after the server notices it. */
export const LISTING_DELAY_TICKS = 600;
/** A company the owner makes while the server runs starts trading this many ticks from now (rounded up to the next candle). */
export const OWN_LISTING_DELAY_TICKS = 30;
/** News is loaded this far ahead of the simulation. */
export const EVENT_LOOKAHEAD_TICKS = 6 * TICKS_PER_HOUR;
/** A special event created while the server runs starts this many ticks after the later of the clock and the simulation. */
export const EVENT_START_DELAY_TICKS = 4;
/** Trading is refused while the world is further behind the clock than this. */
export const MAX_TRADING_LAG_TICKS = 30;

/** A price noted when a news item is published and when its effect has finished (for the "what happened afterwards" record). */
export interface MarkRow {
  readonly key: string;
  readonly kind: 'publish' | 'end';
  readonly price: number;
}

/** Facts about the world that the news system needs to generate and judge news. */
export interface NewsContext {
  readonly worldSeed: number;
  readonly companies: readonly Company[];
}

/** What the world needs from the news system (docs/world.md §7). */
export interface NewsHooks {
  /** Called once at start-up, after the catalog is known. */
  bind?(context: NewsContext): void;
  /** Makes sure every event that starts at or before `tick` exists in storage. Idempotent. Throws if it cannot. */
  ensureThrough(tick: number): void;
  /** Events whose effect is running at `tick` (started at or before it, not finished). */
  eventsActiveAt(tick: number): WorldEvent[];
  /** Events whose effect starts in [from, through]. */
  eventsStartingIn(from: number, through: number): WorldEvent[];
  /** Every rug pull story ever stored (finished ones too): they say which coins are dead and from when (src/world/effects.ts `deathTickOf`). */
  deadEvents?(): WorldEvent[];
  /** Stores prices noted by the world. Called inside the same database transaction that saves the world state. */
  recordMarks?(rows: readonly MarkRow[]): void;
}

interface PendingMark {
  readonly tick: number;
  readonly key: string;
  readonly kind: 'publish' | 'end';
  readonly companyId: number;
}

export interface RuntimeOptions {
  readonly db: Db;
  readonly log: Logger;
  readonly now: () => number;
  readonly companyCount: number;
  readonly warmupDays: number;
  /** For tests: a fixed world seed instead of a random one. */
  readonly worldSeed?: number;
  /** Add the thirty memecoins to the world (once). The game turns this on; most tests leave it off so their worlds stay small. */
  readonly memecoins?: boolean;
  readonly news?: NewsHooks | null;
}

export interface TickMessage {
  readonly tick: number;
  readonly ms: number;
  /** Mid price of every company by id (0 = not listed). */
  readonly prices: number[];
  /** Half of the bid–ask spread of every company by id, in cents. */
  readonly halves: number[];
}

export type Resolution = 'c10' | 'h1' | 'd1';

export interface CandleView extends Candle {
  /** Ticks inside the candle so far (10-tick candles only; others are shown as complete once all parts are in). */
  readonly ticks: number;
  readonly complete: boolean;
}

export interface Health {
  readonly ok: boolean;
  readonly tick: number;
  readonly clockTick: number;
  readonly lagTicks: number;
  readonly catchingUp: boolean;
  readonly stalled: string | null;
  readonly savedTick: number;
  readonly companies: number;
  readonly listed: number;
  readonly genesisMs: number;
  readonly engineVersion: number;
}

interface SavedState {
  sim: WorldSnapshot;
  hour: RollupState;
  day: RollupState;
}

interface PendingRows {
  c10: { company: number; candle: Candle }[];
  h1: { company: number; candle: Candle }[];
  d1: { company: number; candle: Candle }[];
}

export class WorldRuntime {
  readonly db: Db;
  readonly log: Logger;
  private readonly now: () => number;
  private readonly options: RuntimeOptions;

  companies: Company[] = [];
  /** Companies the owner made by hand (id → what they are), as saved in the database. */
  private own = new Map<number, CatalogEntry>();
  sim!: WorldSim;
  effects = new EffectBook();
  genesisMs = 0;
  private worldSeed = 0;
  /** The tick from which stocks are calmer (see {@link CALM_FROM_TICK}). */
  calmFrom = 0;
  /** Tick of the last committed state. */
  savedTick = 0;
  private hour!: Rollup;
  private day!: Rollup;
  stats!: RollingStats;
  private forming: CandleBuilder[] = [];
  private formingActive!: Uint8Array;
  private pending: PendingRows = { c10: [], h1: [], d1: [] };
  private loadedThrough = 0;
  private marks: PendingMark[] = [];
  private markIdx = 0;
  private pendingMarks: MarkRow[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<(m: TickMessage) => void>();
  private stalledReason: string | null = null;
  private lastStallLog = 0;
  private catching = false;
  private initialised = false;
  private pumping = false;

  constructor(options: RuntimeOptions) {
    this.options = options;
    this.db = options.db;
    this.log = options.log;
    this.now = options.now;
  }

  // ---- start-up ----------------------------------------------------------------------------------------------------

  private meta(key: string): string | undefined {
    return this.db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', key)?.value;
  }

  private setMeta(key: string, value: string): void {
    this.db.run('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
  }

  /** Loads (or, on the very first start, creates) the world and brings it up to the present. May take a while after a long stop. */
  init(): void {
    const { db, log } = this;
    const nowMs = this.now();
    let firstBoot = false;
    if (this.meta('genesis_ms') === undefined) {
      firstBoot = true;
      const seed = this.options.worldSeed ?? randomBytes(4).readUInt32BE(0);
      const genesis = Math.floor((nowMs - this.options.warmupDays * 86_400_000) / 3_600_000) * 3_600_000;
      db.tx(() => {
        this.setMeta('genesis_ms', String(genesis));
        this.setMeta('world_seed', String(seed));
        this.setMeta('engine_version', String(WORLD_ENGINE_VERSION));
      });
      log.info('world', `First start: the world begins at ${new Date(genesis).toISOString()} (${this.options.warmupDays} days of history will be simulated).`);
    }
    this.genesisMs = Number(this.meta('genesis_ms'));
    this.worldSeed = Number(this.meta('world_seed'));
    if (Number(this.meta('engine_version')) !== WORLD_ENGINE_VERSION) {
      throw new Error(`This world was created by price-engine version ${this.meta('engine_version')}, but this program is version ${WORLD_ENGINE_VERSION}. It cannot be continued safely.`);
    }
    const clockTick = tickAtMs(nowMs, this.genesisMs);
    if (clockTick < 0) throw new Error('The computer clock is earlier than the start of the world. Fix the clock; the market will not run backwards.');

    // Companies: the database is the record of who is listed and since when.
    const known = db.all<{ id: number; ticker: string; listing_tick: number }>('SELECT id, ticker, listing_tick FROM companies ORDER BY id');
    const listingOf = new Map(known.map((k) => [k.id, k.listing_tick]));
    const newListing = Math.ceil((clockTick + LISTING_DELAY_TICKS) / TICKS_PER_CANDLE) * TICKS_PER_CANDLE;
    this.own = this.readOwnEntries();
    // The memecoins join a world once. They take the ids after every company that exists (or is wanted) now, so nothing that
    // exists changes; they list like any new company (at the start in a brand-new world, a few minutes from now otherwise).
    const seeding = this.options.memecoins === true && this.meta(MEMECOINS_SEEDED) === undefined ? this.planMemecoins(Math.max(this.options.companyCount, known.length, CURATED.length)) : [];
    for (const m of seeding) this.own.set(m.id, m.entry);
    const wanted = Math.max(this.options.companyCount, known.length, ...[...this.own.keys()].map((id) => id + 1));
    const catalog = buildCatalog(wanted, (id) => listingOf.get(id) ?? (firstBoot ? 0 : newListing), this.own);
    for (const k of known) {
      const c = catalog[k.id];
      if (!c || c.ticker !== k.ticker) throw new Error(`The company catalog changed: id ${k.id} was ${k.ticker} but is now ${c?.ticker ?? 'missing'}. Existing companies must never change.`);
    }
    this.checkMemecoinNames(catalog, seeding);
    db.tx(() => {
      for (const m of seeding) {
        db.run('INSERT INTO meme_companies(company_id, ticker, name, entry_json, created_ms) VALUES (?, ?, ?, ?, ?)', m.id, m.entry.ticker, m.entry.name, JSON.stringify(m.entry), nowMs);
      }
      if (seeding.length > 0) this.setMeta(MEMECOINS_SEEDED, String(nowMs));
      for (const c of catalog) {
        if (listingOf.has(c.id)) continue;
        db.run('INSERT INTO companies(id, ticker, name, listing_tick, listed_ms) VALUES (?, ?, ?, ?, ?)', c.id, c.ticker, c.name, c.listingTick, nowMs);
        if (!firstBoot) log.info('world', `New listing: ${c.ticker} (${c.name}) starts trading at tick ${c.listingTick}.`);
      }
    });
    this.companies = catalog;
    this.options.news?.bind?.({ worldSeed: this.worldSeed, companies: catalog });
    const n = catalog.length;
    this.stats = new RollingStats(n);
    this.hour = new Rollup(n, CANDLES_PER_HOUR);
    this.day = new Rollup(n, CANDLES_PER_DAY);
    this.formingActive = new Uint8Array(n);
    this.forming = catalog.map(() => new CandleBuilder());

    // Simulation state.
    const row = db.get<{ tick: number; state: string }>('SELECT tick, state FROM world_state WHERE id = 1');
    this.calmFrom = this.readCalmFrom(firstBoot, clockTick);
    if (row) {
      const saved = JSON.parse(row.state) as SavedState;
      this.sim = WorldSim.restore(this.worldSeed, catalog, saved.sim, this.calmFrom);
      this.hour.loadState(saved.hour);
      this.day.loadState(saved.day);
      this.savedTick = row.tick;
      log.info('world', `Loaded the saved world at tick ${row.tick}; the clock is at tick ${clockTick} (${clockTick - row.tick} ticks to catch up).`);
    } else {
      this.sim = new WorldSim(this.worldSeed, catalog, this.calmFrom);
      this.savedTick = 0;
      this.writeState(0);
    }
    this.reloadStats();
    this.beginCandles(this.savedTick / TICKS_PER_CANDLE + 1);
    // Coins whose developer took the pool are dead from the tick their rug pull story names, whether it finished long ago or not.
    this.applyDeaths(this.options.news?.deadEvents?.() ?? []);

    // News: events that are running at the saved tick or start soon.
    this.loadedThrough = this.options.news ? this.savedTick : Number.MAX_SAFE_INTEGER;
    this.initialised = true;
    this.loadEvents(this.savedTick + 1, true);

    // Catch up to the present.
    const started = performance.now();
    const target = this.currentTick();
    if (target - this.sim.tick > 3 * TICKS_PER_HOUR) log.info('world', `Catching up ${target - this.sim.tick} ticks (about ${Math.round((target - this.sim.tick) / TICKS_PER_DAY * 10) / 10} days of market time)…`);
    this.advanceTo(target, Infinity);
    log.info('world', `World ready at tick ${this.sim.tick} (${n} companies, ${this.listedCount()} trading). Catch-up took ${Math.round(performance.now() - started)} ms.`);
  }

  /**
   * The tick from which stocks are calmer. A brand-new world has it from the start (0). A world that was running before this existed gets the
   * tick after "now" the first time it is started, and keeps that number for good, so a restart, a crash or a long stop replays every tick
   * the same way and nothing in the past is recomputed.
   */
  private readCalmFrom(firstBoot: boolean, clockTick: number): number {
    const stored = this.meta(CALM_FROM_TICK);
    if (stored !== undefined) {
      const value = Number(stored);
      if (!/^\d+$/.test(stored) || !Number.isSafeInteger(value)) throw new Error(`The saved calm tick "${stored}" is not a tick`);
      return value;
    }
    const value = firstBoot ? 0 : clockTick + 1;
    this.setMeta(CALM_FROM_TICK, String(value));
    if (!firstBoot) this.log.info('world', `Calmer stock prices start at tick ${value}; everything before it stays exactly as it was.`);
    return value;
  }

  // ---- companies made by the owner -----------------------------------------------------------------------------------

  private readOwnEntries(): Map<number, CatalogEntry> {
    const rows = this.db.all<{ company_id: number; ticker: string; name: string; sector: string; industry: string; tier: string; personality: string; price_cents: number; product1: string; product2: string; description: string }>(
      'SELECT company_id, ticker, name, sector, industry, tier, personality, price_cents, product1, product2, description FROM custom_companies ORDER BY company_id',
    );
    const own = new Map<number, CatalogEntry>(
      rows.map((r) => [
        r.company_id,
        {
          ticker: r.ticker,
          name: r.name,
          sector: r.sector as CatalogEntry['sector'],
          industry: r.industry,
          tier: r.tier as CatalogEntry['tier'],
          price: r.price_cents,
          personality: r.personality as CatalogEntry['personality'],
          products: [r.product1, r.product2] as const,
          description: r.description,
        },
      ]),
    );
    // The memecoins are saved whole, as the program had them when they were added.
    for (const m of this.db.all<{ company_id: number; entry_json: string }>('SELECT company_id, entry_json FROM meme_companies ORDER BY company_id')) {
      own.set(m.company_id, JSON.parse(m.entry_json) as CatalogEntry);
    }
    return own;
  }

  /** The ids the thirty memecoins would take: one after another, from `first`. */
  private planMemecoins(first: number): { id: number; entry: CatalogEntry }[] {
    return memeEntries().map((entry, i) => ({ id: first + i, entry }));
  }

  /** A coin's name and ticker must not be used by any other company (they identify it everywhere). Throws a plain sentence if they are. */
  private checkMemecoinNames(catalog: readonly Company[], seeding: readonly { id: number; entry: CatalogEntry }[]): void {
    for (const m of seeding) {
      for (const c of catalog) {
        if (c.id !== m.id && (c.ticker === m.entry.ticker || c.name === m.entry.name)) {
          throw new Error(`The memecoin ${m.entry.ticker} (${m.entry.name}) cannot be added: ${c.ticker} (${c.name}) already has that ticker or name.`);
        }
      }
    }
  }

  /** The id the next company gets. Refuses if a company was saved in the database but never loaded into this running world. */
  nextCompanyId(): number {
    const row = this.db.get<{ n: number; top: number | null }>('SELECT COUNT(*) AS n, MAX(id) AS top FROM companies');
    const n = row?.n ?? 0;
    if (n < CURATED.length) {
      throw new Error(`The market has only ${n} companies. A company of your own comes after the ${CURATED.length} hand-written ones: start the server with TQ_COMPANIES set to ${CURATED.length} or more (the default), then try again.`);
    }
    if (n !== this.companies.length || (n > 0 && row?.top !== n - 1)) {
      throw new Error(`The database lists ${n} companies but the running market has ${this.companies.length}. Restart the server so they match.`);
    }
    return n;
  }

  /** The tick at which a company made right now begins trading: a few seconds ahead, at the start of a candle. */
  ownListingTick(): number {
    return Math.ceil((Math.max(this.sim.tick, this.currentTick()) + OWN_LISTING_DELAY_TICKS) / TICKS_PER_CANDLE) * TICKS_PER_CANDLE;
  }

  /**
   * Step 1 of making a company: writes it to the database. Call it inside the transaction that also writes the admin log, then call
   * {@link loadOwnCompany} once that transaction has committed. The company is fully defined by these rows, so even if step 2 never
   * happens (the program is stopped) the next start loads it.
   */
  recordOwnCompany(entry: CatalogEntry, listingTick: number, createdBy: number): number {
    const id = this.nextCompanyId();
    if (listingTick <= this.sim.tick || listingTick % TICKS_PER_CANDLE !== 0) throw new Error(`Bad listing tick ${listingTick} (the world is at tick ${this.sim.tick})`);
    const nowMs = this.now();
    this.db.run('INSERT INTO companies(id, ticker, name, listing_tick, listed_ms) VALUES (?, ?, ?, ?, ?)', id, entry.ticker, entry.name, listingTick, nowMs);
    this.db.run(
      'INSERT INTO custom_companies(company_id, ticker, name, sector, industry, tier, personality, price_cents, product1, product2, description, created_ms, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, entry.ticker, entry.name, entry.sector, entry.industry, entry.tier, entry.personality, entry.price, entry.products[0], entry.products[1], entry.description, nowMs, createdBy,
    );
    return id;
  }

  /**
   * Step 1 for a memecoin made by the owner: the same as {@link recordOwnCompany}, but the coin is saved whole (like the thirty built-in
   * coins, in meme_companies) because it states its own numbers. Call {@link loadOwnCompany} once the transaction has committed.
   */
  recordOwnCoin(entry: CatalogEntry, listingTick: number): number {
    const id = this.nextCompanyId();
    if (entry.sector !== 'meme' || !entry.meme) throw new Error(`${entry.ticker} is not a memecoin`);
    if (listingTick <= this.sim.tick || listingTick % TICKS_PER_CANDLE !== 0) throw new Error(`Bad listing tick ${listingTick} (the world is at tick ${this.sim.tick})`);
    const nowMs = this.now();
    this.db.run('INSERT INTO companies(id, ticker, name, listing_tick, listed_ms) VALUES (?, ?, ?, ?, ?)', id, entry.ticker, entry.name, listingTick, nowMs);
    this.db.run('INSERT INTO meme_companies(company_id, ticker, name, entry_json, created_ms) VALUES (?, ?, ?, ?, ?)', id, entry.ticker, entry.name, JSON.stringify(entry), nowMs);
    return id;
  }

  /**
   * Step 2: adds the company that {@link recordOwnCompany} saved to the RUNNING market, so it needs no restart. The result is exactly what
   * a restart would produce, because the simulation is rebuilt from its own saved state with the larger catalog, and the stories that
   * are already loaded (sector and market-wide ones too) are also given to the new company. Everything is prepared first and the
   * live objects are swapped at the very end, so an error leaves the running market untouched (a restart then loads the company).
   */
  loadOwnCompany(id: number): Company {
    if (!this.initialised) throw new Error('The world is not initialised');
    const n = this.companies.length;
    if (id !== n) throw new Error(`Company ${id} cannot be loaded: the running market has ${n} companies`);
    const rows = this.db.all<{ id: number; listing_tick: number }>('SELECT id, listing_tick FROM companies ORDER BY id');
    if (rows.length !== n + 1) throw new Error(`The database lists ${rows.length} companies, expected ${n + 1}`);
    const listingOf = new Map(rows.map((r) => [r.id, r.listing_tick]));
    const own = this.readOwnEntries();
    const catalog = buildCatalog(n + 1, (k) => listingOf.get(k) as number, own);
    for (let k = 0; k < n; k += 1) {
      if (JSON.stringify(catalog[k]) !== JSON.stringify(this.companies[k])) throw new Error(`Adding a company would change company ${this.companies[k]?.ticker}; it never may`);
    }
    const company = catalog[id] as Company;
    if (company.listingTick <= this.sim.tick) throw new Error(`${company.ticker} would list at tick ${company.listingTick}, but the world is already at tick ${this.sim.tick}`);

    // The simulation again, from its own state, with room for one more company (which is not listed yet).
    const before = this.sim.snapshot();
    const sim = WorldSim.restore(this.worldSeed, catalog, before, this.calmFrom);
    sim.volume.set(this.sim.volume);
    for (const [coinId, tick] of this.sim.deadFrom()) sim.setDeadFrom(coinId, tick);
    const after = sim.snapshot();
    if (JSON.stringify(after.stocks.slice(0, n)) !== JSON.stringify(before.stocks) || after.stocks[id] !== null || after.tick !== before.tick || after.market.S !== before.market.S || JSON.stringify(after.market.sector) !== JSON.stringify(before.market.sector)) {
      throw new Error('Rebuilding the simulation with one more company did not reproduce its state');
    }
    const forming = [...this.forming, new CandleBuilder()];
    const formingActive = new Uint8Array(n + 1);
    formingActive.set(this.formingActive);
    const stats = this.stats.grown(n + 1);
    const hour = this.hour.grown(n + 1);
    const day = this.day.grown(n + 1);

    // News: the company's own stories are written now, and the loaded window gets the stories that touch it.
    const effects: ReturnType<typeof effectsOf> = [];
    const ownEvents: WorldEvent[] = [];
    const news = this.options.news;
    if (news) {
      news.bind?.({ worldSeed: this.worldSeed, companies: catalog });
      news.ensureThrough(this.loadedThrough);
      const events = news.eventsStartingIn(company.listingTick, this.loadedThrough);
      for (const e of events) {
        const mine = e.companyId === id || e.partnerId === id;
        // Stories of other companies are already loaded; only a sector or market-wide story (which reaches every company of its
        // kind) still owes the new company its share.
        effects.push(...effectsOf(e, catalog).filter((x) => mine || x.companyId === id));
        if (e.companyId === id) ownEvents.push(e);
      }
    }

    // Swap. Nothing below can fail for a reason that is not a bug.
    this.own = own;
    this.companies = catalog;
    this.sim = sim;
    this.forming = forming;
    this.formingActive = formingActive;
    this.stats = stats;
    this.hour = hour;
    this.day = day;
    this.effects.add(effects);
    this.addMarks(ownEvents);
    this.log.info('world', `New company loaded into the running market: ${company.ticker} (${company.name}) starts trading at tick ${company.listingTick}.`);
    return company;
  }

  private listedCount(): number {
    let k = 0;
    for (let i = 0; i < this.companies.length; i += 1) if (this.sim.isListed(i)) k += 1;
    return k;
  }

  /** Starts the forming candles of every listed company at the boundary tick. */
  private beginCandles(candleNo: number): void {
    for (let i = 0; i < this.companies.length; i += 1) {
      if (this.sim.isListed(i)) {
        (this.forming[i] as CandleBuilder).begin(candleNo, this.sim.price(i));
        this.formingActive[i] = 1;
      } else {
        this.formingActive[i] = 0;
      }
    }
  }

  /**
   * Refills the 24-hour statistics from the stored 10-tick candles. One company at a time: a day of candles for every company
   * together is about 830,000 rows, and building them all as JavaScript objects in one go ran a small host (Render's free
   * plan, a heap of about 250 MB) out of memory on every start. The result is the same: each candle goes to its own slot.
   */
  private reloadStats(): void {
    this.stats.reset();
    const lastNo = Math.floor(this.savedTick / TICKS_PER_CANDLE);
    if (lastNo < 1) return;
    const from = Math.max(1, lastNo - CANDLES_PER_DAY + 1);
    const sql = 'SELECT idx, high, low, close, volume FROM candles_c10 WHERE company_id = ? AND idx >= ? AND idx <= ? ORDER BY idx';
    for (let id = 0; id < this.companies.length; id += 1) {
      for (const r of this.db.all<{ idx: number; high: number; low: number; close: number; volume: number }>(sql, id, from, lastNo)) this.stats.set(id, r.idx, r);
    }
  }

  // ---- events (news) -------------------------------------------------------------------------------------------------

  private loadEvents(from: number, initial: boolean): void {
    const news = this.options.news;
    if (!news) return;
    const through = from + EVENT_LOOKAHEAD_TICKS;
    news.ensureThrough(through);
    const events = initial ? [...news.eventsActiveAt(from), ...news.eventsStartingIn(from + 1, through)] : news.eventsStartingIn(from, through);
    this.effects.add(events.flatMap((e) => effectsOf(e, this.companies)));
    this.applyDeaths(events);
    this.addMarks(events);
    this.loadedThrough = through;
  }

  /** A rug pull's story makes its coin dead from a fixed tick: its price stops there for good (src/world/sim.ts `setDeadFrom`). */
  private applyDeaths(events: readonly WorldEvent[]): void {
    for (const e of events) {
      const tick = deathTickOf(e);
      if (tick !== null && e.companyId !== null && this.companies[e.companyId]) this.sim.setDeadFrom(e.companyId, tick);
    }
  }

  /** Remembers at which ticks to note the price of each company event: just before it is published and when its effect is over. */
  private addMarks(events: readonly WorldEvent[]): void {
    const fresh: PendingMark[] = [];
    for (const e of events) {
      if (e.companyId === null || e.kind === 'flow') continue; // price pushes from trades are not news: nothing to note
      const c = this.companies[e.companyId];
      if (!c) continue;
      const publishMark = Math.max(e.publishTick - 1, c.listingTick);
      const endMark = e.startTick + effectiveDuration(e.shape, e.durationTicks) - 1;
      if (publishMark > this.sim.tick) fresh.push({ tick: publishMark, key: e.key, kind: 'publish', companyId: e.companyId });
      if (endMark > this.sim.tick) fresh.push({ tick: endMark, key: e.key, kind: 'end', companyId: e.companyId });
    }
    if (fresh.length === 0) return;
    this.marks = this.marks.slice(this.markIdx).concat(fresh).sort((a, b) => a.tick - b.tick || (a.key < b.key ? -1 : a.key > b.key ? 1 : a.kind < b.kind ? -1 : 1));
    this.markIdx = 0;
  }

  /** Adds events that were created after start-up (they must start in the future). */
  addEvents(events: readonly WorldEvent[]): void {
    this.effects.add(events.flatMap((e) => effectsOf(e, this.companies)));
  }

  /**
   * The first tick at which a NEW event may start: after everything already simulated, after the clock, and a few seconds ahead so
   * the event is stored before the simulation can reach it.
   */
  earliestEventStart(): number {
    return Math.max(this.sim.tick, this.currentTick()) + EVENT_START_DELAY_TICKS;
  }

  /**
   * Hands the world an event that was just WRITTEN to the database (in the news table). Call it only after that write committed:
   * then a restart replays exactly the same event from the table and the prices come out identical. Events that start beyond
   * the loaded window make the world load the next window, which finds them in the table.
   */
  scheduleEvent(event: WorldEvent): void {
    if (event.startTick <= this.sim.tick) throw new Error(`Event ${event.key} starts at tick ${event.startTick}, but the world is already at tick ${this.sim.tick}`);
    this.applyDeaths([event]);
    if (!this.options.news) return;
    if (event.startTick > this.loadedThrough) {
      // The loaded window ends just before this event. Load the next window now: it reads the event from the table, exactly as
      // the normal loader would a moment later (and, unlike a late load, it still notes the price at the moment of publishing).
      this.loadEvents(this.loadedThrough + 1, false);
      return;
    }
    this.addEvents([event]);
    this.addMarks([event]);
  }

  // ---- time --------------------------------------------------------------------------------------------------------

  /** The tick the clock says it is now. */
  currentTick(): number {
    return tickAtMs(this.now(), this.genesisMs);
  }

  get tick(): number {
    return this.sim.tick;
  }

  get lagTicks(): number {
    return Math.max(0, this.currentTick() - this.sim.tick);
  }

  // ---- advancing -----------------------------------------------------------------------------------------------------

  /**
   * Simulates ticks until `target` (or until `budgetMs` of computing time is used; the check happens at candle boundaries).
   * Returns how many ticks were simulated.
   */
  advanceTo(target: number, budgetMs: number): number {
    if (!this.initialised) throw new Error('The world is not initialised');
    const start = this.sim.tick;
    const deadline = budgetMs === Infinity ? Infinity : performance.now() + budgetMs;
    while (this.sim.tick < target) {
      const t = this.sim.tick + 1;
      if (t > this.loadedThrough - 1) this.loadEvents(this.loadedThrough + 1, false);
      this.stepOnce();
      if (t % TICKS_PER_CANDLE === 0) {
        this.onBoundary(t, target);
        if (performance.now() > deadline) break;
      }
    }
    return this.sim.tick - start;
  }

  private stepObserver: ((tick: number) => void) | null = null;

  /** Something that wants to look at every market tick (the automatic trading pauses). It must never be able to stop the market. */
  setStepObserver(observer: ((tick: number) => void) | null): void {
    this.stepObserver = observer;
  }

  private stepOnce(): void {
    this.sim.step(this.effects);
    const sim = this.sim;
    if (this.stepObserver) {
      try {
        this.stepObserver(sim.tick);
      } catch (error) {
        const nowMs = this.now();
        if (nowMs - this.lastObserverLog > 10_000) {
          this.lastObserverLog = nowMs;
          this.log.warn('world', `A tick observer failed at tick ${sim.tick}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    for (let i = 0; i < this.companies.length; i += 1) {
      if (this.formingActive[i] === 1) (this.forming[i] as CandleBuilder).add(sim.P[i] as number, sim.volume[i] as number);
    }
    const marks = this.marks;
    while (this.markIdx < marks.length && (marks[this.markIdx] as PendingMark).tick <= sim.tick) {
      const m = marks[this.markIdx] as PendingMark;
      this.markIdx += 1;
      const price = sim.P[m.companyId] as number;
      if (m.tick === sim.tick && price > 0) this.pendingMarks.push({ key: m.key, kind: m.kind, price });
    }
  }

  private onBoundary(t: number, target: number): void {
    const candleNo = t / TICKS_PER_CANDLE;
    const keepFrom = (target - RETENTION_C10_TICKS) / TICKS_PER_CANDLE;
    for (let i = 0; i < this.companies.length; i += 1) {
      if (!this.sim.isListed(i)) {
        this.stats.clear(i, candleNo);
        continue;
      }
      if (this.formingActive[i] === 1) {
        const candle = (this.forming[i] as CandleBuilder).toCandle();
        if (candle.index !== candleNo) throw new Error(`Candle bookkeeping broke for ${this.companies[i]?.ticker}: expected candle ${candleNo}, have ${candle.index}`);
        if (candleNo >= keepFrom) this.pending.c10.push({ company: i, candle });
        this.stats.set(i, candleNo, candle);
        this.hour.add(i, candle);
        this.day.add(i, candle);
      } else {
        this.stats.clear(i, candleNo);
      }
      (this.forming[i] as CandleBuilder).begin(candleNo + 1, this.sim.P[i] as number);
      this.formingActive[i] = 1;
    }
    if (this.hour.isPeriodEnd(candleNo)) this.pending.h1.push(...this.hour.flush(candleNo));
    if (this.day.isPeriodEnd(candleNo)) this.pending.d1.push(...this.day.flush(candleNo));
    // Live (within a minute of the clock): save at every candle. Catching up: save at every full hour of market time.
    if (target - t <= 60 || t % CATCHUP_CHUNK_TICKS === 0) this.flush(t);
  }

  // ---- saving --------------------------------------------------------------------------------------------------------

  private writeState(t: number): void {
    const state: SavedState = { sim: this.sim.snapshot(), hour: this.hour?.toState() ?? emptyRollup(), day: this.day?.toState() ?? emptyRollup() };
    const json = JSON.stringify(state);
    this.db.run(
      'INSERT INTO world_state(id, tick, state, updated_ms) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET tick = excluded.tick, state = excluded.state, updated_ms = excluded.updated_ms',
      t,
      json,
      this.now(),
    );
    if (t % TICKS_PER_HOUR === 0) this.db.run('INSERT OR REPLACE INTO checkpoints(tick, state) VALUES (?, ?)', t, json);
  }

  /** Writes all finished candles and the simulation state in one transaction. */
  private flush(t: number): void {
    const insert = (table: 'candles_c10' | 'candles_h1' | 'candles_d1', rows: { company: number; candle: Candle }[]): void => {
      const sql = `INSERT OR REPLACE INTO ${table}(company_id, idx, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?)`;
      for (const r of rows) this.db.run(sql, r.company, r.candle.index, r.candle.open, r.candle.high, r.candle.low, r.candle.close, r.candle.volume);
    };
    this.db.tx(() => {
      insert('candles_c10', this.pending.c10);
      insert('candles_h1', this.pending.h1);
      insert('candles_d1', this.pending.d1);
      if (this.pendingMarks.length > 0) this.options.news?.recordMarks?.(this.pendingMarks);
      this.writeState(t);
      if (t % TICKS_PER_HOUR === 0) this.prune(t);
    });
    this.pending = { c10: [], h1: [], d1: [] };
    this.pendingMarks = [];
    this.savedTick = t;
    for (const l of this.savedListeners) {
      try {
        l(t);
      } catch (error) {
        this.log.error('world', `A save listener failed at tick ${t}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private lastObserverLog = 0;

  private readonly savedListeners = new Set<(tick: number) => void>();

  /** Called after each save, with the tick up to which candles are now stored. Used to settle 1v1 matches from stored prices. */
  onSaved(listener: (tick: number) => void): () => void {
    this.savedListeners.add(listener);
    return () => this.savedListeners.delete(listener);
  }

  /** Housekeeping once an hour: drop old 10-tick candles and thin out old checkpoints. */
  private prune(t: number): void {
    const cutoff = (t - RETENTION_C10_TICKS) / TICKS_PER_CANDLE;
    if (cutoff > 0) this.db.run('DELETE FROM candles_c10 WHERE idx <= ?', cutoff);
    const old = t - 7 * TICKS_PER_DAY;
    if (old > 0) this.db.run('DELETE FROM checkpoints WHERE tick < ? AND tick % ? != 0', old, TICKS_PER_DAY);
  }

  // ---- the live loop ---------------------------------------------------------------------------------------------------

  /** Called by the timer: brings the world up to the clock, a little at a time so the server stays responsive. */
  pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    try {
      const target = this.currentTick();
      this.advanceTo(target, 40);
      this.stalledReason = null;
      this.catching = this.sim.tick < target - 5;
      if (this.sim.tick < target) setImmediate(() => this.pump());
      this.broadcast();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.stalledReason = message;
      const nowMs = this.now();
      if (nowMs - this.lastStallLog > 10_000) {
        this.lastStallLog = nowMs;
        this.log.error('world', `The market could not advance: ${message}`);
      }
    } finally {
      this.pumping = false;
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.pump(), 100);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.initialised && this.sim.tick > this.savedTick) {
      // Nothing to write: the state is only saved at candle boundaries and the next start replays the few ticks since then.
    }
  }

  private lastBroadcast = -1;

  private broadcast(): void {
    if (this.listeners.size === 0 || this.sim.tick === this.lastBroadcast) return;
    this.lastBroadcast = this.sim.tick;
    const msg = this.tickMessage();
    for (const l of this.listeners) {
      try {
        l(msg);
      } catch (error) {
        this.log.warn('world', `A tick listener failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  onTick(listener: (m: TickMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  tickMessage(): TickMessage {
    const n = this.companies.length;
    const prices: number[] = new Array<number>(n);
    const halves: number[] = new Array<number>(n);
    for (let i = 0; i < n; i += 1) {
      const p = this.sim.P[i] as number;
      const half = p > 0 ? quoteOf(this.companies[i] as Company, p, this.sim.V[i] as number).half : 0;
      // Browsers get cents. A fine-priced coin's price is in smaller units: it goes out as a (tiny) number of cents.
      const scale = scaleOf(this.companies[i]);
      prices[i] = scale === 1 ? p : p / scale;
      halves[i] = scale === 1 ? half : half / scale;
    }
    return { tick: this.sim.tick, ms: this.msOfTick(this.sim.tick), prices, halves };
  }

  msOfTick(tick: number): number {
    return this.genesisMs + tick * 1000;
  }

  // ---- reading -------------------------------------------------------------------------------------------------------

  health(): Health {
    const clock = this.initialised ? this.currentTick() : 0;
    const lag = Math.max(0, clock - (this.initialised ? this.sim.tick : 0));
    return {
      ok: this.initialised && this.stalledReason === null && lag <= MAX_TRADING_LAG_TICKS,
      tick: this.initialised ? this.sim.tick : 0,
      clockTick: clock,
      lagTicks: lag,
      catchingUp: this.catching,
      stalled: this.stalledReason,
      savedTick: this.savedTick,
      companies: this.companies.length,
      listed: this.initialised ? this.listedCount() : 0,
      genesisMs: this.genesisMs,
      engineVersion: WORLD_ENGINE_VERSION,
    };
  }

  /** The seed this world was made from (what the news and fundamentals are drawn from). For the server's own use: it must never be sent to a browser. */
  get seed(): number {
    return this.worldSeed;
  }

  companyByTicker(ticker: string): Company | undefined {
    const t = ticker.toUpperCase();
    return this.companies.find((c) => c.ticker === t);
  }

  isTrading(i: number): boolean {
    return this.sim.isListed(i);
  }

  /** Bid, ask and spread of company i right now. */
  quote(i: number): Quote {
    return quoteOf(this.companies[i] as Company, this.sim.price(i), this.sim.activity(i));
  }

  private bookTilt: ((companyId: number, tick: number) => number) | null = null;

  /**
   * Lets the book react to what players do: `tilt` returns the players' net buying (> 0) or selling (< 0) of a company as a number
   * from -1 to 1 (flow.ts), which thins the asks and thickens the bids (or the opposite). Without it the book is always the calm book.
   */
  setBookTilt(tilt: ((companyId: number, tick: number) => number) | null): void {
    this.bookTilt = tilt;
  }

  /** How much players are net buying (> 0) or selling (< 0) a company right now, from -1 to 1 (0 when pushes are off): what tilts the book. */
  tiltOf(i: number): number {
    return this.bookTilt ? this.bookTilt(i, this.sim.tick) : 0;
  }

  /** The ladder a market order of this side would walk, right now. Orders, estimates and the book shown on the page all use this. */
  book(i: number, side: Side, levels?: number): Level[] {
    return ladder(this.companies[i] as Company, this.quote(i), this.sim.activity(i), side, levels, bookScale(side, this.tiltOf(i)));
  }

  marketCap(i: number): number {
    return marketCapCents(this.sim.price(i), this.companies[i] as Company);
  }

  /** Candles of one company. Newest last. For 10-tick candles the forming one is included. */
  candles(i: number, res: Resolution, limit: number, before?: number): CandleView[] {
    const table = res === 'c10' ? 'candles_c10' : res === 'h1' ? 'candles_h1' : 'candles_d1';
    const lim = Math.max(1, Math.min(2000, limit));
    const rows =
      before === undefined
        ? this.db.all<Candle>(`SELECT idx AS "index", open, high, low, close, volume FROM ${table} WHERE company_id = ? ORDER BY idx DESC LIMIT ?`, i, lim)
        : this.db.all<Candle>(`SELECT idx AS "index", open, high, low, close, volume FROM ${table} WHERE company_id = ? AND idx < ? ORDER BY idx DESC LIMIT ?`, i, before, lim);
    const out: CandleView[] = rows.reverse().map((r) => ({ ...r, ticks: TICKS_PER_CANDLE, complete: true }));
    if (before === undefined && this.sim.isListed(i)) {
      const candleNo = Math.floor(this.sim.tick / TICKS_PER_CANDLE) + 1;
      if (res === 'c10') {
        const b = this.forming[i] as CandleBuilder;
        if (this.formingActive[i] === 1 && b.ticks > 0) out.push({ ...b.toCandle(), ticks: b.ticks, complete: false });
        else if (this.formingActive[i] === 1) out.push({ ...b.toCandle(), ticks: 0, complete: false });
      } else {
        // The period still being built: the finished 10-tick candles folded so far plus the one forming now.
        const r = res === 'h1' ? this.hour : this.day;
        const b = this.forming[i] as CandleBuilder;
        const parts: Candle[] = [];
        const done = r.forming(i, candleNo);
        if (done) parts.push(done);
        if (this.formingActive[i] === 1 && b.ticks > 0) parts.push(b.toCandle());
        if (parts.length > 0) {
          const merged = fold(Math.ceil(candleNo / r.perPeriod), parts);
          out.push({ ...merged, ticks: 0, complete: false });
        }
      }
    }
    // A fine-priced coin's candles are stored in its small price units; browsers get cents (a tiny number of cents).
    const scale = scaleOf(this.companies[i]);
    return scale === 1 ? out : out.map((c) => ({ ...c, open: c.open / scale, high: c.high / scale, low: c.low / scale, close: c.close / scale }));
  }
}

function emptyRollup(): RollupState {
  return { open: [], high: [], low: [], close: [], volume: [], count: [] };
}
