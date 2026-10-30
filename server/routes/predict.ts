// The daily prediction (docs/world.md §38) and the market events (§39). Every route needs a signed-in player. The page only asks; the featured stock, the judging and the
// reward are decided in server/predict.ts, and what happens in the evening is decided in server/events.ts.

import { HttpError } from '../http';
import { PredictError } from '../predict';
import type { Router } from '../router';
import type { Services } from '../services';

/** At most this many picks per player per minute (a pick can be made once a day, so this only stops a flood). */
export const PICKS_PER_MINUTE = 10;

export function registerPredictRoutes(router: Router, s: Services): void {
  const { predict, events } = s;
  const asked = new Map<number, number[]>();

  function slow(userId: number): void {
    const now = s.now();
    const list = (asked.get(userId) ?? []).filter((t) => t > now - 60_000);
    if (list.length >= PICKS_PER_MINUTE) throw new HttpError(429, 'rate_limited', 'Too many tries. Wait a moment.');
    list.push(now);
    asked.set(userId, list);
  }

  /** Today's featured stock, the player's guess, how yesterday's went and his record. */
  router.get('/api/predict', (ctx) => predict.view(ctx.requireUser()));

  /** { pick: "up" | "down" }: the guess for today. It can be made once and not changed. */
  router.post('/api/predict/pick', async (ctx) => {
    const user = ctx.requireUser();
    slow(user.id);
    const b = await ctx.body();
    try {
      return predict.pick(user, b.pick);
    } catch (error) {
      if (error instanceof PredictError) throw new HttpError(error.status, error.code, error.message);
      throw error;
    }
  });

  /** When the next market event starts, the one happening now, and the last few. Which companies and which kind it will be is never told ahead. */
  router.get('/api/events', (ctx) => {
    ctx.requireUser();
    return events.view();
  });
}
