// News routes: the public feed, one item, one company's feed, health, and the owner-only view of what moves a price.

import { HttpError, intParam } from '../http';
import type { Router } from '../router';
import type { Services } from '../services';
import { CATEGORY_LABEL, TICKS_PER_HOUR } from '../../src/world';
import { EVENT_LOOKAHEAD_TICKS } from '../world/runtime';

export function registerNewsRoutes(router: Router, s: Services): void {
  const { world } = s;
  const news = s.news;
  const scheduler = s.scheduler;
  if (!news) return;
  const ms = (tick: number): number => world.msOfTick(tick);
  const categories = new Set<string>(Object.keys(CATEGORY_LABEL));

  function feedParams(url: URL): { limit: number; before?: string; category?: string; breakingOnly: boolean } {
    const limit = intParam(url, 'limit', 30, 1, 100);
    const before = url.searchParams.get('before') ?? undefined;
    if (before !== undefined && !/^\d+:\d+$/.test(before)) throw new HttpError(400, 'bad_parameter', 'before must look like 12345:67 (the "next" value of the previous page).');
    const category = url.searchParams.get('category') ?? undefined;
    if (category !== undefined && !categories.has(category)) throw new HttpError(400, 'bad_parameter', `Unknown category "${category}".`);
    const breaking = url.searchParams.get('breaking');
    if (breaking !== null && breaking !== '0' && breaking !== '1' && breaking !== 'true' && breaking !== 'false') throw new HttpError(400, 'bad_parameter', 'breaking must be 1 or 0.');
    return { limit, before, category, breakingOnly: breaking === '1' || breaking === 'true' };
  }

  router.get('/api/news', (ctx) => {
    const p = feedParams(ctx.url);
    const r = news.feed({ tick: world.sim.tick, ...p }, ms);
    return { tick: world.sim.tick, items: r.items, next: r.next };
  });

  router.get('/api/news/health', () => {
    const clock = world.currentTick();
    return { ...news.health(clock, clock + EVENT_LOOKAHEAD_TICKS), scheduler: scheduler?.status() ?? null };
  });

  router.get('/api/news/:id', (ctx) => {
    const id = Number(ctx.params.id);
    if (!Number.isSafeInteger(id) || id < 1) throw new HttpError(400, 'bad_parameter', 'The news id must be a number.');
    const item = news.item(id, world.sim.tick, ms);
    if (!item) throw new HttpError(404, 'no_such_news', 'No such news item.');
    return item;
  });

  router.get('/api/market/:ticker/news', (ctx) => {
    const c = world.companyByTicker(ctx.params.ticker ?? '');
    if (!c) throw new HttpError(404, 'unknown_company', 'No such company.');
    const p = feedParams(ctx.url);
    const r = news.feed({ tick: world.sim.tick, companyId: c.id, ...p }, ms);
    return { ticker: c.ticker, tick: world.sim.tick, items: r.items, next: r.next };
  });

  // Owner only: every news item that is moving (or recently moved) this company's price, including the hidden numbers.
  router.get('/api/debug/effects/:ticker', (ctx) => {
    const user = ctx.requireUser();
    if (user.role !== 'owner') throw new HttpError(403, 'owner_only', 'Only the owner can see this.');
    const c = world.companyByTicker(ctx.params.ticker ?? '');
    if (!c) throw new HttpError(404, 'unknown_company', 'No such company.');
    const hours = intParam(ctx.url, 'hours', 6, 1, 72);
    const to = world.sim.tick;
    return { ticker: c.ticker, tick: to, fromTick: to - hours * TICKS_PER_HOUR, items: news.debugEffects(c.id, to - hours * TICKS_PER_HOUR, to + 6 * 360) };
  });
}
