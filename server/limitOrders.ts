// Limit orders (docs/world.md §6.8): an order that waits in the market until the price reaches its limit.
//
//   • A BUY limit waits until the ask is at or below the limit, a SELL limit until the bid is at or above it. When that happens the order goes
//     to the market like any other order of the player (Trading.placeOrder, with the limit as its price limit): it pays the spread, walks the
//     order book, pays the fee and pushes the price. Nothing is filled above (a buy) or below (a sell) the limit. If the book at that price is
//     too thin for all of it, the rest keeps waiting.
//   • It works for all four kinds of order: buy, sell, short sale and cover, with the leverage, stop-loss and take-profit of an order that opens
//     a position. It is for Career only; a 1v1 match is three minutes of market orders.
//   • MONEY IS SET ASIDE. An order that OPENS a position (a buy, a short sale) takes the cash it could cost at its limit (the margin and the fee)
//     out of the player's cash when it is placed; the cash comes back when the order fills, is cancelled or expires, so the same money cannot be
//     promised to two orders (or spent on something else). The set-aside cash still counts in net worth. An order that CLOSES a position sets
//     nothing aside; instead the shares it will sell are promised to it: all the open sell orders of a company together never ask for more than
//     the player holds. If the position is smaller when the price is reached (a stop-loss closed it), the order trades what is left, or ends.
//   • It waits at most the time the player chose (1 hour, 1 day or 3 days) and at most 20 orders at a time.
//   • A limit order fills only in the live market: while the server catches up after a stop, nothing fills (like a stop-loss), so there is no
//     filling on prices of the past. A banned player's orders wait.
//
// Everything about an order is stored (migration 16, limit_orders), so a restart keeps it.

import type { Logger } from './log';
import type { Db } from './sqlite';
import { OrderError, maxOrderShares, type AccountView, type OrderRequest, type Trading } from './trading';
import type { WorldRuntime } from './world/runtime';
import { formatCents } from '../src/engine';

/** How long an order may wait, in ticks (seconds). */
export const GOOD_FOR_TICKS = { '1h': 3_600, '1d': 86_400, '3d': 259_200 } as const;
export type GoodFor = keyof typeof GOOD_FOR_TICKS;
export const DEFAULT_GOOD_FOR: GoodFor = '1d';
export const MAX_OPEN_ORDERS = 20;
/** After an order could not be filled yet (the book was too thin at its price...), it is tried again this many seconds later. */
export const RETRY_TICKS = 5;
/** Nothing fills while the market is more than this many ticks behind the clock. */
const MAX_LAG_TICKS = 3;

export interface LimitOrderRequest {
  readonly accountId: number;
  readonly clientOrderId: string;
  readonly companyId: number;
  readonly side: 'buy' | 'sell';
  readonly qty: number;
  readonly limitPrice: number;
  readonly leverage?: number;
  readonly short?: boolean;
  readonly stopPrice?: number;
  readonly takePrice?: number;
  readonly goodFor?: GoodFor;
}

/** What the order form shows before the order is placed. */
export interface LimitOrderEstimate {
  readonly tick: number;
  readonly kind: 'buy' | 'sell' | 'short' | 'cover';
  readonly opening: boolean;
  readonly leverage: number;
  readonly bid: number;
  readonly ask: number;
  readonly mid: number;
  /** Shares × limit price: the most a buy or cover costs, the least a sell or short brings in (before fees and debt). */
  readonly valueCents: number;
  /** The cash that would be set aside (0 for an order that closes a position). */
  readonly reserveCents: number;
  /** The fee rate of this company (memecoins), basis points. */
  readonly feeBps: number;
  readonly cashCents: number;
  /** The most shares this order may ask for right now. */
  readonly maxQty: number;
  /** A closing order: shares held in the position, and how many of them other open orders already promised. */
  readonly held: number;
  readonly promised: number;
  /** True when the market price is already at the limit: the order would trade at once. */
  readonly fillsNow: boolean;
}

export interface LimitOrderView {
  readonly id: number;
  readonly clientOrderId: string;
  readonly companyId: number;
  readonly ticker: string;
  readonly side: 'buy' | 'sell';
  readonly short: boolean;
  /** buy = open or add to a long, sell = sell a long, short = open or add to a short, cover = buy a short back. */
  readonly kind: 'buy' | 'sell' | 'short' | 'cover';
  readonly qty: number;
  readonly filled: number;
  readonly remaining: number;
  readonly limitCents: number;
  readonly leverage: number;
  readonly stopCents: number;
  readonly takeCents: number;
  /** Cash set aside for it (opening orders), cents. */
  readonly reservedCents: number;
  readonly state: 'open' | 'filled' | 'cancelled' | 'expired';
  /** Why it ended, when it did not fill (a sentence for the player). */
  readonly reason: string;
  readonly avgFillCents: number | null;
  readonly createdTick: number;
  readonly expiresTick: number;
  readonly createdMs: number;
  readonly closedMs: number | null;
}

interface Row {
  id: number;
  account_id: number;
  company_id: number;
  client_order_id: string;
  side: 'buy' | 'sell';
  short: number;
  qty: number;
  filled: number;
  total_cents: number;
  limit_cents: number;
  leverage: number;
  stop_cents: number;
  take_cents: number;
  reserved_cents: number;
  state: 'open' | 'filled' | 'cancelled' | 'expired';
  reason: string;
  created_tick: number;
  expires_tick: number;
  retry_tick: number;
  fills: number;
  created_ms: number;
  closed_ms: number | null;
}

/** Errors that only mean "not now": the order keeps waiting. Everything else ends it, with the sentence of the error as the reason. */
const WAIT_CODES: ReadonlySet<string> = new Set(['limit_not_met', 'no_liquidity', 'market_unavailable', 'not_trading', 'halted', 'not_allowed', 'rate_limited']);

export interface LimitOrdersOptions {
  readonly db: Db;
  readonly world: WorldRuntime;
  readonly trading: Trading;
  readonly log: Logger;
  readonly now: () => number;
  /** True while the player is banned (his orders wait). */
  readonly isBanned: (userId: number) => boolean;
  /** Told after an order filled (completely or in part), ended or expired, for the player's pop-up. Called after the transaction has committed. */
  readonly onChange?: (userId: number, order: LimitOrderView, what: 'fill' | 'ended') => void;
}

export class LimitOrders {
  private readonly db: Db;
  private readonly world: WorldRuntime;
  private readonly trading: Trading;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly isBanned: (userId: number) => boolean;
  private readonly onChange: LimitOrdersOptions['onChange'];
  /** What happened inside a transaction, told to onChange once it has committed. */
  private pending: { userId: number; order: LimitOrderView; what: 'fill' | 'ended' }[] = [];

  constructor(o: LimitOrdersOptions) {
    this.db = o.db;
    this.world = o.world;
    this.trading = o.trading;
    this.log = o.log;
    this.now = o.now;
    this.isBanned = o.isBanned;
    this.onChange = o.onChange;
  }

  // ---- reading -------------------------------------------------------------------------------------------------------

  viewOf(r: Row): LimitOrderView {
    const company = this.world.companies[r.company_id];
    const short = r.short === 1;
    const opening = r.side === (short ? 'sell' : 'buy');
    return {
      id: r.id,
      clientOrderId: r.client_order_id,
      companyId: r.company_id,
      ticker: company?.ticker ?? '?',
      side: r.side,
      short,
      kind: short ? (opening ? 'short' : 'cover') : opening ? 'buy' : 'sell',
      qty: r.qty,
      filled: r.filled,
      remaining: r.state === 'open' ? r.qty - r.filled : 0,
      limitCents: r.limit_cents,
      leverage: r.leverage,
      stopCents: r.stop_cents,
      takeCents: r.take_cents,
      reservedCents: r.reserved_cents,
      state: r.state,
      reason: r.reason,
      avgFillCents: r.filled > 0 ? Math.round(r.total_cents / r.filled) : null,
      createdTick: r.created_tick,
      expiresTick: r.expires_tick,
      createdMs: r.created_ms,
      closedMs: r.closed_ms,
    };
  }

  /** The player's orders, newest first: only the open ones, or the latest `limit` of all. */
  list(accountId: number, which: 'open' | 'all' = 'open', limit = 50): LimitOrderView[] {
    const lim = Math.max(1, Math.min(200, limit));
    const rows =
      which === 'open'
        ? this.db.all<Row>("SELECT * FROM limit_orders WHERE account_id = ? AND state = 'open' ORDER BY id DESC LIMIT ?", accountId, lim)
        : this.db.all<Row>('SELECT * FROM limit_orders WHERE account_id = ? ORDER BY id DESC LIMIT ?', accountId, lim);
    return rows.map((r) => this.viewOf(r));
  }

  private row(id: number): Row | undefined {
    return this.db.get<Row>('SELECT * FROM limit_orders WHERE id = ?', id);
  }

  /**
   * What an order would set aside and whether it would fill at once, for the order form (nothing is placed, nothing changes). `maxQty` is
   * the most shares the form may ask for: what the cash can carry (an order that opens) or the shares not yet promised to another order
   * (an order that closes).
   */
  estimate(req: Omit<LimitOrderRequest, 'clientOrderId' | 'goodFor'>): LimitOrderEstimate {
    const shape = this.trading.shapeOf({ accountId: req.accountId, clientOrderId: 'estimate-only', companyId: req.companyId, side: req.side, qty: req.qty, limitPrice: req.limitPrice, leverage: req.leverage, short: req.short, stopPrice: req.stopPrice, takePrice: req.takePrice });
    const acc = this.trading.account(req.accountId);
    if (!acc) throw new OrderError('bad_request', 'Unknown account.', {}, 404);
    if (acc.kind !== 'career') throw new OrderError('not_allowed', 'Limit orders are for your Career account.', {}, 403);
    const q = this.world.quote(req.companyId);
    const feeBps = this.trading.feeRateFor(req.companyId, acc.kind);
    const hold = this.trading.holding(acc.id, req.companyId);
    const have = hold && hold.short === shape.short ? hold.shares : 0;
    const promised = this.db.get<{ n: number | null }>("SELECT SUM(qty - filled) AS n FROM limit_orders WHERE account_id = ? AND company_id = ? AND short = ? AND side = ? AND state = 'open'", acc.id, req.companyId, shape.short ? 1 : 0, req.side)?.n ?? 0;
    const cap = maxOrderShares(q.mid);
    let maxQty: number;
    let reserve = 0;
    if (shape.opening) {
      reserve = this.trading.openingReserve(req.companyId, acc.kind, req.qty, req.limitPrice as number, shape.leverage);
      // The reserve only grows with the number of shares: find the most that fits in the cash.
      let lo = 0;
      let hi = Math.min(cap, acc.cash_cents * 50 + 1);
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        let cost = Number.POSITIVE_INFINITY;
        try {
          cost = this.trading.openingReserve(req.companyId, acc.kind, mid, req.limitPrice as number, shape.leverage);
        } catch {
          // too large to price: it does not fit
        }
        if (cost <= acc.cash_cents) lo = mid;
        else hi = mid - 1;
      }
      maxQty = lo;
    } else {
      maxQty = Math.max(0, Math.min(cap, have - promised));
    }
    const limit = req.limitPrice as number;
    const fillsNow = this.world.sim.isListed(req.companyId) && (req.side === 'buy' ? q.ask > 0 && q.ask <= limit : q.bid > 0 && q.bid >= limit);
    return {
      tick: this.world.sim.tick,
      kind: shape.short ? (shape.opening ? 'short' : 'cover') : shape.opening ? 'buy' : 'sell',
      opening: shape.opening,
      leverage: shape.leverage,
      bid: q.bid,
      ask: q.ask,
      mid: q.mid,
      valueCents: req.qty * limit,
      reserveCents: reserve,
      feeBps,
      cashCents: acc.cash_cents,
      maxQty,
      held: have,
      promised,
      fillsNow,
    };
  }

  // ---- placing and cancelling ------------------------------------------------------------------------------------------

  /** Places an order. Safe to send twice: the same clientOrderId returns the first order and changes nothing. If the price is already there, it is filled at once. */
  place(req: LimitOrderRequest): { duplicate: boolean; order: LimitOrderView; account: AccountView } {
    if (req.limitPrice === undefined || req.limitPrice === null) throw new OrderError('bad_request', 'A limit order needs a price limit (in cents).');
    const goodFor = req.goodFor ?? DEFAULT_GOOD_FOR;
    if (!(goodFor in GOOD_FOR_TICKS)) throw new OrderError('bad_request', 'goodFor must be 1h, 1d or 3d.');
    const asOrder: OrderRequest = { accountId: req.accountId, clientOrderId: req.clientOrderId, companyId: req.companyId, side: req.side, qty: req.qty, limitPrice: req.limitPrice, leverage: req.leverage, short: req.short, stopPrice: req.stopPrice, takePrice: req.takePrice };
    const shape = this.trading.shapeOf(asOrder);
    const result = this.db.tx(() => {
      const acc = this.trading.account(req.accountId);
      if (!acc) throw new OrderError('bad_request', 'Unknown account.', {}, 404);
      if (acc.kind !== 'career') throw new OrderError('not_allowed', 'Limit orders are for your Career account. A 1v1 match is only three minutes, so it takes market orders only.', {}, 403);
      const existing = this.db.get<Row>('SELECT * FROM limit_orders WHERE account_id = ? AND client_order_id = ?', acc.id, req.clientOrderId);
      if (existing) return { duplicate: true, id: existing.id };
      const open = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM limit_orders WHERE account_id = ? AND state = 'open'", acc.id)?.n ?? 0;
      if (open >= MAX_OPEN_ORDERS) throw new OrderError('too_many_orders', `You already have ${MAX_OPEN_ORDERS} open limit orders. Cancel one first.`, { open });
      this.trading.checkMayPlace(acc, req.companyId, req.qty, shape.opening, shape.short);
      const company = this.world.companies[req.companyId];
      const ticker = company?.ticker ?? '?';
      const hold = this.trading.holding(acc.id, req.companyId);

      if (!shape.opening) {
        // Closing: the shares must be there, and no other open order of this kind has already been promised them.
        const have = hold && hold.short === shape.short ? hold.shares : 0;
        if (have === 0) {
          const hint = hold ? (hold.short ? ' You are short it: use a Cover order to buy the shares back.' : ' You hold shares of it: use a Sell order to sell them.') : '';
          throw new OrderError('insufficient_shares', `${shape.short ? 'You are not short' : 'You do not hold'} any ${ticker}.${hint}`, { held: 0 });
        }
        const promised = this.db.get<{ n: number | null }>("SELECT SUM(qty - filled) AS n FROM limit_orders WHERE account_id = ? AND company_id = ? AND short = ? AND side = ? AND state = 'open'", acc.id, req.companyId, shape.short ? 1 : 0, req.side)?.n ?? 0;
        if (req.qty + promised > have) {
          throw new OrderError(
            'insufficient_shares',
            `${shape.short ? `You are short ${have.toLocaleString('en-US')} shares` : `You hold ${have.toLocaleString('en-US')} shares`} of ${ticker}${promised > 0 ? `, and ${promised.toLocaleString('en-US')} of them are already promised to your other open limit orders` : ''}, so you cannot ask for ${req.qty.toLocaleString('en-US')} more.`,
            { held: have, promised },
          );
        }
      } else {
        // Opening: a stop-loss and a take-profit must make sense around the limit price (the market price is checked again when it fills).
        const stop = shape.exits.stop;
        const take = shape.exits.take;
        const bad = (m: string): never => {
          throw new OrderError('bad_exit', `${m} Nothing was placed.`, { limit: req.limitPrice });
        };
        if (!shape.short) {
          if (stop !== undefined && stop >= req.limitPrice) bad(`The stop-loss of a long position must be below your limit price (${formatCents(req.limitPrice)}).`);
          if (take !== undefined && take <= req.limitPrice) bad(`The take-profit of a long position must be above your limit price (${formatCents(req.limitPrice)}).`);
        } else {
          if (stop !== undefined && stop <= req.limitPrice) bad(`The stop-loss of a short position must be above your limit price (${formatCents(req.limitPrice)}).`);
          if (take !== undefined && take >= req.limitPrice) bad(`The take-profit of a short position must be below your limit price (${formatCents(req.limitPrice)}).`);
        }
      }

      const reserve = shape.opening ? this.trading.openingReserve(req.companyId, acc.kind, req.qty, req.limitPrice, shape.leverage) : 0;
      if (reserve > acc.cash_cents) {
        throw new OrderError('insufficient_cash', `This order could cost up to ${formatCents(reserve)} of your own cash (at its price limit${shape.leverage > 1 ? `, with ${shape.leverage}x leverage` : ''}), and you have ${formatCents(acc.cash_cents)}. Nothing was placed.`, { cost: reserve, cash: acc.cash_cents });
      }
      if (reserve > 0) this.db.run('UPDATE accounts SET cash_cents = cash_cents - ? WHERE id = ?', reserve, acc.id);
      const tick = this.world.sim.tick;
      const r = this.db.run(
        `INSERT INTO limit_orders(account_id, company_id, client_order_id, side, short, qty, limit_cents, leverage, stop_cents, take_cents, reserved_cents, created_tick, expires_tick, created_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        acc.id, req.companyId, req.clientOrderId, req.side, shape.short ? 1 : 0, req.qty, req.limitPrice, shape.leverage, shape.exits.stop ?? 0, shape.exits.take ?? 0, reserve, tick, tick + (GOOD_FOR_TICKS[goodFor] as number), this.now(),
      );
      return { duplicate: false, id: r.lastInsertRowid };
    });
    // If the price is already there, it fills now. A failure to fill is not a failure to place.
    if (!result.duplicate) {
      try {
        this.attempt(result.id, this.world.sim.tick);
      } catch (error) {
        this.log.warn('limit', `A new limit order could not be tried at once: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.flush();
    return { duplicate: result.duplicate, order: this.viewOf(this.row(result.id) as Row), account: this.trading.view(req.accountId) };
  }

  /** Cancels an open order of this account and gives its cash back. */
  cancel(accountId: number, orderId: number): { order: LimitOrderView; account: AccountView } {
    if (!Number.isSafeInteger(orderId)) throw new OrderError('bad_request', 'The order id must be a number.');
    this.db.tx(() => {
      const o = this.row(orderId);
      if (!o || o.account_id !== accountId) throw new OrderError('bad_request', 'You have no such limit order.', {}, 404);
      if (o.state !== 'open') return; // already over: nothing to do
      this.finish(o, 'cancelled', 'You cancelled it.', false);
    });
    this.flush();
    return { order: this.viewOf(this.row(orderId) as Row), account: this.trading.view(accountId) };
  }

  /** Ends every open order of an account without giving cash back (the owner reset the account to its starting cash). */
  dropAll(accountId: number, reason: string): void {
    this.db.run("UPDATE limit_orders SET state = 'cancelled', reason = ?, reserved_cents = 0, closed_ms = ? WHERE account_id = ? AND state = 'open'", reason, this.now(), accountId);
  }

  // ---- the market ------------------------------------------------------------------------------------------------------

  /** Called at every tick: orders that ran out of time end, orders whose price has been reached are sent to the market. */
  step(tick: number): void {
    const open = this.db.all<{ id: number; account_id: number; company_id: number; side: 'buy' | 'sell'; short: number; limit_cents: number; expires_tick: number; retry_tick: number }>(
      "SELECT id, account_id, company_id, side, short, limit_cents, expires_tick, retry_tick FROM limit_orders WHERE state = 'open'",
    );
    if (open.length === 0) return;
    const live = this.world.lagTicks <= MAX_LAG_TICKS;
    for (const o of open) {
      let due = tick > o.expires_tick;
      if (!due) {
        // An order that closes a position ends as soon as the position is gone (a stop-loss closed it, the owner took the shares...).
        const closing = o.side !== (o.short === 1 ? 'sell' : 'buy');
        if (closing) {
          const hold = this.trading.holding(o.account_id, o.company_id);
          if (!hold || hold.short !== (o.short === 1)) due = true;
        }
      }
      if (!due) {
        if (!live || tick < o.retry_tick || !this.world.sim.isListed(o.company_id)) continue;
        const q = this.world.quote(o.company_id);
        due = o.side === 'buy' ? q.ask > 0 && q.ask <= o.limit_cents : q.bid >= o.limit_cents && q.bid > 0;
      }
      if (!due) continue;
      try {
        this.attempt(o.id, tick);
      } catch (error) {
        this.log.warn('limit', `Limit order ${o.id} could not be tried: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.flush();
  }

  /** Tells the listener what happened in the transactions that have committed. */
  private flush(): void {
    const list = this.pending;
    this.pending = [];
    if (!this.onChange) return;
    for (const p of list) {
      try {
        this.onChange(p.userId, p.order, p.what);
      } catch (error) {
        this.log.warn('limit', `Could not tell a player about a limit order: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** Ends an open order and gives its set-aside cash back. */
  private finish(o: Row, state: 'filled' | 'cancelled' | 'expired', reason: string, tell = true): void {
    if (o.reserved_cents > 0) this.db.run('UPDATE accounts SET cash_cents = cash_cents + ? WHERE id = ?', o.reserved_cents, o.account_id);
    this.db.run('UPDATE limit_orders SET state = ?, reason = ?, reserved_cents = 0, closed_ms = ? WHERE id = ?', state, reason, this.now(), o.id);
    if (tell) {
      const acc = this.trading.account(o.account_id);
      if (acc) this.pending.push({ userId: acc.user_id, order: this.viewOf(this.row(o.id) as Row), what: 'ended' });
    }
  }

  /** Sends one order to the market if its price has been reached. All or nothing: everything it changes is saved together. */
  private attempt(orderId: number, tick: number): void {
    this.db.tx(() => {
      const o = this.row(orderId);
      if (!o || o.state !== 'open') return;
      const acc = this.trading.account(o.account_id);
      if (!acc) return;
      if (tick > o.expires_tick) return this.finish(o, 'expired', 'It ran out of time before the price reached your limit.');
      const short = o.short === 1;
      const opening = o.side === (short ? 'sell' : 'buy');
      if (!opening) {
        const hold = this.trading.holding(acc.id, o.company_id);
        if (!hold || hold.short !== short) return this.finish(o, 'cancelled', short ? 'Your short position is gone, so there was nothing to cover.' : 'Your shares are gone, so there was nothing to sell.');
      }
      if (this.isBanned(acc.user_id) || tick < o.retry_tick) return;
      if (!this.world.sim.isListed(o.company_id)) return;
      const q = this.world.quote(o.company_id);
      const reached = o.side === 'buy' ? q.ask > 0 && q.ask <= o.limit_cents : q.bid > 0 && q.bid >= o.limit_cents;
      if (!reached) return;

      let qty = o.qty - o.filled;
      if (!opening) qty = Math.min(qty, (this.trading.holding(acc.id, o.company_id) as { shares: number }).shares);
      qty = Math.min(qty, maxOrderShares(q.mid));

      let tryQty = qty;
      for (let round = 0; round < 2; round += 1) {
        // Give the set-aside cash back for a moment: the order is then an ordinary order with that cash in the account.
        if (o.reserved_cents > 0) this.db.run('UPDATE accounts SET cash_cents = cash_cents + ? WHERE id = ?', o.reserved_cents, acc.id);
        try {
          const out = this.trading.placeOrder({
            accountId: acc.id,
            clientOrderId: `limit-${o.id}-${o.fills + 1}`,
            companyId: o.company_id,
            side: o.side,
            qty: tryQty,
            limitPrice: o.limit_cents,
            leverage: opening ? o.leverage : undefined,
            short,
            stopPrice: opening && o.stop_cents > 0 ? o.stop_cents : undefined,
            takePrice: opening && o.take_cents > 0 ? o.take_cents : undefined,
          });
          this.afterFill(o, out.trade.filled, out.trade.totalCents, tick);
          return;
        } catch (error) {
          if (!(error instanceof OrderError)) throw error;
          // It did not trade: the cash is set aside again.
          if (o.reserved_cents > 0) this.db.run('UPDATE accounts SET cash_cents = cash_cents - ? WHERE id = ?', o.reserved_cents, acc.id);
          if (WAIT_CODES.has(error.code)) {
            this.db.run('UPDATE limit_orders SET retry_tick = ? WHERE id = ?', tick + RETRY_TICKS, o.id);
            return;
          }
          // The price moved the cost of opening above what was set aside (a short sold higher than its limit): fewer shares then.
          const max = typeof error.details.maxQty === 'number' ? error.details.maxQty : 0;
          if (error.code === 'insufficient_cash' && round === 0 && max >= 1 && max < tryQty) {
            tryQty = max;
            continue;
          }
          return this.finish(o, 'cancelled', error.message);
        }
      }
    });
  }

  /** The order traded `filled` shares for `total` cents: book it, and either finish it or set aside cash for what is left. */
  private afterFill(o: Row, filled: number, total: number, tick: number): void {
    const short = o.short === 1;
    const opening = o.side === (short ? 'sell' : 'buy');
    const nowFilled = o.filled + filled;
    const nowTotal = o.total_cents + total;
    // placeOrder has been given the set-aside cash back (see attempt), so it is in the account now; the order holds none until it sets aside more.
    this.db.run('UPDATE limit_orders SET filled = ?, total_cents = ?, fills = fills + 1, reserved_cents = 0, retry_tick = ? WHERE id = ?', nowFilled, nowTotal, tick + 1, o.id);
    const fresh = this.row(o.id) as Row;
    if (nowFilled >= o.qty) {
      this.db.run("UPDATE limit_orders SET state = 'filled', closed_ms = ? WHERE id = ?", this.now(), o.id);
    } else if (opening) {
      const left = o.qty - nowFilled;
      const reserve = this.trading.openingReserve(o.company_id, 'career', left, o.limit_cents, o.leverage);
      const cash = this.trading.account(o.account_id)?.cash_cents ?? 0;
      if (reserve > cash) {
        this.db.run("UPDATE limit_orders SET state = 'cancelled', reason = ?, closed_ms = ? WHERE id = ?", `Part of it was bought. You do not have the cash to set aside for the other ${left.toLocaleString('en-US')} shares, so the rest was cancelled.`, this.now(), o.id);
      } else {
        this.db.run('UPDATE accounts SET cash_cents = cash_cents - ? WHERE id = ?', reserve, o.account_id);
        this.db.run('UPDATE limit_orders SET reserved_cents = ? WHERE id = ?', reserve, o.id);
      }
    }
    const acc = this.trading.account(o.account_id);
    if (acc) this.pending.push({ userId: acc.user_id, order: this.viewOf(this.row(fresh.id) as Row), what: 'fill' });
  }
}
