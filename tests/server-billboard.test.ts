// The billboard (server/billboard.ts, server/routes/billboard.ts, src/shared/billboardCatalog.ts, docs/world.md §30): three places at the top of the Market and Memecoins tabs
// where a player can show a company HE LAUNCHED to everybody, for $5,000 an hour. The rules checked here: only your own living company; first come, first served; one place per
// player; 1, 3, 6, 12 or 24 hours and never more than 24 hours from now; the money is taken once and is gone, so net worth and rank drop at once; everybody (even a visitor) sees it
// and hears about changes; a dead company or a banned player is not shown; a place frees itself when its time is over.
import { describe, expect, it } from 'vitest';
import { BOOKS_PER_MINUTE } from '../server/routes/billboard';
import { BILLBOARD_CENTS_PER_HOUR, BILLBOARD_HOURS, BILLBOARD_MAX_HOURS_AHEAD, BILLBOARD_SLOTS, billboardPriceCents, hoursText, leftText } from '../src/shared/billboardCatalog';
import { LONG, db, idOf, liveRig, until, type Running } from './helpers/chatlive';

const { boot, call, signUp, listen } = liveRig('billboard');

const HOUR = 3_600_000;
const board = async (r: Running, cookie?: string) => (await call(r, '/api/billboard', { cookie })).json;
const book = (r: Running, cookie: string | undefined, slot: unknown, ticker: unknown, hours: unknown) => call(r, '/api/billboard/book', { method: 'POST', cookie, body: { slot, ticker, hours } });
const cash = (r: Running, name: string): number => db(r).get<{ c: number }>("SELECT a.cash_cents AS c FROM accounts a JOIN users u ON u.id = a.user_id WHERE u.username = ? AND a.kind = 'career'", name)?.c as number;
const setCash = (r: Running, name: string, cents: number): void => {
  db(r).run("UPDATE accounts SET cash_cents = ? WHERE kind = 'career' AND user_id = (SELECT id FROM users WHERE username = ?)", cents, name);
  r.app.services.social.invalidate();
};

const cid = (r: Running, ticker: string): number => (db(r).get<{ id: number }>('SELECT id FROM companies WHERE ticker = ?', ticker) as { id: number }).id;
let companyNo = 1000;
/** A company that `owner` launched (rows only: the billboard reads these tables and nothing else about a company). Pass null for a built-in one nobody launched. */
function company(r: Running, owner: string | null, ticker: string, kind: 'stock' | 'coin' = 'coin'): number {
  companyNo += 1;
  db(r).run('INSERT INTO companies(id, ticker, name, listing_tick, listed_ms) VALUES (?, ?, ?, 0, ?)', companyNo, ticker, `${ticker} Inc`, r.clock.now());
  if (owner !== null) {
    db(r).run(
      'INSERT INTO launches(company_id, user_id, kind, request_id, seed_cents, spent_cents, stake_shares, price_cents, created_ms) VALUES (?, ?, ?, ?, 0, 0, 0, 100, ?)',
      companyNo,
      idOf(r, owner),
      kind,
      `req-${companyNo}-abcdef`,
      r.clock.now(),
    );
  }
  return companyNo;
}

/** The owner-less world with alice, bob and carol ($200,000 each), and a launched company each. */
async function world() {
  const r = await boot();
  const alice = await signUp(r, 'alice');
  const bob = await signUp(r, 'bob');
  const carol = await signUp(r, 'carol');
  for (const n of ['alice', 'bob', 'carol']) setCash(r, n, 20_000_000);
  company(r, 'alice', 'ALCO');
  company(r, 'bob', 'BOBS', 'stock');
  company(r, 'carol', 'CARL');
  return { r, alice, bob, carol };
}

describe('the numbers', () => {
  it('BILL-1: three places, $5,000 an hour, 1/3/6/12/24 hours, at most 24 hours ahead; the words', () => {
    expect(BILLBOARD_SLOTS).toBe(3);
    expect(BILLBOARD_CENTS_PER_HOUR).toBe(500_000);
    expect(BILLBOARD_HOURS).toEqual([1, 3, 6, 12, 24]);
    expect(BILLBOARD_MAX_HOURS_AHEAD).toBe(24);
    expect(billboardPriceCents(1)).toBe(500_000);
    expect(billboardPriceCents(24)).toBe(12_000_000);
    expect(hoursText(1)).toBe('1 hour');
    expect(hoursText(6)).toBe('6 hours');
    const t0 = 1_000_000;
    expect(leftText(t0 - 1, t0)).toBe('Ended');
    expect(leftText(t0, t0)).toBe('Ended');
    expect(leftText(t0 + 30_000, t0)).toBe('Ends in less than a minute');
    expect(leftText(t0 + 61_000, t0)).toBe('Ends in 2 min');
    expect(leftText(t0 + 3_600_000, t0)).toBe('Ends in 1 h');
    expect(leftText(t0 + 3_600_000 + 5 * 60_000, t0)).toBe('Ends in 1 h 5 min');
  });
});

describe('looking', () => {
  it('BILL-2: anybody can look, even a visitor: three empty places and the price list; a signed-in player also gets his cash and the living companies HE launched, newest first', async () => {
    const { r, alice } = await world();
    const visitor = await board(r);
    expect(visitor).toMatchObject({ centsPerHour: 500_000, hours: [1, 3, 6, 12, 24], maxHoursAhead: 24, mine: null });
    expect(visitor.slots).toEqual([1, 2, 3].map((slot) => ({ slot, rental: null })));
    expect(typeof visitor.serverMs).toBe('number');
    company(r, 'alice', 'NEWR', 'stock'); // a newer one
    const mine = (await board(r, alice)).mine;
    expect(mine.cashCents).toBe(20_000_000);
    expect(mine.launched).toEqual([
      { ticker: 'NEWR', name: 'NEWR Inc', kind: 'stock' },
      { ticker: 'ALCO', name: 'ALCO Inc', kind: 'coin' },
    ]);
    // A dead company is not offered (bankrupt, or a memecoin whose pool was drained).
    const dead = company(r, 'alice', 'DEAD');
    db(r).run('INSERT INTO bankruptcies(company_id, declared_tick, declared_ms, cycle, negative_stories, window_total, price_before_cents) VALUES (?, 1, 1, 1, 1, 1.0, 100)', dead);
    expect((await board(r, alice)).mine.launched.map((c: any) => c.ticker)).toEqual(['NEWR', 'ALCO']);
    expect(db(r).get('SELECT COUNT(*) AS n FROM billboard_rentals')).toEqual({ n: 0 });
  }, LONG);
});

describe('booking', () => {
  it('BILL-3: booking takes hours x $5,000 once, shows the company to everybody (even a visitor), is told to every page, and is kept as a record', async () => {
    const { r, alice, bob } = await world();
    const visitor = await listen(r);
    const watching = await listen(r, bob);
    expect((await book(r, undefined, 2, 'ALCO', 3)).status).toBe(401);
    const done = await book(r, alice, 2, 'alco', 3); // (a small-letter ticker works)
    expect(done.status).toBe(200);
    expect(done.json.booked).toEqual({ slot: 2, ticker: 'ALCO', hours: 3, priceCents: 1_500_000, extended: false, endsMs: r.clock.now() + 3 * HOUR });
    expect(done.json.mine.cashCents).toBe(20_000_000 - 1_500_000);
    expect(cash(r, 'alice')).toBe(18_500_000);
    const rental = { ticker: 'ALCO', name: 'ALCO Inc', byUsername: 'alice', byName: 'alice', startsMs: r.clock.now(), endsMs: r.clock.now() + 3 * HOUR };
    expect(done.json.slots).toEqual([{ slot: 1, rental: null }, { slot: 2, rental }, { slot: 3, rental: null }]);
    // Everybody sees it: a visitor, another player, and every open page hears about it.
    expect((await board(r)).slots[1].rental).toEqual(rental);
    expect((await board(r, bob)).slots[1].rental).toEqual(rental);
    expect(await until(() => visitor.text().includes('event: billboard') && watching.text().includes('event: billboard'))).toBe(true);
    expect(visitor.text()).toContain('"ticker":"ALCO"');
    // A record is kept: who, which place, which company, when, how long, what it cost.
    expect(db(r).all('SELECT slot, user_id, company_id, hours, price_cents, starts_ms, ends_ms FROM billboard_rentals')).toEqual([
      { slot: 2, user_id: idOf(r, 'alice'), company_id: cid(r, 'ALCO'), hours: 3, price_cents: 1_500_000, starts_ms: r.clock.now(), ends_ms: r.clock.now() + 3 * HOUR },
    ]);
    // A place does not change anything about prices or trading: the company is just shown.
    expect(db(r).get('SELECT COUNT(*) AS n FROM trades')).toEqual({ n: 0 });
  }, LONG);

  it('BILL-4: only your own living company, a real place and a listed length are accepted; every refusal is told with its reason and charges nothing', async () => {
    const { r, alice } = await world();
    company(r, null, 'BUILT'); // a built-in company (nobody launched it)
    const dead = company(r, 'alice', 'DEAD');
    db(r).run('INSERT INTO bankruptcies(company_id, declared_tick, declared_ms, cycle, negative_stories, window_total, price_before_cents) VALUES (?, 1, 1, 1, 1, 1.0, 100)', dead);
    const drained = company(r, 'alice', 'RUGD');
    db(r).run('INSERT INTO coin_pools(company_id, pool_cents, in_cents, out_cents, drained_cents, drained_ms) VALUES (?, 0, 5, 0, 5, 1)', drained);
    for (const [slot, ticker, hours, status, code] of [
      [0, 'ALCO', 1, 400, 'bad_request'],
      [4, 'ALCO', 1, 400, 'bad_request'],
      [1.5, 'ALCO', 1, 400, 'bad_request'],
      ['1', 'ALCO', 1, 400, 'bad_request'],
      [undefined, 'ALCO', 1, 400, 'bad_request'],
      [1, 'ALCO', 2, 400, 'bad_request'],
      [1, 'ALCO', 0, 400, 'bad_request'],
      [1, 'ALCO', -3, 400, 'bad_request'],
      [1, 'ALCO', '3', 400, 'bad_request'],
      [1, 'ALCO', 25, 400, 'bad_request'],
      [1, 'ALCO', undefined, 400, 'bad_request'],
      [1, '', 1, 400, 'bad_request'],
      [1, 7, 1, 400, 'bad_request'],
      [1, 'WAYTOOLONGTICKER', 1, 400, 'bad_request'],
      [1, 'NOPE', 1, 404, 'no_such_company'],
      [1, 'BOBS', 1, 403, 'not_yours'], // somebody else's
      [1, 'BUILT', 1, 403, 'not_yours'], // a built-in company
      [1, 'DEAD', 1, 409, 'company_dead'],
      [1, 'RUGD', 1, 409, 'company_dead'],
    ] as const) {
      r.clock.advanceSeconds(10); // (so that asking so many times in a row is not slowed down)
      const bad = await book(r, alice, slot, ticker, hours);
      expect([slot, ticker, hours, bad.status, bad.json.error.code]).toEqual([slot, ticker, hours, status, code]);
    }
    expect(cash(r, 'alice')).toBe(20_000_000);
    expect(db(r).get('SELECT COUNT(*) AS n FROM billboard_rentals')).toEqual({ n: 0 });
  }, LONG);

  it('BILL-5: first come, first served: a taken place cannot be taken over; one place per player; you cannot swap your company in; other places stay open', async () => {
    const { r, alice, bob } = await world();
    expect((await book(r, alice, 1, 'ALCO', 6)).status).toBe(200);
    const bobBefore = cash(r, 'bob');
    const taken = await book(r, bob, 1, 'BOBS', 24);
    expect([taken.status, taken.json.error.code, taken.json.error.details]).toEqual([409, 'slot_taken', { slot: 1, untilMs: r.clock.now() + 6 * HOUR }]);
    expect(cash(r, 'bob')).toBe(bobBefore);
    // Alice already has a place: not a second one, and not another company in her own.
    const second = await book(r, alice, 2, 'ALCO', 1);
    expect([second.status, second.json.error.code]).toEqual([409, 'one_place']);
    company(r, 'alice', 'ALTW');
    const swap = await book(r, alice, 1, 'ALTW', 1);
    expect([swap.status, swap.json.error.code]).toEqual([409, 'other_company']);
    expect(cash(r, 'alice')).toBe(20_000_000 - 3_000_000);
    // Bob takes another place; the board shows both.
    expect((await book(r, bob, 3, 'BOBS', 1)).status).toBe(200);
    const slots = (await board(r)).slots;
    expect(slots.map((s: any) => s.rental?.ticker ?? null)).toEqual(['ALCO', null, 'BOBS']);
    expect(db(r).get('SELECT COUNT(*) AS n FROM billboard_rentals')).toEqual({ n: 2 });
  }, LONG);

  it('BILL-6: adding hours to your own place for the same company makes one longer booking and charges only the new hours; never longer than 24 hours from now', async () => {
    const { r, alice } = await world();
    expect((await book(r, alice, 3, 'ALCO', 12)).status).toBe(200);
    const more = await book(r, alice, 3, 'ALCO', 6);
    expect(more.status).toBe(200);
    expect(more.json.booked).toMatchObject({ slot: 3, ticker: 'ALCO', hours: 6, priceCents: 3_000_000, extended: true, endsMs: r.clock.now() + 18 * HOUR });
    expect(cash(r, 'alice')).toBe(20_000_000 - 6_000_000 - 3_000_000);
    expect(db(r).all('SELECT slot, hours, price_cents, starts_ms, ends_ms FROM billboard_rentals')).toEqual([{ slot: 3, hours: 18, price_cents: 9_000_000, starts_ms: r.clock.now(), ends_ms: r.clock.now() + 18 * HOUR }]);
    expect((await board(r)).slots[2].rental.endsMs).toBe(r.clock.now() + 18 * HOUR);
    // 18 + 12 would run 30 hours from now: refused, nothing charged; 18 + 6 is exactly 24 and fine.
    const tooLong = await book(r, alice, 3, 'ALCO', 12);
    expect([tooLong.status, tooLong.json.error.code]).toEqual([400, 'too_long']);
    expect(cash(r, 'alice')).toBe(20_000_000 - 9_000_000);
    setCash(r, 'alice', 20_000_000);
    expect((await book(r, alice, 3, 'ALCO', 6)).status).toBe(200);
    expect((await book(r, alice, 3, 'ALCO', 1)).json.error.code).toBe('too_long');
    // Time passes and the room opens again: after 6 hours there are 18 hours to the end, so 6 more fit.
    r.clock.advanceSeconds(6 * 3600);
    expect((await book(r, alice, 3, 'ALCO', 6)).status).toBe(200);
    expect((await board(r)).slots[2].rental.endsMs).toBe(r.clock.now() + 24 * HOUR);
  }, LONG);

  it('BILL-7: the money must be there: one cent short is refused with the numbers; exactly enough works and leaves nothing', async () => {
    const { r, alice } = await world();
    setCash(r, 'alice', 499_999);
    const poor = await book(r, alice, 1, 'ALCO', 1);
    expect([poor.status, poor.json.error.code, poor.json.error.details]).toEqual([400, 'not_enough_cash', { cashCents: 499_999, needCents: 500_000 }]);
    expect(poor.json.error.message).toContain('$5,000');
    expect(cash(r, 'alice')).toBe(499_999);
    setCash(r, 'alice', 500_000);
    expect((await book(r, alice, 1, 'ALCO', 1)).status).toBe(200);
    expect(cash(r, 'alice')).toBe(0);
    expect(db(r).get('SELECT COUNT(*) AS n FROM billboard_rentals')).toEqual({ n: 1 });
  }, LONG);

  it('BILL-8: two players asking for the same place at the same moment: one gets it, the other is refused and pays nothing; asking too often is slowed', async () => {
    const { r, alice, bob, carol } = await world();
    const both = await Promise.all([book(r, alice, 2, 'ALCO', 1), book(r, bob, 2, 'BOBS', 1)]);
    expect(both.map((x) => x.status).sort()).toEqual([200, 409]);
    expect(db(r).get('SELECT COUNT(*) AS n FROM billboard_rentals')).toEqual({ n: 1 });
    expect(cash(r, 'alice') + cash(r, 'bob')).toBe(40_000_000 - 500_000);
    // Carol tries over and over: refused ones count too, so the 11th in a minute is slowed down.
    for (let i = 0; i < BOOKS_PER_MINUTE; i += 1) expect((await book(r, carol, 2, 'CARL', 1)).status).toBe(409);
    const slow = await book(r, carol, 2, 'CARL', 1);
    expect([slow.status, slow.json.error.code]).toEqual([429, 'rate_limited']);
    expect(cash(r, 'carol')).toBe(20_000_000);
  }, LONG);
});

describe('when it ends', () => {
  it('BILL-9: a place frees itself when its time is over, and then anybody can take it', async () => {
    const { r, alice, bob } = await world();
    expect((await book(r, alice, 1, 'ALCO', 1)).status).toBe(200);
    r.clock.advanceSeconds(3600 - 1);
    expect((await board(r)).slots[0].rental.ticker).toBe('ALCO');
    expect((await book(r, bob, 1, 'BOBS', 1)).status).toBe(409);
    r.clock.advanceSeconds(2);
    expect((await board(r)).slots[0].rental).toBeNull();
    expect((await book(r, bob, 1, 'BOBS', 1)).status).toBe(200);
    expect((await board(r)).slots[0].rental.ticker).toBe('BOBS');
    // Alice's old booking is over, so she may book again anywhere.
    expect((await book(r, alice, 2, 'ALCO', 1)).status).toBe(200);
  }, LONG);

  it('BILL-10: a company that died (bankrupt, or a coin whose pool was drained) and a banned player are no longer shown, and the place can be booked again', async () => {
    const { r, alice, bob, carol } = await world();
    expect((await book(r, alice, 1, 'ALCO', 12)).status).toBe(200);
    expect((await book(r, bob, 2, 'BOBS', 12)).status).toBe(200);
    expect((await book(r, carol, 3, 'CARL', 12)).status).toBe(200);
    expect((await board(r)).slots.map((s: any) => s.rental?.ticker)).toEqual(['ALCO', 'BOBS', 'CARL']);
    db(r).run('INSERT INTO bankruptcies(company_id, declared_tick, declared_ms, cycle, negative_stories, window_total, price_before_cents) VALUES (?, 1, 1, 1, 1, 1.0, 100)', cid(r, 'ALCO'));
    db(r).run('INSERT INTO coin_pools(company_id, pool_cents, in_cents, out_cents, drained_cents, drained_ms) VALUES (?, 0, 5, 0, 5, 1)', cid(r, 'CARL'));
    expect((await board(r)).slots.map((s: any) => s.rental?.ticker ?? null)).toEqual([null, 'BOBS', null]);
    // Bob is banned: his booking is hidden too.
    db(r).run("INSERT INTO users(username, display_name, pw_hash, role, created_ms) VALUES ('boss', 'boss', 'x', 'owner', 1)");
    db(r).run("INSERT INTO user_bans(user_id, reason, banned_ms, until_ms, by_user_id) VALUES (?, 'x', ?, NULL, ?)", idOf(r, 'bob'), r.clock.now(), idOf(r, 'boss'));
    expect((await board(r)).slots.map((s: any) => s.rental?.ticker ?? null)).toEqual([null, null, null]);
    // The freed places can be booked (alice has no live place any more, her company being dead she books another one).
    company(r, 'alice', 'ALTW');
    expect((await book(r, alice, 1, 'ALTW', 1)).status).toBe(200);
    expect((await board(r)).slots.map((s: any) => s.rental?.ticker ?? null)).toEqual(['ALTW', null, null]);
  }, LONG);
});

describe('money and rank', () => {
  it('BILL-11: booking lowers net worth, so the leaderboard and the weekly board change at once; a refused booking changes nothing', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const bob = await signUp(r, 'bob');
    setCash(r, 'alice', 30_000_000);
    setCash(r, 'bob', 20_000_000);
    company(r, 'alice', 'ALCO');
    const rows = async () => (await call(r, '/api/leaderboard', { cookie: bob })).json.rows.map((x: any) => [x.username, x.netWorthCents]);
    expect(await rows()).toEqual([['alice', 30_000_000], ['bob', 20_000_000]]);
    expect((await book(r, alice, 1, 'ALCO', 24)).status).toBe(200); // $120,000 gone
    expect(await rows()).toEqual([['bob', 20_000_000], ['alice', 18_000_000]]);
    expect((await call(r, '/api/leaderboard/weekly', { cookie: alice })).json.me.gainCents).toBe(18_000_000 - 100_000);
    expect((await book(r, alice, 2, 'ALCO', 1)).status).toBe(409);
    expect(await rows()).toEqual([['bob', 20_000_000], ['alice', 18_000_000]]);
  }, LONG);

  it('BILL-12: a computer player never books', async () => {
    const r = await boot();
    await signUp(r, 'alice');
    const bot = idOf(r, 'alice');
    db(r).run("INSERT INTO bots(user_id, persona) VALUES (?, 'steady')", bot);
    setCash(r, 'alice', 10_000_000);
    company(r, 'alice', 'ALCO');
    const as = { id: bot, username: 'alice', displayName: 'alice', role: 'player' as const, createdMs: 0 };
    expect(() => r.app.services.billboard.book(as, 1, 'ALCO', 1)).toThrow(/Computer players do not book/);
    expect(cash(r, 'alice')).toBe(10_000_000);
    expect(db(r).get('SELECT COUNT(*) AS n FROM billboard_rentals')).toEqual({ n: 0 });
  }, LONG);
});
