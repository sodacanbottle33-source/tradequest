// PayPal TEST payments for Shop looks (docs/world.md §43, server/paypal.ts). Every route needs a signed-in player. When PayPal is not switched on, /api/paypal/config says so and the two
// others answer "not found". The page only asks; the server decides every price, every look and every player.

import { HttpError } from '../http';
import { ShopError } from '../cosmetics';
import { PaypalError } from '../paypal';
import type { Router } from '../router';
import type { Services } from '../services';

/** At most this many orders started, and this many finished, per player per minute. */
export const PAYPAL_STARTS_PER_MINUTE = 10;
export const PAYPAL_FINISHES_PER_MINUTE = 20;

export function registerPaypalRoutes(router: Router, s: Services): void {
  const { paypal } = s;
  const asked = new Map<string, number[]>();

  function slow(kind: 'start' | 'finish', userId: number, limit: number): void {
    const now = s.now();
    const key = `${kind}:${userId}`;
    const list = (asked.get(key) ?? []).filter((t) => t > now - 60_000);
    if (list.length >= limit) throw new HttpError(429, 'rate_limited', 'Too many tries. Wait a moment.');
    list.push(now);
    asked.set(key, list);
  }

  async function guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof ShopError) throw new HttpError(error.status, error.code, error.message, error.extra);
      if (error instanceof PaypalError) throw new HttpError(error.status, error.code, error.message, error.extra);
      throw error;
    }
  }

  /** Whether PayPal test payments are on here, and the public client ID the PayPal button needs. (The secret never leaves the server.) */
  router.get('/api/paypal/config', (ctx) => {
    ctx.requireUser();
    return paypal.publicConfig();
  });

  /** Starts a PayPal order for one look. The price is the server's own; the page only gets the order's id to hand to the PayPal button. */
  router.post('/api/paypal/orders', async (ctx) => {
    const user = ctx.requireUser();
    if (!paypal.enabled()) throw new HttpError(404, 'paypal_off', 'PayPal test payments are not switched on here.');
    slow('start', user.id, PAYPAL_STARTS_PER_MINUTE);
    const b = await ctx.body();
    return guard(() => paypal.createOrder(user, b.item));
  });

  /** Finishes an order the buyer approved: takes the payment, checks it with PayPal and gives the look. */
  router.post('/api/paypal/capture', async (ctx) => {
    const user = ctx.requireUser();
    if (!paypal.enabled()) throw new HttpError(404, 'paypal_off', 'PayPal test payments are not switched on here.');
    slow('finish', user.id, PAYPAL_FINISHES_PER_MINUTE);
    const b = await ctx.body();
    return guard(() => paypal.capture(user, b.orderId));
  });
}
