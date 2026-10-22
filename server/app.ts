// Builds the whole server: database, world, accounts, routes. `createApp` does not listen on a port, so tests can drive it
// directly; `main.ts` is the small program that listens.

import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { Company } from '../src/world';
import { Admin } from './admin';
import { Auth, AuthError, SESSION_COOKIE } from './auth';
import type { Config } from './config';
import { CircuitBreaker } from './breaker';
import { Liquidator, type PositionClosed } from './liquidation';
import { Halts } from './halts';
import { HttpError, clientIp, parseCookies, sendJson } from './http';
import { Leases, SERVER_LEASE } from './lease';
import { BotTrader } from './lobby/bots';
import { MarginCosts, type MarginCall } from './margin';
import { Earnings, earningsWorldOf } from './earnings';
import { LimitOrders } from './limitOrders';
import { MarketBots } from './marketBots';
import { MarketSignals } from './marketSignals';
import { MatchService } from './lobby/service';
import { Logger } from './log';
import { NewsScheduler } from './news/scheduler';
import { NewsService } from './news/service';
import { HANDLED, Router, makeBodyReader, requireUserOf } from './router';
import { registerAdminRoutes } from './routes/admin';
import { registerLaunchRoutes } from './routes/launch';
import { Launches } from './launch';
import { registerCoreRoutes } from './routes/core';
import { FlowService } from './flow';
import { registerLobbyRoutes } from './routes/lobby';
import { registerEarningsRoutes } from './routes/earnings';
import { registerLimitRoutes } from './routes/limits';
import { registerNewsRoutes } from './routes/news';
import { migrate } from './schema';
import type { Services } from './services';
import { Db } from './sqlite';
import { SseHub } from './sse';
import { OrderError, Trading } from './trading';
import { WorldRuntime, type NewsHooks } from './world/runtime';
import { MarketViews } from './world/views';

export interface AppOptions {
  readonly config: Config;
  readonly now?: () => number;
  readonly log?: Logger;
  /** Leave out for the real news system; null switches news off (tests of other things); or pass your own hooks. */
  readonly news?: NewsHooks | null;
  /** For tests: runs inside each news-generation transaction; throwing aborts that day's news. */
  readonly onNewsGenerate?: (cycle: number) => void;
  readonly worldSeed?: number;
  /** Add the thirty memecoins to the world once (the game turns this on in main.ts; tests leave it off unless they test coins). */
  readonly memecoins?: boolean;
  /** For tests only: how many times the real-market size the pushes of player trades are (default 1, the only strength the game has; 0 = no pushes). */
  readonly flowGain?: number;
  /** Automatic trading pauses after a 10 % move in 5 minutes (server/breaker.ts). On unless this is false (tests of other things). */
  readonly autoPauses?: boolean;
  /** Computer opponents in the 1v1 lobby (the game turns them on in main.ts; tests of other things leave them out). */
  readonly bots?: boolean;
  /** For tests: how many milliseconds a player waits alone before a bot joins (default 10 000). */
  readonly botWaitMs?: number;
  /** The bots also trade in the main market with their own Career accounts (the game turns this on in main.ts; tests of other things leave it out). */
  readonly marketBots?: boolean;
  /** Folder with the built web app (npm run build), served by the same server. */
  readonly staticDir?: string;
  /** Extra setup after the services exist (news, lobby). */
  readonly extend?: (services: Services, router: Router) => void;
}

export interface App {
  readonly services: Services;
  /** The computer traders of the main market, or null when they are off (for tests and the owner's log). */
  readonly marketBots: MarketBots | null;
  readonly router: Router;
  readonly handler: (req: IncomingMessage, res: ServerResponse) => void;
  start(): void;
  close(): void;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
};

const SERVER_LEASE_MS = 30_000;

const DEV_ORIGINS = new Set(['http://localhost:5173', 'http://127.0.0.1:5173']);

/** The news system's events and the stored price pushes of player trades, handed to the world as one source. */
function combineHooks(news: NewsService, flow: FlowService): NewsHooks {
  return {
    bind: (context) => news.bind(context),
    ensureThrough: (tick) => news.ensureThrough(tick),
    eventsActiveAt: (tick) => [...news.eventsActiveAt(tick), ...flow.eventsActiveAt(tick)],
    eventsStartingIn: (from, through) => [...news.eventsStartingIn(from, through), ...flow.eventsStartingIn(from, through)],
    recordMarks: (rows) => news.recordMarks(rows),
  };
}

export function createApp(options: AppOptions): App {
  const { config } = options;
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? new Logger({ level: config.logLevel });
  mkdirSync(config.dataDir, { recursive: true });
  const db = new Db(config.dbFile);
  const applied = migrate(db);
  if (applied.length > 0) log.info('db', `Database updated to schema version ${applied[applied.length - 1]}.`);

  const leases = new Leases({ db, now });
  if (!leases.acquire(SERVER_LEASE, SERVER_LEASE_MS)) {
    db.close();
    throw new Error('Another TradeQuest server is using this database right now. Close it first (only one server may run the market).');
  }

  const newsService = options.news === undefined ? new NewsService({ db, log, now, onGenerate: options.onNewsGenerate }) : null;
  // Price pushes from player trades are stored events like news. They need the real news system's event plumbing, so a world
  // created with news switched off or replaced by test hooks has no trade pushes.
  const flow = newsService ? new FlowService(db, options.flowGain) : null;
  const world = new WorldRuntime({
    db,
    log,
    now,
    companyCount: config.companies,
    warmupDays: config.warmupDays,
    worldSeed: options.worldSeed,
    memecoins: options.memecoins === true,
    news: newsService && flow ? combineHooks(newsService, flow) : options.news === undefined ? newsService : options.news,
  });
  // Leveraged positions whose margin is gone are closed at every market tick, also the ticks replayed below after a stop. So the
  // liquidator is attached BEFORE the market starts; the automatic trading pauses (breaker) are attached after it has caught up.
  let tellPlayers: ((events: readonly PositionClosed[]) => void) | null = null; // set below, once the live stream exists
  const liquidator = new Liquidator({ db, world, log, onClosed: (events) => tellPlayers?.(events) });
  // Interest on loans and borrow fees on shorts are charged every minute (also the replayed ones) BEFORE the liquidator looks, because they raise the price at which a position is closed.
  const costs = new MarginCosts(db, world, () => liquidator.markDirty());
  let tellMargin: ((calls: readonly MarginCall[]) => void) | null = null; // set below, once the live stream exists
  let breakerStep: ((tick: number) => void) | null = null;
  let limitStep: ((tick: number) => void) | null = null;
  let lastStepWarn = 0;
  world.setStepObserver((tick) => {
    for (const [what, step] of [
      ['margin costs', () => costs.step(tick)],
      ['liquidation', () => liquidator.step(tick)],
      // Limit orders whose price has been reached go to the market after the liquidator has closed what it had to close (they fill in the live market only).
      ['limit orders', () => limitStep?.(tick)],
      // A warning is for the live market only: while the market catches up after a stop, the player has not been "watching" those ticks.
      ['margin call', () => (world.lagTicks <= 5 ? tellMargin?.(costs.warnings(tick)) : undefined)],
      ['breaker', () => breakerStep?.(tick)],
    ] as const) {
      try {
        step();
      } catch (error) {
        const t = now();
        if (t - lastStepWarn > 10_000) {
          lastStepWarn = t;
          log.warn(what, `A tick check failed at tick ${tick}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  });
  try {
    world.init();
  } catch (error) {
    leases.release(SERVER_LEASE);
    db.close();
    throw error;
  }
  const scheduler = newsService
    ? new NewsScheduler({ service: newsService, leases, log, now, clockTick: () => world.currentTick() })
    : null;

  const auth = new Auth(db, now, config.ownerUsername);
  const owner = auth.applyOwner();
  log.info('auth', owner ? `The owner is "${owner}".` : config.ownerUsername ? `The owner will be "${config.ownerUsername}" once that name is registered.` : 'There is no owner (the admin panel is off). Run "npm run owner -- <username>" to choose one.');
  const halts = new Halts(db);
  halts.setClock(() => world.sim.tick);
  const trading = new Trading(db, world, now);
  trading.setHalts(halts);
  trading.setFlow(flow);
  trading.setMarginCosts(costs);
  // The order book reacts to what players do: net buying eats the asks and piles up bids, net selling the opposite (flow.ts, liquidity.ts).
  if (flow) world.setBookTilt((companyId, tick) => flow.bookTilt(world.companies[companyId] as Company, tick));
  trading.setLeverageListener(() => liquidator.markDirty());
  // Stop-loss and take-profit orders are executed as ordinary market orders by the trading code (see liquidation.ts).
  liquidator.setExitHandler((accountId, companyId, kind, tick) => trading.closeByExit(accountId, companyId, kind, tick));
  const views = new MarketViews(world);
  views.setHalts(halts);
  const hub = new SseHub();
  // A position the market closed by itself (margin gone, stop-loss, take-profit): the player sees it at once as a pop-up, not at the next refresh.
  tellPlayers = (events) => {
    for (const e of events) {
      const acc = db.get<{ user_id: number; kind: string }>('SELECT user_id, kind FROM accounts WHERE id = ?', e.accountId);
      if (!acc) continue;
      hub.publishTo(acc.user_id, 'position', {
        reason: e.reason,
        account: acc.kind,
        ticker: world.companies[e.companyId]?.ticker ?? '?',
        short: e.short,
        shares: e.shares,
        priceCents: e.priceCents,
        realizedCents: e.realizedCents,
        tick: e.tick,
      });
    }
  };
  // A leveraged or short position that has lost three quarters of its margin: a warning pop-up before the market closes it (margin.ts).
  tellMargin = (calls) => {
    for (const c of calls) {
      const acc = db.get<{ user_id: number }>('SELECT user_id FROM accounts WHERE id = ?', c.accountId);
      if (!acc) continue;
      hub.publishTo(acc.user_id, 'position', {
        reason: 'margin_call',
        account: 'career',
        ticker: world.companies[c.companyId]?.ticker ?? '?',
        short: c.short,
        shares: c.shares,
        priceCents: c.priceCents,
        realizedCents: c.unrealizedCents,
        tick: c.tick,
        leverage: c.leverage,
        liqPriceCents: c.liqPriceCents,
      });
    }
  };
  // Orders that wait for the price (limitOrders.ts). The player is told when one fills or ends, at once, as a pop-up.
  const limits = new LimitOrders({
    db,
    world,
    trading,
    log,
    now,
    isBanned: (userId) => auth.banOf(userId) !== null,
    onChange: (userId, order, what) => hub.publishTo(userId, 'limit', { what, order }),
  });
  limitStep = (tick) => limits.step(tick);
  const matches = new MatchService({
    db,
    world,
    trading,
    log,
    now,
    onChange: (userId, view) => hub.publishTo(userId, 'match', { match: view }),
    bots: options.bots === true,
    botWaitMs: options.botWaitMs,
  });
  const botTrader = options.bots === true ? new BotTrader({ db, world, trading, log }) : null;
  const earnings = new Earnings(db, earningsWorldOf(world));
  const signals = new MarketSignals({ db, earnings, companies: () => world.companies, tilt: (c, tick) => (flow ? flow.bookTilt(c, tick) : 0) });
  const marketBots = options.marketBots === true ? new MarketBots({ db, world, trading, log, now, signals }) : null;
  trading.setGate(matches.gate);
  trading.setCompanyRule(matches.companyRule);
  views.setLaunched(() => new Set(db.all<{ company_id: number }>('SELECT company_id FROM launches').map((r) => r.company_id)));
  views.setPools(() => new Map(db.all<{ company_id: number; pool_cents: number; dead: number }>('SELECT company_id, pool_cents, drained_ms IS NOT NULL AS dead FROM coin_pools').map((r) => [r.company_id, { cents: r.pool_cents, dead: r.dead === 1 }])));
  matches.recover();
  const admin = new Admin({ db, auth, matches, hub, world, news: newsService, trading, halts, views, log, now });
  const launches = new Launches({ db, world, trading, halts, news: newsService, views, hub, log, now, notify: () => hub.publish('notice', admin.notice()), inMatch: (userId) => matches.inMatch(userId) });
  const breaker = options.autoPauses === false ? null : new CircuitBreaker({ world, halts, log, onChange: () => { views.invalidate(); hub.publish('notice', admin.notice()); } });
  breakerStep = breaker ? (tick) => breaker.step(tick) : null;
  const services: Services = {
    config,
    db,
    log,
    now,
    world,
    auth,
    trading,
    views,
    hub,
    leases,
    halts,
    breaker,
    liquidator,
    limits,
    flow,
    admin,
    launches,
    matches,
    news: newsService,
    scheduler,
    resolveAccount(user, which) {
      if (which === 'career') return trading.careerAccountOf(user.id);
      if (which === 'match') {
        const account = matches.accountFor(user.id);
        if (account) return account;
        throw new HttpError(404, 'no_match', 'You have not played a match yet. Join the 1v1 lobby first.');
      }
      throw new HttpError(404, 'no_such_account', `There is no "${which}" account for you right now.`);
    },
  };
  const router = new Router();
  registerCoreRoutes(router, services);
  registerAdminRoutes(router, services, admin);
  registerLaunchRoutes(router, services);
  registerNewsRoutes(router, services);
  registerEarningsRoutes(router, services, earnings);
  registerLimitRoutes(router, services);
  registerLobbyRoutes(router, services);
  options.extend?.(services, router);

  world.onSaved((tick) => matches.settleDue(tick));
  world.onTick((m) => {
    try {
      matches.advance();
    } catch (error) {
      log.error('lobby', `Lobby update failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      botTrader?.step();
    } catch (error) {
      log.error('bots', `Bot update failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      marketBots?.step();
    } catch (error) {
      log.error('bots', `Market bot update failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (hub.size > 0) hub.publish('tick', { t: m.tick, ms: m.ms, p: m.prices, h: m.halves });
    if (newsService) {
      try {
        const fresh = newsService.publishDue(m.tick, (t) => world.msOfTick(t));
        if (hub.size > 0) for (const item of fresh) hub.publish('news', item);
      } catch (error) {
        log.warn('news', `Could not announce new news: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  });

  const staticRoot = options.staticDir && existsSync(options.staticDir) ? resolve(options.staticDir) : null;

  function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
    if (!staticRoot || (req.method !== 'GET' && req.method !== 'HEAD')) return false;
    const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
    let file = join(staticRoot, rel);
    if (file !== staticRoot && !file.startsWith(staticRoot + sep)) return false;
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(staticRoot, 'index.html'); // the app handles its own pages
    if (!existsSync(file)) return false;
    const body = readFileSync(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': file.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  }

  function originAllowed(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return true; // same-site form posts and tools like curl send none; the session cookie is SameSite=Lax anyway
    if (DEV_ORIGINS.has(origin)) return true;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now();
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';
    try {
      if (!url.pathname.startsWith('/api/')) {
        if (serveStatic(req, res, url.pathname)) return;
        throw new HttpError(404, 'not_found', 'Not found.');
      }
      if (method !== 'GET' && method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Only GET and POST are used.');
      if (method === 'POST' && !originAllowed(req)) throw new HttpError(403, 'bad_origin', 'This request came from another website.');
      const found = router.match(method, url.pathname);
      if (!('handler' in found)) {
        throw found.methodMismatch ? new HttpError(405, 'method_not_allowed', 'Wrong method for this address.') : new HttpError(404, 'not_found', 'Not found.');
      }
      const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      const user = auth.userFor(token);
      const headers: Record<string, string | string[]> = {};
      const result = await found.handler({
        req,
        res,
        url,
        params: found.params,
        user,
        ip: clientIp(req),
        token,
        body: makeBodyReader(req),
        headers,
        requireUser: () => requireUserOf(user),
      });
      if (result === HANDLED) return;
      if (typeof result === 'object' && result !== null && 'status' in result && 'body' in result && typeof (result as { status: unknown }).status === 'number') {
        const r = result as { status: number; body: unknown };
        sendJson(res, r.status, r.body, headers);
      } else {
        sendJson(res, 200, result, headers);
      }
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof HttpError) {
        sendJson(res, error.status, { error: { code: error.code, message: error.message, details: error.details } });
      } else if (error instanceof AuthError) {
        sendJson(res, error.status, { error: { code: error.code, message: error.message, details: {} } });
      } else if (error instanceof OrderError) {
        sendJson(res, error.status, { error: { code: error.code, message: error.message, details: error.details } });
      } else {
        log.error('http', `${method} ${url.pathname} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
        sendJson(res, 500, { error: { code: 'server_error', message: 'Something went wrong on the server. It has been logged.', details: {} } });
      }
    } finally {
      const took = Date.now() - started;
      if (took > 500 && !url.pathname.endsWith('/stream')) log.warn('http', `${method} ${url.pathname} took ${took} ms`);
    }
  }

  let purgeTimer: ReturnType<typeof setInterval> | null = null;
  let leaseTimer: ReturnType<typeof setInterval> | null = null;
  return {
    services,
    marketBots,
    router,
    handler: (req, res) => {
      void handle(req, res);
    },
    start() {
      world.start();
      hub.start();
      scheduler?.start();
      leaseTimer = setInterval(() => {
        if (!leases.acquire(SERVER_LEASE, SERVER_LEASE_MS)) log.error('server', 'Lost the server lock: another TradeQuest server has taken over this database. This one should be closed.');
      }, 10_000);
      leaseTimer.unref?.();
      purgeTimer = setInterval(() => auth.purgeExpired(), 3_600_000);
      purgeTimer.unref?.();
    },
    close() {
      world.stop();
      scheduler?.stop();
      hub.stop();
      if (purgeTimer) clearInterval(purgeTimer);
      if (leaseTimer) clearInterval(leaseTimer);
      try {
        leases.release(SERVER_LEASE);
      } finally {
        db.close();
      }
    },
  };
}
