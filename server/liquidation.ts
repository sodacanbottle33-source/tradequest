// Automatic closing of positions by the market: leveraged longs and shorts whose margin is gone ("liquidation"), and any position whose
// stop-loss or take-profit price was reached. The rules are in leverage.ts; this file applies them to the market, once per market tick.
//
// How it stays cheap. Few positions are watched (debt, shorts, stops), so the liquidator keeps a tiny table in memory: for each company
// with at least one such position, the band of prices outside which one of them is wiped out or triggered (a long: at or below its
// debt per share or its stop; a short: at or above its collateral per share or its stop; take-profits on the other side). Each tick it
// compares the company's price with that band, and only when the price is outside it does it look at the database. The table is
// rebuilt from the database whenever a trade or the owner's tools may have changed a watched position, and every 10 minutes anyway as
// a safety net.
//
// What it does when a position is wiped out. In one transaction the position is removed and a trade is written (a sell marked as a
// liquidation, at the market price, with the debt shown; for a short a purchase), so the player sees it in the trade list. No cash
// comes back: the shares were worth no more than the debt (a short: the buy-back costs at least the whole collateral). The
// liquidation does not itself push the price (it is the market closing a loan, not a sale into the order book).
//
// Stop-loss and take-profit. When the price reaches the stop or take price of a position, the market sells it (a short: buys it back)
// as an ordinary market order for ALL its shares (trading.closeByExit): it pays the spread and walks the order book, and a Career
// order pushes the price like the player's own would. If trading cannot take the order at that moment (the company is halted or
// paused, or the server is still catching up after having been off) the position stays and the next tick tries again; so a stop
// never fires from a price in the past, only from the price the market has now. A liquidation, which needs no order, goes first.
//
// When it looks. At every tick, including the ticks the market replays after the server was off: set it as the market's step
// observer BEFORE the market is started, so a price that touched the liquidation price while nobody watched still wipes the position
// out, at the tick it happened. It is called from the market's tick loop, so it must never be able to stop it.
//
// 1v1 matches. A position in a match account is only ever closed while its match is live and up to the match's last tick (the score
// is taken at that tick, and a position that is wiped out at that tick counts as nothing in the score either way). After that the
// position is left alone, so a price move after the end can never change a result that is about to be settled, and a finished
// match keeps showing what its players held.

import type { WorldSim } from '../src/world';
import { collateralOf, isLiquidated, isShortLiquidated } from './leverage';
import type { Logger } from './log';
import type { Db } from './sqlite';

/** What the liquidator needs from the market. */
export interface LiquidationWorld {
  readonly sim: Pick<WorldSim, 'price' | 'isListed'>;
  readonly companies: readonly { readonly ticker: string }[];
  msOfTick(tick: number): number;
}

export interface LiquidationOptions {
  readonly db: Db;
  readonly world: LiquidationWorld;
  readonly log: Logger;
  /** Called after positions were closed, so the player can be told at once and open pages can refresh. */
  readonly onClosed?: (events: readonly PositionClosed[]) => void;
}

/** A position the market closed by itself. */
export interface PositionClosed {
  readonly accountId: number;
  readonly companyId: number;
  /** 'liquidated': the margin was gone. 'stop' / 'take': the position's stop-loss / take-profit price was reached. */
  readonly reason: 'liquidated' | 'stop' | 'take';
  readonly short: boolean;
  readonly shares: number;
  /** The average price per share of the closing trade (cents). */
  readonly priceCents: number;
  /** What the player made (+) or lost (-) on the cash he put into the position (cents). */
  readonly realizedCents: number;
  readonly tick: number;
}

/**
 * Closes a whole position because its stop-loss ('stop') or take-profit ('take') price was reached, as an ordinary market order
 * (trading.closeByExit). Returns the trade when it traded, null when it could not right now (the liquidator tries again at the next tick).
 */
export type ExitHandler = (accountId: number, companyId: number, kind: 'stop' | 'take', tick: number) => { filled: number; avgPrice: number; realizedCents: number } | null;

/** How often the in-memory table is rebuilt even if nothing told the liquidator, in ticks (10 minutes). */
export const LIQUIDATION_REBUILD_TICKS = 600;

interface PositionRow {
  account_id: number;
  shares: number;
  cost_cents: number;
  debt_cents: number;
  short: number;
  credit_cents: number;
  stop_cents: number;
  take_cents: number;
}

interface OwnerRow extends PositionRow {
  kind: string;
  end_tick: number | null;
}

/**
 * The positions the market may close: those with debt, shorts, and those with a stop-loss or take-profit; of Career accounts, and of
 * matches that are live.
 */
const WATCHED = "(p.debt_cents > 0 OR p.short = 1 OR p.stop_cents > 0 OR p.take_cents > 0) AND (a.kind <> 'match' OR m.state = 'live')";
const FROM = 'FROM positions p JOIN accounts a ON a.id = p.account_id LEFT JOIN matches m ON m.id = a.match_id';
const COLUMNS = 'p.account_id AS account_id, p.shares AS shares, p.cost_cents AS cost_cents, p.debt_cents AS debt_cents, p.short AS short, p.credit_cents AS credit_cents, p.stop_cents AS stop_cents, p.take_cents AS take_cents';

/** The prices between which nothing happens to any watched position of a company: at or below `low` or at or above `high`, somebody's position is to be looked at. */
interface Band {
  low: number;
  high: number;
}

export class Liquidator {
  /** company id → the band of prices outside which a watched position may be closed. */
  private levels = new Map<number, Band>();
  private dirty = true;
  private lastRebuild = Number.NEGATIVE_INFINITY;
  private exitHandler: ExitHandler | null = null;
  /** How many positions the market has closed because their margin was gone since the program started (for the health page and tests). */
  closed = 0;
  /** How many positions the market has closed because a stop-loss or take-profit was reached since the program started. */
  exited = 0;

  constructor(private readonly o: LiquidationOptions) {}

  /** Something may have changed a watched position: look at the database again at the next tick. */
  markDirty(): void {
    this.dirty = true;
  }

  /** Where stop-loss and take-profit orders are executed (the trading code). Without it only liquidations happen. */
  setExitHandler(handler: ExitHandler | null): void {
    this.exitHandler = handler;
  }

  /** Call once per market tick, after the tick has been computed. */
  step(tick: number): void {
    if (this.dirty || tick - this.lastRebuild >= LIQUIDATION_REBUILD_TICKS) this.rebuild(tick);
    if (this.levels.size === 0) return;
    const { db, world } = this.o;
    const closed: PositionClosed[] = [];
    for (const [companyId, band] of this.levels) {
      if (!world.sim.isListed(companyId)) continue;
      const mid = world.sim.price(companyId);
      if (mid > band.low + 1e-6 && mid < band.high - 1e-6) continue; // nothing is wiped out or triggered at this price
      const rows = db.all<OwnerRow>(`SELECT ${COLUMNS}, a.kind AS kind, m.end_tick AS end_tick ${FROM} WHERE p.company_id = ? AND ${WATCHED}`, companyId);
      for (const r of rows) {
        if (r.kind === 'match' && (r.end_tick === null || tick > r.end_tick)) continue; // the match is over: leave the position as it is
        const short = r.short === 1;
        const wiped = short ? isShortLiquidated(mid, r.shares, collateralOf(r.credit_cents, r.cost_cents)) : isLiquidated(mid, r.shares, r.debt_cents);
        if (wiped) {
          if (this.close(r, companyId, tick, mid)) {
            closed.push({ accountId: r.account_id, companyId, reason: 'liquidated', short, shares: r.shares, priceCents: mid, realizedCents: -r.cost_cents, tick });
            this.dirty = true; // positions came and went: rebuild before the next look
          }
          continue;
        }
        // A stop-loss: a long position when the price falls to it, a short one when the price rises to it. A take-profit: the other way round.
        const stopped = r.stop_cents > 0 && (short ? mid >= r.stop_cents : mid <= r.stop_cents);
        const taken = r.take_cents > 0 && (short ? mid <= r.take_cents : mid >= r.take_cents);
        const kind = stopped ? 'stop' : taken ? 'take' : null;
        if (kind === null || !this.exitHandler) continue;
        const trade = this.exitHandler(r.account_id, companyId, kind, tick);
        if (trade) {
          this.exited += 1;
          closed.push({ accountId: r.account_id, companyId, reason: kind, short, shares: trade.filled, priceCents: Math.round(trade.avgPrice), realizedCents: trade.realizedCents, tick });
          this.dirty = true;
          this.o.log.info('liquidation', `A ${kind === 'stop' ? 'stop-loss' : 'take-profit'} closed a ${short ? 'short' : 'long'} position in ${world.companies[companyId]?.ticker ?? companyId} at about ${mid} (account ${r.account_id}).`);
        }
        // If it could not trade right now (trading halted, the server catching up) the position stays and the next tick tries again.
      }
    }
    if (closed.length > 0) this.o.onClosed?.(closed);
  }

  private rebuild(tick: number): void {
    const rows = this.o.db.all<PositionRow & { company_id: number }>(`SELECT p.company_id AS company_id, ${COLUMNS} ${FROM} WHERE ${WATCHED}`);
    const next = new Map<number, Band>();
    for (const r of rows) {
      // The prices at which this position is wiped out or triggered (a long: down to its debt per share, a short: up to its collateral per share).
      let low = Number.NEGATIVE_INFINITY;
      let high = Number.POSITIVE_INFINITY;
      if (r.short === 1) {
        high = collateralOf(r.credit_cents, r.cost_cents) / r.shares;
        if (r.stop_cents > 0) high = Math.min(high, r.stop_cents);
        if (r.take_cents > 0) low = r.take_cents;
      } else {
        if (r.debt_cents > 0) low = r.debt_cents / r.shares;
        if (r.stop_cents > 0) low = Math.max(low, r.stop_cents);
        if (r.take_cents > 0) high = r.take_cents;
      }
      const band = next.get(r.company_id);
      if (band) {
        band.low = Math.max(band.low, low);
        band.high = Math.min(band.high, high);
      } else next.set(r.company_id, { low, high });
    }
    this.levels = next;
    this.dirty = false;
    this.lastRebuild = tick;
  }

  /** Removes the position and writes the trade that says why, in one transaction. Returns false if it was already gone or is not wiped out. */
  private close(p: PositionRow, companyId: number, tick: number, mid: number): boolean {
    const { db, world, log } = this.o;
    const done = db.tx(() => {
      const now = db.get<PositionRow>('SELECT account_id, shares, cost_cents, debt_cents, short, credit_cents, stop_cents, take_cents FROM positions WHERE account_id = ? AND company_id = ?', p.account_id, companyId);
      const short = now?.short === 1;
      if (!now || !(short ? isShortLiquidated(mid, now.shares, collateralOf(now.credit_cents, now.cost_cents)) : isLiquidated(mid, now.shares, now.debt_cents))) return false;
      db.run('DELETE FROM positions WHERE account_id = ? AND company_id = ?', p.account_id, companyId);
      // A long position is closed by a forced sale and a short one by a forced purchase, at the market price, with nothing coming back.
      db.run(
        'INSERT INTO trades(account_id, client_order_id, company_id, side, requested, filled, total_cents, mid_cents, spread_cents, impact_cents, realized_cents, tick, created_ms, result_json, leverage, debt_cents, forced, short) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, 1, ?, 1, ?)',
        p.account_id,
        `liq-${companyId}-${tick}`,
        companyId,
        short ? 'buy' : 'sell',
        now.shares,
        now.shares,
        mid * now.shares, // what the shares were worth (a short: what buying them back cost): no more than the debt, or at least the collateral
        mid,
        -now.cost_cents, // the player loses the cash he put in
        tick,
        world.msOfTick(tick),
        JSON.stringify({ note: '', parts: [{ qty: now.shares, price: mid }] }),
        now.debt_cents,
        short ? 1 : 0,
      );
      return true;
    });
    if (done) {
      this.closed += 1;
      log.info('liquidation', `A ${p.short === 1 ? 'short' : 'leveraged'} position in ${world.companies[companyId]?.ticker ?? companyId} was closed at ${mid}: its margin was gone (account ${p.account_id}).`);
    }
    return done;
  }
}
