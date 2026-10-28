// The Shop (docs/world.md §29). Every route needs a signed-in player. The page only asks; what a thing costs, who may buy it and what a player wears are all decided
// in server/cosmetics.ts. What everybody wears is one list that every signed-in page keeps (like the profile pictures).

import { HttpError } from '../http';
import { ShopError } from '../cosmetics';
import type { Router } from '../router';
import type { Services } from '../services';

/** At most this many buys, and this many changes of what is worn, per player per minute. */
export const BUYS_PER_MINUTE = 10;
export const EQUIPS_PER_MINUTE = 30;

export function registerShopRoutes(router: Router, s: Services): void {
  const { shop } = s;
  const asked = new Map<string, number[]>();

  function slow(kind: 'buy' | 'equip', userId: number, limit: number): void {
    const now = s.now();
    const key = `${kind}:${userId}`;
    const list = (asked.get(key) ?? []).filter((t) => t > now - 60_000);
    if (list.length >= limit) throw new HttpError(429, 'rate_limited', 'Too many tries. Wait a moment.');
    list.push(now);
    asked.set(key, list);
  }

  function guard<T>(fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      if (error instanceof ShopError) throw new HttpError(error.status, error.code, error.message, error.extra);
      throw error;
    }
  }

  /** The Shop page: his cash, what he owns, what he wears, and which badges that some things need he has. (The things themselves are in the page's own catalog.) */
  router.get('/api/shop', (ctx) => shop.view(ctx.requireUser()));

  router.post('/api/shop/buy', async (ctx) => {
    const user = ctx.requireUser();
    slow('buy', user.id, BUYS_PER_MINUTE);
    const b = await ctx.body();
    return guard(() => shop.buy(user, b.item));
  });

  router.post('/api/shop/equip', async (ctx) => {
    const user = ctx.requireUser();
    slow('equip', user.id, EQUIPS_PER_MINUTE);
    const b = await ctx.body();
    return guard(() => shop.equip(user, b.slot, b.item));
  });

  /** What everybody wears: username -> the things in each place. A player who wears nothing is not in it. */
  router.get('/api/looks', (ctx) => {
    ctx.requireUser();
    return { looks: shop.looks() };
  });
}
