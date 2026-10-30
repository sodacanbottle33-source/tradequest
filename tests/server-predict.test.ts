// The daily prediction (server/predict.ts, server/routes/predict.ts, docs/world.md §38). Every Tokyo day one stock is featured, the same for everybody. A player says once whether its price
// will be higher or lower when the day ends. A right guess pays the same as one daily goal; a wrong one costs nothing; a draw (same price, or judged much too late) pays nothing.
import { describe, expect, it } from 'vitest';
import { DAY_MS, GOAL_REWARD, dayOf, dayStartMs } from '../src/shared/goalCatalog';
import { LATE_MS, PREDICT_REWARD } from '../server/predict';
import { LONG, db, idOf, liveRig, until, type Running } from './helpers/chatlive';

const { boot, call, signUp, listen } = liveRig('predict');

const post = (r: Running, path: string, cookie: string | undefined, body?: unknown) => call(r, path, { method: 'POST', cookie, body: body ?? {} });
const view = async (r: Running, cookie: string) => (await call(r, '/api/predict', { cookie })).json;
const pick = (r: Running, cookie: string, value: unknown) => post(r, '/api/predict/pick', cookie, { pick: value });
const today = (r: Running): number => dayOf(r.clock.now());
/** The clock a minute into a later day. */
const toDay = (r: Running, day: number, afterMs = 60_000): void => {
  r.clock.ms = dayStartMs(day) + afterMs;
};
const cash = (r: Running, name: string): number => (db(r).get('SELECT cash_cents AS c FROM accounts WHERE kind = ? AND user_id = ?', 'career', idOf(r, name)) as { c: number }).c;
const coins = (r: Running, name: string): number => db(r).get<{ b: number }>('SELECT balance_cents AS b FROM wallets WHERE user_id = ?', idOf(r, name))?.b ?? 0;
const xp = (r: Running, name: string): number => db(r).get<{ x: number }>('SELECT xp AS x FROM learn_progress WHERE user_id = ?', idOf(r, name))?.x ?? 0;
/** Makes a pick that is already made look as if the price had been `units` when it was made. */
const setFrom = (r: Running, name: string, day: number, units: number): void => {
  db(r).run('UPDATE predictions SET price_from = ? WHERE user_id = ? AND day = ?', units, idOf(r, name), day);
};
const stored = (r: Running, name: string, day: number) => db(r).get<{ result: string | null; price_to: number | null; price_from: number; judged_ms: number | null }>('SELECT result, price_to, price_from, judged_ms FROM predictions WHERE user_id = ? AND day = ?', idOf(r, name), day);

describe('the featured stock', () => {
  it('PRED-1: only a signed-in player can look; the view shows today\'s stock with its price, no guess yet, no record, and what a right guess pays', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    expect((await call(r, '/api/predict')).status).toBe(401);
    expect((await post(r, '/api/predict/pick', undefined, { pick: 'up' })).status).toBe(401);
    const v = await view(r, alice);
    const day = today(r);
    expect(v).toMatchObject({ day, endMs: dayStartMs(day) + DAY_MS, serverMs: r.clock.now(), mine: null, last: null, stats: { made: 0, correct: 0, run: 0, bestRun: 0 }, reward: GOAL_REWARD });
    expect(PREDICT_REWARD).toEqual(GOAL_REWARD);
    expect(Number.isInteger(v.company.id)).toBe(true);
    expect(typeof v.company.ticker).toBe('string');
    expect(typeof v.company.name).toBe('string');
    expect(v.company.priceCents).toBeGreaterThan(0);
  }, LONG);

  it('PRED-2: everybody gets the same stock; it is kept for the day; it is never a memecoin, a launched stock or a bankrupt one; the next day it is a different one', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const bob = await signUp(r, 'bob');
    const day = today(r);
    const a = (await view(r, alice)).company;
    expect((await view(r, bob)).company).toEqual(a);
    r.clock.ms += 2 * 3_600_000; // later the same day (it is 21:00 in Tokyo when the test clock starts)
    expect((await view(r, alice)).company.id).toBe(a.id);
    expect(db(r).get('SELECT company_id FROM predict_days WHERE day = ?', day)).toEqual({ company_id: a.id });
    // The choice is made from real stocks only.
    const world = r.app.services.world;
    expect(world.companies[a.id]?.sector).not.toBe('meme');
    const seen = new Set<number>();
    let last = a.id as number;
    for (let i = 1; i <= 12; i += 1) {
      toDay(r, day + i, 3_600_000);
      const id = (await view(r, alice)).company.id as number;
      expect(id, `day +${i}`).not.toBe(last);
      expect(world.companies[id]?.sector).not.toBe('meme');
      last = id;
      seen.add(id);
    }
    expect(seen.size).toBeGreaterThan(3); // it moves around
  }, LONG);

  it('PRED-3: a company that a player launched is never featured', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const world = r.app.services.world;
    const day = today(r);
    // Mark every stock but one as launched or bankrupt: the one left is the only choice, then the same one the next day (nothing else to pick).
    const stocks = world.companies.filter((c) => c.sector !== 'meme');
    const keep = stocks[0] as (typeof stocks)[number];
    db(r).run("INSERT INTO users(username, display_name, pw_hash, created_ms, role) VALUES ('founder', 'founder', 'x', 0, 'player')");
    const founder = idOf(r, 'founder');
    stocks.slice(1, 4).forEach((c, i) => {
      db(r).run("INSERT INTO launches(company_id, user_id, kind, request_id, seed_cents, spent_cents, stake_shares, price_cents, created_ms, fee_cents) VALUES (?, ?, 'stock', ?, 100, 100, 1, 100, 0, 0)", c.id, founder, `req-${i}`);
    });
    stocks.slice(4).forEach((c) => {
      db(r).run('INSERT INTO bankruptcies(company_id, declared_tick, declared_ms, cycle, negative_stories, window_total, price_before_cents) VALUES (?, 1, 1, 1, 1, 1, 100)', c.id);
    });
    const v = await view(r, alice);
    expect(v.company.id).toBe(keep.id);
    toDay(r, day + 1, 3_600_000);
    expect((await view(r, alice)).company.id).toBe(keep.id); // the only one that can be featured, so the same two days running is allowed
  }, LONG);

  it('PRED-4: with nothing to feature the view has no stock, the Goals count is not raised and a guess is refused', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    (r.app.services.predict as unknown as { d: { companyOfDay: () => number | null } }).d.companyOfDay = () => null;
    const v = await view(r, alice);
    expect(v.company).toBeNull();
    expect(r.app.services.predict.open(idOf(r, 'alice'))).toBe(false);
    const refused = await pick(r, alice, 'up');
    expect([refused.status, refused.json.error.code]).toEqual([409, 'no_company']);
  }, LONG);
});

describe('making a guess', () => {
  it('PRED-5: a guess of up or down is kept with the price he saw; it can be made once and not changed; anything else is a 400', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const id = idOf(r, 'alice');
    expect(r.app.services.predict.open(id)).toBe(true);
    for (const bad of ['sideways', 'UP', 1, true, null, undefined]) expect((await pick(r, alice, bad)).status, String(bad)).toBe(400);
    const before = await view(r, alice);
    const made = await pick(r, alice, 'up');
    expect(made.status).toBe(200);
    expect(made.json.mine).toEqual({ pick: 'up', priceFromCents: before.company.priceCents, pickedMs: r.clock.now() });
    expect(r.app.services.predict.open(id)).toBe(false);
    const again = await pick(r, alice, 'down');
    expect([again.status, again.json.error.code]).toEqual([409, 'already_picked']);
    expect((await view(r, alice)).mine.pick).toBe('up');
    expect(db(r).get('SELECT COUNT(*) AS n FROM predictions WHERE user_id = ?', id)).toEqual({ n: 1 });
    // Another player is not affected.
    const bob = await signUp(r, 'bob');
    expect((await view(r, bob)).mine).toBeNull();
    expect((await pick(r, bob, 'down')).json.mine.pick).toBe('down');
  }, LONG);

  it('PRED-6: a computer player does not make guesses and is never counted as having one to make', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    db(r).run("INSERT INTO bots(user_id, persona) VALUES (?, 'test-persona')", idOf(r, 'alice'));
    expect(r.app.services.predict.open(idOf(r, 'alice'))).toBe(false);
    const refused = await pick(r, alice, 'up');
    expect([refused.status, refused.json.error.code]).toEqual([403, 'cannot_play']);
  }, LONG);

  it('PRED-7: a flood of tries is slowed down', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    let limited = 0;
    for (let i = 0; i < 14; i += 1) if ((await pick(r, alice, 'nonsense')).status === 429) limited += 1;
    expect(limited).toBe(4);
  }, LONG);
});

describe('judging', () => {
  it('PRED-8: a right guess pays one daily goal (Learn XP, Career cash, 1v1 coins), is written in the cash gifts, and the player is told; the next day shows how it went', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const day = today(r);
    const watching = await listen(r, alice);
    const mine = await pick(r, alice, 'up');
    const ticker = mine.json.company.ticker as string;
    setFrom(r, 'alice', day, 1); // the price was tiny, so it is higher now
    const [cash0, coins0, xp0] = [cash(r, 'alice'), coins(r, 'alice'), xp(r, 'alice')];
    // Nothing is paid until the day is over.
    expect(r.app.services.predict.sweep()).toBe(0);
    expect(stored(r, 'alice', day)?.result).toBeNull();
    toDay(r, day + 1);
    const v = await view(r, alice); // asking is enough: the page judges yesterday first
    expect(stored(r, 'alice', day)).toMatchObject({ result: 'win' });
    expect(stored(r, 'alice', day)?.price_to).toBeGreaterThan(1);
    expect(cash(r, 'alice') - cash0).toBe(GOAL_REWARD.cashCents);
    expect(coins(r, 'alice') - coins0).toBe(GOAL_REWARD.coinCents);
    expect(xp(r, 'alice') - xp0).toBe(GOAL_REWARD.xp);
    expect(db(r).get('SELECT cents, reason FROM cash_gifts WHERE user_id = ?', idOf(r, 'alice'))).toEqual({ cents: GOAL_REWARD.cashCents, reason: 'daily prediction' });
    expect(db(r).get('SELECT reason FROM wallet_ledger WHERE user_id = ? AND reason = ?', idOf(r, 'alice'), 'prediction')).toEqual({ reason: 'prediction' });
    expect(v.mine).toBeNull(); // a new day, a new guess
    expect(v.last).toMatchObject({ day, ticker, pick: 'up', result: 'win' });
    expect(v.last.priceToCents).toBeGreaterThan(0);
    expect(v.stats).toEqual({ made: 1, correct: 1, run: 1, bestRun: 1 });
    expect(await until(() => watching.text().includes('event: predicted'))).toBe(true);
    expect(watching.text()).toContain(`"ticker":"${ticker}"`);
    expect(watching.text()).toContain('"result":"win"');
    // Judging again pays nothing more.
    expect(r.app.services.predict.sweep()).toBe(0);
    expect(cash(r, 'alice') - cash0).toBe(GOAL_REWARD.cashCents);
    // A right guess earns the first prediction badge.
    expect(db(r).get('SELECT badge FROM user_badges WHERE user_id = ? AND badge = ?', idOf(r, 'alice'), 'predict_1')).toEqual({ badge: 'predict_1' });
  }, LONG);

  it('PRED-9: a wrong guess costs and pays nothing; a down guess is right when the price fell; wins after a loss start a new run', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const start = today(r);
    const cash0 = cash(r, 'alice');
    // Day 1: down, but the price rose -> loss.
    await pick(r, alice, 'down');
    setFrom(r, 'alice', start, 1);
    toDay(r, start + 1);
    expect((await view(r, alice)).last).toMatchObject({ result: 'loss' });
    expect(cash(r, 'alice')).toBe(cash0);
    expect(coins(r, 'alice')).toBe(0);
    expect(db(r).get('SELECT COUNT(*) AS n FROM cash_gifts')).toEqual({ n: 0 });
    // Day 2: down and the price fell -> win; day 3: up and it rose -> win.
    await pick(r, alice, 'down');
    setFrom(r, 'alice', start + 1, 1_000_000_000_000);
    toDay(r, start + 2);
    expect((await view(r, alice)).last).toMatchObject({ day: start + 1, result: 'win' });
    await pick(r, alice, 'up');
    setFrom(r, 'alice', start + 2, 1);
    toDay(r, start + 3);
    const v = await view(r, alice);
    expect(v.last).toMatchObject({ day: start + 2, result: 'win' });
    expect(v.stats).toEqual({ made: 3, correct: 2, run: 2, bestRun: 2 });
    expect(cash(r, 'alice') - cash0).toBe(2 * GOAL_REWARD.cashCents);
  }, LONG);

  it('PRED-10: the same price is a draw: nothing is paid and the record is not changed (a draw neither adds to a run nor breaks it)', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const start = today(r);
    const id = idOf(r, 'alice');
    // win, draw, win -> a run of 2.
    await pick(r, alice, 'up');
    setFrom(r, 'alice', start, 1);
    toDay(r, start + 1);
    await view(r, alice);
    await pick(r, alice, 'up');
    const company = db(r).get<{ company_id: number }>('SELECT company_id FROM predictions WHERE user_id = ? AND day = ?', id, start + 1)?.company_id as number;
    setFrom(r, 'alice', start + 1, r.app.services.world.sim.price(company));
    toDay(r, start + 2);
    const v2 = await view(r, alice);
    expect(v2.last).toMatchObject({ day: start + 1, result: 'draw' });
    expect(stored(r, 'alice', start + 1)?.price_to).toBe(stored(r, 'alice', start + 1)?.price_from);
    expect(v2.stats).toEqual({ made: 1, correct: 1, run: 1, bestRun: 1 });
    await pick(r, alice, 'up');
    setFrom(r, 'alice', start + 2, 1);
    toDay(r, start + 3);
    expect((await view(r, alice)).stats).toEqual({ made: 2, correct: 2, run: 2, bestRun: 2 });
    expect(db(r).get('SELECT COUNT(*) AS n FROM cash_gifts WHERE user_id = ?', id)).toEqual({ n: 2 });
    // The badge for three in a row is not there yet, the one for the first right guess is.
    const badges = db(r).all<{ badge: string }>("SELECT badge FROM user_badges WHERE user_id = ? AND badge LIKE 'predict%' ORDER BY badge", id).map((b) => b.badge);
    expect(badges).toEqual(['predict_1']);
  }, LONG);

  it('PRED-11: a day that is judged much too late (the server was off) is a draw for everybody, whatever the price did', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const start = today(r);
    await pick(r, alice, 'up');
    setFrom(r, 'alice', start, 1);
    const cash0 = cash(r, 'alice');
    r.clock.ms = dayStartMs(start + 1) + LATE_MS + 60_000;
    expect(r.app.services.predict.sweep()).toBe(1);
    expect(stored(r, 'alice', start)).toMatchObject({ result: 'draw', price_to: null });
    expect(cash(r, 'alice')).toBe(cash0);
    // Within the allowed delay it is judged as usual.
    const bob = await signUp(r, 'bob');
    await pick(r, bob, 'up');
    setFrom(r, 'bob', today(r), 1);
    r.clock.ms = dayStartMs(today(r) + 1) + LATE_MS - 60_000;
    r.app.services.predict.sweep();
    expect(stored(r, 'bob', today(r) - 1)?.result).toBe('win');
  }, LONG);

  it('PRED-12: three right guesses in a row earn Hot Hand; a loss in between stops the run; the badges say so', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const id = idOf(r, 'alice');
    const start = today(r);
    const results: ('up' | 'down')[] = ['up', 'up', 'down', 'up', 'up', 'up'];
    // Day 3 is wrong on purpose (price rose, guess down), so the run restarts after it.
    for (let i = 0; i < results.length; i += 1) {
      await pick(r, alice, results[i]);
      setFrom(r, 'alice', start + i, 1); // the price rose every day, so a guess of down is wrong
      toDay(r, start + i + 1);
      await view(r, alice);
    }
    const run = (await view(r, alice)).stats;
    expect(run).toEqual({ made: 6, correct: 5, run: 3, bestRun: 3 });
    const badges = db(r).all<{ badge: string }>("SELECT badge FROM user_badges WHERE user_id = ? AND badge LIKE 'predict%' ORDER BY badge", id).map((b) => b.badge);
    expect(badges).toEqual(['predict_1', 'predict_run_3']);
  }, LONG);
});
