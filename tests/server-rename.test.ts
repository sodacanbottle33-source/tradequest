// Changing your username (server/rename.ts, docs/world.md §25): $4,000 of Career cash, once every 7 days. The new name follows the sign-up rules plus a few
// more; the old name is kept for its owner for 30 days; the owner (whose name is a server setting) and the computer players cannot change theirs; and
// everything the player has (money, friends, groups, messages, badges, role) stays with him because it follows his number, not his name.
import { describe, expect, it } from 'vitest';
import { NAME_KEPT_MS } from '../server/auth';
import { RENAME_COST_CENTS, RENAME_WAIT_MS } from '../server/rename';
import { LONG, ageAccounts, db, idOf, liveRig, png, dataUrl, requestId, until, type Running } from './helpers/chatlive';

const { boot, call, signUp, login, listen } = liveRig('rename');

const rename = (r: Running, cookie: string | undefined, username: unknown) => call(r, '/api/account/username', { method: 'POST', cookie, body: { username } });
const status = async (r: Running, cookie: string) => (await call(r, '/api/account/username', { cookie })).json;
const cash = (r: Running, name: string): number => db(r).get<{ c: number }>("SELECT a.cash_cents AS c FROM accounts a JOIN users u ON u.id = a.user_id WHERE u.username = ? AND a.kind = 'career'", name)?.c as number;
const setCash = (r: Running, name: string, cents: number): void => {
  db(r).run("UPDATE accounts SET cash_cents = ? WHERE kind = 'career' AND user_id = (SELECT id FROM users WHERE username = ?)", cents, name);
};
const nameOf = async (r: Running, cookie: string): Promise<string | undefined> => (await call(r, '/api/me', { cookie })).json.user?.username;
const ask = (r: Running, cookie: string, path: string, name: string) => call(r, `/api/friends/${path}`, { method: 'POST', cookie, body: { username: name } });
async function befriend(r: Running, a: string, aName: string, b: string, bName: string): Promise<void> {
  expect((await ask(r, a, 'request', bName)).status).toBe(200);
  expect((await ask(r, b, 'accept', aName)).status).toBe(200);
}
const DAY = 86_400;

async function world(r: Running) {
  const [alice, bob, carol, boss, mia] = [await signUp(r, 'alice'), await signUp(r, 'bob'), await signUp(r, 'carol'), await signUp(r, 'boss'), await signUp(r, 'mia')];
  ageAccounts(r);
  expect((await call(r, '/api/admin/moderator', { method: 'POST', cookie: boss, body: { requestId: requestId(), username: 'mia', on: true } })).status).toBe(200);
  for (const name of ['alice', 'bob', 'carol', 'mia']) setCash(r, name, 1_000_000); // $10,000
  return { alice, bob, carol, boss, mia };
}

describe('changing the username', () => {
  it('NAME-1: both routes need a signed-in player; the page can ask what it costs and whether he may', async () => {
    const r = await boot();
    const { alice } = await world(r);
    expect((await call(r, '/api/account/username')).status).toBe(401);
    expect((await rename(r, undefined, 'newname')).status).toBe(401);
    expect(await status(r, alice)).toEqual({ costCents: RENAME_COST_CENTS, waitMs: RENAME_WAIT_MS, canChange: true, reason: null, nextAllowedMs: null, cashCents: 1_000_000, lastChangeMs: null });
    expect(RENAME_COST_CENTS).toBe(400_000);
    expect(RENAME_WAIT_MS).toBe(7 * DAY * 1000);
    // With too little Career cash the page is told why (and the cash).
    setCash(r, 'alice', 399_999);
    const poor = await status(r, alice);
    expect([poor.canChange, poor.nextAllowedMs]).toEqual([false, null]);
    expect(poor.reason).toMatch(/costs \$4,000 of Career cash, and you have \$3,999\.99/);
  }, LONG);

  it('NAME-2: the new name costs $4,000 of Career cash, the session stays valid, the old name stops working at login and everybody is told', async () => {
    const r = await boot();
    const { alice, bob } = await world(r);
    const watching = await listen(r, bob);
    const before = idOf(r, 'alice');
    const done = await rename(r, alice, 'alicia');
    expect(done.status).toBe(200);
    expect(done.json).toMatchObject({ username: 'alicia', previous: 'alice', costCents: 400_000, cashCents: 600_000, nextAllowedMs: r.clock.now() + RENAME_WAIT_MS, user: { id: before, username: 'alicia', displayName: 'alicia', role: 'player' } });
    expect(cash(r, 'alicia')).toBe(600_000);
    expect(idOf(r, 'alicia')).toBe(before);
    expect(await nameOf(r, alice)).toBe('alicia');
    expect((await login(r, 'alicia')).status).toBe(200);
    expect((await login(r, 'alice')).status).toBe(401);
    expect(await until(() => watching.text().includes('event: user_renamed'))).toBe(true);
    expect(watching.text()).toMatch(/"from":"alice","to":"alicia"/);
    expect(db(r).all('SELECT old_name, new_name, cost_cents FROM username_changes')).toEqual([{ old_name: 'alice', new_name: 'alicia', cost_cents: 400_000 }]);
    // The page shows the wait.
    const s = await status(r, alice);
    expect([s.canChange, s.nextAllowedMs, s.lastChangeMs]).toEqual([false, r.clock.now() + RENAME_WAIT_MS, r.clock.now()]);
    expect(s.reason).toMatch(/again in 7 days/);
  }, LONG);

  it('NAME-3: only once every 7 days, the money is checked at the moment he asks, and a refused try costs nothing and does not use up the week', async () => {
    const r = await boot();
    const { alice } = await world(r);
    // Refused tries change nothing.
    setCash(r, 'alice', 399_999);
    const poor = await rename(r, alice, 'alicia');
    expect([poor.status, poor.json.error.code, poor.json.error.details]).toEqual([400, 'not_enough_cash', { cashCents: 399_999, needCents: 400_000 }]);
    expect([await nameOf(r, alice), cash(r, 'alice'), db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM username_changes')?.n]).toEqual(['alice', 399_999, 0]);
    expect((await rename(r, alice, 'no')).json.error.code).toBe('bad_username');
    // Exactly the price is enough.
    setCash(r, 'alice', 400_000);
    expect((await rename(r, alice, 'alicia')).status).toBe(200);
    expect(cash(r, 'alicia')).toBe(0);
    // A week has not passed.
    setCash(r, 'alicia', 1_000_000);
    const soon = await rename(r, alice, 'alice2');
    expect([soon.status, soon.json.error.code, soon.json.error.details.nextAllowedMs]).toEqual([429, 'too_soon', r.clock.now() + RENAME_WAIT_MS]);
    expect(soon.json.error.message).toMatch(/again in 7 days/);
    r.clock.advanceSeconds(7 * DAY - 1);
    expect((await rename(r, alice, 'alice2')).json.error.code).toBe('too_soon');
    expect(cash(r, 'alicia')).toBe(1_000_000);
    r.clock.advanceSeconds(1);
    expect((await rename(r, alice, 'alice2')).status).toBe(200);
    expect([await nameOf(r, alice), cash(r, 'alice2')]).toEqual(['alice2', 600_000]);
    expect(db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM username_changes')?.n).toBe(2);
    // Asking twice at the same moment (a double click): one change only.
    r.clock.advanceSeconds(7 * DAY);
    const two = await Promise.all([rename(r, alice, 'first_one'), rename(r, alice, 'second_one')]);
    expect(two.map((x) => x.status).sort()).toEqual([200, 429]);
    expect(db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM username_changes')?.n).toBe(3);
    expect(cash(r, await nameOf(r, alice) as string)).toBe(200_000);
  }, LONG);

  it('NAME-4: the new name follows the sign-up rules, cannot be taken, and nobody may take an official-sounding name or the owner\'s', async () => {
    const r = await boot();
    const { alice, bob } = await world(r);
    const bad: [string, unknown, number, string][] = [
      ['not text', 42, 400, 'bad_request'],
      ['nothing', '', 400, 'bad_username'],
      ['too short', 'ab', 400, 'bad_username'],
      ['too long', 'x'.repeat(21), 400, 'bad_username'],
      ['a space', 'two words', 400, 'bad_username'],
      ['a symbol', 'name!', 400, 'bad_username'],
      ['dashes', 'my-name', 400, 'bad_username'],
      ['the same name', 'alice', 400, 'same_name'],
      ['taken', 'bob', 409, 'username_taken'],
      ['taken in other letters', 'BOB', 409, 'username_taken'],
      ['the owner\'s name (he has not even signed up)', 'BOSS', 409, 'username_taken'],
      ['staff sounding', 'Admin', 409, 'name_reserved'],
      ['staff sounding 2', 'moderator', 409, 'name_reserved'],
      ['staff sounding 3', 'SUPPORT', 409, 'name_reserved'],
      ['the game', 'TradeQuest', 409, 'name_reserved'],
    ];
    for (const [what, name, status, code] of bad) {
      const res = await rename(r, alice, name);
      expect([what, res.status, res.json.error.code]).toEqual([what, status, code]);
      r.clock.advanceSeconds(11); // (the page may try 6 times a minute)
    }
    expect([await nameOf(r, alice), cash(r, 'alice'), await nameOf(r, bob)]).toEqual(['alice', 1_000_000, 'bob']);
    // Letters, numbers and underscores of 3 to 20 are fine, also just a change of capital letters.
    expect((await rename(r, alice, 'A_1')).status).toBe(200);
    r.clock.advanceSeconds(7 * DAY);
    setCash(r, 'A_1', 1_000_000);
    expect((await rename(r, alice, 'a'.repeat(20))).status).toBe(200);
    r.clock.advanceSeconds(7 * DAY);
    setCash(r, 'a'.repeat(20), 1_000_000);
    expect((await rename(r, alice, 'AAAAAAAAAAAAAAAAAAAA')).status).toBe(200);
    expect(await nameOf(r, alice)).toBe('AAAAAAAAAAAAAAAAAAAA');
    expect((await login(r, 'aaaaaaaaaaaaaaaaaaaa')).status).toBe(200);
  }, LONG);

  it('NAME-5: a name somebody left is kept for him for 30 days, at sign-up and at a change; he can take it back himself; after 30 days it is free', async () => {
    const r = await boot();
    const { alice, carol } = await world(r);
    expect((await rename(r, alice, 'alicia')).status).toBe(200);
    // Nobody else can sign up with it or change to it for 30 days.
    const signup = await fetch(r.base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'ALICE', password: 'a-good-password' }) });
    expect(signup.status).toBe(409);
    const grab = await rename(r, carol, 'alice');
    expect([grab.status, grab.json.error.code]).toEqual([409, 'name_reserved']);
    expect(grab.json.error.message).toMatch(/kept for them/);
    // He can have it back after his week (and pays again).
    r.clock.advanceSeconds(7 * DAY);
    const back = await rename(r, alice, 'alice');
    expect([back.status, back.json.username]).toEqual([200, 'alice']);
    // The name he just left is kept for him in turn.
    expect((await rename(r, carol, 'alicia')).json.error.code).toBe('name_reserved');
    // 30 days after he left 'alicia' the name is free.
    r.clock.advanceSeconds(NAME_KEPT_MS / 1000);
    db(r).run('UPDATE sessions SET expires_ms = expires_ms + ?', 40 * DAY * 1000); // (a session lasts 30 days)
    expect((await rename(r, carol, 'alicia')).status).toBe(200);
    const late = await fetch(r.base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'someone_new', password: 'a-good-password' }) });
    expect(late.status).toBe(201);
  }, LONG);

  it('NAME-6: the owner\'s name is a server setting so he cannot change it here; a computer player cannot; a moderator can and stays a moderator', async () => {
    const r = await boot();
    const { boss, mia, bob } = await world(r);
    const refused = await rename(r, boss, 'bigboss');
    expect([refused.status, refused.json.error.code]).toEqual([403, 'cannot_rename']);
    expect(refused.json.error.message).toMatch(/set on the server/);
    expect(await nameOf(r, boss)).toBe('boss');
    const s = await status(r, boss);
    expect(s.canChange).toBe(false);
    expect(s.reason).toMatch(/set on the server/);
    // A moderator keeps the role: it follows his number.
    expect((await rename(r, mia, 'mia_mod')).status).toBe(200);
    expect((await call(r, '/api/me', { cookie: mia })).json.user).toMatchObject({ username: 'mia_mod', role: 'moderator' });
    // A computer player.
    const botId = db(r).run("INSERT INTO users(username, display_name, pw_hash, role, created_ms) VALUES ('robot', 'robot', 'bot', 'player', 0)").lastInsertRowid;
    db(r).run("INSERT INTO bots(user_id, persona) VALUES (?, 'test')", botId);
    expect(r.app.services.renames.status(r.app.services.auth.userById(botId) as any).canChange).toBe(false);
    expect(() => r.app.services.renames.change(r.app.services.auth.userById(botId) as any, 'robot2')).toThrow(/keep their names/);
    expect(bob).toBeTruthy();
  }, LONG);

  it('NAME-7: money, shares, friends, groups, messages, chat lines, badges and pictures stay with him under the new name', async () => {
    const r = await boot();
    const { alice, bob } = await world(r);
    await befriend(r, alice, 'alice', bob, 'bob');
    const me = idOf(r, 'alice');
    // A group, a private message, a line in the room, a badge, a picture of him, and a share bought.
    const group = (await call(r, '/api/messages/group/create', { method: 'POST', cookie: alice, body: { title: 'club', usernames: ['bob'] } })).json.conversation;
    expect((await call(r, '/api/messages/group/join', { method: 'POST', cookie: bob, body: { conversationId: group.id } })).status).toBe(404); // private: cannot be joined
    expect((await call(r, '/api/messages/respond', { method: 'POST', cookie: bob, body: { conversationId: group.id, answer: 'accept' } })).status).toBe(200);
    expect((await call(r, '/api/messages/send', { method: 'POST', cookie: alice, body: { conversationId: group.id, text: 'before the change' } })).status).toBe(200);
    expect((await call(r, '/api/chat/send', { method: 'POST', cookie: alice, body: { text: 'hello room' } })).status).toBe(200);
    db(r).run("INSERT INTO user_badges(user_id, badge, earned_ms) VALUES (?, 'welcome', ?)", me, r.clock.now());
    const avatar = await call(r, '/api/profile/avatar', { method: 'POST', cookie: alice, body: { image: dataUrl('image/png', png(64, 64, 50)) } });
    expect(avatar.status).toBe(200);
    expect(Object.keys((await call(r, '/api/avatars', { cookie: bob })).json.avatars)).toEqual(['alice']);
    r.clock.advanceSeconds(3);

    expect((await rename(r, alice, 'alicia')).status).toBe(200);
    // Money
    expect(cash(r, 'alicia')).toBe(600_000);
    // Friends
    expect((await call(r, '/api/friends', { cookie: bob })).json.friends.map((f: any) => f.username)).toEqual(['alicia']);
    // The group and what was said in it
    const seen = (await call(r, '/api/messages', { cookie: bob })).json;
    expect(seen.conversations[0]).toMatchObject({ id: group.id, creator: 'alicia', last: { username: 'alicia', text: 'before the change' } });
    expect(seen.conversations[0].members.map((m: any) => m.username).sort()).toEqual(['alicia', 'bob']);
    // The room
    expect((await call(r, '/api/chat', { cookie: bob })).json.messages.map((m: any) => [m.username, m.displayName, m.text])).toEqual([['alicia', 'alicia', 'hello room']]);
    // Badge and picture
    expect(db(r).get<{ badge: string }>('SELECT badge FROM user_badges WHERE user_id = ?', me)?.badge).toBe('welcome');
    expect(Object.keys((await call(r, '/api/avatars', { cookie: bob })).json.avatars)).toEqual(['alicia']);
    expect((await call(r, '/api/avatar/alicia', { cookie: bob })).status).toBe(200);
    expect((await call(r, '/api/avatar/alice', { cookie: bob })).status).toBe(404);
    // She can still write in the group as herself.
    r.clock.advanceSeconds(3);
    const after = await call(r, '/api/messages/send', { method: 'POST', cookie: alice, body: { conversationId: group.id, text: 'after the change' } });
    expect([after.status, after.json.message.username]).toEqual([200, 'alicia']);
    expect(await nameOf(r, alice)).toBe('alicia');
  }, LONG);

  it('NAME-8: the owner and the moderators see "was called ..." for 30 days after a change, and can find the player by his old name', async () => {
    const r = await boot();
    const { alice, boss, mia } = await world(r);
    expect((await rename(r, alice, 'alicia')).status).toBe(200);
    r.clock.advanceSeconds(7 * DAY);
    expect((await rename(r, alice, 'ally')).status).toBe(200);
    const owner = (await call(r, '/api/admin/state?q=alice', { cookie: boss })).json.players;
    expect(owner.map((p: any) => [p.username, p.formerNames])).toEqual([['ally', ['alicia', 'alice']]]);
    const staff = (await call(r, '/api/mod/players?q=alicia', { cookie: mia })).json.players;
    expect(staff.map((p: any) => [p.username, p.formerNames])).toEqual([['ally', ['alicia', 'alice']]]);
    expect((await call(r, '/api/mod/players?q=bob', { cookie: mia })).json.players.map((p: any) => p.formerNames)).toEqual([[]]);
    // After 30 days the old names are forgotten.
    r.clock.advanceSeconds(NAME_KEPT_MS / 1000);
    db(r).run('UPDATE sessions SET expires_ms = expires_ms + ?', 40 * DAY * 1000);
    expect((await call(r, '/api/mod/players?q=alicia', { cookie: mia })).json.players).toEqual([]);
    expect((await call(r, '/api/mod/players?q=ally', { cookie: mia })).json.players[0].formerNames).toEqual([]);
  }, LONG);

  it('NAME-9: a player can only try so often (6 in a minute), and a change is written once to the log of changes', async () => {
    const r = await boot();
    const { alice } = await world(r);
    let last = 0;
    for (let i = 0; i < 6; i += 1) last = (await rename(r, alice, 'no')).status;
    expect(last).toBe(400);
    const slow = await rename(r, alice, 'no');
    expect([slow.status, slow.json.error.code]).toEqual([429, 'rate_limited']);
    r.clock.advanceSeconds(61);
    expect((await rename(r, alice, 'fine_name')).status).toBe(200);
    expect(db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM username_changes')?.n).toBe(1);
  }, LONG);
});
