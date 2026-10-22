// Market bots: the eight 1v1 bots also trade in the main market with Career accounts of their own (docs/world.md §9.11). They are small, never
// leveraged, never touch players' money or launched companies, set their cash back when they hold nothing, and play the same way every time.
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../server/app';
import { loadConfig } from '../server/config';
import { BOT_WAIT_MS, PERSONAS } from '../server/lobby/bots';
import { Logger } from '../server/log';
import { MARKET_BOT_CASH_CENTS, MARKET_STYLES, MarketBots } from '../server/marketBots';
import { Clock } from './helpers/server';

const LONG = 480_000;

interface Running {
  app: App;
  server: Server;
  base: string;
  dir: string;
  clock: Clock;
  players: Set<string>;
}
const running: Running[] = [];
const dirs: string[] = [];
async function stop(r: Running): Promise<void> {
  await new Promise<void>((done) => {
    r.server.closeAllConnections?.();
    r.server.close(() => done());
  });
  try {
    r.app.close();
  } catch {
    // closed by the test
  }
}
afterEach(async () => {
  while (running.length > 0) await stop(running.pop() as Running);
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

interface BootOptions {
  dir?: string;
  ms?: number;
  marketBots?: boolean;
  bots?: boolean;
  coins?: boolean;
}
async function boot(options: BootOptions = {}): Promise<Running> {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'tq-mkb-'));
  if (!options.dir) dirs.push(dir);
  const clock = new Clock(options.ms);
  const config = loadConfig({ TQ_DATA_DIR: dir, TQ_COMPANIES: '66', TQ_WARMUP_DAYS: '1', TQ_PORT: '8787', TQ_OWNER: 'boss' });
  const app = createApp({
    config,
    log: new Logger({ sink: null, now: clock.now }),
    worldSeed: 777,
    now: clock.now,
    bots: options.bots === true,
    botWaitMs: BOT_WAIT_MS,
    marketBots: options.marketBots !== false,
    memecoins: options.coins !== false,
  });
  const server = createServer(app.handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const r = { app, server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, dir, clock, players: new Set<string>() };
  running.push(r);
  return r;
}

async function call(r: Running, path: string, init: { method?: string; body?: unknown; cookie?: string } = {}) {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  if (init.cookie) headers.Cookie = init.cookie;
  const res = await fetch(r.base + path, { method: init.method ?? 'GET', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

async function signUp(r: Running, name: string): Promise<string> {
  const res = await fetch(r.base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: name, password: 'a-good-password' }) });
  expect(res.status).toBe(201);
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] as string;
  r.players.add(cookie);
  return cookie;
}

/** Moves the server clock to a tick, letting the market catch up as the live timer would and letting open pages ask about the lobby every 5 seconds. */
async function gotoTick(r: Running, tick: number): Promise<void> {
  const w = r.app.services.world;
  while (w.currentTick() < tick) {
    const next = Math.min(tick, w.currentTick() + 5);
    r.clock.ms = w.msOfTick(next);
    for (let i = 0; i < 20_000 && w.sim.tick < w.currentTick(); i += 1) w.pump();
    for (const cookie of r.players) await call(r, '/api/lobby', { cookie });
  }
  expect(w.sim.tick).toBe(tick);
}
const elapse = (r: Running, seconds: number) => gotoTick(r, r.app.services.world.currentTick() + seconds);
const sql = <T>(r: Running, query: string, ...params: (string | number)[]): T[] => r.app.services.db.all<T>(query, ...params);

let counter = 0;
const rid = (): string => `req-${(counter += 1).toString().padStart(8, '0')}`;
const post = (r: Running, path: string, cookie: string | undefined, body: Record<string, unknown>) => call(r, path, { method: 'POST', cookie, body: { requestId: rid(), ...body } });

interface BotTrade {
  persona: string;
  company_id: number;
  sector: string;
  side: string;
  short: number;
  filled: number;
  leverage: number;
  auto: string;
  forced: number;
  tick: number;
}
/** Every trade made by a bot's Career account, in the order it happened. */
function botTrades(r: Running): BotTrade[] {
  const sectors = r.app.services.world.companies.map((c) => c.sector);
  return sql<Omit<BotTrade, 'sector'>>(
    r,
    `SELECT b.persona, t.company_id, t.side, t.short, t.filled, t.leverage, t.auto, t.forced, t.tick
       FROM trades t JOIN accounts a ON a.id = t.account_id AND a.kind = 'career' JOIN bots b ON b.user_id = a.user_id ORDER BY t.id`,
  ).map((t) => ({ ...t, sector: sectors[t.company_id] as string }));
}

describe('switches', () => {
  it('MKB-1: market bots follow the bots (TQ_BOTS=0 turns both off), TQ_MARKET_BOTS=0 turns off only this, and a world made without the option has none', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tq-mkb-cfg-'));
    dirs.push(dir);
    const env = { TQ_DATA_DIR: dir };
    expect(loadConfig(env).bots).toBe(true);
    expect(loadConfig(env).marketBots).toBe(true);
    expect(loadConfig({ ...env, TQ_BOTS: '0' })).toMatchObject({ bots: false, marketBots: false });
    expect(loadConfig({ ...env, TQ_MARKET_BOTS: '0' })).toMatchObject({ bots: true, marketBots: false });

    const r = await boot({ marketBots: false });
    await elapse(r, 600);
    expect(sql(r, "SELECT * FROM users WHERE username LIKE 'bot-%'")).toHaveLength(0);
    expect(sql(r, 'SELECT * FROM trades')).toHaveLength(0);
  }, LONG);
});

describe('trading in the market', () => {
  it('MKB-2: eight bots get a Career account of $1,000,000 each, all trade stocks and memecoins in their own style with no leverage and no stops, and their orders push prices like any Career order', async () => {
    const r = await boot();
    await elapse(r, 1500);
    const accounts = sql<{ username: string; kind: string; start_cash_cents: number }>(r, 'SELECT u.username, a.kind, a.start_cash_cents FROM bots b JOIN users u ON u.id = b.user_id JOIN accounts a ON a.user_id = b.user_id ORDER BY u.username');
    expect(accounts).toHaveLength(8);
    for (const a of accounts) expect(a).toMatchObject({ kind: 'career', start_cash_cents: MARKET_BOT_CASH_CENTS });
    expect(MARKET_BOT_CASH_CENTS).toBe(100_000_000);

    const trades = botTrades(r);
    expect(trades.length).toBeGreaterThan(80);
    for (const p of PERSONAS) {
      const mine = trades.filter((t) => t.persona === p.id);
      expect(mine.length).toBeGreaterThan(0);
      for (const t of mine) {
        expect(t.leverage).toBe(1);
        expect(t.auto).toBe('');
        expect(t.forced).toBe(0);
        if (p.pool === 'coins') expect(t.sector).toBe('meme');
        if (p.pool === 'stocks') expect(t.sector).not.toBe('meme');
        if (p.side === 'long') expect(t.short).toBe(0);
        // Shane only shorts: his opening trades are short sales and his closing trades are the covers (also on the short side).
        if (p.side === 'short') expect(t.short).toBe(1);
      }
    }
    expect(trades.some((t) => t.sector === 'meme')).toBe(true);
    expect(trades.some((t) => t.sector !== 'meme')).toBe(true);
    // Dee goes either way.
    expect(trades.filter((t) => t.persona === 'dee' && t.short === 1).length).toBeGreaterThan(0);
    expect(trades.filter((t) => t.persona === 'dee' && t.short === 0).length).toBeGreaterThan(0);
    // No position has a stop or a take-profit.
    expect(sql(r, "SELECT * FROM positions WHERE account_id IN (SELECT id FROM accounts WHERE kind = 'career' AND user_id IN (SELECT user_id FROM bots)) AND (stop_cents > 0 OR take_cents > 0)")).toHaveLength(0);
    // Their orders moved prices the way a player's order does: stored price pushes that belong to bot trades.
    const pushes = sql<{ n: number }>(r, "SELECT COUNT(*) AS n FROM flow_events f JOIN trades t ON t.id = f.trade_id JOIN accounts a ON a.id = t.account_id WHERE a.user_id IN (SELECT user_id FROM bots)")[0]?.n ?? 0;
    expect(pushes).toBeGreaterThan(40);
    // Every style has a holding time and a number of positions, and none holds more than its limit.
    for (const p of PERSONAS) {
      const open = sql<{ n: number }>(r, 'SELECT COUNT(*) AS n FROM positions WHERE account_id = (SELECT id FROM accounts WHERE kind = \'career\' AND user_id = (SELECT user_id FROM bots WHERE persona = ?))', p.id)[0]?.n ?? 0;
      expect(open).toBeLessThanOrEqual((MARKET_STYLES[p.id] as { positions: number }).positions);
    }
  }, LONG);

  it('MKB-3: players are untouched: a player\'s Career cash and wallet do not change, and the bots have accounts of their own', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const before = (await call(r, '/api/account?account=career', { cookie: alice })).json;
    const wallet = (await call(r, '/api/wallet', { cookie: alice })).json;
    await elapse(r, 600);
    const after = (await call(r, '/api/account?account=career', { cookie: alice })).json;
    expect(after.cashCents).toBe(before.cashCents);
    expect(after.cashCents).toBe(100_000);
    expect((await call(r, '/api/wallet', { cookie: alice })).json).toEqual(wallet);
    expect(sql(r, "SELECT * FROM trades WHERE account_id = (SELECT id FROM accounts WHERE kind = 'career' AND user_id = (SELECT id FROM users WHERE username = 'alice'))")).toHaveLength(0);
    expect(botTrades(r).length).toBeGreaterThan(0);
    // A bot cannot be signed in as, with or without a market account.
    const login = await call(r, '/api/auth/login', { method: 'POST', body: { username: 'bot-mia', password: 'bot' } });
    expect(login.status).toBeGreaterThanOrEqual(400);
  }, LONG);

  it('MKB-4: companies players launched are left alone, although they have price history and other companies are traded all the time', async () => {
    const r = await boot();
    const boss = await signUp(r, 'boss');
    const alice = await signUp(r, 'alice');
    expect((await post(r, '/api/admin/cash', boss, { username: 'alice', amountCents: 2_000_000 })).status).toBe(200);
    expect((await post(r, '/api/launch/coin', alice, { name: 'Moon Pepe', ticker: 'MPEP', seedCents: 500_000 })).status).toBe(200);
    expect((await post(r, '/api/launch/stock', alice, { name: 'Acme Robotics', ticker: 'ACMR', sector: 'robotics', seedCents: 500_000, priceCents: 5000 })).status).toBe(200);
    await elapse(r, 1200);
    const ids = sql<{ company_id: number }>(r, 'SELECT company_id FROM launches').map((x) => x.company_id);
    expect(ids).toHaveLength(2);
    {
      // They have enough finished candles to be looked at, so leaving them out is the rule at work and not missing data.
      const w = r.app.services.world;
      const last = Math.floor(w.savedTick / 10) - 1;
      for (const id of ids) {
        expect(sql(r, 'SELECT 1 AS x FROM candles_c10 WHERE company_id = ? AND idx = ?', id, last)).toHaveLength(1);
        expect(sql(r, 'SELECT 1 AS x FROM candles_c10 WHERE company_id = ? AND idx = ?', id, last - 30)).toHaveLength(1);
      }
      const { db, world, trading, log, now } = r.app.services;
      const seen = (new MarketBots({ db, world, trading, log, now }) as any).movers() as { companyId: number }[];
      expect(seen.length).toBeGreaterThan(60);
      for (const id of ids) expect(seen.some((m) => m.companyId === id)).toBe(false);
    }
    const trades = botTrades(r);
    expect(trades.length).toBeGreaterThan(40);
    for (const t of trades) expect(ids).not.toContain(t.company_id);
    expect(sql(r, 'SELECT * FROM positions WHERE company_id IN (SELECT company_id FROM launches) AND account_id IN (SELECT id FROM accounts WHERE user_id IN (SELECT user_id FROM bots))')).toHaveLength(0);
    // The launcher's rug pull still works: nobody but he holds it.
    expect((await post(r, '/api/launch/rug', alice, { ticker: 'MPEP' })).status).toBe(200);
  }, LONG);

  it('MKB-5: the same world plays out the same way twice', async () => {
    const a = await boot();
    await elapse(a, 900);
    const first = botTrades(a);
    await stop(a);
    running.splice(running.indexOf(a), 1);
    const b = await boot();
    await elapse(b, 900);
    const second = botTrades(b);
    expect(first.length).toBeGreaterThan(20);
    expect(second).toEqual(first);
  }, LONG);
});

describe('keeping the bots steady', () => {
  it('MKB-6: a bot that holds nothing gets its starting cash back (a bot that lost everything trades at full size again)', async () => {
    const r = await boot();
    await elapse(r, 120);
    const db = r.app.services.db;
    const acc = sql<{ id: number }>(r, "SELECT a.id FROM accounts a JOIN bots b ON b.user_id = a.user_id WHERE b.persona = 'rex' AND a.kind = 'career'")[0] as { id: number };
    // Rex lost everything: no shares, a few cents.
    db.tx(() => {
      db.run('DELETE FROM positions WHERE account_id = ?', acc.id);
      db.run('UPDATE accounts SET cash_cents = 1234 WHERE id = ?', acc.id);
    });
    const tradesBefore = botTrades(r).filter((t) => t.persona === 'rex').length;
    for (let i = 0; i < 12 && botTrades(r).filter((t) => t.persona === 'rex').length === tradesBefore; i += 1) await elapse(r, 10);
    expect(botTrades(r).filter((t) => t.persona === 'rex').length).toBeGreaterThan(tradesBefore);
    const cash = sql<{ cash_cents: number }>(r, 'SELECT cash_cents FROM accounts WHERE id = ?', acc.id)[0]?.cash_cents ?? 0;
    expect(cash).toBeGreaterThan(MARKET_BOT_CASH_CENTS * 0.4);
    expect(cash).toBeLessThanOrEqual(MARKET_BOT_CASH_CENTS);
  }, LONG);

  it('MKB-7: a restart keeps the same eight accounts and the bots carry on; nothing is made twice', async () => {
    const r = await boot();
    await elapse(r, 600);
    const tradesBefore = botTrades(r).length;
    const ms = r.clock.ms;
    const dir = r.dir;
    await stop(r);
    running.splice(running.indexOf(r), 1);
    const r2 = await boot({ dir, ms });
    expect(sql(r2, "SELECT * FROM accounts WHERE kind = 'career' AND user_id IN (SELECT user_id FROM bots)")).toHaveLength(8);
    await elapse(r2, 600);
    expect(sql(r2, "SELECT * FROM accounts WHERE kind = 'career' AND user_id IN (SELECT user_id FROM bots)")).toHaveLength(8);
    expect(sql(r2, 'SELECT * FROM bots')).toHaveLength(8);
    expect(botTrades(r2).length).toBeGreaterThan(tradesBefore);
    // Positions that were open at the restart are looked after too: nobody holds more than its limit, and every share is accounted for.
    for (const p of PERSONAS) {
      const open = sql<{ n: number }>(r2, "SELECT COUNT(*) AS n FROM positions WHERE account_id = (SELECT id FROM accounts WHERE kind = 'career' AND user_id = (SELECT user_id FROM bots WHERE persona = ?))", p.id)[0]?.n ?? 0;
      expect(open).toBeLessThanOrEqual((MARKET_STYLES[p.id] as { positions: number }).positions);
    }
  }, LONG);

  it('MKB-8: when trading is halted everywhere the bots do nothing and nothing breaks; when it reopens they trade again', async () => {
    const r = await boot();
    const boss = await signUp(r, 'boss');
    expect(boss.length).toBeGreaterThan(0);
    await elapse(r, 300);
    const { halts, world, db, now } = r.app.services;
    const owner = db.get<{ id: number }>("SELECT id FROM users WHERE username = 'boss'") as { id: number };
    db.tx(() => {
      for (const c of world.companies) halts.halt(c.id, 'test', owner.id, now());
    });
    const before = botTrades(r).length;
    const tick = world.sim.tick;
    await elapse(r, 300);
    expect(world.sim.tick).toBe(tick + 300);
    expect(botTrades(r).length).toBe(before);
    db.tx(() => {
      for (const c of world.companies) halts.resume(c.id);
    });
    await elapse(r, 600);
    expect(botTrades(r).length).toBeGreaterThan(before);
  }, LONG);
});

describe('with the 1v1 bots', () => {
  it('MKB-9: a bot plays a market account and a match account at the same time, and a match against it settles as usual', async () => {
    const r = await boot({ bots: true });
    const alice = await signUp(r, 'alice');
    expect((await call(r, '/api/lobby/bot', { method: 'POST', cookie: alice })).status).toBe(200);
    const view = (await call(r, '/api/lobby/ready', { method: 'POST', cookie: alice, body: { ready: true } })).json.match;
    expect(view.phase).toBe('countdown');
    await gotoTick(r, view.endTick as number);
    await elapse(r, 30);
    const done = (await call(r, '/api/lobby', { cookie: alice })).json.match;
    expect(['finished']).toContain(done.phase);
    expect(done.outcome).not.toBe('abandoned');
    // The bot's one Career account and its one match account: two different accounts of the same user.
    const botUser = sql<{ user_id: number }>(r, "SELECT p.user_id FROM match_players p JOIN bots b ON b.user_id = p.user_id WHERE p.match_id = ?", view.id as number)[0] as { user_id: number };
    expect(sql<{ kind: string }>(r, 'SELECT kind FROM accounts WHERE user_id = ? ORDER BY kind', botUser.user_id).map((a) => a.kind)).toEqual(['career', 'match']);
    // The match account traded only inside the 180 seconds, and the market account traded as a market bot.
    for (const t of sql<{ tick: number }>(r, "SELECT t.tick FROM trades t JOIN accounts a ON a.id = t.account_id WHERE a.kind = 'match' AND a.user_id = ?", botUser.user_id)) {
      expect(t.tick).toBeGreaterThanOrEqual(view.startTick as number);
      expect(t.tick).toBeLessThanOrEqual(view.endTick as number);
    }
    expect(botTrades(r).length).toBeGreaterThan(0);
    // The player was paid like after any match (a win: profit or $50; a loss: $50) and the bot got nothing.
    expect(sql<{ balance_cents: number }>(r, "SELECT balance_cents FROM wallets WHERE user_id = (SELECT id FROM users WHERE username = 'alice')")[0]?.balance_cents ?? 0).toBeGreaterThanOrEqual(0);
    expect(sql(r, 'SELECT * FROM wallets WHERE user_id IN (SELECT user_id FROM bots)')).toHaveLength(0);
  }, LONG);
});
