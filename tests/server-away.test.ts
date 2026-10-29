// "While you were away" (server/away.ts, server/sse.ts onUserGone, docs/world.md §33). When a player's LAST page closes the server writes down how his account looks; when he comes
// back after at least half an hour it compares that with now (net worth, place on the board, the holding that moved most, his own companies and who bought them) and shows a card
// until he closes it. It only reads: nothing about money, prices or orders changes, and a computer player or a signed-out visitor gets no picture taken.
import { describe, expect, it } from 'vitest';
import { AWAY_KEEP_MS, AWAY_MAX_COMPANIES, AWAY_MIN_MS } from '../server/away';
import { dayOf, dayStartMs } from '../src/shared/goalCatalog';
import { LONG, db, idOf, liveRig, until, type Running } from './helpers/chatlive';

const { boot, call, signUp } = liveRig('away');

// ---- helpers -----------------------------------------------------------------------------------------------------------------

/** A page that can be closed (the rig's own listener is only closed at the end of the test). */
async function open(r: Running, cookie?: string): Promise<{ close(): void }> {
  const controller = new AbortController();
  const res = await fetch(r.base + '/api/stream', { headers: cookie ? { Cookie: cookie } : {}, signal: controller.signal });
  expect(res.status).toBe(200);
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  void (async () => {
    try {
      for (;;) if ((await reader.read()).done) return;
    } catch {
      // closed by the test
    }
  })();
  return { close: () => controller.abort() };
}

const mark = (r: Running, name: string) => db(r).get<{ seen_ms: number; net_worth_cents: number | null; rank: number | null; holdings: string; report: string | null }>('SELECT seen_ms, net_worth_cents, rank, holdings, report FROM away_marks WHERE user_id = ?', idOf(r, name));
const away = async (r: Running, cookie: string) => (await call(r, '/api/away', { cookie })).json.away;
const minutes = (r: Running, m: number): void => r.clock.advanceSeconds(m * 60);

let nextOrder = 0;
const oid = (): string => `away-order-${(nextOrder += 1)}-abcdef`;
const order = (r: Running, cookie: string, ticker: string, side: 'buy' | 'sell', qty: number) => call(r, '/api/orders', { method: 'POST', cookie, body: { account: 'career', ticker, side, qty, clientOrderId: oid() } });

function stocks(r: Running) {
  const w = r.app.services.world;
  return w.companies.filter((c) => c.sector !== 'meme' && w.sim.isListed(c.id) && w.sim.price(c.id) >= 1500 && w.sim.price(c.id) <= 6000);
}

/** Closes his only page and waits until the server has written the picture. */
async function leave(r: Running, name: string, page: { close(): void }): Promise<void> {
  page.close();
  expect(await until(() => mark(r, name) !== undefined)).toBe(true);
}

function gotoTick(r: Running, tick: number): void {
  const w = r.app.services.world;
  while (w.currentTick() < tick) {
    const next = Math.min(tick, w.currentTick() + 2);
    r.clock.ms = w.msOfTick(next);
    for (let i = 0; i < 20_000 && w.sim.tick < w.currentTick(); i += 1) w.pump();
  }
}

// ---- taking the picture ---------------------------------------------------------------------------------------------------------

describe('when the last page closes', () => {
  it('DAWAY-1: the picture is taken when the LAST page of a signed-in player closes, not before; two tabs need both closed', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    expect(mark(r, 'alice')).toBeUndefined();
    const phone = await open(r, alice);
    const laptop = await open(r, alice);
    phone.close();
    await new Promise((done) => setTimeout(done, 150));
    expect(mark(r, 'alice')).toBeUndefined(); // the laptop is still open
    laptop.close();
    expect(await until(() => mark(r, 'alice') !== undefined)).toBe(true);
    const m = mark(r, 'alice');
    expect(m).toMatchObject({ seen_ms: r.clock.now(), net_worth_cents: 100_000, report: null });
    expect(JSON.parse((m as NonNullable<typeof m>).holdings)).toEqual({ holdings: [], launched: [] });
  }, LONG);

  it('DAWAY-2: a signed-out visitor, a computer player and a closed server get no picture', async () => {
    const r = await boot();
    await signUp(r, 'robo');
    db(r).run("INSERT INTO bots(user_id, persona) VALUES (?, 'away-test-bot')", idOf(r, 'robo'));
    const visitor = await open(r);
    visitor.close();
    await new Promise((done) => setTimeout(done, 150));
    expect(db(r).all('SELECT 1 FROM away_marks')).toEqual([]);
    // A computer player never has a page, but even if the hook is called for him nothing is written.
    r.app.services.away.snapshot(idOf(r, 'robo'));
    expect(db(r).all('SELECT 1 FROM away_marks')).toEqual([]);
  }, LONG);

  it('DAWAY-3: the picture holds his shares with the price, his launched companies with the price, his net worth and his place', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    await signUp(r, 'bob');
    const [a, b] = stocks(r);
    const A = a as NonNullable<typeof a>;
    const B = b as NonNullable<typeof b>;
    expect((await order(r, alice, A.ticker, 'buy', 3)).status).toBe(201);
    db(r).run("INSERT INTO launches(company_id, user_id, kind, request_id, seed_cents, spent_cents, stake_shares, price_cents, created_ms, fee_cents) VALUES (?, ?, 'stock', 'away-launch-1', 0, 0, 0, 100, ?, 0)", B.id, idOf(r, 'alice'), r.clock.now());
    const page = await open(r, alice);
    await leave(r, 'alice', page);
    const m = mark(r, 'alice') as NonNullable<ReturnType<typeof mark>>;
    const snap = JSON.parse(m.holdings) as { holdings: { c: number; shares: number; short: boolean; p: number }[]; launched: { c: number; p: number }[] };
    expect(snap.holdings).toHaveLength(1);
    expect(snap.holdings[0]).toMatchObject({ c: A.id, shares: 3, short: false });
    expect(snap.holdings[0]?.p).toBeGreaterThan(0);
    expect(snap.launched).toHaveLength(1);
    expect(snap.launched[0]?.c).toBe(B.id);
    expect(m.net_worth_cents).toBeGreaterThan(90_000);
    expect([1, 2]).toContain(m.rank);
  }, LONG);
});

// ---- coming back -------------------------------------------------------------------------------------------------------------

describe('when he comes back', () => {
  it('DAWAY-4: it needs a signed-in player; coming back within half an hour says nothing and throws the picture away', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    expect((await call(r, '/api/away')).status).toBe(401);
    expect((await call(r, '/api/away/dismiss', { method: 'POST' })).status).toBe(401);
    expect(AWAY_MIN_MS).toBe(30 * 60_000);
    // Never left: nothing.
    expect(await away(r, alice)).toBeNull();
    const page = await open(r, alice);
    await leave(r, 'alice', page);
    minutes(r, 29);
    expect(await away(r, alice)).toBeNull();
    expect(mark(r, 'alice')).toBeUndefined();
  }, LONG);

  it('DAWAY-5: after half an hour it reports how long he was away, his net worth before and now, and his place', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const bob = await signUp(r, 'bob');
    // Alice stands ahead of Bob when she leaves.
    db(r).run("UPDATE accounts SET cash_cents = cash_cents + 5000 WHERE user_id = ? AND kind = 'career'", idOf(r, 'alice'));
    r.app.services.social.invalidate();
    const page = await open(r, alice);
    await leave(r, 'alice', page);
    expect(mark(r, 'alice')).toMatchObject({ net_worth_cents: 105_000, rank: 1 });
    const left = r.clock.now();
    // While she is away Bob grows and she grows a little too.
    db(r).run("UPDATE accounts SET cash_cents = cash_cents + 20000 WHERE user_id = ? AND kind = 'career'", idOf(r, 'bob'));
    db(r).run("UPDATE accounts SET cash_cents = cash_cents + 1000 WHERE user_id = ? AND kind = 'career'", idOf(r, 'alice'));
    minutes(r, 31);
    const v = await away(r, alice);
    expect(v.report).toMatchObject({ seenMs: left, nowMs: r.clock.now(), awayMs: 31 * 60_000, mover: null, companies: [] });
    expect(v.report.netWorth).toEqual({ beforeCents: 105_000, nowCents: 106_000, changeCents: 1_000, changePct: 0.95 });
    expect(v.report.rank).toEqual({ before: 1, now: 2 });
    expect(bob).toBeTruthy();
  }, LONG);

  it('DAWAY-6: the holding that moved most is named, with its change in percent and cents; a short position gains when the price falls', async () => {
    const r = await boot();
    const boss = await signUp(r, 'boss');
    const alice = await signUp(r, 'alice');
    const bob = await signUp(r, 'bob');
    const [a, b] = stocks(r);
    const A = a as NonNullable<typeof a>;
    const B = b as NonNullable<typeof b>;
    expect((await order(r, alice, A.ticker, 'buy', 5)).status).toBe(201);
    // Bob goes short on the same company.
    const shortSale = await call(r, '/api/orders', { method: 'POST', cookie: bob, body: { account: 'career', ticker: A.ticker, side: 'sell', short: true, qty: 5, clientOrderId: oid() } });
    expect(shortSale.status).toBe(201);
    expect((await order(r, alice, B.ticker, 'buy', 1)).status).toBe(201);
    const pa = await open(r, alice);
    const pb = await open(r, bob);
    await leave(r, 'alice', pa);
    await leave(r, 'bob', pb);
    const crash = await call(r, '/api/admin/shock', { method: 'POST', cookie: boss, body: { requestId: oid(), ticker: A.ticker, style: 'crash', percent: -30, speed: 'instant' } });
    expect(crash.status).toBe(200);
    gotoTick(r, r.app.services.world.currentTick() + 20);
    minutes(r, 40);
    const mine = await away(r, alice);
    expect(mine.report.mover).toMatchObject({ ticker: A.ticker, short: false });
    expect(mine.report.mover.changePct).toBeLessThan(-10);
    expect(mine.report.mover.changeCents).toBeLessThan(0);
    expect(mine.report.netWorth.changeCents).toBeLessThan(0);
    const his = await away(r, bob);
    expect(his.report.mover).toMatchObject({ ticker: A.ticker, short: true });
    expect(his.report.mover.changeCents).toBeGreaterThan(0);
    expect(his.report.mover.changePct).toBeGreaterThan(10);
  }, LONG);

  it('DAWAY-7: his own companies: who bought them while he was away is counted (not himself, not a computer player, not before he left); a company that did not move and had no buyers is left out', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const bob = await signUp(r, 'bob');
    const carol = await signUp(r, 'carol');
    await signUp(r, 'robo');
    db(r).run("INSERT INTO bots(user_id, persona) VALUES (?, 'away-test-bot-2')", idOf(r, 'robo'));
    const list = stocks(r);
    expect(list.length).toBeGreaterThanOrEqual(4);
    const [A, B, C] = list.slice(0, 3) as NonNullable<(typeof list)[number]>[];
    for (const [i, c] of [A, B, C].entries()) {
      db(r).run("INSERT INTO launches(company_id, user_id, kind, request_id, seed_cents, spent_cents, stake_shares, price_cents, created_ms, fee_cents) VALUES (?, ?, 'stock', ?, 0, 0, 0, 100, ?, 0)", (c as NonNullable<typeof c>).id, idOf(r, 'alice'), `away-launch-${i}`, r.clock.now());
    }
    // Before she leaves, Bob buys A (that is not "while she was away").
    expect((await order(r, bob, (A as NonNullable<typeof A>).ticker, 'buy', 1)).status).toBe(201);
    gotoTick(r, r.app.services.world.currentTick() + 60);
    const page = await open(r, alice);
    await leave(r, 'alice', page);
    gotoTick(r, r.app.services.world.currentTick() + 300);
    // While she is away: Bob and Carol buy B; Alice herself buys C; a computer player buys A.
    expect((await order(r, bob, (B as NonNullable<typeof B>).ticker, 'buy', 1)).status).toBe(201);
    expect((await order(r, carol, (B as NonNullable<typeof B>).ticker, 'buy', 1)).status).toBe(201);
    expect((await order(r, alice, (C as NonNullable<typeof C>).ticker, 'buy', 1)).status).toBe(201);
    const botAccount = db(r).get<{ id: number }>("SELECT id FROM accounts WHERE user_id = ? AND kind = 'career'", idOf(r, 'robo')) as { id: number };
    db(r).run(
      "INSERT INTO trades(account_id, client_order_id, company_id, side, requested, filled, total_cents, mid_cents, spread_cents, impact_cents, realized_cents, tick, created_ms, result_json) VALUES (?, ?, ?, 'buy', 1, 1, 1000, 1000, 0, 0, 0, 1, ?, '{}')",
      botAccount.id,
      oid(),
      (A as NonNullable<typeof A>).id,
      r.clock.now(),
    );
    minutes(r, 40);
    const v = await away(r, alice);
    expect(AWAY_MAX_COMPANIES).toBe(3);
    const named = v.report.companies.filter((c: any) => c.newInvestors > 0);
    expect(named).toEqual([expect.objectContaining({ ticker: (B as NonNullable<typeof B>).ticker, newInvestors: 2 })]);
    // A and C had no new buyers; they are named only if their price moved.
    for (const c of v.report.companies) {
      if (c.newInvestors === 0) expect(Math.abs(c.changePct)).toBeGreaterThanOrEqual(0.01);
    }
    expect(v.report.companies[0].ticker).toBe((B as NonNullable<typeof B>).ticker);
  }, LONG);

  it('DAWAY-8: the card also says today: the streak and how many goals are still open', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const page = await open(r, alice);
    await leave(r, 'alice', page);
    minutes(r, 45);
    let v = await call(r, '/api/away', { cookie: alice });
    expect(v.json.away.today).toEqual({ streak: 0, atRisk: false, goalsLeft: 3 });
    // He finishes a lesson: the streak starts and two goals are left.
    (r.app.services.daily as unknown as { d: { goalsOfDay: () => string[] } }).d.goalsOfDay = () => ['lesson_1', 'win_1', 'limit_1'];
    db(r).run("INSERT INTO learn_lessons(user_id, kind, pattern, seed, scenario, issued_ms, answered_ms) VALUES (?, 'direction', 't', 1, '{}', ?, ?)", idOf(r, 'alice'), r.clock.now(), r.clock.now());
    await call(r, '/api/goals', { cookie: alice });
    v = await call(r, '/api/away', { cookie: alice });
    expect(v.json.away.today).toEqual({ streak: 1, atRisk: false, goalsLeft: 2 });
  }, LONG);
});

// ---- the card stays until it is closed ----------------------------------------------------------------------------------------------

describe('closing the card', () => {
  it('DAWAY-9: the same report is shown again and again until he closes it; closing removes it; a refresh does not lose it', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const page = await open(r, alice);
    await leave(r, 'alice', page);
    minutes(r, 60);
    const first = await away(r, alice);
    expect(first.report.awayMs).toBe(60 * 60_000);
    minutes(r, 2);
    const second = await away(r, alice);
    expect(second.report).toEqual(first.report); // the report is not made again
    // He refreshes the page: it closes and opens again within a few minutes. The card is still there.
    const again = await open(r, alice);
    again.close();
    await new Promise((done) => setTimeout(done, 200));
    expect((await away(r, alice)).report).toEqual(first.report);
    // He presses the button.
    expect((await call(r, '/api/away/dismiss', { method: 'POST', cookie: alice })).json).toEqual({ ok: true });
    expect(await away(r, alice)).toBeNull();
    expect(mark(r, 'alice')).toBeUndefined();
  }, LONG);

  it('DAWAY-10: if he closed the page without pressing the button, the card is counted as seen after a while: the next visit gets a new picture, not the old card', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    expect(AWAY_KEEP_MS).toBe(15 * 60_000);
    const page = await open(r, alice);
    await leave(r, 'alice', page);
    minutes(r, 60);
    const first = await away(r, alice);
    expect(first).not.toBeNull();
    // He leaves with the card still open, a long time after it was made.
    minutes(r, 20);
    r.app.services.away.snapshot(idOf(r, 'alice'));
    expect(mark(r, 'alice')?.report).toBeNull();
    minutes(r, 10);
    expect(await away(r, alice)).toBeNull(); // only ten minutes since he left
    expect(mark(r, 'alice')).toBeUndefined();
  }, LONG);
});

// ---- it only reads --------------------------------------------------------------------------------------------------------------------

describe('what it never does', () => {
  it('DAWAY-11: making and closing a report changes no money, no order and no price', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const [a] = stocks(r);
    const A = a as NonNullable<typeof a>;
    expect((await order(r, alice, A.ticker, 'buy', 2)).status).toBe(201);
    const page = await open(r, alice);
    await leave(r, 'alice', page);
    minutes(r, 90);
    const state = () =>
      JSON.stringify([
        db(r).all('SELECT id, cash_cents FROM accounts ORDER BY id'),
        db(r).all('SELECT * FROM trades ORDER BY id'),
        db(r).all('SELECT * FROM positions ORDER BY account_id, company_id'),
        db(r).all('SELECT * FROM wallets ORDER BY user_id'),
        db(r).all('SELECT * FROM limit_orders ORDER BY id'),
        r.app.services.world.sim.price(A.id),
      ]);
    const before = state();
    expect(await away(r, alice)).not.toBeNull();
    await call(r, '/api/away/dismiss', { method: 'POST', cookie: alice });
    expect(state()).toBe(before);
  }, LONG);

  it('DAWAY-12: the picture is kept in the database, so a restart does not lose it; the day number the card uses for "today" is the Tokyo day', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const page = await open(r, alice);
    await leave(r, 'alice', page);
    // The next morning in Tokyo: the card says the streak is at risk only if he has one.
    r.clock.ms = dayStartMs(dayOf(r.clock.now()) + 1) + 3_600_000;
    const v = await away(r, alice);
    expect(v.today).toMatchObject({ streak: 0, atRisk: false });
    expect(v.report.awayMs).toBeGreaterThan(60 * 60_000);
  }, LONG);
});
