// Ranked 1v1 (src/world/rankedRules.ts, server/ranked.ts, docs/world.md §31). A match between two real players from the lobby moves their points; a friend match, a match against
// a bot and an abandoned match never do. Five tiers (Bronze … Diamond), a floor a player cannot fall below this season, weekly seasons with a soft reset and a podium, and the same
// two players can earn points from each other only a few times an hour.
import { describe, expect, it } from 'vitest';
import {
  FORFEIT_EXTRA,
  LOSS_BASE,
  PAIR_LIMIT,
  PAIR_WINDOW_MS,
  RANK_START_POINTS,
  RANK_TIERS,
  SEASON_MIN_MATCHES,
  WIN_BASE,
  applyDelta,
  expectedScore,
  nextTierOf,
  pointsDelta,
  progressOf,
  rankText,
  seasonStartPoints,
  tierIndexOf,
  tierOf,
} from '../src/world';
import { weekStartOf, WEEK_MS } from '../server/social';
import { Ranked } from '../server/ranked';
import { LONG, db, idOf, liveRig, type Running } from './helpers/chatlive';

const { boot, call, signUp, listen } = liveRig('ranked');

// ---- the rules -----------------------------------------------------------------------------------------------------------------

describe('the rules', () => {
  it('RANK-1: five tiers with the floors 0, 200, 400, 650 and 900; a new player starts in the middle of Bronze', () => {
    expect(RANK_TIERS.map((t) => [t.name, t.floor])).toEqual([
      ['Bronze', 0],
      ['Silver', 200],
      ['Gold', 400],
      ['Platinum', 650],
      ['Diamond', 900],
    ]);
    expect(RANK_START_POINTS).toBe(100);
    expect(tierOf(RANK_START_POINTS).name).toBe('Bronze');
    for (const [points, tier] of [
      [0, 0],
      [199, 0],
      [200, 1],
      [399, 1],
      [400, 2],
      [649, 2],
      [650, 3],
      [899, 3],
      [900, 4],
      [5000, 4],
    ] as const) {
      expect(tierIndexOf(points)).toBe(tier);
    }
    expect(nextTierOf(250)?.name).toBe('Gold');
    expect(nextTierOf(900)).toBeNull();
    const mid = progressOf(300);
    expect(mid).toMatchObject({ into: 100, span: 200, fraction: 0.5 });
    expect(mid.tier.name).toBe('Silver');
    expect(progressOf(1200)).toMatchObject({ next: null, span: 0, fraction: 1 });
    expect(rankText(312)).toBe('Silver · 312 points');
  });

  it('RANK-2: a win is worth 25 between equals and more against a stronger player; a loss costs 20 and more against a weaker one; a tie moves nothing; a forfeit costs a loss plus 10', () => {
    expect(WIN_BASE).toBe(25);
    expect(LOSS_BASE).toBe(20);
    expect(FORFEIT_EXTRA).toBe(10);
    expect(expectedScore(500, 500)).toBeCloseTo(0.5, 10);
    expect(expectedScore(700, 100) + expectedScore(100, 700)).toBeCloseTo(1, 10);
    expect(pointsDelta('win', 300, 300)).toBe(25);
    expect(pointsDelta('loss', 300, 300)).toBe(-20);
    expect(pointsDelta('tie', 300, 300)).toBe(0);
    expect(pointsDelta('forfeit', 300, 300)).toBe(-30);
    // A stronger opponent (600 points above): a win is worth more, a loss costs less.
    expect(pointsDelta('win', 100, 700)).toBe(35);
    expect(pointsDelta('loss', 100, 700)).toBe(-12);
    // A weaker opponent: a win is worth less, a loss costs more.
    expect(pointsDelta('win', 700, 100)).toBe(15);
    expect(pointsDelta('loss', 700, 100)).toBe(-28);
    // Always at least something to win and something to lose, however far apart they are.
    for (const gap of [-5000, -1000, 0, 1000, 5000]) {
      expect(pointsDelta('win', 1000, 1000 + gap)).toBeGreaterThanOrEqual(12);
      expect(pointsDelta('win', 1000, 1000 + gap)).toBeLessThanOrEqual(38);
      expect(pointsDelta('loss', 1000, 1000 + gap)).toBeLessThanOrEqual(-10);
      expect(pointsDelta('loss', 1000, 1000 + gap)).toBeGreaterThanOrEqual(-30);
    }
  });

  it('RANK-3: the floor: points never fall below the bottom of the highest tier reached this season, and a climb moves that tier up', () => {
    expect(applyDelta({ points: 410, peakTier: 2 }, -30)).toEqual({ points: 400, peakTier: 2 });
    expect(applyDelta({ points: 400, peakTier: 2 }, -20)).toEqual({ points: 400, peakTier: 2 });
    expect(applyDelta({ points: 100, peakTier: 0 }, -500)).toEqual({ points: 0, peakTier: 0 });
    expect(applyDelta({ points: 195, peakTier: 0 }, 10)).toEqual({ points: 205, peakTier: 1 });
    // After reaching Silver, a bad run stops at 200, not in Bronze.
    let state = { points: 205, peakTier: 1 };
    for (let i = 0; i < 20; i += 1) state = applyDelta(state, -20);
    expect(state).toEqual({ points: 200, peakTier: 1 });
  });

  it('RANK-4: a new season starts halfway between the old points and the start points', () => {
    expect(seasonStartPoints(100)).toBe(100);
    expect(seasonStartPoints(900)).toBe(500);
    expect(seasonStartPoints(300)).toBe(200);
    expect(seasonStartPoints(0)).toBe(50);
    expect(seasonStartPoints(101)).toBe(100);
    expect(seasonStartPoints(2100)).toBe(1100);
  });
});

// ---- the ladder on the server --------------------------------------------------------------------------------------------------

let nextMatch = 0;
/** A finished match between two players, as the match service leaves it (rows only), for the tests that call Ranked.settle themselves. */
function finishedMatch(r: Running, a: string, b: string, friends = false): number {
  nextMatch += 1;
  const id = db(r).run(
    "INSERT INTO matches(state, created_ms, duration_ticks, start_cash_cents, settled_ms, outcome, winner_user_id, friends) VALUES ('finished', ?, 180, 100000, ?, 'win', ?, ?)",
    r.clock.now(),
    r.clock.now(),
    idOf(r, a),
    friends ? 1 : 0,
  ).lastInsertRowid;
  for (const name of [a, b]) {
    db(r).run("INSERT INTO match_players(match_id, user_id, joined_ms, last_seen_ms, active, result) VALUES (?, ?, ?, ?, 0, 'win')", id, idOf(r, name), r.clock.now(), r.clock.now());
  }
  return id;
}

/** Settles a pretend match in which `winner` beat `loser`. Returns what happened to each. */
function play(r: Running, winner: string, loser: string, options: { friends?: boolean; bot?: boolean; outcome?: 'win' | 'forfeit' | 'tie' | 'abandoned' } = {}) {
  const matchId = finishedMatch(r, winner, loser, options.friends);
  const outcome = options.outcome ?? 'win';
  const result = (win: boolean) => (outcome === 'tie' ? ('tie' as const) : outcome === 'forfeit' ? (win ? ('win' as const) : ('forfeit' as const)) : win ? ('win' as const) : ('loss' as const));
  return r.app.services.ranked.settle({
    matchId,
    friends: options.friends === true,
    outcome,
    nowMs: r.clock.now(),
    players: [
      { userId: idOf(r, winner), bot: false, result: result(true) },
      { userId: idOf(r, loser), bot: options.bot === true, result: result(false) },
    ],
  });
}

const points = (r: Running, name: string): number | undefined => db(r).get<{ points: number }>('SELECT points FROM ranked_player WHERE user_id = ?', idOf(r, name))?.points;

async function trio() {
  const r = await boot();
  const alice = await signUp(r, 'alice');
  const bob = await signUp(r, 'bob');
  const carol = await signUp(r, 'carol');
  return { r, alice, bob, carol };
}

describe('points on the server', () => {
  it('RANK-5: before any match a player stands at the start points, in Bronze, with no place; the ladder is empty; it needs a signed-in player', async () => {
    const { r, alice } = await trio();
    expect((await call(r, '/api/ranked')).status).toBe(401);
    const v = (await call(r, '/api/ranked', { cookie: alice })).json;
    expect(v.startPoints).toBe(100);
    expect(v.me).toMatchObject({ points: 100, tier: 'bronze', tierName: 'Bronze', place: null, matches: 0, wins: 0, losses: 0, floorPoints: 0 });
    expect(v.me.next).toEqual({ name: 'Silver', floor: 200 });
    expect(v.ladder).toEqual([]);
    expect(v.players).toBe(0);
    expect(v.lastSeason).toBeNull();
    expect(v.tiers.map((t: any) => t.name)).toEqual(['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond']);
    // A season is a week from Monday 00:00 Tokyo time.
    expect(v.season.startMs).toBe(weekStartOf(r.clock.now()));
    expect(v.season.endMs - v.season.startMs).toBe(WEEK_MS);
  }, LONG);

  it('RANK-6: a win and a loss between equals move 25 and 20 points, are written on the match rows, and make the ladder', async () => {
    const { r, alice, bob } = await trio();
    const out = play(r, 'alice', 'bob');
    expect(out?.get(idOf(r, 'alice'))).toEqual({ before: 100, after: 125, note: null });
    expect(out?.get(idOf(r, 'bob'))).toEqual({ before: 100, after: 80, note: null });
    expect(points(r, 'alice')).toBe(125);
    expect(points(r, 'bob')).toBe(80);
    const rows = db(r).all<{ user_id: number; rank_before: number; rank_after: number }>('SELECT user_id, rank_before, rank_after FROM match_players ORDER BY user_id');
    expect(rows).toEqual([
      { user_id: idOf(r, 'alice'), rank_before: 100, rank_after: 125 },
      { user_id: idOf(r, 'bob'), rank_before: 100, rank_after: 80 },
    ]);
    const a = (await call(r, '/api/ranked', { cookie: alice })).json;
    expect(a.me).toMatchObject({ points: 125, place: 1, matches: 1, wins: 1, losses: 0 });
    expect(a.ladder.map((e: any) => [e.place, e.username, e.points, e.you])).toEqual([
      [1, 'alice', 125, true],
      [2, 'bob', 80, false],
    ]);
    const b = (await call(r, '/api/ranked', { cookie: bob })).json;
    expect(b.me).toMatchObject({ points: 80, place: 2, matches: 1, wins: 0, losses: 1 });
    expect(a.players).toBe(2);
  }, LONG);

  it('RANK-7: a friend match, a match against a bot and an abandoned match never move points', async () => {
    const { r } = await trio();
    expect(play(r, 'alice', 'bob', { friends: true })).toBeNull();
    expect(play(r, 'alice', 'bob', { bot: true })).toBeNull();
    expect(play(r, 'alice', 'bob', { outcome: 'abandoned' })).toBeNull();
    expect(db(r).all('SELECT * FROM ranked_player')).toEqual([]);
    expect(db(r).all('SELECT * FROM match_players WHERE rank_before IS NOT NULL')).toEqual([]);
    expect(Ranked.counts({ friends: false, outcome: 'win', players: [{ userId: 1, bot: false, result: 'win' }, { userId: 2, bot: false, result: 'loss' }] })).toBe(true);
    expect(Ranked.counts({ friends: true, outcome: 'win', players: [{ userId: 1, bot: false, result: 'win' }, { userId: 2, bot: false, result: 'loss' }] })).toBe(false);
  }, LONG);

  it('RANK-8: a tie moves nothing but counts as a match; leaving a live match costs a loss plus 10 and the other player wins normally', async () => {
    const { r } = await trio();
    play(r, 'alice', 'bob', { outcome: 'tie' });
    expect(points(r, 'alice')).toBe(100);
    expect(points(r, 'bob')).toBe(100);
    expect(db(r).get<{ matches: number; wins: number; losses: number }>('SELECT matches, wins, losses FROM ranked_player WHERE user_id = ?', idOf(r, 'alice'))).toEqual({ matches: 1, wins: 0, losses: 0 });
    play(r, 'alice', 'bob', { outcome: 'forfeit' });
    expect(points(r, 'alice')).toBe(125);
    expect(points(r, 'bob')).toBe(70);
    expect(db(r).get<{ losses: number }>('SELECT losses FROM ranked_player WHERE user_id = ?', idOf(r, 'bob'))?.losses).toBe(1);
  }, LONG);

  it('RANK-9: the floor holds in a season: after reaching Silver a run of losses stops at 200; the highest tier ever is kept for the badges', async () => {
    const { r } = await trio();
    db(r).run('INSERT INTO ranked_player(user_id, season_ms, points, peak_tier, best_tier, matches, wins, losses, updated_ms) VALUES (?, ?, 205, 1, 1, 5, 5, 0, 0)', idOf(r, 'alice'), weekStartOf(r.clock.now()));
    // Different opponents each time, so the same-pair limit (RANK-10) does not get in the way.
    const names = ['bob', 'carol'];
    for (let i = 0; i < 6; i += 1) {
      r.clock.advanceSeconds(3700);
      play(r, names[i % 2] as string, 'alice');
      // keep it the same season
    }
    expect(points(r, 'alice')).toBe(200);
    const row = db(r).get<{ peak_tier: number; best_tier: number }>('SELECT peak_tier, best_tier FROM ranked_player WHERE user_id = ?', idOf(r, 'alice'));
    expect(row).toEqual({ peak_tier: 1, best_tier: 1 });
    const v = (await call(r, '/api/ranked', { cookie: (await call(r, '/api/auth/login', { method: 'POST', body: { username: 'alice', password: 'a-good-password' } })).headers.get('set-cookie')?.split(';')[0] })).json;
    expect(v.me).toMatchObject({ points: 200, tier: 'silver', floorPoints: 200 });
  }, LONG);

  it('RANK-10: the same two players earn points from each other 3 times an hour; the 4th moves nothing and says why; after the hour it counts again', async () => {
    const { r } = await trio();
    expect(PAIR_LIMIT).toBe(3);
    expect(PAIR_WINDOW_MS).toBe(3_600_000);
    for (let i = 0; i < PAIR_LIMIT; i += 1) {
      r.clock.advanceSeconds(60);
      expect(play(r, 'alice', 'bob')?.get(idOf(r, 'alice'))?.note).toBeNull();
    }
    const before = points(r, 'alice');
    r.clock.advanceSeconds(60);
    const fourth = play(r, 'alice', 'bob');
    expect(fourth?.get(idOf(r, 'alice'))).toEqual({ before, after: before, note: 'limit' });
    expect(fourth?.get(idOf(r, 'bob'))?.note).toBe('limit');
    expect(points(r, 'alice')).toBe(before);
    // Someone else is not affected.
    r.clock.advanceSeconds(60);
    expect(play(r, 'alice', 'carol')?.get(idOf(r, 'alice'))?.note).toBeNull();
    // An hour later the pair counts again.
    r.clock.advanceSeconds(3700);
    expect(play(r, 'alice', 'bob')?.get(idOf(r, 'alice'))?.note).toBeNull();
  }, LONG);
});

describe('seasons', () => {
  it('RANK-11: when a new week starts the podium is written down, everybody moves halfway back to the start, and the season counters start again', async () => {
    const { r } = await trio();
    const season = weekStartOf(r.clock.now());
    const put = (name: string, pts: number, matches: number, wins: number, peak: number) =>
      db(r).run('INSERT INTO ranked_player(user_id, season_ms, points, peak_tier, best_tier, matches, wins, losses, updated_ms) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)', idOf(r, name), season, pts, peak, peak, matches, wins);
    put('alice', 900, 12, 10, 4);
    put('bob', 500, 8, 5, 2);
    put('carol', 700, SEASON_MIN_MATCHES - 1, 4, 3); // too few matches for the podium
    r.app.services.ranked.rollSeason(); // starts the first season record (nothing to close yet)
    expect(db(r).all('SELECT * FROM ranked_season_results')).toEqual([]);
    r.clock.ms = season + WEEK_MS + 3_600_000; // the next Monday, 01:00 Tokyo time
    expect(r.app.services.ranked.rollSeason()).toBe(true);
    const results = db(r).all<{ place: number; user_id: number; points: number; matches: number }>('SELECT place, user_id, points, matches FROM ranked_season_results ORDER BY place');
    expect(results).toEqual([
      { place: 1, user_id: idOf(r, 'alice'), points: 900, matches: 12 },
      { place: 2, user_id: idOf(r, 'bob'), points: 500, matches: 8 },
    ]);
    expect(points(r, 'alice')).toBe(500); // halfway between 900 and 100
    expect(points(r, 'bob')).toBe(300);
    expect(points(r, 'carol')).toBe(400);
    const a = db(r).get<{ season_ms: number; matches: number; wins: number; peak_tier: number; best_tier: number }>('SELECT season_ms, matches, wins, peak_tier, best_tier FROM ranked_player WHERE user_id = ?', idOf(r, 'alice'));
    expect(a).toEqual({ season_ms: season + WEEK_MS, matches: 0, wins: 0, peak_tier: 2, best_tier: 4 });
    // Calling it again in the same week does nothing.
    expect(r.app.services.ranked.rollSeason()).toBe(false);
    expect(db(r).all('SELECT * FROM ranked_season_results')).toHaveLength(2);
    // The ladder of the new season is empty until somebody plays; last season's podium is shown.
    const cookie = (await call(r, '/api/auth/login', { method: 'POST', body: { username: 'bob', password: 'a-good-password' } })).headers.get('set-cookie')?.split(';')[0];
    const v = (await call(r, '/api/ranked', { cookie })).json;
    expect(v.ladder).toEqual([]);
    expect(v.me).toMatchObject({ points: 300, tier: 'silver', place: null, matches: 0 });
    expect(v.lastSeason.places.map((p: any) => [p.place, p.username, p.points])).toEqual([
      [1, 'alice', 900],
      [2, 'bob', 500],
    ]);
  }, LONG);

  it('RANK-12: the owner is not on the ladder or the podium', async () => {
    const r = await boot();
    const boss = await signUp(r, 'boss'); // the owner of this world
    await signUp(r, 'alice');
    const season = weekStartOf(r.clock.now());
    for (const n of ['boss', 'alice']) {
      db(r).run('INSERT INTO ranked_player(user_id, season_ms, points, peak_tier, best_tier, matches, wins, losses, updated_ms) VALUES (?, ?, 800, 3, 3, 9, 7, 2, 0)', idOf(r, n), season);
    }
    const v = (await call(r, '/api/ranked', { cookie: boss })).json;
    expect(v.ladder.map((e: any) => e.username)).toEqual(['alice']);
    r.clock.ms = season + WEEK_MS + 1000;
    r.app.services.ranked.rollSeason();
    r.clock.ms = season + 2 * WEEK_MS + 1000;
    r.app.services.ranked.rollSeason();
    expect(db(r).all<{ user_id: number }>('SELECT user_id FROM ranked_season_results').map((x) => x.user_id)).toEqual([idOf(r, 'alice')]);
  }, LONG);
});

describe('badges', () => {
  it('RANK-13: reaching a tier, finishing a season on the podium and in first place earn the ranked badges', async () => {
    const { r } = await trio();
    const season = weekStartOf(r.clock.now());
    db(r).run('INSERT INTO ranked_player(user_id, season_ms, points, peak_tier, best_tier, matches, wins, losses, updated_ms) VALUES (?, ?, 910, 4, 4, 10, 9, 1, 0)', idOf(r, 'alice'), season);
    db(r).run('INSERT INTO ranked_player(user_id, season_ms, points, peak_tier, best_tier, matches, wins, losses, updated_ms) VALUES (?, ?, 450, 2, 2, 6, 4, 2, 0)', idOf(r, 'bob'), season);
    r.app.services.ranked.rollSeason();
    r.clock.ms = season + WEEK_MS + 1000;
    r.app.services.ranked.rollSeason();
    r.app.services.badges.sweep();
    const has = (name: string): string[] =>
      db(r)
        .all<{ badge: string }>("SELECT badge FROM user_badges WHERE user_id = ? AND (badge LIKE 'rank_%' OR badge LIKE 'season_%') ORDER BY badge", idOf(r, name))
        .map((x) => x.badge);
    expect(has('alice')).toEqual(['rank_diamond', 'rank_gold', 'rank_platinum', 'rank_silver', 'season_champion', 'season_podium']);
    expect(has('bob')).toEqual(['rank_gold', 'rank_silver', 'season_podium']);
    expect(has('carol')).toEqual([]);
  }, LONG);
});

// ---- a real match, through the lobby -------------------------------------------------------------------------------------------

async function gotoTick(r: Running, tick: number, cookies: string[]): Promise<void> {
  const w = r.app.services.world;
  while (w.currentTick() < tick) {
    const next = Math.min(tick, w.currentTick() + 5);
    r.clock.ms = w.msOfTick(next);
    for (let i = 0; i < 20_000 && w.sim.tick < w.currentTick(); i += 1) w.pump();
    for (const c of cookies) await call(r, '/api/lobby', { cookie: c });
  }
}

describe('through the lobby', () => {
  it('RANK-14: a match the lobby made between two players is ranked: the view says so, a forfeit settles at the end, and both see their points', async () => {
    const r = await boot();
    const [ca, cb] = [await signUp(r, 'alice'), await signUp(r, 'bob')];
    const a = await call(r, '/api/lobby/join', { method: 'POST', cookie: ca });
    expect(a.json.match.ranked).toBe(true); // waiting alone: it would be ranked
    const b = await call(r, '/api/lobby/join', { method: 'POST', cookie: cb });
    expect(b.json.match.ranked).toBe(true);
    await call(r, '/api/lobby/ready', { method: 'POST', cookie: ca, body: { ready: true } });
    const ready = await call(r, '/api/lobby/ready', { method: 'POST', cookie: cb, body: { ready: true } });
    const view = ready.json.match;
    await gotoTick(r, view.startTick + 5, [ca, cb]);
    // bob walks out of the live match: he forfeits, alice wins when the time is up.
    await call(r, '/api/lobby/leave', { method: 'POST', cookie: cb });
    await gotoTick(r, view.endTick + 12, [ca, cb]);
    const done = await call(r, '/api/lobby', { cookie: ca });
    expect(done.json.match.phase).toBe('finished');
    expect(done.json.match.ranked).toBe(true);
    const mine = done.json.match.players.find((p: any) => p.you);
    const his = done.json.match.players.find((p: any) => !p.you);
    expect(mine.rank).toEqual({ before: 100, after: 125, note: null });
    expect(his.rank).toEqual({ before: 100, after: 70, note: null });
    const hist = await call(r, '/api/matches', { cookie: cb });
    expect(hist.json.matches[0].you).toMatchObject({ rankBefore: 100, rankAfter: 70 });
    // The settled points are the same on the ladder.
    expect(points(r, 'alice')).toBe(125);
    expect(points(r, 'bob')).toBe(70);
    // Settling again changes nothing.
    expect(r.app.services.matches.settle(view.id)).toBe(false);
    expect(points(r, 'alice')).toBe(125);
  }, LONG);

  it('RANK-15: a friend match and a match against a bot are shown as not ranked and move no points', async () => {
    const r = await boot();
    const [ca, cb] = [await signUp(r, 'alice'), await signUp(r, 'bob')];
    // Make them friends and play a challenge match.
    await call(r, '/api/friends/request', { method: 'POST', cookie: ca, body: { username: 'bob' } });
    await call(r, '/api/friends/accept', { method: 'POST', cookie: cb, body: { username: 'alice' } });
    await listen(r, ca);
    await listen(r, cb); // both have the page open, so a challenge can be sent and answered
    const sent = await call(r, '/api/challenges/send', { method: 'POST', cookie: ca, body: { username: 'bob' } });
    expect(sent.status).toBe(200);
    const accepted = await call(r, '/api/challenges/accept', { method: 'POST', cookie: cb, body: { username: 'alice' } });
    expect(accepted.status).toBe(200);
    const lobby = accepted.json.match;
    expect(lobby.friendMatch).toBe(true);
    expect(lobby.ranked).toBe(false);
    await call(r, '/api/lobby/ready', { method: 'POST', cookie: ca, body: { ready: true } });
    const ready = await call(r, '/api/lobby/ready', { method: 'POST', cookie: cb, body: { ready: true } });
    await gotoTick(r, ready.json.match.endTick + 12, [ca, cb]);
    const done = await call(r, '/api/lobby', { cookie: ca });
    expect(done.json.match.phase).toBe('finished');
    expect(done.json.match.ranked).toBe(false);
    expect(done.json.match.players.every((p: any) => p.rank === null)).toBe(true);
    expect(db(r).all('SELECT * FROM ranked_player')).toEqual([]);
  }, LONG);
});
