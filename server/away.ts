// "While you were away" (docs/world.md §33). When a player's last page closes, the server writes down what his account looked like: his net worth, his place on the
// leaderboard, what he held and the companies he launched, each with its price. When he comes back after a while (AWAY_MIN_MS), the server compares that with now and makes
// a short report: how his net worth moved, which holding moved most, how his companies did and who bought them, and where he stands. The report stays until he closes it, and a refresh of
// the page within a few minutes does not lose it (a page that was closed without pressing the button is counted as seen after AWAY_KEEP_MS).
//
// It only reads. It changes no money, no price and no order, and it tells nobody but the player himself.

import { scaleOf, unitsToCents } from '../src/world';
import type { User } from './auth';
import type { Daily } from './daily';
import type { Logger } from './log';
import type { Social } from './social';
import type { Db } from './sqlite';
import type { Trading } from './trading';
import type { WorldRuntime } from './world/runtime';

/** A player has to be away at least this long for a report (a refresh of the page, or a short break, makes none). */
export const AWAY_MIN_MS = 30 * 60_000;
/** The report speaks of at most this many companies of his. */
export const AWAY_MAX_COMPANIES = 3;
/** A report that was made this recently survives a refresh of the page (the page closes and opens again): the card is still there. After that, closing the page counts as having seen it. */
export const AWAY_KEEP_MS = 15 * 60_000;

export interface AwayDeps {
  readonly db: Db;
  readonly world: WorldRuntime;
  readonly trading: Trading;
  readonly social: Social;
  readonly daily: Daily;
  readonly now: () => number;
  readonly log: Logger;
  /** For tests: how long a player has to be away (default {@link AWAY_MIN_MS}). */
  readonly minAwayMs?: number;
}

interface Held {
  /** company id */
  readonly c: number;
  readonly shares: number;
  readonly short: boolean;
  /** price in cents when he left (a decimal number for a coin that costs a tiny fraction of a cent) */
  readonly p: number;
}

interface Snapshot {
  readonly holdings: readonly Held[];
  readonly launched: readonly { readonly c: number; readonly p: number }[];
}

export interface AwayReport {
  readonly seenMs: number;
  readonly nowMs: number;
  readonly awayMs: number;
  readonly netWorth: { readonly beforeCents: number; readonly nowCents: number; readonly changeCents: number; readonly changePct: number } | null;
  readonly rank: { readonly before: number; readonly now: number } | null;
  /** The holding whose value changed most (in cents), or null when nothing changed. */
  readonly mover: { readonly ticker: string; readonly name: string; readonly changePct: number; readonly changeCents: number; readonly short: boolean } | null;
  /** Companies he launched that moved or were bought. */
  readonly companies: readonly { readonly ticker: string; readonly name: string; readonly changePct: number | null; readonly newInvestors: number }[];
}

export interface AwayView {
  readonly report: AwayReport;
  /** Fresh when the report is read: the streak and the goals still open today (a reason to stay). */
  readonly today: { readonly streak: number; readonly atRisk: boolean; readonly goalsLeft: number };
}

interface MarkRow {
  user_id: number;
  seen_ms: number;
  net_worth_cents: number | null;
  rank: number | null;
  holdings: string;
  report: string | null;
}

export class Away {
  constructor(private readonly d: AwayDeps) {}

  private isBot(userId: number): boolean {
    return this.d.db.get('SELECT 1 AS x FROM bots WHERE user_id = ?', userId) !== undefined;
  }

  /** The price of a company in cents now (null when it is not trading). */
  private priceCents(companyId: number): number | null {
    const c = this.d.world.companies[companyId];
    if (!c || !this.d.world.sim.isListed(companyId)) return null;
    return unitsToCents(this.d.world.sim.price(companyId), scaleOf(c));
  }

  // ---- when the last page closes -------------------------------------------------------------------------------------

  /** Writes down how the player's account looks now. A report that is fresh (made in the last AWAY_KEEP_MS) and not closed yet is kept as it is, so a refresh does not lose it. */
  snapshot(userId: number): void {
    if (this.isBot(userId)) return;
    const { db } = this.d;
    const kept = db.get<{ report: string | null; report_ms: number | null }>('SELECT report, report_ms FROM away_marks WHERE user_id = ?', userId);
    if (kept?.report && kept.report_ms !== null && this.d.now() - kept.report_ms < AWAY_KEEP_MS) return;
    const account = db.get<{ id: number }>("SELECT id FROM accounts WHERE user_id = ? AND kind = 'career'", userId);
    if (!account) return;
    const view = this.d.trading.view(account.id);
    const standing = this.d.social.standing(userId);
    const holdings: Held[] = [];
    for (const p of view.positions) {
      const price = this.priceCents(p.companyId);
      if (price !== null) holdings.push({ c: p.companyId, shares: p.shares, short: p.short, p: price });
    }
    const launched: { c: number; p: number }[] = [];
    for (const r of db.all<{ company_id: number }>('SELECT company_id FROM launches WHERE user_id = ?', userId)) {
      const price = this.priceCents(r.company_id);
      if (price !== null) launched.push({ c: r.company_id, p: price });
    }
    const data: Snapshot = { holdings, launched };
    db.run(
      `INSERT INTO away_marks(user_id, seen_ms, net_worth_cents, rank, holdings, report, report_ms) VALUES (?, ?, ?, ?, ?, NULL, NULL)
       ON CONFLICT(user_id) DO UPDATE SET seen_ms = excluded.seen_ms, net_worth_cents = excluded.net_worth_cents, rank = excluded.rank, holdings = excluded.holdings, report = NULL, report_ms = NULL`,
      userId,
      this.d.now(),
      standing?.netWorthCents ?? view.netWorthCents,
      standing?.rank ?? null,
      JSON.stringify(data),
    );
  }

  // ---- when he comes back --------------------------------------------------------------------------------------------

  private build(userId: number, row: MarkRow): AwayReport {
    const { db } = this.d;
    const nowMs = this.d.now();
    const snap = JSON.parse(row.holdings) as Snapshot;
    const standing = this.d.social.standing(userId);
    let netWorth: AwayReport['netWorth'] = null;
    if (row.net_worth_cents !== null && standing?.netWorthCents !== null && standing?.netWorthCents !== undefined) {
      const change = standing.netWorthCents - row.net_worth_cents;
      netWorth = { beforeCents: row.net_worth_cents, nowCents: standing.netWorthCents, changeCents: change, changePct: row.net_worth_cents > 0 ? Math.round((change / row.net_worth_cents) * 10_000) / 100 : 0 };
    }
    const rank = row.rank !== null && standing?.rank !== null && standing?.rank !== undefined ? { before: row.rank, now: standing.rank } : null;
    let mover: AwayReport['mover'] = null;
    let best = 0;
    for (const h of snap.holdings) {
      const now = this.priceCents(h.c);
      const company = this.d.world.companies[h.c];
      if (now === null || !company || h.p <= 0) continue;
      const change = Math.round((now - h.p) * h.shares * (h.short ? -1 : 1));
      if (Math.abs(change) > Math.abs(best)) {
        best = change;
        mover = { ticker: company.ticker, name: company.name, changePct: Math.round(((now - h.p) / h.p) * 10_000) / 100 * (h.short ? -1 : 1), changeCents: change, short: h.short };
      }
    }
    const companies: { ticker: string; name: string; changePct: number | null; newInvestors: number }[] = [];
    for (const l of snap.launched) {
      const company = this.d.world.companies[l.c];
      if (!company) continue;
      const now = this.priceCents(l.c);
      const investors =
        db.get<{ n: number }>(
          `SELECT COUNT(DISTINCT a.user_id) AS n FROM trades t JOIN accounts a ON a.id = t.account_id
            WHERE t.company_id = ? AND t.side = 'buy' AND a.kind = 'career' AND a.user_id <> ? AND t.created_ms > ?
              AND NOT EXISTS (SELECT 1 FROM bots b WHERE b.user_id = a.user_id)`,
          l.c,
          userId,
          row.seen_ms,
        )?.n ?? 0;
      const pct = now !== null && l.p > 0 ? Math.round(((now - l.p) / l.p) * 10_000) / 100 : null;
      if (investors === 0 && (pct === null || Math.abs(pct) < 0.01)) continue;
      companies.push({ ticker: company.ticker, name: company.name, changePct: pct, newInvestors: investors });
    }
    companies.sort((a, b) => b.newInvestors - a.newInvestors || Math.abs(b.changePct ?? 0) - Math.abs(a.changePct ?? 0));
    return { seenMs: row.seen_ms, nowMs, awayMs: nowMs - row.seen_ms, netWorth, rank, mover, companies: companies.slice(0, AWAY_MAX_COMPANIES) };
  }

  /** The report for a player who has come back after a while, or null (never away long enough, or he has closed it). */
  view(me: User): AwayView | null {
    const { db } = this.d;
    const row = db.get<MarkRow>('SELECT user_id, seen_ms, net_worth_cents, rank, holdings, report FROM away_marks WHERE user_id = ?', me.id);
    if (!row) return null;
    let report: AwayReport;
    if (row.report) {
      report = JSON.parse(row.report) as AwayReport;
    } else {
      if (this.d.now() - row.seen_ms < (this.d.minAwayMs ?? AWAY_MIN_MS)) {
        // Only a refresh or a short break: nothing to report, and the next time the page closes a new picture is taken.
        db.run('DELETE FROM away_marks WHERE user_id = ? AND report IS NULL', me.id);
        return null;
      }
      report = this.build(me.id, row);
      db.run('UPDATE away_marks SET report = ?, report_ms = ? WHERE user_id = ?', JSON.stringify(report), this.d.now(), me.id);
    }
    const goals = this.d.daily.summary(me.id);
    return { report, today: { streak: goals.streak.current, atRisk: goals.streak.atRisk, goalsLeft: goals.goalsLeft } };
  }

  /** He closed the report. */
  dismiss(userId: number): void {
    this.d.db.run('DELETE FROM away_marks WHERE user_id = ?', userId);
  }
}
