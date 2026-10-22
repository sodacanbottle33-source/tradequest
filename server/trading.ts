// Accounts, positions and orders. This is the only code that changes anybody's cash or shares, and it does so only inside
// one database transaction that has the write lock, using the price the SERVER's market has right now. The browser sends
// "buy 10 of QLRX" and an order id; it never sends a price, a balance or a fill (docs/world.md §6).

import { formatCents } from '../src/engine';
import { MAX_ORDER_SHARES, MIN_PRICE, executeMarket, maxAffordable, recoverConsumed, type Company, type Execution, type FillPart, type Level, type Side, type WorldEvent } from '../src/world';
import { MEME_FEE_BPS, feeOf } from './fees';
import { NO_FLOW, applyMarkup, type FlowPreview, type FlowService } from './flow';
import type { Halts } from './halts';
import { borrowBps, costPerDay, interestBps, type MarginCosts } from './margin';
import {
  MAX_LEVERAGE,
  OPEN_COST_LIMIT,
  collateralOf,
  debtShare,
  equityOf,
  isLeverage,
  isLiquidated,
  isShortLiquidated,
  liquidationPrice,
  marginOf,
  maxLeverageFor,
  maxShortLeverageFor,
  shortLiquidationPrice,
} from './leverage';
import { POOL_SPOT_ONLY, deadCompanyIds, deadMessage, isDead, payIn, payOut, poolOf, type PoolRow } from './pools';
import type { Db } from './sqlite';
import type { WorldRuntime } from './world/runtime';
import { MAX_TRADING_LAG_TICKS } from './world/runtime';

export type OrderErrorCode =
  | 'bad_request'
  | 'unknown_company'
  | 'not_trading'
  | 'halted'
  | 'market_unavailable'
  | 'insufficient_cash'
  | 'insufficient_shares'
  | 'no_liquidity'
  | 'limit_not_met'
  | 'not_allowed'
  | 'rate_limited'
  | 'too_large'
  /** More open limit orders than the limit (limitOrders.ts). */
  | 'too_many_orders'
  | 'leverage_too_high'
  /** The player is long in a company and asks to short it (or the other way round). */
  | 'position_conflict'
  /** A stop-loss or take-profit price on the wrong side of the market price, or beyond the price the position is closed at anyway. */
  | 'bad_exit';

/**
 * The most shares one order may ask for at this price (cents). The value of an order (price × shares, plus the book's higher
 * levels and the trader's share of a price push) must stay a safe whole number of cents; a factor of 4 leaves room for all of that.
 */
export function maxOrderShares(priceCents: number): number {
  return Math.min(MAX_ORDER_SHARES, Math.max(1, Math.floor(Number.MAX_SAFE_INTEGER / (4 * Math.max(1, priceCents)))));
}

export class OrderError extends Error {
  constructor(
    readonly code: OrderErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
    readonly status = 400,
  ) {
    super(message);
  }
}

export interface AccountRow {
  id: number;
  user_id: number;
  kind: 'career' | 'match';
  match_id: number | null;
  cash_cents: number;
  start_cash_cents: number;
}

export interface PositionView {
  readonly companyId: number;
  readonly ticker: string;
  /** Shares held (a long position) or shares owed (a short position). */
  readonly shares: number;
  /** True for a short position: shares sold without owning them, to be bought back later (see leverage.ts). */
  readonly short: boolean;
  /** The cash of his own the player put into the position (cents): the margin of a leveraged or short position, all of the price of a plain long. */
  readonly costCents: number;
  /** The average price per share: what the shares cost (long, own cash plus borrowed part) or what they were sold for (short). */
  readonly avgCostCents: number;
  readonly bid: number;
  readonly ask: number;
  /** The price the position is valued at: the bid for a long in Career (what it could be sold for), the ask for a short in Career (what it costs to buy back), the market price in a match. */
  readonly markCents: number;
  /** What the shares are worth at the mark price (a short: what buying them back would cost), before any debt. */
  readonly valueCents: number;
  /** What the position owes (0 unless it was bought with leverage; a short owes shares, not money, so it is 0 too). */
  readonly debtCents: number;
  /** A short: the money from the sale, held on the position until the shares are bought back (0 for a long). */
  readonly creditCents: number;
  /** What counts towards net worth: a long's value minus its debt; a short's credit plus margin minus the cost of buying back; never below 0. */
  readonly equityCents: number;
  /** How much the position was levered when it was opened, on average: (own cash + borrowed or sold) / own cash. 1 = no leverage. */
  readonly leverage: number;
  /** The market price (cents) at which the market closes the position and the cash put in is lost: at or below it for a long with debt, at or above it for a short. 0 for a plain long. */
  readonly liqPrice: number;
  /** The stop-loss and take-profit prices the player set (cents; 0 = not set). */
  readonly stopCents: number;
  readonly takeCents: number;
  /** Equity minus the cash put in. */
  readonly unrealizedCents: number;
  /** What borrowing costs: the yearly rate in basis points (interest on a loan, a borrow fee on a short; 0 for a plain long or in a match), what that comes to per day now, and what has been charged so far. */
  readonly rateBps: number;
  readonly costDayCents: number;
  readonly chargedCents: number;
  /** True for shares of a coin whose developer took the money out of its pool (a rug pull): they are worth nothing and cannot be sold. */
  readonly dead: boolean;
}

export interface AccountView {
  readonly id: number;
  readonly kind: 'career' | 'match';
  /** Cash that is free to use (cash set aside for open limit orders is not in it). */
  readonly cashCents: number;
  /** Cash set aside for open limit orders (they take it back when they fill, are cancelled or expire); it counts in net worth. */
  readonly reservedCents: number;
  readonly startCashCents: number;
  readonly positions: PositionView[];
  /** Cash + shares valued at the current bid (what the best buyer pays). */
  readonly netWorthCents: number;
  /** What shares are valued at: 'bid' for Career (what they could be sold for), 'mid' for a match (the published price). */
  readonly valuation: 'bid' | 'mid';
  readonly profitCents: number;
  readonly realizedCents: number;
  readonly tick: number;
}

export interface TradeView {
  readonly id: number;
  readonly clientOrderId: string;
  readonly ticker: string;
  readonly side: Side;
  readonly requested: number;
  readonly filled: number;
  readonly totalCents: number;
  readonly avgPrice: number;
  readonly midCents: number;
  readonly spreadCostCents: number;
  readonly impactCostCents: number;
  readonly realizedCents: number;
  readonly tick: number;
  readonly createdMs: number;
  readonly note: '' | 'depth' | 'limit';
  readonly parts: FillPart[];
  /** The leverage of a buy (1 to 50); sells, liquidations and trades from before leverage say 1. */
  readonly leverage: number;
  /** The debt this trade took on (a buy) or repaid (a sell or a liquidation). `totalCents` is the value of the shares; the cash that moved is that minus this. */
  readonly debtCents: number;
  /** True when the market closed the position by itself because the margin was gone. */
  readonly liquidated: boolean;
  /** True for a trade in a short position: selling to open or add to it, buying to cover it (or the market covering it). */
  readonly short: boolean;
  /** 'stop' or 'take' when the market made this trade by itself because the position's stop-loss or take-profit price was reached. */
  readonly auto: '' | 'stop' | 'take';
  /** The trading fee this order paid (cents; memecoin orders in Career only, see fees.ts). Opening pays it on top of the margin, closing out of what comes back; `realizedCents` already has it taken out. */
  readonly feeCents: number;
  /** True when the sale was filled only in part because the money pool behind the coin could not pay for all of it (pools.ts). */
  readonly poolLimited: boolean;
}

export interface OrderRequest {
  readonly accountId: number;
  readonly clientOrderId: string;
  readonly companyId: number;
  readonly side: Side;
  readonly qty: number;
  /** Optional protection: a buy is not filled above this price, a sell not below it (cents per share). */
  readonly limitPrice?: number;
  /**
   * Leverage of an order that OPENS a position, a whole number from 1 to 50 (default 1: no leverage). Ignored by an order that closes one.
   * A buy opens a long position, a sell opens a short one (when `short` is set).
   */
  readonly leverage?: number;
  /**
   * The order is about the player's SHORT position in this company: a sell opens (or adds to) it, a buy covers (buys back) part or all
   * of it. Without it a buy opens a long position and a sell closes one.
   */
  readonly short?: boolean;
  /** Stop-loss and take-profit prices (cents) for the position this order opens or adds to. Only an order that opens a position may set them. */
  readonly stopPrice?: number;
  readonly takePrice?: number;
  /** Set only by the market itself, for a trade it makes because a stop-loss or take-profit price was reached. */
  readonly auto?: 'stop' | 'take';
}

/** What an order would do right now (trading.estimate). `netCents` is the cash that leaves (opening) or arrives (closing) the account. */
export type Estimate = Execution & {
  mid: number;
  tick: number;
  bid: number;
  ask: number;
  maxQty: number;
  flow: FlowPreview;
  leverage: number;
  /** A long: the debt taken on (opening) or repaid (closing). */
  debtCents: number;
  /** A short: the money from the sale that is held on the position (opening a short). */
  creditCents: number;
  /** The cash that leaves the account (opening: the margin plus the fee) or arrives in it (closing: what comes back minus the fee). */
  netCents: number;
  /** The trading fee of this order (cents; 0 for stocks and in a 1v1 match) and the rate it comes from (basis points of the order's value). */
  feeCents: number;
  feeBps: number;
  /** The price at which the market would close the position (opening: the whole position after this order). */
  liqPrice: number;
  maxLeverage: number;
  short: boolean;
  /** What the borrowing of this order (and of the position it adds to) costs: the yearly rate in basis points and what it comes to per day. 0 when nothing is borrowed. */
  rateBps: number;
  costDayCents: number;
  /** The cash in the money pool behind the coin (cents), or null when the company has no pool; and whether a sale is cut down to what the pool can pay. */
  poolCents: number | null;
  poolLimited: boolean;
};

export interface OrderOutcome {
  readonly duplicate: boolean;
  readonly trade: TradeView;
  readonly account: AccountView;
}

/** Lets other systems (the 1v1 lobby) say whether an account may trade right now. Return a message to refuse. */
export type TradeGate = (account: AccountRow, tick: number) => string | null;
/** A second rule, about the company: the sentence that explains why this account may not trade it, or null. */
export type CompanyRule = (account: AccountRow, companyId: number) => string | null;

interface StoredTrade {
  id: number;
  client_order_id: string;
  company_id: number;
  side: Side;
  requested: number;
  filled: number;
  total_cents: number;
  mid_cents: number;
  spread_cents: number;
  impact_cents: number;
  realized_cents: number;
  tick: number;
  created_ms: number;
  result_json: string;
  leverage: number;
  debt_cents: number;
  forced: number;
  short: number;
  auto: '' | 'stop' | 'take';
  fee_cents: number;
}

interface PositionRow {
  shares: number;
  cost_cents: number;
  debt_cents: number;
  short: number;
  credit_cents: number;
  stop_cents: number;
  take_cents: number;
  charged_cents: number;
}

const POSITION_COLUMNS = 'shares, cost_cents, debt_cents, short, credit_cents, stop_cents, take_cents, charged_cents';

export class Trading {
  private gate: TradeGate | null = null;
  private companyRule: CompanyRule | null = null;
  private halts: Halts | null = null;
  private flow: FlowService | null = null;
  private costs: MarginCosts | null = null;
  private leverageListener: (() => void) | null = null;

  constructor(
    private readonly db: Db,
    private readonly world: WorldRuntime,
    private readonly now: () => number,
    /** The memecoin fee in basis points of an order's value. The game always uses MEME_FEE_BPS; tests may pass another rate (0 = no fee). */
    private readonly memeFeeBps: number = MEME_FEE_BPS,
  ) {
    if (!Number.isSafeInteger(memeFeeBps) || memeFeeBps < 0 || memeFeeBps > 10_000) throw new Error('The memecoin fee must be a whole number of basis points from 0 to 10000.');
  }

  /** The fee rate (basis points) an order pays: memecoins in Career only; stocks and every 1v1 match order pay none. */
  private feeBpsFor(companyId: number, kind: 'career' | 'match' | undefined): number {
    return kind !== 'match' && this.world.companies[companyId]?.sector === 'meme' ? this.memeFeeBps : 0;
  }

  setCompanyRule(rule: CompanyRule | null): void {
    this.companyRule = rule;
  }

  setGate(gate: TradeGate | null): void {
    this.gate = gate;
  }

  /** Lets the owner stop trading in a company (see halts.ts). */
  setHalts(halts: Halts | null): void {
    this.halts = halts;
  }

  /** Lets Career trades move prices (see flow.ts). Without it, trades never change a price. */
  setFlow(flow: FlowService | null): void {
    this.flow = flow;
  }

  /** Called whenever positions with debt may have changed, so the liquidator knows to look again (see liquidation.ts). */
  /** The charging of interest and borrow fees (margin.ts): a position is charged up to now before an order changes it. */
  setMarginCosts(costs: MarginCosts | null): void {
    this.costs = costs;
  }

  setLeverageListener(listener: (() => void) | null): void {
    this.leverageListener = listener;
  }

  /** Tells the liquidator that a position's shares or debt were changed from outside (the owner's tools). */
  leverageChanged(): void {
    this.leverageListener?.();
  }

  // ---- accounts ----------------------------------------------------------------------------------------------------

  account(id: number): AccountRow | undefined {
    return this.db.get<AccountRow>('SELECT id, user_id, kind, match_id, cash_cents, start_cash_cents FROM accounts WHERE id = ?', id);
  }

  careerAccountOf(userId: number): AccountRow {
    const row = this.db.get<AccountRow>("SELECT id, user_id, kind, match_id, cash_cents, start_cash_cents FROM accounts WHERE user_id = ? AND kind = 'career'", userId);
    if (!row) throw new Error(`User ${userId} has no Career account`);
    return row;
  }

  /** Creates a fresh one-off account for a 1v1 match. */
  createMatchAccount(userId: number, matchId: number, cashCents: number): AccountRow {
    const nowMs = this.now();
    const r = this.db.run("INSERT INTO accounts(user_id, kind, match_id, cash_cents, start_cash_cents, created_ms) VALUES (?, 'match', ?, ?, ?, ?)", userId, matchId, cashCents, cashCents, nowMs);
    return this.account(r.lastInsertRowid) as AccountRow;
  }

  view(accountId: number): AccountView {
    const acc = this.account(accountId);
    if (!acc) throw new Error(`No account ${accountId}`);
    const rows = this.db.all<PositionRow & { company_id: number }>(`SELECT company_id, ${POSITION_COLUMNS} FROM positions WHERE account_id = ? ORDER BY company_id`, accountId);
    let holdings = 0;
    // Shares of a coin whose developer took the money out of its pool are worth nothing (pools.ts).
    const deadIds = rows.length > 0 ? deadCompanyIds(this.db) : new Set<number>();
    const positions: PositionView[] = rows.map((p) => {
      const company = this.world.companies[p.company_id];
      const listed = company !== undefined && this.world.sim.isListed(p.company_id);
      const quote = listed ? this.world.quote(p.company_id) : null;
      const bid = quote?.bid ?? 0;
      const ask = quote?.ask ?? 0;
      const short = p.short === 1;
      // Career values a long position at the price it could be sold for (the bid) and a short at the price it costs to buy back (the ask).
      // A 1v1 match scores both players on the one published market price (the mid), so the final scoreboard equals the price on everybody's chart.
      // A coin the owner has just made is held from the moment it is saved but trades a few seconds later: until then it is worth what it
      // started at (a Career position in a company that is not trading yet), so the owner's net worth does not dip while it waits to list.
      const dead = acc.kind === 'career' && deadIds.has(p.company_id);
      const mark = dead ? 0 : acc.kind === 'match' ? (listed ? this.world.sim.price(p.company_id) : 0) : !listed ? (company?.basePriceCents ?? 0) : short ? ask : bid;
      const value = mark * p.shares;
      // What counts is what is left after the debt is repaid / the shares are bought back (never below 0: a player can lose his margin, not more).
      const equity = equityOf({ shares: p.shares, costCents: p.cost_cents, debtCents: p.debt_cents, short, creditCents: p.credit_cents }, mark);
      holdings += equity;
      return {
        companyId: p.company_id,
        ticker: company?.ticker ?? '?',
        shares: p.shares,
        short,
        costCents: p.cost_cents,
        avgCostCents: Math.round((short ? p.credit_cents : p.cost_cents + p.debt_cents) / p.shares), // a long: all it cost (own cash plus borrowed part); a short: what it was sold for
        bid,
        ask,
        markCents: mark,
        valueCents: value,
        debtCents: p.debt_cents,
        creditCents: p.credit_cents,
        equityCents: equity,
        leverage: p.cost_cents > 0 ? Math.round((((short ? p.credit_cents : p.cost_cents + p.debt_cents)) / p.cost_cents) * 10) / 10 : 1,
        liqPrice: short ? shortLiquidationPrice(p.shares, collateralOf(p.credit_cents, p.cost_cents)) : liquidationPrice(p.shares, p.debt_cents),
        stopCents: p.stop_cents,
        takeCents: p.take_cents,
        unrealizedCents: equity - p.cost_cents,
        ...this.costView(acc.kind, company, p),
        dead,
      };
    });
    const realized = this.db.get<{ s: number | null }>('SELECT SUM(realized_cents) AS s FROM trades WHERE account_id = ? AND id > ?', accountId, this.resetMark(accountId))?.s ?? 0;
    // Cash that open limit orders have set aside (limitOrders.ts) is still the player's: it counts in net worth.
    const reserved = this.db.get<{ s: number | null }>("SELECT SUM(reserved_cents) AS s FROM limit_orders WHERE account_id = ? AND state = 'open'", accountId)?.s ?? 0;
    const net = acc.cash_cents + holdings + reserved;
    return {
      id: acc.id,
      kind: acc.kind,
      cashCents: acc.cash_cents,
      reservedCents: reserved,
      startCashCents: acc.start_cash_cents,
      positions,
      netWorthCents: net,
      valuation: acc.kind === 'match' ? 'mid' : 'bid',
      profitCents: net - acc.start_cash_cents,
      realizedCents: realized,
      tick: this.world.sim.tick,
    };
  }

  /** The cost of borrowing of one position, for the account page: nothing for a match account or a plain long. */
  private costView(kind: 'career' | 'match', company: Company | undefined, p: PositionRow): { rateBps: number; costDayCents: number; chargedCents: number } {
    if (kind !== 'career' || !company) return { rateBps: 0, costDayCents: 0, chargedCents: p.charged_cents };
    if (p.short === 1) {
      const bps = borrowBps(company);
      return { rateBps: bps, costDayCents: costPerDay(p.credit_cents, bps), chargedCents: p.charged_cents };
    }
    if (p.debt_cents <= 0) return { rateBps: 0, costDayCents: 0, chargedCents: p.charged_cents };
    const bps = interestBps(company);
    return { rateBps: bps, costDayCents: costPerDay(p.debt_cents, bps), chargedCents: p.charged_cents };
  }

  trades(accountId: number, limit = 50, beforeId?: number): TradeView[] {
    const lim = Math.max(1, Math.min(200, limit));
    const mark = this.resetMark(accountId);
    const rows =
      beforeId === undefined
        ? this.db.all<StoredTrade>('SELECT * FROM trades WHERE account_id = ? AND id > ? ORDER BY id DESC LIMIT ?', accountId, mark, lim)
        : this.db.all<StoredTrade>('SELECT * FROM trades WHERE account_id = ? AND id > ? AND id < ? ORDER BY id DESC LIMIT ?', accountId, mark, beforeId, lim);
    return rows.map((r) => this.tradeView(r));
  }

  /** Trades with an id up to this one are from before the owner reset the account: they no longer count (0 = never reset). */
  private resetMark(accountId: number): number {
    return this.db.get<{ m: number }>('SELECT reset_trade_id AS m FROM accounts WHERE id = ?', accountId)?.m ?? 0;
  }

  private tradeView(r: StoredTrade): TradeView {
    const stored = JSON.parse(r.result_json) as { note: '' | 'depth' | 'limit'; parts: FillPart[]; poolLimited?: boolean };
    return {
      id: r.id,
      clientOrderId: r.client_order_id,
      ticker: this.world.companies[r.company_id]?.ticker ?? '?',
      side: r.side,
      requested: r.requested,
      filled: r.filled,
      totalCents: r.total_cents,
      avgPrice: r.filled > 0 ? r.total_cents / r.filled : 0,
      midCents: r.mid_cents,
      spreadCostCents: r.spread_cents,
      impactCostCents: r.impact_cents,
      realizedCents: r.realized_cents,
      tick: r.tick,
      createdMs: r.created_ms,
      note: stored.note,
      parts: stored.parts,
      leverage: r.leverage,
      debtCents: r.debt_cents,
      liquidated: r.forced === 1,
      short: r.short === 1,
      auto: r.auto,
      feeCents: r.fee_cents,
      poolLimited: stored.poolLimited === true,
    };
  }

  // ---- estimates ---------------------------------------------------------------------------------------------------

  private positionOf(accountId: number, companyId: number): PositionRow | null {
    return this.db.get<PositionRow>(`SELECT ${POSITION_COLUMNS} FROM positions WHERE account_id = ? AND company_id = ?`, accountId, companyId) ?? null;
  }

  /** A player is long or short in a company, never both: an order that opens the other kind is refused with a sentence that says what to do. */
  private checkNoConflict(held: PositionRow | null, short: boolean, ticker: string): void {
    if (!held) return;
    if (!short && held.short === 1) throw new OrderError('position_conflict', `You are short ${held.shares.toLocaleString('en-US')} shares of ${ticker}. Cover (buy back) the short before you buy shares. Nothing was bought.`);
    if (short && held.short === 0) throw new OrderError('position_conflict', `You hold ${held.shares.toLocaleString('en-US')} shares of ${ticker}. Sell them before you short it. Nothing was sold.`);
  }

  /** What an order would get right now for this account, without doing anything. */
  estimate(
    accountId: number | null,
    companyId: number,
    side: Side,
    qty: number,
    limitPrice?: number,
    leverage = 1,
    short = false,
  ): Estimate {
    this.checkMarket(companyId);
    this.checkQty(qty);
    this.checkOrderSize(qty, companyId);
    // A buy opens a long position and a sell opens a short one (with `short`); the other side of each closes it.
    const opening = side === (short ? 'sell' : 'buy');
    const lev = opening ? this.checkLeverage(leverage) : 1;
    const tick = this.world.sim.tick;
    const quote = this.world.quote(companyId);
    const levels = this.world.book(companyId, side);
    const acc = accountId === null ? undefined : this.account(accountId);
    const refused = acc && this.companyRule ? this.companyRule(acc, companyId) : null;
    if (refused) throw new OrderError('not_allowed', refused, {}, 403);
    const ticker = this.world.companies[companyId]?.ticker ?? '?';
    const pool = this.poolFor(companyId, acc?.kind);
    this.checkPool(pool, ticker, { short, leverage: lev, exits: false });
    // Visitors who are not signed in see what a Career order would do. A 1v1 match order never moves the price.
    const moves = acc === undefined || acc.kind === 'career';
    const feeBps = this.feeBpsFor(companyId, acc?.kind);
    const consumed = accountId === null ? 0 : this.consumedNow(accountId, companyId, side, tick);
    const raw = executeMarket(levels, side, qty, consumed, { limitPrice, mid: quote.mid });
    const priced0 = this.priced(companyId, levels, side, raw, quote.mid, tick, moves);
    // A sale of a pool coin is paid from the pool: it fills only as far as the pool can pay.
    const capped = pool && !opening ? this.capToPool(pool, ticker, companyId, levels, qty, consumed, quote.mid, tick, moves, limitPrice, priced0) : { ...priced0, limited: false };
    const { exec, flow } = capped;
    const held = acc ? this.positionOf(acc.id, companyId) : null;
    if (opening) this.checkNoConflict(held, short, this.world.companies[companyId]?.ticker ?? '?');
    // The position this order acts on: a long one for a plain buy/sell, a short one for a short/cover.
    const mine = held && (held.short === 1) === short ? held : null;
    let maxQty = 0;
    if (acc) {
      if (!opening) {
        maxQty = mine?.shares ?? 0;
        if (pool) maxQty = this.poolSellLimit(companyId, levels, maxQty, consumed, quote.mid, tick, moves, limitPrice, pool.pool_cents);
      } else if (short) maxQty = this.affordableShortQty(companyId, levels, consumed, acc.cash_cents, quote.mid, tick, moves, lev, feeBps);
      else maxQty = this.affordableQty(companyId, levels, consumed, acc.cash_cents, quote.mid, tick, moves, lev, feeBps);
    }
    // What really moves in cash: opening pays only the margin (the value divided by the leverage); closing a long pays back the debt that
    // goes with the shares and keeps the rest; covering a short gets back what is left of the collateral that goes with those shares.
    let debtCents = 0;
    let creditCents = 0;
    let netCents: number;
    let liqPrice = 0;
    let maxLeverage = 1;
    // The trading fee (fees.ts): opening pays it on top of the margin, closing pays it out of what comes back, and never more than that.
    const orderFee = feeOf(exec.totalCents, feeBps);
    let feeCents = orderFee;
    if (opening && !short) {
      const margin = marginOf(exec.totalCents, lev);
      netCents = margin + orderFee;
      debtCents = exec.totalCents - margin;
      const heldNow = mine ? { shares: mine.shares, debtCents: mine.debt_cents } : null;
      liqPrice = liquidationPrice((heldNow?.shares ?? 0) + exec.filledQty, (heldNow?.debtCents ?? 0) + debtCents);
      maxLeverage = exec.filledQty > 0 ? maxLeverageFor(exec.totalCents, exec.filledQty, quote.mid, heldNow) : 1;
    } else if (opening) {
      const margin = marginOf(exec.totalCents, lev);
      netCents = margin + orderFee;
      creditCents = exec.totalCents;
      const heldNow = mine ? { shares: mine.shares, collateralCents: collateralOf(mine.credit_cents, mine.cost_cents) } : null;
      liqPrice = shortLiquidationPrice((heldNow?.shares ?? 0) + exec.filledQty, (heldNow?.collateralCents ?? 0) + exec.totalCents + margin);
      maxLeverage = exec.filledQty > 0 ? maxShortLeverageFor(exec.totalCents, exec.filledQty, quote.mid, heldNow) : 1;
    } else if (short) {
      const collateral = mine ? debtShare(collateralOf(mine.credit_cents, mine.cost_cents), exec.filledQty, mine.shares) : 0;
      const back = Math.max(0, collateral - exec.totalCents);
      feeCents = Math.min(orderFee, back);
      netCents = back - feeCents;
    } else {
      debtCents = mine ? debtShare(mine.debt_cents, exec.filledQty, mine.shares) : 0;
      const back = Math.max(0, exec.totalCents - debtCents);
      feeCents = Math.min(orderFee, back);
      netCents = back - feeCents;
    }
    // The cost of borrowing: a loan on a leveraged long, a borrowed sale on a short, in Career only (a match has none).
    let rateBps = 0;
    let costDayCents = 0;
    const company = this.world.companies[companyId];
    if (company && moves && opening) {
      if (!short && debtCents > 0) {
        rateBps = interestBps(company);
        costDayCents = costPerDay((mine?.debt_cents ?? 0) + debtCents, rateBps);
      } else if (short) {
        rateBps = borrowBps(company);
        costDayCents = costPerDay((mine?.credit_cents ?? 0) + creditCents, rateBps);
      }
    }
    return { ...exec, mid: quote.mid, tick, bid: quote.bid, ask: quote.ask, maxQty, flow, leverage: lev, debtCents, creditCents, netCents, feeCents, feeBps, liqPrice, maxLeverage, short, rateBps, costDayCents, poolCents: pool ? pool.pool_cents : null, poolLimited: capped.limited };
  }

  /** A leverage that is not a whole number from 1 to 50 is a mistake in the request, not something to round. */
  private checkLeverage(leverage: unknown): number {
    if (leverage === undefined) return 1;
    if (!isLeverage(leverage)) throw new OrderError('bad_request', `The leverage must be a whole number from 1 to ${MAX_LEVERAGE}.`);
    return leverage;
  }

  /** The order as it really fills: the book's prices plus the trader's share of the price push (flow.ts). */
  private priced(companyId: number, levels: readonly Level[], side: Side, raw: Execution, mid: number, tick: number, moves: boolean): { exec: Execution; flow: FlowPreview } {
    const company = this.world.companies[companyId] as Company;
    const flow = moves && this.flow ? this.flow.preview(company, side, raw.filledQty, tick) : NO_FLOW;
    return { exec: applyMarkup(raw, side, mid, levels[0]?.price ?? 0, flow.paid), flow };
  }

  /** The most shares this cash buys at this leverage (own cash needed = the order's value divided by it), counting the trader's share of the price push. */
  private affordableQty(companyId: number, levels: readonly Level[], consumed: number, cash: number, mid: number, tick: number, moves: boolean, leverage = 1, feeBps = 0): number {
    // The book's prices alone: the real answer can only be lower. With leverage the cash covers `leverage` times as much value.
    let hi = maxAffordable(levels, consumed, Math.min(cash * leverage, Number.MAX_SAFE_INTEGER)).qty;
    if (hi === 0 || (leverage === 1 && feeBps === 0 && (!moves || !this.flow))) return hi;
    // What leaves the cash: the margin, plus the trading fee when the coin has one.
    const costOf = (q: number): number => {
      const total = this.priced(companyId, levels, 'buy', executeMarket(levels, 'buy', q, consumed, { mid }), mid, tick, moves).exec.totalCents;
      return marginOf(total, leverage) + feeOf(total, feeBps);
    };
    let lo = 0;
    while (lo < hi) {
      const m = Math.ceil((lo + hi) / 2);
      if (costOf(m) <= cash) lo = m;
      else hi = m - 1;
    }
    return lo;
  }

  /** The most shares this cash lets the player short at this leverage (own cash needed = the sale's value divided by it), counting the trader's share of the price push. */
  private affordableShortQty(companyId: number, levels: readonly Level[], consumed: number, cash: number, mid: number, tick: number, moves: boolean, leverage = 1, feeBps = 0): number {
    const most = Math.min(maxOrderShares(mid), executeMarket(levels, 'sell', MAX_ORDER_SHARES, consumed, { mid }).filledQty);
    if (most === 0) return 0;
    const marginOfQty = (q: number): number => {
      const total = this.priced(companyId, levels, 'sell', executeMarket(levels, 'sell', q, consumed, { mid }), mid, tick, moves).exec.totalCents;
      return marginOf(total, leverage) + feeOf(total, feeBps);
    };
    let lo = 0;
    let hi = most;
    while (lo < hi) {
      const m = Math.ceil((lo + hi) / 2);
      if (marginOfQty(m) <= cash) lo = m;
      else hi = m - 1;
    }
    return lo;
  }

  private consumedNow(accountId: number, companyId: number, side: Side, tick: number): number {
    const row = this.db.get<{ consumed: number; tick: number }>('SELECT consumed, tick FROM impact_state WHERE account_id = ? AND company_id = ? AND side = ?', accountId, companyId, side);
    return row ? recoverConsumed(row.consumed, tick - row.tick) : 0;
  }

  // ---- the money pool behind a launched coin (pools.ts) ---------------------------------------------------------------

  /** The pool behind a company for this kind of account: only Career orders touch it (a 1v1 match never trades a launched coin). */
  private poolFor(companyId: number, kind: 'career' | 'match' | undefined): PoolRow | null {
    return kind === 'match' ? null : poolOf(this.db, companyId);
  }

  /** A coin with a money pool takes plain buys and sells only; once its pool is taken it takes nothing. */
  private checkPool(pool: PoolRow | null, ticker: string, order: { short: boolean; leverage: number; exits: boolean }): void {
    if (!pool) return;
    if (isDead(pool)) throw new OrderError('not_allowed', deadMessage(ticker), { dead: true }, 403);
    if (order.short || order.leverage > 1 || order.exits) throw new OrderError('not_allowed', `${ticker}: ${POOL_SPOT_ONLY} Nothing was changed.`, { spotOnly: true }, 403);
  }

  /** The most shares (up to `qtyMax`) that a sale can fill with what the pool holds: the biggest quantity whose proceeds are not more than the pool has. */
  private poolSellLimit(companyId: number, levels: readonly Level[], qtyMax: number, consumed: number, mid: number, tick: number, moves: boolean, limitPrice: number | undefined, room: number): number {
    if (qtyMax < 1) return 0;
    const total = (q: number): number => this.priced(companyId, levels, 'sell', executeMarket(levels, 'sell', q, consumed, { limitPrice, mid }), mid, tick, moves).exec.totalCents;
    if (total(qtyMax) <= room) return qtyMax;
    let lo = 0;
    let hi = qtyMax - 1;
    while (lo < hi) {
      const m = Math.ceil((lo + hi) / 2);
      if (total(m) <= room) lo = m;
      else hi = m - 1;
    }
    return lo;
  }

  /**
   * A sale of a pool coin is paid from the pool, so it fills only as far as the pool can pay: when the proceeds are more than the pool holds, the
   * order is cut down to the most shares the pool can pay for. Nothing at all fits: the order is refused with the amount that is left.
   */
  private capToPool(
    pool: PoolRow,
    ticker: string,
    companyId: number,
    levels: readonly Level[],
    qty: number,
    consumed: number,
    mid: number,
    tick: number,
    moves: boolean,
    limitPrice: number | undefined,
    current: { exec: Execution; flow: FlowPreview },
  ): { exec: Execution; flow: FlowPreview; limited: boolean } {
    if (current.exec.totalCents <= pool.pool_cents) return { ...current, limited: false };
    const fit = this.poolSellLimit(companyId, levels, qty, consumed, mid, tick, moves, limitPrice, pool.pool_cents);
    if (fit < 1) {
      throw new OrderError(
        'no_liquidity',
        `The money pool behind ${ticker} holds only ${formatCents(pool.pool_cents)}, which is less than one ${ticker} is worth right now, so nothing could be sold. Sales are paid from the pool; it fills up when other players buy. Nothing was sold.`,
        { poolCents: pool.pool_cents },
      );
    }
    const raw = executeMarket(levels, 'sell', fit, consumed, { limitPrice, mid });
    const cut = this.priced(companyId, levels, 'sell', raw, mid, tick, moves);
    // It is still an order for `qty` shares: the part the pool cannot pay for is what is left unfilled.
    return { exec: { ...cut.exec, requestedQty: qty, unfilledQty: qty - cut.exec.filledQty }, flow: cut.flow, limited: true };
  }

  // ---- orders ------------------------------------------------------------------------------------------------------

  private checkQty(qty: number): void {
    if (!Number.isSafeInteger(qty) || qty < 1) throw new OrderError('bad_request', 'The quantity must be a whole number of shares, at least 1.');
    if (qty > MAX_ORDER_SHARES) throw new OrderError('bad_request', `The most you can order at once is ${MAX_ORDER_SHARES.toLocaleString('en-US')} shares.`);
  }

  /** For a company that is open for trading: is the order small enough for its price? */
  private checkOrderSize(qty: number, companyId: number): void {
    // At a very high price the value of a big order would not fit in a safe whole number of cents; say so instead of failing.
    const most = maxOrderShares(this.world.sim.price(companyId));
    if (qty > most) throw new OrderError('too_large', `At this price the most you can order at once is ${most.toLocaleString('en-US')} shares.`, { maxQty: most });
  }

  private checkMarket(companyId: number): void {
    if (!Number.isInteger(companyId) || !this.world.companies[companyId]) throw new OrderError('unknown_company', 'That company does not exist.', {}, 404);
    const h = this.world.health();
    if (h.stalled !== null || h.lagTicks > MAX_TRADING_LAG_TICKS) {
      throw new OrderError('market_unavailable', 'The market is catching up and cannot take orders for a moment. Nothing was bought or sold.', { lagTicks: h.lagTicks }, 503);
    }
    if (!this.world.sim.isListed(companyId)) throw new OrderError('not_trading', `${this.world.companies[companyId]?.ticker} is not trading yet.`);
    if (this.halts?.isHalted(companyId)) {
      const reason = this.halts.reasonOf(companyId);
      const ticker = this.world.companies[companyId]?.ticker;
      if (this.halts.isHaltedItself(companyId)) {
        throw new OrderError('halted', `Trading in ${ticker} is halted${reason ? `: ${reason}` : ''}. Nothing was bought or sold.`, { reason }, 403);
      }
      if (this.halts.allPaused() !== null) {
        throw new OrderError('halted', `Trading is paused for the whole market${reason ? `: ${reason}` : ''}. Nothing was bought or sold.`, { reason, all: true }, 403);
      }
      // The market paused this company by itself after a big move (server/breaker.ts).
      const auto = this.halts.autoPauseOf(companyId);
      const left = auto ? Math.max(0, auto.untilTick - this.world.sim.tick) : 0;
      throw new OrderError('halted', `Trading in ${ticker} is ${reason}. Nothing was bought or sold.`, { reason, auto: true, reopensInTicks: left, moveBps: auto?.moveBps ?? 0 }, 403);
    }
  }

  /** Stop-loss / take-profit prices given with an order: nothing, or positive whole numbers of cents. Only an order that opens a position may carry them. */
  private checkExitInput(stop: unknown, take: unknown, allowed: boolean): { stop?: number; take?: number } {
    for (const [name, v] of [['stop-loss', stop], ['take-profit', take]] as const) {
      if (v !== undefined && (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1)) throw new OrderError('bad_request', `The ${name} price must be a positive whole number of cents.`);
    }
    if (!allowed && (stop !== undefined || take !== undefined)) {
      throw new OrderError('bad_request', 'A stop-loss or take-profit is set when you open a position, or on a position you already hold. An order that closes one cannot carry them.');
    }
    return { stop: stop as number | undefined, take: take as number | undefined };
  }

  /**
   * The rules for a stop-loss and a take-profit (cents). They are market prices at which the market closes the whole position by itself:
   * a long position is stopped below the price and taken above it, a short position the other way round. A stop on the far side of the
   * price at which the market would close the position anyway (its liquidation price) could never be reached first, so it is refused.
   */
  private checkExits(ticker: string, short: boolean, mid: number, liqPrice: number, stop: number | undefined, take: number | undefined): void {
    const money = (c: number): string => formatCents(c);
    const bad = (message: string): never => {
      throw new OrderError('bad_exit', `${message} Nothing was changed.`, { mid, liqPrice });
    };
    if (stop !== undefined) {
      if (!short && stop >= mid) bad(`The stop-loss of a long position in ${ticker} must be below the market price (${money(mid)}).`);
      if (short && stop <= mid) bad(`The stop-loss of a short position in ${ticker} must be above the market price (${money(mid)}).`);
      if (!short && liqPrice > 0 && stop <= liqPrice) bad(`The market closes this position at ${money(liqPrice)} anyway (the margin is gone), so a stop-loss at or below that price could never fire. Use a price above ${money(liqPrice)}.`);
      if (short && liqPrice > 0 && stop >= liqPrice) bad(`The market closes this short at ${money(liqPrice)} anyway (the margin is gone), so a stop-loss at or above that price could never fire. Use a price below ${money(liqPrice)}.`);
    }
    if (take !== undefined) {
      if (!short && take <= mid) bad(`The take-profit of a long position in ${ticker} must be above the market price (${money(mid)}).`);
      if (short && take >= mid) bad(`The take-profit of a short position in ${ticker} must be below the market price (${money(mid)}).`);
      if (short && take < MIN_PRICE) bad(`A share can never be worth less than ${money(MIN_PRICE)}, so a take-profit below that price could never fire.`);
    }
  }

  /** Executes a market order. Safe to send twice: the same clientOrderId returns the first result. */
  /**
   * The checks on the SHAPE of an order that need no market and no account (an id, a side, a quantity, a price limit, a leverage, exits). Used by
   * placeOrder and by the limit orders (limitOrders.ts), so both refuse the same mistakes with the same sentences.
   */
  shapeOf(req: OrderRequest): { short: boolean; opening: boolean; leverage: number; exits: { stop?: number; take?: number } } {
    if (typeof req.clientOrderId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(req.clientOrderId)) {
      throw new OrderError('bad_request', 'The order needs an id of 8–64 letters, numbers, - or _.');
    }
    if (req.side !== 'buy' && req.side !== 'sell') throw new OrderError('bad_request', 'The side must be buy or sell.');
    if (req.short !== undefined && typeof req.short !== 'boolean') throw new OrderError('bad_request', 'short must be true or false.');
    const short = req.short === true;
    this.checkQty(req.qty);
    if (req.limitPrice !== undefined && (!Number.isSafeInteger(req.limitPrice) || req.limitPrice < 1)) throw new OrderError('bad_request', 'The price limit must be a positive whole number of cents.');
    // A buy opens (or adds to) a long position and a sell closes one; with `short` it is the other way round: a sell opens a short and a
    // buy covers it. Only an order that OPENS can be levered or carry a stop-loss / take-profit.
    const opening = req.side === (short ? 'sell' : 'buy');
    const leverage = opening ? this.checkLeverage(req.leverage) : 1;
    const exits = this.checkExitInput(req.stopPrice, req.takePrice, opening);
    return { short, opening, leverage, exits };
  }

  /** What the limit orders (limitOrders.ts) need to know about the way Trading works. */
  feeRateFor(companyId: number, kind: 'career' | 'match'): number {
    return this.feeBpsFor(companyId, kind);
  }

  /** The shares an account holds in a company and which side they are on, or null. */
  holding(accountId: number, companyId: number): { shares: number; short: boolean } | null {
    const p = this.positionOf(accountId, companyId);
    return p ? { shares: p.shares, short: p.short === 1 } : null;
  }

  /** The checks placeOrder makes before it looks at the book, for an order that is only being placed: the company exists and is open, the size fits, this account may trade it, and an opening order does not clash with the other side. */
  checkMayPlace(acc: AccountRow, companyId: number, qty: number, opening: boolean, short: boolean): void {
    this.checkMarket(companyId);
    this.checkOrderSize(qty, companyId);
    const tick = this.world.sim.tick;
    const blocked = this.gate ? this.gate(acc, tick) : null;
    if (blocked) throw new OrderError('not_allowed', blocked, {}, 403);
    const refused = this.companyRule ? this.companyRule(acc, companyId) : null;
    if (refused) throw new OrderError('not_allowed', refused, {}, 403);
    // A coin with a money pool takes market orders only (pools.ts): a limit order would sit and wait while its developer can empty the pool.
    const ticker = this.world.companies[companyId]?.ticker ?? '?';
    const pool = this.poolFor(companyId, acc.kind);
    this.checkPool(pool, ticker, { short, leverage: 1, exits: false });
    if (pool) throw new OrderError('not_allowed', `${ticker}: ${POOL_SPOT_ONLY} Nothing was placed.`, { spotOnly: true }, 403);
    if (opening) this.checkNoConflict(this.positionOf(acc.id, companyId), short, ticker);
  }

  /** Throws (an OrderError) unless the company is open for trading right now (listed, not halted or paused, the market live) and this account may trade. For the rug pull of a pool coin (launch.ts). */
  checkOpenFor(acc: AccountRow, companyId: number): void {
    this.checkMarket(companyId);
    const blocked = this.gate ? this.gate(acc, this.world.sim.tick) : null;
    if (blocked) throw new OrderError('not_allowed', blocked, {}, 403);
  }

  /** The cash that has to be set aside for an order that opens a position at its price limit: the margin and the fee on the most it can cost. */
  openingReserve(companyId: number, kind: 'career' | 'match', qty: number, limitCents: number, leverage: number): number {
    const total = qty * limitCents;
    if (!Number.isSafeInteger(total)) throw new OrderError('too_large', 'That order is too big for its price.');
    return marginOf(total, leverage) + feeOf(total, this.feeBpsFor(companyId, kind));
  }

  placeOrder(req: OrderRequest): OrderOutcome {
    const { short, opening, leverage, exits } = this.shapeOf(req);
    const auto = req.auto ?? '';

    // The price push of a Career trade is a stored event; it is handed to the world only after the transaction has committed.
    const pushed: { event: WorldEvent | null } = { event: null };
    const outcome = this.db.tx(() => {
      const acc = this.account(req.accountId);
      if (!acc) throw new OrderError('bad_request', 'Unknown account.', {}, 404);

      // A repeated request returns the first result and changes nothing.
      const existing = this.db.get<StoredTrade>('SELECT * FROM trades WHERE account_id = ? AND client_order_id = ?', acc.id, req.clientOrderId);
      if (existing) return { duplicate: true, trade: this.tradeView(existing), account: this.view(acc.id) };

      this.checkMarket(req.companyId);
      this.checkOrderSize(req.qty, req.companyId);
      const tick = this.world.sim.tick;
      const blocked = this.gate ? this.gate(acc, tick) : null;
      if (blocked) throw new OrderError('not_allowed', blocked, {}, 403);
      const refused = this.companyRule ? this.companyRule(acc, req.companyId) : null;
      if (refused) throw new OrderError('not_allowed', refused, {}, 403);

      const company = this.world.companies[req.companyId];
      if (!company) throw new OrderError('unknown_company', 'That company does not exist.', {}, 404);
      // A coin with a money pool takes plain market buys and sells only, and nothing once its pool was taken (pools.ts).
      const pool = this.poolFor(req.companyId, acc.kind);
      this.checkPool(pool, company.ticker, { short, leverage, exits: exits.stop !== undefined || exits.take !== undefined });
      // A position that borrows is charged up to this moment before the order changes it (margin.ts).
      if (acc.kind === 'career') this.costs?.settle(acc.id, req.companyId, tick);
      const quote = this.world.quote(req.companyId);
      const levels = this.world.book(req.companyId, req.side);
      const consumed = this.consumedNow(acc.id, req.companyId, req.side, tick);
      const feeBps = this.feeBpsFor(req.companyId, acc.kind);
      const position = this.positionOf(acc.id, req.companyId);
      if (opening) this.checkNoConflict(position, short, company.ticker);
      // The position this order acts on: a long one for a plain buy/sell, a short one for a short/cover.
      const mine = position && (position.short === 1) === short ? position : null;

      if (!opening && (mine?.shares ?? 0) < req.qty) {
        const have = mine?.shares ?? 0;
        const hint = !mine && position ? (position.short === 1 ? ' You are short it: use Cover to buy the shares back.' : ' You hold shares of it: use Sell to sell them.') : '';
        throw new OrderError('insufficient_shares', `${short ? `You are short ${have} shares of ${company.ticker}` : `You hold ${have} shares of ${company.ticker}`}, not ${req.qty}.${hint}`, { held: have });
      }

      const raw = executeMarket(levels, req.side, req.qty, consumed, { limitPrice: req.limitPrice, mid: quote.mid });
      const priced0 = this.priced(req.companyId, levels, req.side, raw, quote.mid, tick, acc.kind === 'career');
      // A sale of a pool coin is paid from the pool: it fills only as far as the pool can pay (the rest of the order is not filled, like a thin book).
      const capped = pool && !opening ? this.capToPool(pool, company.ticker, req.companyId, levels, req.qty, consumed, quote.mid, tick, acc.kind === 'career', req.limitPrice, priced0) : { ...priced0, limited: false };
      const { exec, flow } = capped;
      if (exec.filledQty > 0 && req.limitPrice !== undefined && flow.paid > 0 && exec.parts.some((p) => (req.side === 'buy' ? p.price > (req.limitPrice as number) : p.price < (req.limitPrice as number)))) {
        throw new OrderError('limit_not_met', 'After the price impact of this order, the price would be beyond your price limit, so nothing was traded.', { bid: quote.bid, ask: quote.ask });
      }
      if (exec.filledQty === 0) {
        if (exec.note === 'limit') throw new OrderError('limit_not_met', 'The market price is beyond your price limit, so nothing was traded.', { bid: quote.bid, ask: quote.ask });
        throw new OrderError('no_liquidity', 'There are no shares available at any price on the book right now. Try again in a moment.');
      }

      let realized = 0;
      let debt = 0; // a long: the debt this order takes on (a buy) or repays (a sell)
      // The trading fee (fees.ts). `orderFee` is what the rate asks for; `fee` is what this order really pays (closing never pays more than comes back).
      const orderFee = feeOf(exec.totalCents, feeBps);
      let fee = orderFee;
      const upsert = (shares: number, cost: number, debtAdd: number, credit: number): void => {
        if (mine) this.db.run('UPDATE positions SET shares = shares + ?, cost_cents = cost_cents + ?, debt_cents = debt_cents + ?, credit_cents = credit_cents + ? WHERE account_id = ? AND company_id = ?', shares, cost, debtAdd, credit, acc.id, req.companyId);
        else this.db.run('INSERT INTO positions(account_id, company_id, shares, cost_cents, debt_cents, short, credit_cents) VALUES (?, ?, ?, ?, ?, ?, ?)', acc.id, req.companyId, shares, cost, debtAdd, short ? 1 : 0, credit);
      };
      const setExits = (liq: number): void => {
        if (exits.stop === undefined && exits.take === undefined) return;
        this.checkExits(company.ticker, short, quote.mid, liq, exits.stop, exits.take);
        if (exits.stop !== undefined) this.db.run('UPDATE positions SET stop_cents = ? WHERE account_id = ? AND company_id = ?', exits.stop, acc.id, req.companyId);
        if (exits.take !== undefined) this.db.run('UPDATE positions SET take_cents = ? WHERE account_id = ? AND company_id = ?', exits.take, acc.id, req.companyId);
      };

      if (opening && !short) {
        // Own cash needed: the value of the shares divided by the leverage (all of it at 1x). The rest becomes a debt on the position.
        const margin = marginOf(exec.totalCents, leverage);
        debt = exec.totalCents - margin;
        // The fee is paid on top of the margin, out of the player's cash.
        const cost = margin + orderFee;
        if (cost > acc.cash_cents) {
          const max = this.affordableQty(req.companyId, levels, consumed, acc.cash_cents, quote.mid, tick, acc.kind === 'career', leverage, feeBps);
          const how = leverage > 1 ? ` of your own cash at ${leverage}x leverage` : '';
          const withFee = orderFee > 0 ? ` (including a fee of ${formatCents(orderFee)})` : '';
          throw new OrderError('insufficient_cash', `That order would cost ${formatCents(cost)}${how}${withFee} but you only have ${formatCents(acc.cash_cents)}. Nothing was bought.`, { cost, fee: orderFee, cash: acc.cash_cents, maxQty: max });
        }
        const heldNow = mine ? { shares: mine.shares, debtCents: mine.debt_cents } : null;
        if (leverage > 1) {
          // You cannot be liquidated by the act of buying: the opening cost may use at most half the margin, and the position must stand.
          const openCost = Math.max(0, exec.totalCents - exec.filledQty * quote.mid);
          const standsAfter = !isLiquidated(quote.mid, (heldNow?.shares ?? 0) + exec.filledQty, (heldNow?.debtCents ?? 0) + debt);
          if (openCost > margin * OPEN_COST_LIMIT || !standsAfter) {
            const allowed = maxLeverageFor(exec.totalCents, exec.filledQty, quote.mid, heldNow);
            throw new OrderError(
              'leverage_too_high',
              `At ${leverage}x the cost of opening this order (${formatCents(openCost)} above the market price) is too big for its margin, so it would be closed almost at once. ${allowed > 1 ? `The most for this order is ${allowed}x.` : 'Use no leverage, or a smaller order.'} Nothing was bought.`,
              { leverage, maxLeverage: allowed, openCostCents: openCost },
            );
          }
        }
        this.db.run('UPDATE accounts SET cash_cents = cash_cents - ? WHERE id = ?', cost, acc.id);
        if (pool) payIn(this.db, req.companyId, margin); // what a buyer pays for a pool coin goes into its pool (the fee does not: it is gone)
        realized = -fee; // the fee is a loss the moment it is paid; the position itself starts at no profit and no loss
        upsert(exec.filledQty, margin, debt, 0);
        setExits(liquidationPrice((heldNow?.shares ?? 0) + exec.filledQty, (heldNow?.debtCents ?? 0) + debt));
      } else if (opening) {
        // A short sale: the money from the sale stays on the position as its "credit"; the player puts up a margin of his own cash.
        const margin = marginOf(exec.totalCents, leverage);
        const cost = margin + orderFee;
        if (cost > acc.cash_cents) {
          const max = this.affordableShortQty(req.companyId, levels, consumed, acc.cash_cents, quote.mid, tick, acc.kind === 'career', leverage, feeBps);
          const how = leverage > 1 ? ` of your own cash at ${leverage}x leverage` : '';
          const withFee = orderFee > 0 ? ` plus a fee of ${formatCents(orderFee)}` : '';
          throw new OrderError('insufficient_cash', `Shorting that would need ${formatCents(margin)}${how} as margin${withFee} but you only have ${formatCents(acc.cash_cents)}. Nothing was sold.`, { cost, fee: orderFee, cash: acc.cash_cents, maxQty: max });
        }
        const heldNow = mine ? { shares: mine.shares, collateralCents: collateralOf(mine.credit_cents, mine.cost_cents) } : null;
        const sharesAfter = (heldNow?.shares ?? 0) + exec.filledQty;
        const collateralAfter = (heldNow?.collateralCents ?? 0) + exec.totalCents + margin;
        if (leverage > 1) {
          // You cannot be liquidated by the act of selling short: the opening cost (selling below the market price) may use at most half the margin.
          const openCost = Math.max(0, exec.filledQty * quote.mid - exec.totalCents);
          if (openCost > margin * OPEN_COST_LIMIT || isShortLiquidated(quote.mid, sharesAfter, collateralAfter)) {
            const allowed = maxShortLeverageFor(exec.totalCents, exec.filledQty, quote.mid, heldNow);
            throw new OrderError(
              'leverage_too_high',
              `At ${leverage}x the cost of opening this short (${formatCents(openCost)} below the market price) is too big for its margin, so it would be closed almost at once. ${allowed > 1 ? `The most for this order is ${allowed}x.` : 'Use no leverage, or a smaller order.'} Nothing was sold.`,
              { leverage, maxLeverage: allowed, openCostCents: openCost },
            );
          }
        }
        this.db.run('UPDATE accounts SET cash_cents = cash_cents - ? WHERE id = ?', cost, acc.id);
        realized = -fee;
        upsert(exec.filledQty, margin, 0, exec.totalCents);
        setExits(shortLiquidationPrice(sharesAfter, collateralAfter));
      } else if (short) {
        // Covering: the player buys shares back. What is left of the collateral that goes with those shares comes back to him, never less than nothing.
        const held = mine as PositionRow;
        const costPart = debtShare(held.cost_cents, exec.filledQty, held.shares);
        const creditPart = debtShare(held.credit_cents, exec.filledQty, held.shares);
        const back = Math.max(0, creditPart + costPart - exec.totalCents);
        fee = Math.min(orderFee, back); // the fee comes out of what comes back, never more than that
        const received = back - fee;
        realized = received - costPart;
        this.db.run('UPDATE accounts SET cash_cents = cash_cents + ? WHERE id = ?', received, acc.id);
        if (exec.filledQty === held.shares) this.db.run('DELETE FROM positions WHERE account_id = ? AND company_id = ?', acc.id, req.companyId);
        else this.db.run('UPDATE positions SET shares = shares - ?, cost_cents = cost_cents - ?, credit_cents = credit_cents - ? WHERE account_id = ? AND company_id = ?', exec.filledQty, costPart, creditPart, acc.id, req.companyId);
      } else {
        const held = mine as PositionRow;
        // Cost removed is proportional to the shares sold; BigInt keeps the multiplication exact. The debt that goes with those shares is repaid
        // out of the proceeds; what is left is the player's, and if the proceeds do not cover the debt he gets nothing (never less than nothing).
        const removed = exec.filledQty === held.shares ? held.cost_cents : Number((BigInt(held.cost_cents) * BigInt(exec.filledQty)) / BigInt(held.shares));
        debt = debtShare(held.debt_cents, exec.filledQty, held.shares);
        const proceeds = Math.max(0, exec.totalCents - debt);
        fee = Math.min(orderFee, proceeds); // the fee comes out of what is left after the debt, never more than that
        const received = proceeds - fee;
        realized = received - removed;
        this.db.run('UPDATE accounts SET cash_cents = cash_cents + ? WHERE id = ?', received, acc.id);
        if (pool) payOut(this.db, req.companyId, exec.totalCents); // the pool pays for the sale (capToPool made sure it holds that much); the fee is gone
        if (exec.filledQty === held.shares) this.db.run('DELETE FROM positions WHERE account_id = ? AND company_id = ?', acc.id, req.companyId);
        else this.db.run('UPDATE positions SET shares = shares - ?, cost_cents = cost_cents - ?, debt_cents = debt_cents - ? WHERE account_id = ? AND company_id = ?', exec.filledQty, removed, debt, acc.id, req.companyId);
      }
      // The position (if it is still there) is paid up to now: the next charge counts from this tick.
      if (acc.kind === 'career') this.db.run('UPDATE positions SET accrued_tick = ? WHERE account_id = ? AND company_id = ?', tick, acc.id, req.companyId);
      this.db.run(
        'INSERT INTO impact_state(account_id, company_id, side, consumed, tick) VALUES (?, ?, ?, ?, ?) ON CONFLICT(account_id, company_id, side) DO UPDATE SET consumed = excluded.consumed, tick = excluded.tick',
        acc.id,
        req.companyId,
        req.side,
        exec.consumedAfter,
        tick,
      );
      const created = this.now();
      const r = this.db.run(
        'INSERT INTO trades(account_id, client_order_id, company_id, side, requested, filled, total_cents, mid_cents, spread_cents, impact_cents, realized_cents, tick, created_ms, result_json, leverage, debt_cents, short, auto, fee_cents) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        acc.id,
        req.clientOrderId,
        req.companyId,
        req.side,
        req.qty,
        exec.filledQty,
        exec.totalCents,
        quote.mid,
        exec.spreadCostCents,
        exec.impactCostCents,
        realized,
        tick,
        created,
        JSON.stringify(capped.limited ? { note: exec.note, parts: exec.parts, poolLimited: true } : { note: exec.note, parts: exec.parts }),
        leverage,
        debt,
        short ? 1 : 0,
        auto,
        fee,
      );
      // Anything that can be closed by the market (debt, a short, a stop or take) may have changed: the liquidator looks again.
      this.leverageListener?.();
      const stored = this.db.get<StoredTrade>('SELECT * FROM trades WHERE id = ?', r.lastInsertRowid) as StoredTrade;
      if (acc.kind === 'career' && this.flow) pushed.event = this.flow.record(stored.id, company, flow, tick, this.world.earliestEventStart(), created);
      // Safety net: the database constraints already forbid negative cash and shares; this makes a bug visible at once.
      const after = this.account(acc.id) as AccountRow;
      if (after.cash_cents < 0) throw new Error(`Account ${acc.id} would have negative cash`);
      return { duplicate: false, trade: this.tradeView(stored), account: this.view(acc.id) };
    });
    const push = pushed.event;
    if (push) {
      try {
        this.world.scheduleEvent(push);
      } catch (error) {
        // The trade and its push are saved; a restart will load the push from the table. Say so loudly instead of hiding it.
        this.world.log.error('trading', `Could not hand the price push ${push.key} to the market now; it will apply after the next restart: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return outcome;
  }

  // ---- stop-loss and take-profit ---------------------------------------------------------------------------------------

  /**
   * Sets, changes or clears the stop-loss and take-profit of a position the player holds. A price is a whole number of cents; `null`
   * clears it and leaving it out keeps what is set. Only the prices that are being set are checked (see checkExits).
   */
  setExits(accountId: number, companyId: number, input: { stopPrice?: number | null; takePrice?: number | null }): AccountView {
    for (const [name, v] of [['stop-loss', input.stopPrice], ['take-profit', input.takePrice]] as const) {
      if (v !== undefined && v !== null && (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1)) throw new OrderError('bad_request', `The ${name} price must be a positive whole number of cents, or null to remove it.`);
    }
    return this.db.tx(() => {
      const acc = this.account(accountId);
      if (!acc) throw new OrderError('bad_request', 'Unknown account.', {}, 404);
      const company = this.world.companies[companyId];
      if (!Number.isInteger(companyId) || !company) throw new OrderError('unknown_company', 'That company does not exist.', {}, 404);
      const blocked = this.gate ? this.gate(acc, this.world.sim.tick) : null;
      if (blocked) throw new OrderError('not_allowed', blocked, {}, 403);
      const pos = this.positionOf(acc.id, companyId);
      if (!pos) throw new OrderError('insufficient_shares', `You have no position in ${company.ticker}, so there is nothing to protect.`, { held: 0 });
      this.checkPool(this.poolFor(companyId, acc.kind), company.ticker, { short: false, leverage: 1, exits: true });
      const short = pos.short === 1;
      const stop = input.stopPrice === undefined ? undefined : input.stopPrice === null ? 0 : input.stopPrice;
      const take = input.takePrice === undefined ? undefined : input.takePrice === null ? 0 : input.takePrice;
      const mid = this.world.quote(companyId).mid;
      const liq = short ? shortLiquidationPrice(pos.shares, collateralOf(pos.credit_cents, pos.cost_cents)) : liquidationPrice(pos.shares, pos.debt_cents);
      this.checkExits(company.ticker, short, mid, liq, stop ? stop : undefined, take ? take : undefined);
      if (stop !== undefined) this.db.run('UPDATE positions SET stop_cents = ? WHERE account_id = ? AND company_id = ?', stop, acc.id, companyId);
      if (take !== undefined) this.db.run('UPDATE positions SET take_cents = ? WHERE account_id = ? AND company_id = ?', take, acc.id, companyId);
      this.leverageListener?.();
      return this.view(acc.id);
    });
  }

  /**
   * The market closes a whole position because its stop-loss or take-profit price was reached (called by the liquidator, see
   * liquidation.ts). It is an ordinary market order for all the shares: it pays the spread and walks the order book like the player's
   * own order would. Returns the trade when something was traded, null when the market could not take the order right now (trading
   * halted or paused, the server catching up, no liquidity): the liquidator simply tries again at the next tick.
   */
  closeByExit(accountId: number, companyId: number, kind: 'stop' | 'take', tick: number): TradeView | null {
    const pos = this.positionOf(accountId, companyId);
    if (!pos) return null;
    const short = pos.short === 1;
    const qty = Math.min(pos.shares, maxOrderShares(this.world.sim.price(companyId)));
    try {
      return this.placeOrder({ accountId, clientOrderId: `auto-${kind}-${companyId}-${tick}`, companyId, side: short ? 'buy' : 'sell', qty, short, auto: kind }).trade;
    } catch (error) {
      if (error instanceof OrderError) return null;
      throw error;
    }
  }
}
