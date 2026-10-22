// Routes for launching stocks and memecoins and for the rug pull. Any signed-in player may use them (the owner too); a banned player is
// signed out on every request, so cannot. Everything about who may do what is checked in server/launch.ts, not here.

import { HttpError } from '../http';
import type { Router } from '../router';
import type { Services } from '../services';

export function registerLaunchRoutes(router: Router, s: Services): void {
  const { launches } = s;
  // A launch or a rug pull is a big step; this only stops a script from hammering the server.
  const limiter = new Map<number, number[]>();
  function throttle(userId: number): void {
    const recent = (limiter.get(userId) ?? []).filter((t) => t > s.now() - 10_000);
    if (recent.length >= 40) throw new HttpError(429, 'rate_limited', 'Too many requests too quickly. Wait a moment.');
    recent.push(s.now());
    limiter.set(userId, recent);
  }

  /** What the Launch tab shows: the forms' options, the player's cash and limits, and the companies he launched. */
  router.get('/api/launch', (ctx) => {
    const user = ctx.requireUser();
    return launches.state(user);
  });

  const num = (ctx: { url: URL }, key: string): number => Number(ctx.url.searchParams.get(key) ?? '');
  // Typing a number goes through bad values on the way; the form shows the sentence instead of an error.
  const forForm = <T>(fn: () => T): { ok: true; preview: T } | { ok: false; problem: string } => {
    try {
      return { ok: true, preview: fn() };
    } catch (error) {
      if (error instanceof HttpError && error.status === 400) return { ok: false, problem: error.message };
      throw error;
    }
  };

  // A starting price is not asked for, for a coin or a stock: the money makes it (server/customCoin.ts, server/customStock.ts). A priceCents sent by an older page is ignored.
  router.get('/api/launch/coin-preview', (ctx) => {
    const user = ctx.requireUser();
    return forForm(() => launches.previewCoin(user, num(ctx, 'seedCents')));
  });

  router.get('/api/launch/stock-preview', (ctx) => {
    const user = ctx.requireUser();
    return forForm(() => launches.previewStock(user, num(ctx, 'seedCents')));
  });

  router.post('/api/launch/coin', async (ctx) => {
    const user = ctx.requireUser();
    throttle(user.id);
    const b = await ctx.body();
    return launches.launchCoin(user, { requestId: b.requestId, name: b.name, ticker: b.ticker, seedCents: b.seedCents, description: b.description, dev: b.dev });
  });

  router.post('/api/launch/stock', async (ctx) => {
    const user = ctx.requireUser();
    throttle(user.id);
    const b = await ctx.body();
    return launches.launchStock(user, { requestId: b.requestId, name: b.name, ticker: b.ticker, sector: b.sector, seedCents: b.seedCents, industry: b.industry, description: b.description });
  });

  router.post('/api/launch/rug', async (ctx) => {
    const user = ctx.requireUser();
    throttle(user.id);
    const b = await ctx.body();
    return launches.rugPull(user, { requestId: b.requestId, ticker: b.ticker });
  });
}
