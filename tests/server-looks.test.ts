// Banners, pets, the looks that are earned and the trophy room (src/shared/cosmeticCatalog.ts, src/shared/petCatalog.ts, server/cosmetics.ts, server/ranked.ts, server/trophies.ts,
// docs/world.md §34 and §36). A banner is drawn behind a name on the profile card; a pet stands next to a name and GROWS with the best streak of daily goals (worked out when it is shown,
// never stored); a few looks cannot be bought and are given for finishing high in ranked 1v1 or for winning the weekly team race; and the trophy room lists what a player has won.
import { describe, expect, it } from 'vitest';
import { BADGES } from '../src/shared/badgeCatalog';
import {
  COSMETICS,
  FOR_SALE,
  LEAGUE_LOOKS,
  PROFILE_SLOTS,
  RARITY_PRICE_CENTS,
  SEASON_CHAMPION_LOOKS,
  SEASON_PODIUM_LOOKS,
  TEAM_CHAMPION_LOOKS,
  bannerClass,
  cleanLook,
  cosmeticById,
  isLookSlot,
  isProfileSlot,
  lookIsEmpty,
  priceOf,
} from '../src/shared/cosmeticCatalog';
import { PETS, PET_EGG, PET_MAX_STAGE, PET_STAGE_DAYS, PET_STAGE_NAMES, cleanStage, petGlyph, petLabel, petNextText, petById, petStageOf } from '../src/shared/petCatalog';
import { DAY_MS, dayOf, dayStartMs } from '../src/shared/goalCatalog';
import { RANK_TIERS } from '../src/world';
import { WEEK_MS, weekStartOf } from '../server/social';
import { LONG, db, idOf, liveRig, until, type Running } from './helpers/chatlive';

const { boot, call, signUp, listen } = liveRig('looks');

const buy = (r: Running, cookie: string | undefined, item: unknown) => call(r, '/api/shop/buy', { method: 'POST', cookie, body: { item } });
const equip = (r: Running, cookie: string | undefined, slot: unknown, item: unknown) => call(r, '/api/shop/equip', { method: 'POST', cookie, body: { slot, item } });
const looks = async (r: Running, cookie: string | undefined) => (await call(r, '/api/looks', { cookie })).json.looks;
const setCash = (r: Running, name: string, cents: number): void => {
  db(r).run("UPDATE accounts SET cash_cents = ? WHERE kind = 'career' AND user_id = (SELECT id FROM users WHERE username = ?)", cents, name);
  r.app.services.social.invalidate();
};
const setBest = (r: Running, name: string, best: number): void => {
  db(r).run('INSERT INTO streaks(user_id, current, best, last_day, freezes, saved, updated_ms) VALUES (?, ?, ?, 0, 0, 0, 0) ON CONFLICT(user_id) DO UPDATE SET best = excluded.best, current = excluded.current', idOf(r, name), best, best);
};
const owns = (r: Running, name: string): string[] => db(r).all<{ item: string }>('SELECT item FROM user_cosmetics WHERE user_id = ? ORDER BY item', idOf(r, name)).map((x) => x.item);

// ---- the catalog -----------------------------------------------------------------------------------------------------------------

describe('banners and pets in the catalog', () => {
  it('LOOK-1: twelve banners and ten pets in four rarities with the same four prices; the best ones need a badge that exists; pets and their pictures match one to one', () => {
    expect(PROFILE_SLOTS.map((s) => s.id)).toEqual(['banner', 'pet']);
    const banners = FOR_SALE.filter((c) => c.slot === 'banner');
    const pets = FOR_SALE.filter((c) => c.slot === 'pet');
    expect([banners.length, pets.length]).toEqual([12, 10]);
    for (const c of [...banners, ...pets]) {
      expect(c.id.startsWith(c.slot === 'banner' ? 'bn_' : 'p_')).toBe(true);
      expect(priceOf(c)).toBe(RARITY_PRICE_CENTS[c.rarity]);
      if (c.rarity === 4) {
        expect(c.requiresBadge).toBeDefined();
        expect(BADGES.map((b) => b.id)).toContain(c.requiresBadge);
      } else {
        expect(c.requiresBadge).toBeUndefined();
      }
    }
    for (const slot of ['banner', 'pet'] as const) {
      expect(FOR_SALE.filter((c) => c.slot === slot && c.rarity === 1).length).toBeGreaterThanOrEqual(3); // a new player can always reach something
      expect(isProfileSlot(slot)).toBe(true);
      expect(isLookSlot(slot)).toBe(true);
    }
    expect(isProfileSlot('color')).toBe(false);
    expect(isLookSlot('candles')).toBe(false);
    // Every pet in the Shop has its four pictures, and the other way round.
    expect(PETS.map((p) => p.id).sort()).toEqual(pets.map((p) => p.id).sort());
    for (const p of PETS) {
      expect(cosmeticById(p.id)?.name).toBe(p.name);
      expect(p.forms).toHaveLength(4);
      expect(new Set(p.forms).size).toBe(4); // each stage looks different
    }
    expect(new Set(COSMETICS.map((c) => c.id)).size).toBe(COSMETICS.length);
    expect(new Set(COSMETICS.map((c) => `${c.slot}:${c.name}`)).size).toBe(COSMETICS.length);
  });

  it('LOOK-2: a pet is an egg until the best streak reaches 3 days, then grows at 7, 14 and 30; the picture and the words follow the stage; anything odd counts as an egg', () => {
    expect(PET_STAGE_DAYS).toEqual([0, 3, 7, 14, 30]);
    expect(PET_STAGE_NAMES).toEqual(['Egg', 'Baby', 'Young', 'Grown', 'Legend']);
    expect(PET_MAX_STAGE).toBe(4);
    const expected: [number, number][] = [[0, 0], [2, 0], [3, 1], [6, 1], [7, 2], [13, 2], [14, 3], [29, 3], [30, 4], [400, 4]];
    for (const [days, stage] of expected) expect(petStageOf(days), `${days} days`).toBe(stage);
    expect(petGlyph('p_fox', 0)).toBe(PET_EGG);
    expect(petGlyph('p_fox', 1)).toBe('🦊');
    expect(petGlyph('p_fox', 4)).toBe(petById('p_fox')?.forms[3]);
    expect(petGlyph('p_made_up', 2)).toBe('');
    expect(petGlyph(undefined, 2)).toBe('');
    for (const odd of [-1, 5, 1.5, NaN, '2', null, undefined, {}]) expect(cleanStage(odd)).toBe(0);
    expect(petLabel('p_fox', 2)).toBe('Fox (Young)');
    expect(petNextText(0)).toBe('Hatches when your best streak reaches 3 days');
    expect(petNextText(2)).toBe('Grows when your best streak reaches 14 days');
    expect(petNextText(4)).toBeNull();
  });

  it('LOOK-3: a look keeps a banner and a pet only in their own place; the stage is kept only with a pet; an empty look is empty', () => {
    expect(cleanLook({ banner: 'bn_dawn', pet: 'p_fox', petStage: 2 })).toEqual({ banner: 'bn_dawn', pet: 'p_fox', petStage: 2 });
    expect(cleanLook({ banner: 'p_fox', pet: 'bn_dawn' })).toEqual({});
    expect(cleanLook({ petStage: 3 })).toEqual({});
    expect(cleanLook({ pet: 'p_fox', petStage: 99 })).toEqual({ pet: 'p_fox', petStage: 0 });
    expect(cleanLook({ pet: 'p_fox' })).toEqual({ pet: 'p_fox', petStage: 0 });
    expect(lookIsEmpty({ banner: 'bn_dawn' })).toBe(false);
    expect(lookIsEmpty({ pet: 'p_fox', petStage: 1 })).toBe(false);
    expect(lookIsEmpty({})).toBe(true);
    expect(bannerClass({ banner: 'bn_dawn' })).toBe('cos-bn_dawn');
    expect(bannerClass({ banner: 'nonsense' })).toBe('');
    expect(bannerClass(null)).toBe('');
  });

  it('LOOK-4: the looks that are earned are not for sale: every one says how to get it, none needs a badge, and the ranked and team lists only name real earned looks', () => {
    const earned = COSMETICS.filter((c) => c.earn !== undefined);
    expect(earned.length).toBeGreaterThanOrEqual(13);
    for (const c of earned) {
      expect(c.how, c.id).toMatch(/^[A-Z].*\.$/);
      expect(c.requiresBadge, c.id).toBeUndefined();
      expect([3, 4]).toContain(c.rarity);
      expect(['ranked', 'team']).toContain(c.earn);
    }
    const ids = (list: readonly string[]) => list.map((id) => cosmeticById(id)?.earn);
    expect(LEAGUE_LOOKS.map((l) => l.tier)).toEqual(['gold', 'platinum', 'diamond']);
    for (const l of LEAGUE_LOOKS) {
      expect(RANK_TIERS.map((t) => t.id)).toContain(l.tier);
      expect(l.items).toHaveLength(3); // a ring, a title and a banner
      expect(new Set(l.items.map((id) => cosmeticById(id)?.slot))).toEqual(new Set(['frame', 'title', 'banner']));
      expect(ids(l.items).every((e) => e === 'ranked')).toBe(true);
    }
    expect(ids(SEASON_CHAMPION_LOOKS).every((e) => e === 'ranked')).toBe(true);
    expect(ids(SEASON_PODIUM_LOOKS).every((e) => e === 'ranked')).toBe(true);
    expect(ids(TEAM_CHAMPION_LOOKS).every((e) => e === 'team')).toBe(true);
    expect(FOR_SALE.every((c) => c.earn === undefined)).toBe(true);
    // The names of titles stay short plain words.
    for (const c of COSMETICS.filter((x) => x.slot === 'title')) expect(c.name).toMatch(/^[A-Za-z' -]{4,24}$/);
  });
});

// ---- buying and wearing ------------------------------------------------------------------------------------------------------------

describe('buying a banner or a pet', () => {
  it('LOOK-5: a banner and a pet cost by rarity, are worn at once, are told to everybody, and a pet starts as an egg (stage 0); the other places stay as they are', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const bob = await signUp(r, 'bob');
    setCash(r, 'alice', 100_000_000);
    const watching = await listen(r, bob);
    expect((await buy(r, alice, 'c_sky')).status).toBe(200);
    const b = await buy(r, alice, 'bn_ocean'); // Common: $2,000
    expect(b.status).toBe(200);
    expect(b.json).toMatchObject({ item: 'bn_ocean', priceCents: 200_000, equipped: { color: 'c_sky', banner: 'bn_ocean' } });
    const p = await buy(r, alice, 'p_fox'); // Rare: $10,000
    expect(p.json).toMatchObject({ item: 'p_fox', priceCents: 1_000_000, equipped: { color: 'c_sky', banner: 'bn_ocean', pet: 'p_fox', petStage: 0 } });
    expect(await until(() => watching.text().includes('"pet":"p_fox"'))).toBe(true);
    expect(watching.text()).toContain('"look":{"color":"c_sky","banner":"bn_ocean","pet":"p_fox","petStage":0}');
    expect(await looks(r, bob)).toEqual({ alice: { color: 'c_sky', banner: 'bn_ocean', pet: 'p_fox', petStage: 0 } });
    expect(db(r).get('SELECT banner, pet FROM user_looks WHERE user_id = ?', idOf(r, 'alice'))).toEqual({ banner: 'bn_ocean', pet: 'p_fox' });
    // Owning twice is refused, and nothing is charged.
    expect((await buy(r, alice, 'p_fox')).status).toBe(409);
  }, LONG);

  it('LOOK-6: equipping works for the two new places, takes them off, refuses the wrong place and a thing he does not own, and the row goes when nothing is worn', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    setCash(r, 'alice', 10_000_000);
    await buy(r, alice, 'bn_dawn');
    await buy(r, alice, 'p_chick');
    expect((await equip(r, alice, 'banner', null)).json.equipped).toEqual({ pet: 'p_chick', petStage: 0 });
    expect((await equip(r, alice, 'pet', null)).json.equipped).toEqual({});
    expect(db(r).all('SELECT * FROM user_looks')).toEqual([]);
    expect((await equip(r, alice, 'banner', 'bn_dawn')).json.equipped).toEqual({ banner: 'bn_dawn' });
    expect((await equip(r, alice, 'pet', 'bn_dawn')).status).toBe(400); // a banner is not worn as a pet
    expect((await equip(r, alice, 'banner', 'bn_ocean')).status).toBe(403); // not owned
    expect((await equip(r, alice, 'tail', 'p_chick')).status).toBe(400);
    expect((await equip(r, alice, 'pet', 'p_chick')).json.equipped).toEqual({ banner: 'bn_dawn', pet: 'p_chick', petStage: 0 });
  }, LONG);

  it('LOOK-7: a Legendary banner or pet needs its badge; an earned look can not be bought at any price', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    setCash(r, 'alice', 1_000_000_000);
    const gated = await buy(r, alice, 'bn_vault');
    expect([gated.status, gated.json.error.code]).toEqual([403, 'badge_needed']);
    const phoenix = await buy(r, alice, 'p_phoenix');
    expect([phoenix.status, phoenix.json.error.code]).toEqual([403, 'badge_needed']);
    db(r).run('INSERT INTO user_badges(user_id, badge, earned_ms) VALUES (?, ?, ?)', idOf(r, 'alice'), 'streak_7', r.clock.now());
    expect((await buy(r, alice, 'p_phoenix')).status).toBe(200);
    // Earned looks: refused with a clear reason, and no money moves.
    const before = (db(r).get('SELECT cash_cents AS c FROM accounts WHERE user_id = ? AND kind = ?', idOf(r, 'alice'), 'career') as { c: number }).c;
    const refused = await buy(r, alice, 'f_lg_gold');
    expect([refused.status, refused.json.error.code]).toEqual([403, 'not_for_sale']);
    expect(refused.json.error.message).toContain('Reach Gold in a ranked season');
    expect(refused.json.error.details.how).toContain('Gold');
    expect((await buy(r, alice, 't_team')).json.error.code).toBe('not_for_sale');
    expect(db(r).get('SELECT cash_cents AS c FROM accounts WHERE user_id = ? AND kind = ?', idOf(r, 'alice'), 'career')).toEqual({ c: before });
    expect(owns(r, 'alice')).toEqual(['p_phoenix']);
  }, LONG);
});

// ---- growth -------------------------------------------------------------------------------------------------------------------------

describe('a pet that grows', () => {
  it('LOOK-8: the stage comes from the best streak when the look is read, so a pet never shrinks and a player without a streak row has an egg', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const bob = await signUp(r, 'bob');
    setCash(r, 'alice', 100_000_000);
    await buy(r, alice, 'p_pup');
    expect((await looks(r, bob)).alice).toEqual({ pet: 'p_pup', petStage: 0 });
    for (const [best, stage] of [[3, 1], [7, 2], [14, 3], [30, 4]] as const) {
      setBest(r, 'alice', best);
      expect((await looks(r, bob)).alice.petStage, `${best} days`).toBe(stage);
      expect(r.app.services.shop.lookOf(idOf(r, 'alice')).petStage).toBe(stage);
    }
    // The streak ends (current 0) but the best stays: the pet stays grown.
    db(r).run('UPDATE streaks SET current = 0 WHERE user_id = ?', idOf(r, 'alice'));
    expect((await looks(r, bob)).alice.petStage).toBe(4);
    // A player with no pet has no stage, whatever his streak.
    setBest(r, 'bob', 30);
    expect((await looks(r, bob)).bob).toBeUndefined();
  }, LONG);

  it('LOOK-9: when a streak reaches a step of growth, everybody is told at once (and only when a pet is worn)', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const bob = await signUp(r, 'bob');
    setCash(r, 'alice', 100_000_000);
    await buy(r, alice, 'p_kitten');
    const watching = await listen(r, bob);
    // Three days in a row with a finished goal each (a lesson answered): the third day is a milestone.
    (r.app.services.daily as unknown as { d: { goalsOfDay: () => readonly string[] } }).d.goalsOfDay = () => ['lesson_1', 'win_1', 'limit_1'];
    const start = dayOf(r.clock.now());
    for (let i = 0; i < 3; i += 1) {
      r.clock.ms = dayStartMs(start + i) + 12 * 3_600_000;
      db(r).run(
        'INSERT INTO learn_lessons(user_id, kind, pattern, seed, scenario, issued_ms, answered_ms, skipped_ms) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)',
        idOf(r, 'alice'),
        'direction',
        'test',
        i + 1,
        '{}',
        r.clock.now(),
        r.clock.now(),
      );
      await call(r, '/api/goals', { cookie: alice });
      if (i < 2) expect(watching.text()).not.toContain('"petStage":1');
    }
    expect(await until(() => watching.text().includes('"look":{"pet":"p_kitten","petStage":1}'))).toBe(true);
    expect((await looks(r, bob)).alice).toEqual({ pet: 'p_kitten', petStage: 1 });
  }, LONG);
});

// ---- looks that are earned in ranked play ------------------------------------------------------------------------------------------

describe('looks earned in ranked 1v1', () => {
  const put = (r: Running, name: string, season: number, points: number, matches: number, peak: number) =>
    db(r).run('INSERT INTO ranked_player(user_id, season_ms, points, peak_tier, best_tier, matches, wins, losses, updated_ms) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)', idOf(r, name), season, points, peak, peak, matches, matches);

  async function seasonEnd(): Promise<{ r: Running; cookies: Record<string, string> }> {
    const r = await boot();
    const cookies: Record<string, string> = {};
    for (const n of ['alice', 'bob', 'carol', 'dave', 'erin']) cookies[n] = await signUp(r, n);
    const season = weekStartOf(r.clock.now());
    put(r, 'alice', season, 950, 12, 4); // Diamond, 1st place
    put(r, 'bob', season, 700, 8, 3); // Platinum, 2nd
    put(r, 'carol', season, 450, 6, 2); // Gold, 3rd
    put(r, 'dave', season, 300, 9, 1); // Silver only, 4th: nothing to earn
    put(r, 'erin', season, 980, 4, 4); // Diamond points but too few matches
    r.app.services.ranked.rollSeason();
    r.clock.ms = season + WEEK_MS + 3_600_000;
    return { r, cookies };
  }

  it('LOOK-10: at the end of a season every player with enough matches is given the league looks of every tier up to his highest; the top three get the podium title and the winner the champion looks', async () => {
    const { r, cookies } = await seasonEnd();
    const watching = await listen(r, cookies.alice);
    expect(r.app.services.ranked.rollSeason()).toBe(true);
    const league = (tier: 'gold' | 'platinum' | 'diamond') => (LEAGUE_LOOKS.find((l) => l.tier === tier) as (typeof LEAGUE_LOOKS)[number]).items;
    expect(owns(r, 'alice')).toEqual([...league('gold'), ...league('platinum'), ...league('diamond'), ...SEASON_CHAMPION_LOOKS, ...SEASON_PODIUM_LOOKS].sort());
    expect(owns(r, 'bob')).toEqual([...league('gold'), ...league('platinum'), ...SEASON_PODIUM_LOOKS].sort());
    expect(owns(r, 'carol')).toEqual([...league('gold'), ...SEASON_PODIUM_LOOKS].sort());
    expect(owns(r, 'dave')).toEqual([]);
    expect(owns(r, 'erin')).toEqual([]);
    // They cost nothing, are recorded as free, and are NOT put on by themselves.
    expect(db(r).get("SELECT COUNT(*) AS n, SUM(price_cents) AS s FROM user_cosmetics WHERE user_id = ?", idOf(r, 'alice'))).toMatchObject({ s: 0 });
    expect(db(r).all('SELECT * FROM user_looks')).toEqual([]);
    expect(await looks(r, cookies.alice)).toEqual({});
    // Alice is told with a pop-up that names what she earned.
    expect(await until(() => watching.text().includes('event: earned'))).toBe(true);
    expect(watching.text()).toContain('Diamond League Ring');
    expect(watching.text()).toContain('Season Champion');
    // Now she can wear them from the Shop, and the Shop says she owns them.
    const view = (await call(r, '/api/shop', { cookie: cookies.alice })).json;
    expect(view.owned).toContain('f_season');
    expect((await equip(r, cookies.alice, 'frame', 'f_lg_diamond')).json.equipped).toEqual({ frame: 'f_lg_diamond' });
    expect((await equip(r, cookies.alice, 'banner', 'bn_season')).json.equipped).toEqual({ frame: 'f_lg_diamond', banner: 'bn_season' });
  }, LONG);

  it('LOOK-11: a season that is closed again gives nothing twice, a new player in the next season earns only what he reached, and the owner and computer players earn nothing', async () => {
    const { r } = await seasonEnd();
    r.app.services.ranked.rollSeason();
    const before = db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM user_cosmetics')?.n;
    expect(r.app.services.ranked.rollSeason()).toBe(false);
    expect(db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM user_cosmetics')?.n).toBe(before);
    // The next season: erin plays enough and reaches Gold; alice drops to Silver (points halve) and plays 5 matches there.
    const season2 = weekStartOf(r.clock.now());
    db(r).run('UPDATE ranked_player SET points = 420, peak_tier = 2, best_tier = 4, matches = 7, wins = 5 WHERE user_id = ?', idOf(r, 'erin'));
    db(r).run('UPDATE ranked_player SET matches = 5, wins = 3 WHERE user_id = ?', idOf(r, 'alice'));
    r.clock.ms = season2 + WEEK_MS + 3_600_000;
    r.app.services.ranked.rollSeason();
    const league = (tier: 'gold' | 'platinum' | 'diamond') => (LEAGUE_LOOKS.find((l) => l.tier === tier) as (typeof LEAGUE_LOOKS)[number]).items;
    for (const id of league('gold')) expect(owns(r, 'erin')).toContain(id);
    expect(owns(r, 'erin')).not.toContain('f_lg_diamond');
    expect(owns(r, 'erin')).not.toContain('f_lg_plat');
    // Giving the same look again is a no-op for the Shop.
    expect(r.app.services.shop.award(idOf(r, 'erin'), 'f_lg_gold', 'again')).toBe(false);
    expect(r.app.services.shop.award(idOf(r, 'erin'), 'not_a_look', 'x')).toBe(false);
  }, LONG);

  it('LOOK-12: the owner is not on the podium and earns nothing; a computer player is never given a look', async () => {
    const r = await boot();
    await signUp(r, 'boss'); // the owner of this world
    await signUp(r, 'alice');
    const season = weekStartOf(r.clock.now());
    put(r, 'boss', season, 990, 20, 4);
    put(r, 'alice', season, 500, 8, 2);
    r.app.services.ranked.rollSeason();
    r.clock.ms = season + WEEK_MS + 1000;
    r.app.services.ranked.rollSeason();
    expect(owns(r, 'boss')).toEqual([]);
    expect(owns(r, 'alice')).toEqual([...(LEAGUE_LOOKS[0] as (typeof LEAGUE_LOOKS)[number]).items, ...SEASON_CHAMPION_LOOKS, ...SEASON_PODIUM_LOOKS].sort());
    // A computer player is never given anything, even when asked for directly.
    await signUp(r, 'carol');
    db(r).run("INSERT INTO bots(user_id, persona) VALUES (?, 'test-persona')", idOf(r, 'carol'));
    expect(r.app.services.shop.award(idOf(r, 'carol'), 'f_lg_gold', 'test')).toBe(false);
    expect(owns(r, 'carol')).toEqual([]);
  }, LONG);
});

// ---- the trophy room -----------------------------------------------------------------------------------------------------------------

describe('the trophy room', () => {
  it('LOOK-13: it needs a signed-in player; an unknown player is "no such player"; a new player has an empty room', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    expect((await call(r, '/api/trophies/alice')).status).toBe(401);
    const none = await call(r, '/api/trophies/nobody', { cookie: alice });
    expect([none.status, none.json.error.code]).toEqual([404, 'no_such_player']);
    const room = (await call(r, '/api/trophies/alice', { cookie: alice })).json;
    expect(room).toMatchObject({
      username: 'alice',
      ranked: { bestTier: null, seasons: [] },
      weekly: { podiums: [], firsts: 0 },
      goals: { finished: 0, perfectDays: 0, bestStreak: 0 },
      matches: { played: 0, wins: 0 },
      predictions: { made: 0, correct: 0, bestRun: 0 },
      lessons: 0,
      badges: { total: BADGES.length },
      team: null,
      teamWins: [],
      count: 0,
    });
    expect(room.badges.earned).toBeGreaterThanOrEqual(0);
  }, LONG);

  it('LOOK-14: it lists the best ranked tier, the seasons on the podium, the weeks on the weekly podium, goals, matches, predictions, lessons and the team', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const bob = await signUp(r, 'bob');
    const aid = idOf(r, 'alice');
    db(r).run('INSERT INTO ranked_player(user_id, season_ms, points, peak_tier, best_tier, matches, wins, losses, updated_ms) VALUES (?, 0, 500, 2, 3, 6, 4, 2, 0)', aid);
    db(r).run('INSERT INTO ranked_season_results(season_ms, place, user_id, points, matches) VALUES (100, 2, ?, 800, 9), (200, 1, ?, 900, 11), (300, 7, ?, 400, 5)', aid, aid, aid);
    db(r).run('INSERT INTO weekly_winners(week_start_ms, place, user_id, gain_pct, gain_cents) VALUES (1000, 1, ?, 12.5, 12500), (2000, 3, ?, 4.25, 4250)', aid, aid);
    db(r).run("INSERT INTO daily_goal_done(user_id, day, goal, done_ms) VALUES (?, 1, 'lesson_1', 0), (?, 1, 'win_1', 0), (?, 2, 'lesson_1', 0)", aid, aid, aid);
    db(r).run('INSERT INTO daily_bonus(user_id, day, paid_ms) VALUES (?, 1, 0)', aid);
    db(r).run('INSERT INTO streaks(user_id, current, best, last_day, freezes, saved, updated_ms) VALUES (?, 1, 9, 2, 0, 0, 0)', aid);
    db(r).run('INSERT INTO learn_progress(user_id, xp, lessons_done, updated_ms) VALUES (?, 5, 17, 0)', aid);
    const id = db(r).run("INSERT INTO matches(state, created_ms, duration_ticks, start_cash_cents, settled_ms, outcome, friends) VALUES ('finished', 0, 180, 100000, 0, 'win', 0)", ).lastInsertRowid;
    db(r).run("INSERT INTO match_players(match_id, user_id, joined_ms, last_seen_ms, active, result) VALUES (?, ?, 0, 0, 0, 'win')", id, aid);
    db(r).run("INSERT INTO predictions(user_id, day, company_id, pick, price_from, picked_ms, result, price_to) VALUES (?, 1, 0, 'up', 1, 0, 'win', 2), (?, 2, 0, 'up', 1, 0, 'win', 2), (?, 3, 0, 'up', 1, 0, 'loss', 0), (?, 4, 0, 'up', 1, 0, 'draw', 1), (?, 5, 0, 'down', 2, 0, 'win', 1)", aid, aid, aid, aid, aid);
    db(r).run("INSERT INTO teams(name, name_key, tag, tag_key, leader_id, open, created_ms) VALUES ('Night Owls', 'night owls', 'OWL', 'owl', ?, 1, 0)", aid);
    db(r).run('INSERT INTO team_members(user_id, team_id, joined_ms) VALUES (?, 1, 0)', aid);
    db(r).run("INSERT INTO team_week_results(week_start_ms, place, team_name, team_tag, score_pct, members) VALUES (3000, 1, 'Night Owls', 'OWL', 3.5, 4)");
    db(r).run('INSERT INTO team_week_members(week_start_ms, place, user_id) VALUES (3000, 1, ?)', aid);
    const room = (await call(r, '/api/trophies/alice', { cookie: bob })).json; // anybody signed in may look
    expect(room.ranked.bestTier).toEqual({ id: 'platinum', name: 'Platinum', icon: '💠' });
    expect(room.ranked.seasons).toEqual([
      { seasonMs: 300, place: 7, points: 400 },
      { seasonMs: 200, place: 1, points: 900 },
      { seasonMs: 100, place: 2, points: 800 },
    ]);
    expect(room.weekly).toEqual({ podiums: [{ weekStartMs: 2000, place: 3, gainPct: 4.25 }, { weekStartMs: 1000, place: 1, gainPct: 12.5 }], firsts: 1 });
    expect(room.goals).toEqual({ finished: 3, perfectDays: 1, bestStreak: 9 });
    expect(room.matches).toEqual({ played: 1, wins: 1 });
    expect(room.predictions).toEqual({ made: 4, correct: 3, bestRun: 2 }); // the draw is left out; win, win, loss, win
    expect(room.lessons).toBe(17);
    expect(room.team).toEqual({ name: 'Night Owls', tag: 'OWL' });
    expect(room.teamWins).toEqual([{ weekStartMs: 3000, place: 1, teamName: 'Night Owls', teamTag: 'OWL' }]);
    // seasons on the podium (2) + weekly podiums (2) + team wins (1) + a tier above Bronze (1)
    expect(room.count).toBe(6);
    // Somebody who is banned can not be looked at, like his profile card.
    db(r).run('INSERT INTO user_bans(user_id, reason, banned_ms, until_ms, by_user_id, kind) VALUES (?, ?, ?, NULL, ?, ?)', aid, 'test', 0, idOf(r, 'bob'), 'ban');
    r.app.services.social.invalidate();
    expect((await call(r, '/api/trophies/alice', { cookie: bob })).status).toBe(404);
    void alice;
  }, LONG);

  it('LOOK-15: the best three of a finished week are written down for good when the week turns, once, and a week with no gain names nobody', async () => {
    const r = await boot();
    const names = ['alice', 'bob', 'carol', 'dave'];
    for (const n of names) await signUp(r, n);
    const social = r.app.services.social;
    const week0 = weekStartOf(r.clock.now());
    social.rollWeek(); // marks everybody's net worth at the start of this week
    // alice +30%, bob +20%, carol +10%, dave -5%
    const gains: Record<string, number> = { alice: 30_000, bob: 20_000, carol: 10_000, dave: -5_000 };
    for (const [n, c] of Object.entries(gains)) {
      db(r).run("UPDATE accounts SET cash_cents = cash_cents + ? WHERE kind = 'career' AND user_id = ?", c, idOf(r, n));
    }
    social.invalidate();
    r.clock.ms = week0 + WEEK_MS + 60_000; // next Monday
    social.rollWeek();
    const rows = db(r).all<{ place: number; user_id: number; gain_pct: number }>('SELECT place, user_id, gain_pct FROM weekly_winners WHERE week_start_ms = ? ORDER BY place', week0);
    expect(rows.map((x) => [x.place, x.user_id])).toEqual([[1, idOf(r, 'alice')], [2, idOf(r, 'bob')], [3, idOf(r, 'carol')]]);
    expect(rows[0]?.gain_pct).toBeCloseTo(30, 5);
    // The old marks are still there, but a second call (or a restart) writes nothing new.
    r.clock.ms += 60_000;
    social.rollWeek();
    expect(db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM weekly_winners')?.n).toBe(3);
    // The room shows it.
    const cookie = (await call(r, '/api/auth/login', { method: 'POST', body: { username: 'alice', password: 'a-good-password' } })).headers.get('set-cookie')?.split(';')[0] as string;
    const room = (await call(r, '/api/trophies/alice', { cookie })).json;
    expect(room.weekly.podiums[0]).toMatchObject({ weekStartMs: week0, place: 1 });
    expect(DAY_MS).toBe(86_400_000);
  }, LONG);
});
