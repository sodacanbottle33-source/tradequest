// Companies whose trading the owner has stopped, and the owner's "pause everything" switch. The company set is kept in memory and
// in the database (table trading_halts); the switch is a setting (meta key trading_paused). Orders for a halted company, or for any
// company while everything is paused, are refused and the market list shows them as halted. Prices keep moving: a halt stops
// TRADING, not time.
//
// The market can also pause a company by itself (automatic pauses, "circuit breaker", server/breaker.ts): when its price has moved
// 10 % within 5 minutes, trading in it stops for 5 minutes. Those pauses live in the table auto_pauses and end on their own;
// they count as halted everywhere (orders refused, "Halted" in the lists), but they are not the owner's halts.

import type { Db } from './sqlite';

export interface HaltView {
  readonly companyId: number;
  readonly reason: string;
  readonly haltedMs: number;
}

export interface PauseView {
  readonly reason: string;
  readonly sinceMs: number;
}

/** An automatic pause (all ticks are market seconds, prices are cents, moveBps is signed: -1000 = the price fell 10 %). */
export interface AutoPauseView {
  readonly companyId: number;
  readonly sinceTick: number;
  readonly untilTick: number;
  readonly fromPrice: number;
  readonly toPrice: number;
  readonly moveBps: number;
}

const PAUSE_KEY = 'trading_paused';

export class Halts {
  private ids = new Set<number>();
  private paused: PauseView | null = null;
  private auto = new Map<number, AutoPauseView>();
  private tickNow: () => number = () => 0;

  constructor(private readonly db: Db) {
    this.reload();
  }

  reload(): void {
    this.ids = new Set(this.db.all<{ company_id: number }>('SELECT company_id FROM trading_halts').map((r) => r.company_id));
    this.paused = this.readPause();
    this.auto = new Map(
      this.db
        .all<{ company_id: number; since_tick: number; until_tick: number; from_price: number; to_price: number; move_bps: number }>('SELECT company_id, since_tick, until_tick, from_price, to_price, move_bps FROM auto_pauses')
        .map((r) => [r.company_id, { companyId: r.company_id, sinceTick: r.since_tick, untilTick: r.until_tick, fromPrice: r.from_price, toPrice: r.to_price, moveBps: r.move_bps }]),
    );
  }

  /** Tells the pauses what the market's tick is now (they end by themselves when it reaches their end). */
  setClock(tick: () => number): void {
    this.tickNow = tick;
  }

  private readPause(): PauseView | null {
    const raw = this.db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', PAUSE_KEY)?.value;
    if (!raw) return null;
    try {
      const v = JSON.parse(raw) as { reason?: unknown; sinceMs?: unknown };
      return { reason: typeof v.reason === 'string' ? v.reason : '', sinceMs: typeof v.sinceMs === 'number' ? v.sinceMs : 0 };
    } catch {
      return null;
    }
  }

  /** True while the owner has paused ALL trading (every company, Career and 1v1). */
  allPaused(): PauseView | null {
    return this.paused;
  }

  isHalted(companyId: number): boolean {
    return this.paused !== null || this.ids.has(companyId) || this.autoPauseOf(companyId) !== null;
  }

  /** The automatic pause this company is in right now, or null (also null once its time has run out). */
  autoPauseOf(companyId: number): AutoPauseView | null {
    const p = this.auto.get(companyId);
    return p !== undefined && p.untilTick > this.tickNow() ? p : null;
  }

  /** Every automatic pause that is still running. */
  autoList(): AutoPauseView[] {
    const now = this.tickNow();
    return [...this.auto.values()].filter((p) => p.untilTick > now).sort((a, b) => a.companyId - b.companyId);
  }

  /** Starts (or replaces) an automatic pause. */
  startAuto(p: AutoPauseView): void {
    this.db.run(
      'INSERT INTO auto_pauses(company_id, since_tick, until_tick, from_price, to_price, move_bps) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(company_id) DO UPDATE SET since_tick = excluded.since_tick, until_tick = excluded.until_tick, from_price = excluded.from_price, to_price = excluded.to_price, move_bps = excluded.move_bps',
      p.companyId,
      p.sinceTick,
      p.untilTick,
      p.fromPrice,
      p.toPrice,
      p.moveBps,
    );
    this.auto.set(p.companyId, p);
  }

  /** Ends a company's automatic pause now (the owner's "resume"). True if there was one. */
  endAuto(companyId: number): boolean {
    const had = this.auto.has(companyId);
    this.db.run('DELETE FROM auto_pauses WHERE company_id = ?', companyId);
    this.auto.delete(companyId);
    return had;
  }

  /** Removes the rows of pauses that have run out. Returns the companies that were released. */
  expireAuto(tick: number): number[] {
    const done = [...this.auto.values()].filter((p) => p.untilTick <= tick).map((p) => p.companyId);
    for (const id of done) {
      this.db.run('DELETE FROM auto_pauses WHERE company_id = ?', id);
      this.auto.delete(id);
    }
    return done;
  }

  /** True only if this one company was halted by itself (not because everything is paused). */
  isHaltedItself(companyId: number): boolean {
    return this.ids.has(companyId);
  }

  reasonOf(companyId: number): string {
    if (this.ids.has(companyId)) return this.db.get<{ reason: string }>('SELECT reason FROM trading_halts WHERE company_id = ?', companyId)?.reason ?? '';
    if (this.paused !== null) return this.paused.reason;
    const a = this.autoPauseOf(companyId);
    return a ? autoPauseReason(a, this.tickNow()) : '';
  }

  /** Pauses (reason, time) or reopens (null) all trading. Call inside the transaction that also writes the admin log. */
  setPaused(pause: PauseView | null): void {
    if (pause === null) this.db.run('DELETE FROM meta WHERE key = ?', PAUSE_KEY);
    else this.db.run('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', PAUSE_KEY, JSON.stringify(pause));
    this.paused = pause;
  }

  list(): HaltView[] {
    return this.db
      .all<{ company_id: number; reason: string; halted_ms: number }>('SELECT company_id, reason, halted_ms FROM trading_halts ORDER BY company_id')
      .map((r) => ({ companyId: r.company_id, reason: r.reason, haltedMs: r.halted_ms }));
  }

  /** Call inside the transaction that also writes the admin log. */
  halt(companyId: number, reason: string, byUserId: number, nowMs: number): void {
    this.db.run(
      'INSERT INTO trading_halts(company_id, reason, halted_ms, by_user_id) VALUES (?, ?, ?, ?) ON CONFLICT(company_id) DO UPDATE SET reason = excluded.reason, halted_ms = excluded.halted_ms, by_user_id = excluded.by_user_id',
      companyId,
      reason,
      nowMs,
      byUserId,
    );
    this.ids.add(companyId);
  }

  resume(companyId: number): void {
    this.db.run('DELETE FROM trading_halts WHERE company_id = ?', companyId);
    this.ids.delete(companyId);
  }
}

/** "paused automatically: the price fell 12.3% within 5 minutes; reopens in about 4 minutes" for an automatic pause. */
export function autoPauseReason(p: AutoPauseView, tick: number): string {
  const pct = Math.abs(p.moveBps) / 100;
  const shown = pct >= 100 ? Math.round(pct).toLocaleString('en-US') : pct.toFixed(1);
  const left = Math.max(0, p.untilTick - tick);
  const minutes = Math.ceil(left / 60);
  return `paused automatically: the price ${p.moveBps < 0 ? 'fell' : 'rose'} ${shown}% within 5 minutes; reopens ${left < 60 ? 'in under a minute' : `in about ${minutes} minute${minutes === 1 ? '' : 's'}`}`;
}
