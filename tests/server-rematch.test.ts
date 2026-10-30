// "Rematch" after a 1v1 (server/lobby/service.ts, docs/world.md §35). When a match between two real players is over, each may ask the other to play again for two minutes. When BOTH have asked,
// a closed lobby of exactly the two of them opens (nobody ready yet). A rematch of a lobby match is ranked like any lobby match; a rematch of a friend match is a friend match again.
import { describe, expect, it } from 'vitest';
import { REMATCH_WINDOW_MS } from '../server/lobby/service';
import { LONG, db, idOf, liveRig, type Running } from './helpers/chatlive';

const { boot, call, signUp, listen } = liveRig('rematch');

async function gotoTick(r: Running, tick: number, cookies: string[]): Promise<void> {
  const w = r.app.services.world;
  while (w.currentTick() < tick) {
    const next = Math.min(tick, w.currentTick() + 5);
    r.clock.ms = w.msOfTick(next);
    for (let i = 0; i < 20_000 && w.sim.tick < w.currentTick(); i += 1) w.pump();
    for (const c of cookies) await call(r, '/api/lobby', { cookie: c });
  }
}

const post = (r: Running, path: string, cookie: string, body?: unknown) => call(r, path, { method: 'POST', cookie, body });
const view = async (r: Running, cookie: string) => (await call(r, '/api/lobby', { cookie })).json.match;

/** Two players find each other in the lobby, both press Ready and the match is played to the end. Returns the id of the finished match. */
async function playLobbyMatch(r: Running, ca: string, cb: string): Promise<number> {
  await post(r, '/api/lobby/join', ca);
  await post(r, '/api/lobby/join', cb);
  await post(r, '/api/lobby/ready', ca, { ready: true });
  const ready = await post(r, '/api/lobby/ready', cb, { ready: true });
  await gotoTick(r, ready.json.match.endTick + 12, [ca, cb]);
  const done = await view(r, ca);
  expect(done.phase).toBe('finished');
  return done.id as number;
}

async function pair() {
  const r = await boot();
  const ca = await signUp(r, 'alice');
  const cb = await signUp(r, 'bob');
  return { r, ca, cb };
}

describe('asking for a rematch', () => {
  it('REMATCH-1: after a match between two players both see an offer that lasts two minutes; nobody has asked yet; the finished match is not itself a rematch', async () => {
    const { r, ca, cb } = await pair();
    await playLobbyMatch(r, ca, cb);
    for (const c of [ca, cb]) {
      const m = await view(r, c);
      expect(m.isRematch).toBe(false);
      expect(m.rematch).toMatchObject({ youAsked: false, theyAsked: false });
      expect(m.rematch.msLeft).toBeGreaterThan(REMATCH_WINDOW_MS - 20_000);
      expect(m.rematch.msLeft).toBeLessThanOrEqual(REMATCH_WINDOW_MS);
    }
    // The offer runs down with the clock.
    const before = (await view(r, ca)).rematch.msLeft as number;
    r.clock.ms += 30_000;
    expect(before - (await view(r, ca)).rematch.msLeft).toBe(30_000);
    // A match that is not over has no offer.
    const second = await pair();
    const w = await post(second.r, '/api/lobby/join', second.ca);
    expect(w.json.match.rematch).toBeNull();
  }, LONG);

  it('REMATCH-2: one player asking is told to the other ("they asked"); asking twice is the same as once; only when both have asked does a closed ranked lobby of the two open', async () => {
    const { r, ca, cb } = await pair();
    const id = await playLobbyMatch(r, ca, cb);
    const first = await post(r, '/api/lobby/rematch', ca, { matchId: id });
    expect(first.status).toBe(200);
    expect(first.json.match.id).toBe(id); // still the finished match
    expect(first.json.match.rematch).toMatchObject({ youAsked: true, theyAsked: false });
    expect((await post(r, '/api/lobby/rematch', ca, { matchId: id })).json.match.rematch).toMatchObject({ youAsked: true, theyAsked: false });
    expect((await view(r, cb)).rematch).toMatchObject({ youAsked: false, theyAsked: true });
    expect(db(r).all("SELECT * FROM matches WHERE state = 'lobby'")).toEqual([]);

    const second = await post(r, '/api/lobby/rematch', cb, { matchId: id });
    expect(second.status).toBe(200);
    const m = second.json.match;
    expect(m.id).not.toBe(id);
    expect(m).toMatchObject({ phase: 'ready_check', isRematch: true, friendMatch: false, ranked: true, playerCount: 2, rematch: null });
    expect(m.players.map((p: { name: string }) => p.name).sort()).toEqual(['alice', 'bob']);
    expect(m.players.every((p: { ready: boolean }) => !p.ready)).toBe(true);
    expect(m.message).toContain('Rematch against alice');
    // The same lobby is what alice sees, and the old result is gone from both screens.
    const mine = await view(r, ca);
    expect(mine).toMatchObject({ id: m.id, isRematch: true, ranked: true });
    expect(mine.message).toContain('Rematch against bob');
    expect(db(r).get('SELECT rematch, friends FROM matches WHERE id = ?', m.id)).toEqual({ rematch: 1, friends: 0 });
    expect(db(r).all('SELECT dismissed FROM match_players WHERE match_id = ?', id).every((p: any) => p.dismissed === 1)).toBe(true);
    // And now the old match has no offer to ask for.
    expect((await post(r, '/api/lobby/rematch', ca, { matchId: id })).json.error.code).toBe('no_rematch');
  }, LONG);

  it('REMATCH-3: the rematch is played like any match and is ranked: points move for the second match too', async () => {
    const { r, ca, cb } = await pair();
    const id = await playLobbyMatch(r, ca, cb);
    const matchesOf = () => db(r).get<{ n: number }>('SELECT matches AS n FROM ranked_player WHERE user_id = ?', idOf(r, 'alice'))?.n;
    const firstCount = matchesOf();
    expect(firstCount).toBe(1);
    await post(r, '/api/lobby/rematch', ca, { matchId: id });
    const opened = await post(r, '/api/lobby/rematch', cb, { matchId: id });
    await post(r, '/api/lobby/ready', ca, { ready: true });
    const ready = await post(r, '/api/lobby/ready', cb, { ready: true });
    expect(ready.json.match.isRematch).toBe(true);
    await gotoTick(r, ready.json.match.endTick + 12, [ca, cb]);
    const done = await view(r, ca);
    expect(done.id).toBe(opened.json.match.id);
    expect(done).toMatchObject({ phase: 'finished', isRematch: true, ranked: true });
    expect(done.players.every((p: { rank: unknown }) => p.rank !== null)).toBe(true);
    expect(matchesOf()).toBe(2);
    // The result of a rematch can itself be followed by another rematch.
    expect(done.rematch).toMatchObject({ youAsked: false, theyAsked: false });
  }, LONG);

  it('REMATCH-4: a player who leaves the rematch lobby cancels it for both, with a clear reason, and nobody is left waiting for a stranger', async () => {
    const { r, ca, cb } = await pair();
    const id = await playLobbyMatch(r, ca, cb);
    await post(r, '/api/lobby/rematch', ca, { matchId: id });
    const opened = (await post(r, '/api/lobby/rematch', cb, { matchId: id })).json.match;
    await post(r, '/api/lobby/leave', cb);
    const mine = await view(r, ca);
    expect(mine).toMatchObject({ id: opened.id, phase: 'cancelled', cancelReason: 'rematch_left', ranked: false });
    expect(mine.message).toBe('Your opponent left before the rematch started, so it was cancelled. Nobody won or lost.');
    expect(db(r).get('SELECT COUNT(*) AS n FROM match_players WHERE match_id = ? AND active = 1', opened.id)).toEqual({ n: 0 });
    // Alice can close it and look for a new match as normal.
    await post(r, '/api/lobby/dismiss', ca);
    expect((await call(r, '/api/lobby', { cookie: ca })).json.match).toBeNull();
    const again = await post(r, '/api/lobby/join', ca);
    expect(again.json.match).toMatchObject({ phase: 'waiting', isRematch: false, playerCount: 1 });
  }, LONG);

  it('REMATCH-5: the offer ends after two minutes: it disappears from the view and asking is refused', async () => {
    const { r, ca, cb } = await pair();
    const id = await playLobbyMatch(r, ca, cb);
    await post(r, '/api/lobby/rematch', ca, { matchId: id });
    r.clock.ms += REMATCH_WINDOW_MS + 1000;
    expect((await view(r, ca)).rematch).toBeNull();
    expect((await view(r, cb)).rematch).toBeNull();
    const late = await post(r, '/api/lobby/rematch', cb, { matchId: id });
    expect([late.status, late.json.error.code]).toEqual([409, 'no_rematch']);
    expect(db(r).all("SELECT * FROM matches WHERE rematch = 1")).toEqual([]);
  }, LONG);

  it('REMATCH-6: a player who closed the result or went to find another match has said no; his opponent can not ask him any more', async () => {
    const { r, ca, cb } = await pair();
    const id = await playLobbyMatch(r, ca, cb);
    await post(r, '/api/lobby/rematch', ca, { matchId: id });
    await post(r, '/api/lobby/dismiss', cb); // bob closes the result
    expect((await view(r, ca)).rematch).toBeNull();
    const refused = await post(r, '/api/lobby/rematch', cb, { matchId: id });
    expect(refused.json.error.code).toBe('no_rematch');
    // Looking for another match ends the offer too.
    const second = await pair();
    const id2 = await playLobbyMatch(second.r, second.ca, second.cb);
    await post(second.r, '/api/lobby/join', second.cb);
    expect((await view(second.r, second.ca)).rematch).toBeNull();
    expect((await post(second.r, '/api/lobby/rematch', second.ca, { matchId: id2 })).json.error.code).toBe('no_rematch');
  }, LONG);

  it('REMATCH-7: it is checked: a stranger to the match gets "no such match", a bad body is a 400, and you must be signed in', async () => {
    const { r, ca, cb } = await pair();
    const cc = await signUp(r, 'carol');
    const id = await playLobbyMatch(r, ca, cb);
    expect((await post(r, '/api/lobby/rematch', cc, { matchId: id })).json.error.code).toBe('no_such_match');
    expect((await post(r, '/api/lobby/rematch', ca, { matchId: '1' })).status).toBe(400);
    expect((await post(r, '/api/lobby/rematch', ca, { matchId: 1.5 })).status).toBe(400);
    expect((await post(r, '/api/lobby/rematch', ca, {})).status).toBe(400);
    expect((await call(r, '/api/lobby/rematch', { method: 'POST', body: { matchId: id } })).status).toBe(401);
    expect((await post(r, '/api/lobby/rematch', ca, { matchId: 99999 })).status).toBe(404);
    expect((await view(r, cc))).toBeNull();
  }, LONG);

  it('REMATCH-8: there is no offer after a match against a computer player, a match that was abandoned or a match that was cancelled', async () => {
    const { r, ca, cb } = await pair();
    const id = await playLobbyMatch(r, ca, cb);
    expect((await view(r, ca)).rematch).not.toBeNull();
    // The same finished match, but bob is a computer player.
    db(r).run("INSERT INTO bots(user_id, persona) VALUES (?, 'test-persona')", idOf(r, 'bob'));
    expect((await view(r, ca)).rematch).toBeNull();
    expect((await post(r, '/api/lobby/rematch', ca, { matchId: id })).json.error.code).toBe('no_rematch');
    db(r).run('DELETE FROM bots');
    expect((await view(r, ca)).rematch).not.toBeNull();
    // Both left, so nobody won or lost.
    db(r).run("UPDATE matches SET outcome = 'abandoned' WHERE id = ?", id);
    expect((await view(r, ca)).rematch).toBeNull();
    expect((await post(r, '/api/lobby/rematch', ca, { matchId: id })).json.error.code).toBe('no_rematch');
    // A cancelled match.
    db(r).run("UPDATE matches SET outcome = 'win', state = 'cancelled', cancel_reason = 'everyone_left' WHERE id = ?", id);
    expect((await post(r, '/api/lobby/rematch', cb, { matchId: id })).json.error.code).toBe('no_rematch');
  }, LONG);

  it('REMATCH-9: a rematch of a friend match is a friend match again (not ranked), and a stranger who searches meanwhile never lands in a rematch lobby', async () => {
    const { r, ca, cb } = await pair();
    const cc = await signUp(r, 'carol');
    await post(r, '/api/friends/request', ca, { username: 'bob' });
    await post(r, '/api/friends/accept', cb, { username: 'alice' });
    await listen(r, ca);
    await listen(r, cb); // both have the page open, so a challenge can be sent and answered
    expect((await post(r, '/api/challenges/send', ca, { username: 'bob' })).status).toBe(200);
    expect((await post(r, '/api/challenges/accept', cb, { username: 'alice' })).status).toBe(200);
    await post(r, '/api/lobby/ready', ca, { ready: true });
    const ready = await post(r, '/api/lobby/ready', cb, { ready: true });
    await gotoTick(r, ready.json.match.endTick + 12, [ca, cb]);
    const done = await view(r, ca);
    expect(done).toMatchObject({ phase: 'finished', friendMatch: true, ranked: false });
    expect(done.rematch).toMatchObject({ youAsked: false, theyAsked: false });
    await post(r, '/api/lobby/rematch', ca, { matchId: done.id });
    const again = (await post(r, '/api/lobby/rematch', cb, { matchId: done.id })).json.match;
    expect(again).toMatchObject({ phase: 'ready_check', friendMatch: true, ranked: false, isRematch: false });
    expect(db(r).get('SELECT rematch, friends FROM matches WHERE id = ?', again.id)).toEqual({ rematch: 0, friends: 1 });
    // A stranger looking for a match gets a lobby of his own.
    const stranger = await post(r, '/api/lobby/join', cc);
    expect(stranger.json.match.id).not.toBe(again.id);
    expect(stranger.json.match).toMatchObject({ phase: 'waiting', playerCount: 1, isRematch: false, friendMatch: false });
  }, LONG);

  it('REMATCH-10: a stranger who searches while two players sit in a rematch lobby never joins it', async () => {
    const { r, ca, cb } = await pair();
    const cc = await signUp(r, 'carol');
    const id = await playLobbyMatch(r, ca, cb);
    await post(r, '/api/lobby/rematch', ca, { matchId: id });
    const opened = (await post(r, '/api/lobby/rematch', cb, { matchId: id })).json.match;
    const stranger = await post(r, '/api/lobby/join', cc);
    expect(stranger.json.match.id).not.toBe(opened.id);
    expect(stranger.json.match).toMatchObject({ phase: 'waiting', playerCount: 1, isRematch: false });
    expect((await view(r, ca)).playerCount).toBe(2);
    // One of the two is busy in the rematch lobby, so he cannot be pulled into another match by searching: searching takes him out of the rematch, which cancels it.
    await post(r, '/api/lobby/leave', ca);
    expect((await view(r, cb))).toMatchObject({ phase: 'cancelled', cancelReason: 'rematch_left' });
  }, LONG);
});
