// 1v1 routes: join the lobby, get ready, leave; challenge a friend; match history and the virtual-currency wallet.
// The client only ever asks. What the lobby looks like, whether the match has started and who won are answered by the server.

import { ChallengeError } from '../challenges';
import { HttpError, intParam } from '../http';
import { LobbyError } from '../lobby/service';
import type { Router } from '../router';
import type { Services } from '../services';

export function registerLobbyRoutes(router: Router, s: Services): void {
  const { matches } = s;
  const recent = new Map<number, number[]>();

  function limited(userId: number): void {
    const now = s.now();
    const list = (recent.get(userId) ?? []).filter((t) => t > now - 10_000);
    if (list.length >= 30) throw new HttpError(429, 'rate_limited', 'Too many lobby requests. Wait a moment.');
    list.push(now);
    recent.set(userId, list);
  }

  function guard<T>(fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      if (error instanceof LobbyError || error instanceof ChallengeError) throw new HttpError(error.status, error.code, error.message);
      throw error;
    }
  }

  router.get('/api/lobby', (ctx) => {
    const user = ctx.requireUser();
    return guard(() => ({ match: matches.current(user.id), searching: matches.searching(), bots: matches.botsEnabled, wallet: matches.wallet(user.id).balanceCents }));
  });

  router.post('/api/lobby/join', (ctx) => {
    const user = ctx.requireUser();
    limited(user.id);
    return guard(() => ({ match: matches.join(user.id) }));
  });

  // "Play a bot now": the same as Find a match, and a bot joins at once if nobody else is waiting.
  router.post('/api/lobby/bot', (ctx) => {
    const user = ctx.requireUser();
    limited(user.id);
    return guard(() => ({ match: matches.playBot(user.id) }));
  });

  router.post('/api/lobby/ready', async (ctx) => {
    const user = ctx.requireUser();
    limited(user.id);
    const b = await ctx.body();
    if (typeof b.ready !== 'boolean') throw new HttpError(400, 'bad_request', 'ready must be true or false.');
    return guard(() => ({ match: matches.setReady(user.id, b.ready as boolean) }));
  });

  router.post('/api/lobby/leave', (ctx) => {
    const user = ctx.requireUser();
    limited(user.id);
    return guard(() => ({ match: matches.leave(user.id) }));
  });

  router.post('/api/lobby/dismiss', (ctx) => {
    const user = ctx.requireUser();
    limited(user.id);
    matches.dismiss(user.id);
    return { ok: true };
  });

  // ---- challenges: ask a friend to a 1v1 --------------------------------------------------------------------------------------
  // The client only asks. Who may challenge whom, whether the friend is online, whether the challenge ran out and whether the
  // two players are free to play are all answered by the server (server/challenges.ts).
  const { challenges } = s;
  const sent = new Map<number, number[]>();
  function limitedChallenge(userId: number): void {
    const now = s.now();
    const list = (sent.get(userId) ?? []).filter((t) => t > now - 10_000);
    if (list.length >= 20) throw new HttpError(429, 'rate_limited', 'Too many challenge requests. Wait a moment.');
    list.push(now);
    sent.set(userId, list);
  }

  router.get('/api/challenges', (ctx) => ({ ...challenges.state(ctx.requireUser()), match: null }));

  const challenge = (path: string, run: (user: Parameters<typeof challenges.state>[0], name: string) => { state: ReturnType<typeof challenges.state>; match: ReturnType<typeof matches.current> } | ReturnType<typeof challenges.state>): void => {
    router.post(path, async (ctx) => {
      const user = ctx.requireUser();
      limitedChallenge(user.id);
      const b = await ctx.body();
      if (typeof b.username !== 'string') throw new HttpError(400, 'bad_request', 'username must be the name of a friend.');
      const name = b.username;
      const out = guard(() => run(user, name));
      return 'state' in out ? { ...out.state, match: out.match } : { ...out, match: null };
    });
  };
  challenge('/api/challenges/send', (u, n) => challenges.send(u, n));
  challenge('/api/challenges/accept', (u, n) => challenges.accept(u, n));
  challenge('/api/challenges/decline', (u, n) => challenges.decline(u, n));
  challenge('/api/challenges/cancel', (u, n) => challenges.cancel(u, n));

  router.get('/api/matches', (ctx) => {
    const user = ctx.requireUser();
    const before = ctx.url.searchParams.get('before');
    return { matches: matches.history(user.id, intParam(ctx.url, 'limit', 20, 1, 100), before === null ? undefined : intParam(ctx.url, 'before', 0, 1, Number.MAX_SAFE_INTEGER)) };
  });

  router.get('/api/wallet', (ctx) => {
    const user = ctx.requireUser();
    return matches.wallet(user.id);
  });
}
