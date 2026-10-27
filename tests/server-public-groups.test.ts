// Public groups and the quick invite (server/messages.ts, docs/world.md §23). A group is private (invited friends only, at most 8 players) or public
// (listed, anybody who can write may join, at most 30). Any member may invite his own friends, several at once, and each friend still answers. The
// player who made the group decides public or private, and takes players out; a player who was taken out cannot walk back in by himself.
import { describe, expect, it } from 'vitest';
import { MAX_GROUPS, MAX_GROUP_MEMBERS, MAX_INVITES_WAITING, MAX_PUBLIC_GROUP_MEMBERS, PUBLIC_GROUPS_SHOWN } from '../server/messages';
import { MIGRATIONS, migrate } from '../server/schema';
import { Db } from '../server/sqlite';
import { LONG, ageAccounts, db, idOf, liveRig, until, type Running } from './helpers/chatlive';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { boot, call, signUp, listen } = liveRig('groups');

const post = (r: Running, cookie: string | undefined, path: string, body: unknown = {}) => call(r, `/api/messages/${path}`, { method: 'POST', cookie, body });
const inbox = async (r: Running, cookie: string) => (await call(r, '/api/messages', { cookie })).json;
const thread = (r: Running, cookie: string, id: number) => call(r, `/api/messages/thread/${id}`, { cookie });
const publicList = (r: Running, cookie: string, q?: string) => call(r, `/api/messages/groups/public${q === undefined ? '' : `?q=${encodeURIComponent(q)}`}`, { cookie });
const ask = (r: Running, cookie: string, path: string, name: string) => call(r, `/api/friends/${path}`, { method: 'POST', cookie, body: { username: name } });
async function befriend(r: Running, a: string, aName: string, b: string, bName: string): Promise<void> {
  expect((await ask(r, a, 'request', bName)).status).toBe(200);
  expect((await ask(r, b, 'accept', aName)).status).toBe(200);
}
/** Makes two players friends without the rules. */
function plantFriends(r: Running, a: number, b: number): void {
  db(r).run("INSERT INTO friendships(user_a, user_b, requester_id, status, created_ms, accepted_ms) VALUES (?, ?, ?, 'accepted', ?, ?)", Math.min(a, b), Math.max(a, b), a, r.clock.now(), r.clock.now());
}
/** Alice, Bob, Carol, Dave, Erin and the owner, all old enough to write. */
async function world(r: Running) {
  const [alice, bob, carol, dave, erin, boss] = [await signUp(r, 'alice'), await signUp(r, 'bob'), await signUp(r, 'carol'), await signUp(r, 'dave'), await signUp(r, 'erin'), await signUp(r, 'boss')];
  ageAccounts(r);
  return { alice, bob, carol, dave, erin, boss };
}
/** Adds players the rules did not meet (no password): returns their ids. */
function bulk(r: Running, prefix: string, count: number): number[] {
  const ids: number[] = [];
  for (let i = 0; i < count; i += 1) {
    ids.push(db(r).run("INSERT INTO users(username, display_name, pw_hash, role, created_ms) VALUES (?, ?, 'x', 'player', ?)", `${prefix}${i}`, `${prefix}${i}`, r.clock.now() - 10 * 60_000).lastInsertRowid);
  }
  return ids;
}
/** Puts players into a group as members, made without the rules. */
function addMembers(r: Running, groupId: number, ids: number[]): void {
  for (const id of ids) db(r).run("INSERT INTO conversation_members(conversation_id, user_id, state, joined_ms) VALUES (?, ?, 'member', ?)", groupId, id, r.clock.now());
}
const say = async (r: Running, cookie: string, conversationId: number, text: string) => {
  const res = await post(r, cookie, 'send', { conversationId, text });
  r.clock.advanceSeconds(3);
  return res;
};
const makeGroup = async (r: Running, cookie: string, title: string, usernames: string[], visibility?: string) => (await post(r, cookie, 'group/create', { title, usernames, visibility })).json.conversation as any;

describe('a group is private or public', () => {
  it('GRP-1: the new routes need a signed-in player', async () => {
    const r = await boot();
    const wrong: string[] = [];
    for (const [method, path, body] of [
      ['GET', '/api/messages/groups/public', undefined],
      ['POST', '/api/messages/group/join', { conversationId: 1 }],
      ['POST', '/api/messages/group/visibility', { conversationId: 1, visibility: 'public' }],
    ] as [string, string, unknown][]) {
      const res = await call(r, path, { method, body });
      if (res.status !== 401) wrong.push(`${method} ${path} -> ${res.status}`);
    }
    expect(wrong).toEqual([]);
  }, LONG);

  it('GRP-2: a group is private unless its maker says public; a public group may start with nobody invited, a private one needs a friend', async () => {
    const r = await boot();
    const { alice, bob } = await world(r);
    await befriend(r, alice, 'alice', bob, 'bob');
    const priv = await makeGroup(r, alice, 'secret club', ['bob']);
    expect(priv).toMatchObject({ kind: 'group', visibility: 'private', creator: 'alice', title: 'secret club' });
    const pub = await makeGroup(r, alice, 'open house', [], 'public');
    expect(pub).toMatchObject({ visibility: 'public', members: [{ username: 'alice' }], invited: [] });
    const alone = await post(r, alice, 'group/create', { title: 'lonely', usernames: [] });
    expect([alone.status, alone.json.error.code]).toEqual([400, 'bad_request']);
    const bad = await post(r, alice, 'group/create', { title: 'odd', usernames: ['bob'], visibility: 'secret' });
    expect([bad.status, bad.json.error.code]).toEqual([400, 'bad_request']);
    // The list shows the public group only.
    const list = (await publicList(r, bob)).json;
    expect(list.groups.map((g: any) => [g.title, g.memberCount, g.joined])).toEqual([['open house', 1, false]]);
    expect(list.max).toBe(MAX_PUBLIC_GROUP_MEMBERS);
    expect(list.groups[0].creator).toMatchObject({ username: 'alice' });
  }, LONG);

  it('GRP-3: anybody who can write joins a public group at once, reads only what is said after he joined, and is counted', async () => {
    const r = await boot();
    const { alice, bob, carol } = await world(r);
    await befriend(r, alice, 'alice', bob, 'bob');
    const group = await makeGroup(r, alice, 'open house', [], 'public');
    expect((await say(r, alice, group.id, 'welcome everybody')).status).toBe(200);
    const joined = await post(r, bob, 'group/join', { conversationId: group.id });
    expect(joined.status).toBe(200);
    expect(joined.json.conversation).toMatchObject({ id: group.id, visibility: 'public', canWrite: true, unread: 0 });
    expect(joined.json.conversation.members.map((m: any) => m.username).sort()).toEqual(['alice', 'bob']);
    // What was said before is not shown to him.
    expect((await thread(r, bob, group.id)).json.messages).toEqual([]);
    expect((await say(r, bob, group.id, 'hello all')).status).toBe(200);
    expect((await say(r, alice, group.id, 'hi bob')).status).toBe(200);
    expect((await thread(r, bob, group.id)).json.messages.map((m: any) => m.text)).toEqual(['hello all', 'hi bob']);
    // Joined twice is an error and does not count him twice.
    const twice = await post(r, bob, 'group/join', { conversationId: group.id });
    expect([twice.status, twice.json.error.code]).toEqual([409, 'bad_request']);
    expect((await publicList(r, carol)).json.groups[0]).toMatchObject({ memberCount: 2, joined: false });
    expect((await publicList(r, bob)).json.groups[0]).toMatchObject({ memberCount: 2, joined: true });
    // A private group cannot be joined, and neither can something that is not a group.
    const priv = await makeGroup(r, alice, 'secret', ['bob']);
    const denied = await post(r, carol, 'group/join', { conversationId: priv.id });
    expect([denied.status, denied.json.error.code]).toEqual([404, 'no_such_conversation']);
    expect((await post(r, carol, 'group/join', { conversationId: 99999 })).status).toBe(404);
    expect((await post(r, carol, 'group/join', { conversationId: 'x' })).status).toBe(400);
  }, LONG);

  it('GRP-4: a brand-new account can look at the list but cannot join, a group holds 30 players, and a player is in at most 20 groups', async () => {
    const r = await boot();
    const [alice, newbie] = [await signUp(r, 'alice'), await signUp(r, 'newbie')];
    ageAccounts(r);
    const fresh = await signUp(r, 'fresh');
    const group = await makeGroup(r, alice, 'open house', [], 'public');
    expect((await publicList(r, fresh)).status).toBe(200);
    const early = await post(r, fresh, 'group/join', { conversationId: group.id });
    expect([early.status, early.json.error.code]).toEqual([403, 'too_new']);
    // Full at 30.
    addMembers(r, group.id, bulk(r, 'p', MAX_PUBLIC_GROUP_MEMBERS - 1));
    const full = await post(r, newbie, 'group/join', { conversationId: group.id });
    expect([full.status, full.json.error.code]).toEqual([409, 'group_full']);
    expect((await publicList(r, newbie)).json.groups[0]).toMatchObject({ memberCount: MAX_PUBLIC_GROUP_MEMBERS, max: MAX_PUBLIC_GROUP_MEMBERS });
    // 20 groups at most.
    const [other] = [await signUp(r, 'other')];
    ageAccounts(r);
    const maker = bulk(r, 'maker', 1)[0] as number;
    for (let i = 0; i < MAX_GROUPS; i += 1) {
      const id = db(r).run("INSERT INTO conversations(kind, title, created_by, created_ms, last_ms, visibility) VALUES ('group', ?, ?, ?, ?, 'public')", `g${i}`, maker, r.clock.now(), r.clock.now()).lastInsertRowid;
      addMembers(r, id, [maker]);
      if (i < MAX_GROUPS) addMembers(r, id, [idOf(r, 'other')]);
    }
    const another = await post(r, other, 'group/join', { conversationId: group.id });
    expect([another.status, another.json.error.code]).toEqual([409, 'too_many_groups']);
  }, LONG);

  it('GRP-5: the list is the busiest first, shows at most 50, and the search finds part of a name (a % or _ in the search is just a letter)', async () => {
    const r = await boot();
    const { alice, bob } = await world(r);
    const maker = idOf(r, 'alice');
    const now = r.clock.now();
    for (const [title, size] of [['chess club', 5], ['chess puzzles', 2], ['stock tips', 8], ['100% growth', 3], ['a_b group', 1]] as [string, number][]) {
      const id = db(r).run("INSERT INTO conversations(kind, title, created_by, created_ms, last_ms, visibility) VALUES ('group', ?, ?, ?, ?, 'public')", title, maker, now, now).lastInsertRowid;
      addMembers(r, id, [maker, ...bulk(r, `${title.replace(/\W/g, '')}-`, size - 1)]);
    }
    expect((await publicList(r, bob)).json.groups.map((g: any) => g.title)).toEqual(['stock tips', 'chess club', '100% growth', 'chess puzzles', 'a_b group']);
    expect((await publicList(r, bob, 'CHESS')).json.groups.map((g: any) => g.title)).toEqual(['chess club', 'chess puzzles']);
    expect((await publicList(r, bob, '%')).json.groups.map((g: any) => g.title)).toEqual(['100% growth']);
    expect((await publicList(r, bob, '_')).json.groups.map((g: any) => g.title)).toEqual(['a_b group']);
    expect((await publicList(r, bob, 'zzz')).json.groups).toEqual([]);
    expect(alice).toBeTruthy();
    // Too many groups: only the first 50 are listed.
    for (let i = 0; i < PUBLIC_GROUPS_SHOWN + 5; i += 1) {
      const id = db(r).run("INSERT INTO conversations(kind, title, created_by, created_ms, last_ms, visibility) VALUES ('group', ?, ?, ?, ?, 'public')", `extra ${i}`, maker, now, now).lastInsertRowid;
      addMembers(r, id, [maker]);
    }
    expect((await publicList(r, bob)).json.groups).toHaveLength(PUBLIC_GROUPS_SHOWN);
  }, LONG);
});

describe('the quick invite', () => {
  it('GRP-6: a member invites several friends in one go; each one answers; a friend who is not a friend of the inviter, or has been invited, stops everybody', async () => {
    const r = await boot();
    const { alice, bob, carol, dave, erin } = await world(r);
    await befriend(r, alice, 'alice', bob, 'bob');
    await befriend(r, alice, 'alice', carol, 'carol');
    await befriend(r, alice, 'alice', dave, 'dave');
    const group = await makeGroup(r, alice, 'club', ['bob']);
    const watching = await listen(r, carol);
    const sent = await post(r, alice, 'group/invite', { conversationId: group.id, usernames: ['carol', 'dave'] });
    expect(sent.status).toBe(200);
    expect(sent.json.conversation.invited.map((m: any) => m.username).sort()).toEqual(['bob', 'carol', 'dave']); // (bob was invited when the group was made)
    expect(await until(() => watching.text().includes('event: pm_changed'))).toBe(true);
    // They see a group invitation and accept it.
    const seen = await inbox(r, carol);
    expect(seen.requests).toMatchObject([{ kind: 'invite', conversationId: group.id, title: 'club', from: { username: 'alice' } }]);
    expect((await post(r, carol, 'respond', { conversationId: group.id, answer: 'accept' })).status).toBe(200);
    // One name that is not his friend, so nobody is invited.
    const mixed = await post(r, alice, 'group/invite', { conversationId: group.id, usernames: ['erin'] });
    expect([mixed.status, mixed.json.error.code]).toEqual([403, 'not_friends']);
    await befriend(r, alice, 'alice', erin, 'erin');
    const again = await post(r, alice, 'group/invite', { conversationId: group.id, usernames: ['erin', 'bob'] });
    expect([again.status, again.json.error.code]).toEqual([409, 'bad_request']);
    expect(db(r).get('SELECT 1 AS x FROM conversation_members WHERE conversation_id = ? AND user_id = ?', group.id, idOf(r, 'erin'))).toBeUndefined();
    // One name still works (the old way), and nothing at all is an error.
    expect((await post(r, alice, 'group/invite', { conversationId: group.id, username: 'erin' })).status).toBe(200);
    expect((await post(r, alice, 'group/invite', { conversationId: group.id, usernames: [] })).json.error.code).toBe('bad_request');
    expect((await post(r, alice, 'group/invite', { conversationId: group.id })).status).toBe(400); // no name at all
  }, LONG);

  it('GRP-7: any member (not only the maker) can invite his own friends, but only a member; and a private group has room for 8, counting the invited', async () => {
    const r = await boot();
    const { alice, bob, carol, dave } = await world(r);
    await befriend(r, alice, 'alice', bob, 'bob');
    await befriend(r, bob, 'bob', carol, 'carol');
    await befriend(r, carol, 'carol', dave, 'dave');
    const group = await makeGroup(r, alice, 'club', ['bob']);
    expect((await post(r, bob, 'respond', { conversationId: group.id, answer: 'accept' })).status).toBe(200);
    // Bob brings his friend carol: alice does not know her, and that is fine.
    const brought = await post(r, bob, 'group/invite', { conversationId: group.id, usernames: ['carol'] });
    expect(brought.status).toBe(200);
    expect(brought.json.conversation.invited.map((m: any) => m.username)).toEqual(['carol']);
    // A player outside the group (dave has only been told nothing) cannot invite into it; carol is only invited, not a member yet.
    const outsider = await post(r, dave, 'group/invite', { conversationId: group.id, usernames: ['carol'] });
    expect([outsider.status, outsider.json.error.code]).toEqual([404, 'no_such_conversation']);
    const invitedOnly = await post(r, carol, 'group/invite', { conversationId: group.id, usernames: ['dave'] });
    expect([invitedOnly.status, invitedOnly.json.error.code]).toEqual([404, 'no_such_conversation']);
    // Room: 3 are in (alice, bob) or invited (carol); 5 more fit.
    const ids = bulk(r, 'f', 6);
    for (const id of ids) plantFriends(r, idOf(r, 'alice'), id);
    const tooMany = await post(r, alice, 'group/invite', { conversationId: group.id, usernames: ['f0', 'f1', 'f2', 'f3', 'f4', 'f5'] });
    expect([tooMany.status, tooMany.json.error.code]).toEqual([409, 'group_full']);
    expect(tooMany.json.error.message).toMatch(/room for 5 more players/);
    expect((await post(r, alice, 'group/invite', { conversationId: group.id, usernames: ['f0', 'f1', 'f2', 'f3', 'f4'] })).status).toBe(200);
    const full = await post(r, alice, 'group/invite', { conversationId: group.id, usernames: ['f5'] });
    expect([full.status, full.json.error.code]).toEqual([409, 'group_full']);
    expect(MAX_GROUP_MEMBERS).toBe(8);
  }, LONG);

  it('GRP-8: a public group has room for 30, so many friends can be invited at once; and a friend has at most 10 invitations waiting', async () => {
    const r = await boot();
    const { alice } = await world(r);
    const group = await makeGroup(r, alice, 'open', [], 'public');
    const me = idOf(r, 'alice');
    const ids = bulk(r, 'g', MAX_PUBLIC_GROUP_MEMBERS);
    for (const id of ids) plantFriends(r, me, id);
    const names = ids.map((_, i) => `g${i}`);
    const over = await post(r, alice, 'group/invite', { conversationId: group.id, usernames: names });
    expect([over.status, over.json.error.code]).toEqual([409, 'group_full']);
    const ok = await post(r, alice, 'group/invite', { conversationId: group.id, usernames: names.slice(0, MAX_PUBLIC_GROUP_MEMBERS - 1) });
    expect(ok.status).toBe(200);
    expect(ok.json.conversation.invited).toHaveLength(MAX_PUBLIC_GROUP_MEMBERS - 1);
    // Somebody with 10 invitations waiting is not asked a 11th time.
    const busy = idOf(r, 'g0');
    expect(MAX_INVITES_WAITING).toBe(10);
    const host = bulk(r, 'host', 1)[0] as number;
    for (let i = 0; i < MAX_INVITES_WAITING - 1; i += 1) {
      const gid = db(r).run("INSERT INTO conversations(kind, title, created_by, created_ms, last_ms) VALUES ('group', ?, ?, ?, ?)", `w${i}`, host, r.clock.now(), r.clock.now()).lastInsertRowid;
      db(r).run("INSERT INTO conversation_members(conversation_id, user_id, state, joined_ms) VALUES (?, ?, 'member', ?)", gid, host, r.clock.now());
      db(r).run("INSERT INTO conversation_members(conversation_id, user_id, state, invited_by, joined_ms) VALUES (?, ?, 'invited', ?, ?)", gid, busy, me, r.clock.now());
    }
    const second = await makeGroup(r, alice, 'second', [], 'public');
    const refused = await post(r, alice, 'group/invite', { conversationId: second.id, usernames: ['g0'] });
    expect([refused.status, refused.json.error.code]).toEqual([409, 'cannot_message']);
  }, LONG);
});

describe('who decides, and who is taken out', () => {
  it('GRP-9: only the maker makes a group public or private; making it private keeps the members, hides it from the list, and needs 8 or fewer players', async () => {
    const r = await boot();
    const { alice, bob, carol } = await world(r);
    const group = await makeGroup(r, alice, 'open house', [], 'public');
    expect((await post(r, bob, 'group/join', { conversationId: group.id })).status).toBe(200);
    const notMaker = await post(r, bob, 'group/visibility', { conversationId: group.id, visibility: 'private' });
    expect([notMaker.status, notMaker.json.error.code]).toEqual([403, 'not_creator']);
    expect((await post(r, alice, 'group/visibility', { conversationId: group.id, visibility: 'maybe' })).json.error.code).toBe('bad_request');
    // Too many players for a private group.
    const crowd = bulk(r, 'c', MAX_GROUP_MEMBERS);
    addMembers(r, group.id, crowd);
    const crowded = await post(r, alice, 'group/visibility', { conversationId: group.id, visibility: 'private' });
    expect([crowded.status, crowded.json.error.code]).toEqual([409, 'group_full']);
    db(r).run('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id IN (' + crowd.join(',') + ')', group.id);
    const watching = await listen(r, bob);
    const made = await post(r, alice, 'group/visibility', { conversationId: group.id, visibility: 'private' });
    expect(made.json.conversation.visibility).toBe('private');
    expect(await until(() => watching.text().includes('event: pm_changed'))).toBe(true);
    expect((await publicList(r, carol)).json.groups).toEqual([]);
    expect((await post(r, carol, 'group/join', { conversationId: group.id })).json.error.code).toBe('no_such_conversation');
    // The members stay and can still write.
    expect((await say(r, bob, group.id, 'still here')).status).toBe(200);
    // And back again.
    expect((await post(r, alice, 'group/visibility', { conversationId: group.id, visibility: 'public' })).json.conversation.visibility).toBe('public');
    expect((await publicList(r, carol)).json.groups.map((g: any) => g.title)).toEqual(['open house']);
  }, LONG);

  it('GRP-10: a player the maker took out of a group cannot join it again; the maker can invite him back, another member cannot; taking back an invitation is not a removal', async () => {
    const r = await boot();
    const { alice, bob, carol, dave } = await world(r);
    await befriend(r, alice, 'alice', bob, 'bob');
    await befriend(r, alice, 'alice', carol, 'carol');
    await befriend(r, bob, 'bob', carol, 'carol');
    const group = await makeGroup(r, alice, 'open house', [], 'public');
    expect((await post(r, carol, 'group/join', { conversationId: group.id })).status).toBe(200);
    expect((await post(r, bob, 'group/join', { conversationId: group.id })).status).toBe(200);
    expect((await post(r, alice, 'group/remove', { conversationId: group.id, username: 'carol' })).status).toBe(200);
    const back = await post(r, carol, 'group/join', { conversationId: group.id });
    expect([back.status, back.json.error.code]).toEqual([403, 'removed_from_group']);
    // The group is not even in her list any more.
    expect((await publicList(r, carol)).json.groups).toEqual([]);
    // Bob (not the maker) cannot bring her back; alice can, and carol still has to accept.
    const bobTries = await post(r, bob, 'group/invite', { conversationId: group.id, usernames: ['carol'] });
    expect([bobTries.status, bobTries.json.error.code]).toEqual([403, 'removed_from_group']);
    expect((await post(r, alice, 'group/invite', { conversationId: group.id, usernames: ['carol'] })).status).toBe(200);
    expect((await post(r, carol, 'respond', { conversationId: group.id, answer: 'accept' })).status).toBe(200);
    expect((await say(r, carol, group.id, 'thanks for having me back')).status).toBe(200);
    // Taking back an invitation that was never answered does not close the door.
    await befriend(r, alice, 'alice', dave, 'dave');
    expect((await post(r, alice, 'group/invite', { conversationId: group.id, usernames: ['dave'] })).status).toBe(200);
    expect((await post(r, alice, 'group/remove', { conversationId: group.id, username: 'dave' })).status).toBe(200);
    expect((await post(r, dave, 'group/join', { conversationId: group.id })).status).toBe(200);
  }, LONG);

  it('GRP-11: leaving a public group is allowed and joining again is too; a group of a banned maker is not listed and cannot be joined; a public group nobody is in is gone', async () => {
    const r = await boot();
    const { alice, bob, carol, boss } = await world(r);
    const group = await makeGroup(r, alice, 'open house', [], 'public');
    expect((await post(r, bob, 'group/join', { conversationId: group.id })).status).toBe(200);
    expect((await post(r, bob, 'group/leave', { conversationId: group.id })).status).toBe(200);
    expect((await post(r, bob, 'group/join', { conversationId: group.id })).status).toBe(200);
    // The maker is banned from the game: his group disappears from the list.
    expect((await call(r, '/api/admin/ban', { method: 'POST', cookie: boss, body: { requestId: 'ban-alice-0001', username: 'alice', reason: 'rude', hours: 24 } })).status).toBe(200);
    expect((await publicList(r, carol)).json.groups).toEqual([]);
    const refused = await post(r, carol, 'group/join', { conversationId: group.id });
    expect([refused.status, refused.json.error.code]).toEqual([404, 'no_such_conversation']);
  }, LONG);
});

describe('what an old database keeps', () => {
  it('GRP-12: version 26 keeps every old group private and every old row; a kind other than private or public is refused by the table; a removed-player row needs a real group', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tq-grp-mig-'));
    const d = new Db(join(dir, 'old.sqlite'));
    try {
      d.tx(() => {
        for (const m of MIGRATIONS.filter((x) => x.version <= 25)) {
          d.exec(m.sql);
          d.exec(`PRAGMA user_version = ${m.version}`);
        }
      });
      d.run("INSERT INTO users(username, display_name, pw_hash, role, created_ms) VALUES ('a', 'a', 'x', 'player', 1), ('b', 'b', 'x', 'player', 1)");
      d.run("INSERT INTO conversations(kind, title, created_by, created_ms, last_ms) VALUES ('group', 'old group', 1, 5, 5)");
      d.run("INSERT INTO private_messages(conversation_id, user_id, body, created_ms) VALUES (1, 1, 'old words', 5)");
      expect(migrate(d)).toEqual([26]);
      expect(d.get<{ visibility: string; title: string }>('SELECT visibility, title FROM conversations WHERE id = 1')).toEqual({ visibility: 'private', title: 'old group' });
      expect(d.get<{ body: string }>('SELECT body FROM private_messages WHERE id = 1')?.body).toBe('old words');
      expect(() => d.run("UPDATE conversations SET visibility = 'secret' WHERE id = 1")).toThrow();
      d.run("UPDATE conversations SET visibility = 'public' WHERE id = 1");
      d.run('INSERT INTO group_removed(conversation_id, user_id, created_ms) VALUES (1, 2, 5)');
      expect(() => d.run('INSERT INTO group_removed(conversation_id, user_id, created_ms) VALUES (99, 2, 5)')).toThrow();
      // A group that is deleted takes its list of removed players with it.
      d.run('DELETE FROM conversations WHERE id = 1');
      expect(d.get<{ n: number }>('SELECT COUNT(*) AS n FROM group_removed')?.n).toBe(0);
      expect(migrate(d)).toEqual([]);
    } finally {
      d.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, LONG);
});
