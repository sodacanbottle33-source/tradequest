// Computer players for the 1v1 lobby (docs/world.md §9.9).
//
// A bot is an ordinary player as far as the lobby, the match account and the scoring are concerned: it has a row in "users" (username
// "bot-<style>", which nobody can register because of the hyphen, and a password hash that can never match) and a row in "bots". It
// joins a lobby where a real player has been waiting alone for BOT_WAIT_MS (or at once, when the player presses "Play a bot now"), and
// it is ready at once. A real player who arrives later always takes the bot's place until the countdown starts.
//
// While a match is live, BotTrader decides what a bot does. It trades through Trading.placeOrder with the bot's own match account, so it
// pays the same spread, meets the same order-book depth, can be liquidated, and is refused outside the 180 seconds exactly like a human.
// It only looks at prices that were already stored (candles up to the last finished one), never at a price that has not happened yet.
// Every choice comes from a seeded generator (match id + bot), so a bot's play can be reproduced in a test.

import type { Logger } from '../log';
import type { Db } from '../sqlite';
import { OrderError, maxOrderShares, type Trading } from '../trading';
import type { WorldRuntime } from '../world/runtime';

/** A real player who waits alone this long gets a bot as an opponent. */
export const BOT_WAIT_MS = 10_000;

export interface Persona {
  readonly id: string;
  readonly name: string;
  /** One line for the lobby: how this bot plays. */
  readonly blurb: string;
  readonly pool: 'stocks' | 'coins' | 'any';
  /** How it picks a company: the strongest / weakest mover of the last minute, one of the biggest companies, or a wild coin. */
  readonly pick: 'momentum' | 'reversal' | 'big' | 'wild';
  readonly side: 'long' | 'short' | 'either';
  /** Leverage range (whole numbers) and the share of its cash it puts up as margin. */
  readonly leverage: readonly [number, number];
  readonly stake: readonly [number, number];
  /** Seconds after the start before its first trade, and seconds it holds a position before selling. */
  readonly enterAfter: readonly [number, number];
  readonly holdFor: readonly [number, number];
  /** How many positions it opens in one match, and its stop-loss and take-profit in percent (0 = none). */
  readonly trades: number;
  readonly stopPct: number;
  readonly takePct: number;
}

/** Eight bots, so up to eight bot matches can run at the same time (a user can only be in one unfinished match). */
export const PERSONAS: readonly Persona[] = [
  { id: 'sam', name: 'Sam', blurb: 'Buys one big steady company and holds it to the end.', pool: 'stocks', pick: 'big', side: 'long', leverage: [1, 2], stake: [0.85, 0.95], enterAfter: [3, 14], holdFor: [150, 170], trades: 1, stopPct: 0, takePct: 0 },
  { id: 'mia', name: 'Mia', blurb: 'Chases whatever is rising, with some leverage and tight exits.', pool: 'any', pick: 'momentum', side: 'long', leverage: [3, 5], stake: [0.6, 0.8], enterAfter: [3, 20], holdFor: [40, 90], trades: 2, stopPct: 2, takePct: 3 },
  { id: 'carl', name: 'Carl', blurb: 'Buys what has just dropped, betting on a bounce.', pool: 'any', pick: 'reversal', side: 'long', leverage: [2, 4], stake: [0.6, 0.85], enterAfter: [3, 20], holdFor: [40, 80], trades: 2, stopPct: 3, takePct: 4 },
  { id: 'dee', name: 'Dee', blurb: 'All-in on wild memecoins with big leverage. Wins fast or loses fast.', pool: 'coins', pick: 'wild', side: 'either', leverage: [10, 25], stake: [0.5, 0.9], enterAfter: [2, 12], holdFor: [20, 60], trades: 3, stopPct: 6, takePct: 8 },
  { id: 'shane', name: 'Shane', blurb: 'Shorts the biggest riser, betting the rally ends.', pool: 'any', pick: 'momentum', side: 'short', leverage: [2, 4], stake: [0.6, 0.8], enterAfter: [3, 20], holdFor: [40, 80], trades: 2, stopPct: 3, takePct: 4 },
  { id: 'rex', name: 'Rex', blurb: 'A scalper: a few quick trades with tight exits.', pool: 'stocks', pick: 'momentum', side: 'long', leverage: [3, 5], stake: [0.3, 0.5], enterAfter: [2, 10], holdFor: [15, 35], trades: 3, stopPct: 1.5, takePct: 2.5 },
  { id: 'luna', name: 'Luna', blurb: 'Rides the strongest memecoin for a minute or two.', pool: 'coins', pick: 'momentum', side: 'long', leverage: [3, 6], stake: [0.5, 0.75], enterAfter: [3, 15], holdFor: [60, 100], trades: 2, stopPct: 4, takePct: 6 },
  { id: 'hank', name: 'Hank', blurb: 'A bargain hunter: steady companies that are down, little leverage.', pool: 'stocks', pick: 'reversal', side: 'long', leverage: [1, 3], stake: [0.7, 0.9], enterAfter: [3, 20], holdFor: [60, 120], trades: 2, stopPct: 3, takePct: 5 },
];

export function personaOf(id: string): Persona | undefined {
  return PERSONAS.find((p) => p.id === id);
}

export const BOT_NAME_SUFFIX = ' (bot)';

/** The user id of the bot with this style, made on first use. */
export function botUserId(db: Db, persona: Persona, nowMs: number): number {
  const have = db.get<{ user_id: number }>('SELECT user_id FROM bots WHERE persona = ?', persona.id);
  if (have) return have.user_id;
  return db.tx(() => {
    const made = db.run("INSERT INTO users(username, display_name, pw_hash, role, created_ms) VALUES (?, ?, 'bot', 'player', ?)", `bot-${persona.id}`, `${persona.name}${BOT_NAME_SUFFIX}`, nowMs);
    db.run('INSERT INTO bots(user_id, persona) VALUES (?, ?)', made.lastInsertRowid, persona.id);
    return made.lastInsertRowid;
  });
}

/** A bot that is not in an unfinished match, chosen by rotating through the styles (so the same one does not always come first). */
export function freeBot(db: Db, rotate: number, nowMs: number): number | null {
  for (let i = 0; i < PERSONAS.length; i += 1) {
    const persona = PERSONAS[(Math.abs(rotate) + i) % PERSONAS.length] as Persona;
    const id = botUserId(db, persona, nowMs);
    const busy = db.get('SELECT 1 FROM match_players WHERE user_id = ? AND active = 1', id);
    if (!busy) return id;
  }
  return null;
}

// ---- seeded numbers ----------------------------------------------------------------------------------------------------

/** mulberry32: a small seeded generator, so a bot plays the same way when the same match is replayed in a test. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function between(rng: () => number, range: readonly [number, number]): number {
  return range[0] + Math.floor(rng() * (range[1] - range[0] + 1));
}

export function fraction(rng: () => number, range: readonly [number, number]): number {
  return range[0] + rng() * (range[1] - range[0]);
}

// ---- playing a match ---------------------------------------------------------------------------------------------------

interface Memory {
  readonly persona: Persona;
  readonly rng: () => number;
  entries: number;
  failures: number;
  orders: number;
  nextAt: number;
  closeAt: number;
  open: { companyId: number; short: boolean } | null;
}

interface LiveBotRow {
  match_id: number;
  start_tick: number;
  end_tick: number;
  user_id: number;
  account_id: number;
  persona: string;
}

export interface BotTraderOptions {
  readonly db: Db;
  readonly world: WorldRuntime;
  readonly trading: Trading;
  readonly log: Logger;
}

/** The ticks before the end after which a bot opens nothing new (it could not do anything with it). */
const NO_NEW_TRADES_LAST_TICKS = 12;

export class BotTrader {
  private readonly db: Db;
  private readonly world: WorldRuntime;
  private readonly trading: Trading;
  private readonly log: Logger;
  private readonly memory = new Map<number, Memory>();
  private lastError = 0;

  constructor(o: BotTraderOptions) {
    this.db = o.db;
    this.world = o.world;
    this.trading = o.trading;
    this.log = o.log;
  }

  /** Called once per market tick: every live match with a bot gives the bot a turn. */
  step(): void {
    const tick = this.world.sim.tick;
    const rows = this.db.all<LiveBotRow>(
      `SELECT m.id AS match_id, m.start_tick, m.end_tick, p.user_id, p.account_id, b.persona
         FROM matches m JOIN match_players p ON p.match_id = m.id AND p.active = 1 JOIN bots b ON b.user_id = p.user_id
        WHERE m.state = 'live' AND p.account_id IS NOT NULL`,
    );
    const live = new Set<number>();
    for (const r of rows) {
      live.add(r.match_id);
      try {
        this.turn(r, tick);
      } catch (error) {
        const now = Date.now();
        if (now - this.lastError > 10_000) {
          this.lastError = now;
          this.log.warn('bots', `A bot could not take its turn in match ${r.match_id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    for (const id of [...this.memory.keys()]) if (!live.has(id)) this.memory.delete(id);
  }

  private turn(r: LiveBotRow, tick: number): void {
    if (tick < r.start_tick || tick >= r.end_tick - 1) return;
    let mem = this.memory.get(r.match_id);
    if (!mem) {
      const persona = personaOf(r.persona);
      if (!persona) return;
      const rng = seeded(r.match_id * 7919 + r.user_id);
      mem = { persona, rng, entries: 0, failures: 0, orders: 0, nextAt: r.start_tick + between(rng, persona.enterAfter), closeAt: 0, open: null };
      this.memory.set(r.match_id, mem);
    }
    if (mem.open !== null) {
      const held = this.db.get<{ shares: number }>('SELECT shares FROM positions WHERE account_id = ? AND company_id = ? AND short = ?', r.account_id, mem.open.companyId, mem.open.short ? 1 : 0);
      if (!held || held.shares <= 0) {
        // The market closed it (stop-loss, take-profit or liquidation): look for the next chance after a short pause.
        mem.open = null;
        mem.nextAt = tick + between(mem.rng, [3, 12]);
        return;
      }
      if (tick >= mem.closeAt) this.close(r, mem, held.shares, tick);
      return;
    }
    if (mem.entries >= mem.persona.trades || tick < mem.nextAt || tick > r.end_tick - NO_NEW_TRADES_LAST_TICKS) return;
    this.open(r, mem, tick);
  }

  /** What a bot may know: the companies' closes over the last minute of FINISHED candles, nothing newer. */
  private movers(): { companyId: number; ret: number }[] {
    const last = Math.floor(this.world.savedTick / 10) - 1;
    const then = last - 6;
    if (then < 1) return [];
    const closes = new Map<string, number>();
    for (const row of this.db.all<{ company_id: number; idx: number; close: number }>('SELECT company_id, idx, close FROM candles_c10 WHERE idx = ? OR idx = ?', last, then)) closes.set(`${row.company_id}:${row.idx}`, row.close);
    const out: { companyId: number; ret: number }[] = [];
    // Companies players launched cannot be traded in a match (the order would be refused), so a bot never looks at them.
    const launched = new Set(this.db.all<{ company_id: number }>('SELECT company_id FROM launches').map((r) => r.company_id));
    for (const c of this.world.companies) {
      if (!this.world.sim.isListed(c.id) || launched.has(c.id)) continue;
      const a = closes.get(`${c.id}:${last}`);
      const b = closes.get(`${c.id}:${then}`);
      if (a === undefined || b === undefined || b <= 0) continue;
      out.push({ companyId: c.id, ret: a / b - 1 });
    }
    return out;
  }

  private choose(mem: Memory): { companyId: number; short: boolean } | null {
    const p = mem.persona;
    const isCoin = (id: number): boolean => this.world.companies[id]?.sector === 'meme';
    let pool = this.movers().filter((m) => (p.pool === 'any' ? true : p.pool === 'coins' ? isCoin(m.companyId) : !isCoin(m.companyId)));
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
    const pick = pool[Math.floor(mem.rng() * pool.length)];
    if (!pick) return null;
    const short = p.side === 'short' || (p.side === 'either' && mem.rng() < 0.5);
    return { companyId: pick.companyId, short };
  }

  private orderId(r: LiveBotRow, mem: Memory): string {
    mem.orders += 1;
    return `bot-${r.match_id}-${r.user_id}-${mem.orders}`;
  }

  private open(r: LiveBotRow, mem: Memory, tick: number): void {
    const choice = this.choose(mem);
    if (!choice) {
      mem.nextAt = tick + 5;
      return;
    }
    const acc = this.trading.account(r.account_id);
    if (!acc) return;
    const quote = this.world.quote(choice.companyId);
    const price = choice.short ? quote.bid : quote.ask;
    if (price < 1) {
      mem.nextAt = tick + 5;
      return;
    }
    const lever = between(mem.rng, mem.persona.leverage);
    const stake = fraction(mem.rng, mem.persona.stake);
    // Try the planned leverage with its exits, then without exits, then less leverage, then none: a bot never gets stuck on a refusal.
    const attempts: { leverage: number; exits: boolean }[] = [
      { leverage: lever, exits: true },
      { leverage: lever, exits: false },
      { leverage: Math.max(1, Math.floor(lever / 2)), exits: false },
      { leverage: 1, exits: false },
    ];
    for (const a of attempts) {
      const qty = Math.min(maxOrderShares(price), Math.floor((acc.cash_cents * stake * a.leverage) / price));
      if (qty < 1) continue;
      const stopPct = mem.persona.stopPct > 0 ? Math.min(mem.persona.stopPct, 60 / a.leverage) : 0;
      const takePct = mem.persona.takePct;
      const up = (pct: number): number => Math.ceil(quote.mid * (1 + pct / 100));
      const down = (pct: number): number => Math.max(1, Math.floor(quote.mid * (1 - pct / 100)));
      try {
        this.trading.placeOrder({
          accountId: r.account_id,
          clientOrderId: this.orderId(r, mem),
          companyId: choice.companyId,
          side: choice.short ? 'sell' : 'buy',
          qty,
          short: choice.short,
          leverage: a.leverage,
          ...(a.exits && stopPct > 0 ? { stopPrice: choice.short ? up(stopPct) : down(stopPct) } : {}),
          ...(a.exits && takePct > 0 ? { takePrice: choice.short ? down(takePct) : up(takePct) } : {}),
        });
      } catch (error) {
        if (error instanceof OrderError) continue;
        throw error;
      }
      mem.entries += 1;
      mem.open = { companyId: choice.companyId, short: choice.short };
      mem.closeAt = tick + between(mem.rng, mem.persona.holdFor);
      this.log.info('bots', `${mem.persona.name} opened ${choice.short ? 'a short' : 'a long'} position in company ${choice.companyId} in match ${r.match_id}.`);
      return;
    }
    // Nothing could be opened (the company may be halted, or there is no depth): try again a little later, and give up after a while.
    mem.failures += 1;
    mem.nextAt = tick + 4;
    if (mem.failures >= 8) mem.entries = mem.persona.trades;
  }

  private close(r: LiveBotRow, mem: Memory, shares: number, tick: number): void {
    const open = mem.open as { companyId: number; short: boolean };
    try {
      this.trading.placeOrder({ accountId: r.account_id, clientOrderId: this.orderId(r, mem), companyId: open.companyId, side: open.short ? 'buy' : 'sell', qty: Math.min(shares, maxOrderShares(this.world.sim.price(open.companyId))), short: open.short });
    } catch (error) {
      if (!(error instanceof OrderError)) throw error;
      mem.closeAt = tick + 3; // refused (halted, thin book...): try again in a moment
      return;
    }
    const left = this.db.get<{ shares: number }>('SELECT shares FROM positions WHERE account_id = ? AND company_id = ? AND short = ?', r.account_id, open.companyId, open.short ? 1 : 0);
    if (!left || left.shares <= 0) {
      mem.open = null;
      mem.nextAt = tick + between(mem.rng, [2, 10]);
    } else {
      mem.closeAt = tick + 1; // only part of it fit in the order book: sell the rest on the next turn
    }
  }
}
