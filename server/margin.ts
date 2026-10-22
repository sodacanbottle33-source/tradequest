// What borrowing costs, and when the market warns you (docs/world.md §6.1).
//
//   • INTEREST. The borrowed part of a leveraged long position (its debt) costs interest, charged to the debt: 10 % a year on a stock,
//     40 % a year on a memecoin (a coin's leverage is the riskiest to lend). The interest is added to the debt, so it lowers what the
//     position is worth to its owner and raises the price at which the market closes it.
//   • BORROW FEE. A short position borrows shares, and the fee is taken out of the money from the sale that sits on the position (its
//     "credit"), so it lowers what comes back when the shares are bought back. A liquid stock is cheap to borrow (0.5 % a year), a thin one
//     dear (up to 10.5 %), a memecoin 40 %. The fee is charged on the money from the sale.
//   • Only Career accounts pay. A 1v1 match lasts three minutes and has none of it.
//   • How it is counted: every position remembers the tick up to which it has been charged (`accrued_tick`). Every minute, and before any
//     order that changes the position, the cost for the ticks since then is worked out to the cent with whole numbers; if it is less
//     than a cent nothing is charged yet and the time keeps counting, so splitting the time into small steps does not change the total (to
//     within a cent). An order that changes the position settles it and starts a new count, so a part of a cent can be dropped there.
//   • MARGIN CALL. When a leveraged or short position has lost three quarters of the cash put into it (its equity is at or below 25 %
//     of it), the player gets a warning pop-up once, before the market closes it. It can warn again after the position has recovered to
//     50 % or more.

import { equityOf } from './leverage';
import type { Db } from './sqlite';

/** One year in market ticks (1 tick = 1 second). */
export const TICKS_PER_YEAR = 365 * 86_400;
/** Costs are charged every this many ticks (a minute), and before any order that changes the position. */
export const ACCRUE_EVERY_TICKS = 60;
/** The market warns every this many ticks. */
export const WARN_EVERY_TICKS = 5;
/** Margin call at or below this share of the cash put in; the warning can come again after the position is back above RESET. */
export const MARGIN_CALL_SHARE = 0.25;
export const MARGIN_CALL_RESET = 0.5;

/** What the code needs to know about a company to price its borrowing. */
export interface CostCompany {
  readonly sector: string;
  readonly liquidity: number;
}

/** Interest on the borrowed part of a leveraged long, in basis points a year. */
export function interestBps(c: Pick<CostCompany, 'sector'>): number {
  return c.sector === 'meme' ? 4000 : 1000;
}

/** Fee for borrowing the shares of a short, in basis points a year: dear for thin companies. */
export function borrowBps(c: CostCompany): number {
  if (c.sector === 'meme') return 4000;
  const thin = 1 - Math.max(0, Math.min(1, c.liquidity));
  return 50 + Math.round(thin * 1000);
}

/** What `baseCents` costs at `bps` a year for `elapsedTicks`: whole cents, and the ticks that paid for them (to the nearest tick, never more than `elapsedTicks`). */
export function accrue(baseCents: number, bps: number, elapsedTicks: number): { due: number; usedTicks: number } {
  if (!(baseCents > 0) || !(bps > 0) || !(elapsedTicks > 0)) return { due: 0, usedTicks: 0 };
  const per = BigInt(10_000) * BigInt(TICKS_PER_YEAR);
  const rate = BigInt(baseCents) * BigInt(bps);
  const due = (rate * BigInt(elapsedTicks)) / per;
  if (due === BigInt(0)) return { due: 0, usedTicks: 0 };
  // The ticks that pay for `due` cents, to the nearest tick (so the rounding does not favour either side over many charges).
  const used = (BigInt(2) * due * per + rate) / (BigInt(2) * rate);
  return { due: Number(due), usedTicks: Math.min(elapsedTicks, Number(used)) };
}

/** What a loan or a borrowed sale costs per day, in cents (for showing; the real charge is worked out per tick). */
export function costPerDay(baseCents: number, bps: number): number {
  if (!(baseCents > 0) || !(bps > 0)) return 0;
  return Math.round((baseCents * bps) / 10_000 / 365);
}

export interface MarginWorld {
  readonly companies: readonly CostCompany[];
  readonly sim: { price(companyId: number): number; isListed(companyId: number): boolean };
}

/** A position that crossed into its margin call. */
export interface MarginCall {
  readonly accountId: number;
  readonly companyId: number;
  readonly short: boolean;
  readonly shares: number;
  readonly priceCents: number;
  /** What is left of the cash put in, minus the cash put in (negative). */
  readonly unrealizedCents: number;
  readonly leverage: number;
  readonly liqPriceCents: number;
  readonly tick: number;
}

interface CostRow {
  account_id: number;
  company_id: number;
  shares: number;
  cost_cents: number;
  debt_cents: number;
  credit_cents: number;
  short: number;
  accrued_tick: number | null;
}

const CAREER_WITH_COST = "a.kind = 'career' AND (p.debt_cents > 0 OR p.short = 1)";

export class MarginCosts {
  /** Positions that have been warned and have not recovered yet ("account:company"). */
  private readonly warned = new Set<string>();

  constructor(
    private readonly db: Db,
    private readonly world: MarginWorld,
    /** Something that changes what a position can be closed at has happened (interest was charged): the liquidator must look again. */
    private readonly onChanged: () => void,
  ) {}

  /**
   * Charges one position what it owes up to `tick` (a no-op for a match account, a plain long, or less than a cent owed). Call it inside the
   * transaction of an order that is about to change the position, and from the minute step. Returns the cents charged.
   */
  settle(accountId: number, companyId: number, tick: number): number {
    const row = this.db.get<CostRow & { kind: string }>(
      'SELECT p.account_id, p.company_id, p.shares, p.cost_cents, p.debt_cents, p.credit_cents, p.short, p.accrued_tick, a.kind FROM positions p JOIN accounts a ON a.id = p.account_id WHERE p.account_id = ? AND p.company_id = ?',
      accountId,
      companyId,
    );
    if (!row || row.kind !== 'career') return 0;
    const company = this.world.companies[companyId];
    if (!company) return 0;
    const short = row.short === 1;
    const base = short ? row.credit_cents : row.debt_cents;
    if (base <= 0) return 0;
    if (row.accrued_tick === null) {
      // A position from before costs existed: it starts paying from now.
      this.db.run('UPDATE positions SET accrued_tick = ? WHERE account_id = ? AND company_id = ?', tick, accountId, companyId);
      return 0;
    }
    const elapsed = tick - row.accrued_tick;
    if (elapsed <= 0) return 0;
    const { due, usedTicks } = accrue(base, short ? borrowBps(company) : interestBps(company), elapsed);
    if (due === 0) return 0;
    if (short) {
      const paid = Math.min(due, row.credit_cents);
      this.db.run('UPDATE positions SET credit_cents = credit_cents - ?, charged_cents = charged_cents + ?, accrued_tick = accrued_tick + ? WHERE account_id = ? AND company_id = ?', paid, paid, usedTicks, accountId, companyId);
      return paid;
    }
    this.db.run('UPDATE positions SET debt_cents = debt_cents + ?, charged_cents = charged_cents + ?, accrued_tick = accrued_tick + ? WHERE account_id = ? AND company_id = ?', due, due, usedTicks, accountId, companyId);
    return due;
  }

  /** Once a minute: every Career position with a loan or a borrowed sale pays what it owes. Call once per market tick (also the replayed ones). */
  step(tick: number): void {
    if (tick % ACCRUE_EVERY_TICKS !== 0) return;
    const rows = this.db.all<{ account_id: number; company_id: number }>(`SELECT p.account_id, p.company_id FROM positions p JOIN accounts a ON a.id = p.account_id WHERE ${CAREER_WITH_COST}`);
    if (rows.length === 0) return;
    let changed = false;
    this.db.tx(() => {
      for (const r of rows) if (this.settle(r.account_id, r.company_id, tick) > 0) changed = true;
    });
    if (changed) this.onChanged();
  }

  /**
   * Every few ticks: positions that have just lost three quarters of their margin. Returns the new margin calls (each position once, until it
   * has recovered to half its margin). Only for the live market: do not call it while the market catches up.
   */
  warnings(tick: number): MarginCall[] {
    if (tick % WARN_EVERY_TICKS !== 0) return [];
    const rows = this.db.all<CostRow>(`SELECT p.account_id, p.company_id, p.shares, p.cost_cents, p.debt_cents, p.credit_cents, p.short, p.accrued_tick FROM positions p JOIN accounts a ON a.id = p.account_id WHERE ${CAREER_WITH_COST}`);
    const live = new Set<string>();
    const out: MarginCall[] = [];
    for (const r of rows) {
      const key = `${r.account_id}:${r.company_id}`;
      live.add(key);
      if (r.cost_cents <= 0 || !this.world.sim.isListed(r.company_id)) continue;
      const price = this.world.sim.price(r.company_id);
      const short = r.short === 1;
      const equity = equityOf({ shares: r.shares, costCents: r.cost_cents, debtCents: r.debt_cents, short, creditCents: r.credit_cents }, price);
      const share = equity / r.cost_cents;
      if (share > MARGIN_CALL_RESET) {
        this.warned.delete(key);
        continue;
      }
      if (share > MARGIN_CALL_SHARE || equity <= 0 || this.warned.has(key)) continue; // (a position with nothing left is being closed, not warned)
      this.warned.add(key);
      const collateral = r.credit_cents + r.cost_cents;
      out.push({
        accountId: r.account_id,
        companyId: r.company_id,
        short,
        shares: r.shares,
        priceCents: price,
        unrealizedCents: equity - r.cost_cents,
        leverage: Math.round(((short ? r.credit_cents : r.cost_cents + r.debt_cents) / r.cost_cents) * 10) / 10,
        liqPriceCents: short ? Math.ceil(collateral / r.shares) : Math.floor(r.debt_cents / r.shares),
        tick,
      });
    }
    for (const key of [...this.warned]) if (!live.has(key)) this.warned.delete(key);
    return out;
  }
}
