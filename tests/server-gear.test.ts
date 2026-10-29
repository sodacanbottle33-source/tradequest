// The Shop's things for your OWN screen (server/cosmetics.ts, src/shared/cosmeticCatalog.ts, docs/world.md §30): the colours and shape of the candles, the background and an
// effect on the price chart, and the style of the party after a win. They are bought and owned like every other Shop thing, but only the player himself is ever told what he has on:
// they are not in the list of what everybody wears, not on the profile card, and not in the live stream that goes to the other players.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS, migrate } from '../server/schema';
import { Db } from '../server/sqlite';
import { BADGES } from '../src/shared/badgeCatalog';
import {
  ALL_SLOT_IDS,
  COSMETICS,
  GEAR_SLOTS,
  RARITY_PRICE_CENTS,
  SLOTS,
  chartClasses,
  cleanGear,
  cleanLook,
  cosmeticById,
  gearIsEmpty,
  isGearSlot,
  isSlot,
  priceOf,
} from '../src/shared/cosmeticCatalog';
import { LONG, db, idOf, liveRig, until, type Running } from './helpers/chatlive';

const { boot, call, signUp, listen } = liveRig('gear');

const view = async (r: Running, cookie: string) => (await call(r, '/api/shop', { cookie })).json;
const gearOf = async (r: Running, cookie: string) => (await call(r, '/api/gear', { cookie })).json;
const buy = (r: Running, cookie: string | undefined, item: unknown) => call(r, '/api/shop/buy', { method: 'POST', cookie, body: { item } });
const equip = (r: Running, cookie: string | undefined, slot: unknown, item: unknown) => call(r, '/api/shop/equip', { method: 'POST', cookie, body: { slot, item } });
const cash = (r: Running, name: string): number => db(r).get<{ c: number }>("SELECT a.cash_cents AS c FROM accounts a JOIN users u ON u.id = a.user_id WHERE u.username = ? AND a.kind = 'career'", name)?.c as number;
const setCash = (r: Running, name: string, cents: number): void => {
  db(r).run("UPDATE accounts SET cash_cents = ? WHERE kind = 'career' AND user_id = (SELECT id FROM users WHERE username = ?)", cents, name);
  r.app.services.social.invalidate();
};
const giveBadge = (r: Running, name: string, badge: string): void => {
  db(r).run('INSERT OR IGNORE INTO user_badges(user_id, badge, earned_ms) VALUES (?, ?, ?)', idOf(r, name), badge, r.clock.now());
};

const gear = COSMETICS.filter((c) => isGearSlot(c.slot));

describe('what is for sale for your own screen', () => {
  it('GEAR-1: five places with 36 things, the same four prices as the other Shop things, ids that cannot be mixed up with the other group, and every Legendary one needs a real badge', () => {
    expect(GEAR_SLOTS.map((s) => s.id)).toEqual(['candles', 'shape', 'backdrop', 'effect', 'win']);
    expect(ALL_SLOT_IDS).toEqual([...SLOTS.map((s) => s.id), ...GEAR_SLOTS.map((s) => s.id)]);
    const count = (slot: string) => COSMETICS.filter((c) => c.slot === slot).length;
    expect(['candles', 'shape', 'backdrop', 'effect', 'win'].map(count)).toEqual([10, 6, 7, 5, 8]);
    expect(gear.length).toBe(36);
    const letter: Record<string, string> = { candles: 'cc_', shape: 'sh_', backdrop: 'bg_', effect: 'fx_', win: 'ws_' };
    for (const c of gear) {
      expect(c.id.startsWith(letter[c.slot] as string)).toBe(true);
      expect(priceOf(c)).toBe(RARITY_PRICE_CENTS[c.rarity]);
      expect(c.name).toMatch(/^[A-Za-z' -]{4,24}$/);
      // The best looks stay a sign of something done and not only of money.
      if (c.rarity === 4) {
        expect(c.requiresBadge).toBeDefined();
        expect(BADGES.map((b) => b.id)).toContain(c.requiresBadge);
      } else {
        expect(c.requiresBadge).toBeUndefined();
      }
    }
    // Every place has something a new player can reach with the $2,000 first rung or the $10,000 second one.
    for (const slot of GEAR_SLOTS) expect(COSMETICS.some((c) => c.slot === slot.id && c.rarity <= 2)).toBe(true);
    expect(new Set(COSMETICS.map((c) => c.id)).size).toBe(COSMETICS.length);
    expect(new Set(COSMETICS.map((c) => `${c.slot}:${c.name}`)).size).toBe(COSMETICS.length);
    expect(isGearSlot('candles')).toBe(true);
    expect(isGearSlot('color')).toBe(false);
    expect(isSlot('win')).toBe(false);
  });

  it('GEAR-2: gear keeps only things that are in the list and in the right place; a chart gets its classes from it; the win style is not a chart class; the other group ignores gear', () => {
    expect(cleanGear({ candles: 'cc_neon', shape: 'sh_hollow', backdrop: 'bg_galaxy', effect: 'fx_glow', win: 'ws_coins' })).toEqual({ candles: 'cc_neon', shape: 'sh_hollow', backdrop: 'bg_galaxy', effect: 'fx_glow', win: 'ws_coins' });
    expect(cleanGear({ candles: 'sh_hollow', shape: 'nonsense', backdrop: 7, effect: 'c_gold', win: 'cc_neon', extra: 'x' })).toEqual({});
    expect(cleanGear(null)).toEqual({});
    expect(cleanGear('cc_neon')).toEqual({});
    expect(gearIsEmpty({})).toBe(true);
    expect(gearIsEmpty(null)).toBe(true);
    expect(gearIsEmpty({ win: 'ws_gold' })).toBe(false);
    expect(chartClasses({ candles: 'cc_neon', shape: 'sh_hollow', backdrop: 'bg_galaxy', effect: 'fx_glow', win: 'ws_coins' })).toBe('cos-cc_neon cos-sh_hollow cos-bg_galaxy cos-fx_glow');
    expect(chartClasses({ win: 'ws_coins' })).toBe('');
    expect(chartClasses({ candles: 'made_up' })).toBe('');
    expect(chartClasses(undefined)).toBe('');
    // A name colour can never be smuggled into the gear and gear can never be smuggled into a look.
    expect(cleanLook({ color: 'cc_neon', frame: 'sh_hollow', title: 'ws_gold' })).toEqual({});
    expect(cosmeticById('cc_neon')?.slot).toBe('candles');
  });
});

describe('buying and wearing', () => {
  it('GEAR-3: buying takes the price once, puts it on at once, and the Shop view and /api/gear say so; a look place is not touched', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    setCash(r, 'alice', 10_000_000); // $100,000
    expect((await call(r, '/api/gear')).status).toBe(401);
    expect(await gearOf(r, alice)).toEqual({ gear: {} });
    const done = await buy(r, alice, 'cc_neon'); // Rare: $10,000
    expect(done.status).toBe(200);
    expect(done.json).toMatchObject({ item: 'cc_neon', priceCents: 1_000_000, cashCents: 9_000_000, owned: ['cc_neon'], equipped: {}, gear: { candles: 'cc_neon' } });
    expect(cash(r, 'alice')).toBe(9_000_000);
    expect(db(r).all('SELECT item, price_cents FROM user_cosmetics')).toEqual([{ item: 'cc_neon', price_cents: 1_000_000 }]);
    expect(await gearOf(r, alice)).toEqual({ gear: { candles: 'cc_neon' } });
    expect(db(r).all('SELECT candles, shape, backdrop, effect, win FROM user_gear')).toEqual([{ candles: 'cc_neon', shape: null, backdrop: null, effect: null, win: null }]);
    // One of each place; the other group's places are separate.
    for (const item of ['sh_hollow', 'bg_midnight', 'fx_glow', 'ws_gold', 'c_sky']) expect((await buy(r, alice, item)).status).toBe(200);
    expect((await view(r, alice)).gear).toEqual({ candles: 'cc_neon', shape: 'sh_hollow', backdrop: 'bg_midnight', effect: 'fx_glow', win: 'ws_gold' });
    expect((await view(r, alice)).equipped).toEqual({ color: 'c_sky' });
    // The same price rule as every Shop thing: $2,000, $10,000, $50,000, $250,000 and never again for what he owns.
    expect(cash(r, 'alice')).toBe(9_000_000 - 200_000 * 4 - 1_000_000);
    const again = await buy(r, alice, 'cc_neon');
    expect([again.status, again.json.error.code]).toEqual([409, 'already_owned']);
    expect(cash(r, 'alice')).toBe(9_000_000 - 200_000 * 4 - 1_000_000);
  }, LONG);

  it('GEAR-4: wearing is free and checked: only what he owns, only in its own place; a second thing in a place takes the first one off; taking off keeps it; an empty player has no row', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    setCash(r, 'alice', 10_000_000);
    await buy(r, alice, 'cc_ocean');
    await buy(r, alice, 'cc_mono');
    expect((await view(r, alice)).gear).toEqual({ candles: 'cc_mono' }); // the newest is worn
    const back = await equip(r, alice, 'candles', 'cc_ocean');
    expect([back.status, back.json]).toEqual([200, { equipped: {}, gear: { candles: 'cc_ocean' } }]);
    const before = cash(r, 'alice');
    for (const [slot, item, status, code] of [
      ['shape', 'cc_ocean', 400, 'wrong_place'], // a colour set is not a shape
      ['candles', 'cc_pastel', 403, 'not_owned'], // exists, not bought
      ['candles', 'nonsense', 404, 'no_such_item'],
      ['candles', 5, 400, 'bad_request'],
      ['sky', 'cc_ocean', 400, 'bad_request'],
      [undefined, 'cc_ocean', 400, 'bad_request'],
      ['color', 'cc_ocean', 400, 'wrong_place'], // not smuggled into the other group
    ] as const) {
      const bad = await equip(r, alice, slot, item);
      expect([slot, bad.status, bad.json.error.code]).toEqual([slot, status, code]);
    }
    expect(cash(r, 'alice')).toBe(before);
    expect((await view(r, alice)).gear).toEqual({ candles: 'cc_ocean' });
    const unknown = await equip(r, alice, 'sky', 'x');
    expect(unknown.json.error.message).toContain('candles');
    expect(unknown.json.error.message).toContain('color');
    // Take it off: he still owns it, and a player with nothing on has no row.
    expect((await equip(r, alice, 'candles', null)).json).toEqual({ equipped: {}, gear: {} });
    expect(db(r).all('SELECT * FROM user_gear')).toEqual([]);
    expect((await view(r, alice)).owned.sort()).toEqual(['cc_mono', 'cc_ocean']);
    expect((await equip(r, alice, 'candles', 'cc_mono')).json.gear).toEqual({ candles: 'cc_mono' });
    expect((await equip(r, alice, 'candles', '')).json.gear).toEqual({});
  }, LONG);

  it('GEAR-5: the Legendary things need the badge: refused without it (nothing is charged), bought with it', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    setCash(r, 'alice', 60_000_000);
    const no = await buy(r, alice, 'cc_diamond');
    expect([no.status, no.json.error.code, no.json.error.details]).toEqual([403, 'badge_needed', { badge: 'profit_100k' }]);
    expect(cash(r, 'alice')).toBe(60_000_000);
    giveBadge(r, 'alice', 'profit_100k');
    const yes = await buy(r, alice, 'cc_diamond');
    expect(yes.json).toMatchObject({ priceCents: 25_000_000, cashCents: 35_000_000, gear: { candles: 'cc_diamond' } });
    // One badge per thing, as listed.
    for (const c of gear.filter((x) => x.requiresBadge !== undefined)) {
      const bad = await buy(r, alice, c.id);
      if (c.requiresBadge === 'profit_100k') expect(bad.status).toBe(c.id === 'cc_diamond' ? 409 : 200);
      else expect([bad.status, bad.json.error.code]).toEqual([403, 'badge_needed']);
    }
  }, LONG);

  it('GEAR-6: not enough cash is refused with the numbers and nothing changes; spending lowers net worth, rank and the weekly growth at once', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const bob = await signUp(r, 'bob');
    setCash(r, 'alice', 5_000_000);
    setCash(r, 'bob', 4_000_000);
    setCash(r, 'bob', 199_999);
    const poor = await buy(r, bob, 'bg_midnight');
    expect([poor.status, poor.json.error.code, poor.json.error.details]).toEqual([400, 'not_enough_cash', { cashCents: 199_999, needCents: 200_000 }]);
    expect((await view(r, bob)).gear).toEqual({});
    setCash(r, 'bob', 4_000_000);
    const rows = async () => (await call(r, '/api/leaderboard', { cookie: bob })).json.rows.map((x: any) => [x.username, x.netWorthCents]);
    expect(await rows()).toEqual([['alice', 5_000_000], ['bob', 4_000_000]]);
    expect((await buy(r, alice, 'fx_neon')).status).toBe(200); // Epic: $50,000
    expect(await rows()).toEqual([['bob', 4_000_000], ['alice', 0]]);
    expect((await call(r, '/api/leaderboard/weekly', { cookie: alice })).json.me.gainCents).toBe(-100_000);
  }, LONG);
});

describe('only the player himself knows', () => {
  it('GEAR-7: gear is in nobody\'s list: not what everybody wears, not the profile card, not another player\'s /api/gear; a computer player has none', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const bob = await signUp(r, 'bob');
    setCash(r, 'alice', 10_000_000);
    await buy(r, alice, 'cc_neon');
    await buy(r, alice, 'ws_coins');
    await buy(r, alice, 'c_sky'); // one thing he wears for everybody to see, so the lists are not empty for another reason
    expect((await call(r, '/api/looks', { cookie: bob })).json).toEqual({ looks: { alice: { color: 'c_sky' } } });
    const card = await call(r, '/api/player/alice', { cookie: bob });
    expect(JSON.stringify(card.json)).not.toMatch(/cc_neon|ws_coins|candles|gear/);
    expect(await gearOf(r, bob)).toEqual({ gear: {} });
    expect(await gearOf(r, alice)).toEqual({ gear: { candles: 'cc_neon', win: 'ws_coins' } });
    // A computer player never shops (the same rule as the rest of the Shop).
    const botId = idOf(r, 'bob');
    db(r).run("INSERT INTO bots(user_id, persona) VALUES (?, 'steady')", botId);
    setCash(r, 'bob', 10_000_000);
    const as = { id: botId, username: 'bob', displayName: 'bob', role: 'player' as const, createdMs: 0 };
    expect(() => r.app.services.shop.buy(as, 'cc_neon')).toThrow(/Computer players do not shop/);
    expect(() => r.app.services.shop.equip(as, 'candles', null)).toThrow(/Computer players do not shop/);
  }, LONG);

  it('GEAR-8: the live stream: the player\'s own pages hear about his gear, nobody else does, and buying gear does not tell the others anything about looks', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const bob = await signUp(r, 'bob');
    setCash(r, 'alice', 10_000_000);
    const mine = await listen(r, alice); // (a second page of his, like a phone)
    const others = await listen(r, bob);
    const visitor = await listen(r);
    await buy(r, alice, 'bg_matrix');
    expect(await until(() => mine.text().includes('event: gear'))).toBe(true);
    expect(mine.text()).toContain('"gear":{"backdrop":"bg_matrix"}');
    await equip(r, alice, 'backdrop', null);
    expect(await until(() => mine.text().includes('"gear":null'))).toBe(true);
    // Give the others' streams time to receive anything that was (wrongly) sent to them.
    await new Promise((done) => setTimeout(done, 150));
    for (const s of [others, visitor]) {
      expect(s.text()).not.toContain('event: gear');
      expect(s.text()).not.toContain('bg_matrix');
      expect(s.text()).not.toContain('event: looks');
    }
  }, LONG);
});

describe('what an old database keeps', () => {
  it('GEAR-9: version 28 adds the gear table and the billboard table (both empty); gear follows the player; a place is a real word; deleting a player deletes both', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tq-gear-mig-'));
    const d = new Db(join(dir, 'old.sqlite'));
    try {
      d.tx(() => {
        for (const m of MIGRATIONS.filter((x) => x.version <= 27)) {
          d.exec(m.sql);
          d.exec(`PRAGMA user_version = ${m.version}`);
        }
      });
      d.run("INSERT INTO users(username, display_name, pw_hash, role, created_ms) VALUES ('a', 'a', 'x', 'player', 1)");
      d.run("INSERT INTO companies(id, ticker, name, listing_tick, listed_ms) VALUES (1, 'ABC', 'Abc Co', 0, 1)");
      expect(migrate(d)).toEqual([28, 29]);
      for (const t of ['user_gear', 'billboard_rentals']) expect(d.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`)?.n).toBe(0);
      d.run("INSERT INTO user_gear(user_id, candles, updated_ms) VALUES (1, 'cc_neon', 5)");
      expect(() => d.run("INSERT INTO user_gear(user_id, candles, updated_ms) VALUES (1, 'cc_mono', 6)")).toThrow(); // one row per player
      expect(() => d.run("INSERT INTO user_gear(user_id, candles, updated_ms) VALUES (99, 'cc_mono', 6)")).toThrow(); // a player must exist
      d.run('INSERT INTO billboard_rentals(slot, user_id, company_id, starts_ms, ends_ms, hours, price_cents, created_ms) VALUES (1, 1, 1, 10, 3600010, 1, 500000, 10)');
      expect(() => d.run('INSERT INTO billboard_rentals(slot, user_id, company_id, starts_ms, ends_ms, hours, price_cents, created_ms) VALUES (4, 1, 1, 10, 20, 1, 500000, 10)')).toThrow(); // only places 1 to 3
      expect(() => d.run('INSERT INTO billboard_rentals(slot, user_id, company_id, starts_ms, ends_ms, hours, price_cents, created_ms) VALUES (0, 1, 1, 10, 20, 1, 500000, 10)')).toThrow();
      expect(() => d.run('INSERT INTO billboard_rentals(slot, user_id, company_id, starts_ms, ends_ms, hours, price_cents, created_ms) VALUES (2, 1, 1, 20, 20, 1, 500000, 10)')).toThrow(); // it must end after it starts
      expect(() => d.run('INSERT INTO billboard_rentals(slot, user_id, company_id, starts_ms, ends_ms, hours, price_cents, created_ms) VALUES (2, 1, 1, 10, 20, 0, 500000, 10)')).toThrow();
      expect(() => d.run('INSERT INTO billboard_rentals(slot, user_id, company_id, starts_ms, ends_ms, hours, price_cents, created_ms) VALUES (2, 1, 1, 10, 20, 1, -1, 10)')).toThrow();
      expect(() => d.run('INSERT INTO billboard_rentals(slot, user_id, company_id, starts_ms, ends_ms, hours, price_cents, created_ms) VALUES (2, 1, 77, 10, 20, 1, 5, 10)')).toThrow(); // the company must exist
      d.run('DELETE FROM users WHERE id = 1');
      for (const t of ['user_gear', 'billboard_rentals']) expect(d.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`)?.n).toBe(0);
      expect(migrate(d)).toEqual([]);
    } finally {
      d.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, LONG);
});
