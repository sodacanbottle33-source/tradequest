// Daily goals with the streak, the free looks for streak milestones, and the "while you were away" card (docs/world.md §32 and §33). Every route needs a signed-in player.
// The page only asks. What counts as a finished goal, what it pays, the streak and which looks may be taken are decided in server/daily.ts; the report is made by server/away.ts.

import { DailyError } from '../daily';
import { ShopError } from '../cosmetics';
import { HttpError } from '../http';
import type { Router } from '../router';
import type { Services } from '../services';

/** At most this many claims per player per minute. */
export const CLAIMS_PER_MINUTE = 10;

export function registerDailyRoutes(router: Router, s: Services): void {
  const { daily, away } = s;
  const asked = new Map<number, number[]>();

  function slow(userId: number): void {
    const now = s.now();
    const list = (asked.get(userId) ?? []).filter((t) => t > now - 60_000);
    if (list.length >= CLAIMS_PER_MINUTE) throw new HttpError(429, 'rate_limited', 'Too many tries. Wait a moment.');
    list.push(now);
    asked.set(userId, list);
  }

  /** Today's three goals, how far the player is, his streak and his free looks. Asking also pays any goal he has just finished. */
  router.get('/api/goals', (ctx) => daily.view(ctx.requireUser()));

  /** Takes the free look of a streak milestone: { milestone: 7, item: "c_gold" }. */
  router.post('/api/goals/claim', async (ctx) => {
    const user = ctx.requireUser();
    slow(user.id);
    const b = await ctx.body();
    try {
      return daily.claim(user, b.milestone, b.item);
    } catch (error) {
      if (error instanceof DailyError) throw new HttpError(error.status, error.code, error.message);
      if (error instanceof ShopError) throw new HttpError(error.status, error.code, error.message, error.extra);
      throw error;
    }
  });

  /** What happened while the player was away (null when nothing needs saying). */
  router.get('/api/away', (ctx) => ({ away: away.view(ctx.requireUser()) }));

  /** The player closed the report. */
  router.post('/api/away/dismiss', (ctx) => {
    away.dismiss(ctx.requireUser().id);
    return { ok: true };
  });
}
