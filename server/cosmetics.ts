// The Shop: things to wear (docs/world.md §29).
//
// A player can buy things that change how he looks to other players: the colour of his name, a glow around it, a ring around his picture and a title under
// his name. The list, with the kind, the rarity and the price of each, is src/shared/cosmeticCatalog.ts. The rules here:
//   • The price comes out of the cash of his Career account and is gone (like the cost of a new username). Spending therefore lowers his net worth, so it lowers his
//     place on the leaderboard and his growth on the weekly board. Nothing here gives money back and nothing is ever refunded.
//   • A thing is bought once and owned for good (money reset by the owner does not take it away). Buying it again is refused, so a double click cannot charge twice.
//   • A few Legendary things also need a badge the player has already earned.
//   • He wears at most one thing in each place and can change or take it off whenever he likes, for free. A newly bought thing is worn at once.
//   • It is all looks: nothing here changes a price, an order, a ranking rule or what a player can trade.
//   • Only real players buy. Computer players never do, and the page never decides who owns what: it only asks, and shows what the server answers.
// Everybody who is signed in sees what everybody wears (GET /api/looks, kept fresh by the "looks" event of the live stream), like the profile pictures.

import { badgeById } from '../src/shared/badgeCatalog';
import { COSMETICS, cleanLook, cosmeticById, isSlot, priceOf, priceText, type Look, type Slot } from '../src/shared/cosmeticCatalog';
import type { User } from './auth';
import type { Logger } from './log';
import type { Db } from './sqlite';

export class ShopError extends Error {
  constructor(
    readonly code: 'bad_request' | 'no_such_item' | 'already_owned' | 'not_owned' | 'wrong_place' | 'badge_needed' | 'not_enough_cash' | 'cannot_buy',
    message: string,
    readonly status: number,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export interface ShopDeps {
  readonly db: Db;
  readonly now: () => number;
  readonly log: Logger;
  /** Tells every signed-in page what one player wears now. */
  readonly publish: (event: string, data: unknown) => void;
  /** Told after a player spent money, so the leaderboards forget their kept ranking and show the new net worth at once. */
  readonly spent?: (userId: number) => void;
  /** Gives the player any badge he has just earned (the badge sweep otherwise runs every 45 seconds), so a thing that needs a badge is not refused for a slow sweep. */
  readonly refreshBadges?: (userId: number) => void;
}

/** What the Shop page shows about the player: his cash, what he owns, what he wears, and which of the badges some things need he already has. */
export interface ShopView {
  readonly cashCents: number;
  readonly owned: readonly string[];
  readonly equipped: Look;
  /** The badges (ids) the player has among the ones Legendary things need. */
  readonly badges: readonly string[];
}

export interface BuyResult extends ShopView {
  readonly item: string;
  readonly priceCents: number;
}

/** The badges any thing needs (so the view can say which of them the player has). */
const NEEDED_BADGES: readonly string[] = [...new Set(COSMETICS.map((c) => c.requiresBadge).filter((b): b is string => b !== undefined))];

interface LookRow {
  color: string | null;
  glow: string | null;
  frame: string | null;
  title: string | null;
}

function lookOfRow(row: LookRow | undefined): Look {
  if (!row) return {};
  return cleanLook({ color: row.color ?? undefined, glow: row.glow ?? undefined, frame: row.frame ?? undefined, title: row.title ?? undefined });
}

export class Shop {
  constructor(private readonly d: ShopDeps) {}

  private isBot(userId: number): boolean {
    return this.d.db.get('SELECT 1 AS x FROM bots WHERE user_id = ?', userId) !== undefined;
  }

  private accountOf(userId: number): { id: number; cash: number } | null {
    const a = this.d.db.get<{ id: number; cash_cents: number }>("SELECT id, cash_cents FROM accounts WHERE user_id = ? AND kind = 'career'", userId);
    return a ? { id: a.id, cash: a.cash_cents } : null;
  }

  lookOf(userId: number): Look {
    return lookOfRow(this.d.db.get<LookRow>('SELECT color, glow, frame, title FROM user_looks WHERE user_id = ?', userId));
  }

  /** Everybody who wears anything: username -> what he wears. */
  looks(): Record<string, Look> {
    const rows = this.d.db.all<LookRow & { username: string }>(
      'SELECT u.username AS username, l.color, l.glow, l.frame, l.title FROM user_looks l JOIN users u ON u.id = l.user_id ORDER BY u.id',
    );
    const out: Record<string, Look> = {};
    for (const r of rows) {
      const look = lookOfRow(r);
      if (look.color !== undefined || look.glow !== undefined || look.frame !== undefined || look.title !== undefined) out[r.username] = look;
    }
    return out;
  }

  view(me: User): ShopView {
    const { db } = this.d;
    const owned = db.all<{ item: string }>('SELECT item FROM user_cosmetics WHERE user_id = ? ORDER BY bought_ms, item', me.id).map((r) => r.item);
    const marks = NEEDED_BADGES.map(() => '?').join(', ');
    const have = db.all<{ badge: string }>(`SELECT badge FROM user_badges WHERE user_id = ? AND badge IN (${marks})`, me.id, ...NEEDED_BADGES).map((r) => r.badge);
    return { cashCents: this.accountOf(me.id)?.cash ?? 0, owned: owned.filter((id) => cosmeticById(id) !== undefined), equipped: this.lookOf(me.id), badges: have };
  }

  /** Buys one thing and puts it on. Everything is checked again inside one transaction, so two clicks at once can never charge twice. */
  buy(me: User, rawItem: unknown): BuyResult {
    if (typeof rawItem !== 'string') throw new ShopError('bad_request', 'item must be the id of something in the Shop.', 400);
    const def = cosmeticById(rawItem);
    if (!def) throw new ShopError('no_such_item', 'There is nothing like that in the Shop.', 404);
    const price = priceOf(def);
    const now = this.d.now();
    // A badge he earned a moment ago counts: look for new ones before checking (only when this thing needs one).
    if (def.requiresBadge !== undefined && !this.isBot(me.id)) this.d.refreshBadges?.(me.id);
    this.d.db.tx(() => {
      if (this.isBot(me.id)) throw new ShopError('cannot_buy', 'Computer players do not shop.', 403);
      if (this.d.db.get('SELECT 1 AS x FROM user_cosmetics WHERE user_id = ? AND item = ?', me.id, def.id)) {
        throw new ShopError('already_owned', `You already own ${def.name}. You can wear it from the Shop.`, 409);
      }
      if (def.requiresBadge !== undefined && !this.d.db.get('SELECT 1 AS x FROM user_badges WHERE user_id = ? AND badge = ?', me.id, def.requiresBadge)) {
        const need = badgeById(def.requiresBadge)?.name ?? def.requiresBadge;
        throw new ShopError('badge_needed', `${def.name} is only for players who have earned the "${need}" badge.`, 403, { badge: def.requiresBadge });
      }
      const account = this.accountOf(me.id);
      if (!account) throw new ShopError('cannot_buy', 'You have no Career account to pay from.', 409);
      if (account.cash < price) {
        throw new ShopError(
          'not_enough_cash',
          `${def.name} costs ${priceText(price)} of Career cash, and you have $${(account.cash / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}.`,
          400,
          { cashCents: account.cash, needCents: price },
        );
      }
      const paid = this.d.db.run('UPDATE accounts SET cash_cents = cash_cents - ? WHERE id = ? AND cash_cents >= ?', price, account.id, price);
      if (paid.changes !== 1) throw new ShopError('not_enough_cash', 'Your cash changed while you were buying. Try again.', 409);
      this.d.db.run('INSERT INTO user_cosmetics(user_id, item, bought_ms, price_cents) VALUES (?, ?, ?, ?)', me.id, def.id, now, price);
      this.wear(me.id, def.slot, def.id, now);
    });
    this.d.log.info('account', `${me.username} bought "${def.name}" in the Shop for ${priceText(price)}.`);
    this.d.spent?.(me.id);
    this.announce(me);
    return { ...this.view(me), item: def.id, priceCents: price };
  }

  /** Puts a thing he owns on (or takes the place's thing off when `rawItem` is null). Free. */
  equip(me: User, rawSlot: unknown, rawItem: unknown): { equipped: Look } {
    if (!isSlot(rawSlot)) throw new ShopError('bad_request', 'slot must be color, glow, frame or title.', 400);
    const slot: Slot = rawSlot;
    const now = this.d.now();
    this.d.db.tx(() => {
      if (this.isBot(me.id)) throw new ShopError('cannot_buy', 'Computer players do not shop.', 403);
      if (rawItem === null || rawItem === undefined || rawItem === '') {
        this.wear(me.id, slot, null, now);
        return;
      }
      if (typeof rawItem !== 'string') throw new ShopError('bad_request', 'item must be the id of something you own, or null to take it off.', 400);
      const def = cosmeticById(rawItem);
      if (!def) throw new ShopError('no_such_item', 'There is nothing like that in the Shop.', 404);
      if (def.slot !== slot) throw new ShopError('wrong_place', `${def.name} is not worn in that place.`, 400);
      if (!this.d.db.get('SELECT 1 AS x FROM user_cosmetics WHERE user_id = ? AND item = ?', me.id, def.id)) {
        throw new ShopError('not_owned', `You do not own ${def.name} yet. Buy it in the Shop first.`, 403);
      }
      this.wear(me.id, slot, def.id, now);
    });
    this.announce(me);
    return { equipped: this.lookOf(me.id) };
  }

  /** Writes the one place of a player's look (inside a transaction). A player who then wears nothing has no row. */
  private wear(userId: number, slot: Slot, item: string | null, now: number): void {
    // `slot` is one of four fixed words (checked by isSlot / the catalog), never text from a player, so it is safe in the statement.
    this.d.db.run(
      `INSERT INTO user_looks(user_id, ${slot}, updated_ms) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET ${slot} = excluded.${slot}, updated_ms = excluded.updated_ms`,
      userId,
      item,
      now,
    );
    this.d.db.run('DELETE FROM user_looks WHERE user_id = ? AND color IS NULL AND glow IS NULL AND frame IS NULL AND title IS NULL', userId);
  }

  /** Tells every page what this player wears now (null = nothing). */
  private announce(me: User): void {
    const look = this.lookOf(me.id);
    const empty = look.color === undefined && look.glow === undefined && look.frame === undefined && look.title === undefined;
    this.d.publish('looks', { username: me.username, look: empty ? null : look });
  }
}
