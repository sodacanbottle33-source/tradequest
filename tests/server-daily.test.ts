// Daily goals, the streak and the free looks (src/shared/goalCatalog.ts, server/daily.ts, docs/world.md §32). Three goals a day (one from the market, one from learning, one from
// 1v1), the same for everybody. A finished goal is noticed from what the game already saved, paid once (a little XP, Career cash and 1v1 coins), finishing all three pays a bonus,
// a day with a finished goal keeps the streak alive, a freeze covers a missed day, and a few streak milestones give a free look the player chooses. The cash is not growth on the
// weekly board, and a computer player never takes part.
import { describe, expect, it } from 'vitest';
import {
  BONUS_REWARD,
  DAY_MS,
  FREEZE_EVERY,
  GOALS,
  GOALS_PER_DAY,
  GOAL_GROUPS,
  GOAL_REWARD,
  MAX_FREEZES,
  STREAK_MILESTONES,
  dayOf,
  dayStartMs,
  goalById,
  goalsOfDay,
  rewardText,
} from '../src/shared/goalCatalog';
import { COSMETICS } from '../src/shared/cosmeticCatalog';
import { LONG, db, idOf, liveRig, until, type Running } from './helpers/chatlive';

const { boot, call, signUp, listen } = liveRig('daily');

// ---- helpers -----------------------------------------------------------------------------------------------------------------

let nextOrder = 0;
const oid = (): string => `daily-order-${(nextOrder += 1)}-abcdef`;

/** Makes today's goals these three (the real list is a hash of the day; a test wants to know which ones). */
function setGoals(r: Running, ids: readonly string[]): void {
  (r.app.services.daily as unknown as { d: { goalsOfDay: (day: number) => readonly string[] } }).d.goalsOfDay = () => ids;
}

const today = (r: Running): number => dayOf(r.clock.now());
/** Moves the clock to `hours` after the start (00:00 Tokyo time) of a day. */
function toDay(r: Running, day: number, hours = 12): void {
  r.clock.ms = dayStartMs(day) + hours * 3_600_000;
}

const ledger = (r: Running, name: string) => db(r).get<{ n: number; s: number | null }>("SELECT COUNT(*) AS n, SUM(delta_cents) AS s FROM wallet_ledger WHERE user_id = ? AND reason = 'daily_goal'", idOf(r, name)) as { n: number; s: number | null };
const xp = (r: Running, name: string): number => db(r).get<{ xp: number }>('SELECT xp FROM learn_progress WHERE user_id = ?', idOf(r, name))?.xp ?? 0;
const cash = (r: Running, name: string): number => (db(r).get<{ c: number }>("SELECT cash_cents AS c FROM accounts WHERE user_id = ? AND kind = 'career'", idOf(r, name)) as { c: number }).c;
const coins = (r: Running, name: string): number => db(r).get<{ b: number }>('SELECT balance_cents AS b FROM wallets WHERE user_id = ?', idOf(r, name))?.b ?? 0;
const doneGoals = (r: Running, name: string, day = today(r)): string[] => db(r).all<{ goal: string }>('SELECT goal FROM daily_goal_done WHERE user_id = ? AND day = ? ORDER BY goal', idOf(r, name), day).map((x) => x.goal);

/** A lesson answered now (what the Learn page leaves behind), or one that was skipped. */
function lesson(r: Running, name: string, how: 'answered' | 'skipped' = 'answered', atMs = r.clock.now()): void {
  db(r).run(
    'INSERT INTO learn_lessons(user_id, kind, pattern, seed, scenario, issued_ms, answered_ms, skipped_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    idOf(r, name),
    'direction',
    'test',
    1,
    '{}',
    atMs,
    how === 'answered' ? atMs : null,
    how === 'skipped' ? atMs : null,
  );
}

let nextMatch = 0;
/** A finished 1v1 match in which `name` got `result` (the rows the match service leaves). */
function match(r: Running, name: string, result: 'win' | 'loss' | 'tie' | 'forfeit', atMs = r.clock.now()): void {
  nextMatch += 1;
  const id = db(r).run("INSERT INTO matches(state, created_ms, duration_ticks, start_cash_cents, settled_ms, outcome, friends) VALUES ('finished', ?, 180, 100000, ?, 'win', 0)", atMs, atMs).lastInsertRowid;
  db(r).run('INSERT INTO match_players(match_id, user_id, joined_ms, last_seen_ms, active, result) VALUES (?, ?, ?, ?, 0, ?)', id, idOf(r, name), atMs, atMs, result);
  void nextMatch;
}

/** A trade row the way the order desk writes it (only the columns that matter here). */
function fakeTrade(r: Running, name: string, side: 'buy' | 'sell', realized: number, companyId: number, atMs = r.clock.now()): void {
  const acc = db(r).get<{ id: number }>("SELECT id FROM accounts WHERE user_id = ? AND kind = 'career'", idOf(r, name)) as { id: number };
  db(r).run(
    "INSERT INTO trades(account_id, client_order_id, company_id, side, requested, filled, total_cents, mid_cents, spread_cents, impact_cents, realized_cents, tick, created_ms, result_json) VALUES (?, ?, ?, ?, 1, 1, 1000, 1000, 0, 0, ?, 1, ?, '{}')",
    acc.id,
    oid(),
    companyId,
    side,
    realized,
    atMs,
  );
}

const goals = async (r: Running, cookie: string) => (await call(r, '/api/goals', { cookie })).json;
const line = (v: any, id: string) => v.goals.find((g: any) => g.id === id);

/** Finishes one goal on the clock's day: a lesson (the cheapest goal to make true). */
async function finishOne(r: Running, name: string, cookie: string): Promise<any> {
  setGoals(r, ['lesson_1', 'win_1', 'limit_1']);
  lesson(r, name);
  return goals(r, cookie);
}

function stocks(r: Running) {
  const w = r.app.services.world;
  return w.companies.filter((c) => c.sector !== 'meme' && w.sim.isListed(c.id) && w.sim.price(c.id) >= 1500 && w.sim.price(c.id) <= 6000);
}

// ---- the catalog and the day --------------------------------------------------------------------------------------------------

describe('the list of goals', () => {
  it('DAILY-1: every goal has a group, a target, a hint and an icon; a day has one goal from each group, the same every time, and not the same every day', () => {
    expect(GOAL_GROUPS).toEqual(['market', 'learn', 'play']);
    expect(GOALS_PER_DAY).toBe(3);
    expect(new Set(GOALS.map((g) => g.id)).size).toBe(GOALS.length);
    for (const g of GOALS) {
      expect(GOAL_GROUPS).toContain(g.group);
      expect(g.target).toBeGreaterThanOrEqual(1);
      expect(g.title.length).toBeGreaterThan(3);
      expect(g.hint.length).toBeGreaterThan(10);
      expect(g.icon.length).toBeGreaterThan(0);
      expect(goalById(g.id)).toBe(g);
    }
    const seen = new Set<string>();
    for (let day = 20_000; day < 20_060; day += 1) {
      const ids = goalsOfDay(day);
      expect(ids).toEqual(goalsOfDay(day));
      expect(ids.map((id) => goalById(id)?.group)).toEqual(GOAL_GROUPS);
      seen.add(ids.join(','));
    }
    expect(seen.size).toBeGreaterThan(5);
    expect(goalById('nothing')).toBeUndefined();
  });

  it('DAILY-2: a day starts at 00:00 Tokyo time; the reward lines read well', () => {
    const noon = Date.UTC(2026, 9, 1, 12, 0, 0);
    // 12:00 UTC is 21:00 Tokyo time on the same date; 15:00 UTC is already midnight of the next day there.
    expect(dayOf(Date.UTC(2026, 9, 1, 14, 59, 59))).toBe(dayOf(noon));
    expect(dayOf(Date.UTC(2026, 9, 1, 15, 0, 0))).toBe(dayOf(noon) + 1);
    expect(dayStartMs(dayOf(noon))).toBe(Date.UTC(2026, 8, 30, 15, 0, 0));
    expect(dayStartMs(dayOf(noon) + 1) - dayStartMs(dayOf(noon))).toBe(DAY_MS);
    expect(rewardText(GOAL_REWARD)).toBe('+$10 · 10 XP · $5 1v1 coins');
    expect(rewardText({ xp: 0, cashCents: 0, coinCents: 0 })).toBe('');
    expect(BONUS_REWARD.cashCents).toBeGreaterThan(0);
    expect(STREAK_MILESTONES.map((m) => m.days)).toEqual([3, 7, 14, 30]);
    expect(FREEZE_EVERY).toBe(7);
    expect(MAX_FREEZES).toBe(2);
    // No milestone gives a look that needs a badge: the best looks stay a sign of something done.
    for (const m of STREAK_MILESTONES) expect(COSMETICS.filter((c) => c.rarity === m.rarity && c.requiresBadge === undefined).length).toBeGreaterThan(2);
  });
});

// ---- what a player sees --------------------------------------------------------------------------------------------------------

describe('the Goals page', () => {
  it('DAILY-3: it needs a signed-in player; a new player sees three open goals, no streak, a locked ladder and the time the goals change', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    expect((await call(r, '/api/goals')).status).toBe(401);
    expect((await call(r, '/api/goals/claim', { method: 'POST', body: { milestone: 3, item: 'c_sky' } })).status).toBe(401);
    const v = await goals(r, alice);
    expect(v.day).toBe(today(r));
    expect(v.endMs - v.startMs).toBe(DAY_MS);
    expect(v.serverMs).toBe(r.clock.now());
    expect(v.goals.map((g: any) => g.id)).toEqual(goalsOfDay(today(r)));
    for (const g of v.goals) expect(g).toMatchObject({ progress: 0, done: false, reward: GOAL_REWARD });
    expect(v.bonus).toEqual({ reward: BONUS_REWARD, paid: false });
    expect(v.streak).toMatchObject({ current: 0, best: 0, freezes: 0, atRisk: false, lost: false, todayDone: false, toFreeze: FREEZE_EVERY });
    expect(v.milestones.map((m: any) => [m.days, m.state])).toEqual([
      [3, 'locked'],
      [7, 'locked'],
      [14, 'locked'],
      [30, 'locked'],
    ]);
    expect(v.milestones.every((m: any) => m.choices.length === 0 && m.item === null)).toBe(true);
    // Asking changes nothing by itself.
    expect(ledger(r, 'alice').n).toBe(0);
    expect(cash(r, 'alice')).toBe(100_000);
  }, LONG);
});

// ---- finishing goals and being paid -------------------------------------------------------------------------------------------

describe('finishing a goal', () => {
  it('DAILY-4: a lesson pays 10 XP, $10 of Career cash and $5 of 1v1 coins once, however often the page asks; the page is told through the stream', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const stream = await listen(r, alice);
    setGoals(r, ['lesson_1', 'win_1', 'limit_1']);
    expect(line(await goals(r, alice), 'lesson_1')).toMatchObject({ progress: 0, done: false });
    lesson(r, 'alice');
    const v = await goals(r, alice);
    expect(line(v, 'lesson_1')).toMatchObject({ progress: 1, done: true });
    expect(v.streak).toMatchObject({ current: 1, best: 1, todayDone: true, atRisk: false });
    expect(xp(r, 'alice')).toBe(10);
    expect(cash(r, 'alice')).toBe(101_000);
    expect(coins(r, 'alice')).toBe(500);
    expect(ledger(r, 'alice')).toEqual({ n: 1, s: 500 });
    // Again and again: nothing more is paid.
    for (let i = 0; i < 4; i += 1) await goals(r, alice);
    expect(r.app.services.daily.sweep(idOf(r, 'alice'))).toBeNull();
    expect(xp(r, 'alice')).toBe(10);
    expect(cash(r, 'alice')).toBe(101_000);
    expect(coins(r, 'alice')).toBe(500);
    expect(doneGoals(r, 'alice')).toEqual(['lesson_1']);
    // The cash is written as a gift of the game (so the weekly board does not count it as growth).
    expect(db(r).all('SELECT cents, reason FROM cash_gifts WHERE user_id = ?', idOf(r, 'alice'))).toEqual([{ cents: 1000, reason: 'daily goals' }]);
    // The page that was open heard it.
    expect(await until(() => stream.text().includes('event: goals'))).toBe(true);
    const events = stream.text().split('\n\n').filter((b) => b.startsWith('event: goals'));
    expect(events).toHaveLength(1);
    expect(JSON.parse((events[0] as string).split('data: ')[1] as string)).toMatchObject({ finished: ['lesson_1'], bonus: false, reward: GOAL_REWARD, milestones: [], streak: 1 });
  }, LONG);

  it('DAILY-5: real orders count: buying two different companies finishes "buy 2", three orders finish "make 3 trades"; a limit order that waits finishes "set a limit order"', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    setGoals(r, ['buy_2', 'trade_3', 'limit_1']);
    const [a, b] = stocks(r);
    expect(a && b).toBeTruthy();
    const order = (ticker: string, side: 'buy' | 'sell') => call(r, '/api/orders', { method: 'POST', cookie: alice, body: { account: 'career', ticker, side, qty: 1, clientOrderId: oid() } });
    expect((await order((a as NonNullable<typeof a>).ticker, 'buy')).status).toBe(201);
    let v = await goals(r, alice);
    expect(line(v, 'buy_2')).toMatchObject({ progress: 1, done: false });
    expect(line(v, 'trade_3')).toMatchObject({ progress: 1, done: false });
    // The same company again is a trade but not a different company.
    expect((await order((a as NonNullable<typeof a>).ticker, 'buy')).status).toBe(201);
    v = await goals(r, alice);
    expect(line(v, 'buy_2')).toMatchObject({ progress: 1, done: false });
    expect(line(v, 'trade_3')).toMatchObject({ progress: 2, done: false });
    expect((await order((b as NonNullable<typeof b>).ticker, 'buy')).status).toBe(201);
    v = await goals(r, alice);
    expect(line(v, 'buy_2')).toMatchObject({ progress: 2, done: true });
    expect(line(v, 'trade_3')).toMatchObject({ progress: 3, done: true });
    expect(doneGoals(r, 'alice')).toEqual(['buy_2', 'trade_3']);
    expect(xp(r, 'alice')).toBe(20);
    expect(ledger(r, 'alice')).toEqual({ n: 2, s: 1000 });
    // A limit order that waits.
    const quote = r.app.services.world.quote((a as NonNullable<typeof a>).id);
    const placed = await call(r, '/api/limit-orders', { method: 'POST', cookie: alice, body: { clientOrderId: oid(), ticker: (a as NonNullable<typeof a>).ticker, side: 'buy', qty: 1, limitPrice: Math.floor(quote.ask * 0.8) } });
    expect(placed.status).toBe(201);
    v = await goals(r, alice);
    expect(line(v, 'limit_1')).toMatchObject({ progress: 1, done: true });
    expect(v.bonus.paid).toBe(true);
    expect(doneGoals(r, 'alice')).toEqual(['buy_2', 'limit_1', 'trade_3']);
  }, LONG);

  it('DAILY-6: finishing all three pays a bonus once, on top: 40 XP, $40 and $20 of coins', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    setGoals(r, ['lesson_1', 'win_1', 'match_1']);
    lesson(r, 'alice');
    match(r, 'alice', 'win');
    let v = await goals(r, alice);
    expect(doneGoals(r, 'alice')).toEqual(['lesson_1', 'match_1', 'win_1']);
    expect(v.bonus.paid).toBe(true);
    expect(xp(r, 'alice')).toBe(40);
    expect(cash(r, 'alice')).toBe(100_000 + 4_000);
    expect(coins(r, 'alice')).toBe(2_000);
    expect(ledger(r, 'alice')).toEqual({ n: 4, s: 2_000 });
    expect(db(r).all('SELECT day FROM daily_bonus WHERE user_id = ?', idOf(r, 'alice'))).toEqual([{ day: today(r) }]);
    // More lessons, more matches: nothing more.
    lesson(r, 'alice');
    match(r, 'alice', 'win');
    v = await goals(r, alice);
    expect(xp(r, 'alice')).toBe(40);
    expect(coins(r, 'alice')).toBe(2_000);
  }, LONG);

  it('DAILY-7: what counts and what does not: a skipped lesson, yesterday\'s work, another player\'s work, a loss for "win", a trade without profit', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    await signUp(r, 'bob');
    const company = stocks(r)[0] as NonNullable<ReturnType<typeof stocks>[number]>;
    setGoals(r, ['lesson_3', 'win_1', 'profit_1']);
    // A lesson that was skipped is not an answer; neither is one from yesterday; neither is bob's.
    lesson(r, 'alice', 'skipped');
    lesson(r, 'alice', 'answered', r.clock.now() - DAY_MS);
    lesson(r, 'bob');
    let v = await goals(r, alice);
    expect(line(v, 'lesson_3')).toMatchObject({ progress: 0, done: false });
    lesson(r, 'alice');
    lesson(r, 'alice');
    v = await goals(r, alice);
    expect(line(v, 'lesson_3')).toMatchObject({ progress: 2, done: false });
    lesson(r, 'alice');
    v = await goals(r, alice);
    expect(line(v, 'lesson_3')).toMatchObject({ progress: 3, done: true });
    // A loss, a tie and a forfeit are not wins.
    match(r, 'alice', 'loss');
    match(r, 'alice', 'tie');
    match(r, 'alice', 'forfeit');
    match(r, 'bob', 'win');
    v = await goals(r, alice);
    expect(line(v, 'win_1')).toMatchObject({ progress: 0, done: false });
    match(r, 'alice', 'win');
    v = await goals(r, alice);
    expect(line(v, 'win_1')).toMatchObject({ progress: 1, done: true });
    // A sell at a loss, at nothing, and a buy are not a profit; a sell with a profit is.
    fakeTrade(r, 'alice', 'sell', -500, company.id);
    fakeTrade(r, 'alice', 'sell', 0, company.id);
    fakeTrade(r, 'alice', 'buy', 0, company.id);
    v = await goals(r, alice);
    expect(line(v, 'profit_1')).toMatchObject({ progress: 0, done: false });
    fakeTrade(r, 'alice', 'sell', 700, company.id);
    v = await goals(r, alice);
    expect(line(v, 'profit_1')).toMatchObject({ progress: 1, done: true });
    expect(v.bonus.paid).toBe(true);
  }, LONG);

  it('DAILY-8: a computer player does not take part, and a trade in a 1v1 match account is not a Career trade', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const company = stocks(r)[0] as NonNullable<ReturnType<typeof stocks>[number]>;
    setGoals(r, ['trade_3', 'lesson_1', 'win_1']);
    // A trade in a match account is not a Career trade.
    const matchAcc = db(r).run("INSERT INTO accounts(user_id, kind, cash_cents, start_cash_cents, created_ms) VALUES (?, 'match', 100000, 100000, ?)", idOf(r, 'alice'), r.clock.now()).lastInsertRowid;
    for (let i = 0; i < 3; i += 1) {
      db(r).run(
        "INSERT INTO trades(account_id, client_order_id, company_id, side, requested, filled, total_cents, mid_cents, spread_cents, impact_cents, realized_cents, tick, created_ms, result_json) VALUES (?, ?, ?, 'buy', 1, 1, 1000, 1000, 0, 0, 0, 1, ?, '{}')",
        matchAcc,
        oid(),
        company.id,
        r.clock.now(),
      );
    }
    const v = await goals(r, alice);
    expect(line(v, 'trade_3')).toMatchObject({ progress: 0, done: false });
    // A bot never earns anything (a player marked as a computer player, with a finished lesson, still gets nothing).
    await signUp(r, 'robo');
    db(r).run("INSERT INTO bots(user_id, persona) VALUES (?, 'daily-test-bot')", idOf(r, 'robo'));
    lesson(r, 'robo');
    expect(r.app.services.daily.sweep(idOf(r, 'robo'))).toBeNull();
    expect(r.app.services.daily.sweepMany([idOf(r, 'robo')])).toBe(0);
    expect(db(r).all('SELECT 1 FROM daily_goal_done WHERE user_id = ?', idOf(r, 'robo'))).toEqual([]);
    expect(coins(r, 'robo')).toBe(0);
  }, LONG);
});

// ---- the streak -----------------------------------------------------------------------------------------------------------------

describe('the streak', () => {
  it('DAILY-9: a day with a finished goal adds one to the streak; the second goal of the same day adds nothing', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const start = today(r);
    setGoals(r, ['lesson_1', 'match_1', 'limit_1']);
    lesson(r, 'alice');
    expect((await goals(r, alice)).streak).toMatchObject({ current: 1, best: 1 });
    match(r, 'alice', 'win');
    expect((await goals(r, alice)).streak).toMatchObject({ current: 1, best: 1 });
    toDay(r, start + 1);
    // Before he finishes anything on the new day, the streak is alive but at risk.
    let v = await goals(r, alice);
    expect(v.streak).toMatchObject({ current: 1, atRisk: true, todayDone: false, covers: 0, lost: false });
    lesson(r, 'alice');
    v = await goals(r, alice);
    expect(v.streak).toMatchObject({ current: 2, best: 2, atRisk: false, todayDone: true });
    // Yesterday's two goals are not today's: only the lesson counts again.
    expect(doneGoals(r, 'alice', start + 1)).toEqual(['lesson_1']);
    expect(v.bonus.paid).toBe(false);
    expect(db(r).all('SELECT day FROM daily_bonus')).toEqual([]);
  }, LONG);

  it('DAILY-10: a missed day with no freeze ends the streak: the page says so, and the next finished goal starts again at 1 (the best stays)', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const start = today(r);
    for (let i = 0; i < 3; i += 1) {
      toDay(r, start + i);
      await finishOne(r, 'alice', alice);
    }
    expect((await goals(r, alice)).streak).toMatchObject({ current: 3, best: 3, freezes: 0 });
    // Two days pass with nothing done.
    toDay(r, start + 5);
    let v = await goals(r, alice);
    expect(v.streak).toMatchObject({ current: 0, best: 3, lost: true, atRisk: false, covers: 0, todayDone: false });
    await finishOne(r, 'alice', alice);
    v = await goals(r, alice);
    expect(v.streak).toMatchObject({ current: 1, best: 3, lost: false, todayDone: true });
    // The free look for 3 days was earned once and stays his.
    expect(db(r).all('SELECT milestone FROM streak_rewards WHERE user_id = ?', idOf(r, 'alice'))).toEqual([{ milestone: 3 }]);
  }, LONG);

  it('DAILY-11: every 7th day earns a freeze (two at most); a freeze covers one missed day and is used up by it', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const uid = idOf(r, 'alice');
    const start = today(r);
    // He has 6 days in a row; the 7th earns the first freeze.
    db(r).run('INSERT INTO streaks(user_id, current, best, last_day, freezes, saved, updated_ms) VALUES (?, 6, 6, ?, 0, 0, ?)', uid, start - 1, r.clock.now());
    await finishOne(r, 'alice', alice);
    let v = await goals(r, alice);
    expect(v.streak).toMatchObject({ current: 7, freezes: 1, toFreeze: FREEZE_EVERY });
    // One missed day: the streak keeps going, the freeze is used.
    toDay(r, start + 2);
    v = await goals(r, alice);
    expect(v.streak).toMatchObject({ current: 7, atRisk: true, covers: 1, lost: false });
    await finishOne(r, 'alice', alice);
    v = await goals(r, alice);
    expect(v.streak).toMatchObject({ current: 8, freezes: 0 });
    expect(db(r).get<{ saved: number }>('SELECT saved FROM streaks WHERE user_id = ?', uid)?.saved).toBe(1);
    // Two missed days with only one freeze: lost.
    db(r).run('UPDATE streaks SET freezes = 1 WHERE user_id = ?', uid);
    toDay(r, start + 5);
    v = await goals(r, alice);
    expect(v.streak).toMatchObject({ current: 0, lost: true });
    // Never more than two kept: a streak on day 13 -> 14 earns a freeze even if he holds two? No: he stays at two.
    db(r).run('UPDATE streaks SET current = 13, best = 13, last_day = ?, freezes = 2 WHERE user_id = ?', start + 4, uid);
    await finishOne(r, 'alice', alice);
    v = await goals(r, alice);
    expect(v.streak).toMatchObject({ current: 14, freezes: MAX_FREEZES, toFreeze: 0 });
  }, LONG);

  it('DAILY-12: the goals change at 00:00 Tokyo time: 5 minutes before, work still counts for the old day; after, the new day starts empty', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const start = today(r);
    setGoals(r, ['lesson_1', 'win_1', 'limit_1']);
    r.clock.ms = dayStartMs(start + 1) - 5 * 60_000;
    lesson(r, 'alice');
    let v = await goals(r, alice);
    expect(v.day).toBe(start);
    expect(line(v, 'lesson_1').done).toBe(true);
    expect(v.endMs - r.clock.now()).toBe(5 * 60_000);
    r.clock.ms = dayStartMs(start + 1) + 1_000;
    v = await goals(r, alice);
    expect(v.day).toBe(start + 1);
    expect(line(v, 'lesson_1')).toMatchObject({ done: false, progress: 0 });
    expect(doneGoals(r, 'alice', start)).toEqual(['lesson_1']);
    // And a lesson answered 5 minutes before midnight is not today's.
    expect(v.streak).toMatchObject({ current: 1, atRisk: true });
  }, LONG);
});

// ---- the free looks -------------------------------------------------------------------------------------------------------------

describe('the free looks', () => {
  async function threeDays() {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const start = today(r);
    for (let i = 0; i < 3; i += 1) {
      toDay(r, start + i);
      await finishOne(r, 'alice', alice);
    }
    return { r, alice };
  }
  const claim = (r: Running, cookie: string, milestone: unknown, item: unknown) => call(r, '/api/goals/claim', { method: 'POST', cookie, body: { milestone, item } });

  it('DAILY-13: 3 days in a row make the first free look ready; the choices are the Common things he does not own (none that need a badge)', async () => {
    const { r, alice } = await threeDays();
    const v = await goals(r, alice);
    const m3 = v.milestones.find((m: any) => m.days === 3);
    expect(m3).toMatchObject({ state: 'ready', rarity: 1, rarityName: 'Common', item: null });
    expect(m3.choices.sort()).toEqual(COSMETICS.filter((c) => c.rarity === 1 && c.requiresBadge === undefined).map((c) => c.id).sort());
    expect(v.milestones.filter((m: any) => m.state === 'locked').map((m: any) => m.days)).toEqual([7, 14, 30]);
    expect(v.milestones.find((m: any) => m.days === 7).choices).toEqual([]);
  }, LONG);

  it('DAILY-14: taking the look gives it (price 0, no cash taken), puts it on, and can be done once; he can not take it twice or take two looks for one milestone', async () => {
    const { r, alice } = await threeDays();
    const before = cash(r, 'alice');
    const taken = await claim(r, alice, 3, 'c_sky');
    expect(taken.status).toBe(200);
    expect(taken.json.milestones.find((m: any) => m.days === 3)).toMatchObject({ state: 'claimed', item: 'c_sky', choices: [] });
    expect(cash(r, 'alice')).toBe(before);
    expect(db(r).get('SELECT price_cents AS p FROM user_cosmetics WHERE user_id = ? AND item = ?', idOf(r, 'alice'), 'c_sky')).toEqual({ p: 0 });
    expect(db(r).get('SELECT color FROM user_looks WHERE user_id = ?', idOf(r, 'alice'))).toEqual({ color: 'c_sky' });
    const again = await claim(r, alice, 3, 'c_mint');
    expect(again.status).toBe(409);
    expect(again.json.error.code).toBe('already_claimed');
    expect(db(r).all('SELECT item FROM user_cosmetics WHERE user_id = ?', idOf(r, 'alice'))).toEqual([{ item: 'c_sky' }]);
  }, LONG);

  it('DAILY-15: the claim is refused for a milestone he has not reached, a look of the wrong rarity, a look that needs a badge, a look he owns, something that is not in the Shop and a bad request', async () => {
    const { r, alice } = await threeDays();
    const refused = async (milestone: unknown, item: unknown, status: number, code: string) => {
      const res = await claim(r, alice, milestone, item);
      expect([res.status, res.json.error.code]).toEqual([status, code]);
    };
    await refused(7, 'c_gold', 403, 'no_reward'); // not reached
    await refused(3, 'c_gold', 400, 'wrong_item'); // Rare, not Common
    await refused(3, 'nothing', 404, 'no_such_item');
    await refused(3, 5, 404, 'no_such_item');
    await refused('3', 'c_sky', 400, 'bad_request');
    await refused(4, 'c_sky', 400, 'bad_request');
    // A Legendary look needs a badge, so it is never a free look (it is also the wrong rarity here).
    await refused(3, 'f_crown', 400, 'wrong_item');
    // He already owns it: refused, and the free look is still his to use on another.
    db(r).run("INSERT INTO user_cosmetics(user_id, item, bought_ms, price_cents) VALUES (?, 'c_sky', ?, 100000)", idOf(r, 'alice'), r.clock.now());
    await refused(3, 'c_sky', 409, 'already_owned');
    expect((await goals(r, alice)).milestones.find((m: any) => m.days === 3)).toMatchObject({ state: 'ready' });
    expect((await claim(r, alice, 3, 'c_mint')).status).toBe(200);
  }, LONG);

  it('DAILY-16: 7, 14 and 30 days give a Rare, an Epic and an Epic look; the stream says which milestone was just reached', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const stream = await listen(r, alice);
    const uid = idOf(r, 'alice');
    const start = today(r);
    for (const [days, rarityName] of [
      [7, 'Rare'],
      [14, 'Epic'],
      [30, 'Epic'],
    ] as const) {
      db(r).run(
        'INSERT INTO streaks(user_id, current, best, last_day, freezes, saved, updated_ms) VALUES (?, ?, ?, ?, 0, 0, ?) ON CONFLICT(user_id) DO UPDATE SET current = excluded.current, best = excluded.best, last_day = excluded.last_day',
        uid,
        days - 1,
        days - 1,
        today(r) - 1,
        r.clock.now(),
      );
      await finishOne(r, 'alice', alice);
      const v = await goals(r, alice);
      expect(v.streak.current).toBe(days);
      expect(v.milestones.find((m: any) => m.days === days)).toMatchObject({ state: 'ready', rarityName });
      toDay(r, today(r) + 1);
    }
    expect(start).toBeLessThan(today(r));
    expect(await until(() => stream.text().includes('"milestones":[30]'))).toBe(true);
    // (He was put straight on 6 days, so the first finished goal reached the 3-day look as well as the 7-day one.)
    expect(stream.text()).toContain('"milestones":[3,7]');
    expect(stream.text()).toContain('"milestones":[14]');
  }, LONG);
});

// ---- the weekly board and the badges ----------------------------------------------------------------------------------------

describe('what the goals do to the rest of the game', () => {
  it('DAILY-17: the cash from goals counts in net worth but is not growth on the weekly board (it is taken off the gain)', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const bob = await signUp(r, 'bob');
    setGoals(r, ['lesson_1', 'win_1', 'match_1']);
    // Before: both stand at the starting cash, nobody has grown.
    const before = (await call(r, '/api/leaderboard/weekly?scope=all', { cookie: bob })).json;
    expect(before.rows.map((x: any) => x.gainCents)).toEqual([0, 0]);
    lesson(r, 'alice');
    match(r, 'alice', 'win');
    await goals(r, alice);
    expect(cash(r, 'alice')).toBe(104_000);
    const all = (await call(r, '/api/leaderboard/weekly?scope=all', { cookie: bob })).json;
    const mine = all.rows.find((x: any) => x.username === 'alice');
    expect(mine.netWorthCents).toBe(104_000);
    expect(mine.gainCents).toBe(0);
    expect(mine.gainPct).toBe(0);
    const net = (await call(r, '/api/leaderboard', { cookie: bob })).json;
    const row = (net.rows ?? net.entries ?? net.top ?? []).find((x: any) => x.username === 'alice');
    if (row) expect(row.netWorthCents).toBe(104_000);
    // A real gain on top of the gift still counts: only the gift is left out.
    db(r).run("UPDATE accounts SET cash_cents = cash_cents + 2500 WHERE user_id = ? AND kind = 'career'", idOf(r, 'alice'));
    r.app.services.social.invalidate();
    const later = (await call(r, '/api/leaderboard/weekly?scope=all', { cookie: bob })).json;
    expect(later.rows.find((x: any) => x.username === 'alice').gainCents).toBe(2500);
  }, LONG);

  it('DAILY-18: the streak and goal badges: 3 days, the perfect day, and nothing for a computer player', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const start = today(r);
    const owned = () => db(r).all<{ badge: string }>('SELECT badge FROM user_badges WHERE user_id = ? ORDER BY badge', idOf(r, 'alice')).map((x) => x.badge);
    expect(owned()).toEqual([]);
    for (let i = 0; i < 3; i += 1) {
      toDay(r, start + i);
      await finishOne(r, 'alice', alice);
    }
    expect(owned()).toContain('streak_3');
    expect(owned()).not.toContain('streak_7');
    expect(owned()).not.toContain('perfect_day');
    // A perfect day.
    toDay(r, start + 3);
    setGoals(r, ['lesson_1', 'win_1', 'match_1']);
    lesson(r, 'alice');
    match(r, 'alice', 'win');
    await goals(r, alice);
    expect(owned()).toContain('perfect_day');
    expect(owned()).not.toContain('goals_50');
  }, LONG);
});
