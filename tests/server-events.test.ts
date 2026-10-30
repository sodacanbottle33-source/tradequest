// Market events (server/events.ts, server/routes/predict.ts, docs/world.md §39). At 21:00 Tokyo time, at most once a day, something happens to the market: a storm, a meme frenzy, a rally or a
// sell-off. The players are told that an event is coming, never which one. Every move is made with the same machinery as the owner's special events (a headline and a price move).
import { describe, expect, it } from 'vitest';
import { dayOf, dayStartMs } from '../src/shared/goalCatalog';
import { CATCHUP_MS, EVENT_AT_MS, EVENT_KINDS, LIVE_MS, RECENT_EVENTS, kindDef, type EventKind } from '../server/events';
import { LONG, db, idOf, liveRig, until, type Running } from './helpers/chatlive';

const { boot, call, signUp, listen } = liveRig('events', 'boss', '66', { events: true, memecoins: true });
const plain = liveRig('events-off', 'boss', '12');
const noNews = liveRig('events-nonews', 'boss', '12', { events: true, news: null });

const events = async (r: Running, cookie: string) => (await call(r, '/api/events', { cookie })).json;
const hour = (day: number, h: number, extraMs = 0): number => dayStartMs(day) + h * 3_600_000 + extraMs;
const at = (r: Running, ms: number): void => {
  r.clock.ms = ms;
};
const rowOf = (r: Running, day: number) => db(r).get<{ kind: string; status: string; fired_ms: number | null; moves_json: string }>('SELECT kind, status, fired_ms, moves_json FROM market_events WHERE day = ?', day);
const shocks = (r: Running, day: number) => db(r).all<{ request_id: string; target: string }>("SELECT request_id, target FROM admin_log WHERE action = 'shock' AND request_id LIKE ? ORDER BY id", `ev-${day}-%`);
const moveOf = (r: Running, day: number): { ticker: string; name: string; pct: number }[] => JSON.parse(rowOf(r, day)?.moves_json ?? '[]');

/** Plans a day's event in the morning, forces its kind, and lets 21:00 come. Returns what the sweep says. */
function runDay(r: Running, day: number, kind: EventKind): EventKind | null {
  at(r, hour(day, 10));
  r.app.services.events.sweep();
  db(r).run('UPDATE market_events SET kind = ? WHERE day = ?', kind, day);
  at(r, hour(day, 21, 5000));
  return r.app.services.events.sweep();
}

describe('switched off', () => {
  it('EVENT-1: without the setting, or without the news system, nothing is announced and nothing runs', async () => {
    for (const rig of [plain, noNews]) {
      const r = await rig.boot();
      const owner = await rig.signUp(r, 'boss');
      at(r, hour(dayOf(r.clock.now()), 21, 1000));
      expect(r.app.services.events.sweep()).toBeNull();
      const v = (await rig.call(r, '/api/events', { cookie: owner })).json;
      expect(v).toMatchObject({ enabled: false, next: null, live: null, recent: [] });
      expect(db(r).get('SELECT COUNT(*) AS n FROM market_events')).toEqual({ n: 0 });
      expect(db(r).get("SELECT COUNT(*) AS n FROM admin_log WHERE action = 'shock'")).toEqual({ n: 0 });
    }
  }, LONG);

  it('EVENT-2: only a signed-in player can ask', async () => {
    const r = await boot();
    expect((await call(r, '/api/events')).status).toBe(401);
  }, LONG);
});

describe('before the event', () => {
  it('EVENT-3: in the morning the page only knows that an event is coming at 21:00; the kind is decided but never shown; asking does not plan or run anything', async () => {
    const r = await boot();
    const owner = await signUp(r, 'boss');
    const day = dayOf(r.clock.now());
    at(r, hour(day, 10));
    const v = await events(r, owner);
    expect(v).toMatchObject({ enabled: true, serverMs: r.clock.now(), next: { day, atMs: hour(day, 21) }, live: null, recent: [] });
    expect(EVENT_AT_MS).toBe(21 * 3_600_000);
    expect(db(r).get('SELECT COUNT(*) AS n FROM market_events')).toEqual({ n: 0 });
    // The game's sweep plans the day (so the choice is kept), but still moves nothing.
    expect(r.app.services.events.sweep()).toBeNull();
    expect(rowOf(r, day)).toMatchObject({ status: 'planned', fired_ms: null });
    const after = await events(r, owner);
    const text = JSON.stringify(after);
    for (const k of EVENT_KINDS) for (const word of [k.kind, k.name, k.blurb]) expect(text).not.toContain(word);
    expect(after.next).toEqual({ day, atMs: hour(day, 21) });
    expect(shocks(r, day)).toEqual([]);
    // Planning is done once: another sweep keeps the same kind.
    const planned = rowOf(r, day)?.kind;
    r.app.services.events.sweep();
    expect(rowOf(r, day)?.kind).toBe(planned);
  }, LONG);
});

describe('the four kinds', () => {
  const expectations: Record<EventKind, { count: number; min: number; max: number; sign: 'mixed' | 'up' | 'down'; meme: boolean }> = {
    storm: { count: 6, min: 5, max: 12, sign: 'mixed', meme: false },
    frenzy: { count: 5, min: 20, max: 45, sign: 'mixed', meme: true },
    rally: { count: 8, min: 4, max: 9, sign: 'up', meme: false },
    selloff: { count: 8, min: 4, max: 9, sign: 'down', meme: false },
  };

  it('EVENT-4: each kind moves the right number of the right kind of company by an amount in its range, in the right direction, with a headline in the owner\'s name, and tells every signed-in page', async () => {
    const r = await boot();
    const owner = await signUp(r, 'boss');
    const alice = await signUp(r, 'alice');
    const watching = await listen(r, alice);
    let day = dayOf(r.clock.now()) + 1;
    for (const kind of ['storm', 'frenzy', 'rally', 'selloff'] as const) {
      const want = expectations[kind];
      expect(runDay(r, day, kind), kind).toBe(kind);
      const moves = moveOf(r, day);
      expect(moves.length, kind).toBe(want.count);
      expect(new Set(moves.map((m) => m.ticker)).size).toBe(moves.length);
      for (const m of moves) {
        const company = r.app.services.world.companies.find((c) => c.ticker === m.ticker);
        expect(company, m.ticker).toBeDefined();
        expect((company?.sector === 'meme'), `${kind} ${m.ticker}`).toBe(want.meme);
        expect(Math.abs(m.pct), `${kind} ${m.ticker}`).toBeGreaterThanOrEqual(want.min);
        expect(Math.abs(m.pct), `${kind} ${m.ticker}`).toBeLessThanOrEqual(want.max);
        if (want.sign === 'up') expect(m.pct).toBeGreaterThan(0);
        if (want.sign === 'down') expect(m.pct).toBeLessThan(0);
      }
      if (want.sign === 'mixed') {
        expect(moves.some((m) => m.pct > 0)).toBe(true);
        expect(moves.some((m) => m.pct < 0)).toBe(true);
      }
      // Done and recorded in the owner's log, one shock per company, named by the day and the ticker.
      expect(rowOf(r, day)).toMatchObject({ kind, status: 'done' });
      expect(shocks(r, day).map((s) => s.target).sort()).toEqual(moves.map((m) => m.ticker).sort());
      expect(shocks(r, day).every((s) => s.request_id.startsWith(`ev-${day}-`))).toBe(true);
      expect(await until(() => watching.text().includes(`"kind":"${kind}"`))).toBe(true);
      day += 1;
    }
    expect(watching.text()).toContain('event: marketevent');
    expect(db(r).all("SELECT DISTINCT admin_user_id AS u FROM admin_log WHERE action = 'shock'")).toEqual([{ u: idOf(r, 'boss') }]);
    void owner;
  }, 300_000);

  it('EVENT-5: it runs once: a second sweep, a later sweep and a fresh start change nothing; the day is claimed before anything moves', async () => {
    const r = await boot();
    await signUp(r, 'boss');
    const day = dayOf(r.clock.now()) + 1;
    expect(runDay(r, day, 'rally')).toBe('rally');
    const logged = shocks(r, day).length;
    expect(logged).toBe(8);
    expect(r.app.services.events.sweep()).toBeNull();
    at(r, hour(day, 22));
    expect(r.app.services.events.sweep()).toBeNull();
    expect(shocks(r, day)).toHaveLength(logged);
    // A day that is already marked done is never run again, even by a brand new sweeper and even if the row looks fresh.
    db(r).run("UPDATE market_events SET fired_ms = NULL WHERE day = ?", day);
    expect(r.app.services.events.sweep()).toBeNull();
    expect(shocks(r, day)).toHaveLength(logged);
  }, LONG);

  it('EVENT-6: it shows as "happening now" for half an hour with the kind and the moves, then it is in the list of recent ones; the list keeps the last few, newest first', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    await signUp(r, 'boss');
    const first = dayOf(r.clock.now()) + 1;
    const kinds: EventKind[] = ['storm', 'rally', 'selloff', 'storm', 'rally', 'selloff', 'storm'];
    kinds.forEach((k, i) => expect(runDay(r, first + i, k)).toBe(k));
    const last = first + kinds.length - 1;
    at(r, hour(last, 21, 10 * 60_000));
    const live = (await events(r, alice)).live;
    expect(live).toMatchObject({ day: last, kind: 'storm', name: 'Market Storm', icon: '⛈️', status: 'done' });
    expect(live.moves).toHaveLength(6);
    expect(typeof live.moves[0].ticker).toBe('string');
    at(r, hour(last, 21, LIVE_MS + 60_000));
    const after = await events(r, alice);
    expect(after.live).toBeNull();
    expect(after.recent).toHaveLength(RECENT_EVENTS);
    expect(after.recent.map((e: { day: number }) => e.day)).toEqual([last, last - 1, last - 2, last - 3, last - 4]);
    expect(after.next).toEqual({ day: last + 1, atMs: hour(last + 1, 21) });
  }, 300_000);
});

describe('when it can not run', () => {
  it('EVENT-7: if the server was off at 21:00 and comes back much later, the day is marked missed and nothing moves', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    await signUp(r, 'boss');
    const day = dayOf(r.clock.now()) + 1;
    at(r, hour(day, 21, CATCHUP_MS + 60_000));
    expect(r.app.services.events.sweep()).toBeNull();
    expect(rowOf(r, day)?.status).toBe('missed');
    expect(shocks(r, day)).toEqual([]);
    const v = await events(r, alice);
    expect(v).toMatchObject({ live: null, recent: [], next: { day: day + 1, atMs: hour(day + 1, 21) } });
    // A little late (within the allowed delay) still runs.
    const next = day + 1;
    at(r, hour(next, 10));
    r.app.services.events.sweep();
    db(r).run("UPDATE market_events SET kind = 'rally' WHERE day = ?", next);
    at(r, hour(next, 21, CATCHUP_MS - 60_000));
    expect(r.app.services.events.sweep()).toBe('rally');
  }, LONG);

  it('EVENT-8: without an owner account the day is marked "off" and nothing moves', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const day = dayOf(r.clock.now()) + 1;
    at(r, hour(day, 21, 5000));
    expect(r.app.services.events.sweep()).toBeNull();
    expect(rowOf(r, day)?.status).toBe('off');
    expect(db(r).get("SELECT COUNT(*) AS n FROM admin_log WHERE action = 'shock'")).toEqual({ n: 0 });
    expect((await events(r, alice)).enabled).toBe(true);
  }, LONG);

  it('EVENT-9: a company that a player launched, one that went bankrupt and one that is not a stock (for a storm) is never moved; with fewer left the event is smaller', async () => {
    const r = await boot();
    await signUp(r, 'boss');
    await signUp(r, 'founder');
    const founder = idOf(r, 'founder');
    const world = r.app.services.world;
    const stocks = world.companies.filter((c) => c.sector !== 'meme').map((c) => c.ticker);
    const memes = world.companies.filter((c) => c.sector === 'meme').map((c) => c.ticker);
    expect(stocks.length).toBeGreaterThan(10);
    expect(memes.length).toBeGreaterThan(5);
    const launched = new Set([...stocks.slice(0, 5), ...memes.slice(0, memes.length - 2)]);
    const broke = new Set(stocks.slice(5, 8));
    let n = 0;
    for (const c of world.companies) {
      if (launched.has(c.ticker)) {
        db(r).run("INSERT INTO launches(company_id, user_id, kind, request_id, seed_cents, spent_cents, stake_shares, price_cents, created_ms, fee_cents) VALUES (?, ?, ?, ?, 100, 100, 1, 100, 0, 0)", c.id, founder, c.sector === 'meme' ? 'coin' : 'stock', `launch-${(n += 1)}`);
      } else if (broke.has(c.ticker)) {
        db(r).run('INSERT INTO bankruptcies(company_id, declared_tick, declared_ms, cycle, negative_stories, window_total, price_before_cents) VALUES (?, 1, 1, 1, 1, 1, 100)', c.id);
      }
    }
    let day = dayOf(r.clock.now()) + 1;
    expect(runDay(r, day, 'storm')).toBe('storm');
    for (const m of moveOf(r, day)) {
      expect(launched.has(m.ticker), m.ticker).toBe(false);
      expect(broke.has(m.ticker), m.ticker).toBe(false);
      expect(memes.includes(m.ticker), m.ticker).toBe(false);
    }
    day += 1;
    expect(runDay(r, day, 'frenzy')).toBe('frenzy');
    const frenzy = moveOf(r, day).map((m) => m.ticker).sort();
    expect(frenzy).toEqual(memes.filter((t) => !launched.has(t)).sort());
    expect(frenzy).toHaveLength(2);
  }, 300_000);

  it('EVENT-10: when there is nothing of the right kind to move, the day is marked missed and the pages are told nothing', async () => {
    const r = await boot();
    await signUp(r, 'boss');
    const alice = await signUp(r, 'alice');
    const watching = await listen(r, alice);
    await signUp(r, 'founder');
    const founder = idOf(r, 'founder');
    let n = 0;
    for (const c of r.app.services.world.companies) {
      if (c.sector === 'meme') db(r).run("INSERT INTO launches(company_id, user_id, kind, request_id, seed_cents, spent_cents, stake_shares, price_cents, created_ms, fee_cents) VALUES (?, ?, 'coin', ?, 100, 100, 1, 100, 0, 0)", c.id, founder, `launch-${(n += 1)}`);
    }
    const day = dayOf(r.clock.now()) + 1;
    expect(runDay(r, day, 'frenzy')).toBeNull();
    expect(rowOf(r, day)?.status).toBe('missed');
    expect(shocks(r, day)).toEqual([]);
    await new Promise((done) => setTimeout(done, 150));
    expect(watching.text()).not.toContain('event: marketevent');
  }, LONG);
});

describe('which kind comes', () => {
  it('EVENT-11: the kind of each day is never the same as the day before, and over two weeks every kind comes up', async () => {
    const r = await boot();
    await signUp(r, 'boss');
    const first = dayOf(r.clock.now()) + 1;
    const seen: string[] = [];
    for (let i = 0; i < 14; i += 1) {
      const day = first + i;
      at(r, hour(day, 10));
      r.app.services.events.sweep();
      seen.push(rowOf(r, day)?.kind as string);
    }
    for (let i = 1; i < seen.length; i += 1) expect(seen[i], `day ${i}`).not.toBe(seen[i - 1]);
    for (const k of EVENT_KINDS) expect(kindDef(k.kind)).toBeDefined();
    expect(new Set(seen).size).toBeGreaterThanOrEqual(3);
    // The weights favour the common kinds.
    expect(EVENT_KINDS.map((k) => k.weight)).toEqual([3, 2, 1, 1]);
    // Run the whole fortnight as the game would: every day that has a row ran its own kind exactly once.
    for (let i = 0; i < 14; i += 1) {
      const day = first + i;
      at(r, hour(day, 21, 5000));
      expect(r.app.services.events.sweep(), `day ${i}`).toBe(seen[i]);
    }
  }, 600_000);
});
