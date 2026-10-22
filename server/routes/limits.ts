// Limit order routes (docs/world.md §6.8): place an order that waits for its price, see your orders, cancel one.

import { GOOD_FOR_TICKS, type GoodFor } from '../limitOrders';
import { HttpError, intParam } from '../http';
import type { Router } from '../router';
import type { Services } from '../services';
import { OrderError } from '../trading';

export function registerLimitRoutes(router: Router, s: Services): void {
  const { world, limits } = s;
  const limiter = new Map<number, number[]>();

  const careerOf = (ctx: { requireUser(): import('../auth').User }) => {
    const user = ctx.requireUser();
    return { user, acc: s.resolveAccount(user, 'career') };
  };
  const wrap = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (error) {
      if (error instanceof OrderError) throw new HttpError(error.status, error.code, error.message, error.details);
      throw error;
    }
  };

  // Your orders: the open ones (default) or the latest of all, with how they ended.
  router.get('/api/limit-orders', (ctx) => {
    const { acc } = careerOf(ctx);
    const which = ctx.url.searchParams.get('state') === 'all' ? 'all' : 'open';
    return { tick: world.sim.tick, orders: limits.list(acc.id, which, intParam(ctx.url, 'limit', 50, 1, 200)) };
  });

  // The order form's numbers before the order is placed: ?ticker=&side=&qty=&limit= (cents) &leverage= &short=1
  router.get('/api/limit-orders/estimate', (ctx) => {
    const { acc } = careerOf(ctx);
    const company = world.companyByTicker(ctx.url.searchParams.get('ticker') ?? '');
    if (!company) throw new HttpError(404, 'unknown_company', 'No such company.');
    const side = ctx.url.searchParams.get('side');
    if (side !== 'buy' && side !== 'sell') throw new HttpError(400, 'bad_parameter', 'side must be buy or sell.');
    const short = ctx.url.searchParams.get('short') === '1';
    return wrap(() =>
      limits.estimate({
        accountId: acc.id,
        companyId: company.id,
        side,
        qty: intParam(ctx.url, 'qty', 1, 1, 100_000_000),
        limitPrice: intParam(ctx.url, 'limit', 0, 0, Number.MAX_SAFE_INTEGER),
        leverage: intParam(ctx.url, 'leverage', 1, 1, 50),
        short,
      }),
    );
  });

  // {ticker, side, qty, limitPrice (cents), clientOrderId, leverage?, short?, stopPrice?, takePrice?, goodFor?: '1h' | '1d' | '3d'}
  router.post('/api/limit-orders', async (ctx) => {
    const { user, acc } = careerOf(ctx);
    const recent = (limiter.get(user.id) ?? []).filter((t) => t > s.now() - 10_000);
    if (recent.length >= 40) throw new HttpError(429, 'rate_limited', 'Too many orders too quickly. Wait a moment.');
    recent.push(s.now());
    limiter.set(user.id, recent);

    const b = await ctx.body();
    const company = typeof b.ticker === 'string' ? world.companyByTicker(b.ticker) : undefined;
    if (!company) throw new HttpError(404, 'unknown_company', 'No such company.');
    if (typeof b.qty !== 'number') throw new HttpError(400, 'bad_request', 'qty must be a number of shares.');
    if (typeof b.limitPrice !== 'number') throw new HttpError(400, 'bad_request', 'limitPrice must be a number of cents.');
    if (b.leverage !== undefined && b.leverage !== null && typeof b.leverage !== 'number') throw new HttpError(400, 'bad_request', 'leverage must be a whole number from 1 to 50.');
    if (b.short !== undefined && b.short !== null && typeof b.short !== 'boolean') throw new HttpError(400, 'bad_request', 'short must be true or false.');
    if (b.goodFor !== undefined && b.goodFor !== null && !(typeof b.goodFor === 'string' && b.goodFor in GOOD_FOR_TICKS)) throw new HttpError(400, 'bad_request', 'goodFor must be 1h, 1d or 3d.');
    const price = (name: 'stopPrice' | 'takePrice'): number | undefined => {
      const v = b[name];
      if (v === undefined || v === null) return undefined;
      if (typeof v !== 'number') throw new HttpError(400, 'bad_request', `${name} must be a number of cents.`);
      return v;
    };
    const out = wrap(() =>
      limits.place({
        accountId: acc.id,
        clientOrderId: String(b.clientOrderId ?? ''),
        companyId: company.id,
        side: b.side as 'buy' | 'sell',
        qty: b.qty as number,
        limitPrice: b.limitPrice as number,
        leverage: (b.leverage ?? undefined) as number | undefined,
        short: (b.short ?? undefined) as boolean | undefined,
        stopPrice: price('stopPrice'),
        takePrice: price('takePrice'),
        goodFor: (b.goodFor ?? undefined) as GoodFor | undefined,
      }),
    );
    return { status: out.duplicate ? 200 : 201, body: out };
  });

  // {id}: takes the order out of the market and gives its set-aside cash back.
  router.post('/api/limit-orders/cancel', async (ctx) => {
    const { acc } = careerOf(ctx);
    const b = await ctx.body();
    if (typeof b.id !== 'number') throw new HttpError(400, 'bad_request', 'id must be the number of the order.');
    return wrap(() => limits.cancel(acc.id, b.id as number));
  });
}
