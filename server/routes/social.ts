// Friends, the player list and the leaderboard. Every route needs a signed-in player. The client only asks; who is whose friend,
// who is ranked where and what a player may see of another one are all decided here (server/social.ts).

import { HttpError, intParam } from '../http';
import type { Router } from '../router';
import type { Services } from '../services';
import { PLAYERS_PAGE, PLAYERS_PAGE_MAX, SocialError, type Relation } from '../social';

export function registerSocialRoutes(router: Router, s: Services): void {
  const { social } = s;
  const recent = new Map<number, number[]>();

  /** Changing friendships is limited, so nobody can flood other players with requests. */
  function limited(userId: number): void {
    const now = s.now();
    const list = (recent.get(userId) ?? []).filter((t) => t > now - 10_000);
    if (list.length >= 20) throw new HttpError(429, 'rate_limited', 'Too many friend requests too quickly. Wait a moment.');
    list.push(now);
    recent.set(userId, list);
  }

  function guard<T>(fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      if (error instanceof SocialError) throw new HttpError(error.status, error.code, error.message);
      throw error;
    }
  }

  async function nameOf(ctx: { body(): Promise<Record<string, unknown>> }): Promise<string> {
    const b = await ctx.body();
    if (typeof b.username !== 'string') throw new HttpError(400, 'bad_request', 'username must be the name of a player.');
    return b.username;
  }

  router.get('/api/players', (ctx) => {
    const user = ctx.requireUser();
    const q = ctx.url.searchParams.get('q') ?? '';
    if (q.length > 40) throw new HttpError(400, 'bad_parameter', 'The search is too long.');
    return social.players(user, q, intParam(ctx.url, 'limit', PLAYERS_PAGE, 1, PLAYERS_PAGE_MAX), intParam(ctx.url, 'offset', 0, 0, 1_000_000));
  });

  router.get('/api/leaderboard', (ctx) => {
    const user = ctx.requireUser();
    const scope = ctx.url.searchParams.get('scope') ?? 'all';
    if (scope !== 'all' && scope !== 'friends') throw new HttpError(400, 'bad_parameter', 'scope must be all or friends.');
    return social.leaderboard(user, scope);
  });

  router.get('/api/leaderboard/weekly', (ctx) => {
    const user = ctx.requireUser();
    const scope = ctx.url.searchParams.get('scope') ?? 'all';
    if (scope !== 'all' && scope !== 'friends') throw new HttpError(400, 'bad_parameter', 'scope must be all or friends.');
    return social.weekly(user, scope);
  });

  router.get('/api/friends', (ctx) => social.friends(ctx.requireUser()));

  const act = (path: string, run: (user: Parameters<typeof social.friends>[0], name: string) => Relation | void): void => {
    router.post(path, async (ctx) => {
      const user = ctx.requireUser();
      limited(user.id);
      const name = await nameOf(ctx);
      const relation = guard(() => run(user, name)) ?? 'none';
      return { relation, ...social.friends(user) };
    });
  };
  act('/api/friends/request', (u, n) => social.request(u, n));
  act('/api/friends/accept', (u, n) => social.accept(u, n));
  act('/api/friends/decline', (u, n) => social.decline(u, n));
  act('/api/friends/cancel', (u, n) => social.cancel(u, n));
  act('/api/friends/remove', (u, n) => social.remove(u, n));
}
