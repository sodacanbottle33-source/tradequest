// Launching stocks and memecoins, and the "rug pull". ANY signed-in player can launch a company with his own Career cash; only the
// player who launched a company can rug pull it. docs/world.md §12.1.
//
//   Launch   The player picks a name and ticker, and puts money in. The MONEY decides the size (server/customCoin.ts,
//            server/customStock.ts); nobody picks a size class, and nobody picks the starting price either: for a coin the money decides it
//            (every launched coin has the same number of coins from $5,000 up), for a stock too (a table of prices, server/customStock.ts). The
//            money is not lost: it buys shares at the starting price and the player starts out holding them (the "launch stake"; cash turned
//            into shares, so neither profit nor loss; only the launch fee is a cost). The
//            company is then saved and added to the running market exactly like a company the owner makes, and starts trading a few
//            seconds later. A launch is a row in `launches`.
//            A STOCK needs a real stake and a fee: at least MIN_STOCK_SEED_CENTS put in ($100), plus the stock launch fee
//            (STOCK_LAUNCH_FEE_CENTS, $10, taken from the cash and gone). There is no free stock launch.
//            A MEMECOIN is made like on pump.fun: making it costs only the launch fee (LAUNCH_FEE_CENTS, taken from the cash and gone), and the
//            money put in is an optional first buy that can be $0, in which case the player holds nothing of it and buys on the market once it
//            lists, like everybody else (a launch with no stake has no position row).
//
//   Rug pull A COIN launched with a money pool (server/pools.ts, docs/world.md §12.2) has real cash behind it: everything buyers paid for it
//            is in the pool. The rug pull takes ALL of that cash for the launching player, kills the coin (what other players still hold of it
//            is worth nothing and cannot be sold) and crashes its price, with a news story that says what happened. He does not need to hold
//            any of the coin for that. A coin from before pools, and every stock, has no pool: its rug pull stays what it was, the launching
//            player sells EVERYTHING he holds of his own company in one ordinary market order (it walks the order book like any order, pushes
//            the price down like any big sell, and the cash he gets is his; if the book is too thin it fills only partly: press again later).
//
// Nothing here changes how prices are made. A launch adds a company (the same way the owner's Create stock does), a position and, for a coin,
// a pool; a pool rug pull moves cash from the pool to the player and adds one crash story like the owner's price moves, the other kind of
// rug pull is a normal order (Trading.placeOrder) plus one informational news story (realised 0: it moves no price by itself).

import { CURATED, MAX_COMPANIES, MEME_SEEDS, TICK_MS, adminDraft, cycleOfTick, scaleOf, unitsToCents, type CatalogEntry, type Company, type NewsDraft } from '../src/world';
import { solveTotal } from './admin';
import type { User } from './auth';
import { coinOptions, makeCoinEntry, previewCoin, type CoinInput, type CoinOptions, type CoinPreview } from './customCoin';
import { makeLaunchedStockEntry, previewStock, stockLaunchOptions, type StockLaunchInput, type StockLaunchOptions, type StockLaunchPreview, MAX_OWN_COMPANIES } from './customStock';
import type { Halts } from './halts';
import { HttpError } from './http';
import { NO_LAUNCH_IN_MATCH } from './lobby/service';
import type { Logger } from './log';
import type { NewsService } from './news/service';
import { POOL_COLUMNS, createPool, drain, poolOf, type PoolRow } from './pools';
import type { SseHub } from './sse';
import type { Db } from './sqlite';
import { OrderError, maxOrderShares, type PositionView, type Trading } from './trading';
import type { MarketViews } from './world/views';
import { OWN_LISTING_DELAY_TICKS, type WorldRuntime } from './world/runtime';

/** A player may have this many launched companies of one kind that he still holds (sell out of one and he can launch another). */
export const MAX_ACTIVE_PER_KIND = 3;
/** … and may launch this many of one kind in all, ever (a company can never be removed, so the number has to be capped). */
export const MAX_EVER_PER_KIND = 20;
/** The most memecoins players can launch in all (stocks are capped by MAX_OWN_COMPANIES together with the owner's). */
export const MAX_LAUNCHED_COINS = 300;

const LISTING_SECONDS = Math.round((OWN_LISTING_DELAY_TICKS * TICK_MS) / 1000);
const REQUEST_ID = /^[A-Za-z0-9_-]{8,60}$/;
/** How long the rug pull news runs (ticks). It moves no price; this only decides how long it counts as "live". */
const RUG_NEWS_TICKS = 30;
/** The news slot used for rug pull stories (the same one the owner's special events use, see admin.ts). */
const RUG_SLOT = 900;
/**
 * How the pool rug pull of an older coin (one that counts in cents) crashes the price: down 99 % in a burst of 6 ticks (the owner's "instant"
 * move, admin.ts); the $1.00 price floor stops it there, and from then on its price stays where it is. A coin with fine prices has no crash like
 * this: it dies on the spot and sits at the lowest price there is.
 */
const DRAIN_CRASH = { multiplier: 0.01, ticks: 6 } as const;

export interface LaunchDeps {
  readonly db: Db;
  readonly world: WorldRuntime;
  readonly trading: Trading;
  readonly halts: Halts;
  readonly news: NewsService | null;
  readonly views: MarketViews;
  readonly hub: SseHub;
  readonly log: Logger;
  readonly now: () => number;
  /** Tells open pages to fetch their company list again (the "notice" event). */
  readonly notify: () => void;
  /** True while the player's 1v1 match is about to start or running: he may not launch then (docs/world.md §9.10). */
  readonly inMatch?: (userId: number) => boolean;
}

interface LaunchRow {
  company_id: number;
  user_id: number;
  kind: 'stock' | 'coin';
  request_id: string;
  seed_cents: number;
  spent_cents: number;
  stake_shares: number;
  price_cents: number;
  created_ms: number;
  fee_cents: number;
}

export interface LaunchView {
  readonly companyId: number;
  readonly ticker: string;
  readonly name: string;
  readonly kind: 'stock' | 'coin';
  readonly createdMs: number;
  readonly seedCents: number;
  /** What the first buy took from the player's cash, and what it bought: the launch stake at the starting price (both 0 with no first buy). */
  readonly spentCents: number;
  readonly stakeShares: number;
  /** The launch fee he paid (0 for a launch from before there was a fee). */
  readonly feeCents: number;
  readonly priceCents: number;
  /** True once the company is trading; until then `listsInSeconds` says about how long. */
  readonly listed: boolean;
  readonly listsInSeconds: number;
  readonly halted: boolean;
  /** What the player holds of it now (0 once he has sold out), and what that is worth if sold at the bid. */
  readonly sharesNow: number;
  readonly valueNowCents: number;
  /** The current market price (cents; the starting price until it trades). */
  readonly priceNowCents: number;
  /** Everything made on this company so far: cash already received from sales (after fees) plus what is held now, minus what was put in and the launch fee. */
  readonly profitCents: number;
  /** Rug pulls so far: how many orders, how many shares they sold, how much cash they paid out. */
  readonly rugs: number;
  readonly ruggedShares: number;
  readonly ruggedCents: number;
  /** True when pressing "Rug pull" would do something right now; otherwise `blocked` says why. */
  readonly canRug: boolean;
  readonly blocked: string | null;
  /**
   * The money pool behind a coin launched with one (null for a stock and for a coin from before pools): what is in it now (a rug pull would take
   * exactly that), everything buyers paid in and sellers took out so far, and what a rug pull already took (`dead`: it did, the coin is worthless).
   */
  readonly pool: { readonly cents: number; readonly inCents: number; readonly outCents: number; readonly drainedCents: number; readonly dead: boolean } | null;
}

export interface LaunchState {
  readonly cashCents: number;
  readonly coinForm: CoinOptions;
  readonly stockForm: StockLaunchOptions;
  readonly limits: { activePerKind: number; everPerKind: number };
  /** How many launches of each kind the player has now (still held) and has made in all. */
  readonly counts: { coinActive: number; coinEver: number; stockActive: number; stockEver: number };
  readonly mine: LaunchView[];
}

/** The answer to a rug pull of a coin with a money pool: the whole pool became the player's cash and the coin is dead. */
export interface DrainResult {
  readonly ok: true;
  readonly kind: 'drain';
  readonly duplicate: boolean;
  readonly ticker: string;
  readonly name: string;
  /** What the pool held and now is the player's cash. */
  readonly takenCents: number;
  /** Everything buyers had paid in, and how much of it the player put in himself (his first buy and what he bought later is in his own cost). */
  readonly paidInCents: number;
  /** How many other players were left holding the coin, and how many coins that is. */
  readonly otherHolders: number;
  readonly otherCoins: number;
  /** What the player holds of the (now worthless) coin himself. */
  readonly ownCoins: number;
}

/** The answer to a rug pull of a company without a pool: one ordinary market sale. */
export interface RugResult {
  readonly ok: true;
  readonly kind: 'sale';
  readonly duplicate: boolean;
  readonly ticker: string;
  readonly name: string;
  readonly requested: number;
  readonly filled: number;
  /** True when the order book took only part of it: press again a little later for the rest. */
  readonly partial: boolean;
  readonly remaining: number;
  readonly receivedCents: number;
  readonly avgPriceCents: number;
  readonly midBeforeCents: number;
  readonly feeCents: number;
  readonly tradeId: number;
}

function money(cents: number): string {
  const abs = Math.abs(cents);
  return `${cents < 0 ? '−' : ''}$${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
}

export class Launches {
  constructor(private readonly d: LaunchDeps) {}

  // ---- reading -----------------------------------------------------------------------------------------------------

  state(user: User): LaunchState {
    const { db, trading } = this.d;
    const acc = trading.careerAccountOf(user.id);
    const view = trading.view(acc.id);
    const rows = db.all<LaunchRow>('SELECT * FROM launches WHERE user_id = ? ORDER BY created_ms DESC, company_id DESC LIMIT 200', user.id);
    const mine = rows.map((r) => this.viewOf(r, acc.id, view.positions));
    const held = (kind: 'stock' | 'coin'): number => mine.filter((m) => m.kind === kind && m.sharesNow > 0 && !m.pool?.dead).length;
    const ever = (kind: 'stock' | 'coin'): number => this.everCount(user.id, kind);
    return {
      cashCents: acc.cash_cents,
      coinForm: coinOptions(LISTING_SECONDS),
      stockForm: stockLaunchOptions(LISTING_SECONDS),
      limits: { activePerKind: MAX_ACTIVE_PER_KIND, everPerKind: MAX_EVER_PER_KIND },
      counts: { coinActive: held('coin'), coinEver: ever('coin'), stockActive: held('stock'), stockEver: ever('stock') },
      mine,
    };
  }

  private everCount(userId: number, kind: 'stock' | 'coin'): number {
    return this.d.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM launches WHERE user_id = ? AND kind = ?', userId, kind)?.n ?? 0;
  }

  /** Companies of this kind the player launched and still holds some of (a coin whose pool he took is dead and does not count). */
  private activeCount(userId: number, accountId: number, kind: 'stock' | 'coin'): number {
    return (
      this.d.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM launches l JOIN positions p ON p.company_id = l.company_id AND p.account_id = ?
          WHERE l.user_id = ? AND l.kind = ? AND NOT EXISTS (SELECT 1 FROM coin_pools c WHERE c.company_id = l.company_id AND c.drained_ms IS NOT NULL)`,
        accountId,
        userId,
        kind,
      )?.n ?? 0
    );
  }

  private viewOf(r: LaunchRow, accountId: number, positions: readonly PositionView[]): LaunchView {
    const { world, db, halts } = this.d;
    const c = world.companies[r.company_id] as Company | undefined;
    const listed = c !== undefined && world.isTrading(c.id);
    const pos = positions.find((p) => p.companyId === r.company_id && !p.short);
    const sharesNow = pos?.shares ?? 0;
    const rug = db.get<{ n: number; shares: number | null; cents: number | null }>('SELECT COUNT(*) AS n, SUM(shares) AS shares, SUM(received_cents) AS cents FROM launch_rugs WHERE company_id = ?', r.company_id);
    const realized = db.get<{ s: number | null }>('SELECT SUM(realized_cents) AS s FROM trades WHERE account_id = ? AND company_id = ?', accountId, r.company_id)?.s ?? 0;
    const any = positions.find((p) => p.companyId === r.company_id);
    const halted = c !== undefined && halts.isHalted(c.id);
    const listsIn = c === undefined || listed ? 0 : Math.max(0, Math.ceil(((c.listingTick - Math.max(world.sim.tick, world.currentTick())) * TICK_MS) / 1000));
    const poolRow = poolOf(db, r.company_id);
    const dead = poolRow !== null && poolRow.drained_ms !== null;
    let blocked: string | null = null;
    if (!c) blocked = 'This company is not in the market yet. Restart the server to load it.';
    else if (!listed) blocked = `${c.ticker} is not trading yet.`;
    else if (poolRow) {
      // A coin with a money pool: the rug pull takes the pool, whatever the player holds of the coin himself.
      if (dead) blocked = `You took the money out of the ${c.ticker} pool already: ${c.ticker} is dead.`;
      else if (halted) blocked = `Trading in ${c.ticker} is halted right now.`;
      else if (poolRow.pool_cents === 0) blocked = `There is no money in the ${c.ticker} pool yet: it fills up when players buy ${c.ticker}.`;
    } else if (any?.short) blocked = `You are short ${c.ticker}: a rug pull sells what you hold.`;
    else if (sharesNow === 0) blocked = `You hold none of ${c.ticker} any more.`;
    else if (halted) blocked = `Trading in ${c.ticker} is halted right now.`;
    return {
      companyId: r.company_id,
      ticker: c?.ticker ?? '?',
      name: c?.name ?? '?',
      kind: r.kind,
      createdMs: r.created_ms,
      seedCents: r.seed_cents,
      spentCents: r.spent_cents,
      stakeShares: r.stake_shares,
      feeCents: r.fee_cents,
      // Prices go out in cents; a fine-priced coin keeps its launch row and its market in smaller units (a tiny number of cents here).
      priceCents: unitsToCents(r.price_cents, scaleOf(c)),
      listed,
      listsInSeconds: listsIn,
      halted,
      sharesNow,
      valueNowCents: pos?.equityCents ?? 0,
      priceNowCents: unitsToCents(c && listed ? world.sim.price(c.id) : r.price_cents, scaleOf(c)),
      profitCents: realized + (any?.unrealizedCents ?? 0) - r.fee_cents + (poolRow?.drained_cents ?? 0),
      rugs: (rug?.n ?? 0) + (dead ? 1 : 0),
      ruggedShares: rug?.shares ?? 0,
      ruggedCents: (rug?.cents ?? 0) + (poolRow?.drained_cents ?? 0),
      canRug: blocked === null,
      blocked,
      pool: poolRow ? { cents: poolRow.pool_cents, inCents: poolRow.in_cents, outCents: poolRow.out_cents, drainedCents: poolRow.drained_cents, dead } : null,
    };
  }

  /** What a coin launch with this first buy would make (its starting price too), and whether the player has the cash for the fee and the first buy (for the live preview). */
  previewCoin(user: User, seedCents: unknown): CoinPreview & { cashCents: number; enough: boolean } {
    const preview = previewCoin(seedCents);
    const cash = this.d.trading.careerAccountOf(user.id).cash_cents;
    return { ...preview, cashCents: cash, enough: cash >= preview.totalCents };
  }

  /** What a stock launch with this money would make (its starting price too), and whether the player has the cash for the shares and the fee. */
  previewStock(user: User, seedCents: unknown): StockLaunchPreview & { cashCents: number; enough: boolean } {
    const preview = previewStock(seedCents);
    const cash = this.d.trading.careerAccountOf(user.id).cash_cents;
    return { ...preview, cashCents: cash, enough: cash >= preview.totalCents };
  }

  // ---- launching ---------------------------------------------------------------------------------------------------

  private requestId(value: unknown): string {
    if (typeof value !== 'string' || !REQUEST_ID.test(value)) throw new HttpError(400, 'bad_request', 'The request needs a requestId of 8–60 letters, numbers, - or _.');
    return value;
  }

  /** The names and tickers no new company may use: every company in the market, and the thirty built-in coins even if this world does not have them yet. */
  private takenNames(): { names: Set<string>; tickers: Set<string> } {
    const { world } = this.d;
    return {
      names: new Set([...world.companies.map((c) => c.name.toLowerCase()), ...MEME_SEEDS.map((m) => m.name.toLowerCase())]),
      tickers: new Set([...world.companies.map((c) => c.ticker), ...MEME_SEEDS.map((m) => m.ticker)]),
    };
  }

  /** A launch request that was already done returns the first answer instead of launching again. */
  private repeated(user: User, requestId: string, kind: 'stock' | 'coin', rawTicker: string): Record<string, unknown> | null {
    const row = this.d.db.get<LaunchRow>('SELECT * FROM launches WHERE request_id = ?', requestId);
    if (!row) return null;
    const c = this.d.world.companies[row.company_id];
    if (row.user_id !== user.id || row.kind !== kind || (rawTicker !== '' && c?.ticker !== rawTicker)) {
      throw new HttpError(409, 'request_id_reused', 'That requestId was already used for a different launch.');
    }
    return { ok: true, duplicate: true, kind, ticker: c?.ticker ?? '?', name: c?.name ?? '?', companyId: row.company_id };
  }

  private checkNotInMatch(user: User): void {
    if (this.d.inMatch?.(user.id)) throw new HttpError(409, 'in_match', NO_LAUNCH_IN_MATCH);
  }

  launchCoin(user: User, input: CoinInput & { requestId: unknown }): Record<string, unknown> {
    const requestId = this.requestId(input.requestId);
    const rawTicker = typeof input.ticker === 'string' ? input.ticker.trim().toUpperCase() : '';
    const again = this.repeated(user, requestId, 'coin', rawTicker);
    if (again) return again;
    this.checkNotInMatch(user);
    const { entry, preview } = makeCoinEntry(input, this.takenNames());
    const launched = this.d.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM launches WHERE kind = 'coin'")?.n ?? 0;
    if (launched >= MAX_LAUNCHED_COINS) throw new HttpError(400, 'too_many', `Players have already launched ${launched} coins, which is the most the market can hold.`);
    return this.commit(user, requestId, 'coin', entry, { seedCents: preview.seedCents, spentCents: preview.spentCents, feeCents: preview.feeCents, stakeShares: preview.stakeShares, priceCents: entry.price }, {
      size: preview.size,
      sizeLabel: preview.sizeLabel,
      marketCapCents: preview.marketCapCents,
    });
  }

  launchStock(user: User, input: StockLaunchInput & { requestId: unknown }): Record<string, unknown> {
    const requestId = this.requestId(input.requestId);
    const rawTicker = typeof input.ticker === 'string' ? input.ticker.trim().toUpperCase() : '';
    const again = this.repeated(user, requestId, 'stock', rawTicker);
    if (again) return again;
    this.checkNotInMatch(user);
    const { entry, preview } = makeLaunchedStockEntry(input, this.takenNames());
    const own = this.d.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM custom_companies')?.n ?? 0;
    if (own >= MAX_OWN_COMPANIES) throw new HttpError(400, 'too_many', `${own} companies were made by hand already, which is the most there can be.`);
    return this.commit(user, requestId, 'stock', entry, { seedCents: preview.seedCents, spentCents: preview.spentCents, feeCents: preview.feeCents, stakeShares: preview.stakeShares, priceCents: entry.price }, {
      tier: preview.tier,
      tierLabel: preview.tierLabel,
    });
  }

  /** The part launching a stock and launching a coin share: limits, cash, saving the company, the stake, loading it into the running market. */
  private commit(
    user: User,
    requestId: string,
    kind: 'stock' | 'coin',
    entry: CatalogEntry,
    money_: { seedCents: number; spentCents: number; feeCents: number; stakeShares: number; priceCents: number },
    extra: Record<string, unknown>,
  ): Record<string, unknown> {
    const { db, world, views, log, trading } = this.d;
    const acc = trading.careerAccountOf(user.id);
    if (this.everCount(user.id, kind) >= MAX_EVER_PER_KIND) {
      throw new HttpError(400, 'too_many', `You have launched ${MAX_EVER_PER_KIND} ${kind === 'coin' ? 'coins' : 'stocks'} already, which is the most one player can.`);
    }
    if (this.activeCount(user.id, acc.id, kind) >= MAX_ACTIVE_PER_KIND) {
      throw new HttpError(
        400,
        'too_many_active',
        `You already hold ${MAX_ACTIVE_PER_KIND} ${kind === 'coin' ? 'coins' : 'stocks'} you launched. Sell out of one (a rug pull does it) before you launch another.`,
      );
    }
    if (world.companies.length + 1 > MAX_COMPANIES) throw new HttpError(400, 'too_many', 'The market cannot hold more companies.');
    let listingTick: number;
    try {
      world.nextCompanyId(); // refuses when the database and the running market disagree
      listingTick = world.ownListingTick();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new HttpError(409, world.companies.length < CURATED.length ? 'too_few_companies' : 'restart_needed', message);
    }
    const id = db.tx(() => {
      const fresh = trading.careerAccountOf(user.id);
      const need = money_.feeCents + money_.spentCents;
      if (fresh.cash_cents < need) {
        const thing = kind === 'coin' ? 'a coin' : 'a stock';
        const what =
          money_.spentCents === 0
            ? `Making ${thing} costs the ${money(money_.feeCents)} launch fee`
            : `Making ${thing} costs the ${money(money_.feeCents)} launch fee plus ${money(money_.spentCents)} for ${kind === 'coin' ? 'your first buy' : 'the shares'}, ${money(need)} in all`;
        throw new HttpError(400, 'not_enough_cash', `${what}, and you have ${money(fresh.cash_cents)}. Put in less, or earn more first.`, { cashCents: fresh.cash_cents, needCents: need });
      }
      const newId = kind === 'coin' ? world.recordOwnCoin(entry, listingTick) : world.recordOwnCompany(entry, listingTick, user.id);
      db.run('UPDATE accounts SET cash_cents = cash_cents - ? WHERE id = ?', need, fresh.id);
      // The launch stake: the shares the first buy bought, at the starting price. Cash turned into shares, so it is neither profit nor loss (the fee is a cost, and
      // is kept on the launch row). With no first buy there is no stake and no position.
      if (money_.stakeShares > 0) {
        db.run('INSERT INTO positions(account_id, company_id, shares, cost_cents) VALUES (?, ?, ?, ?)', fresh.id, newId, money_.stakeShares, money_.spentCents);
      }
      db.run(
        'INSERT INTO launches(company_id, user_id, kind, request_id, seed_cents, spent_cents, stake_shares, price_cents, created_ms, fee_cents) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        newId,
        user.id,
        kind,
        requestId,
        money_.seedCents,
        money_.spentCents,
        money_.stakeShares,
        money_.priceCents,
        this.d.now(),
        money_.feeCents,
      );
      // A coin gets a money pool (pools.ts): the first buy is its first deposit. A stock has none.
      if (kind === 'coin') createPool(db, newId, money_.spentCents);
      return newId;
    });
    const scale = scaleOf(entry.meme);
    log.info('launch', `${user.username}: launched ${kind} ${entry.ticker} (${entry.name}) with ${money(money_.spentCents)} put in (and ${money(money_.feeCents)} fee) at ${scale === 1 ? money(money_.priceCents) : `$${(money_.priceCents / scale / 100).toFixed(16).replace(/0+$/, '')}`}`);
    // Only now, after the company is safely saved, does the running market learn about it. If that failed, the company still exists in
    // the database and the next start of the server loads it.
    let loaded = true;
    try {
      world.loadOwnCompany(id);
    } catch (error) {
      loaded = false;
      log.error('launch', `${entry.ticker} was saved but could not be added to the running market (it will start trading after the next server start): ${error instanceof Error ? error.message : String(error)}`);
    }
    trading.leverageChanged();
    views.invalidate();
    this.d.notify(); // open pages fetch their company list again
    const startsInSeconds = Math.max(0, listingTick - Math.max(world.sim.tick, world.currentTick()));
    return {
      ok: true,
      duplicate: false,
      kind,
      ticker: entry.ticker,
      name: entry.name,
      companyId: id,
      listingTick,
      startsInSeconds,
      loaded,
      stakeShares: money_.stakeShares,
      spentCents: money_.spentCents,
      feeCents: money_.feeCents,
      priceCents: unitsToCents(money_.priceCents, scale),
      ...extra,
    };
  }

  // ---- the rug pull ------------------------------------------------------------------------------------------------

  /**
   * The rug pull. A coin with a money pool: the launching player takes everything that is in the pool (see {@link drainPool}). Any other company
   * (a stock, a coin from before pools): he sells everything he holds of it in one market order. That is an ordinary order in every way: it pays
   * the spread and walks the order book, a coin pays the 0.5 % fee, it pushes the price down by the usual amount, and a halt or a
   * pause refuses it. If the book is too thin to take it all, the part that was sold is done and the rest is still his: press
   * again later (his used-up depth comes back with a half-life of five minutes). Safe to send twice (same requestId = same result).
   */
  rugPull(user: User, input: { requestId: unknown; ticker: unknown }): RugResult | DrainResult {
    const { db, world } = this.d;
    const requestId = this.requestId(input.requestId);
    const company = typeof input.ticker === 'string' ? world.companyByTicker(input.ticker) : undefined;
    if (!company) throw new HttpError(404, 'unknown_company', 'No such company.');
    const launch = db.get<LaunchRow>('SELECT * FROM launches WHERE company_id = ?', company.id);
    if (!launch) throw new HttpError(400, 'not_a_launch', `${company.ticker} was not launched by a player, so there is nothing to rug pull.`);
    if (launch.user_id !== user.id) throw new HttpError(403, 'not_yours', `Only the player who launched ${company.ticker} can rug pull it.`);
    if (poolOf(db, company.id)) return this.drainPool(user, company, requestId);
    return this.sellOut(user, company, requestId);
  }

  // ---- the rug pull of a coin with a money pool --------------------------------------------------------------------

  /**
   * Takes everything that is in the coin's money pool for the launching player and kills the coin (pools.ts): the cash becomes his, the coin
   * crashes and what other players still hold of it is worth nothing and cannot be sold. He does not have to hold any of the coin. It is refused
   * while the company is halted or trading is paused, when the pool is empty and when it was already taken. Safe to send twice (same requestId
   * = same result, and nothing is paid twice).
   */
  private drainPool(user: User, company: Company, requestId: string): DrainResult {
    const { db, trading, views, log } = this.d;
    const acc = trading.careerAccountOf(user.id);
    const row = (companyId: number): PoolRow => poolOf(db, companyId) as PoolRow;
    const result = (duplicate: boolean, taken: number, paidIn: number): DrainResult => {
      const others = db.get<{ holders: number; coins: number | null }>(
        `SELECT COUNT(*) AS holders, SUM(p.shares) AS coins FROM positions p JOIN accounts a ON a.id = p.account_id AND a.kind = 'career'
          WHERE p.company_id = ? AND p.short = 0 AND a.user_id <> ?`,
        company.id,
        user.id,
      );
      const own = db.get<{ shares: number }>('SELECT shares FROM positions WHERE account_id = ? AND company_id = ? AND short = 0', acc.id, company.id)?.shares ?? 0;
      return { ok: true, kind: 'drain', duplicate, ticker: company.ticker, name: company.name, takenCents: taken, paidInCents: paidIn, otherHolders: others?.holders ?? 0, otherCoins: others?.coins ?? 0, ownCoins: own };
    };

    // A repeated request gets the first answer, even though the pool is empty by now.
    const before = db.get<PoolRow>(`SELECT ${POOL_COLUMNS} FROM coin_pools WHERE drain_request_id = ?`, requestId);
    if (before) {
      if (before.company_id !== company.id) throw new HttpError(409, 'request_id_reused', 'That requestId was already used for a different rug pull.');
      return result(true, before.drained_cents, before.in_cents);
    }
    const first = row(company.id);
    if (first.drained_ms !== null) throw new HttpError(400, 'already_pulled', `You already took the money out of the ${company.ticker} pool: ${company.ticker} is dead.`);
    try {
      trading.checkOpenFor(acc, company.id); // listed, not halted or paused, the market live
    } catch (error) {
      if (error instanceof OrderError) throw new HttpError(error.status, error.code, error.message, error.details);
      throw error;
    }
    if (first.pool_cents === 0) throw new HttpError(400, 'pool_empty', `There is no money in the ${company.ticker} pool yet. It fills up when players buy ${company.ticker}.`);

    const taken = db.tx(() => {
      const pool = row(company.id);
      if (pool.drained_ms !== null || pool.pool_cents === 0) throw new HttpError(409, 'pool_changed', `The ${company.ticker} pool changed while you pressed the button. Look at it again.`);
      const cents = drain(db, company.id, requestId, this.d.now());
      db.run('UPDATE accounts SET cash_cents = cash_cents + ? WHERE id = ?', cents, acc.id);
      return cents;
    });
    log.info('launch', `${user.username}: rug pull on ${company.ticker}: took ${money(taken)} out of its pool`);
    this.announceDrain(company, taken);
    views.invalidate();
    this.d.notify(); // open pages see that the coin is dead
    return result(false, taken, row(company.id).in_cents);
  }

  /**
   * The news story about a pool rug pull, with the crash: down 99 % in a few seconds (the owner's "instant" price move), so the price falls the way
   * the story says. Best effort: a failure here is logged and never undoes the rug pull (the coin is dead and cannot be traded either way).
   */
  private announceDrain(company: Company, takenCents: number): void {
    const { db, world, news, log } = this.d;
    if (!news) return;
    try {
      const publishTick = world.earliestEventStart();
      // A coin with fine prices does not crash by a share of its price: the story ends it. From the story's tick the coin is dead and its
      // price sits at the lowest price there is (src/world/sim.ts `setDeadFrom`). An older coin still falls 99 % in a burst, and then stays where it is.
      const fine = scaleOf(company) !== 1;
      const ticks = fine ? 1 : DRAIN_CRASH.ticks;
      const base = adminDraft({
        key: `rug:${company.id}:drain`,
        company,
        direction: 'negative',
        strength: 'extreme',
        publishTick,
        realized: 0,
        durationTicks: ticks,
        cycle: cycleOfTick(publishTick),
        slot: RUG_SLOT,
      });
      const draft: NewsDraft = {
        ...base,
        shape: 'burst',
        immediacy: 'immediate',
        realized: fine ? 0 : solveTotal(DRAIN_CRASH.multiplier, 'burst', DRAIN_CRASH.ticks),
        permShare: 1,
        headline: `${company.name} is a rug pull: its developer drained the pool`,
        body: `The developer of ${company.name} (${company.ceo}) took all ${money(takenCents)} out of the money pool behind ${company.ticker} and left. The price collapsed and the coins that other players still hold cannot be sold.`,
        breaking: true,
      };
      const id = db.tx(() => news.addSpecial(draft, this.d.now()));
      if (id !== null) world.scheduleEvent(news.eventOfDraft(draft));
    } catch (error) {
      log.error('launch', `The rug pull news for ${company.ticker} could not be published: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ---- the rug pull of a company without a pool: a market sale ---------------------------------------------------------

  private sellOut(user: User, company: Company, requestId: string): RugResult {
    const { db, world, trading } = this.d;
    const acc = trading.careerAccountOf(user.id);
    const clientOrderId = `rug-${requestId}`;

    // A repeated request gets the first answer, even if there is nothing left to sell by now.
    const before = db.get<{ requested: number }>('SELECT requested FROM trades WHERE account_id = ? AND client_order_id = ?', acc.id, clientOrderId);
    let qty: number;
    if (before) qty = before.requested;
    else {
      const pos = db.get<{ shares: number; short: number }>('SELECT shares, short FROM positions WHERE account_id = ? AND company_id = ?', acc.id, company.id);
      if (!pos) throw new HttpError(400, 'nothing_to_dump', `You hold none of ${company.ticker}, so there is nothing to dump.`);
      if (pos.short === 1) throw new HttpError(400, 'nothing_to_dump', `You are short ${company.ticker}. A rug pull sells the ${company.ticker} you hold; cover the short first.`);
      qty = Math.min(pos.shares, maxOrderShares(world.sim.price(company.id)));
    }

    let out;
    try {
      out = trading.placeOrder({ accountId: acc.id, clientOrderId, companyId: company.id, side: 'sell', qty });
    } catch (error) {
      if (error instanceof OrderError) throw new HttpError(error.status, error.code, error.message, error.details);
      throw error;
    }
    const t = out.trade;
    const received = Math.max(0, t.totalCents - t.debtCents) - t.feeCents;
    const fresh = db.tx(
      () => db.run('INSERT OR IGNORE INTO launch_rugs(trade_id, company_id, user_id, shares, received_cents, created_ms) VALUES (?, ?, ?, ?, ?, ?)', t.id, company.id, user.id, t.filled, received, this.d.now()).changes === 1,
    );
    if (fresh) {
      this.d.log.info('launch', `${user.username}: rug pull on ${company.ticker}: sold ${t.filled} of ${t.requested} for ${money(received)}`);
      this.announce(company, t.filled, t.id);
    }
    const left = db.get<{ shares: number }>('SELECT shares FROM positions WHERE account_id = ? AND company_id = ? AND short = 0', acc.id, company.id)?.shares ?? 0;
    return {
      ok: true,
      kind: 'sale',
      duplicate: out.duplicate,
      ticker: company.ticker,
      name: company.name,
      requested: t.requested,
      filled: t.filled,
      partial: t.filled < t.requested,
      remaining: left,
      receivedCents: received,
      avgPriceCents: Math.round(t.avgPrice),
      midBeforeCents: t.midCents,
      feeCents: t.feeCents,
      tradeId: t.id,
    };
  }

  /**
   * The news story about a rug pull: "the founder sold X". It is a plain story with a realised move of 0, so it changes no price by
   * itself (the sale already moved the price through the order flow); it exists so that other players can SEE what happened and
   * decide what to do. Best effort: a failure here is logged and never undoes or hides the sale.
   */
  private announce(company: Company, sold: number, tradeId: number): void {
    const { db, world, news, log } = this.d;
    if (!news) return;
    try {
      const pct = (sold / company.sharesOutstanding) * 100;
      const share = pct >= 0.1 ? `${pct.toFixed(1)} %` : 'a small part';
      const coin = company.sector === 'meme';
      const who = coin ? `The developer of ${company.name} (${company.ceo})` : `The founder of ${company.name}`;
      const publishTick = world.earliestEventStart();
      const base = adminDraft({
        key: `rug:${company.id}:${tradeId}`,
        company,
        direction: 'negative',
        strength: 'minor',
        publishTick,
        realized: 0,
        durationTicks: RUG_NEWS_TICKS,
        cycle: cycleOfTick(publishTick),
        slot: RUG_SLOT,
      });
      const draft: NewsDraft = {
        ...base,
        permShare: 0,
        headline: `${who} dumps ${sold.toLocaleString('en-US')} ${coin ? 'coins' : 'shares'}`,
        body: `${who} sold ${sold.toLocaleString('en-US')} ${coin ? 'coins' : 'shares'} of ${company.ticker} in a single order, ${share} of everything in circulation. Traders are watching to see how the price reacts.`,
        breaking: true,
      };
      const id = db.tx(() => news.addSpecial(draft, this.d.now()));
      if (id !== null) world.scheduleEvent(news.eventOfDraft(draft));
    } catch (error) {
      log.error('launch', `The rug pull news for ${company.ticker} could not be published: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
