// CALMSRV — calmer stocks on the server (docs/world.md §26): a new world is calm from its first tick, an older world becomes calm from the first tick
// after it is started by this program and keeps everything before it, the tick is stored once, and restarts replay the same prices.
import { afterEach, describe, expect, it } from 'vitest';
import { EffectBook, WorldSim, buildCatalog } from '../src/world';
import { CALM_FROM_TICK } from '../server/world/runtime';
import { migrate } from '../server/schema';
import { Db } from '../server/sqlite';
import { Clock, makeRig, priceVector, type Rig } from './helpers/server';

const LONG = 120_000;
const SEED = 777;
const NEVER = '9007199254740000'; // far beyond any real tick: a world that was made before the calmer stocks existed

const rigs: Rig[] = [];
function rig(clock?: Clock): Rig {
  const r = makeRig(clock);
  rigs.push(r);
  return r;
}
afterEach(() => {
  while (rigs.length > 0) rigs.pop()?.cleanup();
});

/** Makes the database of a world that never heard of calmer stocks: its first start finds the number already there. */
function oldWorld(r: Rig): void {
  const db = new Db(r.path);
  migrate(db);
  db.run('INSERT INTO meta(key, value) VALUES (?, ?)', CALM_FROM_TICK, NEVER);
  db.close();
}

function storedCalm(db: Db): string | undefined {
  return db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', CALM_FROM_TICK)?.value;
}

describe('Calmer stocks on the server', () => {
  it('CALMSRV-1: a brand-new world is calm from tick 0, and says so in the database', () => {
    const r = rig();
    const { db, world } = r.open({ worldSeed: SEED });
    expect(world.calmFrom).toBe(0);
    expect(world.sim.calmFrom).toBe(0);
    expect(storedCalm(db)).toBe('0');
    // Its first day of history is the calm one: it equals a direct calm replay.
    const direct = new WorldSim(SEED, buildCatalog(12), 0);
    const none = new EffectBook();
    while (direct.tick < world.sim.tick) direct.step(none);
    expect(priceVector(world)).toEqual(Array.from(direct.P));
  }, LONG);

  it('CALMSRV-2: an older world becomes calm from the tick after it is first started, and everything before stays exactly as it was', () => {
    const r = rig();
    oldWorld(r);
    const first = r.open({ worldSeed: SEED });
    expect(first.world.sim.calmFrom).toBe(Number(NEVER));
    r.clock.advanceSeconds(900);
    first.world.advanceTo(first.world.currentTick(), Infinity);
    type Row = { company_id: number; idx: number; open: number; high: number; low: number; close: number; volume: number };
    const rowsBefore = first.db.all<Row>('SELECT * FROM candles_c10 ORDER BY company_id, idx');
    expect(rowsBefore.length).toBeGreaterThan(1000);
    first.db.run('DELETE FROM meta WHERE key = ?', CALM_FROM_TICK); // the program is replaced by this one: it finds no calm tick
    first.db.close();

    r.clock.advanceSeconds(1800); // the computer was off for half an hour
    const second = r.open({ worldSeed: SEED });
    const nowTick = second.world.currentTick();
    expect(second.world.calmFrom).toBe(nowTick + 1);
    expect(storedCalm(second.db)).toBe(String(nowTick + 1));
    // The past is not recomputed: every stored candle from before the stop is still the same.
    const rowsAfter = new Map(second.db.all<Row>('SELECT * FROM candles_c10').map((x) => [`${x.company_id}:${x.idx}`, x]));
    for (const x of rowsBefore) expect(rowsAfter.get(`${x.company_id}:${x.idx}`)).toEqual(x);

    // And the market now equals an independent replay: old rules up to the calm tick, calm rules from it.
    r.clock.advanceSeconds(7200);
    second.world.advanceTo(second.world.currentTick(), Infinity);
    const now = second.world.sim.tick;
    expect(now).toBeGreaterThan(nowTick + 7000);
    const replay = (calmFrom: number): number[] => {
      const sim = new WorldSim(SEED, buildCatalog(12), calmFrom);
      const none = new EffectBook();
      while (sim.tick < now) sim.step(none);
      return Array.from(sim.P);
    };
    expect(priceVector(second.world)).toEqual(replay(second.world.calmFrom));
    expect(priceVector(second.world)).not.toEqual(replay(Infinity));
  }, LONG);

  it('CALMSRV-3: the calm tick is chosen once; a restart (clean, or after days off) keeps it and gives the prices an uninterrupted market has', () => {
    const steps = (restart: boolean): { calm: number; prices: number[]; tick: number } => {
      const clock = new Clock();
      const r = rig(clock);
      oldWorld(r);
      let run = r.open({ worldSeed: SEED });
      clock.advanceSeconds(600);
      run.world.advanceTo(run.world.currentTick(), Infinity);
      run.db.run('DELETE FROM meta WHERE key = ?', CALM_FROM_TICK);
      run.db.close();
      run = r.open({ worldSeed: SEED }); // the upgrade
      const calm = run.world.calmFrom;
      clock.advanceSeconds(3000);
      run.world.advanceTo(run.world.currentTick(), Infinity);
      if (restart) {
        run.db.close();
        run = r.open({ worldSeed: SEED }); // a plain restart: the number is read, not made again
        expect(run.world.calmFrom).toBe(calm);
      }
      clock.advanceSeconds(3000);
      run.world.advanceTo(run.world.currentTick(), Infinity);
      expect(storedCalm(run.db)).toBe(String(calm));
      return { calm, prices: priceVector(run.world), tick: run.world.sim.tick };
    };
    const straight = steps(false);
    const restarted = steps(true);
    expect(restarted.tick).toBe(straight.tick);
    expect(restarted.calm).toBe(straight.calm);
    expect(restarted.prices).toEqual(straight.prices);
  }, LONG);

  it('CALMSRV-4: a crash between saves replays to the same calm prices', () => {
    const clock = new Clock();
    const r = rig(clock);
    const run = r.open({ worldSeed: SEED });
    clock.advanceSeconds(1234);
    run.world.advanceTo(run.world.currentTick(), Infinity);
    const prices = priceVector(run.world);
    const tick = run.world.sim.tick;
    run.db.close(); // no clean stop: the state in memory is lost, the last saved candle boundary is what is left
    const again = r.open({ worldSeed: SEED });
    expect(again.world.sim.tick).toBe(tick);
    expect(priceVector(again.world)).toEqual(prices);
    expect(again.world.calmFrom).toBe(0);
  }, LONG);

  it('CALMSRV-5: a calm tick in the database that is not a tick is refused with a plain sentence', () => {
    for (const bad of ['abc', '-5', '1.5', '']) {
      const r = rig();
      const db = new Db(r.path);
      migrate(db);
      db.run('INSERT INTO meta(key, value) VALUES (?, ?)', CALM_FROM_TICK, bad);
      db.close();
      expect(() => r.open({ worldSeed: SEED })).toThrow(/calm tick/);
    }
  }, LONG);

  it('CALMSRV-6: memecoins are not calmed on the server either', () => {
    const clock = new Clock();
    const a = rig(clock);
    const b = rig(new Clock());
    oldWorld(b);
    const calm = a.open({ worldSeed: SEED, memecoins: true, companyCount: 66 });
    const old = b.open({ worldSeed: SEED, memecoins: true, companyCount: 66 });
    for (const x of [clock, b.clock]) x.advanceSeconds(3000);
    calm.world.advanceTo(calm.world.currentTick(), Infinity);
    old.world.advanceTo(old.world.currentTick(), Infinity);
    let coins = 0;
    let stocks = 0;
    let stocksThatDiffer = 0;
    calm.world.companies.forEach((c, i) => {
      const same = calm.world.sim.P[i] === old.world.sim.P[i];
      if (c.sector === 'meme') {
        coins += 1;
        expect(same).toBe(true);
      } else {
        stocks += 1;
        if (!same) stocksThatDiffer += 1;
      }
    });
    expect(coins).toBe(30);
    expect(stocksThatDiffer).toBeGreaterThan(stocks * 0.8);
  }, LONG);
});

