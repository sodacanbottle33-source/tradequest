// Earnings routes: one company's fundamentals and reports, and the calendar of reports across the market (docs/world.md §7.5).

import { HttpError, intParam } from '../http';
import type { Router } from '../router';
import type { Services } from '../services';
import { Earnings, earningsWorldOf } from '../earnings';

export function registerEarningsRoutes(router: Router, s: Services, earnings: Earnings = new Earnings(s.db, earningsWorldOf(s.world))): Earnings {
  const { world } = s;

  router.get('/api/market/:ticker/earnings', (ctx) => {
    const c = world.companyByTicker(ctx.params.ticker ?? '');
    if (!c) throw new HttpError(404, 'unknown_company', 'No such company.');
    const limit = intParam(ctx.url, 'limit', 8, 1, 40);
    return { tick: world.sim.tick, ...earnings.forCompany(c, world.sim.tick, limit) };
  });

  router.get('/api/earnings', (ctx) => {
    const hours = intParam(ctx.url, 'hours', 24, 1, 72);
    const tick = world.sim.tick;
    return { tick, hours, upcoming: earnings.upcoming(tick, hours), recent: earnings.recent(tick, hours) };
  });

  return earnings;
}
