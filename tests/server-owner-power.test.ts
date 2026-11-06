// What the owner can do about bad players, added in the penny-stock update: a banned player is moved to a "Banned" list (so the main lists show only the
// players who are in the game), the owner can give any ordinary player a new username, and the owner can delete a private or group message that a player
// reported. Private chats stay private: the owner still reads only what players report, never a conversation. Moderators keep what they had (they can
// find and lift bans, and delete in the public chat) and gain none of the new owner powers.
import { describe, expect, it } from 'vitest';
import { NAME_KEPT_MS } from '../server/auth';
import { RENAME_WAIT_MS } from '../server/rename';
import { LONG, ageAccounts, db, idOf, liveRig, requestId, until, type Running } from './helpers/chatlive';

const { boot, call, signUp, login, listen } = liveRig('owner-power');

const DAY = 86_400;
const post = (r: Running, cookie: string | undefined, path: string, body: unknown = {}) => call(r, path, { method: 'POST', cookie, body: { requestId: requestId(), ...(body as object) } });
const names = (list: any[]): string[] => list.map((p) => p.username);
const state = async (r: Running, cookie: string, q = '') => (await call(r, `/api/admin/state${q === '' ? '' : `?q=${encodeURIComponent(q)}`}`, { cookie })).json;
const staffList = async (r: Running, cookie: string, banned: boolean, q = '') => (await call(r, `/api/mod/players?banned=${banned ? 1 : 0}&q=${encodeURIComponent(q)}`, { cookie })).json.players as any[];

async function world(r: Running) {
  const [alice, bob, carol, boss, mia] = [await signUp(r, 'alice'), await signUp(r, 'bob'), await signUp(r, 'carol'), await signUp(r, 'boss'), await signUp(r, 'mia')];
  ageAccounts(r);
  expect((await post(r, boss, '/api/admin/moderator', { username: 'mia', on: true })).status).toBe(200);
  return { alice, bob, carol, boss, mia };
}

describe('the Banned list', () => {
  it('OWNP-1: a ban moves the player from the main list to the Banned list, unbanning moves him back, and a kick leaves him where he is', async () => {
    const r = await boot();
    const { boss } = await world(r);
    const before = await state(r, boss);
    expect(names(before.players)).toEqual(['alice', 'bob', 'carol', 'boss', 'mia']);
    expect(before.bannedPlayers).toEqual([]);

    expect((await post(r, boss, '/api/admin/ban', { username: 'alice', reason: 'cheating' })).status).toBe(200);
    const banned = await state(r, boss);
    expect(names(banned.players)).toEqual(['bob', 'carol', 'boss', 'mia']);
    expect(names(banned.bannedPlayers)).toEqual(['alice']);
    expect(banned.bannedPlayers[0]).toMatchObject({ username: 'alice', banned: { kind: 'ban', reason: 'cheating' } });
    expect(typeof banned.bannedPlayers[0].cashCents).toBe('number'); // the owner still sees what he needs to reset or fix an account

    // A kick is short and he comes back by himself: he stays in the main list.
    expect((await post(r, boss, '/api/admin/kick', { username: 'bob', minutes: 10, reason: 'calm down' })).status).toBe(200);
    const kicked = await state(r, boss);
    expect(names(kicked.players)).toEqual(['bob', 'carol', 'boss', 'mia']);
    expect(names(kicked.bannedPlayers)).toEqual(['alice']);
    expect(kicked.players[0].banned).toMatchObject({ kind: 'kick' });

    // Unbanning puts him back.
    expect((await post(r, boss, '/api/admin/unban', { username: 'alice' })).status).toBe(200);
    const back = await state(r, boss);
    expect(names(back.players)).toEqual(['alice', 'bob', 'carol', 'boss', 'mia']);
    expect(back.bannedPlayers).toEqual([]);
  }, LONG);

  it('OWNP-2: a timed ban sends him to the Banned list and, when the time is over, back to the main list by itself; the search works in both lists', async () => {
    const r = await boot();
    const { boss } = await world(r);
    expect((await post(r, boss, '/api/admin/ban', { username: 'alice', reason: 'rude', hours: 2 })).status).toBe(200);
    expect((await post(r, boss, '/api/admin/ban', { username: 'carol', reason: 'spam' })).status).toBe(200);
    expect(names((await state(r, boss)).bannedPlayers).sort()).toEqual(['alice', 'carol']);
    // Search: each list looks only at its own players.
    expect(names((await state(r, boss, 'ali')).bannedPlayers)).toEqual(['alice']);
    expect((await state(r, boss, 'ali')).players).toEqual([]);
    expect(names((await state(r, boss, 'bo')).players)).toEqual(['bob', 'boss']);
    expect((await state(r, boss, 'bo')).bannedPlayers).toEqual([]);
    // Two hours later the ban of alice is over (carol's is for good).
    r.clock.advanceSeconds(2 * 3600 + 1);
    db(r).run('UPDATE sessions SET expires_ms = expires_ms + ?', 3 * DAY * 1000);
    const later = await state(r, boss);
    expect(names(later.bannedPlayers)).toEqual(['carol']);
    expect(names(later.players)).toContain('alice');
    expect(names(later.players)).not.toContain('carol');
    // A player found by an old name is found in the right list.
    expect((await post(r, boss, '/api/admin/rename', { username: 'carol', newUsername: 'carla' })).status).toBe(200);
    expect(names((await state(r, boss, 'carol')).bannedPlayers)).toEqual(['carla']);
    expect((await state(r, boss, 'carol')).players).toEqual([]);
  }, LONG);

  it('OWNP-3: moderators get the same two lists (names only), can still find and unban a banned player, and the banned player stays out of the game', async () => {
    const r = await boot();
    const { boss, mia, alice } = await world(r);
    expect(names(await staffList(r, mia, false))).toEqual(['mia', 'boss', 'carol', 'bob', 'alice']);
    expect((await post(r, mia, '/api/admin/ban', { username: 'alice', reason: 'rude', hours: 24 })).status).toBe(200);
    expect(names(await staffList(r, mia, false))).toEqual(['mia', 'boss', 'carol', 'bob']);
    const banned = await staffList(r, mia, true);
    expect(names(banned)).toEqual(['alice']);
    expect(banned[0]).toMatchObject({ username: 'alice', banned: { kind: 'ban' } });
    expect(JSON.stringify(banned)).not.toMatch(/cash/i); // moderators never see money
    expect(names(await staffList(r, mia, true, 'bob'))).toEqual([]);
    expect(names(await staffList(r, mia, false, 'alice'))).toEqual([]);
    // The route needs staff.
    expect((await call(r, '/api/mod/players?banned=1', { cookie: alice })).status).toBeGreaterThanOrEqual(401);
    expect((await call(r, '/api/mod/players?banned=1')).status).toBe(401);
    // He cannot sign in or use his old session while banned, and the moderator can lift it.
    expect((await call(r, '/api/me', { cookie: alice })).json.user).toBeNull();
    expect((await login(r, 'alice')).status).toBe(403);
    expect((await post(r, mia, '/api/admin/unban', { username: 'alice' })).status).toBe(200);
    expect(names(await staffList(r, mia, true))).toEqual([]);
    expect(names(await staffList(r, mia, false))).toContain('alice');
    expect((await login(r, 'alice')).status).toBe(200);
    expect(boss).toBeTruthy();
  }, LONG);
});

describe('changing somebody else\'s username', () => {
  const rename = (r: Running, cookie: string | undefined, username: unknown, newUsername: unknown, id: unknown = requestId()) => call(r, '/api/admin/rename', { method: 'POST', cookie, body: { requestId: id, username, newUsername } });

  it('OWNP-4: the owner gives a player a new name at no cost; his session, money, friends and groups stay, and the old name is kept for him for 30 days', async () => {
    const r = await boot();
    const { alice, bob, boss, mia } = await world(r);
    expect((await call(r, '/api/friends/request', { method: 'POST', cookie: alice, body: { username: 'bob' } })).status).toBe(200);
    expect((await call(r, '/api/friends/accept', { method: 'POST', cookie: bob, body: { username: 'alice' } })).status).toBe(200);
    const cash = (name: string): number => db(r).get<{ c: number }>("SELECT a.cash_cents AS c FROM accounts a JOIN users u ON u.id = a.user_id WHERE u.username = ? AND a.kind = 'career'", name)?.c as number;
    const money = cash('alice');
    const id = idOf(r, 'alice');
    const watching = await listen(r, bob);

    const done = await rename(r, boss, 'alice', 'alicia');
    expect([done.status, done.json]).toEqual([200, { ok: true, duplicate: false, username: 'alicia', previous: 'alice' }]);
    expect(idOf(r, 'alicia')).toBe(id);
    expect(db(r).get<{ username: string; display_name: string }>('SELECT username, display_name FROM users WHERE id = ?', id)).toEqual({ username: 'alicia', display_name: 'alicia' });
    expect(cash('alicia')).toBe(money); // free
    // She is not signed out; she signs in under the new name only.
    expect((await call(r, '/api/me', { cookie: alice })).json.user).toMatchObject({ id, username: 'alicia' });
    expect((await login(r, 'alicia')).status).toBe(200);
    expect((await login(r, 'alice')).status).toBe(401);
    // Friends see the new name; every page is told.
    expect((await call(r, '/api/friends', { cookie: bob })).json.friends.map((f: any) => f.username)).toEqual(['alicia']);
    expect(await until(() => watching.text().includes('event: user_renamed'))).toBe(true);
    expect(watching.text()).toMatch(/"from":"alice","to":"alicia"/);
    // One row in the list of name changes (cost 0) and one in the admin log, under the owner's name.
    expect(db(r).all('SELECT old_name, new_name, cost_cents FROM username_changes')).toEqual([{ old_name: 'alice', new_name: 'alicia', cost_cents: 0 }]);
    expect(db(r).all("SELECT action, target, detail_json FROM admin_log WHERE action = 'user_rename'").map((l: any) => [l.target, JSON.parse(l.detail_json)])).toEqual([['alice', { from: 'alice', to: 'alicia' }]]);
    expect((await call(r, '/api/admin/log', { cookie: boss })).json.log?.[0]?.action ?? 'user_rename').toBe('user_rename');
    // The old name is kept for her: nobody else can take it for 30 days, she can search by it, and after 30 days it is free.
    const taken = await call(r, '/api/auth/register', { method: 'POST', body: { username: 'alice', password: 'a-good-password' } });
    expect([taken.status, taken.json.error.code]).toEqual([409, 'username_taken']);
    expect(names((await state(r, boss, 'alice')).players)).toEqual(['alicia']);
    expect((await state(r, boss, 'alice')).players[0].formerNames).toEqual(['alice']);
    expect((await staffList(r, mia, false, 'alice')).map((p) => [p.username, p.formerNames])).toEqual([['alicia', ['alice']]]);
    db(r).run('UPDATE sessions SET expires_ms = expires_ms + ?', 40 * DAY * 1000);
    r.clock.advanceSeconds(NAME_KEPT_MS / 1000 + 1);
    expect((await state(r, boss, 'alice')).players).toEqual([]);
    // Her own wait before she changes it herself starts too, like after any change.
    const own = await call(r, '/api/account/username', { cookie: alice });
    expect([own.json.canChange, own.json.waitMs]).toEqual([false, RENAME_WAIT_MS]);
  }, LONG);

  it('OWNP-5: only the owner can do it; the new name follows the same rules as a name a player picks; the owner, computer players and strangers are refused; nothing changes on a refusal', async () => {
    const r = await boot();
    const { alice, bob, boss, mia } = await world(r);
    // Who may.
    expect((await rename(r, undefined, 'alice', 'alicia')).status).toBe(401);
    for (const [who, cookie] of [['player', bob], ['moderator', mia]] as const) {
      const out = await rename(r, cookie, 'alice', 'alicia');
      expect([who, out.status, out.json.error.code]).toEqual([who, 403, 'owner_only']);
    }
    // Which names.
    const bad: Record<string, [number, string]> = {
      no: [400, 'bad_username'],
      'has space': [400, 'bad_username'],
      [`${'x'.repeat(21)}`]: [400, 'bad_username'],
      alice: [400, 'same_name'],
      bob: [409, 'username_taken'],
      boss: [409, 'username_taken'],
      Admin: [409, 'name_reserved'],
      moderator: [409, 'name_reserved'],
    };
    for (const [name, [status, code]] of Object.entries(bad)) {
      const out = await rename(r, boss, 'alice', name);
      expect([name, out.status, out.json.error.code]).toEqual([name, status, code]);
    }
    // A name somebody left a short while ago is kept for him.
    expect((await rename(r, boss, 'bob', 'bobby')).status).toBe(200);
    const kept = await rename(r, boss, 'alice', 'bob');
    expect([kept.status, kept.json.error.code]).toEqual([409, 'name_reserved']);
    // Who cannot be renamed.
    const own = await rename(r, boss, 'boss', 'bigboss');
    expect([own.status, own.json.error.code]).toEqual([403, 'cannot_rename']);
    const botId = db(r).run("INSERT INTO users(username, display_name, pw_hash, role, created_ms) VALUES ('robot', 'robot', 'bot', 'player', 0)").lastInsertRowid;
    db(r).run("INSERT INTO bots(user_id, persona) VALUES (?, 'test')", botId);
    const bot = await rename(r, boss, 'robot', 'robot2');
    expect([bot.status, bot.json.error.code]).toEqual([403, 'cannot_rename']);
    for (const missing of ['nobody', '', '   ', 'x'.repeat(60)]) expect([missing, (await rename(r, boss, missing, 'fine_name')).status]).toEqual([missing, 404]);
    // Bad input.
    expect((await rename(r, boss, 'alice', 'fine_name', 'short')).status).toBe(400);
    expect((await rename(r, boss, 'alice', 'fine_name', null)).status).toBe(400);
    expect((await rename(r, boss, 42, 'fine_name')).status).toBe(400);
    expect((await rename(r, boss, 'alice', 42)).status).toBe(400);
    // A moderator can be renamed (he keeps the job); the "@" in front of the name is allowed in the box.
    const mod = await rename(r, boss, '@mia', 'mia_mod');
    expect([mod.status, mod.json.username]).toEqual([200, 'mia_mod']);
    expect((await call(r, '/api/me', { cookie: mia })).json.user).toMatchObject({ username: 'mia_mod', role: 'moderator' });
    // Nothing changed for alice through all of that.
    expect(db(r).all("SELECT username FROM users WHERE id = ?", idOf(r, 'alice'))).toEqual([{ username: 'alice' }]);
    expect((await call(r, '/api/me', { cookie: alice })).json.user.username).toBe('alice');
    expect(db(r).get<{ n: number }>("SELECT COUNT(*) AS n FROM admin_log WHERE action = 'user_rename'")?.n).toBe(2); // only bobby and mia_mod
  }, LONG);

  it('OWNP-6: the same request twice renames once and answers the same; the old name is not looked up the second time', async () => {
    const r = await boot();
    const { boss } = await world(r);
    const id = 'owner-rename-0001';
    const first = await rename(r, boss, 'alice', 'alicia', id);
    expect(first.json).toEqual({ ok: true, duplicate: false, username: 'alicia', previous: 'alice' });
    const again = await rename(r, boss, 'alice', 'alicia', id);
    expect([again.status, again.json]).toEqual([200, { ok: true, duplicate: true, username: 'alicia', previous: 'alice' }]);
    expect(db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM username_changes')?.n).toBe(1);
    expect(db(r).get<{ n: number }>("SELECT COUNT(*) AS n FROM admin_log WHERE action = 'user_rename'")?.n).toBe(1);
    // A new request for the old name finds nobody (the player has the new name now).
    expect((await rename(r, boss, 'alice', 'another_one')).status).toBe(404);
    // The same request number for a different action is refused, not applied.
    const clash = await post(r, boss, '/api/admin/ban', { username: 'bob', reason: 'x', requestId: id });
    expect(clash.status).toBeGreaterThanOrEqual(400);
    expect(db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM user_bans')?.n).toBe(0);
  }, LONG);
});

describe('deleting a reported private message', () => {
  const del = (r: Running, cookie: string | undefined, messageId: unknown, id: unknown = requestId()) => call(r, '/api/admin/private-reports/delete', { method: 'POST', cookie, body: { requestId: id, messageId } });
  const msg = (r: Running, cookie: string, path: string, body: unknown) => call(r, `/api/messages/${path}`, { method: 'POST', cookie, body });
  const reports = async (r: Running, boss: string) => (await call(r, '/api/admin/private-reports', { cookie: boss })).json.reports as any[];
  const lines = async (r: Running, cookie: string, conversationId: number): Promise<string[]> => (await call(r, `/api/messages/thread/${conversationId}`, { cookie })).json.messages.map((m: any) => m.text);
  async function tell(r: Running, cookie: string, to: string | number, text: string): Promise<{ id: number; conversationId: number }> {
    const out = await msg(r, cookie, 'send', typeof to === 'number' ? { conversationId: to, text } : { username: to, text });
    expect(out.status).toBe(200);
    r.clock.advanceSeconds(2);
    return { id: out.json.message.id, conversationId: out.json.conversationId ?? out.json.message.conversationId ?? to };
  }
  async function befriend(r: Running, a: string, aName: string, b: string, bName: string) {
    expect((await call(r, '/api/friends/request', { method: 'POST', cookie: a, body: { username: bName } })).status).toBe(200);
    expect((await call(r, '/api/friends/accept', { method: 'POST', cookie: b, body: { username: aName } })).status).toBe(200);
  }
  async function trio(r: Running) {
    const w = await world(r);
    await befriend(r, w.alice, 'alice', w.bob, 'bob');
    await befriend(r, w.alice, 'alice', w.carol, 'carol');
    const id = (await msg(r, w.alice, 'group/create', { title: 'trio', usernames: ['bob', 'carol'] })).json.conversation.id as number;
    await msg(r, w.bob, 'respond', { conversationId: id, answer: 'accept' });
    r.clock.advanceSeconds(1);
    await msg(r, w.carol, 'respond', { conversationId: id, answer: 'accept' });
    return { ...w, id };
  }

  it('OWNP-7: the owner deletes a reported group message: it disappears for every member at once, the report is closed, and it is logged', async () => {
    const r = await boot();
    const { alice, bob, carol, boss, id } = await trio(r);
    await tell(r, alice, id, 'hello all');
    const rude = await tell(r, bob, id, 'rude words');
    await tell(r, alice, id, 'a later line');
    expect((await msg(r, carol, 'report', { messageId: rude.id })).status).toBe(200);
    expect((await reports(r, boss)).map((x) => x.messageId)).toEqual([rude.id]);
    const [forAlice, forBob, outsider] = [await listen(r, alice), await listen(r, bob), await listen(r, await signUp(r, 'dave'))];

    const done = await del(r, boss, rude.id, 'owner-delete-0001');
    expect([done.status, done.json]).toEqual([200, { ok: true, duplicate: false }]);
    for (const [who, cookie] of [['alice', alice], ['bob', bob], ['carol', carol]] as const) expect([who, await lines(r, cookie, id)]).toEqual([who, ['hello all', 'a later line']]);
    // The report is closed, so it leaves the owner's list, and the owner never saw anything but that report.
    expect(await reports(r, boss)).toEqual([]);
    expect(db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM private_reports WHERE resolved_ms IS NULL')?.n).toBe(0);
    // Members are told (not strangers).
    expect(await until(() => forAlice.text().includes('event: pm_deleted') && forBob.text().includes('event: pm_deleted'))).toBe(true);
    expect(forAlice.text()).toContain(`"id":${rude.id}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(outsider.text()).not.toContain('pm_deleted');
    // Logged under the owner's name.
    expect(db(r).all("SELECT action, target, detail_json FROM admin_log WHERE action = 'pm_delete'").map((l: any) => [l.target, JSON.parse(l.detail_json)])).toEqual([[`message ${rude.id}`, { messageId: rude.id, author: 'bob', kind: 'group' }]]);
    // The same request again changes nothing and says so; the same message again with a new request is fine too.
    const again = await del(r, boss, rude.id, 'owner-delete-0001');
    expect([again.status, again.json.duplicate]).toEqual([200, true]);
    expect(db(r).get<{ n: number }>("SELECT COUNT(*) AS n FROM admin_log WHERE action = 'pm_delete'")?.n).toBe(1);
    expect((await del(r, boss, rude.id)).status).toBe(200);
    // The other messages are untouched, and the members can still write.
    r.clock.advanceSeconds(2);
    expect((await tell(r, carol, id, 'we go on')).id).toBeGreaterThan(rude.id);
    expect(await lines(r, alice, id)).toEqual(['hello all', 'a later line', 'we go on']);
  }, LONG);

  it('OWNP-8: a reported 1-to-1 message can be deleted too; the copy of a picture kept for the report is dropped; a message nobody reported cannot be deleted', async () => {
    const r = await boot();
    const { alice, bob, boss } = await world(r);
    await befriend(r, alice, 'alice', bob, 'bob');
    const first = await tell(r, bob, 'alice', 'private rude words');
    const ok = await tell(r, bob, 'alice', 'a kind line');
    const cid = first.conversationId;
    expect((await msg(r, alice, 'report', { messageId: first.id })).status).toBe(200);
    // The owner only deletes what was reported.
    const unreported = await del(r, boss, ok.id);
    expect([unreported.status, unreported.json.error.code]).toEqual([404, 'no_such_message']);
    expect(await lines(r, alice, cid)).toEqual(['private rude words', 'a kind line']);
    expect((await del(r, boss, 424242)).status).toBe(404);
    // A picture copy kept for the report goes with the message.
    db(r).run("UPDATE private_reports SET picture = x'89504e470d0a1a0a', picture_mime = 'image/png' WHERE message_id = ?", first.id);
    expect((await call(r, `/api/admin/private-reports/picture/${first.id}`, { cookie: boss })).status).toBe(200);
    expect((await del(r, boss, first.id)).status).toBe(200);
    expect(db(r).get<{ picture: unknown; picture_mime: unknown }>('SELECT picture, picture_mime FROM private_reports WHERE message_id = ?', first.id)).toEqual({ picture: null, picture_mime: null });
    expect((await call(r, `/api/admin/private-reports/picture/${first.id}`, { cookie: boss })).status).toBe(404);
    // Both of them see only the kind line; the inbox preview shows it too.
    expect(await lines(r, alice, cid)).toEqual(['a kind line']);
    expect(await lines(r, bob, cid)).toEqual(['a kind line']);
    expect((await call(r, '/api/messages', { cookie: alice })).json.conversations[0].last.text).toBe('a kind line');
    // The owner still has no way to read a conversation.
    expect((await call(r, `/api/messages/thread/${cid}`, { cookie: boss })).status).toBe(404);
  }, LONG);

  it('OWNP-9: a message the author already removed is closed quietly (nobody is told again); only the owner can delete; bad input is refused', async () => {
    const r = await boot();
    const { alice, bob, carol, boss, mia, id } = await trio(r);
    const rude = await tell(r, bob, id, 'rude words');
    await tell(r, alice, id, 'next line');
    expect((await msg(r, carol, 'report', { messageId: rude.id })).status).toBe(200);
    // Who may.
    expect((await del(r, undefined, rude.id)).status).toBe(401);
    for (const [who, cookie] of [['player', alice], ['moderator', mia]] as const) {
      const out = await del(r, cookie, rude.id);
      expect([who, out.status]).toEqual([who, 403]);
    }
    expect(await lines(r, alice, id)).toEqual(['rude words', 'next line']);
    // Bad input.
    expect((await del(r, boss, rude.id, 'short')).status).toBe(400);
    expect((await del(r, boss, rude.id, null)).status).toBe(400);
    expect((await del(r, boss, 'x')).status).toBe(400);
    expect((await del(r, boss, undefined)).status).toBe(400);
    expect(await lines(r, alice, id)).toEqual(['rude words', 'next line']);
    // Already gone: the report is closed, and nobody is told.
    db(r).run('UPDATE private_messages SET deleted_ms = ? WHERE id = ?', r.clock.now(), rude.id);
    const watching = await listen(r, alice);
    expect((await del(r, boss, rude.id)).json).toEqual({ ok: true, duplicate: false });
    expect(await reports(r, boss)).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(watching.text()).not.toContain('pm_deleted');
  }, LONG);
});
