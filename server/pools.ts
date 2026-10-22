// The money pool behind a memecoin that a player launched (docs/world.md §12.2).
//
// A coin that is launched with this version has a pool of real cash, like a coin on pump.fun:
//
//   • What buyers pay goes IN. Every Career buy of the coin puts everything it cost (without the trading fee, which is gone) into the pool, and
//     the launching player's first buy is the pool's first deposit.
//   • What sellers get comes OUT. A sale is paid from the pool, so it can never be paid with more cash than the pool has: a sale that is bigger
//     than the pool is filled only as far as the pool can pay (a smaller part of it), and with an empty pool nothing can be sold.
//   • The launching player can take it ALL (the "rug pull", server/launch.ts): the whole pool becomes his cash and the coin is dead. The coins that
//     other players still hold are worth nothing then and cannot be sold, and the price crashes.
//
// The PRICE does not come from the pool. It is still made by the market engine and the players' buying and selling pushes, exactly like every other
// company (the pool is the cash behind the price, not the price itself). That is why a pool coin only takes plain buying and selling: no leverage,
// no shorting, no stop-loss or take-profit, no limit orders (all of them would let a player borrow, or be paid, against a pool that its developer can
// empty). A coin launched before this version has no pool row and works exactly as it did.

import type { Db } from './sqlite';

export interface PoolRow {
  company_id: number;
  /** The cash in the pool right now. Always in_cents − out_cents − drained_cents (the database checks it). */
  pool_cents: number;
  /** Everything buyers ever paid in (the launching player's first buy included) and everything sellers took out. */
  in_cents: number;
  out_cents: number;
  /** What the rug pull took (0 until it happened) and when. */
  drained_cents: number;
  drained_ms: number | null;
  drain_request_id: string | null;
}

export const POOL_COLUMNS = 'company_id, pool_cents, in_cents, out_cents, drained_cents, drained_ms, drain_request_id';

/** The pool behind a coin, or null when it has none (every company except the coins launched with this version). */
export function poolOf(db: Db, companyId: number): PoolRow | null {
  return db.get<PoolRow>(`SELECT ${POOL_COLUMNS} FROM coin_pools WHERE company_id = ?`, companyId) ?? null;
}

/** True once the developer has taken the whole pool: the coin is worthless and nothing can be bought or sold. */
export function isDead(pool: PoolRow | null | undefined): boolean {
  return pool !== null && pool !== undefined && pool.drained_ms !== null;
}

/** The ids of the coins whose pool has been taken (they are worth nothing). */
export function deadCompanyIds(db: Db): Set<number> {
  return new Set(db.all<{ company_id: number }>('SELECT company_id FROM coin_pools WHERE drained_ms IS NOT NULL').map((r) => r.company_id));
}

/** A new pool for a coin that was just launched: the launching player's first buy (0 for a free launch) is its first deposit. */
export function createPool(db: Db, companyId: number, firstBuyCents: number): void {
  db.run('INSERT INTO coin_pools(company_id, pool_cents, in_cents) VALUES (?, ?, ?)', companyId, firstBuyCents, firstBuyCents);
}

/** Buyers paid this much for coins: it goes into the pool. */
export function payIn(db: Db, companyId: number, cents: number): void {
  if (cents <= 0) return;
  db.run('UPDATE coin_pools SET pool_cents = pool_cents + ?, in_cents = in_cents + ? WHERE company_id = ?', cents, cents, companyId);
}

/** A seller was paid this much for coins: it comes out of the pool (the database refuses it if the pool does not have it). */
export function payOut(db: Db, companyId: number, cents: number): void {
  if (cents <= 0) return;
  db.run('UPDATE coin_pools SET pool_cents = pool_cents - ?, out_cents = out_cents + ? WHERE company_id = ?', cents, cents, companyId);
}

/** Takes everything that is in the pool for the developer and kills the coin. Returns what was taken. */
export function drain(db: Db, companyId: number, requestId: string, nowMs: number): number {
  const pool = poolOf(db, companyId);
  if (!pool || pool.drained_ms !== null) return 0;
  db.run('UPDATE coin_pools SET pool_cents = 0, drained_cents = drained_cents + ?, drained_ms = ?, drain_request_id = ? WHERE company_id = ?', pool.pool_cents, nowMs, requestId, companyId);
  return pool.pool_cents;
}

// ---- the sentences players see ------------------------------------------------------------------------------------------------------

export const POOL_SPOT_ONLY =
  'Coins that players launch can only be bought and sold at the market price: the money behind them sits in a pool that the developer can take, so there is no leverage, no shorting, no stop-loss or take-profit and no limit orders on them.';

export function deadMessage(ticker: string): string {
  return `The developer of ${ticker} took all the money out of its pool (a rug pull). ${ticker} is worthless now and cannot be bought or sold.`;
}
