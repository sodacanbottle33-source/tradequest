// Computer traders in the main market (docs/world.md §9.11).
//
// The eight 1v1 bots (server/lobby/bots.ts) also trade in Career, all day, with money of their own. Each one has a Career account like any
// player (never your money, never the wallet): it buys or shorts a company, holds it for a few minutes and closes it, then looks for the next
// one. Its orders go through Trading.placeOrder exactly like a player's, so they pay the spread and the fee, meet the order book, and push the
// price a little (server/flow.ts), which is what makes the order book tilt and the thin companies and memecoins move when nobody is online.
//
// Rules that keep it harmless:
//   • Orders are small compared with the company's order book (a few percent), so a big company hardly moves and a thin one moves a little.
//   • No leverage and no stops: a bot cannot be liquidated, so there is no chain of forced closes.
//   • A bot never trades a company a player launched (the launcher's own money decides its price) and never looks at a price that has not
//     happened yet (finished candles only).
//   • When a bot has nothing open, its cash is set back to the same amount, so winning or losing never makes it bigger or smaller.
//   • Every choice comes from a seeded generator and a bot only acts when the market is not catching up, so a test can replay it.
//
// What a bot reacts to (server/marketSignals.ts): stories that are already published, the figures of published earnings reports, how cheap a
// stock is next to its sector, and what the crowd of players is doing to a company's order book. Each style follows or fades each of these
// in its own way and after its own short delay (MARKET_REACTIONS). A bot that finds nothing worth acting on trades as it always did. It never
// reads what a player cannot read (no hidden moves, no story that is not out yet).

import { bookDepth } from './flow';
import { between, fraction, PERSONAS, botUserId, seeded, type Persona } from './lobby/bots';
import type { Logger } from './log';
import type { MarketSignals, Reaction } from './marketSignals';
import type { Db } from './sqlite';
import { OrderError, maxOrderShares, type Trading } from './trading';
import type { WorldRuntime } from './world/runtime';

/** The cash of a bot's Career account: $1,000,000, set again whenever it holds nothing (the order books are millions deep, so less would not be felt at all). */
export const MARKET_BOT_CASH_CENTS = 100_000_000;
/** One order uses at most this share of the bot's cash. */
const MAX_CASH_SHARE = 0.3;
/** A bot waits (does nothing) when the market is more than this many ticks behind the clock. */
const MAX_LAG_TICKS = 3;
/** A bot looks at this many finished 10-second candles back (5 minutes) to see what is rising or falling. */
const LOOKBACK_CANDLES = 30;

export interface MarketStyle {
  /** Seconds between two decisions, seconds a position is held, order size as a share of the company's calm order book, positions at a time. */
  readonly every: readonly [number, number];
  readonly hold: readonly [number, number];
  readonly size: readonly [number, number];
  readonly positions: number;
}

/** How each of the eight styles trades in the main market (the picking rule, the pool and the side come from the 1v1 style in lobby/bots.ts). */
export const MARKET_STYLES: Readonly<Record<string, MarketStyle>> = {
  sam: { every: [120, 300], hold: [900, 1800], size: [0.02, 0.05], positions: 3 },
  mia: { every: [45, 120], hold: [120, 420], size: [0.04, 0.1], positions: 3 },
  carl: { every: [60, 150], hold: [180, 480], size: [0.04, 0.1], positions: 3 },
  dee: { every: [30, 90], hold: [60, 240], size: [0.08, 0.2], positions: 2 },
  shane: { every: [90, 200], hold: [180, 420], size: [0.04, 0.1], positions: 2 },
  rex: { every: [20, 50], hold: [30, 120], size: [0.02, 0.06], positions: 2 },
  luna: { every: [40, 100], hold: [120, 400], size: [0.06, 0.15], positions: 2 },
  hank: { every: [90, 240], hold: [300, 900], size: [0.03, 0.07], positions: 2 },
};

/** How each of the eight styles reacts to news, earnings, price/earnings and the crowd (see Reaction in marketSignals.ts). Delays are in seconds. */
export const MARKET_REACTIONS: Readonly<Record<string, Reaction>> = {
  // Sam: a steady holder of big companies; only a clear earnings beat (or miss) at one of the largest companies moves him, and he takes his time.
  sam: { news: 'ignore', earnings: 'follow', crowd: 'ignore', minScore: 3, delay: [120, 600], window: 3600, attention: 0.9, exitOnNews: false },
  // Mia: chases whatever the news says is rising, with the crowd, fast; leaves when a story turns against her.
  mia: { news: 'follow', earnings: 'follow', crowd: 'follow', minScore: 1.5, delay: [8, 40], window: 600, attention: 0.8, exitOnNews: true },
  // Carl: buys the drop after bad news and bad reports, and against a selling crowd, after waiting for the dust to settle.
  carl: { news: 'fade', earnings: 'fade', crowd: 'fade', minScore: 1.5, delay: [90, 240], window: 1200, attention: 0.7, exitOnNews: false },
  // Dee: memecoins, either way: long on good coin news, short on bad, with the crowd, within seconds.
  dee: { news: 'follow', earnings: 'ignore', crowd: 'follow', minScore: 1.5, delay: [3, 20], window: 300, attention: 0.85, exitOnNews: true },
  // Shane: shorts bad news and misses, and fades a crowd that has piled in.
  shane: { news: 'follow', earnings: 'follow', crowd: 'fade', minScore: 1.5, delay: [15, 60], window: 900, attention: 0.8, exitOnNews: true },
  // Rex: a news scalper: only major or extreme stories and big surprises, within seconds, in and out.
  rex: { news: 'follow', earnings: 'follow', crowd: 'ignore', minScore: 3, delay: [2, 12], window: 180, attention: 1, exitOnNews: true },
  // Luna: coins, long: good coin news and a crowd that is buying.
  luna: { news: 'follow', earnings: 'ignore', crowd: 'follow', minScore: 1.5, delay: [5, 30], window: 300, attention: 0.8, exitOnNews: true },
  // Hank: a bargain hunter: buys overreactions to bad news and stocks that are cheap next to their sector.
  hank: { news: 'fade', earnings: 'value', crowd: 'ignore', minScore: 1.5, delay: [120, 400], window: 3600, attention: 0.7, exitOnNews: false },
};

/** At most this many bots hold the same company on the same side (so they cannot all pile onto one story). */
const MAX_BOTS_PER_SIDE = 2;
/** A bot that picks `big` companies looks at this many of the largest. */
const BIG_COMPANIES = 12;
/** The latest decisions kept in memory, for tests and the owner's log. */
const KEEP_DECISIONS = 400;

/** One thing a bot did because of what it read. `chart` is the old reason: what rose or fell over the last five minutes. */
export interface Decision {
  readonly tick: number;
  readonly persona: string;
  readonly companyId: number;
  readonly short: boolean;
  readonly action: 'open' | 'early-exit';
  readonly why: 'news' | 'earnings' | 'value' | 'crowd' | 'chart';
  readonly score: number;
}

interface Plan {
  readonly short: boolean;
  closeAt: number;
  /** True for a position opened because of something the bot read; the others (the chart, or found after a restart) can make room for it. */
  readonly reacted?: boolean;
}

interface MarketBot {
  readonly persona: Persona;
  readonly style: MarketStyle;
  readonly reaction: Reaction | null;
  /** Stories this bot has acted on (it does not act on one twice). */
  readonly seen: Set<number>;
  readonly userId: number;
  readonly accountId: number;
  readonly rng: () => number;
  nextAt: number;
  orders: number;
  /** When each open position is to be closed, by company id. */
  readonly plans: Map<number, Plan>;
  /** A company the bot wants to trade because of what it read, waiting for a free place (the bot closes a chart position to make one). */
  idea: Choice | null;
}

interface Choice {
  readonly companyId: number;
  readonly short: boolean;
  readonly why: Decision['why'];
  readonly score: number;
  readonly stories: readonly number[];
}

interface Held {
  company_id: number;
  shares: number;
  short: number;
}

export interface MarketBotsOptions {
  readonly db: Db;
  readonly world: WorldRuntime;
  readonly trading: Trading;
  readonly log: Logger;
  readonly now: () => number;
  /** What the bots may read. Without it they trade only on the chart, as before. */
  readonly signals?: MarketSignals;
}

export class MarketBots {
  private readonly db: Db;
  private readonly world: WorldRuntime;
  private readonly trading: Trading;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly signals: MarketSignals | null;
  private bots: MarketBot[] | null = null;
  private lastError = 0;
  private readonly log_: Decision[] = [];

  constructor(o: MarketBotsOptions) {
    this.db = o.db;
    this.world = o.world;
    this.trading = o.trading;
    this.log = o.log;
    this.now = o.now;
    this.signals = o.signals ?? null;
  }

  /** The latest things bots did because of what they read, oldest first. */
  decisions(): readonly Decision[] {
    return this.log_;
  }

  private note(d: Decision): void {
    this.log_.push(d);
    if (this.log_.length > KEEP_DECISIONS) this.log_.splice(0, this.log_.length - KEEP_DECISIONS);
  }

  /** Called once per market tick: every bot whose time has come takes a turn. */
  step(): void {
    if (this.world.lagTicks > MAX_LAG_TICKS) return;
    const tick = this.world.sim.tick;
    const bots = this.bots ?? this.setup(tick);
    for (const bot of bots) {
      if (tick < bot.nextAt) continue;
      try {
        this.turn(bot, tick);
      } catch (error) {
        bot.nextAt = tick + 10;
        const t = Date.now();
        if (t - this.lastError > 10_000) {
          this.lastError = t;
          this.log.warn('bots', `${bot.persona.name} could not take a turn in the market: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }

  /** The bots' users and Career accounts, made on first use (a restart finds them again). */
  private setup(tick: number): MarketBot[] {
    const made: MarketBot[] = [];
    for (const persona of PERSONAS) {
      const style = MARKET_STYLES[persona.id];
      if (!style) continue;
      const userId = botUserId(this.db, persona, this.now());
      let account = this.db.get<{ id: number }>("SELECT id FROM accounts WHERE user_id = ? AND kind = 'career'", userId);
      if (!account) {
        this.db.run("INSERT INTO accounts(user_id, kind, match_id, cash_cents, start_cash_cents, created_ms) VALUES (?, 'career', NULL, ?, ?, ?)", userId, MARKET_BOT_CASH_CENTS, MARKET_BOT_CASH_CENTS, this.now());
        account = this.db.get<{ id: number }>("SELECT id FROM accounts WHERE user_id = ? AND kind = 'career'", userId) as { id: number };
      }
      const rng = seeded(0x4d4b5400 + userId * 7919);
      // The first decisions are spread over the first minutes, so all eight do not start in the same second.
      made.push({ persona, style, reaction: this.signals ? (MARKET_REACTIONS[persona.id] ?? null) : null, seen: new Set(), userId, accountId: account.id, rng, nextAt: tick + between(rng, [3, style.every[1]]), orders: 0, plans: new Map(), idea: null });
    }
    this.bots = made;
    return made;
  }

  private turn(bot: MarketBot, tick: number): void {
    const held = this.db.all<Held>('SELECT company_id, shares, short FROM positions WHERE account_id = ?', bot.accountId);
    // After a restart the plans are gone: a position that is found open is closed after a normal holding time.
    const open = new Set(held.map((h) => h.company_id));
    for (const id of [...bot.plans.keys()]) if (!open.has(id)) bot.plans.delete(id);
    for (const h of held) if (!bot.plans.has(h.company_id)) bot.plans.set(h.company_id, { short: h.short === 1, closeAt: tick + between(bot.rng, bot.style.hold) });
    if (held.length === 0) this.refill(bot);
    const urgent = this.leaveOnNews(bot, held, tick);
    this.act(bot, held, tick);
    // A position that is to be closed because of a story is looked at again when it is due, not when the bot would next have looked.
    if (urgent !== null && bot.nextAt > urgent) bot.nextAt = urgent;
  }

  private act(bot: MarketBot, held: readonly Held[], tick: number): void {
    // Something to close that is due: that is this turn's job.
    for (const h of held) {
      const plan = bot.plans.get(h.company_id) as Plan;
      if (tick >= plan.closeAt) {
        this.close(bot, h, plan, tick);
        return;
      }
    }
    if (held.length < bot.style.positions) {
      this.open(bot, held, tick);
      return;
    }
    // Full: a good idea (a story, a report, a bargain) takes the place of a position that was opened for no particular reason.
    if (!bot.idea) bot.idea = this.reactive(bot, held, tick);
    if (bot.idea) {
      const spare = held.find((h) => bot.plans.get(h.company_id)?.reacted !== true);
      if (spare) {
        const plan = bot.plans.get(spare.company_id) as Plan;
        plan.closeAt = tick;
        bot.nextAt = tick + 1;
        return;
      }
      bot.idea = null;
    }
    bot.nextAt = tick + between(bot.rng, bot.style.every);
  }

  /** With nothing open the account goes back to its starting cash, so winning or losing never changes how big a bot trades. */
  private refill(bot: MarketBot): void {
    const row = this.db.get<{ cash_cents: number }>('SELECT cash_cents FROM accounts WHERE id = ?', bot.accountId);
    if (row && row.cash_cents !== MARKET_BOT_CASH_CENTS) this.db.run('UPDATE accounts SET cash_cents = ? WHERE id = ?', MARKET_BOT_CASH_CENTS, bot.accountId);
  }

  /** What a bot may know: how each company moved over the last five minutes, from FINISHED candles only. */
  private movers(): { companyId: number; ret: number }[] {
    const last = Math.floor(this.world.savedTick / 10) - 1;
    const then = last - LOOKBACK_CANDLES;
    if (then < 1) return [];
    const closes = new Map<string, number>();
    for (const row of this.db.all<{ company_id: number; idx: number; close: number }>('SELECT company_id, idx, close FROM candles_c10 WHERE idx = ? OR idx = ?', last, then)) closes.set(`${row.company_id}:${row.idx}`, row.close);
    // A company a player launched is left alone: its price is the launcher's business.
    const launched = new Set(this.db.all<{ company_id: number }>('SELECT company_id FROM launches').map((r) => r.company_id));
    const out: { companyId: number; ret: number }[] = [];
    for (const c of this.world.companies) {
      if (!this.world.sim.isListed(c.id) || launched.has(c.id)) continue;
      const a = closes.get(`${c.id}:${last}`);
      const b = closes.get(`${c.id}:${then}`);
      if (a === undefined || b === undefined || b <= 0) continue;
      out.push({ companyId: c.id, ret: a / b - 1 });
    }
    return out;
  }

  /** How many bots hold each company on each side right now (key "companyId:short"). */
  private crowding(): Map<string, number> {
    const ids = (this.bots ?? []).map((b) => b.accountId);
    const out = new Map<string, number>();
    if (ids.length === 0) return out;
    const rows = this.db.all<{ company_id: number; short: number; n: number }>(`SELECT company_id, short, COUNT(*) AS n FROM positions WHERE shares > 0 AND account_id IN (${ids.map(() => '?').join(',')}) GROUP BY company_id, short`, ...ids);
    for (const r of rows) out.set(`${r.company_id}:${r.short}`, r.n);
    return out;
  }

  /** A company chosen because of what the bot read (news, a report, how cheap it is, the crowd), or null when nothing is worth acting on. */
  private reactive(bot: MarketBot, held: readonly Held[], tick: number): Choice | null {
    const react = bot.reaction;
    if (!this.signals || !react) return null;
    const p = bot.persona;
    const candidates = this.signals.candidates(react, bot.userId, tick, bot.seen);
    if (candidates.length === 0) return null;
    if (bot.rng() >= react.attention) return null;
    const mine = new Set(held.map((h) => h.company_id));
    const launched = new Set(this.db.all<{ company_id: number }>('SELECT company_id FROM launches').map((r) => r.company_id));
    const crowd = this.crowding();
    let big: Set<number> | null = null;
    if (p.pick === 'big') {
      const cap = (id: number): number => (this.world.companies[id]?.sharesOutstanding ?? 0) * this.world.sim.price(id);
      big = new Set(
        this.world.companies
          .filter((c) => c.sector !== 'meme' && this.world.sim.isListed(c.id))
          .sort((a, b) => cap(b.id) - cap(a.id))
          .slice(0, BIG_COMPANIES)
          .map((c) => c.id),
      );
    }
    const usable = candidates.filter((cand) => {
      const c = this.world.companies[cand.companyId];
      if (!c || mine.has(cand.companyId) || launched.has(cand.companyId) || !this.world.sim.isListed(cand.companyId)) return false;
      const coin = c.sector === 'meme';
      if (p.pool === 'coins' ? !coin : p.pool === 'stocks' ? coin : false) return false;
      if (big && !big.has(cand.companyId)) return false;
      if (p.side === 'long' ? cand.dir !== 1 : p.side === 'short' ? cand.dir !== -1 : false) return false;
      return (crowd.get(`${cand.companyId}:${cand.dir === -1 ? 1 : 0}`) ?? 0) < MAX_BOTS_PER_SIDE;
    });
    const top = usable.slice(0, 2);
    const pick = top[Math.floor(bot.rng() * top.length)];
    if (!pick) return null;
    return { companyId: pick.companyId, short: pick.dir === -1, why: pick.why, score: pick.score, stories: pick.stories };
  }

  /** A follower closes a position early when a story that came out after it opened points the other way. Returns the tick the first such position is to go, or null. */
  private leaveOnNews(bot: MarketBot, held: readonly Held[], tick: number): number | null {
    const react = bot.reaction;
    if (!this.signals || !react || !react.exitOnNews || held.length === 0) return null;
    const against = this.signals.candidates(react, bot.userId, tick, bot.seen);
    let first: number | null = null;
    for (const h of held) {
      const plan = bot.plans.get(h.company_id);
      if (!plan) continue;
      const cand = against.find((c) => c.companyId === h.company_id && c.dir === (h.short === 1 ? 1 : -1));
      if (!cand) continue;
      for (const id of cand.stories) bot.seen.add(id);
      plan.closeAt = Math.min(plan.closeAt, tick + between(bot.rng, [2, 8]));
      first = first === null ? plan.closeAt : Math.min(first, plan.closeAt);
      this.note({ tick, persona: bot.persona.id, companyId: h.company_id, short: h.short === 1, action: 'early-exit', why: cand.why, score: cand.score });
    }
    return first;
  }

  private choose(bot: MarketBot, held: readonly Held[], tick: number): Choice | null {
    const reacted = this.reactive(bot, held, tick);
    if (reacted) return reacted;
    const p = bot.persona;
    const isCoin = (id: number): boolean => this.world.companies[id]?.sector === 'meme';
    const mine = new Set(held.map((h) => h.company_id));
    let pool = this.movers().filter((m) => !mine.has(m.companyId) && (p.pool === 'any' ? true : p.pool === 'coins' ? isCoin(m.companyId) : !isCoin(m.companyId)));
    if (pool.length === 0) return null;
    if (p.pick === 'big') {
      const cap = (id: number): number => (this.world.companies[id]?.sharesOutstanding ?? 0) * this.world.sim.price(id);
      pool = pool.sort((a, b) => cap(b.companyId) - cap(a.companyId)).slice(0, 6);
    } else if (p.pick === 'reversal') {
      pool = pool.sort((a, b) => a.ret - b.ret).slice(0, 3);
    } else if (p.pick === 'wild') {
      pool = pool.sort((a, b) => Math.abs(b.ret) - Math.abs(a.ret)).slice(0, 4);
    } else {
      pool = pool.sort((a, b) => b.ret - a.ret).slice(0, 3);
    }
    const pick = pool[Math.floor(bot.rng() * pool.length)];
    if (!pick) return null;
    const short = p.side === 'short' || (p.side === 'either' && bot.rng() < 0.5);
    return { companyId: pick.companyId, short, why: 'chart', score: 0, stories: [] };
  }

  private orderId(bot: MarketBot, tick: number): string {
    bot.orders += 1;
    return `mk-${bot.userId}-${tick}-${bot.orders}`;
  }

  private open(bot: MarketBot, held: readonly Held[], tick: number): void {
    let choice: Choice | null = null;
    if (bot.idea) {
      // The idea is still good if its company is not held and was not taken by other bots in the meantime.
      const idea = bot.idea;
      bot.idea = null;
      if (!held.some((h) => h.company_id === idea.companyId) && this.world.sim.isListed(idea.companyId)) choice = idea;
    }
    choice ??= this.choose(bot, held, tick);
    const retry = (): void => {
      bot.nextAt = tick + between(bot.rng, [5, 20]);
    };
    if (!choice) return retry();
    const company = this.world.companies[choice.companyId];
    const acc = this.trading.account(bot.accountId);
    if (!company || !acc) return retry();
    const quote = this.world.quote(choice.companyId);
    const price = choice.short ? quote.bid : quote.ask;
    if (price < 1) return retry();
    const wanted = Math.floor(bookDepth(company) * fraction(bot.rng, bot.style.size));
    const qty = Math.min(wanted, Math.floor((acc.cash_cents * MAX_CASH_SHARE) / price), maxOrderShares(price));
    if (qty < 1) return retry();
    try {
      this.trading.placeOrder({ accountId: bot.accountId, clientOrderId: this.orderId(bot, tick), companyId: choice.companyId, side: choice.short ? 'sell' : 'buy', qty, short: choice.short });
    } catch (error) {
      if (error instanceof OrderError) return retry(); // halted, no depth, not enough cash...: another company, a little later
      throw error;
    }
    bot.plans.set(choice.companyId, { short: choice.short, closeAt: tick + between(bot.rng, bot.style.hold), reacted: choice.why !== 'chart' });
    for (const id of choice.stories) bot.seen.add(id);
    if (bot.seen.size > 500) for (const id of [...bot.seen].slice(0, bot.seen.size - 400)) bot.seen.delete(id);
    if (choice.why !== 'chart') this.note({ tick, persona: bot.persona.id, companyId: choice.companyId, short: choice.short, action: 'open', why: choice.why, score: choice.score });
    bot.nextAt = tick + between(bot.rng, bot.style.every);
  }

  private close(bot: MarketBot, h: Held, plan: Plan, tick: number): void {
    const price = this.world.sim.price(h.company_id);
    try {
      this.trading.placeOrder({ accountId: bot.accountId, clientOrderId: this.orderId(bot, tick), companyId: h.company_id, side: h.short === 1 ? 'buy' : 'sell', qty: Math.min(h.shares, maxOrderShares(price)), short: h.short === 1 });
    } catch (error) {
      if (!(error instanceof OrderError)) throw error;
      plan.closeAt = tick + 5; // refused (halted, thin book...): try again in a moment
      bot.nextAt = tick + 5;
      return;
    }
    const left = this.db.get<{ shares: number }>('SELECT shares FROM positions WHERE account_id = ? AND company_id = ?', bot.accountId, h.company_id);
    if (left && left.shares > 0) plan.closeAt = tick + 1; // only part of it fit in the order book: the rest goes on the next turn
    bot.nextAt = tick + between(bot.rng, [2, 10]);
  }
}
