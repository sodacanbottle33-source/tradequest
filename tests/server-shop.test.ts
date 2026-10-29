// The Shop (server/cosmetics.ts, src/shared/cosmeticCatalog.ts, docs/world.md §29): things to wear (a name colour, a name glow, a picture frame, a title) bought with Career
// cash. The rules checked here: what each rarity costs; the money is taken once and is gone, so spending lowers net worth and rank at once; a thing is owned for good
// and worn at once; the best things need a badge; changing what is worn is free; everybody sees what everybody wears; and a profile card says what the list says.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUYS_PER_MINUTE } from '../server/routes/shop';
import { MIGRATIONS, migrate } from '../server/schema';
import { Db } from '../server/sqlite';
import { BADGES } from '../src/shared/badgeCatalog';
import { COSMETICS, RARITY_NAMES, RARITY_PRICE_CENTS, cleanLook, cosmeticById, frameClass, lookIsEmpty, nameClasses, priceOf, priceText, titleOf, type CosmeticDef } from '../src/shared/cosmeticCatalog';
import { LONG, db, idOf, liveRig, requestId, until, type Running } from './helpers/chatlive';

const { boot, call, signUp, listen } = liveRig('shop');

const view = async (r: Running, cookie: string) => (await call(r, '/api/shop', { cookie })).json;
const buy = (r: Running, cookie: string | undefined, item: unknown) => call(r, '/api/shop/buy', { method: 'POST', cookie, body: { item } });
const equip = (r: Running, cookie: string | undefined, slot: unknown, item: unknown) => call(r, '/api/shop/equip', { method: 'POST', cookie, body: { slot, item } });
const looks = async (r: Running, cookie: string) => (await call(r, '/api/looks', { cookie })).json.looks;
const cash = (r: Running, name: string): number => db(r).get<{ c: number }>("SELECT a.cash_cents AS c FROM accounts a JOIN users u ON u.id = a.user_id WHERE u.username = ? AND a.kind = 'career'", name)?.c as number;
const setCash = (r: Running, name: string, cents: number): void => {
  db(r).run("UPDATE accounts SET cash_cents = ? WHERE kind = 'career' AND user_id = (SELECT id FROM users WHERE username = ?)", cents, name);
  r.app.services.social.invalidate();
};
const giveBadge = (r: Running, name: string, badge: string): void => {
  db(r).run('INSERT OR IGNORE INTO user_badges(user_id, badge, earned_ms) VALUES (?, ?, ?)', idOf(r, name), badge, r.clock.now());
};
const byRarity = (rarity: number, slot: string): CosmeticDef => COSMETICS.find((c) => c.rarity === rarity && c.slot === slot && c.requiresBadge === undefined) as CosmeticDef;

describe('what is for sale', () => {
  it('SHOP-1: four rarities cost $2,000, $10,000, $50,000 and $250,000; every thing is in one of four places; the list has no duplicates and the badge a thing needs is a real badge', () => {
    expect(RARITY_PRICE_CENTS).toEqual([0, 200_000, 1_000_000, 5_000_000, 25_000_000]);
    expect(RARITY_NAMES.slice(1)).toEqual(['Common', 'Rare', 'Epic', 'Legendary']);
    expect(priceText(200_000)).toBe('$2,000');
    expect(priceText(25_000_000)).toBe('$250,000');
    expect(new Set(COSMETICS.map((c) => c.id)).size).toBe(COSMETICS.length);
    expect(new Set(COSMETICS.map((c) => `${c.slot}:${c.name}`)).size).toBe(COSMETICS.length);
    const count = (slot: string) => COSMETICS.filter((c) => c.slot === slot).length;
    expect([count('color'), count('glow'), count('frame'), count('title')]).toEqual([8, 5, 10, 13]);
    const letter: Record<string, string> = { color: 'c_', glow: 'g_', frame: 'f_', title: 't_', candles: 'cc_', shape: 'sh_', backdrop: 'bg_', effect: 'fx_', win: 'ws_' };
    for (const c of COSMETICS) {
      expect(c.id.startsWith(letter[c.slot] as string)).toBe(true);
      expect([1, 2, 3, 4]).toContain(c.rarity);
      expect(priceOf(c)).toBe(RARITY_PRICE_CENTS[c.rarity]);
      // Only the Legendary things can need a badge, and the badge must exist.
      if (c.requiresBadge !== undefined) {
        expect(c.rarity).toBe(4);
        expect(BADGES.map((b) => b.id)).toContain(c.requiresBadge);
      }
    }
    // Titles are a fixed list of short plain words: nobody types his own, so there is nothing to moderate.
    for (const c of COSMETICS.filter((x) => x.slot === 'title')) expect(c.name).toMatch(/^[A-Za-z' -]{4,24}$/);
    expect(COSMETICS.filter((c) => c.requiresBadge !== undefined).length).toBeGreaterThanOrEqual(6);
    expect(COSMETICS.filter((c) => c.rarity === 1).length).toBeGreaterThanOrEqual(7); // there is always something a new player can reach
  });

  it('SHOP-2: a look keeps only things that are in the list and in the right place; the classes and the title come from it; anything else draws nothing', () => {
    expect(cleanLook({ color: 'c_gold', glow: 'g_neon', frame: 'f_ruby', title: 't_bull' })).toEqual({ color: 'c_gold', glow: 'g_neon', frame: 'f_ruby', title: 't_bull' });
    expect(cleanLook({ color: 'g_neon', glow: 'nonsense', frame: 7, title: 'f_ruby', extra: 'x' })).toEqual({});
    expect(cleanLook(null)).toEqual({});
    expect(cleanLook('c_gold')).toEqual({});
    expect(lookIsEmpty({})).toBe(true);
    expect(lookIsEmpty(null)).toBe(true);
    expect(lookIsEmpty({ title: 't_bull' })).toBe(false);
    expect(nameClasses({ color: 'c_gold', glow: 'g_neon' })).toBe('cos-c_gold cos-g_neon');
    expect(nameClasses({ color: 'made_up' })).toBe('');
    expect(nameClasses(undefined)).toBe('');
    expect(frameClass({ frame: 'f_diamond' })).toBe('cos-f_diamond');
    expect(frameClass({ color: 'c_gold' })).toBe('');
    expect(titleOf({ title: 't_bull' })).toBe('Bull Runner');
    expect(titleOf({ title: 'c_gold' })).toBeNull();
    expect(titleOf({})).toBeNull();
    expect(cosmeticById('nope')).toBeUndefined();
  });
});

describe('buying', () => {
  it('SHOP-3: every Shop route needs a signed-in player; a new player has $1,000, owns nothing and wears nothing', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    expect((await call(r, '/api/shop')).status).toBe(401);
    expect((await buy(r, undefined, 'c_sky')).status).toBe(401);
    expect((await equip(r, undefined, 'color', 'c_sky')).status).toBe(401);
    expect((await call(r, '/api/looks')).status).toBe(401);
    expect((await call(r, '/api/player/alice')).status).toBe(401);
    expect(await view(r, alice)).toEqual({ cashCents: 100_000, owned: [], equipped: {}, gear: {}, badges: [] });
    expect(await looks(r, alice)).toEqual({});
  }, LONG);

  it('SHOP-4: buying takes the price from Career cash for good, is worn at once, is kept as a record, told to every page, and listed for everybody', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const bob = await signUp(r, 'bob');
    setCash(r, 'alice', 1_000_000); // $10,000
    const watching = await listen(r, bob);
    const done = await buy(r, alice, 'c_gold'); // Rare: $10,000... which is all the money he has
    expect(done.status).toBe(200);
    expect(done.json).toMatchObject({ item: 'c_gold', priceCents: 1_000_000, cashCents: 0, owned: ['c_gold'], equipped: { color: 'c_gold' }, badges: [] });
    expect(cash(r, 'alice')).toBe(0);
    expect(db(r).all('SELECT item, price_cents FROM user_cosmetics')).toEqual([{ item: 'c_gold', price_cents: 1_000_000 }]);
    expect(await view(r, alice)).toMatchObject({ cashCents: 0, owned: ['c_gold'], equipped: { color: 'c_gold' } });
    expect(await until(() => watching.text().includes('event: looks'))).toBe(true);
    expect(watching.text()).toContain('"username":"alice","look":{"color":"c_gold"}');
    expect(await looks(r, bob)).toEqual({ alice: { color: 'c_gold' } });
    // A Common thing and one of each place: each goes on in its own place and the others stay.
    setCash(r, 'alice', 100_000_000);
    for (const item of ['g_neon', 'f_emerald', 't_dip']) expect((await buy(r, alice, item)).status).toBe(200);
    expect(await looks(r, bob)).toEqual({ alice: { color: 'c_gold', glow: 'g_neon', frame: 'f_emerald', title: 't_dip' } });
    expect(cash(r, 'alice')).toBe(100_000_000 - 5_000_000 - 5_000_000 - 200_000);
    // The price follows the rarity, not the place.
    expect(db(r).all('SELECT item, price_cents FROM user_cosmetics ORDER BY bought_ms, item').map((x: any) => x.price_cents).sort((a: number, b: number) => a - b)).toEqual([200_000, 1_000_000, 5_000_000, 5_000_000]);
  }, LONG);

  it('SHOP-5: refused buys change nothing: not text, not in the Shop, already owned, not enough cash (the exact price is enough, one cent less is not)', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const common = byRarity(1, 'frame');
    setCash(r, 'alice', 500_000);
    const unchanged = (): unknown[] => [cash(r, 'alice'), db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM user_cosmetics')?.n];
    for (const [item, status, code] of [[42, 400, 'bad_request'], [null, 400, 'bad_request'], ['nope', 404, 'no_such_item'], ['', 404, 'no_such_item']] as const) {
      const bad = await buy(r, alice, item);
      expect([bad.status, bad.json.error.code]).toEqual([status, code]);
    }
    expect(unchanged()).toEqual([500_000, 0]);
    // Not enough cash: told the price and the cash.
    setCash(r, 'alice', 199_999);
    const poor = await buy(r, alice, common.id);
    expect([poor.status, poor.json.error.code, poor.json.error.details]).toEqual([400, 'not_enough_cash', { cashCents: 199_999, needCents: 200_000 }]);
    expect(poor.json.error.message).toMatch(/costs \$2,000 of Career cash, and you have \$1,999\.99/);
    expect(unchanged()).toEqual([199_999, 0]);
    setCash(r, 'alice', 200_000);
    expect((await buy(r, alice, common.id)).status).toBe(200);
    expect(unchanged()).toEqual([0, 1]);
    // Already owned: refused, and the money is not taken again.
    setCash(r, 'alice', 500_000);
    const again = await buy(r, alice, common.id);
    expect([again.status, again.json.error.code]).toEqual([409, 'already_owned']);
    expect(unchanged()).toEqual([500_000, 1]);
    // A double click at the same moment buys once.
    const two = await Promise.all([buy(r, alice, 'c_sky'), buy(r, alice, 'c_sky')]);
    expect(two.map((x) => x.status).sort()).toEqual([200, 409]);
    expect(unchanged()).toEqual([300_000, 2]);
  }, LONG);

  it('SHOP-6: the best things also need a badge: refused without it (nothing taken), allowed with it, at the full Legendary price', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    setCash(r, 'alice', 60_000_000); // $600,000
    const gated = COSMETICS.filter((c) => c.requiresBadge !== undefined);
    const diamond = cosmeticById('f_diamond') as CosmeticDef;
    expect(diamond.requiresBadge).toBe('profit_100k');
    const no = await buy(r, alice, diamond.id);
    expect([no.status, no.json.error.code, no.json.error.details]).toEqual([403, 'badge_needed', { badge: 'profit_100k' }]);
    expect(no.json.error.message).toMatch(/"Whale" badge/);
    expect([cash(r, 'alice'), db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM user_cosmetics')?.n]).toEqual([60_000_000, 0]);
    // A badge for another thing does not help.
    giveBadge(r, 'alice', 'wins_25');
    expect((await buy(r, alice, diamond.id)).json.error.code).toBe('badge_needed');
    expect(await view(r, alice)).toMatchObject({ badges: ['wins_25'] });
    giveBadge(r, 'alice', 'profit_100k');
    const yes = await buy(r, alice, diamond.id);
    expect(yes.status).toBe(200);
    expect(yes.json).toMatchObject({ priceCents: 25_000_000, cashCents: 35_000_000, equipped: { frame: 'f_diamond' } });
    expect((await view(r, alice)).badges.sort()).toEqual(['profit_100k', 'wins_25']);
    // A badge is not enough without the money.
    setCash(r, 'alice', 24_999_999);
    expect((await buy(r, alice, 't_oracle')).json.error.code).toBe('not_enough_cash');
    expect(gated.length).toBeGreaterThan(0);
  }, LONG);

  it('SHOP-7: at most ten tries a minute, and refused tries count too; a minute later it works again', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    for (let i = 0; i < BUYS_PER_MINUTE; i += 1) expect((await buy(r, alice, 'nope')).status).toBe(404);
    const slow = await buy(r, alice, 'nope');
    expect([slow.status, slow.json.error.code]).toEqual([429, 'rate_limited']);
    r.clock.advanceSeconds(61);
    expect((await buy(r, alice, 'nope')).status).toBe(404);
  }, LONG);
});

describe('wearing', () => {
  it('SHOP-8: he wears one thing in each place, can change or take it off for free, cannot wear what he does not own or put a thing in the wrong place; a bare player has no entry', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const bob = await signUp(r, 'bob');
    setCash(r, 'alice', 100_000_000);
    await buy(r, alice, 'c_sky');
    await buy(r, alice, 'c_mint');
    await buy(r, alice, 't_dip');
    expect((await view(r, alice)).equipped).toEqual({ color: 'c_mint', title: 't_dip' }); // the newest colour is worn
    const money = cash(r, 'alice');
    // Back to the first colour: free.
    const back = await equip(r, alice, 'color', 'c_sky');
    expect([back.status, back.json]).toEqual([200, { equipped: { color: 'c_sky', title: 't_dip' }, gear: {} }]);
    expect(cash(r, 'alice')).toBe(money);
    // Refusals.
    const refusals: [unknown, unknown, number, string][] = [
      ['hat', 'c_sky', 400, 'bad_request'],
      [7, 'c_sky', 400, 'bad_request'],
      ['color', 5, 400, 'bad_request'],
      ['color', 'made_up', 404, 'no_such_item'],
      ['color', 'c_coral', 403, 'not_owned'],
      ['glow', 'c_sky', 400, 'wrong_place'],
      ['title', 'c_sky', 400, 'wrong_place'],
    ];
    for (const [slot, item, status, code] of refusals) {
      const bad = await equip(r, alice, slot, item);
      expect([bad.status, bad.json.error.code]).toEqual([status, code]);
    }
    expect((await view(r, alice)).equipped).toEqual({ color: 'c_sky', title: 't_dip' });
    // Another player's things cannot be worn.
    expect((await equip(r, bob, 'color', 'c_sky')).json.error.code).toBe('not_owned');
    // Taking off: null, nothing, or an empty text.
    expect((await equip(r, alice, 'color', null)).json.equipped).toEqual({ title: 't_dip' });
    expect((await equip(r, alice, 'title', '')).json.equipped).toEqual({});
    expect(await looks(r, bob)).toEqual({});
    expect(db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM user_looks')?.n).toBe(0);
    // He still owns everything, and can put it on again.
    expect((await view(r, alice)).owned.sort()).toEqual(['c_mint', 'c_sky', 't_dip']);
    expect((await equip(r, alice, 'title', 't_dip')).json.equipped).toEqual({ title: 't_dip' });
    // Taking off something that is not worn changes nothing.
    expect((await equip(r, alice, 'frame', null)).json.equipped).toEqual({ title: 't_dip' });
  }, LONG);

  it('SHOP-9: every page is told when somebody changes what he wears, including that he now wears nothing', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const bob = await signUp(r, 'bob');
    setCash(r, 'alice', 10_000_000);
    await buy(r, alice, 'f_bronze');
    const watching = await listen(r, bob);
    await equip(r, alice, 'frame', null);
    expect(await until(() => watching.text().includes('"look":null'))).toBe(true);
    expect(watching.text()).toContain('"username":"alice","look":null');
    await equip(r, alice, 'frame', 'f_bronze');
    expect(await until(() => watching.text().includes('"look":{"frame":"f_bronze"}'))).toBe(true);
  }, LONG);
});

describe('money and rank', () => {
  it('SHOP-10: spending lowers net worth, so the leaderboard and the weekly board change at once, not half a minute later', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const bob = await signUp(r, 'bob');
    setCash(r, 'alice', 30_000_000); // $300,000
    setCash(r, 'bob', 20_000_000); // $200,000
    const rows = async () => (await call(r, '/api/leaderboard', { cookie: bob })).json.rows.map((x: any) => [x.username, x.netWorthCents]);
    expect(await rows()).toEqual([['alice', 30_000_000], ['bob', 20_000_000]]);
    // The weekly board counts growth from the $1,000 a new player starts the week with.
    const weekly0 = (await call(r, '/api/leaderboard/weekly', { cookie: alice })).json;
    expect(weekly0.me.gainCents).toBe(30_000_000 - 100_000);
    // Alice buys a Legendary thing with the badge it needs: $250,000 is gone.
    giveBadge(r, 'alice', 'profit_1m');
    expect((await buy(r, alice, 'f_crown')).status).toBe(200);
    expect(await rows()).toEqual([['bob', 20_000_000], ['alice', 5_000_000]]);
    expect((await call(r, '/api/leaderboard', { cookie: alice })).json.me).toMatchObject({ rank: 2, netWorthCents: 5_000_000 });
    const weekly = (await call(r, '/api/leaderboard/weekly', { cookie: alice })).json;
    expect(weekly.me.gainCents).toBe(weekly0.me.gainCents - 25_000_000); // the whole price comes off the week's growth
    expect(weekly.me.gainCents).toBe(5_000_000 - 100_000);
    // Nothing is refunded and a refused buy changes no rank.
    expect((await buy(r, alice, 'f_crown')).status).toBe(409);
    expect(cash(r, 'alice')).toBe(5_000_000);
  }, LONG);

  it('SHOP-11: what he owns and wears follows his number, not his name or his money: a username change, and the owner resetting his Career money, keep everything', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const boss = await signUp(r, 'boss');
    setCash(r, 'alice', 10_000_000);
    await buy(r, alice, 'c_rose');
    await buy(r, alice, 't_bull');
    // A new username.
    expect((await call(r, '/api/account/username', { method: 'POST', cookie: alice, body: { username: 'alicia' } })).status).toBe(200);
    expect(await looks(r, alice)).toEqual({ alicia: { color: 'c_rose', title: 't_bull' } });
    expect(await view(r, alice)).toMatchObject({ owned: ['c_rose', 't_bull'], equipped: { color: 'c_rose', title: 't_bull' } });
    // The owner resets the Career account: cash goes back to $1,000; the things stay.
    const reset = await call(r, '/api/admin/reset', { method: 'POST', cookie: boss, body: { requestId: requestId(), username: 'alicia' } });
    expect(reset.status).toBe(200);
    expect(await view(r, alice)).toEqual({ cashCents: 100_000, owned: ['c_rose', 't_bull'], equipped: { color: 'c_rose', title: 't_bull' }, gear: {}, badges: [] });
  }, LONG);

  it('SHOP-12: a computer player never buys or wears anything', async () => {
    const r = await boot();
    await signUp(r, 'alice');
    const bot = r.app.services.db.get<{ id: number }>("SELECT id FROM users WHERE username = 'alice'") as { id: number };
    db(r).run("INSERT INTO bots(user_id, persona) VALUES (?, 'steady')", bot.id);
    setCash(r, 'alice', 10_000_000);
    const as = { id: bot.id, username: 'alice', displayName: 'alice', role: 'player' as const, createdMs: 0 };
    expect(() => r.app.services.shop.buy(as, 'c_sky')).toThrow(/Computer players do not shop/);
    expect(() => r.app.services.shop.equip(as, 'color', null)).toThrow(/Computer players do not shop/);
    expect(cash(r, 'alice')).toBe(10_000_000);
  }, LONG);
});

describe('the profile card', () => {
  it('SHOP-13: a player\'s card says what the list says (name, role, net worth, place, how he stands to you), every badge he earned best first, and the day he joined', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const bob = await signUp(r, 'bob');
    await signUp(r, 'boss');
    setCash(r, 'alice', 30_000_000);
    setCash(r, 'bob', 20_000_000);
    giveBadge(r, 'bob', 'welcome');
    giveBadge(r, 'bob', 'profit_1m');
    giveBadge(r, 'bob', 'first_trade');
    const card = await call(r, '/api/player/bob', { cookie: alice });
    expect(card.status).toBe(200);
    expect(card.json).toEqual({
      username: 'bob',
      displayName: 'bob',
      role: 'player',
      netWorthCents: 20_000_000,
      rank: 2,
      rankedCount: 2,
      relation: 'none',
      memberSinceMs: db(r).get<{ c: number }>("SELECT created_ms AS c FROM users WHERE username = 'bob'")?.c,
      badges: ['profit_1m', 'first_trade', 'welcome'], // best tier first, then the order of the badge list
    });
    // Your own card says "you"; the owner is shown but not ranked; case does not matter; banned, computer and unknown players are "no such player".
    expect((await call(r, '/api/player/alice', { cookie: alice })).json.relation).toBe('you');
    const owner = await call(r, '/api/player/BOSS', { cookie: alice });
    expect(owner.json).toMatchObject({ username: 'boss', netWorthCents: null, rank: null });
    expect((await call(r, '/api/player/nobody', { cookie: bob })).status).toBe(404);
    db(r).run("INSERT INTO user_bans(user_id, reason, banned_ms, until_ms, by_user_id) VALUES (?, 'x', ?, NULL, ?)", idOf(r, 'bob'), r.clock.now(), idOf(r, 'boss'));
    r.app.services.social.invalidate();
    expect((await call(r, '/api/player/bob', { cookie: alice })).status).toBe(404);
  }, LONG);
});

describe('what an old database keeps', () => {
  it('SHOP-14: version 27 adds two empty tables (and 28 adds the next ones); an item can be owned once; a look needs a player; deleting a player deletes both', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tq-shop-mig-'));
    const d = new Db(join(dir, 'old.sqlite'));
    try {
      d.tx(() => {
        for (const m of MIGRATIONS.filter((x) => x.version <= 26)) {
          d.exec(m.sql);
          d.exec(`PRAGMA user_version = ${m.version}`);
        }
      });
      d.run("INSERT INTO users(username, display_name, pw_hash, role, created_ms) VALUES ('a', 'a', 'x', 'player', 1)");
      expect(migrate(d)).toEqual([27, 28]);
      for (const t of ['user_cosmetics', 'user_looks']) expect(d.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`)?.n).toBe(0);
      d.run("INSERT INTO user_cosmetics(user_id, item, bought_ms, price_cents) VALUES (1, 'c_sky', 5, 200000)");
      expect(() => d.run("INSERT INTO user_cosmetics(user_id, item, bought_ms, price_cents) VALUES (1, 'c_sky', 6, 200000)")).toThrow();
      expect(() => d.run("INSERT INTO user_cosmetics(user_id, item, bought_ms, price_cents) VALUES (1, 'c_mint', 6, -1)")).toThrow();
      expect(() => d.run("INSERT INTO user_cosmetics(user_id, item, bought_ms, price_cents) VALUES (99, 'c_mint', 6, 1)")).toThrow();
      d.run("INSERT INTO user_looks(user_id, color, updated_ms) VALUES (1, 'c_sky', 7)");
      expect(() => d.run("INSERT INTO user_looks(user_id, color, updated_ms) VALUES (99, 'c_sky', 7)")).toThrow();
      d.run('DELETE FROM users WHERE id = 1');
      for (const t of ['user_cosmetics', 'user_looks']) expect(d.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`)?.n).toBe(0);
      expect(migrate(d)).toEqual([]);
    } finally {
      d.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, LONG);
});
