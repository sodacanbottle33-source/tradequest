// Teams (docs/world.md §37). A player can start a team or join one (at most one team at a time, at most MAX_MEMBERS in a team). Every week the teams race: a team's score is
// the AVERAGE weekly growth in percent of its members who count on the weekly board (server/social.ts; cash the game gave away is not growth), so a big team has no advantage over
// a small one, and a team is listed in the race only when at least MIN_SCORED of its members count. The best three teams of each finished week are written down for good, and
// the members of the winning team who had joined at least TROPHY_DAYS days before the week ended are given the Team Champion looks (earned, not sold).
//
// A team is only a name, a short tag, a list of members and a score. It gives no money and no advantage in trading. The name and the tag are typed by players: they are limited to
// letters, numbers and a few marks (no pictures, no links), they are unique when capital letters are ignored, and the owner and the moderators can disband any team.

import { TEAM_CHAMPION_LOOKS, cosmeticById } from '../src/shared/cosmeticCatalog';
import { isStaff, type Role, type User } from './auth';
import type { Logger } from './log';
import { WEEK_MS, weekStartOf } from './social';
import type { Db } from './sqlite';

export class TeamError extends Error {
  constructor(
    readonly code:
      | 'bad_request'
      | 'bad_name'
      | 'bad_tag'
      | 'name_taken'
      | 'tag_taken'
      | 'already_in_team'
      | 'not_in_team'
      | 'no_such_team'
      | 'no_such_player'
      | 'team_full'
      | 'team_closed'
      | 'not_leader'
      | 'too_many_invites'
      | 'cannot_join',
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export const MAX_MEMBERS = 10;
/** A team is in the weekly race only with this many members who count on the weekly board. */
export const MIN_SCORED = 3;
/** The members who joined at least this many days before the week ended share the prize of a winning team. */
export const TROPHY_DAYS = 3;
export const MAX_INVITES = 20;
/** An invitation lasts this long. */
export const INVITE_MS = 7 * 86_400_000;
export const TEAMS_SHOWN = 30;
const WEEK_KEY = 'teams_week_ms';

export interface TeamMemberView {
  readonly username: string;
  readonly displayName: string;
  readonly leader: boolean;
  readonly joinedMs: number;
  /** His growth this week in percent, or null when he does not count on the weekly board yet. */
  readonly gainPct: number | null;
}

export interface TeamRow {
  readonly id: number;
  readonly name: string;
  readonly tag: string;
  readonly open: boolean;
  readonly members: number;
  /** How many of the members count on the weekly board. */
  readonly scored: number;
  /** The team's score this week (the average growth in percent of the members who count), or null when fewer than MIN_SCORED count. */
  readonly scorePct: number | null;
  /** The place in this week's race, or null when the team is not in it. */
  readonly rank: number | null;
  readonly leader: string;
  readonly you: boolean;
}

export interface MyTeam extends TeamRow {
  readonly memberList: readonly TeamMemberView[];
  readonly iAmLeader: boolean;
  /** The players the leader has invited and who have not answered (only the leader is told). */
  readonly invited: readonly { readonly username: string; readonly invitedMs: number }[];
}

export interface TeamInviteView {
  readonly teamId: number;
  readonly name: string;
  readonly tag: string;
  readonly members: number;
  readonly invitedMs: number;
}

export interface TeamsView {
  readonly weekStartMs: number;
  readonly endsMs: number;
  readonly me: MyTeam | null;
  readonly invites: readonly TeamInviteView[];
  /** The race: the teams in it first (best score first), then the others, at most TEAMS_SHOWN. */
  readonly teams: readonly TeamRow[];
  readonly total: number;
  /** The best teams of the week that ended, or null when there was no race. */
  readonly lastWeek: { readonly weekStartMs: number; readonly places: readonly { place: number; teamName: string; teamTag: string; scorePct: number; members: number }[] } | null;
  readonly limits: { readonly maxMembers: number; readonly minScored: number; readonly nameMin: number; readonly nameMax: number; readonly tagMin: number; readonly tagMax: number };
}

export interface TeamsDeps {
  readonly db: Db;
  readonly now: () => number;
  readonly log: Logger;
  /** The weekly growth of every player who counts this week (Social.weeklyGrowth), and of the week that just ended (Social.lastWeekGrowth). */
  readonly growth: () => ReadonlyMap<number, { gainCents: number; gainPct: number }>;
  readonly lastGrowth: () => ReadonlyMap<number, { gainCents: number; gainPct: number }>;
  /** A real player who may be named (Social.playerRef): throws when there is none. */
  readonly playerRef: (username: string) => { id: number; username: string; displayName: string };
  /** Tells the pages of one player that something about his team changed (they ask again). */
  readonly tell?: (userId: number, event: string, data: unknown) => void;
  /** Gives an earned look (Shop.award). */
  readonly award?: (userId: number, item: string, reason: string) => boolean;
}

interface TeamDbRow {
  id: number;
  name: string;
  tag: string;
  leader_id: number;
  open: number;
  created_ms: number;
}

/** A team name: letters, numbers, single spaces and a few marks inside, 3 to 20 characters. Returns the cleaned name or throws. */
export function cleanTeamName(raw: unknown): string {
  if (typeof raw !== 'string') throw new TeamError('bad_name', 'Type a name for the team.', 400);
  const name = raw.trim().replace(/\s+/g, ' ');
  if (name.length < 3 || name.length > 20) throw new TeamError('bad_name', 'A team name has 3 to 20 characters.', 400);
  if (!/^[A-Za-z0-9][A-Za-z0-9 _.'-]*[A-Za-z0-9]$/.test(name)) throw new TeamError('bad_name', 'A team name can have letters, numbers, spaces and . _ \' - only, and starts and ends with a letter or a number.', 400);
  return name;
}

/** A team tag: 2 to 4 letters or numbers, kept in capitals. */
export function cleanTeamTag(raw: unknown): string {
  if (typeof raw !== 'string') throw new TeamError('bad_tag', 'Type a short tag for the team.', 400);
  const tag = raw.trim().toUpperCase();
  if (!/^[A-Z0-9]{2,4}$/.test(tag)) throw new TeamError('bad_tag', 'A team tag has 2 to 4 letters or numbers.', 400);
  return tag;
}

export class Teams {
  private markedWeek = -1;

  constructor(private readonly d: TeamsDeps) {}

  // ---- reading ------------------------------------------------------------------------------------------------------

  private teamRow(id: number): TeamDbRow | undefined {
    return this.d.db.get<TeamDbRow>('SELECT id, name, tag, leader_id, open, created_ms FROM teams WHERE id = ?', id);
  }

  /** The team a player is in, or undefined. */
  private teamOf(userId: number): TeamDbRow | undefined {
    return this.d.db.get<TeamDbRow>('SELECT t.id, t.name, t.tag, t.leader_id, t.open, t.created_ms FROM team_members m JOIN teams t ON t.id = m.team_id WHERE m.user_id = ?', userId);
  }

  /** The id of the team a player is in, or null. */
  teamIdOf(userId: number): number | null {
    return this.teamOf(userId)?.id ?? null;
  }

  private membersOf(teamId: number): { user_id: number; username: string; display_name: string; joined_ms: number }[] {
    // Only players who can be seen: nobody banned right now (a ban that ends brings him back).
    return this.d.db.all(
      `SELECT m.user_id, u.username, u.display_name, m.joined_ms FROM team_members m JOIN users u ON u.id = m.user_id
        WHERE m.team_id = ? AND NOT EXISTS (SELECT 1 FROM user_bans x WHERE x.user_id = m.user_id AND (x.until_ms IS NULL OR x.until_ms > ?))
        ORDER BY m.joined_ms, m.user_id`,
      teamId,
      this.d.now(),
    );
  }

  private scoreOf(memberIds: readonly number[], growth: ReadonlyMap<number, { gainPct: number }>): { scored: number; scorePct: number | null } {
    const g = memberIds.map((id) => growth.get(id)).filter((x): x is { gainPct: number } => x !== undefined);
    if (g.length < MIN_SCORED) return { scored: g.length, scorePct: null };
    const avg = g.reduce((sum, x) => sum + x.gainPct, 0) / g.length;
    return { scored: g.length, scorePct: Math.round(avg * 100) / 100 };
  }

  view(me: User): TeamsView {
    const { db } = this.d;
    const nowMs = this.d.now();
    const week = weekStartOf(nowMs);
    const growth = this.d.growth();
    const all = db.all<TeamDbRow>('SELECT id, name, tag, leader_id, open, created_ms FROM teams ORDER BY id');
    const mineId = this.teamIdOf(me.id);
    const built = all.map((t) => {
      const members = this.membersOf(t.id);
      const score = this.scoreOf(members.map((m) => m.user_id), growth);
      const leader = members.find((m) => m.user_id === t.leader_id)?.username ?? (db.get<{ username: string }>('SELECT username FROM users WHERE id = ?', t.leader_id)?.username ?? '');
      return { t, members, ...score, leader };
    });
    // The race: best score first; the same score: more members who count, then the older team.
    const racing = built.filter((x) => x.scorePct !== null).sort((a, b) => (b.scorePct as number) - (a.scorePct as number) || b.scored - a.scored || a.t.id - b.t.id);
    const rest = built.filter((x) => x.scorePct === null).sort((a, b) => b.members.length - a.members.length || a.t.id - b.t.id);
    const rankOf = new Map(racing.map((x, i) => [x.t.id, i + 1] as const));
    const rowOf = (x: (typeof built)[number]): TeamRow => ({
      id: x.t.id,
      name: x.t.name,
      tag: x.t.tag,
      open: x.t.open === 1,
      members: x.members.length,
      scored: x.scored,
      scorePct: x.scorePct,
      rank: rankOf.get(x.t.id) ?? null,
      leader: x.leader,
      you: x.t.id === mineId,
    });
    const teams = [...racing, ...rest].slice(0, TEAMS_SHOWN).map(rowOf);
    let mine: MyTeam | null = null;
    const mineBuilt = built.find((x) => x.t.id === mineId);
    if (mineBuilt) {
      const iAmLeader = mineBuilt.t.leader_id === me.id;
      mine = {
        ...rowOf(mineBuilt),
        memberList: mineBuilt.members.map((m) => ({ username: m.username, displayName: m.display_name, leader: m.user_id === mineBuilt.t.leader_id, joinedMs: m.joined_ms, gainPct: growth.get(m.user_id)?.gainPct ?? null })),
        iAmLeader,
        invited: iAmLeader
          ? db
              .all<{ username: string; invited_ms: number }>('SELECT u.username, i.invited_ms FROM team_invites i JOIN users u ON u.id = i.user_id WHERE i.team_id = ? AND i.invited_ms > ? ORDER BY i.invited_ms DESC', mineBuilt.t.id, nowMs - INVITE_MS)
              .map((i) => ({ username: i.username, invitedMs: i.invited_ms }))
          : [],
      };
    }
    const invites = db
      .all<{ team_id: number; name: string; tag: string; invited_ms: number }>(
        'SELECT i.team_id, t.name, t.tag, i.invited_ms FROM team_invites i JOIN teams t ON t.id = i.team_id WHERE i.user_id = ? AND i.invited_ms > ? ORDER BY i.invited_ms DESC',
        me.id,
        nowMs - INVITE_MS,
      )
      .map((i) => ({ teamId: i.team_id, name: i.name, tag: i.tag, members: this.d.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM team_members WHERE team_id = ?', i.team_id)?.n ?? 0, invitedMs: i.invited_ms }));
    const previous = week - WEEK_MS;
    const places = db
      .all<{ place: number; team_name: string; team_tag: string; score_pct: number; members: number }>('SELECT place, team_name, team_tag, score_pct, members FROM team_week_results WHERE week_start_ms = ? ORDER BY place', previous)
      .map((r) => ({ place: r.place, teamName: r.team_name, teamTag: r.team_tag, scorePct: r.score_pct, members: r.members }));
    return {
      weekStartMs: week,
      endsMs: week + WEEK_MS,
      me: mine,
      invites,
      teams,
      total: all.length,
      lastWeek: places.length > 0 ? { weekStartMs: previous, places } : null,
      limits: { maxMembers: MAX_MEMBERS, minScored: MIN_SCORED, nameMin: 3, nameMax: 20, tagMin: 2, tagMax: 4 },
    };
  }

  // ---- changing ------------------------------------------------------------------------------------------------------

  private isBot(userId: number): boolean {
    return this.d.db.get('SELECT 1 AS x FROM bots WHERE user_id = ?', userId) !== undefined;
  }

  private tellTeam(teamId: number, except?: number): void {
    for (const m of this.d.db.all<{ user_id: number }>('SELECT user_id FROM team_members WHERE team_id = ?', teamId)) if (m.user_id !== except) this.d.tell?.(m.user_id, 'teams', {});
  }

  private canPlay(me: User): void {
    if (this.isBot(me.id)) throw new TeamError('cannot_join', 'Computer players do not join teams.', 403);
    if (me.role === 'owner') throw new TeamError('cannot_join', 'The owner runs the game and does not join a team.', 403);
  }

  create(me: User, rawName: unknown, rawTag: unknown, rawOpen: unknown): TeamsView {
    this.canPlay(me);
    const name = cleanTeamName(rawName);
    const tag = cleanTeamTag(rawTag);
    const open = rawOpen === false ? 0 : 1;
    const nowMs = this.d.now();
    this.d.db.tx(() => {
      if (this.teamOf(me.id)) throw new TeamError('already_in_team', 'You are already in a team. Leave it first.', 409);
      if (this.d.db.get('SELECT 1 AS x FROM teams WHERE name_key = ?', name.toLowerCase())) throw new TeamError('name_taken', `There is already a team called "${name}".`, 409);
      if (this.d.db.get('SELECT 1 AS x FROM teams WHERE tag_key = ?', tag.toLowerCase())) throw new TeamError('tag_taken', `The tag ${tag} is already used by another team.`, 409);
      const id = this.d.db.run('INSERT INTO teams(name, name_key, tag, tag_key, leader_id, open, created_ms) VALUES (?, ?, ?, ?, ?, ?, ?)', name, name.toLowerCase(), tag, tag.toLowerCase(), me.id, open, nowMs).lastInsertRowid;
      this.d.db.run('INSERT INTO team_members(user_id, team_id, joined_ms) VALUES (?, ?, ?)', me.id, id, nowMs);
      this.d.db.run('DELETE FROM team_invites WHERE user_id = ?', me.id);
    });
    this.d.log.info('teams', `${me.username} started the team "${name}" [${tag}].`);
    return this.view(me);
  }

  join(me: User, rawTeamId: unknown): TeamsView {
    this.canPlay(me);
    if (typeof rawTeamId !== 'number' || !Number.isInteger(rawTeamId)) throw new TeamError('bad_request', 'teamId must be the number of a team.', 400);
    const nowMs = this.d.now();
    let team: TeamDbRow | undefined;
    this.d.db.tx(() => {
      if (this.teamOf(me.id)) throw new TeamError('already_in_team', 'You are already in a team. Leave it first.', 409);
      team = this.teamRow(rawTeamId);
      if (!team) throw new TeamError('no_such_team', 'There is no such team.', 404);
      const invited = this.d.db.get('SELECT 1 AS x FROM team_invites WHERE team_id = ? AND user_id = ? AND invited_ms > ?', team.id, me.id, nowMs - INVITE_MS) !== undefined;
      if (team.open !== 1 && !invited) throw new TeamError('team_closed', `${team.name} is only for players the leader invites.`, 403);
      const count = this.d.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM team_members WHERE team_id = ?', team.id)?.n ?? 0;
      if (count >= MAX_MEMBERS) throw new TeamError('team_full', `${team.name} is full (${MAX_MEMBERS} players).`, 409);
      this.d.db.run('INSERT INTO team_members(user_id, team_id, joined_ms) VALUES (?, ?, ?)', me.id, team.id, nowMs);
      this.d.db.run('DELETE FROM team_invites WHERE user_id = ?', me.id);
    });
    const t = team as TeamDbRow | undefined;
    if (t) this.tellTeam(t.id, me.id);
    this.d.log.info('teams', `${me.username} joined the team "${t?.name ?? ''}".`);
    return this.view(me);
  }

  /** Takes a player out of his team. If he led it, the oldest member leads; if he was the last one, the team ends. */
  private removeMember(userId: number): { teamId: number; ended: boolean } | null {
    const t = this.teamOf(userId);
    if (!t) return null;
    const { db } = this.d;
    db.run('DELETE FROM team_members WHERE user_id = ?', userId);
    const rest = db.all<{ user_id: number }>('SELECT user_id FROM team_members WHERE team_id = ? ORDER BY joined_ms, user_id', t.id);
    if (rest.length === 0) {
      db.run('DELETE FROM teams WHERE id = ?', t.id);
      return { teamId: t.id, ended: true };
    }
    if (t.leader_id === userId) db.run('UPDATE teams SET leader_id = ? WHERE id = ?', (rest[0] as { user_id: number }).user_id, t.id);
    return { teamId: t.id, ended: false };
  }

  leave(me: User): TeamsView {
    let gone: { teamId: number; ended: boolean } | null = null;
    this.d.db.tx(() => {
      gone = this.removeMember(me.id);
    });
    const g = gone as { teamId: number; ended: boolean } | null;
    if (!g) throw new TeamError('not_in_team', 'You are not in a team.', 409);
    if (!g.ended) this.tellTeam(g.teamId);
    this.d.log.info('teams', `${me.username} left team ${g.teamId}${g.ended ? ' (which ended)' : ''}.`);
    return this.view(me);
  }

  private leaderTeam(me: User): TeamDbRow {
    const t = this.teamOf(me.id);
    if (!t) throw new TeamError('not_in_team', 'You are not in a team.', 409);
    if (t.leader_id !== me.id) throw new TeamError('not_leader', 'Only the leader of the team can do that.', 403);
    return t;
  }

  invite(me: User, rawUsername: unknown): TeamsView {
    const t = this.leaderTeam(me);
    if (typeof rawUsername !== 'string') throw new TeamError('bad_request', 'username must be the name of a player.', 400);
    const target = this.playerOrThrow(rawUsername);
    const nowMs = this.d.now();
    this.d.db.tx(() => {
      if (this.isBot(target.id) || this.d.db.get("SELECT 1 AS x FROM users WHERE id = ? AND role = 'owner'", target.id)) throw new TeamError('cannot_join', `${target.username} cannot join a team.`, 403);
      if (this.teamOf(target.id)) throw new TeamError('already_in_team', `${target.username} is already in a team.`, 409);
      if ((this.d.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM team_members WHERE team_id = ?', t.id)?.n ?? 0) >= MAX_MEMBERS) throw new TeamError('team_full', `${t.name} is full (${MAX_MEMBERS} players).`, 409);
      this.d.db.run('DELETE FROM team_invites WHERE team_id = ? AND invited_ms <= ?', t.id, nowMs - INVITE_MS);
      const open = this.d.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM team_invites WHERE team_id = ?', t.id)?.n ?? 0;
      const again = this.d.db.get('SELECT 1 AS x FROM team_invites WHERE team_id = ? AND user_id = ?', t.id, target.id) !== undefined;
      if (open >= MAX_INVITES && !again) throw new TeamError('too_many_invites', `You already have ${MAX_INVITES} invitations waiting. Wait for answers first.`, 429);
      this.d.db.run('INSERT INTO team_invites(team_id, user_id, invited_ms) VALUES (?, ?, ?) ON CONFLICT(team_id, user_id) DO UPDATE SET invited_ms = excluded.invited_ms', t.id, target.id, nowMs);
    });
    this.d.tell?.(target.id, 'teams', {});
    return this.view(me);
  }

  private playerOrThrow(username: string): { id: number; username: string; displayName: string } {
    try {
      return this.d.playerRef(username);
    } catch {
      throw new TeamError('no_such_player', `There is no player called "${username.trim()}".`, 404);
    }
  }

  /** The invited player says no (the invitation is removed). */
  decline(me: User, rawTeamId: unknown): TeamsView {
    if (typeof rawTeamId !== 'number' || !Number.isInteger(rawTeamId)) throw new TeamError('bad_request', 'teamId must be the number of a team.', 400);
    this.d.db.run('DELETE FROM team_invites WHERE team_id = ? AND user_id = ?', rawTeamId, me.id);
    return this.view(me);
  }

  kick(me: User, rawUsername: unknown): TeamsView {
    const t = this.leaderTeam(me);
    if (typeof rawUsername !== 'string') throw new TeamError('bad_request', 'username must be the name of a player.', 400);
    const row = this.d.db.get<{ id: number }>('SELECT u.id FROM users u JOIN team_members m ON m.user_id = u.id WHERE u.username = ? AND m.team_id = ?', rawUsername.trim().replace(/^@+/, ''), t.id);
    if (!row) throw new TeamError('no_such_player', `${rawUsername.trim()} is not in your team.`, 404);
    if (row.id === me.id) throw new TeamError('bad_request', 'You cannot remove yourself. Leave the team, or give the lead to somebody else first.', 400);
    this.d.db.run('DELETE FROM team_members WHERE user_id = ? AND team_id = ?', row.id, t.id);
    this.d.tell?.(row.id, 'teams', {});
    this.tellTeam(t.id, me.id);
    return this.view(me);
  }

  /** The leader gives the lead to another member. */
  lead(me: User, rawUsername: unknown): TeamsView {
    const t = this.leaderTeam(me);
    if (typeof rawUsername !== 'string') throw new TeamError('bad_request', 'username must be the name of a player.', 400);
    const row = this.d.db.get<{ id: number }>('SELECT u.id FROM users u JOIN team_members m ON m.user_id = u.id WHERE u.username = ? AND m.team_id = ?', rawUsername.trim().replace(/^@+/, ''), t.id);
    if (!row) throw new TeamError('no_such_player', `${rawUsername.trim()} is not in your team.`, 404);
    this.d.db.run('UPDATE teams SET leader_id = ? WHERE id = ?', row.id, t.id);
    this.tellTeam(t.id, me.id);
    return this.view(me);
  }

  settings(me: User, rawOpen: unknown): TeamsView {
    const t = this.leaderTeam(me);
    if (typeof rawOpen !== 'boolean') throw new TeamError('bad_request', 'open must be true or false.', 400);
    this.d.db.run('UPDATE teams SET open = ? WHERE id = ?', rawOpen ? 1 : 0, t.id);
    this.tellTeam(t.id, me.id);
    return this.view(me);
  }

  /** The leader ends his team; the owner and the moderators can end any team (for a name that should not be there). */
  disband(me: User, rawTeamId: unknown): TeamsView {
    const own = this.teamOf(me.id);
    const wanted = rawTeamId === undefined || rawTeamId === null ? own?.id : rawTeamId;
    if (typeof wanted !== 'number' || !Number.isInteger(wanted)) throw new TeamError('bad_request', 'teamId must be the number of a team.', 400);
    const t = this.teamRow(wanted);
    if (!t) throw new TeamError('no_such_team', 'There is no such team.', 404);
    const staff = isStaff(me.role as Role);
    if (t.leader_id !== me.id && !staff) throw new TeamError('not_leader', 'Only the leader of the team can end it.', 403);
    const members = this.d.db.all<{ user_id: number }>('SELECT user_id FROM team_members WHERE team_id = ?', t.id).map((m) => m.user_id);
    this.d.db.tx(() => {
      this.d.db.run('DELETE FROM team_members WHERE team_id = ?', t.id);
      this.d.db.run('DELETE FROM teams WHERE id = ?', t.id);
    });
    for (const u of members) if (u !== me.id) this.d.tell?.(u, 'teams', {});
    this.d.log.info('teams', `${me.username} ended the team "${t.name}" [${t.tag}].`);
    return this.view(me);
  }

  // ---- the weekly race ------------------------------------------------------------------------------------------------

  /**
   * When the week has changed, writes down the best three teams of the week that ended and gives the winning team's members who joined early enough the Team Champion looks.
   * Safe to call as often as you like: a week is only ever settled once (the week is kept in the "meta" list). Returns the number of teams that placed.
   */
  rollWeek(): number {
    const week = weekStartOf(this.d.now());
    if (week === this.markedWeek) return 0;
    const { db } = this.d;
    const done = Number(db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', WEEK_KEY)?.value ?? 0);
    if (done === week) {
      this.markedWeek = week;
      return 0;
    }
    const previous = week - WEEK_MS;
    const earned: number[] = [];
    let placed = 0;
    db.tx(() => {
      if (done > 0 && !db.get('SELECT 1 AS x FROM team_week_results WHERE week_start_ms = ?', previous)) {
        const growth = this.d.lastGrowth();
        const built = db
          .all<TeamDbRow>('SELECT id, name, tag, leader_id, open, created_ms FROM teams ORDER BY id')
          .map((t) => {
            const members = db.all<{ user_id: number; joined_ms: number }>('SELECT user_id, joined_ms FROM team_members WHERE team_id = ? AND joined_ms < ?', t.id, week);
            return { t, members, ...this.scoreOf(members.map((m) => m.user_id), growth) };
          })
          .filter((x) => x.scorePct !== null && (x.scorePct as number) > 0)
          .sort((a, b) => (b.scorePct as number) - (a.scorePct as number) || b.scored - a.scored || a.t.id - b.t.id)
          .slice(0, 3);
        built.forEach((x, i) => {
          db.run('INSERT OR IGNORE INTO team_week_results(week_start_ms, place, team_name, team_tag, score_pct, members) VALUES (?, ?, ?, ?, ?, ?)', previous, i + 1, x.t.name, x.t.tag, x.scorePct, x.members.length);
          for (const m of x.members) {
            if (m.joined_ms > week - TROPHY_DAYS * 86_400_000) continue;
            db.run('INSERT OR IGNORE INTO team_week_members(week_start_ms, place, user_id) VALUES (?, ?, ?)', previous, i + 1, m.user_id);
            if (i === 0) earned.push(m.user_id);
          }
          placed += 1;
        });
      }
      db.run('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', WEEK_KEY, String(week));
    });
    this.markedWeek = week;
    for (const userId of earned) {
      const got: string[] = [];
      for (const item of TEAM_CHAMPION_LOOKS) if (this.d.award?.(userId, item, 'the weekly team race')) got.push(item);
      if (got.length > 0) this.d.tell?.(userId, 'earned', { reason: 'the weekly team race', items: got.map((id) => ({ id, name: cosmeticById(id)?.name ?? id })) });
    }
    if (placed > 0) this.d.log.info('teams', `The weekly team race is over: ${placed} team(s) placed.`);
    return placed;
  }
}
