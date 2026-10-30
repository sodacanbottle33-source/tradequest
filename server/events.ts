// Market events (docs/world.md §39). At most once a day, at 21:00 Tokyo time, something happens to the market: a storm that throws a few stocks up and down, a frenzy in some
// memecoins, a broad rally or a broad sell-off. Every company it touches gets a news headline and a price move exactly like the owner's "special events" (server/admin.ts shock),
// so the market, the news and the charts need no new code: this file only DECIDES what happens and asks the same machinery to do it, in the name of the owner's account.
//
// Fairness: the players are told ahead only that there will be an event at 21:00. The kind of event, the companies and the direction are decided when it starts (the choice of
// the day is made from the day number, kept in the "market_events" list so a restart never runs it twice), and nothing about them can be seen before the headlines come out. Moves
// are modest (a stock 4–12 %, a memecoin 20–45 %), never touch a company a player launched, and never a company that is not trading. If the server was off at 21:00 the event is
// still run when it comes back within CATCHUP_MS, otherwise the day is marked "missed" (no event) rather than run at an odd hour.
//
// It needs the news system (the headlines) and an owner account (the moves are recorded in the owner's log). Without either, or with TQ_EVENTS=0, there are no events.

import { dayOf, dayStartMs } from '../src/shared/goalCatalog';
import type { Admin } from './admin';
import type { User } from './auth';
import type { Logger } from './log';
import type { Db } from './sqlite';
import type { WorldRuntime } from './world/runtime';

/** The event starts this long after the day starts (Tokyo midnight): 21:00. */
export const EVENT_AT_MS = 21 * 3_600_000;
/** An event that is late by more than this is skipped. */
export const CATCHUP_MS = 30 * 60_000;
/** After it started, an event is shown as "happening now" for this long. */
export const LIVE_MS = 30 * 60_000;
/** How many finished events the page lists. */
export const RECENT_EVENTS = 5;

export type EventKind = 'storm' | 'frenzy' | 'rally' | 'selloff';

interface KindDef {
  readonly kind: EventKind;
  readonly name: string;
  readonly icon: string;
  readonly blurb: string;
  readonly weight: number;
  /** 'stock' or 'meme': what is moved. */
  readonly pool: 'stock' | 'meme';
  readonly count: number;
  /** The smallest and largest move in percent (the sign comes from `direction`). */
  readonly min: number;
  readonly max: number;
  readonly direction: 'mixed' | 'up' | 'down';
}

export const EVENT_KINDS: readonly KindDef[] = [
  { kind: 'storm', name: 'Market Storm', icon: '⛈️', blurb: 'Six stocks were thrown around: some up, some down.', weight: 3, pool: 'stock', count: 6, min: 5, max: 12, direction: 'mixed' },
  { kind: 'frenzy', name: 'Meme Frenzy', icon: '🚀', blurb: 'Five memecoins went wild, up and down.', weight: 2, pool: 'meme', count: 5, min: 20, max: 45, direction: 'mixed' },
  { kind: 'rally', name: 'Broad Rally', icon: '📈', blurb: 'Eight stocks climbed together.', weight: 1, pool: 'stock', count: 8, min: 4, max: 9, direction: 'up' },
  { kind: 'selloff', name: 'Sell-off', icon: '📉', blurb: 'Eight stocks slid together.', weight: 1, pool: 'stock', count: 8, min: 4, max: 9, direction: 'down' },
];

export function kindDef(kind: string): KindDef | undefined {
  return EVENT_KINDS.find((k) => k.kind === kind);
}

export interface EventMove {
  readonly ticker: string;
  readonly name: string;
  readonly pct: number;
}

export interface EventLine {
  readonly day: number;
  /** When it starts (or started). */
  readonly atMs: number;
  /** The kind is only told once the event has started. */
  readonly kind: EventKind | null;
  readonly name: string | null;
  readonly icon: string | null;
  readonly blurb: string | null;
  readonly status: 'planned' | 'done' | 'missed' | 'off';
  readonly moves: readonly EventMove[];
}

export interface EventsView {
  readonly serverMs: number;
  /** False when events are switched off (nothing is announced). */
  readonly enabled: boolean;
  /** The next event that has not started (today's before 21:00, or tomorrow's), or null. Its kind is never told. */
  readonly next: { readonly day: number; readonly atMs: number } | null;
  /** The event of the last half hour, if there is one. */
  readonly live: EventLine | null;
  /** The finished events, newest first. */
  readonly recent: readonly EventLine[];
}

export interface EventsDeps {
  readonly db: Db;
  readonly world: WorldRuntime;
  readonly now: () => number;
  readonly log: Logger;
  readonly admin: Pick<Admin, 'shock'>;
  /** False switches events off (TQ_EVENTS=0, or no news system). */
  readonly enabled: boolean;
  /** Tells every signed-in page that an event started. */
  readonly publish?: (event: string, data: unknown) => void;
}

interface Row {
  day: number;
  kind: string;
  planned_ms: number;
  status: 'planned' | 'done' | 'missed' | 'off';
  fired_ms: number | null;
  moves_json: string;
}

/** A small repeatable dice: the same seed always gives the same numbers. */
function dice(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class MarketEvents {
  constructor(private readonly d: EventsDeps) {}

  private owner(): User | null {
    const r = this.d.db.get<{ id: number; username: string; display_name: string; created_ms: number }>("SELECT id, username, display_name, created_ms FROM users WHERE role = 'owner' ORDER BY id LIMIT 1");
    return r ? { id: r.id, username: r.username, displayName: r.display_name, role: 'owner', createdMs: r.created_ms } : null;
  }

  private row(day: number): Row | undefined {
    return this.d.db.get<Row>('SELECT day, kind, planned_ms, status, fired_ms, moves_json FROM market_events WHERE day = ?', day);
  }

  /** The kind of a day: weighted by the dice of the day, and never the same as yesterday's. */
  private kindOf(day: number): KindDef {
    const yesterday = this.row(day - 1)?.kind;
    const pool = EVENT_KINDS.filter((k) => k.kind !== yesterday);
    const total = pool.reduce((s, k) => s + k.weight, 0);
    let roll = dice(day * 7919 + 17)() * total;
    for (const k of pool) {
      roll -= k.weight;
      if (roll < 0) return k;
    }
    return pool[0] as KindDef;
  }

  // ---- reading ------------------------------------------------------------------------------------------------------

  private line(r: Row, reveal: boolean): EventLine {
    const def = kindDef(r.kind);
    let moves: EventMove[] = [];
    try {
      moves = reveal ? (JSON.parse(r.moves_json) as EventMove[]) : [];
    } catch {
      moves = [];
    }
    return {
      day: r.day,
      atMs: dayStartMs(r.day) + EVENT_AT_MS,
      kind: reveal && def ? def.kind : null,
      name: reveal && def ? def.name : null,
      icon: reveal && def ? def.icon : null,
      blurb: reveal && def ? def.blurb : null,
      status: r.status,
      moves,
    };
  }

  view(): EventsView {
    const { db } = this.d;
    const nowMs = this.d.now();
    const day = dayOf(nowMs);
    if (!this.d.enabled) return { serverMs: nowMs, enabled: false, next: null, live: null, recent: [] };
    const todayAt = dayStartMs(day) + EVENT_AT_MS;
    const today = this.row(day);
    // Today's event is still to come until it has started (or been skipped); after that the next one is tomorrow's.
    const upcoming = nowMs < todayAt || (today?.status === 'planned' && nowMs - todayAt <= CATCHUP_MS);
    const next = upcoming ? { day, atMs: todayAt } : { day: day + 1, atMs: dayStartMs(day + 1) + EVENT_AT_MS };
    const done = db.all<Row>("SELECT day, kind, planned_ms, status, fired_ms, moves_json FROM market_events WHERE status = 'done' ORDER BY day DESC LIMIT ?", RECENT_EVENTS + 1);
    const first = done[0];
    const live = first && first.fired_ms !== null && nowMs - first.fired_ms <= LIVE_MS ? this.line(first, true) : null;
    const recent = done.filter((r) => !live || r.day !== live.day).slice(0, RECENT_EVENTS).map((r) => this.line(r, true));
    return { serverMs: nowMs, enabled: true, next, live, recent };
  }

  // ---- running ------------------------------------------------------------------------------------------------------

  /**
   * Plans today's event (once) and runs it when its time has come. The game calls this every few seconds. Returns the kind that was run just now, or null.
   * `planned` rows are never run twice: the row is claimed before anything is moved.
   */
  sweep(): EventKind | null {
    if (!this.d.enabled) return null;
    const { db } = this.d;
    const nowMs = this.d.now();
    const day = dayOf(nowMs);
    const at = dayStartMs(day) + EVENT_AT_MS;
    let row = this.row(day);
    if (!row) {
      const owner = this.owner();
      const def = this.kindOf(day);
      db.run('INSERT OR IGNORE INTO market_events(day, kind, planned_ms, status) VALUES (?, ?, ?, ?)', day, def.kind, nowMs, owner ? 'planned' : 'off');
      row = this.row(day);
    }
    if (!row || row.status !== 'planned' || nowMs < at) return null;
    if (nowMs - at > CATCHUP_MS) {
      db.run("UPDATE market_events SET status = 'missed' WHERE day = ? AND status = 'planned'", day);
      this.d.log.warn('events', `The market event of day ${day} was missed (the server was not running at 21:00).`);
      return null;
    }
    const owner = this.owner();
    if (!owner) return null;
    const def = kindDef(row.kind);
    if (!def) return null;
    return this.fire(day, def, owner, nowMs);
  }

  /** The companies an event of this kind may move: trading, not launched by a player, not bankrupt, of the right pool. */
  private candidates(pool: 'stock' | 'meme'): number[] {
    const { world, db } = this.d;
    const out: number[] = [];
    for (const c of world.companies) {
      if ((c.sector === 'meme') !== (pool === 'meme') || !world.isTrading(c.id)) continue;
      if (db.get('SELECT 1 AS x FROM launches WHERE company_id = ?', c.id)) continue;
      if (db.get('SELECT 1 AS x FROM bankruptcies WHERE company_id = ?', c.id)) continue;
      out.push(c.id);
    }
    return out;
  }

  private headline(def: KindDef, name: string, up: boolean): [string, string] {
    switch (def.kind) {
      case 'storm':
        return up ? [`${name} rides tonight's market storm higher`, `Traders piled into ${name} while the market storm blew through tonight.`] : [`${name} is hit hard by tonight's market storm`, `Sellers hammered ${name} while the market storm blew through tonight.`];
      case 'frenzy':
        return up ? [`${name} goes wild in tonight's meme frenzy`, `Coin traders rushed into ${name} in tonight's meme frenzy.`] : [`${name} gets dumped in tonight's meme frenzy`, `Coin traders rushed out of ${name} in tonight's meme frenzy.`];
      case 'rally':
        return [`${name} climbs as the market rallies tonight`, `A broad rally lifted ${name} and several other stocks tonight.`];
      default:
        return [`${name} slides in tonight's broad sell-off`, `A broad sell-off pushed ${name} and several other stocks lower tonight.`];
    }
  }

  private fire(day: number, def: KindDef, owner: User, nowMs: number): EventKind | null {
    const { db } = this.d;
    const roll = dice(day * 104729 + def.weight * 31 + def.count);
    const list = this.candidates(def.pool);
    // A seeded shuffle, then the first `count`.
    for (let i = list.length - 1; i > 0; i -= 1) {
      const j = Math.floor(roll() * (i + 1));
      [list[i], list[j]] = [list[j] as number, list[i] as number];
    }
    const chosen = list.slice(0, def.count);
    if (chosen.length === 0) {
      db.run("UPDATE market_events SET status = 'missed' WHERE day = ? AND status = 'planned'", day);
      return null;
    }
    // Mixed events: half up, half down (the order is shuffled too).
    const ups = chosen.map((_, i) => (def.direction === 'up' ? true : def.direction === 'down' ? false : i % 2 === 0));
    for (let i = ups.length - 1; i > 0; i -= 1) {
      const j = Math.floor(roll() * (i + 1));
      [ups[i], ups[j]] = [ups[j] as boolean, ups[i] as boolean];
    }
    const plan = chosen.map((id, i) => {
      const size = Math.round((def.min + roll() * (def.max - def.min)) * 10) / 10;
      return { id, pct: ups[i] ? size : -size };
    });
    // Claim the day first: from here on nothing runs it again, even after a crash.
    const claimed = db.run("UPDATE market_events SET status = 'done', fired_ms = ? WHERE day = ? AND status = 'planned'", nowMs, day);
    if (claimed.changes !== 1) return null;
    const moves: EventMove[] = [];
    for (const p of plan) {
      const c = this.d.world.companies[p.id];
      if (!c) continue;
      const [headline, body] = this.headline(def, c.name, p.pct > 0);
      try {
        this.d.admin.shock(owner, { requestId: `ev-${day}-${c.ticker}`, ticker: c.ticker, percent: p.pct, style: 'custom', speed: 'fast', headline, body, breaking: true });
        moves.push({ ticker: c.ticker, name: c.name, pct: p.pct });
      } catch (error) {
        this.d.log.warn('events', `The ${def.name} could not move ${c.ticker}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    db.run('UPDATE market_events SET moves_json = ? WHERE day = ?', JSON.stringify(moves), day);
    this.d.log.info('events', `${def.name} ran: ${moves.map((m) => `${m.ticker} ${m.pct > 0 ? '+' : ''}${m.pct}%`).join(', ') || 'nothing moved'}.`);
    if (moves.length === 0) {
      db.run("UPDATE market_events SET status = 'missed' WHERE day = ?", day);
      return null;
    }
    this.d.publish?.('marketevent', { kind: def.kind, name: def.name, icon: def.icon, blurb: def.blurb, day, count: moves.length });
    return def.kind;
  }
}

