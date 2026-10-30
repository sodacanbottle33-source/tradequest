// Teams and the weekly team race (server/teams.ts, server/routes/teams.ts, docs/world.md §37). A player starts or joins ONE team (up to ten players). Every week the teams race on the
// AVERAGE weekly growth of the members who count on the weekly board; a team needs three of those to be in the race. The best three of a finished week are written down for good and the
// members of the winning team who had joined at least three days before the week ended are given the Team Champion looks. A team gives no money and no advantage in trading.
import { describe, expect, it } from 'vitest';
import { TEAM_CHAMPION_LOOKS } from '../src/shared/cosmeticCatalog';
import { MAX_MEMBERS, MAX_INVITES, MIN_SCORED, TEAMS_SHOWN, TROPHY_DAYS, cleanTeamName, cleanTeamTag } from '../server/teams';
import { TEAMS_CREATED_PER_HOUR } from '../server/routes/teams';
import { WEEK_MS, weekStartOf } from '../server/social';
import { LONG, db, idOf, liveRig, until, type Running } from './helpers/chatlive';

const { boot, call, signUp, listen } = liveRig('teams');

const post = (r: Running, path: string, cookie: string | undefined, body?: unknown) => call(r, path, { method: 'POST', cookie, body: body ?? {} });
const teams = async (r: Running, cookie: string) => (await call(r, '/api/teams', { cookie })).json;
const code = (reply: { json: any }): string => reply.json.error.code;
const make = (r: Running, cookie: string, name: string, tag: string, open?: boolean) => post(r, '/api/teams/create', cookie, { name, tag, open });
const idOfTeam = (r: Running, name: string): number => (db(r).get('SELECT id FROM teams WHERE name = ?', name) as { id: number }).id;
const owns = (r: Running, name: string): string[] => db(r).all<{ item: string }>('SELECT item FROM user_cosmetics WHERE user_id = ? ORDER BY item', idOf(r, name)).map((x) => x.item);

/** Signs players up. Only ten accounts an hour may be made from one address, so the clock moves on an hour after nine (it never goes back). */
const registered = new WeakMap<Running, number>();
async function people(r: Running, names: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const n of names) {
    if ((registered.get(r) ?? 0) >= 9) {
      r.clock.ms += 3_600_001;
      registered.set(r, 0);
    }
    registered.set(r, (registered.get(r) ?? 0) + 1);
    out[n] = await signUp(r, n);
  }
  return out;
}

// ---- names and tags ---------------------------------------------------------------------------------------------------------------

describe('team names and tags', () => {
  it('TEAM-1: a name has 3 to 20 letters, numbers and a few marks; a tag has 2 to 4 letters or numbers kept in capitals; anything else is refused with a plain reason', () => {
    expect(cleanTeamName('  Night   Owls ')).toBe('Night Owls');
    expect(cleanTeamName("O'Neil-Crew 2")).toBe("O'Neil-Crew 2");
    for (const bad of ['ab', 'a'.repeat(21), '-Owls', 'Owls-', 'Night@Owls', 'http://x.co', '<b>Hi</b>', '🦉 Owls', 5, null, undefined]) {
      expect(() => cleanTeamName(bad), String(bad)).toThrow();
    }
    expect(cleanTeamTag(' owl ')).toBe('OWL');
    expect(cleanTeamTag('a1')).toBe('A1');
    for (const bad of ['a', 'abcde', 'ab c', 'ab-', '🦉🦉', '', 7, null]) expect(() => cleanTeamTag(bad), String(bad)).toThrow();
    try {
      cleanTeamName('x');
    } catch (e) {
      expect((e as { code: string; status: number }).code).toBe('bad_name');
      expect((e as { status: number }).status).toBe(400);
    }
  });
});

// ---- starting and joining ----------------------------------------------------------------------------------------------------------

describe('starting, joining and leaving', () => {
  it('TEAM-2: only a signed-in player can see teams; a new player sees none; starting one makes him the leader and its only member', async () => {
    const r = await boot();
    const c = await people(r, ['alice']);
    expect((await call(r, '/api/teams')).status).toBe(401);
    expect((await post(r, '/api/teams/create', undefined, { name: 'Night Owls', tag: 'OWL' })).status).toBe(401);
    const none = await teams(r, c.alice as string);
    expect(none).toMatchObject({ me: null, invites: [], teams: [], total: 0, lastWeek: null, limits: { maxMembers: 10, minScored: 3, nameMin: 3, nameMax: 20, tagMin: 2, tagMax: 4 } });
    const made = await make(r, c.alice as string, 'Night  Owls', 'owl');
    expect(made.status).toBe(200);
    expect(made.json.me).toMatchObject({ name: 'Night Owls', tag: 'OWL', open: true, members: 1, scored: 1, scorePct: null, rank: null, leader: 'alice', you: true, iAmLeader: true });
    expect(made.json.me.memberList).toMatchObject([{ username: 'alice', leader: true }]);
    expect(made.json.teams).toHaveLength(1);
    expect(made.json.total).toBe(1);
  }, LONG);

  it('TEAM-3: a name and a tag can be used by one team only (capital letters do not matter); one team at a time; bad names are a 400; the owner and computer players do not join', async () => {
    const r = await boot();
    const c = await people(r, ['alice', 'bob', 'bob2', 'bob3', 'boss', 'carol']);
    expect((await make(r, c.alice as string, 'Night Owls', 'OWL')).status).toBe(200);
    expect(code(await make(r, c.bob as string, 'NIGHT OWLS', 'NOW'))).toBe('name_taken');
    expect(code(await make(r, c.bob as string, 'Day Owls', 'owl'))).toBe('tag_taken');
    expect(code(await make(r, c.alice as string, 'Other Team', 'OTH'))).toBe('already_in_team');
    expect(code(await make(r, c.bob as string, 'x', 'OWL'))).toBe('bad_name');
    expect(code(await make(r, c.bob2 as string, 'Good Name', 'x'))).toBe('bad_tag');
    expect((await post(r, '/api/teams/create', c.bob2 as string, { tag: 'ABC' })).status).toBe(400);
    expect(code(await make(r, c.boss as string, 'Boss Team', 'BOS'))).toBe('cannot_join');
    db(r).run("INSERT INTO bots(user_id, persona) VALUES (?, 'test-persona')", idOf(r, 'carol'));
    expect(code(await make(r, c.carol as string, 'Robot Team', 'BOT'))).toBe('cannot_join');
    expect(db(r).get('SELECT COUNT(*) AS n FROM teams')).toEqual({ n: 1 });
  }, LONG);

  it('TEAM-4: a player can start only a few teams an hour; tries that fail count too', async () => {
    const r = await boot();
    const c = await people(r, ['alice']);
    for (let i = 0; i < TEAMS_CREATED_PER_HOUR; i += 1) expect((await make(r, c.alice as string, 'x', 'ABC')).status).toBe(400);
    expect((await make(r, c.alice as string, 'Real Name', 'ABC')).status).toBe(429);
    r.clock.ms += 3_600_001;
    expect((await make(r, c.alice as string, 'Real Name', 'ABC')).status).toBe(200);
  }, LONG);

  it('TEAM-5: an open team can be joined by anybody; a closed team only by an invited player; a full team by nobody; joining takes away other invitations and tells the team', async () => {
    const r = await boot();
    const names = ['alice', 'bob', 'carol', 'dave'];
    const c = await people(r, names);
    const watching = await listen(r, c.alice);
    await make(r, c.alice as string, 'Open House', 'OPN', true);
    const open = idOfTeam(r, 'Open House');
    await make(r, c.bob as string, 'Closed Door', 'CLS', false);
    const closed = idOfTeam(r, 'Closed Door');
    expect(code(await post(r, '/api/teams/join', c.carol, { teamId: closed }))).toBe('team_closed');
    expect(code(await post(r, '/api/teams/join', c.carol, { teamId: 9999 }))).toBe('no_such_team');
    expect((await post(r, '/api/teams/join', c.carol, { teamId: '1' })).status).toBe(400);
    expect((await post(r, '/api/teams/join', c.carol, {})).status).toBe(400);
    const joined = await post(r, '/api/teams/join', c.carol, { teamId: open });
    expect(joined.status).toBe(200);
    expect(joined.json.me).toMatchObject({ name: 'Open House', members: 2 });
    expect(await until(() => watching.text().includes('event: teams'))).toBe(true); // the leader's page asks again
    expect(code(await post(r, '/api/teams/join', c.carol, { teamId: closed }))).toBe('already_in_team');
    // Bob (leader of the closed team) invites dave; dave also gets an invitation from alice and picks one.
    expect((await post(r, '/api/teams/invite', c.bob, { username: 'dave' })).json.me.invited).toMatchObject([{ username: 'dave' }]);
    expect((await post(r, '/api/teams/invite', c.alice, { username: 'dave' })).status).toBe(200);
    const mine = await teams(r, c.dave as string);
    expect(mine.invites.map((i: { name: string }) => i.name).sort()).toEqual(['Closed Door', 'Open House']);
    expect(mine.invites.map((i: { members: number; tag: string }) => [i.members, i.tag]).sort()).toEqual([[1, 'CLS'], [2, 'OPN']]);
    const took = await post(r, '/api/teams/join', c.dave, { teamId: closed });
    expect(took.json.me.name).toBe('Closed Door');
    expect(took.json.invites).toEqual([]); // the other invitation went with it
    // A full team.
    const many = await people(r, ['pla1', 'pla2', 'pla3', 'pla4', 'pla5', 'pla6', 'pla7', 'pla8']);
    for (const n of Object.keys(many)) expect((await post(r, '/api/teams/join', many[n], { teamId: open })).status).toBe(200);
    expect(db(r).get('SELECT COUNT(*) AS n FROM team_members WHERE team_id = ?', open)).toEqual({ n: MAX_MEMBERS });
    const late = await people(r, ['late']);
    expect(code(await post(r, '/api/teams/join', late.late, { teamId: open }))).toBe('team_full');
    expect(code(await post(r, '/api/teams/invite', c.alice, { username: 'late' }))).toBe('team_full');
  }, 120_000);

  it('TEAM-6: only the leader invites; he can not invite someone who is in a team, the owner, a computer player or nobody; an invitation can be said no to and runs out after a week', async () => {
    const r = await boot();
    const c = await people(r, ['alice', 'bob', 'carol', 'dave', 'boss']);
    await make(r, c.alice as string, 'Alpha', 'ALP', false);
    await post(r, '/api/teams/join', c.bob, { teamId: idOfTeam(r, 'Alpha') }); // closed: refused
    expect(await db(r).get('SELECT COUNT(*) AS n FROM team_members')).toEqual({ n: 1 });
    expect(code(await post(r, '/api/teams/invite', c.carol, { username: 'dave' }))).toBe('not_in_team');
    await make(r, c.bob as string, 'Beta', 'BET');
    expect(code(await post(r, '/api/teams/invite', c.alice, { username: 'bob' }))).toBe('already_in_team');
    expect(code(await post(r, '/api/teams/invite', c.alice, { username: 'boss' }))).toBe('cannot_join');
    expect(code(await post(r, '/api/teams/invite', c.alice, { username: 'nobody' }))).toBe('no_such_player');
    expect((await post(r, '/api/teams/invite', c.alice, { username: 7 })).status).toBe(400);
    db(r).run("INSERT INTO bots(user_id, persona) VALUES (?, 'test-persona')", idOf(r, 'dave'));
    expect(code(await post(r, '/api/teams/invite', c.alice, { username: 'dave' }))).toBe('cannot_join');
    db(r).run('DELETE FROM bots');
    // Join a second member so a member (not the leader) can try to invite.
    await post(r, '/api/teams/invite', c.alice, { username: 'carol' });
    await post(r, '/api/teams/join', c.carol, { teamId: idOfTeam(r, 'Alpha') });
    expect(code(await post(r, '/api/teams/invite', c.carol, { username: 'dave' }))).toBe('not_leader');
    // Saying no removes the invitation; a week later an old invitation no longer works.
    await post(r, '/api/teams/invite', c.alice, { username: 'dave' });
    expect((await teams(r, c.dave as string)).invites).toHaveLength(1);
    expect((await post(r, '/api/teams/decline', c.dave, { teamId: idOfTeam(r, 'Alpha') })).json.invites).toEqual([]);
    expect(code(await post(r, '/api/teams/join', c.dave, { teamId: idOfTeam(r, 'Alpha') }))).toBe('team_closed');
    await post(r, '/api/teams/invite', c.alice, { username: 'dave' });
    r.clock.ms += 7 * 86_400_000 + 1000;
    expect((await teams(r, c.dave as string)).invites).toEqual([]);
    expect(code(await post(r, '/api/teams/join', c.dave, { teamId: idOfTeam(r, 'Alpha') }))).toBe('team_closed');
    expect((await post(r, '/api/teams/decline', c.dave, { teamId: 'x' })).status).toBe(400);
  }, LONG);

  it('TEAM-7: the leader can only keep so many invitations waiting (inviting the same player again is fine)', async () => {
    const r = await boot();
    const c = await people(r, ['alice', 'zed', 'yan']);
    await make(r, c.alice as string, 'Alpha', 'ALP');
    const team = idOfTeam(r, 'Alpha');
    for (let i = 0; i < MAX_INVITES - 1; i += 1) {
      db(r).run("INSERT INTO users(username, display_name, pw_hash, created_ms, role) VALUES (?, ?, 'x', 0, 'player')", `ghost${i}`, `ghost${i}`);
      db(r).run('INSERT INTO team_invites(team_id, user_id, invited_ms) VALUES (?, ?, ?)', team, idOf(r, `ghost${i}`), r.clock.now());
    }
    expect((await post(r, '/api/teams/invite', c.alice, { username: 'zed' })).status).toBe(200); // the last one that fits
    expect(code(await post(r, '/api/teams/invite', c.alice, { username: 'yan' }))).toBe('too_many_invites');
    expect((await post(r, '/api/teams/invite', c.alice, { username: 'zed' })).status).toBe(200);
  }, LONG);

  it('TEAM-8: leaving: a leader who leaves hands the lead to the player who has been there longest; the last player to leave ends the team; leaving without a team is a 409', async () => {
    const r = await boot();
    const c = await people(r, ['alice', 'bob', 'carol']);
    await make(r, c.alice as string, 'Alpha', 'ALP');
    r.clock.ms += 1000;
    await post(r, '/api/teams/join', c.bob, { teamId: idOfTeam(r, 'Alpha') });
    r.clock.ms += 1000;
    await post(r, '/api/teams/join', c.carol, { teamId: idOfTeam(r, 'Alpha') });
    expect((await post(r, '/api/teams/leave', undefined)).status).toBe(401);
    const left = await post(r, '/api/teams/leave', c.alice);
    expect(left.json.me).toBeNull();
    const view = await teams(r, c.bob as string);
    expect(view.me).toMatchObject({ leader: 'bob', iAmLeader: true, members: 2 });
    await post(r, '/api/teams/leave', c.carol);
    await post(r, '/api/teams/leave', c.bob);
    expect(db(r).get('SELECT COUNT(*) AS n FROM teams')).toEqual({ n: 0 });
    expect(code(await post(r, '/api/teams/leave', c.bob))).toBe('not_in_team');
    // A new team can have the old name again.
    expect((await make(r, c.carol as string, 'Alpha', 'ALP')).status).toBe(200);
  }, LONG);

  it('TEAM-9: the leader can remove a member, hand over the lead, close or open the team and end it; nobody else can; the owner can end any team', async () => {
    const r = await boot();
    const c = await people(r, ['alice', 'bob', 'carol', 'dave', 'boss']);
    await make(r, c.alice as string, 'Alpha', 'ALP');
    const team = idOfTeam(r, 'Alpha');
    await post(r, '/api/teams/join', c.bob, { teamId: team });
    await post(r, '/api/teams/join', c.carol, { teamId: team });
    await post(r, '/api/teams/join', c.dave, { teamId: team });
    for (const path of ['kick', 'lead']) expect(code(await post(r, `/api/teams/${path}`, c.bob, { username: 'carol' })), path).toBe('not_leader');
    expect(code(await post(r, '/api/teams/settings', c.bob, { open: false }))).toBe('not_leader');
    expect(code(await post(r, '/api/teams/disband', c.bob, {}))).toBe('not_leader');
    expect(code(await post(r, '/api/teams/kick', c.alice, { username: 'alice' }))).toBe('bad_request');
    expect(code(await post(r, '/api/teams/kick', c.alice, { username: 'boss' }))).toBe('no_such_player');
    expect((await post(r, '/api/teams/kick', c.alice, { username: '@dave' })).json.me.members).toBe(3);
    expect(await teams(r, c.dave as string)).toMatchObject({ me: null });
    expect((await post(r, '/api/teams/settings', c.alice, { open: 'no' })).status).toBe(400);
    expect((await post(r, '/api/teams/settings', c.alice, { open: false })).json.me.open).toBe(false);
    expect(code(await post(r, '/api/teams/join', c.dave, { teamId: team }))).toBe('team_closed');
    const led = await post(r, '/api/teams/lead', c.alice, { username: 'bob' });
    expect(led.json.me).toMatchObject({ leader: 'bob', iAmLeader: false });
    expect(code(await post(r, '/api/teams/disband', c.alice, {}))).toBe('not_leader');
    // The owner ends any team by number; a leader ends his own without saying which.
    expect((await post(r, '/api/teams/disband', c.boss, { teamId: team })).status).toBe(200);
    expect(db(r).get('SELECT COUNT(*) AS n FROM teams')).toEqual({ n: 0 });
    expect(db(r).get('SELECT COUNT(*) AS n FROM team_members')).toEqual({ n: 0 });
    await make(r, c.carol as string, 'Gamma', 'GAM');
    expect((await post(r, '/api/teams/disband', c.carol, {})).status).toBe(200);
    expect(code(await post(r, '/api/teams/disband', c.carol, {}))).toBe('bad_request');
    expect(code(await post(r, '/api/teams/disband', c.carol, { teamId: 123 }))).toBe('no_such_team');
  }, LONG);

  it('TEAM-10: a banned player is not shown in his team while the ban lasts', async () => {
    const r = await boot();
    const c = await people(r, ['alice', 'bob', 'boss']);
    await make(r, c.alice as string, 'Alpha', 'ALP');
    await post(r, '/api/teams/join', c.bob, { teamId: idOfTeam(r, 'Alpha') });
    expect((await teams(r, c.alice as string)).me.members).toBe(2);
    db(r).run("INSERT INTO user_bans(user_id, reason, banned_ms, until_ms, by_user_id, kind) VALUES (?, 'test', 0, NULL, ?, 'ban')", idOf(r, 'bob'), idOf(r, 'boss'));
    expect((await teams(r, c.alice as string)).me.members).toBe(1);
  }, LONG);
});

// ---- the race ------------------------------------------------------------------------------------------------------------------------

/**
 * Three real teams and a small one: Alpha (+10%, +20%, +30% = 20%), Beta (+5% each = 5%), Gamma (two players only, so out of the race) and Delta (-10% each). Cash is moved by hand,
 * the week's marks are written, and the clock is left in the middle of the week.
 */
async function race() {
  const r = await boot();
  const c = await people(r, ['alp1', 'alp2', 'alp3', 'bet1', 'bet2', 'bet3', 'gam1', 'gam2', 'del1', 'del2', 'del3']);
  for (const [name, tag, members] of [
    ['Alpha', 'ALP', ['alp1', 'alp2', 'alp3']],
    ['Beta', 'BET', ['bet1', 'bet2', 'bet3']],
    ['Gamma', 'GAM', ['gam1', 'gam2']],
    ['Delta', 'DEL', ['del1', 'del2', 'del3']],
  ] as const) {
    await make(r, c[members[0]] as string, name, tag);
    for (const m of members.slice(1)) await post(r, '/api/teams/join', c[m], { teamId: idOfTeam(r, name) });
  }
  const social = r.app.services.social;
  r.app.services.teams.rollWeek(); // the first roll only writes the week down
  social.rollWeek();
  const week0 = weekStartOf(r.clock.now());
  const move = (name: string, pct: number): void => {
    const cash = (db(r).get('SELECT cash_cents AS c FROM accounts WHERE kind = ? AND user_id = ?', 'career', idOf(r, name)) as { c: number }).c;
    db(r).run('UPDATE accounts SET cash_cents = cash_cents + ? WHERE kind = ? AND user_id = ?', Math.round((cash * pct) / 100), 'career', idOf(r, name));
  };
  for (const [n, pct] of [['alp1', 10], ['alp2', 20], ['alp3', 30], ['bet1', 5], ['bet2', 5], ['bet3', 5], ['gam1', 50], ['gam2', 50], ['del1', -10], ['del2', -10], ['del3', -10]] as const) move(n, pct);
  social.invalidate();
  return { r, c, week0 };
}

describe('the weekly race', () => {
  it('TEAM-11: a team is scored by the average growth of its members who count; a team needs three of them to be in the race; the race is listed best first, the others after', async () => {
    const { r, c } = await race();
    const view = await teams(r, c.alp1 as string);
    expect(MIN_SCORED).toBe(3);
    expect(view.teams.map((t: { name: string }) => t.name)).toEqual(['Alpha', 'Beta', 'Delta', 'Gamma']);
    expect(view.teams.map((t: { rank: number | null }) => t.rank)).toEqual([1, 2, 3, null]);
    expect(view.teams.map((t: { scorePct: number | null }) => t.scorePct)).toEqual([20, 5, -10, null]);
    expect(view.teams.map((t: { scored: number }) => t.scored)).toEqual([3, 3, 3, 2]);
    expect(view.me).toMatchObject({ name: 'Alpha', rank: 1, scorePct: 20, you: true });
    expect(view.me.memberList.map((m: { username: string; gainPct: number }) => [m.username, m.gainPct])).toEqual([['alp1', 10], ['alp2', 20], ['alp3', 30]]);
    // Gamma's two players grew the most, but a team of two is not in the race; the page can say what is missing.
    const gamma = view.teams.find((t: { name: string }) => t.name === 'Gamma');
    expect(gamma).toMatchObject({ members: 2, scored: 2, scorePct: null, rank: null });
    expect(view.weekStartMs + WEEK_MS).toBe(view.endsMs);
    expect(view.lastWeek).toBeNull();
    // A team page never shows money, only percent.
    expect(JSON.stringify(view)).not.toMatch(/cents/i);
  }, 120_000);

  it('TEAM-12: the list of teams shows at most TEAMS_SHOWN teams, the race first', async () => {
    const r = await boot();
    const c = await people(r, ['alice']);
    expect(TEAMS_SHOWN).toBe(30);
    for (let i = 0; i < TEAMS_SHOWN + 2; i += 1) {
      db(r).run("INSERT INTO users(username, display_name, pw_hash, created_ms, role) VALUES (?, ?, 'x', 0, 'player')", `lead${i}`, `lead${i}`);
      db(r).run('INSERT INTO teams(name, name_key, tag, tag_key, leader_id, open, created_ms) VALUES (?, ?, ?, ?, ?, 1, 0)', `Team ${i}`, `team ${i}`, `T${i}`, `t${i}`, idOf(r, `lead${i}`));
      db(r).run('INSERT INTO team_members(user_id, team_id, joined_ms) VALUES (?, ?, 0)', idOf(r, `lead${i}`), i + 1);
    }
    const view = await teams(r, c.alice as string);
    expect(view.teams).toHaveLength(TEAMS_SHOWN);
    expect(view.total).toBe(TEAMS_SHOWN + 2);
  }, LONG);

  it('TEAM-13: when the week turns, the best three teams with a gain are written down; a team that lost, a team out of the race and a week without marks place nobody', async () => {
    const { r, week0 } = await race();
    const social = r.app.services.social;
    // A player who joins Alpha too late for the prize (the last day), but not too late to count.
    const late = (await people(r, ['alp4'])).alp4 as string;
    const nextWeek = week0 + WEEK_MS;
    r.clock.ms = nextWeek - 86_400_000;
    await post(r, '/api/teams/join', late, { teamId: idOfTeam(r, 'Alpha') });
    r.clock.ms = nextWeek + 60_000;
    social.rollWeek();
    expect(r.app.services.teams.rollWeek()).toBe(2);
    const rows = db(r).all<{ place: number; team_name: string; team_tag: string; score_pct: number; members: number }>('SELECT place, team_name, team_tag, score_pct, members FROM team_week_results WHERE week_start_ms = ? ORDER BY place', week0);
    // Alpha has four members now, alp4 with no gain: (10 + 20 + 30 + 0) / 4 = 15.
    expect(rows).toEqual([
      { place: 1, team_name: 'Alpha', team_tag: 'ALP', score_pct: 15, members: 4 },
      { place: 2, team_name: 'Beta', team_tag: 'BET', score_pct: 5, members: 3 },
    ]);
    // Safe to call again, and nothing changes.
    expect(r.app.services.teams.rollWeek()).toBe(0);
    expect(db(r).get('SELECT COUNT(*) AS n FROM team_week_results')).toEqual({ n: 2 });
    // The page shows the winners of last week.
    const view = (await call(r, '/api/teams', { cookie: (await people(r, ['viewer'])).viewer as string })).json;
    expect(view.lastWeek).toMatchObject({ weekStartMs: week0, places: [{ place: 1, teamName: 'Alpha', teamTag: 'ALP', scorePct: 15, members: 4 }, { place: 2, teamName: 'Beta' }] });
  }, 120_000);

  it('TEAM-14: the members of the winning team who joined at least three days before the week ended are given the Team Champion looks, are told, and a late joiner is not; nobody gets them twice', async () => {
    const { r, c, week0 } = await race();
    const social = r.app.services.social;
    const late = (await people(r, ['alp4'])).alp4 as string;
    const nextWeek = week0 + WEEK_MS;
    r.clock.ms = nextWeek - 86_400_000;
    await post(r, '/api/teams/join', late, { teamId: idOfTeam(r, 'Alpha') });
    const watching = await listen(r, c.alp1);
    r.clock.ms = nextWeek + 60_000;
    social.rollWeek();
    r.app.services.teams.rollWeek();
    expect(TROPHY_DAYS).toBe(3);
    const want = [...TEAM_CHAMPION_LOOKS].sort();
    for (const n of ['alp1', 'alp2', 'alp3']) expect(owns(r, n), n).toEqual(want);
    for (const n of ['alp4', 'bet1', 'bet2', 'bet3', 'gam1', 'del1']) expect(owns(r, n), n).toEqual([]);
    expect(await until(() => watching.text().includes('event: earned'))).toBe(true);
    expect(watching.text()).toContain('the weekly team race');
    // Not put on by themselves; the Shop lets him wear them.
    expect(db(r).all('SELECT * FROM user_looks')).toEqual([]);
    expect((await post(r, '/api/shop/equip', c.alp1, { slot: 'title', item: TEAM_CHAMPION_LOOKS.find((id) => id.startsWith('t_')) })).status).toBe(200);
    // The team's members are in the trophy room, by place, for the weeks their team placed.
    const room = (await call(r, '/api/trophies/alp1', { cookie: c.alp2 })).json;
    expect(room.team).toEqual({ name: 'Alpha', tag: 'ALP' });
    expect(room.teamWins).toEqual([{ weekStartMs: week0, place: 1, teamName: 'Alpha', teamTag: 'ALP' }]);
    expect((await call(r, '/api/trophies/bet1', { cookie: c.alp2 })).json.teamWins).toEqual([{ weekStartMs: week0, place: 2, teamName: 'Beta', teamTag: 'BET' }]);
    expect((await call(r, '/api/trophies/alp4', { cookie: c.alp2 })).json.teamWins).toEqual([]);
    // A second roll gives nothing more.
    r.app.services.teams.rollWeek();
    expect(owns(r, 'alp1')).toEqual(want);
  }, 120_000);

  it('TEAM-15: the first roll of a new game places nobody; a week with no gains at all places nobody', async () => {
    const r = await boot();
    const c = await people(r, ['alp1', 'alp2', 'alp3']);
    await make(r, c.alp1 as string, 'Alpha', 'ALP');
    for (const n of ['alp2', 'alp3']) await post(r, '/api/teams/join', c[n], { teamId: idOfTeam(r, 'Alpha') });
    const week0 = weekStartOf(r.clock.now());
    expect(r.app.services.teams.rollWeek()).toBe(0); // marks the week only
    expect(db(r).get<{ value: string }>('SELECT value FROM meta WHERE key = ?', 'teams_week_ms')?.value).toBe(String(week0));
    r.app.services.social.rollWeek();
    r.clock.ms = week0 + WEEK_MS + 60_000;
    r.app.services.social.rollWeek();
    expect(r.app.services.teams.rollWeek()).toBe(0); // nobody gained
    expect(db(r).all('SELECT * FROM team_week_results')).toEqual([]);
    expect(owns(r, 'alp1')).toEqual([]);
    expect(db(r).get<{ value: string }>('SELECT value FROM meta WHERE key = ?', 'teams_week_ms')?.value).toBe(String(week0 + WEEK_MS));
  }, LONG);
});
