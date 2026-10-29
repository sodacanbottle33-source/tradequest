// The billboard the whole way round (server/billboard.ts, docs/world.md §30): a memecoin made through the real Launch tab shows up in the launcher's own list, he books it onto the
// billboard, and everybody sees it with its real name. (This needs the full-size market, which the other billboard tests do not, so it has its own file.)
import { describe, expect, it } from 'vitest';
import { LONG, db, liveRig } from './helpers/chatlive';

const { boot, call, signUp } = liveRig('billboard-launch', 'boss', '66');

describe('the whole way round', () => {
  it('BILL-13: a memecoin launched through the real Launch tab appears in the player\'s own list, can be booked, and is shown to everybody with its real name', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    db(r).run("UPDATE accounts SET cash_cents = 10000000 WHERE kind = 'career' AND user_id = (SELECT id FROM users WHERE username = 'alice')");
    const launched = await call(r, '/api/launch/coin', { method: 'POST', cookie: alice, body: { requestId: 'req-launch-1-abcdef', name: 'Moon Pepe', ticker: 'MPEP', seedCents: 0 } });
    expect(launched.status).toBe(200);
    const mine = (await call(r, '/api/billboard', { cookie: alice })).json.mine;
    expect(mine.launched).toEqual([{ ticker: 'MPEP', name: 'Moon Pepe', kind: 'coin' }]);
    const done = await call(r, '/api/billboard/book', { method: 'POST', cookie: alice, body: { slot: 1, ticker: 'MPEP', hours: 1 } });
    expect(done.status).toBe(200);
    expect((await call(r, '/api/billboard')).json.slots[0].rental).toMatchObject({ ticker: 'MPEP', name: 'Moon Pepe', byUsername: 'alice' });
  }, LONG);
});
