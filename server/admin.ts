// The owner's tools: move a company's price (rug pull, crash, pump), stop and resume trading (one company or everything), give or
// take Career cash, coins and shares, ban and unban players, reset a Career account, post an announcement, set how strongly
// player trades move prices, and make a company of your own. Only the owner may use any of it (the routes check the role on the server every time), and every
// action is written once to the admin log.
//
// A price move is NOT a trick on the price engine. It is an ordinary news story (source "admin") that is written to the news
// table first and handed to the world afterwards. The engine applies it exactly like any other story, so prices stay a pure
// function of (seed, catalog, stored events): after a restart the replay gives the very same prices.

import {
  CURATED,
  MAX_COMPANIES,
  TICKS_PER_HOUR,
  TICK_MS,
  adminDraft,
  cycleOfTick,
  effectiveDuration,
  fill,
  weightAt,
  type Company,
  type NewsDraft,
  type Shape,
  type Strength,
} from '../src/world';
import { START_CASH_CENTS, type Auth, type BanInfo, type User } from './auth';
import { autoPauseReason, type Halts, type PauseView } from './halts';
import { MEME_SEEDS } from '../src/world';
import { MAX_OWN_COMPANIES, makeEntry, stockOptions, type StockInput, type StockOptions } from './customStock';
import { HttpError } from './http';
import { debtShare } from './leverage';
import type { MatchService } from './lobby/service';
import type { Logger } from './log';
import type { NewsService } from './news/service';
import type { Db } from './sqlite';
import type { SseHub } from './sse';
import type { Trading } from './trading';
import type { MarketViews } from './world/views';
import { OWN_LISTING_DELAY_TICKS, type WorldRuntime } from './world/runtime';

export const MIN_PERCENT = -99;
export const MAX_PERCENT = 900;
/** The most cash or coins that one action may add or take (cents): $1,000,000,000. */
export const MAX_AMOUNT_CENTS = 100_000_000_000;
export const STYLES = ['rug', 'crash', 'pump', 'custom'] as const;
export type Style = (typeof STYLES)[number];
export const SPEEDS = ['instant', 'fast', 'slow'] as const;
export type Speed = (typeof SPEEDS)[number];
/** The most shares one action may give or take. */
export const MAX_SHARES_PER_ACTION = 1_000_000;
/** The longest timed ban: one year (in hours). A longer one is a ban "until lifted". */
export const MAX_BAN_HOURS = 24 * 365;
export const ANNOUNCEMENT_MAX = 200;
const ANNOUNCEMENT_KEY = 'announcement';

/** Every kind of entry in the admin log. */
export type AdminAction = 'shock' | 'halt' | 'resume' | 'cash' | 'coins' | 'ban' | 'unban' | 'shares' | 'reset' | 'announce' | 'pause' | 'unpause' | 'stock' | 'coin' | 'chat_delete' | 'chat_mute' | 'chat_ban' | 'chat_lift' | 'chat_dismiss' | 'pm_dismiss';

export interface Announcement {
  readonly text: string;
  readonly ms: number;
}

/** What every player's page shows at the top: the owner's announcement and whether all trading is paused. */
export interface Notice {
  readonly announcement: Announcement | null;
  readonly paused: PauseView | null;
}

/** How a move is spread over time. "instant" is the engine's burst (6 seconds); the others start strong and taper off. */
const PACE: Record<Speed, { shape: Shape; ticks: number }> = {
  instant: { shape: 'burst', ticks: 6 },
  fast: { shape: 'front', ticks: 300 },
  slow: { shape: 'front', ticks: TICKS_PER_HOUR },
};

const TEXT: Record<Exclude<Style, 'custom'>, readonly [string, string]> = {
  rug: [
    '{co} collapses as insiders vanish with investor money',
    'Shares of {co} fell off a cliff after reports that its leaders have disappeared with a large part of the company’s cash. Traders are rushing to sell whatever they can.',
  ],
  crash: ['{co} plunges in a sudden sell-off', 'Shares of {co} dropped sharply as investors rushed to sell after a surprise shock to the company.'],
  pump: ['{co} rockets as buyers pile in', 'Shares of {co} jumped as a wave of buying swept through the stock, catching even long-time holders by surprise.'],
};

/** About how many seconds pass between making a company and its first trade. */
const OWN_LISTING_SECONDS = Math.round((OWN_LISTING_DELAY_TICKS * TICK_MS) / 1000);

const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;
const SPECIAL_SLOT = 900;

export interface ShockInput {
  readonly requestId: string;
  readonly ticker: string;
  readonly percent: number;
  readonly style: Style;
  readonly speed: Speed;
  readonly headline?: string;
  readonly body?: string;
  readonly breaking?: boolean;
}

export interface PlayerRow {
  readonly id: number;
  readonly username: string;
  readonly role: 'player' | 'owner';
  readonly createdMs: number;
  readonly cashCents: number;
  readonly netWorthCents: number;
  readonly coinsCents: number;
  /** The ban in force right now, or null. */
  readonly banned: BanInfo | null;
}

/** A company the owner made. */
export interface OwnStock {
  readonly id: number;
  readonly ticker: string;
  readonly name: string;
  readonly sector: string;
  readonly tier: string;
  readonly personality: string;
  readonly startPriceCents: number;
  readonly createdMs: number;
  /** False while it is saved but not yet running in the market (it then starts at the next server start). */
  readonly loaded: boolean;
  readonly trading: boolean;
  readonly listsInTicks: number;
  readonly priceCents: number;
  readonly halted: boolean;
}

/** A stock or memecoin a player launched (server/launch.ts), as the owner sees it. */
export interface AdminLaunch {
  readonly id: number;
  readonly ticker: string;
  readonly name: string;
  readonly kind: 'stock' | 'coin';
  /** Who launched it. */
  readonly username: string;
  readonly createdMs: number;
  /** The money taken from the player's cash, and the shares it bought. */
  readonly spentCents: number;
  readonly stakeShares: number;
  readonly startPriceCents: number;
  /** What the launcher holds of it now. */
  readonly sharesNow: number;
  readonly trading: boolean;
  readonly priceCents: number;
  readonly halted: boolean;
  /** Rug pulls so far: orders, shares sold, cash paid out. */
  readonly rugs: number;
  readonly ruggedShares: number;
  readonly ruggedCents: number;
  /** The money pool behind a coin launched with one (null for a stock and for a coin from before pools): what is in it, what buyers paid in, what sellers took out, what the rug pull took. */
  readonly pool: { readonly cents: number; readonly inCents: number; readonly outCents: number; readonly drainedCents: number; readonly dead: boolean } | null;
}

export interface AdminState {
  readonly announcement: Announcement | null;
  /** Set while the owner has paused ALL trading. */
  readonly paused: PauseView | null;
  readonly halts: { ticker: string; name: string; reason: string; haltedMs: number; auto: boolean }[];
  readonly events: {
    id: number;
    ticker: string | null;
    headline: string;
    direction: string;
    publishTick: number;
    startTick: number;
    endTick: number;
    priceAtPublish: number | null;
    priceAtEnd: number | null;
  }[];
  readonly players: PlayerRow[];
  /** Companies the owner made (newest first) and what the "Create stock" form offers. */
  readonly stocks: OwnStock[];
  readonly stockForm: StockOptions;
  /** Stocks and memecoins that players launched (newest first). */
  readonly launches: AdminLaunch[];
  readonly log: { id: number; createdMs: number; admin: string; action: string; target: string; detail: Record<string, unknown> }[];
}

export interface AdminDeps {
  readonly db: Db;
  readonly auth: Auth;
  readonly matches: MatchService;
  readonly hub: SseHub;
  readonly world: WorldRuntime;
  readonly news: NewsService | null;
  readonly trading: Trading;
  readonly halts: Halts;
  readonly views: MarketViews;
  readonly log: Logger;
  readonly now: () => number;
}

/**
 * The total move T (a signed fraction, stored as the story's "realised" number) that makes the price end up `multiplier` times
 * as high, given how the engine spreads a story: each tick the price is multiplied by (1 + T × weight of that tick). Solved by
 * bisection on the logarithm. The real result varies a little (the engine scales news with the stock's mood), so the screens say "about".
 */
export function solveTotal(multiplier: number, shape: Shape, durationTicks: number): number {
  if (!(multiplier > 0)) throw new Error('The price multiplier must be positive');
  const d = effectiveDuration(shape, durationTicks);
  let wMax = 0;
  for (let k = 0; k < d; k += 1) wMax = Math.max(wMax, weightAt(shape, durationTicks, k));
  const target = Math.log(multiplier);
  const logProduct = (total: number): number => {
    let sum = 0;
    for (let k = 0; k < d; k += 1) sum += Math.log(1 + total * weightAt(shape, durationTicks, k));
    return sum;
  };
  let lo = -(1 / wMax) * (1 - 1e-9); // the largest single-tick factor would reach zero here
  let hi = 1;
  while (logProduct(hi) < target) hi *= 2;
  for (let i = 0; i < 100; i += 1) {
    const mid = (lo + hi) / 2;
    if (logProduct(mid) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

function strengthOf(percent: number): Strength {
  const a = Math.abs(percent);
  return a < 10 ? 'minor' : a < 30 ? 'moderate' : a < 70 ? 'major' : 'extreme';
}

/** Plain one-line text: no control characters, trimmed, limited in length. */
function cleanText(value: unknown, max: number, what: string): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new HttpError(400, 'bad_request', `${what} must be text.`);
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (text.length > max) throw new HttpError(400, 'bad_request', `${what} can be at most ${max} characters.`);
  return text;
}

function likeEscape(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function money(cents: number): string {
  const sign = cents < 0 ? '−' : '';
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
}

export class Admin {
  constructor(private readonly d: AdminDeps) {}

  // ---- reading -----------------------------------------------------------------------------------------------------

  state(query: string): AdminState {
    const { db, world, trading, halts } = this.d;
    const q = query.trim();
    const rows = db.all<{ id: number; username: string; role: 'player' | 'owner'; created_ms: number; account_id: number; cash_cents: number; coins: number | null }>(
      `SELECT u.id, u.username, u.role, u.created_ms, a.id AS account_id, a.cash_cents, w.balance_cents AS coins
         FROM users u JOIN accounts a ON a.user_id = u.id AND a.kind = 'career' LEFT JOIN wallets w ON w.user_id = u.id
        WHERE ? = '' OR u.username LIKE ? ESCAPE '\\' ORDER BY u.id LIMIT 200`,
      q,
      `%${likeEscape(q)}%`,
    );
    const players: PlayerRow[] = rows.map((r) => ({
      id: r.id,
      username: r.username,
      role: r.role,
      createdMs: r.created_ms,
      cashCents: r.cash_cents,
      netWorthCents: trading.view(r.account_id).netWorthCents,
      coinsCents: r.coins ?? 0,
      banned: this.d.auth.banOf(r.id),
    }));
    const events = db
      .all<{ id: number; company_id: number | null; headline: string; direction: string; publish_tick: number; start_tick: number; end_tick: number; price_at_publish: number | null; price_at_end: number | null }>(
        "SELECT id, company_id, headline, direction, publish_tick, start_tick, end_tick, price_at_publish, price_at_end FROM news_items WHERE source = 'admin' ORDER BY id DESC LIMIT 20",
      )
      .map((r) => ({
        id: r.id,
        ticker: r.company_id === null ? null : (world.companies[r.company_id]?.ticker ?? null),
        headline: r.headline,
        direction: r.direction,
        publishTick: r.publish_tick,
        startTick: r.start_tick,
        endTick: r.end_tick,
        priceAtPublish: r.price_at_publish,
        priceAtEnd: r.price_at_end,
      }));
    const log = db
      .all<{ id: number; created_ms: number; username: string; action: string; target: string; detail_json: string }>(
        'SELECT l.id, l.created_ms, u.username, l.action, l.target, l.detail_json FROM admin_log l JOIN users u ON u.id = l.admin_user_id ORDER BY l.id DESC LIMIT 60',
      )
      .map((r) => ({ id: r.id, createdMs: r.created_ms, admin: r.username, action: r.action, target: r.target, detail: JSON.parse(r.detail_json) as Record<string, unknown> }));
    const stocks = db
      .all<{ company_id: number; ticker: string; name: string; sector: string; tier: string; personality: string; price_cents: number; created_ms: number }>(
        'SELECT company_id, ticker, name, sector, tier, personality, price_cents, created_ms FROM custom_companies ORDER BY company_id DESC LIMIT 100',
      )
      .map((r): OwnStock => {
        const c = world.companies[r.company_id];
        const trading = c !== undefined && world.sim.isListed(c.id);
        return {
          id: r.company_id,
          ticker: r.ticker,
          name: r.name,
          sector: r.sector,
          tier: r.tier,
          personality: r.personality,
          startPriceCents: r.price_cents,
          createdMs: r.created_ms,
          loaded: c !== undefined,
          trading,
          listsInTicks: c !== undefined && !trading ? Math.max(0, c.listingTick - world.sim.tick) : 0,
          priceCents: trading && c ? world.sim.price(c.id) : 0,
          halted: c !== undefined && halts.isHaltedItself(c.id),
        };
      });
    const launches = db
      .all<{ company_id: number; kind: 'stock' | 'coin'; username: string; created_ms: number; spent_cents: number; stake_shares: number; price_cents: number; shares_now: number; rugs: number; rugged_shares: number; rugged_cents: number; pool_cents: number | null; pool_in: number | null; pool_out: number | null; pool_drained: number | null; pool_dead: number | null }>(
        `SELECT l.company_id, l.kind, u.username, l.created_ms, l.spent_cents, l.stake_shares, l.price_cents,
                cp.pool_cents, cp.in_cents AS pool_in, cp.out_cents AS pool_out, cp.drained_cents AS pool_drained, cp.drained_ms IS NOT NULL AS pool_dead,
                COALESCE((SELECT p.shares FROM positions p JOIN accounts a ON a.id = p.account_id AND a.kind = 'career' WHERE a.user_id = l.user_id AND p.company_id = l.company_id AND p.short = 0), 0) AS shares_now,
                (SELECT COUNT(*) FROM launch_rugs r WHERE r.company_id = l.company_id) AS rugs,
                COALESCE((SELECT SUM(r.shares) FROM launch_rugs r WHERE r.company_id = l.company_id), 0) AS rugged_shares,
                COALESCE((SELECT SUM(r.received_cents) FROM launch_rugs r WHERE r.company_id = l.company_id), 0) AS rugged_cents
           FROM launches l JOIN users u ON u.id = l.user_id LEFT JOIN coin_pools cp ON cp.company_id = l.company_id ORDER BY l.company_id DESC LIMIT 100`,
      )
      .map((r): AdminLaunch => {
        const c = world.companies[r.company_id];
        const trading = c !== undefined && world.sim.isListed(c.id);
        return {
          id: r.company_id,
          ticker: c?.ticker ?? '?',
          name: c?.name ?? '?',
          kind: r.kind,
          username: r.username,
          createdMs: r.created_ms,
          spentCents: r.spent_cents,
          stakeShares: r.stake_shares,
          startPriceCents: r.price_cents,
          sharesNow: r.shares_now,
          trading,
          priceCents: trading && c ? world.sim.price(c.id) : 0,
          halted: c !== undefined && halts.isHaltedItself(c.id),
          rugs: r.rugs + (r.pool_dead ? 1 : 0),
          ruggedShares: r.rugged_shares,
          ruggedCents: r.rugged_cents + (r.pool_drained ?? 0),
          pool: r.pool_cents === null ? null : { cents: r.pool_cents, inCents: r.pool_in ?? 0, outCents: r.pool_out ?? 0, drainedCents: r.pool_drained ?? 0, dead: r.pool_dead === 1 },
        };
      });
    return {
      announcement: this.announcement(),
      paused: halts.allPaused(),
      halts: [
        ...halts.list().map((h) => ({ ticker: world.companies[h.companyId]?.ticker ?? '?', name: world.companies[h.companyId]?.name ?? '?', reason: h.reason, haltedMs: h.haltedMs, auto: false })),
        ...halts.autoList().map((a) => ({
          ticker: world.companies[a.companyId]?.ticker ?? '?',
          name: world.companies[a.companyId]?.name ?? '?',
          reason: autoPauseReason(a, world.sim.tick),
          haltedMs: world.msOfTick(a.sinceTick),
          auto: true,
        })),
      ],
      events,
      players,
      stocks,
      stockForm: stockOptions(OWN_LISTING_SECONDS),
      launches,
      log,
    };
  }

  // ---- helpers -----------------------------------------------------------------------------------------------------

  private requestId(value: unknown): string {
    if (typeof value !== 'string' || !REQUEST_ID.test(value)) throw new HttpError(400, 'bad_request', 'The request needs a requestId of 8–64 letters, numbers, - or _.');
    return value;
  }

  private companyOf(ticker: unknown): Company {
    const c = typeof ticker === 'string' ? this.d.world.companyByTicker(ticker) : undefined;
    if (!c) throw new HttpError(404, 'unknown_company', 'No such company.');
    return c;
  }

  private userOf(username: unknown): { id: number; username: string; role: 'player' | 'owner' } {
    const row = typeof username === 'string' ? this.d.db.get<{ id: number; username: string; role: 'player' | 'owner' }>('SELECT id, username, role FROM users WHERE username = ?', username.trim()) : undefined;
    if (!row) throw new HttpError(404, 'no_such_user', 'There is no player with that username.');
    return row;
  }

  /** A request id that was used before returns the first answer instead of doing the action again. */
  private seen(requestId: string, action: string, target: string): boolean {
    const row = this.d.db.get<{ action: string; target: string }>('SELECT action, target FROM admin_log WHERE request_id = ?', requestId);
    if (!row) return false;
    if (row.action !== action || row.target !== target) throw new HttpError(409, 'request_id_reused', 'That requestId was already used for a different action.');
    return true;
  }

  /**
   * Writes one action of another module (the chat's moderation) to the log, once per requestId. Returns false when that requestId was
   * already used for the same action and target: the caller must not do the action again.
   */
  logOnce(admin: User, requestId: unknown, action: AdminAction, target: string, detail: Record<string, unknown>): boolean {
    const id = this.requestId(requestId);
    if (this.seen(id, action, target)) return false;
    this.record(id, admin, action, target, detail);
    return true;
  }

  private record(requestId: string, admin: User, action: AdminAction, target: string, detail: Record<string, unknown>): void {
    this.d.db.run('INSERT INTO admin_log(request_id, created_ms, admin_user_id, action, target, detail_json) VALUES (?, ?, ?, ?, ?, ?)', requestId, this.d.now(), admin.id, action, target, JSON.stringify(detail));
    this.d.log.info('admin', `${admin.username}: ${action} ${target} ${JSON.stringify(detail)}`);
  }

  // ---- price moves -------------------------------------------------------------------------------------------------

  shock(admin: User, input: ShockInput): Record<string, unknown> {
    const { db, world, news } = this.d;
    if (!news) throw new HttpError(503, 'news_off', 'The news system is switched off, so special events are not available.');
    const requestId = this.requestId(input.requestId);
    const company = this.companyOf(input.ticker);
    if (typeof input.percent !== 'number' || !Number.isFinite(input.percent) || input.percent < MIN_PERCENT || input.percent > MAX_PERCENT || Math.abs(input.percent) < 1) {
      throw new HttpError(400, 'bad_request', `The move must be a percentage from ${MIN_PERCENT}% to +${MAX_PERCENT}%, and at least 1% either way.`);
    }
    if (!STYLES.includes(input.style)) throw new HttpError(400, 'bad_request', 'The style must be rug, crash, pump or custom.');
    if (!SPEEDS.includes(input.speed)) throw new HttpError(400, 'bad_request', 'The speed must be instant, fast or slow.');
    if ((input.style === 'rug' || input.style === 'crash') && input.percent >= 0) throw new HttpError(400, 'bad_request', `A ${input.style} must be a drop (a negative percentage).`);
    if (input.style === 'pump' && input.percent <= 0) throw new HttpError(400, 'bad_request', 'A pump must be a rise (a positive percentage).');
    let headline = cleanText(input.headline, 120, 'The headline');
    let body = cleanText(input.body, 400, 'The text');
    if (input.style === 'custom' && headline === '') throw new HttpError(400, 'bad_request', 'A custom event needs a headline.');
    if (this.seen(requestId, 'shock', company.ticker)) return { ok: true, duplicate: true, ticker: company.ticker };
    if (!world.isTrading(company.id)) throw new HttpError(400, 'not_trading', `${company.ticker} is not trading yet, so it has no price to move.`);

    const pace = PACE[input.speed];
    const total = solveTotal(1 + input.percent / 100, pace.shape, pace.ticks);
    const publishTick = world.earliestEventStart();
    if (input.style !== 'custom') {
      const [h, b] = TEXT[input.style];
      if (headline === '') headline = fill(h, { co: company.name });
      if (body === '') body = fill(b, { co: company.name });
    } else if (body === '') {
      body = input.percent < 0 ? `Shares of ${company.name} moved sharply lower.` : `Shares of ${company.name} moved sharply higher.`;
    }
    const base = adminDraft({
      key: `admin:${requestId}`,
      company,
      direction: input.percent < 0 ? 'negative' : 'positive',
      strength: strengthOf(input.percent),
      publishTick,
      realized: 0,
      durationTicks: pace.ticks,
      cycle: cycleOfTick(publishTick),
      slot: SPECIAL_SLOT,
    });
    const draft: NewsDraft = {
      ...base,
      shape: pace.shape,
      immediacy: input.speed === 'instant' ? 'immediate' : 'gradual',
      realized: total,
      permShare: 1,
      headline,
      body,
      breaking: input.breaking ?? true,
    };

    const priceBefore = world.sim.price(company.id);
    const newsId = db.tx(() => {
      const id = news.addSpecial(draft, this.d.now());
      if (id === null) throw new HttpError(409, 'request_id_reused', 'That requestId was already used.');
      this.record(requestId, admin, 'shock', company.ticker, { style: input.style, percent: input.percent, speed: input.speed, headline, newsId: id, priceBeforeCents: priceBefore });
      return id;
    });
    // Only now, after the story is safely stored, does the running world learn about it.
    world.scheduleEvent(news.eventOfDraft(draft));
    return { ok: true, duplicate: false, ticker: company.ticker, newsId, percent: input.percent, startsAtTick: draft.startTick, priceBeforeCents: priceBefore };
  }

  // ---- trading halts -----------------------------------------------------------------------------------------------

  setHalt(admin: User, input: { requestId: string; ticker: string; halted: boolean; reason?: string }): Record<string, unknown> {
    const { db, halts, views } = this.d;
    const requestId = this.requestId(input.requestId);
    const company = this.companyOf(input.ticker);
    if (typeof input.halted !== 'boolean') throw new HttpError(400, 'bad_request', 'halted must be true or false.');
    const action = input.halted ? 'halt' : 'resume';
    const reason = cleanText(input.reason, 120, 'The reason');
    if (this.seen(requestId, action, company.ticker)) return { ok: true, duplicate: true, ticker: company.ticker, halted: input.halted };
    try {
      db.tx(() => {
        this.record(requestId, admin, action, company.ticker, { reason });
        if (input.halted) halts.halt(company.id, reason, admin.id, this.d.now());
        else {
          halts.resume(company.id);
          halts.endAuto(company.id); // "Resume" also reopens a company the market paused by itself
        }
      });
    } catch (error) {
      halts.reload(); // keep the in-memory set equal to the table, whatever went wrong
      throw error;
    }
    views.invalidate();
    this.d.hub.publish('notice', this.notice()); // open pages refresh their company list at once
    return { ok: true, duplicate: false, ticker: company.ticker, halted: input.halted };
  }

  // ---- making a company -------------------------------------------------------------------------------------------

  /**
   * Makes a new company: it is saved in the database, written into the running market, given its own news, and starts trading a
   * few seconds later (at the start of a candle). It is a real company in every way: it has an order book, an hourly and a daily
   * chart, news, and it is moved by sector and market-wide news. A company can never be deleted (prices, news and players' positions
   * refer to it for ever); the owner can halt it. Companies the owner made are the same after a restart.
   */
  createStock(admin: User, input: StockInput & { requestId: string }): Record<string, unknown> {
    const { db, world, views, hub, log } = this.d;
    const requestId = this.requestId(input.requestId);
    const rawTicker = typeof input.ticker === 'string' ? input.ticker.trim().toUpperCase() : '';
    if (rawTicker !== '' && this.seen(requestId, 'stock', rawTicker)) return { ok: true, duplicate: true, ticker: rawTicker };
    const entry = makeEntry(input, this.takenNames());
    const own = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM custom_companies')?.n ?? 0;
    if (own >= MAX_OWN_COMPANIES) throw new HttpError(400, 'too_many', `You already made ${own} companies, which is the most there can be.`);
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
      const newId = world.recordOwnCompany(entry, listingTick, admin.id);
      this.record(requestId, admin, 'stock', entry.ticker, {
        companyId: newId, name: entry.name, sector: entry.sector, tier: entry.tier, personality: entry.personality, priceCents: entry.price, listingTick,
      });
      return newId;
    });
    // Only now, after the company is safely saved, does the running market learn about it. If that failed, the company still exists
    // in the database and the next start of the server loads it.
    let loaded = true;
    try {
      world.loadOwnCompany(id);
    } catch (error) {
      loaded = false;
      log.error('admin', `${entry.ticker} was saved but could not be added to the running market (it will start trading after the next server start): ${error instanceof Error ? error.message : String(error)}`);
    }
    views.invalidate();
    hub.publish('notice', this.notice()); // open pages fetch their company list again
    const startsInSeconds = Math.max(0, listingTick - Math.max(world.sim.tick, world.currentTick()));
    return { ok: true, duplicate: false, ticker: entry.ticker, name: entry.name, companyId: id, listingTick, startsInSeconds, loaded };
  }

  /** The names and tickers no new company may use: every company in the market, and the thirty built-in coins even if this world does not have them yet. */
  private takenNames(): { names: Set<string>; tickers: Set<string> } {
    const { world } = this.d;
    return {
      names: new Set([...world.companies.map((c) => c.name.toLowerCase()), ...MEME_SEEDS.map((m) => m.name.toLowerCase())]),
      tickers: new Set([...world.companies.map((c) => c.ticker), ...MEME_SEEDS.map((m) => m.ticker)]),
    };
  }

  // ---- money -------------------------------------------------------------------------------------------------------

  private amount(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value === 0 || Math.abs(value) > MAX_AMOUNT_CENTS) {
      throw new HttpError(400, 'bad_request', `The amount must be a whole number of cents, not zero, and at most ${money(MAX_AMOUNT_CENTS)} either way.`);
    }
    return value;
  }

  /**
   * Gives (positive) or takes (negative) Career cash. The player's starting balance moves by the same amount, so a gift counts as a
   * deposit and not as trading profit, and a take as a withdrawal.
   */
  adjustCash(admin: User, input: { requestId: string; username: string; amountCents: number; note?: string }): Record<string, unknown> {
    const { db, trading } = this.d;
    const requestId = this.requestId(input.requestId);
    const user = this.userOf(input.username);
    const amount = this.amount(input.amountCents);
    const note = cleanText(input.note, 120, 'The note');
    if (this.seen(requestId, 'cash', user.username)) return { ok: true, duplicate: true, username: user.username };
    const after = db.tx(() => {
      const acc = trading.careerAccountOf(user.id);
      const cash = acc.cash_cents + amount;
      if (cash < 0) throw new HttpError(400, 'not_enough', `${user.username} has only ${money(acc.cash_cents)} of cash, so you cannot take ${money(-amount)}.`);
      const start = Math.max(0, acc.start_cash_cents + amount);
      db.run('UPDATE accounts SET cash_cents = ?, start_cash_cents = ? WHERE id = ?', cash, start, acc.id);
      this.record(requestId, admin, 'cash', user.username, { amountCents: amount, cashBeforeCents: acc.cash_cents, cashAfterCents: cash, note });
      return cash;
    });
    return { ok: true, duplicate: false, username: user.username, cashCents: after };
  }

  /** Gives or takes virtual-currency coins (the 1v1 wallet). Every change is also written to the wallet's own ledger. */
  adjustCoins(admin: User, input: { requestId: string; username: string; amountCents: number; note?: string }): Record<string, unknown> {
    const { db } = this.d;
    const requestId = this.requestId(input.requestId);
    const user = this.userOf(input.username);
    const amount = this.amount(input.amountCents);
    const note = cleanText(input.note, 120, 'The note');
    if (this.seen(requestId, 'coins', user.username)) return { ok: true, duplicate: true, username: user.username };
    const after = db.tx(() => {
      const before = db.get<{ balance_cents: number }>('SELECT balance_cents FROM wallets WHERE user_id = ?', user.id)?.balance_cents ?? 0;
      const balance = before + amount;
      if (balance < 0) throw new HttpError(400, 'not_enough', `${user.username} has only ${money(before)} in coins, so you cannot take ${money(-amount)}.`);
      const nowMs = this.d.now();
      db.run(
        'INSERT INTO wallets(user_id, balance_cents, updated_ms) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET balance_cents = excluded.balance_cents, updated_ms = excluded.updated_ms',
        user.id,
        balance,
        nowMs,
      );
      db.run('INSERT INTO wallet_ledger(user_id, delta_cents, reason, match_id, created_ms) VALUES (?, ?, ?, NULL, ?)', user.id, amount, amount > 0 ? 'admin_grant' : 'admin_take', nowMs);
      this.record(requestId, admin, 'coins', user.username, { amountCents: amount, coinsBeforeCents: before, coinsAfterCents: balance, note });
      return balance;
    });
    return { ok: true, duplicate: false, username: user.username, coinsCents: after };
  }

  // ---- what every player sees ----------------------------------------------------------------------------------------

  announcement(): Announcement | null {
    const raw = this.d.db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', ANNOUNCEMENT_KEY)?.value;
    if (!raw) return null;
    try {
      const v = JSON.parse(raw) as { text?: unknown; ms?: unknown };
      return typeof v.text === 'string' && v.text !== '' ? { text: v.text, ms: typeof v.ms === 'number' ? v.ms : 0 } : null;
    } catch {
      return null;
    }
  }

  notice(): Notice {
    return { announcement: this.announcement(), paused: this.d.halts.allPaused() };
  }

  /** Posts the announcement banner that every page shows (an empty text takes it down). */
  setAnnouncement(admin: User, input: { requestId: string; text?: string }): Record<string, unknown> {
    const { db } = this.d;
    const requestId = this.requestId(input.requestId);
    const text = cleanText(input.text, ANNOUNCEMENT_MAX, 'The announcement');
    if (this.seen(requestId, 'announce', 'banner')) return { ok: true, duplicate: true, announcement: this.announcement() };
    db.tx(() => {
      if (text === '') db.run('DELETE FROM meta WHERE key = ?', ANNOUNCEMENT_KEY);
      else db.run('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', ANNOUNCEMENT_KEY, JSON.stringify({ text, ms: this.d.now() }));
      this.record(requestId, admin, 'announce', 'banner', { text });
    });
    this.d.hub.publish('notice', this.notice());
    return { ok: true, duplicate: false, announcement: this.announcement() };
  }

  /** Pauses or reopens ALL trading: every company, Career and 1v1. Prices, candles and news keep running. */
  setTradingPaused(admin: User, input: { requestId: string; paused: boolean; reason?: string }): Record<string, unknown> {
    const { db, halts, views } = this.d;
    const requestId = this.requestId(input.requestId);
    if (typeof input.paused !== 'boolean') throw new HttpError(400, 'bad_request', 'paused must be true or false.');
    const reason = cleanText(input.reason, 120, 'The reason');
    const action = input.paused ? 'pause' : 'unpause';
    if (this.seen(requestId, action, 'all trading')) return { ok: true, duplicate: true, paused: input.paused };
    try {
      db.tx(() => {
        this.record(requestId, admin, action, 'all trading', { reason });
        halts.setPaused(input.paused ? { reason, sinceMs: this.d.now() } : null);
      });
    } catch (error) {
      halts.reload(); // keep the in-memory switch equal to the database, whatever went wrong
      throw error;
    }
    views.invalidate();
    this.d.hub.publish('notice', this.notice());
    return { ok: true, duplicate: false, paused: input.paused };
  }

  // ---- bans ----------------------------------------------------------------------------------------------------------

  /**
   * Bans a player: he cannot sign in, an old session is treated as signed out on the very next request, his live streams are closed,
   * and a lobby or live 1v1 match he is in is left (a live match counts as a forfeit). His Career account and coins stay as they
   * are. `hours` is how long (1 – a year); leave it out to ban until the owner lifts it. The owner cannot be banned.
   */
  banPlayer(admin: User, input: { requestId: string; username: string; reason?: string; hours?: number | null }): Record<string, unknown> {
    const { db, auth, matches, hub } = this.d;
    const requestId = this.requestId(input.requestId);
    const user = this.userOf(input.username);
    if (user.role === 'owner' || user.id === admin.id) throw new HttpError(400, 'cannot_ban_owner', 'The owner cannot be banned.');
    const reason = cleanText(input.reason, 120, 'The reason');
    const hours = input.hours === undefined || input.hours === null ? null : input.hours;
    if (hours !== null && (typeof hours !== 'number' || !Number.isInteger(hours) || hours < 1 || hours > MAX_BAN_HOURS)) {
      throw new HttpError(400, 'bad_request', `A timed ban lasts a whole number of hours, from 1 to ${MAX_BAN_HOURS}. Leave it out to ban until you lift it.`);
    }
    if (this.seen(requestId, 'ban', user.username)) return { ok: true, duplicate: true, username: user.username };
    const untilMs = hours === null ? null : this.d.now() + hours * 3_600_000;
    db.tx(() => {
      auth.setBan(user.id, reason, untilMs, admin.id);
      this.record(requestId, admin, 'ban', user.username, { reason, hours, untilMs });
    });
    try {
      matches.leave(user.id); // leaves a lobby, or forfeits a live match
    } catch (error) {
      this.d.log.warn('admin', `Could not take ${user.username} out of the 1v1 lobby after the ban: ${error instanceof Error ? error.message : String(error)}`);
    }
    hub.dropUser(user.id);
    return { ok: true, duplicate: false, username: user.username, untilMs };
  }

  unbanPlayer(admin: User, input: { requestId: string; username: string }): Record<string, unknown> {
    const { db, auth } = this.d;
    const requestId = this.requestId(input.requestId);
    const user = this.userOf(input.username);
    if (this.seen(requestId, 'unban', user.username)) return { ok: true, duplicate: true, username: user.username };
    db.tx(() => {
      if (!auth.clearBan(user.id)) throw new HttpError(400, 'not_banned', `${user.username} is not banned.`);
      this.record(requestId, admin, 'unban', user.username, {});
    });
    return { ok: true, duplicate: false, username: user.username };
  }

  // ---- shares and resets ---------------------------------------------------------------------------------------------

  /**
   * Gives (positive) or takes (negative) shares of one company in a player's Career account. Like a cash gift it counts as a deposit
   * or withdrawal: the shares are valued at the current bid, which is added to (or taken from) the account's start value, so it never
   * shows up as trading profit or loss.
   */
  adjustShares(admin: User, input: { requestId: string; username: string; ticker: string; qty: number; note?: string }): Record<string, unknown> {
    const { db, trading, world } = this.d;
    const requestId = this.requestId(input.requestId);
    const user = this.userOf(input.username);
    const company = this.companyOf(input.ticker);
    if (typeof input.qty !== 'number' || !Number.isSafeInteger(input.qty) || input.qty === 0 || Math.abs(input.qty) > MAX_SHARES_PER_ACTION) {
      throw new HttpError(400, 'bad_request', `The number of shares must be a whole number, not zero, and at most ${MAX_SHARES_PER_ACTION.toLocaleString('en-US')} either way.`);
    }
    const qty = input.qty;
    const note = cleanText(input.note, 120, 'The note');
    if (this.seen(requestId, 'shares', user.username)) return { ok: true, duplicate: true, username: user.username };
    if (!world.sim.isListed(company.id)) throw new HttpError(400, 'not_trading', `${company.ticker} is not trading yet, so it has no price.`);
    const bid = world.quote(company.id).bid;
    const value = bid * Math.abs(qty);
    // A company can be pumped to $1,000,000,000 a share; a position worth more than the game can count would break the account page.
    const countable = Number.MAX_SAFE_INTEGER / 8;
    if (!Number.isSafeInteger(value) || value > countable) {
      throw new HttpError(400, 'too_large', `At $${(bid / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })} a share, ${Math.abs(qty).toLocaleString('en-US')} shares are worth more than the game can count. Use fewer shares.`);
    }
    const after = db.tx(() => {
      const acc = trading.careerAccountOf(user.id);
      const held = db.get<{ shares: number; cost_cents: number; debt_cents: number; short: number }>('SELECT shares, cost_cents, debt_cents, short FROM positions WHERE account_id = ? AND company_id = ?', acc.id, company.id);
      // A short position is shares the player owes, not owns: giving or taking shares would corrupt its books.
      if (held?.short === 1) throw new HttpError(400, 'short_position', `${user.username} is short ${held.shares.toLocaleString('en-US')} shares of ${company.ticker}, so shares cannot be given or taken. Ask them to cover the short first.`);
      const before = held?.shares ?? 0;
      let sharesAfter: number;
      if (qty > 0) {
        sharesAfter = before + qty;
        if (!Number.isSafeInteger(sharesAfter)) throw new HttpError(400, 'bad_request', 'That would be too many shares.');
        if (sharesAfter * bid > countable) throw new HttpError(400, 'too_large', `That would leave the player with ${sharesAfter.toLocaleString('en-US')} shares worth more than the game can count at this price.`);
        if (held) db.run('UPDATE positions SET shares = ?, cost_cents = cost_cents + ? WHERE account_id = ? AND company_id = ?', sharesAfter, value, acc.id, company.id);
        else db.run('INSERT INTO positions(account_id, company_id, shares, cost_cents) VALUES (?, ?, ?, ?)', acc.id, company.id, qty, value);
        db.run('UPDATE accounts SET start_cash_cents = start_cash_cents + ? WHERE id = ?', value, acc.id);
      } else {
        const take = -qty;
        if (!held || held.shares < take) throw new HttpError(400, 'not_enough', `${user.username} holds only ${before.toLocaleString('en-US')} shares of ${company.ticker}, so you cannot take ${take.toLocaleString('en-US')}.`);
        sharesAfter = held.shares - take;
        if (sharesAfter === 0) db.run('DELETE FROM positions WHERE account_id = ? AND company_id = ?', acc.id, company.id);
        else {
          const removed = Number((BigInt(held.cost_cents) * BigInt(take)) / BigInt(held.shares));
          // Shares bought with leverage take their share of the debt with them.
          db.run('UPDATE positions SET shares = ?, cost_cents = cost_cents - ?, debt_cents = debt_cents - ? WHERE account_id = ? AND company_id = ?', sharesAfter, removed, debtShare(held.debt_cents, take, held.shares), acc.id, company.id);
        }
        db.run('UPDATE accounts SET start_cash_cents = MAX(0, start_cash_cents - ?) WHERE id = ?', value, acc.id);
      }
      this.record(requestId, admin, 'shares', user.username, { ticker: company.ticker, qty, priceCents: bid, valueCents: value, sharesBefore: before, sharesAfter, note });
      return sharesAfter;
    });
    trading.leverageChanged();
    return { ok: true, duplicate: false, username: user.username, ticker: company.ticker, shares: after };
  }

  /**
   * Gives a player a clean Career account: $1,000 of cash, no shares, and no trade history or realized profit from before. Older
   * trades stay in the database (their ids are used by the price pushes) but no longer show. Coins, 1v1 history and the account
   * itself are untouched.
   */
  resetPlayer(admin: User, input: { requestId: string; username: string; note?: string }): Record<string, unknown> {
    const { db, trading } = this.d;
    const requestId = this.requestId(input.requestId);
    const user = this.userOf(input.username);
    const note = cleanText(input.note, 120, 'The note');
    if (this.seen(requestId, 'reset', user.username)) return { ok: true, duplicate: true, username: user.username };
    db.tx(() => {
      const acc = trading.careerAccountOf(user.id);
      const view = trading.view(acc.id);
      db.run('DELETE FROM positions WHERE account_id = ?', acc.id); // any debt on them goes with them
      db.run('DELETE FROM impact_state WHERE account_id = ?', acc.id);
      // Open limit orders end with the account (their set-aside cash is not given back: the cash is set to the starting cash below).
      db.run("UPDATE limit_orders SET state = 'cancelled', reason = 'The owner reset the account.', reserved_cents = 0, closed_ms = ? WHERE account_id = ? AND state = 'open'", this.d.now(), acc.id);
      db.run('UPDATE accounts SET cash_cents = ?, start_cash_cents = ?, reset_trade_id = COALESCE((SELECT MAX(id) FROM trades), 0) WHERE id = ?', START_CASH_CENTS, START_CASH_CENTS, acc.id);
      this.record(requestId, admin, 'reset', user.username, { cashBeforeCents: view.cashCents, netWorthBeforeCents: view.netWorthCents, positions: view.positions.length, note });
    });
    trading.leverageChanged();
    return { ok: true, duplicate: false, username: user.username, cashCents: START_CASH_CENTS };
  }
}
