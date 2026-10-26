// Market, account, order and stream routes.

import { scaleOf } from '../../src/world';
import { OrderError } from '../trading';
import { EVENT_LOOKAHEAD_TICKS } from '../world/runtime';
import { SESSION_COOKIE, SESSION_DAYS, type User } from '../auth';
import { HttpError, intParam, sessionCookie } from '../http';
import { CAREER_CLOSED_IN_MATCH } from '../lobby/service';
import { HANDLED, type Router } from '../router';
import type { Services } from '../services';
import type { Resolution } from '../world/runtime';

function publicUser(u: User): Record<string, unknown> {
  return { id: u.id, username: u.username, displayName: u.displayName, role: u.role };
}

export function registerCoreRoutes(router: Router, s: Services): void {
  const { world, auth, trading, views, hub } = s;
  const orderLimiter = new Map<number, number[]>();

  router.get('/api/health', () => {
    const h = world.health();
    const clock = h.clockTick;
    const n = s.news ? s.news.health(clock, clock + EVENT_LOOKAHEAD_TICKS) : null;
    return {
      ...h,
      ok: h.ok && (n === null || n.ok),
      news: n === null ? null : { ...n, scheduler: s.scheduler?.status() ?? null },
      lobby: s.matches.stats(),
      // What every page shows at the top: the owner's announcement and whether all trading is paused.
      announcement: s.admin.announcement(),
      paused: s.halts.allPaused(),
      serverMs: s.now(),
      streams: hub.size,
      problems: s.log.problems().slice(-10).map((p) => ({ ms: p.ms, level: p.level, area: p.area, message: p.message })),
    };
  });

  // ---- sign-in -------------------------------------------------------------------------------------------------------
  // A banned player is signed out on every request; /api/me says so (and why) so the page can show it instead of a plain login form.
  router.get('/api/me', (ctx) => {
    if (ctx.user) return { user: publicUser(ctx.user) };
    const ban = auth.banOfSession(ctx.token);
    return { user: null, ...(ban ? { banned: { reason: ban.reason, untilMs: ban.untilMs, kind: ban.kind } } : {}) };
  });

  router.post('/api/auth/register', async (ctx) => {
    const b = await ctx.body();
    const { user, token } = await auth.register(String(b.username ?? ''), String(b.password ?? ''), ctx.ip);
    ctx.headers['Set-Cookie'] = sessionCookie(SESSION_COOKIE, token, SESSION_DAYS * 86400, ctx.req.headers['x-forwarded-proto'] === 'https');
    return { status: 201, body: { user: publicUser(user) } };
  });

  router.post('/api/auth/login', async (ctx) => {
    const b = await ctx.body();
    const { user, token } = await auth.login(String(b.username ?? ''), String(b.password ?? ''), ctx.ip);
    ctx.headers['Set-Cookie'] = sessionCookie(SESSION_COOKIE, token, SESSION_DAYS * 86400, ctx.req.headers['x-forwarded-proto'] === 'https');
    return { user: publicUser(user) };
  });

  router.post('/api/auth/logout', (ctx) => {
    auth.logout(ctx.token);
    ctx.headers['Set-Cookie'] = sessionCookie(SESSION_COOKIE, '', 0, false);
    return { ok: true };
  });

  // ---- market --------------------------------------------------------------------------------------------------------
  router.get('/api/market', () => views.overview());

  router.get('/api/market/:ticker', (ctx) => {
    const d = views.detail(ctx.params.ticker ?? '');
    if (!d) throw new HttpError(404, 'unknown_company', 'No such company.');
    return d;
  });

  router.get('/api/market/:ticker/candles', (ctx) => {
    const c = world.companyByTicker(ctx.params.ticker ?? '');
    if (!c) throw new HttpError(404, 'unknown_company', 'No such company.');
    const res = ctx.url.searchParams.get('res') ?? 'c10';
    if (res !== 'c10' && res !== 'h1' && res !== 'd1') throw new HttpError(400, 'bad_parameter', 'res must be c10 (10 seconds), h1 (hour) or d1 (day).');
    const limit = intParam(ctx.url, 'limit', 200, 1, 2000);
    const beforeRaw = ctx.url.searchParams.get('before');
    const before = beforeRaw === null ? undefined : intParam(ctx.url, 'before', 0, 1, Number.MAX_SAFE_INTEGER);
    return { ticker: c.ticker, res, tick: world.sim.tick, candles: world.candles(c.id, res as Resolution, limit, before) };
  });

  router.get('/api/market/:ticker/book', (ctx) => {
    const d = views.depth(ctx.params.ticker ?? '');
    if (!d) throw new HttpError(404, 'not_trading', 'That company is not trading.');
    return d;
  });

  router.get('/api/market/:ticker/estimate', (ctx) => {
    const c = world.companyByTicker(ctx.params.ticker ?? '');
    if (!c) throw new HttpError(404, 'unknown_company', 'No such company.');
    const side = ctx.url.searchParams.get('side');
    if (side !== 'buy' && side !== 'sell') throw new HttpError(400, 'bad_parameter', 'side must be buy or sell.');
    // A coin that costs a tiny fraction of a cent has a trillion tokens, so its orders can be far bigger than the usual 100 million.
    const qty = intParam(ctx.url, 'qty', 1, 1, scaleOf(c) === 1 ? 100_000_000 : c.sharesOutstanding);
    const leverage = intParam(ctx.url, 'leverage', 1, 1, 50);
    // "Spend this much" (cents): the answer's maxQty is then the most tokens that much money buys (never more than the cash you have).
    const budget = ctx.url.searchParams.get('budget') === null ? undefined : intParam(ctx.url, 'budget', 0, 0, Number.MAX_SAFE_INTEGER);
    const shortParam = ctx.url.searchParams.get('short');
    if (shortParam !== null && shortParam !== '0' && shortParam !== '1') throw new HttpError(400, 'bad_parameter', 'short must be 0 or 1.');
    const short = shortParam === '1';
    const which = ctx.url.searchParams.get('account') ?? 'career';
    const accountId = ctx.user ? s.resolveAccount(ctx.user, which).id : null;
    try {
      const e = trading.estimate(accountId, c.id, side, qty, undefined, leverage, short, budget);
      return {
        ticker: c.ticker, side, short, tick: e.tick, mid: e.mid, bid: e.bid, ask: e.ask,
        requestedQty: e.requestedQty, filledQty: e.filledQty, unfilledQty: e.unfilledQty, totalCents: e.totalCents, avgPrice: e.avgPrice,
        firstPrice: e.firstPrice, lastPrice: e.lastPrice, spreadCostCents: e.spreadCostCents, impactCostCents: e.impactCostCents,
        slippageBps: e.slippageBps, note: e.note, maxQty: e.maxQty,
        // Leverage (docs/world.md §6.1): what really leaves your cash (a buy: the margin) or arrives in it (a sell: the value minus the debt
        // repaid), the debt taken on or repaid, the price at which the position would be closed by the market, and the highest leverage
        // this order may use.
        // For a short (docs/world.md §6.2): selling opens it (netCents = the margin that leaves your cash, creditCents = the money from the
        // sale held on the position), buying covers it (netCents = what comes back to you).
        leverage: e.leverage, netCents: e.netCents, debtCents: e.debtCents, creditCents: e.creditCents, liqPrice: e.liqPrice, maxLeverage: e.maxLeverage,
        // The trading fee (docs/world.md §6.6): memecoin orders only, 0 for stocks. netCents already has it counted in (opening: margin plus
        // fee leaves your cash; closing: what comes back, minus the fee). feeBps is the rate, in basis points of the order's value.
        feeCents: e.feeCents, feeBps: e.feeBps,
        // What borrowing costs (docs/world.md §6.7): the yearly rate (basis points) and about how much that is per day (cents) for the debt of a
        // leveraged buy (interest) or the borrowed sale of a short (borrow fee); 0 when nothing is borrowed.
        rateBps: e.rateBps, costDayCents: e.costDayCents,
        // The money pool behind a coin that a player launched (docs/world.md §12.2): the cash in it (null for a company without one), and whether
        // this sale is cut down to what the pool can pay (filledQty is then smaller than requestedQty).
        poolCents: e.poolCents, poolLimited: e.poolLimited,
        // What this order does to the price (basis points; 0 when trades do not move prices): how far the price will be pushed, and how much of that the trader pays.
        moveBps: Math.round(e.flow.move * 10_000 * 10) / 10, paidBps: Math.round(e.flow.paid * 10_000 * 10) / 10,
      };
    } catch (error) {
      if (error instanceof OrderError) throw new HttpError(error.status, error.code, error.message, error.details);
      throw error;
    }
  });

  // ---- account and orders --------------------------------------------------------------------------------------------
  router.get('/api/account', (ctx) => {
    const user = ctx.requireUser();
    const acc = s.resolveAccount(user, ctx.url.searchParams.get('account') ?? 'career');
    return trading.view(acc.id);
  });

  router.get('/api/account/trades', (ctx) => {
    const user = ctx.requireUser();
    const acc = s.resolveAccount(user, ctx.url.searchParams.get('account') ?? 'career');
    const before = ctx.url.searchParams.get('before');
    return { trades: trading.trades(acc.id, intParam(ctx.url, 'limit', 50, 1, 200), before === null ? undefined : intParam(ctx.url, 'before', 0, 1, Number.MAX_SAFE_INTEGER)) };
  });

  router.post('/api/orders', async (ctx) => {
    const user = ctx.requireUser();
    const recent = (orderLimiter.get(user.id) ?? []).filter((t) => t > s.now() - 10_000);
    if (recent.length >= 40) throw new HttpError(429, 'rate_limited', 'Too many orders too quickly. Wait a moment.');
    recent.push(s.now());
    orderLimiter.set(user.id, recent);

    const b = await ctx.body();
    const company = typeof b.ticker === 'string' ? world.companyByTicker(b.ticker) : undefined;
    if (!company) throw new HttpError(404, 'unknown_company', 'No such company.');
    if (typeof b.qty !== 'number') throw new HttpError(400, 'bad_request', 'qty must be a number of shares.');
    if (b.limitPrice !== undefined && typeof b.limitPrice !== 'number') throw new HttpError(400, 'bad_request', 'limitPrice must be a number of cents.');
    if (b.leverage !== undefined && typeof b.leverage !== 'number') throw new HttpError(400, 'bad_request', 'leverage must be a whole number from 1 to 50.');
    if (b.short !== undefined && typeof b.short !== 'boolean') throw new HttpError(400, 'bad_request', 'short must be true or false.');
    // null means "not set" (a form that sends every field).
    const price = (name: 'stopPrice' | 'takePrice'): number | undefined => {
      const v = b[name];
      if (v === undefined || v === null) return undefined;
      if (typeof v !== 'number') throw new HttpError(400, 'bad_request', `${name} must be a number of cents.`);
      return v;
    };
    const acc = s.resolveAccount(user, typeof b.account === 'string' ? b.account : 'career');
    // Career money moves prices, and a match is scored on them: no Career orders while this player's own match is starting or running (docs/world.md §9.12).
    if (acc.kind === 'career' && s.matches.inMatch(user.id)) throw new HttpError(409, 'in_match', CAREER_CLOSED_IN_MATCH);
    try {
      const out = trading.placeOrder({
        accountId: acc.id,
        clientOrderId: String(b.clientOrderId ?? ''),
        companyId: company.id,
        side: b.side as 'buy' | 'sell',
        qty: b.qty,
        limitPrice: b.limitPrice as number | undefined,
        leverage: b.leverage as number | undefined,
        short: b.short as boolean | undefined,
        stopPrice: price('stopPrice'),
        takePrice: price('takePrice'),
      });
      return { status: out.duplicate ? 200 : 201, body: out };
    } catch (error) {
      if (error instanceof OrderError) throw new HttpError(error.status, error.code, error.message, error.details);
      throw error;
    }
  });

  // Stop-loss and take-profit of a position that is already open: {ticker, stopPrice?, takePrice?, account?}, a price in cents or null to remove it.
  router.post('/api/positions/exits', async (ctx) => {
    const user = ctx.requireUser();
    const b = await ctx.body();
    const company = typeof b.ticker === 'string' ? world.companyByTicker(b.ticker) : undefined;
    if (!company) throw new HttpError(404, 'unknown_company', 'No such company.');
    const price = (name: 'stopPrice' | 'takePrice'): number | null | undefined => {
      const v = b[name];
      if (v === undefined || v === null) return v;
      if (typeof v !== 'number') throw new HttpError(400, 'bad_request', `${name} must be a number of cents, or null to remove it.`);
      return v;
    };
    const acc = s.resolveAccount(user, typeof b.account === 'string' ? b.account : 'career');
    if (acc.kind === 'career' && s.matches.inMatch(user.id)) throw new HttpError(409, 'in_match', CAREER_CLOSED_IN_MATCH);
    try {
      return { account: trading.setExits(acc.id, company.id, { stopPrice: price('stopPrice'), takePrice: price('takePrice') }) };
    } catch (error) {
      if (error instanceof OrderError) throw new HttpError(error.status, error.code, error.message, error.details);
      throw error;
    }
  });

  // ---- live stream ---------------------------------------------------------------------------------------------------
  router.get('/api/stream', (ctx) => {
    const m = world.tickMessage();
    hub.connect(ctx.req, ctx.res, ctx.user?.id ?? null, { t: m.tick, ms: m.ms, p: m.prices, h: m.halves, serverMs: s.now(), tickMs: 1000 });
    return HANDLED;
  });

}
