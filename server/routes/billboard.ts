// The billboard (docs/world.md §30). Anybody can look (the market is public); booking needs a signed-in player. What a place costs, who may book what and who has which place
// are all decided in server/billboard.ts. The page only asks, and shows what the server answers.

import { HttpError } from '../http';
import { BillboardError } from '../billboard';
import type { Router } from '../router';
import type { Services } from '../services';

/** At most this many bookings per player per minute. */
export const BOOKS_PER_MINUTE = 10;

export function registerBillboardRoutes(router: Router, s: Services): void {
  const { billboard } = s;
  const asked = new Map<number, number[]>();

  function slow(userId: number): void {
    const now = s.now();
    const list = (asked.get(userId) ?? []).filter((t) => t > now - 60_000);
    if (list.length >= BOOKS_PER_MINUTE) throw new HttpError(429, 'rate_limited', 'Too many tries. Wait a moment.');
    list.push(now);
    asked.set(userId, list);
  }

  /** The three places and who has them. When the player is signed in it also has his cash and the companies he launched that he can show. */
  router.get('/api/billboard', (ctx) => billboard.view(ctx.user));

  router.post('/api/billboard/book', async (ctx) => {
    const user = ctx.requireUser();
    slow(user.id);
    const b = await ctx.body();
    try {
      return billboard.book(user, b.slot, b.ticker, b.hours);
    } catch (error) {
      if (error instanceof BillboardError) throw new HttpError(error.status, error.code, error.message, error.extra);
      throw error;
    }
  });
}
