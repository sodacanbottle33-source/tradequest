// Teams and the weekly team race (docs/world.md §37). Every route needs a signed-in player. The page only asks; who may do what in a team, the limits and the score are all decided
// in server/teams.ts.

import { HttpError } from '../http';
import type { Router } from '../router';
import type { Services } from '../services';
import { TeamError } from '../teams';

/** At most this many changes to teams per player per minute, and this many new teams per player per hour. */
export const TEAM_CHANGES_PER_MINUTE = 20;
export const TEAMS_CREATED_PER_HOUR = 3;

export function registerTeamRoutes(router: Router, s: Services): void {
  const { teams } = s;
  const changes = new Map<number, number[]>();
  const created = new Map<number, number[]>();

  function slow(map: Map<number, number[]>, userId: number, windowMs: number, limit: number): void {
    const now = s.now();
    const list = (map.get(userId) ?? []).filter((t) => t > now - windowMs);
    if (list.length >= limit) throw new HttpError(429, 'rate_limited', 'Too many tries. Wait a moment.');
    list.push(now);
    map.set(userId, list);
  }

  function guard<T>(fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      if (error instanceof TeamError) throw new HttpError(error.status, error.code, error.message);
      throw error;
    }
  }

  /** The teams page: his own team (with its members), the invitations he has, the race this week and the winners of last week. */
  router.get('/api/teams', (ctx) => teams.view(ctx.requireUser()));

  router.post('/api/teams/create', async (ctx) => {
    const user = ctx.requireUser();
    slow(created, user.id, 3_600_000, TEAMS_CREATED_PER_HOUR);
    const b = await ctx.body();
    return guard(() => teams.create(user, b.name, b.tag, b.open));
  });

  router.post('/api/teams/join', async (ctx) => {
    const user = ctx.requireUser();
    slow(changes, user.id, 60_000, TEAM_CHANGES_PER_MINUTE);
    const b = await ctx.body();
    return guard(() => teams.join(user, b.teamId));
  });

  router.post('/api/teams/leave', (ctx) => {
    const user = ctx.requireUser();
    slow(changes, user.id, 60_000, TEAM_CHANGES_PER_MINUTE);
    return guard(() => teams.leave(user));
  });

  router.post('/api/teams/invite', async (ctx) => {
    const user = ctx.requireUser();
    slow(changes, user.id, 60_000, TEAM_CHANGES_PER_MINUTE);
    const b = await ctx.body();
    return guard(() => teams.invite(user, b.username));
  });

  router.post('/api/teams/decline', async (ctx) => {
    const user = ctx.requireUser();
    slow(changes, user.id, 60_000, TEAM_CHANGES_PER_MINUTE);
    const b = await ctx.body();
    return guard(() => teams.decline(user, b.teamId));
  });

  router.post('/api/teams/kick', async (ctx) => {
    const user = ctx.requireUser();
    slow(changes, user.id, 60_000, TEAM_CHANGES_PER_MINUTE);
    const b = await ctx.body();
    return guard(() => teams.kick(user, b.username));
  });

  router.post('/api/teams/lead', async (ctx) => {
    const user = ctx.requireUser();
    slow(changes, user.id, 60_000, TEAM_CHANGES_PER_MINUTE);
    const b = await ctx.body();
    return guard(() => teams.lead(user, b.username));
  });

  router.post('/api/teams/settings', async (ctx) => {
    const user = ctx.requireUser();
    slow(changes, user.id, 60_000, TEAM_CHANGES_PER_MINUTE);
    const b = await ctx.body();
    return guard(() => teams.settings(user, b.open));
  });

  /** The leader ends his team; the owner and the moderators can end any team ({ teamId }). */
  router.post('/api/teams/disband', async (ctx) => {
    const user = ctx.requireUser();
    slow(changes, user.id, 60_000, TEAM_CHANGES_PER_MINUTE);
    const b = await ctx.body();
    return guard(() => teams.disband(user, b.teamId));
  });
}
