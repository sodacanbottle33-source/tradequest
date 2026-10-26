// Learn: the tutorial bookmarks and the practice lessons (docs/world.md §19). Every route needs a signed-in player; all the rules are in server/learn.ts.

import { HttpError } from '../http';
import { LearnError } from '../learn';
import type { Router } from '../router';
import type { Services } from '../services';

export function registerLearnRoutes(router: Router, s: Services): void {
  const { learn } = s;

  function guard<T>(fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      if (error instanceof LearnError) throw new HttpError(error.status, error.code, error.message);
      throw error;
    }
  }

  async function guardAsync<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof LearnError) throw new HttpError(error.status, error.code, error.message);
      throw error;
    }
  }

  router.get('/api/learn/state', (ctx) => guard(() => learn.state(ctx.requireUser())));

  router.post('/api/learn/tutorial', async (ctx) => {
    const user = ctx.requireUser();
    const b = await ctx.body();
    return guard(() => learn.tutorialDone(user, b.step));
  });

  router.post('/api/learn/lesson/start', (ctx) => guard(() => learn.start(ctx.requireUser())));

  router.post('/api/learn/lesson/answer', async (ctx) => {
    const user = ctx.requireUser();
    const b = await ctx.body();
    return guard(() => learn.answer(user, { lessonId: b.lessonId, choice: b.choice, reason: b.reason }));
  });

  router.post('/api/learn/lesson/skip', async (ctx) => {
    const user = ctx.requireUser();
    const b = await ctx.body();
    return guard(() => learn.skip(user, b.lessonId));
  });

  router.post('/api/learn/lesson/coach', async (ctx) => {
    const user = ctx.requireUser();
    const b = await ctx.body();
    return guardAsync(() => learn.coach(user, b.lessonId));
  });
}
