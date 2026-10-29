// The billboard (docs/world.md §30).
//
// Three places at the top of the Market and Memecoins tabs show a company to everybody for some hours. A player books a place by paying Career cash. The rules:
//   • He may only show a company HE LAUNCHED (a stock or a memecoin he made in the Launch tab), never somebody else's and never one of the built-in ones.
//   • A place costs the same per hour (BILLBOARD_CENTS_PER_HOUR) whichever place it is and whoever books; first come, first served. A taken place cannot be taken over.
//   • He may book 1, 3, 6, 12 or 24 hours. The money comes out of his Career cash and is gone for good (like the Shop and a new username), so his net worth, his place on
//     the leaderboard and his growth this week all go down by the price. Nothing is ever refunded.
//   • One place per player at a time. He may add hours to his own place for the same company, but never so that it runs longer than 24 hours from now.
//   • A company that died (bankrupt, or a memecoin whose pool was drained) stops being shown and frees its place. A banned player's booking is not shown either.
//   • It only SHOWS the company: its picture, name and live price, and a click opens its page. It never changes a price, a ranking rule or what anybody can trade.
//   • Only real players book. Computer players never do. The page never decides who has which place: it only asks, and shows what the server answers.
// Everybody (signed in or not) can see the billboard, like the pictures of the companies: the market is public.

import { BILLBOARD_HOURS, BILLBOARD_MAX_HOURS_AHEAD, BILLBOARD_SLOTS, billboardPriceCents, hoursText } from '../src/shared/billboardCatalog';
import { priceText } from '../src/shared/cosmeticCatalog';
import type { User } from './auth';
import type { Logger } from './log';
import type { Db } from './sqlite';

export class BillboardError extends Error {
  constructor(
    readonly code: 'bad_request' | 'no_such_company' | 'not_yours' | 'company_dead' | 'slot_taken' | 'one_place' | 'other_company' | 'too_long' | 'not_enough_cash' | 'cannot_book',
    message: string,
    readonly status: number,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export interface BillboardDeps {
  readonly db: Db;
  readonly now: () => number;
  readonly log: Logger;
  /** Tells every page (signed in or not) what the billboard shows now. */
  readonly publish: (event: string, data: unknown) => void;
  /** Told after a player spent money, so the leaderboards forget their kept ranking and show the new net worth at once. */
  readonly spent?: (userId: number) => void;
  /** True for a banned player (his booking is not shown). */
  readonly isBanned?: (userId: number) => boolean;
}

/** What one place shows. */
export interface BillboardRental {
  readonly ticker: string;
  readonly name: string;
  /** The player who booked it. */
  readonly byUsername: string;
  readonly byName: string;
  readonly startsMs: number;
  readonly endsMs: number;
}

export interface BillboardSlotView {
  readonly slot: number;
  readonly rental: BillboardRental | null;
}

/** The part of the answer that is the same for everybody (and is also pushed to every page when something changes). */
export interface BillboardPublic {
  readonly slots: readonly BillboardSlotView[];
}

/** What one player may do: his cash, the companies he launched that can be shown, and whether he has a place. */
export interface BillboardMine {
  readonly cashCents: number;
  readonly launched: readonly { readonly ticker: string; readonly name: string; readonly kind: 'stock' | 'coin' }[];
}

export interface BillboardView extends BillboardPublic {
  readonly serverMs: number;
  readonly centsPerHour: number;
  readonly hours: readonly number[];
  readonly maxHoursAhead: number;
  /** Null for a visitor who is not signed in. */
  readonly mine: BillboardMine | null;
}

export interface BookResult extends BillboardView {
  /** What was just booked. */
  readonly booked: {
    readonly slot: number;
    readonly ticker: string;
    readonly hours: number;
    readonly priceCents: number;
    /** True when the player added hours to a booking he already had. */
    readonly extended: boolean;
    readonly endsMs: number;
  };
}

interface RentalRow {
  id: number;
  slot: number;
  user_id: number;
  company_id: number;
  starts_ms: number;
  ends_ms: number;
  ticker: string;
  name: string;
  username: string;
  display_name: string;
}

/** A company that can still be shown: it did not go bankrupt and (for a memecoin with a pool) the pool was not drained. */
const ALIVE = `NOT EXISTS (SELECT 1 FROM bankruptcies b WHERE b.company_id = c.id)
  AND NOT EXISTS (SELECT 1 FROM coin_pools p WHERE p.company_id = c.id AND p.drained_ms IS NOT NULL)`;

export class Billboard {
  constructor(private readonly d: BillboardDeps) {}

  private isBot(userId: number): boolean {
    return this.d.db.get('SELECT 1 AS x FROM bots WHERE user_id = ?', userId) !== undefined;
  }

  private accountOf(userId: number): { id: number; cash: number } | null {
    const a = this.d.db.get<{ id: number; cash_cents: number }>("SELECT id, cash_cents FROM accounts WHERE user_id = ? AND kind = 'career'", userId);
    return a ? { id: a.id, cash: a.cash_cents } : null;
  }

  /** Every booking that is running now and whose company is alive and whose player is not banned, newest first. */
  private live(): RentalRow[] {
    const now = this.d.now();
    const rows = this.d.db.all<RentalRow>(
      `SELECT r.id, r.slot, r.user_id, r.company_id, r.starts_ms, r.ends_ms, c.ticker, c.name, u.username, u.display_name
         FROM billboard_rentals r
         JOIN companies c ON c.id = r.company_id
         JOIN users u ON u.id = r.user_id
        WHERE r.starts_ms <= ? AND r.ends_ms > ? AND ${ALIVE}
        ORDER BY r.created_ms DESC, r.id DESC`,
      now,
      now,
    );
    return rows.filter((r) => !this.d.isBanned?.(r.user_id));
  }

  /** What every page sees. */
  publicView(): BillboardPublic {
    const live = this.live();
    const slots: BillboardSlotView[] = [];
    for (let slot = 1; slot <= BILLBOARD_SLOTS; slot += 1) {
      const row = live.find((r) => r.slot === slot);
      slots.push({
        slot,
        rental: row ? { ticker: row.ticker, name: row.name, byUsername: row.username, byName: row.display_name, startsMs: row.starts_ms, endsMs: row.ends_ms } : null,
      });
    }
    return { slots };
  }

  /** The companies this player launched that can be shown (alive), newest first. */
  private launchedBy(userId: number): BillboardMine['launched'] {
    return this.d.db
      .all<{ ticker: string; name: string; kind: 'stock' | 'coin' }>(
        `SELECT c.ticker, c.name, l.kind FROM launches l JOIN companies c ON c.id = l.company_id
          WHERE l.user_id = ? AND ${ALIVE} ORDER BY l.created_ms DESC, c.id DESC LIMIT 50`,
        userId,
      )
      .map((r) => ({ ticker: r.ticker, name: r.name, kind: r.kind }));
  }

  view(me: User | null): BillboardView {
    return {
      ...this.publicView(),
      serverMs: this.d.now(),
      centsPerHour: billboardPriceCents(1),
      hours: BILLBOARD_HOURS,
      maxHoursAhead: BILLBOARD_MAX_HOURS_AHEAD,
      mine: me ? { cashCents: this.accountOf(me.id)?.cash ?? 0, launched: this.launchedBy(me.id) } : null,
    };
  }

  /**
   * Books a place for one of his own companies, or adds hours to the place he already has. Everything is checked again inside one transaction, so two players
   * asking for the same place at the same moment can never both get it. (Asking twice for your own place is on purpose an extension and is paid twice: the page
   * asks "Book" and then "Confirm", and it does not let a second request out while the first one is still on its way.)
   */
  book(me: User, rawSlot: unknown, rawTicker: unknown, rawHours: unknown): BookResult {
    if (typeof rawSlot !== 'number' || !Number.isInteger(rawSlot) || rawSlot < 1 || rawSlot > BILLBOARD_SLOTS) {
      throw new BillboardError('bad_request', `slot must be a whole number from 1 to ${BILLBOARD_SLOTS}.`, 400);
    }
    if (typeof rawHours !== 'number' || !BILLBOARD_HOURS.includes(rawHours)) {
      throw new BillboardError('bad_request', `hours must be one of: ${BILLBOARD_HOURS.join(', ')}.`, 400);
    }
    const ticker = typeof rawTicker === 'string' ? rawTicker.trim() : '';
    if (ticker === '' || ticker.length > 12) throw new BillboardError('bad_request', 'ticker must be the ticker of a company you launched.', 400);
    const slot = rawSlot;
    const hours = rawHours;
    const price = billboardPriceCents(hours);
    const now = this.d.now();
    let extended = false;
    let endsMs = 0;
    this.d.db.tx(() => {
      if (this.isBot(me.id)) throw new BillboardError('cannot_book', 'Computer players do not book the billboard.', 403);
      const company = this.d.db.get<{ id: number; ticker: string; name: string }>('SELECT id, ticker, name FROM companies WHERE ticker = ? OR ticker = ?', ticker, ticker.toUpperCase());
      if (!company) throw new BillboardError('no_such_company', 'There is no company with that ticker.', 404);
      if (!this.d.db.get('SELECT 1 AS x FROM launches WHERE company_id = ? AND user_id = ?', company.id, me.id)) {
        throw new BillboardError('not_yours', `You can only show a company you launched yourself, and you did not launch ${company.ticker}.`, 403);
      }
      const alive = this.d.db.get(`SELECT 1 AS x FROM companies c WHERE c.id = ? AND ${ALIVE}`, company.id);
      if (!alive) throw new BillboardError('company_dead', `${company.ticker} is dead, so it cannot be shown.`, 409);

      const live = this.live();
      const here = live.find((r) => r.slot === slot);
      const mine = live.find((r) => r.user_id === me.id);
      if (here && here.user_id !== me.id) {
        throw new BillboardError('slot_taken', `Place ${slot} is taken. Pick another place, or come back when it is free.`, 409, { slot, untilMs: here.ends_ms });
      }
      if (mine && mine.slot !== slot) {
        throw new BillboardError('one_place', `You already have place ${mine.slot}. A player can have one place at a time.`, 409, { slot: mine.slot, untilMs: mine.ends_ms });
      }
      if (here && here.company_id !== company.id) {
        throw new BillboardError('other_company', `Place ${slot} is yours for ${here.ticker}. You can add hours for ${here.ticker}, or wait until it ends to show ${company.ticker}.`, 409, { slot, untilMs: here.ends_ms });
      }
      const ends = (here ? here.ends_ms : now) + hours * 3_600_000;
      if (ends > now + BILLBOARD_MAX_HOURS_AHEAD * 3_600_000) {
        throw new BillboardError('too_long', `A place can run for at most ${hoursText(BILLBOARD_MAX_HOURS_AHEAD)} from now. Pick fewer hours.`, 400, { untilMs: here ? here.ends_ms : now });
      }
      const account = this.accountOf(me.id);
      if (!account) throw new BillboardError('cannot_book', 'You have no Career account to pay from.', 409);
      if (account.cash < price) {
        throw new BillboardError(
          'not_enough_cash',
          `${hoursText(hours)} on the billboard costs ${priceText(price)} of Career cash, and you have $${(account.cash / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}.`,
          400,
          { cashCents: account.cash, needCents: price },
        );
      }
      const paid = this.d.db.run('UPDATE accounts SET cash_cents = cash_cents - ? WHERE id = ? AND cash_cents >= ?', price, account.id, price);
      if (paid.changes !== 1) throw new BillboardError('not_enough_cash', 'Your cash changed while you were booking. Try again.', 409);
      if (here) {
        // Adding hours to his own running booking: one row keeps growing (the total he paid is kept in it).
        this.d.db.run('UPDATE billboard_rentals SET ends_ms = ?, hours = hours + ?, price_cents = price_cents + ? WHERE id = ?', ends, hours, price, here.id);
        extended = true;
      } else {
        this.d.db.run(
          'INSERT INTO billboard_rentals(slot, user_id, company_id, starts_ms, ends_ms, hours, price_cents, created_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          slot,
          me.id,
          company.id,
          now,
          ends,
          hours,
          price,
          now,
        );
      }
      endsMs = ends;
    });
    this.d.log.info('account', `${me.username} ${extended ? 'added' : 'booked'} ${hoursText(hours)} of billboard place ${slot} for ${ticker.toUpperCase()} (${priceText(price)}).`);
    this.d.spent?.(me.id);
    this.d.publish('billboard', this.publicView());
    return { ...this.view(me), booked: { slot, ticker: ticker.toUpperCase(), hours, priceCents: price, extended, endsMs } };
  }
}
