// Stocks and memecoins that ANY player can launch, and the "rug pull" (server/launch.ts, server/customCoin.ts, server/customStock.ts). The rules
// checked here: the SIZE comes from the money the player puts in (from $2), never from a menu; the money comes out of his own Career cash
// and comes back as shares he holds (no fee on the launch, no profit or loss from it); every input is checked and nothing is half-made; the same
// request never launches twice; a player may hold only a few of his own launches at a time; the launched company is a real one (lists a few seconds
// later, trades, has news, charts and an order book); only the player who launched a company can rug pull it; a rug pull is one ordinary market
// order for everything he holds (fee, spread, price push, halts and partial fills all work as for any order) plus a news story; and adding a company
// to the RUNNING market gives exactly the prices that loading it at a restart gives. (A COIN launched with this version has a money pool and its rug
// pull takes the pool instead, see tests/server-pool.test.ts; the sale rug pull below is tested on stocks and on coins made to look like ones from before
// pools, with `noPool`.)
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../server/app';
import { loadConfig } from '../server/config';
import { COIN_SUPPLY, LAUNCH_FEE_CENTS, MAX_SEED_CENTS, MIN_COIN_PRICE_CENTS, MIN_SEED_CENTS, coinOptions, makeCoinEntry, previewCoin, priceFor, supplyFor } from '../server/customCoin';
import { MAX_STOCK_SEED_CENTS, MIN_STOCK_SEED_CENTS, STOCK_LAUNCH_FEE_CENTS, makeLaunchedStockEntry, previewStock, stockLaunchOptions, stockPriceFor, tierOfSeed } from '../server/customStock';
import { MAX_ACTIVE_PER_KIND, MAX_EVER_PER_KIND } from '../server/launch';
import { Logger } from '../server/log';
import { WorldRuntime } from '../server/world/runtime';
import type { Company } from '../src/world';
import { Clock } from './helpers/server';

const LONG = 240_000;
const BASE = 66; // the hand-written companies; launched companies get the ids after them (and after the thirty built-in coins when the world has them)
const COINS = 30;

interface Running {
  app: App;
  server: Server;
  base: string;
  dir: string;
  clock: Clock;
  withCoins: boolean;
  flowGain: number;
}
const running: Running[] = [];
const dirs: string[] = [];
afterEach(async () => {
  while (running.length > 0) await stop(running.pop() as Running);
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

async function stop(r: Running): Promise<void> {
  await new Promise<void>((done) => {
    r.server.closeAllConnections?.();
    r.server.close(() => done());
  });
  try {
    r.app.close();
  } catch {
    // already closed by the test
  }
}

async function boot(options: { dir?: string; clock?: Clock; withCoins?: boolean; flowGain?: number } = {}): Promise<Running> {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'tq-launch-'));
  if (!options.dir) dirs.push(dir);
  const clock = options.clock ?? new Clock();
  const withCoins = options.withCoins ?? false;
  const flowGain = options.flowGain ?? 0;
  const config = loadConfig({ TQ_DATA_DIR: dir, TQ_COMPANIES: '66', TQ_WARMUP_DAYS: '1', TQ_PORT: '8787', TQ_OWNER: 'boss' });
  const app = createApp({ config, log: new Logger({ sink: null, now: clock.now }), worldSeed: 777, now: clock.now, flowGain, memecoins: withCoins });
  const server = createServer(app.handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const r = { app, server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, dir, clock, withCoins, flowGain };
  running.push(r);
  return r;
}

async function restart(r: Running): Promise<Running> {
  await stop(r);
  running.splice(running.indexOf(r), 1);
  return boot({ dir: r.dir, clock: r.clock, withCoins: r.withCoins, flowGain: r.flowGain });
}

function catchUp(r: Running): void {
  const w = r.app.services.world;
  for (let i = 0; i < 400_000 && w.sim.tick < w.currentTick(); i += 1) w.pump();
  expect(w.sim.tick).toBe(w.currentTick());
}
function advance(r: Running, seconds: number): void {
  r.clock.advanceSeconds(seconds);
  catchUp(r);
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
  return (res.headers.get('set-cookie') ?? '').split(';')[0] as string;
}

async function logIn(r: Running, name: string): Promise<string> {
  const res = await fetch(r.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: name, password: 'a-good-password' }) });
  expect(res.status).toBe(200);
  return (res.headers.get('set-cookie') ?? '').split(';')[0] as string;
}

let counter = 0;
const rid = (): string => `req-${(counter += 1).toString().padStart(8, '0')}`;
const post = (r: Running, path: string, cookie: string | undefined, body: Record<string, unknown>) => call(r, path, { method: 'POST', cookie, body: { requestId: rid(), ...body } });

/** $5,000 put in: a micro coin. The money makes the price too: $160,000 of market cap over 80,000 coins is $2.00 a coin, so the player gets 2,500 coins for $5,000.00. */
const MOON = { name: 'Moon Pepe', ticker: 'MPEP', seedCents: 500_000 };
const launchCoin = (r: Running, cookie: string | undefined, over: Record<string, unknown> = {}) => post(r, '/api/launch/coin', cookie, { ...MOON, ...over });
/**
 * $5,000 put in: a micro-cap stock. The money makes the price too ($5,000 starts at $22.77 a share), so the player gets 219 shares for $4,986.63,
 * and pays the $10.00 launch fee on top.
 */
const ACME = { name: 'Acme Robotics', ticker: 'ACMR', sector: 'robotics', seedCents: 500_000 };
const ACME_PRICE = 2277;
const ACME_SHARES = 219;
const ACME_SPENT = ACME_SHARES * ACME_PRICE; // 498,663
const launchStock = (r: Running, cookie: string | undefined, over: Record<string, unknown> = {}) => post(r, '/api/launch/stock', cookie, { ...ACME, ...over });
const rug = (r: Running, cookie: string | undefined, ticker = 'MPEP', over: Record<string, unknown> = {}) => post(r, '/api/launch/rug', cookie, { ticker, ...over });
/** Makes a coin look like one launched before money pools existed (no pool row): it trades with leverage etc. and its rug pull is the old market sale. */
const noPool = (r: Running, ...tickers: string[]): void => {
  for (const t of tickers.length > 0 ? tickers : ['MPEP']) r.app.services.db.run('DELETE FROM coin_pools WHERE company_id = ?', r.app.services.world.companyByTicker(t)?.id as number);
};
/** The owner gives a player Career cash (a gift counts as a deposit, not as profit). */
const fund = (r: Running, boss: string, username: string, amountCents: number) => post(r, '/api/admin/cash', boss, { username, amountCents });

let orderNo = 0;
const trade = (r: Running, cookie: string, body: Record<string, unknown> = {}) =>
  call(r, '/api/orders', { method: 'POST', cookie, body: { account: 'career', ticker: 'MPEP', side: 'buy', qty: 10, clientOrderId: `order-${(orderNo += 1)}-abcdef`, ...body } });

const market = async (r: Running) => (await call(r, '/api/market')).json.companies as any[];
const rowsOf = (r: Running, sql: string, ...params: (string | number)[]) => r.app.services.db.all(sql, ...params);
const account = async (r: Running, cookie: string) => (await call(r, '/api/account', { cookie })).json;
const launchState = async (r: Running, cookie: string) => (await call(r, '/api/launch', { cookie })).json;
const priceOf = async (r: Running, ticker: string): Promise<number> => (await market(r)).find((c) => c.ticker === ticker).price;

/** A world with the owner ("boss") and one funded player ("alice": $1,000 of her own plus $10,000 from the owner). */
async function twoPlayers(options: { withCoins?: boolean; flowGain?: number } = {}) {
  const r = await boot(options);
  const boss = await signUp(r, 'boss');
  const alice = await signUp(r, 'alice');
  expect((await fund(r, boss, 'alice', 1_000_000)).status).toBe(200);
  return { r, boss, alice };
}

// ---- what money makes ---------------------------------------------------------------------------------------------------------

describe('the size comes from the money', () => {
  const SEEDS = [500_000, 2_500_000, 10_000_000, 50_000_000, 200_000_000, 1_000_000_000]; // $5k, $25k, $100k, $500k, $2M, $10M

  it('LAUNCH-1: from $2; more money makes a bigger, deeper, calmer coin, step by step; there is no size input at all', () => {
    expect(MIN_SEED_CENTS).toBe(200);
    const previews = SEEDS.map((s) => previewCoin(s));
    for (let i = 1; i < previews.length; i += 1) {
      const a = previews[i - 1] as ReturnType<typeof previewCoin>;
      const b = previews[i] as ReturnType<typeof previewCoin>;
      expect(b.marketCapCents).toBeGreaterThan(a.marketCapCents);
      expect(b.liquidityPct).toBeGreaterThan(a.liquidityPct);
      expect(b.typicalMovePct).toBeLessThan(a.typicalMovePct);
      expect(b.spreadBps).toBeLessThan(a.spreadBps);
    }
    expect(previews.map((p) => p.size)).toEqual(['micro', 'micro', 'small', 'mid', 'mid', 'blue']);
    expect(previews[0]).toMatchObject({ sizeLabel: 'Micro coin', marketCapCents: 16_000_000, liquidityPct: 10, typicalMovePct: 45 });
    // In between, it slides smoothly: $10,000 is bigger than $5,000 and smaller than $25,000.
    const mid = previewCoin(1_000_000);
    expect(mid.marketCapCents).toBeGreaterThan(previews[0]!.marketCapCents);
    expect(mid.marketCapCents).toBeLessThan(previews[1]!.marketCapCents);
    // Every coin, whatever the size, moves far more than a stock does (a stock's typical 3-minute move is under 8.5 %).
    expect(Math.min(...previews.map((p) => p.typicalMovePct))).toBeGreaterThanOrEqual(10);
    // The form shows the same ladder: a row for each step, in the same order.
    // (no first buy at all, then three small steps: $2, $100 and $1,000, then the six rows)
    const rungs = [0, 200, 10_000, 100_000, ...SEEDS];
    const rungPreviews = rungs.map((s) => previewCoin(s));
    const form = coinOptions(30);
    expect(form.ladder.map((l) => l.seedCents)).toEqual(rungs);
    expect(form.ladder.map((l) => l.sizeLabel)).toEqual(rungPreviews.map((p) => p.sizeLabel));
    expect(form).toMatchObject({ launchFeeCents: LAUNCH_FEE_CENTS, minSeedCents: MIN_SEED_CENTS, maxSeedCents: MAX_SEED_CENTS, supply: COIN_SUPPLY, fullSupplyFromSeedCents: 500_000, minPriceCents: MIN_COIN_PRICE_CENTS });
    expect(form.ladder.map((l) => l.priceCents)).toEqual(rungPreviews.map((p) => p.priceCents)); // and the starting price each amount makes
    expect(form.ladder.map((l) => l.supply)).toEqual(rungPreviews.map((p) => p.supply)); // and how many coins there are
    expect(Object.keys(form)).not.toContain('tiers');
    for (const gone of ['maxPriceCents', 'minSupply']) expect(Object.keys(form)).not.toContain(gone); // nobody types a price
  });

  it('LAUNCH-2: the money buys whole coins at the starting price it makes; the preview says exactly what leaves the cash', () => {
    const p = previewCoin(500_000);
    expect(p).toMatchObject({ priceCents: 200, stakeShares: 2500, spentCents: 500_000, supply: COIN_SUPPLY });
    // $5,000.50 buys the same 2,500 whole coins: they cost $5,000.00 and the last 50 cents are not taken.
    expect(previewCoin(500_050)).toMatchObject({ stakeShares: 2500, spentCents: 500_000 });
    // An amount the price does not divide into leaves the change in the player's cash.
    const r = previewCoin(777_777);
    expect(r.spentCents).toBe(r.stakeShares * r.priceCents);
    expect(r.spentCents).toBeLessThanOrEqual(777_777);
    expect(777_777 - r.spentCents).toBeLessThan(r.priceCents);
    expect(r.supply * r.priceCents).toBe(r.marketCapCents);
    expect(r.floatShares).toBeLessThanOrEqual(r.supply);
  });

  it('LAUNCH-3: the stake is a real part of the coin and of its order book, so selling it all can be done in one go and shows in the price', () => {
    for (const seed of SEEDS_ALL) {
      const p = previewCoin(seed);
      expect(p.stakePct).toBeGreaterThan(2); // 2–3.2 % of every coin that exists
      expect(p.stakePct).toBeLessThan(3.3);
      expect(p.stakeOfBookPct).toBeGreaterThan(20); // roughly a third of the order book
      expect(p.stakeOfBookPct).toBeLessThan(50);
      expect(p.dumpFilledPct).toBe(100); // the whole stake can be sold at once
      expect(p.dumpPriceDropPct).toBeGreaterThan(2); // and it pushes the price down visibly
      expect(p.dumpCostPct).toBeGreaterThan(3); // but it is never free: spread, push and the 0.5 % fee
      expect(p.dumpCostPct).toBeLessThan(25);
      expect(p.breakEvenRisePct).toBeGreaterThan(p.dumpCostPct);
      expect(p.dumpReceiveCents).toBeLessThan(p.spentCents);
      expect(p.dumpReceiveCents).toBeGreaterThan(p.spentCents * 0.7);
    }
    // $5,000 is the smallest launch and the one the owner asked for: it gets back about $4,000–$4,200 if it is dumped right away.
    const five = previewCoin(500_000);
    expect(five.dumpReceiveCents).toBeGreaterThan(400_000);
    expect(five.dumpReceiveCents).toBeLessThan(430_000);
  });

  it('LAUNCH-4: bad money is refused with a sentence; every amount of money makes a sensible starting price on its own (nobody types one)', () => {
    for (const bad of [1, 100, 199, MAX_SEED_CENTS + 1, 1.5, -5, NaN, '500000', null, undefined, Infinity]) expect(() => previewCoin(bad)).toThrow(/money you put in/); // ($0 is allowed now: no first buy)
    expect(() => previewCoin(100)).toThrow(/\$2 to \$10,000,000/); // the least and the most are stated
    // The least money starts at exactly $2.00 and the most at $5,500.00 (a $440 million market cap over 80,000 coins).
    expect(priceFor(MIN_SEED_CENTS)).toBe(200);
    expect(priceFor(MAX_SEED_CENTS)).toBe(550_000);
    for (const seed of [500_000, 512_345, 999_999, 5_000_000, 12_345_678, 777_777_777, MAX_SEED_CENTS]) {
      const v = previewCoin(seed);
      expect(v.supply).toBe(COIN_SUPPLY); // from $5,000 up (below that: LAUNCH-29)
      expect(v.priceCents).toBeGreaterThanOrEqual(200);
      expect(v.priceCents).toBeLessThan(1_000_000); // under $10,000 a coin
      expect(v.stakeShares).toBeGreaterThanOrEqual(1);
      expect(Number.isSafeInteger(v.marketCapCents)).toBe(true);
      expect(v.dumpFilledPct).toBeGreaterThan(90);
    }
  });

  it('LAUNCH-26: more money, a higher starting price, all the way up; every coin has the same number of coins; the price is the market cap divided by them', () => {
    expect(COIN_SUPPLY).toBe(80_000);
    let last = 0;
    for (let i = 0; i <= 120; i += 1) {
      const seed = Math.round(500_000 * Math.pow(MAX_SEED_CENTS / 500_000, i / 120)); // $5,000 up to $10 million: all of these have 80,000 coins
      const v = previewCoin(seed);
      expect(v.supply).toBe(COIN_SUPPLY);
      expect(v.priceCents).toBe(priceFor(seed));
      expect(v.priceCents).toBeGreaterThanOrEqual(last); // never goes down as the money goes up
      expect(v.marketCapCents).toBe(COIN_SUPPLY * v.priceCents);
      last = v.priceCents;
    }
    // The six steps of the ladder, in dollars a coin: $5,000 is $2.00 and each step up costs more per coin.
    const prices = SEEDS.map((s) => previewCoin(s).priceCents);
    expect(prices[0]).toBe(200);
    for (let i = 1; i < prices.length; i += 1) expect(prices[i]).toBeGreaterThan((prices[i - 1] as number) * 2);
    // Nothing about the price can be typed any more: an old page that still sends one gets the price the money makes.
    const taken = { names: new Set<string>(), tickers: new Set<string>() };
    expect(makeCoinEntry({ ...MOON, priceCents: 9000 } as any, taken).entry.price).toBe(200);
    expect(makeCoinEntry({ ...MOON, priceCents: 1 } as any, taken).entry.price).toBe(200);
  });

  it('LAUNCH-5: the entry carries its own numbers (saved whole), the size follows the money, the name and ticker are checked', () => {
    const taken = { names: new Set(['woofy']), tickers: new Set(['TAKN']) };
    const { entry, preview } = makeCoinEntry({ ...MOON, dev: 'PepeKing', description: 'A moon frog.' }, taken);
    expect(entry).toMatchObject({ ticker: 'MPEP', name: 'Moon Pepe', sector: 'meme', industry: 'Memecoin', price: 200, personality: 'volatile', description: 'A moon frog.' });
    expect(entry.products).toEqual(['Moon Swap', 'Moon Vault']);
    expect(entry.meme).toMatchObject({ supply: preview.supply, dev: 'PepeKing' });
    expect(entry.meme?.vol3m).toBeGreaterThan(0.3); // a small coin: wild
    const big = makeCoinEntry({ ...MOON, name: 'Big Pepe', ticker: 'BPEP', seedCents: 100_000_000 }, taken).entry;
    expect(big.meme?.liquidity as number).toBeGreaterThan(entry.meme?.liquidity as number);
    expect(big.meme?.vol3m as number).toBeLessThan(entry.meme?.vol3m as number);
    expect(big.meme?.supply).toBe(COIN_SUPPLY); // the same number of coins, so more money is a higher price
    expect(entry.meme?.supply).toBe(COIN_SUPPLY);
    expect(big.price).toBeGreaterThan(entry.price * 10);
    expect(makeCoinEntry({ name: 'No Dev', ticker: 'NODV', seedCents: 500_000 }, taken).entry.meme?.dev).toBe('AnonDev');
    const bad = (over: Record<string, unknown>, pattern: RegExp) => expect(() => makeCoinEntry({ ...MOON, ...over }, taken)).toThrow(pattern);
    bad({ name: 'ab' }, /at least 3/);
    bad({ name: 12 }, /must be text/);
    bad({ name: 'x'.repeat(41) }, /at most 40/);
    bad({ name: '12345' }, /letters|contain/);
    bad({ name: 'Woofy' }, /already exists/);
    bad({ ticker: 'AB' }, /3 to 5 letters/);
    bad({ ticker: 'TAKN' }, /already used/);
    bad({ dev: 'two words' }, /no spaces/);
    bad({ description: 'y'.repeat(301) }, /at most 300/);
    bad({ seedCents: 5 }, /money you put in/);
  });

  it('LAUNCH-6: stocks: the size class and the starting price follow the money; a real stake and a fee are needed; the stake is whole shares; the entry has a fixed personality', () => {
    expect(MIN_STOCK_SEED_CENTS).toBe(10_000); // $100: a stock cannot be made for pocket change, and not for free
    expect(MAX_STOCK_SEED_CENTS).toBe(1_000_000_000);
    expect(STOCK_LAUNCH_FEE_CENTS).toBe(1_000);
    const money = [10_000, 500_000, 4_999_999, 5_000_000, 24_999_999, 25_000_000, 99_999_999, 100_000_000, 499_999_999, 500_000_000, 1_000_000_000];
    expect(money.map(tierOfSeed)).toEqual(['micro', 'micro', 'micro', 'small', 'small', 'mid', 'mid', 'large', 'large', 'mega', 'mega']);
    const p = previewStock(500_000);
    expect(p).toMatchObject({ priceCents: ACME_PRICE, stakeShares: ACME_SHARES, spentCents: ACME_SPENT, feeCents: 1_000, totalCents: ACME_SPENT + 1_000, tier: 'micro', tierLabel: 'Micro-cap' });
    expect(500_000 - p.spentCents).toBeLessThan(p.priceCents); // the leftover is less than one share, and stays in the cash
    expect(previewStock(10_000)).toMatchObject({ priceCents: 500, stakeShares: 20, spentCents: 10_000, totalCents: 11_000 }); // the least: $100 buys 20 shares at $5.00
    for (const bad of [0, 1, 199, 9_999, MAX_STOCK_SEED_CENTS + 1, 1.5, NaN, '500000', null, undefined]) expect(() => previewStock(bad)).toThrow(/money you put in/);
    expect(() => previewStock(9_999)).toThrow(/\$100 to/);
    const taken = { names: new Set<string>(), tickers: new Set<string>() };
    const { entry, preview } = makeLaunchedStockEntry({ ...ACME, description: 'Robots.' }, taken);
    expect(entry).toMatchObject({ ticker: 'ACMR', name: 'Acme Robotics', sector: 'robotics', tier: 'micro', personality: 'volatile', price: ACME_PRICE, description: 'Robots.' });
    expect(preview.stakeShares).toBe(ACME_SHARES);
    // A size, a personality or a price typed into the request is ignored: the money decides.
    const forced = makeLaunchedStockEntry({ ...ACME, tier: 'mega', personality: 'income', priceCents: 99_900 } as any, taken).entry;
    expect(forced).toMatchObject({ tier: 'micro', personality: 'volatile', price: ACME_PRICE });
    expect(() => makeLaunchedStockEntry({ ...ACME, sector: 'meme' }, taken)).toThrow(/sector/);
    expect(() => makeLaunchedStockEntry({ ...ACME, ticker: 'x' }, taken)).toThrow(/3 to 5 letters/);
    const form = stockLaunchOptions(30);
    expect(form.tiers.map((t) => [t.id, t.fromSeedCents])).toEqual([['micro', 10_000], ['small', 5_000_000], ['mid', 25_000_000], ['large', 100_000_000], ['mega', 500_000_000]]);
    expect(form).toMatchObject({ launchFeeCents: 1_000, minSeedCents: 10_000, maxSeedCents: 1_000_000_000, listsInSeconds: 30 });
    expect(form.ladder.map((l) => l.seedCents)).toEqual([10_000, 100_000, 1_000_000, 5_000_000, 25_000_000, 100_000_000, 500_000_000, 1_000_000_000]);
    expect(form.ladder.map((l) => l.priceCents)).toEqual([500, 1200, 3000, 6000, 12_000, 25_000, 50_000, 70_000]);
    expect(form.ladder.map((l) => l.priceCents)).toEqual(form.ladder.map((l) => previewStock(l.seedCents).priceCents));
    expect(form.sectors.map((x) => x.id)).not.toContain('meme');
  });

  it('LAUNCH-35: the starting price of a stock follows the money: never down as the money goes up, a whole number of cents, always allowed', () => {
    // The table's own rows are exact; everything in between slides smoothly.
    expect([100, 1_000, 10_000, 50_000, 250_000, 1_000_000, 5_000_000, 10_000_000].map((d) => stockPriceFor(d * 100))).toEqual([500, 1200, 3000, 6000, 12_000, 25_000, 50_000, 70_000]);
    let last = 0;
    for (let seed = MIN_STOCK_SEED_CENTS; seed <= MAX_STOCK_SEED_CENTS; seed = Math.ceil(seed * 1.003)) {
      const price = stockPriceFor(seed);
      expect(Number.isInteger(price)).toBe(true);
      expect(price).toBeGreaterThanOrEqual(last);
      expect(price).toBeGreaterThanOrEqual(200); // the cheapest a stock may start
      expect(price).toBeLessThanOrEqual(100_000); // the dearest
      const v = previewStock(seed);
      expect(v.stakeShares).toBeGreaterThanOrEqual(20); // a real stake: at least 20 shares at any allowed amount
      expect(v.spentCents).toBe(v.stakeShares * v.priceCents);
      expect(v.spentCents).toBeLessThanOrEqual(seed);
      last = price;
    }
    // A bigger stock costs more per share, and the shares held grow with the money.
    expect(previewStock(100_000_000).priceCents).toBeGreaterThan(previewStock(5_000_000).priceCents);
    expect(previewStock(100_000_000).stakeShares).toBeGreaterThan(previewStock(5_000_000).stakeShares);
  });
});

const SEEDS_ALL = [500_000, 2_500_000, 10_000_000, 50_000_000, 200_000_000, 1_000_000_000];

// ---- who can launch, and what it costs -------------------------------------------------------------------------------------------

describe('launching', () => {
  it('LAUNCH-7: any signed-in player can launch and look; signed-out visitors cannot; the owner\'s old coin route is gone; the state carries the forms and the limits', async () => {
    const { r, boss, alice } = await twoPlayers();
    expect((await launchCoin(r, undefined)).status).toBe(401);
    expect((await launchStock(r, undefined)).status).toBe(401);
    expect((await rug(r, undefined)).status).toBe(401);
    expect((await call(r, '/api/launch')).status).toBe(401);
    expect((await call(r, '/api/launch/coin-preview?seedCents=500000')).status).toBe(401);
    expect((await call(r, '/api/launch/stock-preview?seedCents=500000')).status).toBe(401);
    // The owner's own coin route (the earlier owner-only tab) no longer exists: everybody uses the same Launch route.
    expect((await post(r, '/api/admin/coin', boss, MOON)).status).toBe(404);

    const state = await launchState(r, alice);
    expect(state).toMatchObject({ cashCents: 1_100_000, limits: { activePerKind: MAX_ACTIVE_PER_KIND, everPerKind: MAX_EVER_PER_KIND }, counts: { coinActive: 0, coinEver: 0, stockActive: 0, stockEver: 0 }, mine: [] });
    expect(state.coinForm).toMatchObject({ launchFeeCents: 200, minSeedCents: 200, maxSeedCents: 1_000_000_000, supply: 80_000, fullSupplyFromSeedCents: 500_000, minPriceCents: 200, listsInSeconds: 30 });
    expect(state.coinForm.ladder).toHaveLength(10);
    expect(state.stockForm).toMatchObject({ launchFeeCents: 1_000, minSeedCents: 10_000, maxSeedCents: 1_000_000_000, listsInSeconds: 30 });
    expect(state.stockForm.tiers).toHaveLength(5);
    expect(state.stockForm.ladder).toHaveLength(8);
    expect(state.stockForm.sectors.map((x: any) => x.id)).not.toContain('meme');
    expect((await launchState(r, boss)).cashCents).toBe(100_000); // the owner is just another player here
  }, LONG);

  it('LAUNCH-8: the preview routes tell the form what a launch makes and says why a bad one cannot (200, not an error page); looking makes nothing', async () => {
    const { r, alice } = await twoPlayers();
    const ok = (await call(r, '/api/launch/coin-preview?seedCents=500000', { cookie: alice })).json;
    expect(ok.ok).toBe(true);
    expect(ok.preview).toMatchObject({ priceCents: 200, stakeShares: 2500, spentCents: 500_000, cashCents: 1_100_000, enough: true, size: 'micro', dumpFilledPct: 100 });
    const poor = (await call(r, '/api/launch/coin-preview?seedCents=5000000', { cookie: alice })).json;
    expect(poor.preview).toMatchObject({ spentCents: 5_000_000, enough: false });
    // An old page that still sends a price gets the same answer: the money makes the price, whatever is typed.
    const oldPage = await call(r, '/api/launch/coin-preview?seedCents=500000&priceCents=5000', { cookie: alice });
    expect(oldPage.status).toBe(200);
    expect(oldPage.json).toEqual(ok);
    const junk = await call(r, '/api/launch/coin-preview?seedCents=abc', { cookie: alice });
    expect(junk.json).toMatchObject({ ok: false });
    expect(junk.json.problem).toMatch(/money you put in/);
    const tooLittle = await call(r, '/api/launch/coin-preview?seedCents=150', { cookie: alice });
    expect(tooLittle.json.problem).toMatch(/\$2 to/);
    const stock = (await call(r, '/api/launch/stock-preview?seedCents=500000', { cookie: alice })).json;
    expect(stock.preview).toMatchObject({ priceCents: ACME_PRICE, stakeShares: ACME_SHARES, spentCents: ACME_SPENT, feeCents: 1_000, totalCents: ACME_SPENT + 1_000, tier: 'micro', enough: true });
    // An old page that still sends a price gets the same answer: the money makes the price, whatever is typed.
    const oldStock = await call(r, '/api/launch/stock-preview?seedCents=500000&priceCents=100', { cookie: alice });
    expect(oldStock.json).toEqual(stock);
    const bigStock = (await call(r, '/api/launch/stock-preview?seedCents=30000000', { cookie: alice })).json;
    expect(bigStock.preview).toMatchObject({ tier: 'mid', enough: false });
    expect((await call(r, '/api/launch/stock-preview?seedCents=1', { cookie: alice })).json.ok).toBe(false);
    const smallStock = await call(r, '/api/launch/stock-preview?seedCents=9999', { cookie: alice });
    expect(smallStock.json).toMatchObject({ ok: false });
    expect(smallStock.json.problem).toMatch(/\$100 to/);
    expect(rowsOf(r, 'SELECT * FROM launches')).toHaveLength(0);
    expect(await market(r)).toHaveLength(BASE);
  }, LONG);

  it('LAUNCH-9: a coin: the money leaves the cash and comes back as coins; no profit or loss from the launch; it lists seconds later and then trades', async () => {
    const { r, boss, alice } = await twoPlayers();
    const bob = await signUp(r, 'bob');
    const before = await account(r, alice);
    expect(before.cashCents).toBe(1_100_000);

    const made = await launchCoin(r, alice);
    expect(made.status).toBe(200);
    expect(made.json).toMatchObject({ ok: true, duplicate: false, kind: 'coin', ticker: 'MPEP', name: 'Moon Pepe', companyId: BASE, loaded: true, priceCents: 200, stakeShares: 2500, spentCents: 500_000, feeCents: 200, size: 'micro', sizeLabel: 'Micro coin' });
    expect(made.json.startsInSeconds).toBeGreaterThanOrEqual(30);

    const during = await account(r, alice);
    expect(during.cashCents).toBe(599_800); // the $5,000 first buy and the $2.00 launch fee
    expect(during.startCashCents).toBe(1_100_000);
    expect(during.positions).toHaveLength(1);
    expect(during.positions[0]).toMatchObject({ ticker: 'MPEP', shares: 2500, costCents: 500_000, short: false, debtCents: 0 });
    expect(during.positions[0].markCents).toBe(200); // not trading yet: worth what it started at
    expect(during.netWorthCents).toBe(1_099_800); // the first buy is cash turned into coins; only the fee is gone
    expect(during.profitCents).toBe(-200);
    expect(rowsOf(r, 'SELECT * FROM trades WHERE account_id = ?', during.id)).toHaveLength(0); // the launch is no order: no fee, no trade row
    expect(rowsOf(r, 'SELECT user_id, kind, seed_cents, spent_cents, stake_shares, price_cents, fee_cents FROM launches')).toEqual([
      { user_id: (rowsOf(r, "SELECT id FROM users WHERE username = 'alice'")[0] as { id: number }).id, kind: 'coin', seed_cents: 500_000, spent_cents: 500_000, stake_shares: 2500, price_cents: 200, fee_cents: 200 },
    ]);

    // The Launch tab shows it, not trading yet.
    let state = await launchState(r, alice);
    expect(state.counts).toMatchObject({ coinActive: 1, coinEver: 1, stockActive: 0, stockEver: 0 });
    expect(state.mine[0]).toMatchObject({ ticker: 'MPEP', kind: 'coin', listed: false, sharesNow: 2500, canRug: false, rugs: 0, feeCents: 200, profitCents: -200 });
    expect(state.mine[0].listsInSeconds).toBeGreaterThan(0);
    expect(state.mine[0].blocked).toMatch(/not trading yet/);
    // A coin that was made by Alice is not on Bob's list.
    expect((await launchState(r, bob)).mine).toEqual([]);

    let rows = await market(r);
    expect(rows).toHaveLength(BASE + 1);
    expect(rows.find((c) => c.ticker === 'MPEP')).toMatchObject({ id: BASE, name: 'Moon Pepe', sector: 'meme', trading: false });
    const early = await trade(r, bob);
    expect(early.status).toBe(400);
    expect(early.json.error.code).toBe('not_trading');

    advance(r, 45);
    rows = await market(r);
    const now = rows.find((c) => c.ticker === 'MPEP');
    expect(now.trading).toBe(true);
    const detail = (await call(r, '/api/market/MPEP')).json;
    expect(detail).toMatchObject({ ticker: 'MPEP', name: 'Moon Pepe', sector: 'meme', industry: 'Memecoin', products: ['Moon Swap', 'Moon Vault'] });
    expect(detail.sharesOutstanding).toBe(COIN_SUPPLY);
    state = await launchState(r, alice);
    expect(state.mine[0]).toMatchObject({ listed: true, listsInSeconds: 0, canRug: true, blocked: null, halted: false });
    expect(state.mine[0].priceNowCents).toBe(now.price);
    // Worth what it can be sold for: a little less than $5,000 (the buy–sell gap), not zero, not far off.
    expect(state.mine[0].valueNowCents).toBeGreaterThan(400_000);
    expect(state.mine[0].valueNowCents).toBeLessThan(2_500_000);

    // Anybody can trade it and pays the coin fee; the book and the charts work.
    const bought = await trade(r, bob);
    expect(bought.status).toBe(201);
    expect(bought.json.trade.feeCents).toBeGreaterThan(0);
    expect((await call(r, '/api/market/MPEP/book')).status).toBe(200);
    advance(r, 300);
    const candles = (await call(r, '/api/market/MPEP/candles?res=c10&limit=50')).json.candles;
    expect(candles.length).toBeGreaterThan(20);
    expect(candles.every((c: any) => c.low <= c.open && c.low <= c.close && c.high >= c.open && c.high >= c.close && c.low > 0)).toBe(true);

    // The owner sees who launched it; the owner's old "coin" log is unused.
    const admin = (await call(r, '/api/admin/state', { cookie: boss })).json;
    expect(admin.launches).toHaveLength(1);
    expect(admin.launches[0]).toMatchObject({ ticker: 'MPEP', kind: 'coin', username: 'alice', spentCents: 500_000, stakeShares: 2500, sharesNow: 2500, trading: true, rugs: 0, ruggedShares: 0, ruggedCents: 0 });
    expect(admin.stocks).toEqual([]); // a launched coin is not one of the owner's "stocks"
    expect(rowsOf(r, "SELECT * FROM admin_log WHERE action = 'coin'")).toHaveLength(0);
    expect((await call(r, '/api/admin/state', { cookie: alice })).status).toBe(403); // the overview is the owner's
  }, LONG);

  it('LAUNCH-27: the player cannot choose the price of a coin: a price sent along is ignored, and the money makes it (the same for everybody)', async () => {
    const { r, boss, alice } = await twoPlayers();
    expect((await fund(r, boss, 'alice', 20_000_000)).status).toBe(200);
    const bob = await signUp(r, 'bob');
    expect((await fund(r, boss, 'bob', 20_000_000)).status).toBe(200);
    // An old page (or a script) asks for a $999 coin with $5,000: it gets the $2.00 coin that $5,000 makes.
    const cheat = await launchCoin(r, alice, { priceCents: 99_900 });
    expect(cheat.status).toBe(200);
    expect(cheat.json).toMatchObject({ priceCents: 200, stakeShares: 2500, spentCents: 500_000 });
    expect(rowsOf(r, 'SELECT price_cents, stake_shares FROM launches')).toEqual([{ price_cents: 200, stake_shares: 2500 }]);
    // Somebody else with the same money gets the same price; more money gets a higher one.
    const same = await launchCoin(r, bob, { name: 'Moon Frog', ticker: 'MFRG', priceCents: 1 });
    expect(same.json.priceCents).toBe(200);
    const more = await launchCoin(r, bob, { name: 'Moon Whale', ticker: 'MWHL', seedCents: 5_000_000, priceCents: 200 });
    expect(more.status).toBe(200);
    expect(more.json.priceCents).toBe(priceFor(5_000_000));
    expect(more.json.priceCents).toBeGreaterThan(1000);
    // The company really lists at that price with that many coins.
    advance(r, 45);
    const w = r.app.services.world;
    expect(w.companyByTicker('MPEP')?.sharesOutstanding).toBe(COIN_SUPPLY);
    expect(w.companyByTicker('MWHL')?.sharesOutstanding).toBe(COIN_SUPPLY);
    expect(await priceOf(r, 'MWHL')).toBeGreaterThan(await priceOf(r, 'MPEP') * 3);
  }, LONG);

  it('LAUNCH-10: not enough cash: nothing is made, nothing is taken (a new player starts with $1,000)', async () => {
    const r = await boot();
    const bob = await signUp(r, 'bob');
    const res = await launchCoin(r, bob);
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe('not_enough_cash');
    expect(res.json.error.message).toMatch(/\$5,000\.00.*\$1,000\.00/);
    expect((await account(r, bob)).cashCents).toBe(100_000);
    expect((await account(r, bob)).positions).toEqual([]);
    expect(await market(r)).toHaveLength(BASE);
    expect(rowsOf(r, 'SELECT * FROM companies')).toHaveLength(BASE);
    expect(rowsOf(r, 'SELECT * FROM meme_companies')).toHaveLength(0);
    expect(rowsOf(r, 'SELECT * FROM launches')).toHaveLength(0);
    const stock = await launchStock(r, bob);
    expect(stock.json.error.code).toBe('not_enough_cash');
    expect(rowsOf(r, 'SELECT * FROM custom_companies')).toHaveLength(0);
  }, LONG);

  it('LAUNCH-11: a stock: the size class follows the money, the personality is fixed, the stake is a holding at cost, and it trades with no fee', async () => {
    const { r, alice } = await twoPlayers();
    const bob = await signUp(r, 'bob');
    const made = await launchStock(r, alice);
    expect(made.status).toBe(200);
    expect(made.json).toMatchObject({ ok: true, duplicate: false, kind: 'stock', ticker: 'ACMR', name: 'Acme Robotics', companyId: BASE, loaded: true, priceCents: ACME_PRICE, stakeShares: ACME_SHARES, spentCents: ACME_SPENT, feeCents: 1_000, tier: 'micro', tierLabel: 'Micro-cap' });
    const acc = await account(r, alice);
    expect(acc.cashCents).toBe(1_100_000 - ACME_SPENT - 1_000); // the shares and the $10.00 launch fee
    expect(acc.positions[0]).toMatchObject({ ticker: 'ACMR', shares: ACME_SHARES, costCents: ACME_SPENT });
    expect(acc.netWorthCents).toBe(1_100_000 - 1_000); // the shares are cash turned into holdings; only the fee is gone
    expect(acc.profitCents).toBe(-1_000);
    expect(rowsOf(r, 'SELECT price_cents, stake_shares, spent_cents, fee_cents FROM launches')).toEqual([{ price_cents: ACME_PRICE, stake_shares: ACME_SHARES, spent_cents: ACME_SPENT, fee_cents: 1_000 }]);
    const row = rowsOf(r, 'SELECT sector, tier, personality, price_cents, created_by FROM custom_companies')[0] as any;
    expect(row).toMatchObject({ sector: 'robotics', tier: 'micro', personality: 'volatile', price_cents: ACME_PRICE });
    expect(row.created_by).toBe((rowsOf(r, "SELECT id FROM users WHERE username = 'alice'")[0] as { id: number }).id);
    expect(rowsOf(r, 'SELECT * FROM meme_companies')).toHaveLength(0);

    // A size, a personality or a price typed into the request changes nothing: the money decides.
    const forced = await launchStock(r, alice, { name: 'Forced Foods', ticker: 'FRCD', tier: 'mega', personality: 'income', priceCents: 99_900 });
    expect(forced.status).toBe(200);
    expect(forced.json.tier).toBe('micro');
    expect(forced.json.priceCents).toBe(ACME_PRICE);
    expect(r.app.services.world.companyByTicker('FRCD')?.personality).toBe('volatile');

    advance(r, 45);
    expect((await market(r)).find((c) => c.ticker === 'ACMR')).toMatchObject({ trading: true, sector: 'robotics' });
    const bought = await trade(r, bob, { ticker: 'ACMR', qty: 2 });
    expect(bought.status).toBe(201);
    expect(bought.json.trade.feeCents).toBe(0); // stocks pay no fee
    const state = await launchState(r, alice);
    expect(state.mine.map((m: any) => m.ticker)).toEqual(['FRCD', 'ACMR']); // newest first
    expect(state.counts).toMatchObject({ stockActive: 2, stockEver: 2, coinActive: 0 });
  }, LONG);

  it('LAUNCH-12: bad input is refused and nothing is half-made (no company, no row, no cash taken)', async () => {
    const { r, alice } = await twoPlayers();
    const nothingMade = async (): Promise<void> => {
      expect(await market(r)).toHaveLength(BASE);
      expect(rowsOf(r, 'SELECT * FROM companies')).toHaveLength(BASE);
      expect(rowsOf(r, 'SELECT * FROM meme_companies')).toHaveLength(0);
      expect(rowsOf(r, 'SELECT * FROM custom_companies')).toHaveLength(0);
      expect(rowsOf(r, 'SELECT * FROM launches')).toHaveLength(0);
      const acc = await account(r, alice);
      expect(acc.cashCents).toBe(1_100_000);
      expect(acc.positions).toEqual([]);
    };
    const refuse = async (over: Record<string, unknown>, status: number, code: string): Promise<void> => {
      const res = await launchCoin(r, alice, over);
      expect(res.status).toBe(status);
      expect(res.json.error.code).toBe(code);
      await nothingMade();
    };
    await refuse({ name: 'ab' }, 400, 'bad_request');
    await refuse({ ticker: 'ab' }, 400, 'bad_request');
    await refuse({ seedCents: 199 }, 400, 'bad_request'); // under the $2 minimum
    await refuse({ seedCents: 500_000.5 }, 400, 'bad_request');
    await refuse({ dev: 'bad dev' }, 400, 'bad_request');
    expect((await post(r, '/api/launch/coin', alice, { ...MOON, requestId: 'short' })).status).toBe(400);
    await nothingMade();
    // The names of the stocks and of the thirty built-in coins are taken, even in a world that does not have the coins.
    await refuse({ ticker: 'WOOF' }, 409, 'ticker_taken');
    await refuse({ name: 'MoonWoof' }, 409, 'name_taken');
    await refuse({ name: 'moonwoof' }, 409, 'name_taken');
    const companyTicker = (await market(r))[0].ticker as string;
    await refuse({ ticker: companyTicker }, 409, 'ticker_taken');
    // The same checks guard the stock form.
    const badStock = async (over: Record<string, unknown>, status: number, code: string): Promise<void> => {
      const res = await launchStock(r, alice, over);
      expect(res.status).toBe(status);
      expect(res.json.error.code).toBe(code);
      await nothingMade();
    };
    await badStock({ ticker: 'WOOF' }, 409, 'ticker_taken');
    await badStock({ sector: 'meme' }, 400, 'bad_request');
    await badStock({ sector: 'nonsense' }, 400, 'bad_request');
    await badStock({ seedCents: 199 }, 400, 'bad_request');
    await badStock({ seedCents: 1_000 }, 400, 'bad_request'); // $10 is under the $100 minimum
    await badStock({ seedCents: 9_999 }, 400, 'bad_request'); // one cent under it
    await badStock({ seedCents: 0 }, 400, 'bad_request'); // a stock has no free launch
    await badStock({ industry: '<b>' }, 400, 'bad_request');
  }, LONG);

  it('LAUNCH-13: the same request never launches twice or takes the money twice; a reused id for something else, or by somebody else, is refused', async () => {
    const { r, boss, alice } = await twoPlayers();
    const id = 'req-launch-once-0001';
    const first = await post(r, '/api/launch/coin', alice, { ...MOON, requestId: id });
    expect(first.json).toMatchObject({ ok: true, duplicate: false });
    const again = await post(r, '/api/launch/coin', alice, { ...MOON, requestId: id });
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ ok: true, duplicate: true, ticker: 'MPEP', kind: 'coin' });
    expect(await market(r)).toHaveLength(BASE + 1);
    expect(rowsOf(r, 'SELECT * FROM launches')).toHaveLength(1);
    expect((await account(r, alice)).cashCents).toBe(599_800);
    // The same id for another coin, as a stock, or by another player: refused, and nothing changes.
    expect((await post(r, '/api/launch/coin', alice, { ...MOON, ticker: 'OTHR', name: 'Other Coin', requestId: id })).json.error.code).toBe('request_id_reused');
    expect((await post(r, '/api/launch/stock', alice, { ...ACME, requestId: id })).json.error.code).toBe('request_id_reused');
    expect((await post(r, '/api/launch/coin', boss, { ...MOON, requestId: id })).json.error.code).toBe('request_id_reused');
    expect(await market(r)).toHaveLength(BASE + 1);
    // The same ticker again with a new request id is simply taken.
    expect((await launchCoin(r, alice, { name: 'Another Pepe' })).json.error.code).toBe('ticker_taken');
    expect((await launchCoin(r, alice)).json.error.code).toBe('name_taken');
    expect((await account(r, alice)).cashCents).toBe(599_800);
  }, LONG);

  it('LAUNCH-14: a player may hold only 3 of his own launches of one kind at a time (selling out of one, or a rug pull of a coin, frees a place), and 20 ever', async () => {
    const { r, boss, alice } = await twoPlayers();
    expect((await fund(r, boss, 'alice', 3_000_000)).status).toBe(200);
    for (const [name, ticker] of [['Coin Alpha', 'ALPA'], ['Coin Beta', 'BETA'], ['Coin Gamma', 'GAMA']]) {
      expect((await launchCoin(r, alice, { name, ticker })).status).toBe(200);
    }
    const blocked = await launchCoin(r, alice, { name: 'Coin Delta', ticker: 'DELA' });
    expect(blocked.status).toBe(400);
    expect(blocked.json.error.code).toBe('too_many_active');
    expect(blocked.json.error.message).toMatch(/Sell out of one/);
    expect(await market(r)).toHaveLength(BASE + 3);
    // Stocks have their own count.
    expect((await launchStock(r, alice)).status).toBe(200);
    // Sell out of one coin and a place is free again.
    advance(r, 45);
    // (A coin has a money pool: selling all of one's own coins is paid from it and may be cut down to what it holds, so the place is freed with the rug pull, which kills the coin.)
    expect((await rug(r, alice, 'BETA')).status).toBe(200);
    expect((await launchState(r, alice)).counts).toMatchObject({ coinActive: 2, coinEver: 3, stockActive: 1, stockEver: 1 });
    expect((await launchCoin(r, alice, { name: 'Coin Delta', ticker: 'DELA' })).status).toBe(200);

    // 20 launches ever: the 21st is refused even if he holds none of them (a company can never be removed).
    const carol = await signUp(r, 'carol');
    expect((await fund(r, boss, 'carol', 1_000_000)).status).toBe(200);
    const carolId = (rowsOf(r, "SELECT id FROM users WHERE username = 'carol'")[0] as { id: number }).id;
    for (let i = 0; i < MAX_EVER_PER_KIND; i += 1) {
      r.app.services.db.run("INSERT INTO launches(company_id, user_id, kind, request_id, seed_cents, spent_cents, stake_shares, price_cents, created_ms) VALUES (?, ?, 'coin', ?, 500000, 500000, 2500, 200, 0)", i, carolId, `old-launch-${i.toString().padStart(4, '0')}`);
    }
    const ever = await launchCoin(r, carol, { name: 'Coin Omega', ticker: 'OMGA' });
    expect(ever.status).toBe(400);
    expect(ever.json.error.code).toBe('too_many');
    expect(ever.json.error.message).toMatch(/20 coins/);
  }, LONG * 2);
});

// ---- the rug pull -------------------------------------------------------------------------------------------------------------------

describe('the rug pull', () => {
  /** Alice launches the coin and it starts trading; Bob buys a little so there is some market. */
  async function launched(options: { flowGain?: number; withCoins?: boolean } = {}) {
    const { r, boss, alice } = await twoPlayers(options);
    const bob = await signUp(r, 'bob');
    expect((await launchCoin(r, alice)).status).toBe(200);
    noPool(r); // (a coin from before pools: the rug pull sells on the market)
    advance(r, 45);
    expect((await trade(r, bob, { qty: 50 })).status).toBe(201);
    return { r, boss, alice, bob };
  }

  it('LAUNCH-15: only the player who launched a company can rug pull it; nothing else can be rug pulled; before it trades there is nothing to sell', async () => {
    const { r, boss, alice } = await twoPlayers();
    const bob = await signUp(r, 'bob');
    expect((await launchCoin(r, alice)).status).toBe(200);
    const early = await rug(r, alice);
    expect(early.status).toBe(400);
    expect(early.json.error.code).toBe('not_trading');
    advance(r, 45);
    expect((await rug(r, bob)).json.error.code).toBe('not_yours');
    expect((await rug(r, bob)).status).toBe(403);
    expect((await rug(r, boss)).status).toBe(403); // the owner has no special right to dump somebody else's launch
    expect((await rug(r, alice, 'NOPE')).status).toBe(404);
    const builtIn = (await market(r))[0].ticker as string;
    const res = await rug(r, alice, builtIn);
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe('not_a_launch');
    expect((await post(r, '/api/launch/rug', alice, { ticker: 12 })).status).toBe(404);
    expect((await post(r, '/api/launch/rug', alice, { ticker: 'MPEP', requestId: 'x' })).status).toBe(400);
    expect((await account(r, alice)).positions[0].shares).toBe(2500); // none of that sold anything
    expect(rowsOf(r, 'SELECT * FROM launch_rugs')).toHaveLength(0);
    expect(rowsOf(r, "SELECT * FROM news_items WHERE key LIKE 'rug:%'")).toHaveLength(0);
  }, LONG);

  it('LAUNCH-16: the rug pull sells everything he holds in one order: fee and spread paid, cash received, position gone, news published, price pushed down', async () => {
    const { r, boss, alice } = await launched({ flowGain: 1 });
    const cashBefore = (await account(r, alice)).cashCents;
    const pressureBefore = (rowsOf(r, 'SELECT pressure FROM flow_state')[0] as { pressure: number }).pressure;
    expect(pressureBefore).toBeGreaterThan(0); // Bob's buying
    const done = await rug(r, alice);
    expect(done.status).toBe(200);
    const out = done.json;
    expect(out).toMatchObject({ ok: true, duplicate: false, ticker: 'MPEP', name: 'Moon Pepe', requested: 2500, filled: 2500, partial: false, remaining: 0 });
    expect(out.feeCents).toBeGreaterThan(0); // a coin pays the 0.5 % fee
    expect(out.receivedCents).toBeGreaterThan(300_000);
    expect(out.receivedCents).toBeLessThan(500_000 * 1.6);

    const acc = await account(r, alice);
    expect(acc.positions).toEqual([]);
    expect(acc.cashCents).toBe(cashBefore + out.receivedCents);
    const t = rowsOf(r, 'SELECT id, side, requested, filled, total_cents, fee_cents, realized_cents, client_order_id FROM trades WHERE account_id = ?', acc.id) as any[];
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ id: out.tradeId, side: 'sell', requested: 2500, filled: 2500 });
    expect(t[0].client_order_id).toMatch(/^rug-/);
    expect(t[0].total_cents - t[0].fee_cents).toBe(out.receivedCents);
    expect(t[0].realized_cents).toBe(out.receivedCents - 500_000);
    expect(rowsOf(r, 'SELECT trade_id, company_id, shares, received_cents FROM launch_rugs')).toEqual([{ trade_id: out.tradeId, company_id: BASE, shares: 2500, received_cents: out.receivedCents }]);

    // The order pushed the price down like any big sell: a stored price push, and the players' pressure turned negative.
    const flow = rowsOf(r, 'SELECT total FROM flow_events WHERE trade_id = ?', out.tradeId) as { total: number }[];
    expect(flow).toHaveLength(1);
    expect(flow[0]!.total).toBeLessThan(-0.05);
    expect((rowsOf(r, 'SELECT pressure FROM flow_state')[0] as { pressure: number }).pressure).toBeLessThan(0);

    // The news: one story, labelled as a special event, with no price effect of its own.
    const news = rowsOf(r, "SELECT key, source, category, direction, realized, headline, body, company_id FROM news_items WHERE key LIKE 'rug:%'") as any[];
    expect(news).toHaveLength(1);
    expect(news[0]).toMatchObject({ key: `rug:${BASE}:${out.tradeId}`, source: 'admin', category: 'admin', direction: 'negative', realized: 0, company_id: BASE });
    expect(news[0].headline).toBe('The developer of Moon Pepe (AnonDev) dumps 2,500 coins');
    expect(news[0].body).toMatch(/single order/);
    expect(JSON.stringify(news)).not.toMatch(/alice/); // nobody is named

    // The Launch tab: the result, and nothing left to dump.
    const state = await launchState(r, alice);
    expect(state.mine[0]).toMatchObject({ ticker: 'MPEP', sharesNow: 0, rugs: 1, ruggedShares: 2500, ruggedCents: out.receivedCents, canRug: false, valueNowCents: 0, profitCents: out.receivedCents - 500_000 - 200 }); // (the $2.00 launch fee is part of the result)
    expect(state.counts).toMatchObject({ coinActive: 0, coinEver: 1 }); // sold out: a place is free again
    // The owner sees it too.
    const admin = (await call(r, '/api/admin/state', { cookie: boss })).json;
    expect(admin.launches[0]).toMatchObject({ ticker: 'MPEP', username: 'alice', sharesNow: 0, rugs: 1, ruggedShares: 2500, ruggedCents: out.receivedCents });
    // After a while the price has really fallen below where it was (the push is stored and the engine reads it like a news story).
    advance(r, 120);
    expect(await priceOf(r, 'MPEP')).toBeGreaterThan(0);
  }, LONG);

  it('LAUNCH-17: the same request sells and announces once; a new request with nothing left is refused with a sentence', async () => {
    const { r, alice } = await launched();
    const id = 'req-rug-once-000001';
    const first = await rug(r, alice, 'MPEP', { requestId: id });
    expect(first.json).toMatchObject({ duplicate: false, filled: 2500 });
    const cash = (await account(r, alice)).cashCents;
    const again = await rug(r, alice, 'MPEP', { requestId: id });
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ duplicate: true, filled: 2500, tradeId: first.json.tradeId, receivedCents: first.json.receivedCents });
    expect((await account(r, alice)).cashCents).toBe(cash);
    expect(rowsOf(r, 'SELECT * FROM launch_rugs')).toHaveLength(1);
    expect(rowsOf(r, "SELECT * FROM news_items WHERE key LIKE 'rug:%'")).toHaveLength(1);
    const none = await rug(r, alice);
    expect(none.status).toBe(400);
    expect(none.json.error.code).toBe('nothing_to_dump');
    expect(none.json.error.message).toMatch(/none of MPEP/);
    expect(rowsOf(r, 'SELECT * FROM launch_rugs')).toHaveLength(1);
  }, LONG);

  it('LAUNCH-18: a halt refuses the rug pull (the owner can stop one), and so does a short position; the stake stays untouched', async () => {
    const { r, boss, alice } = await launched();
    expect((await post(r, '/api/admin/halt', boss, { ticker: 'MPEP', halted: true, reason: 'looks like a scam' })).status).toBe(200);
    const state = await launchState(r, alice);
    expect(state.mine[0]).toMatchObject({ halted: true, canRug: false });
    expect(state.mine[0].blocked).toMatch(/halted/);
    const refused = await rug(r, alice);
    expect(refused.status).toBe(403);
    expect(refused.json.error.code).toBe('halted');
    expect((await account(r, alice)).positions[0].shares).toBe(2500);
    expect(rowsOf(r, 'SELECT * FROM launch_rugs')).toHaveLength(0);
    expect(rowsOf(r, "SELECT * FROM news_items WHERE key LIKE 'rug:%'")).toHaveLength(0);
    expect((await post(r, '/api/admin/halt', boss, { ticker: 'MPEP', halted: false })).status).toBe(200);

    // Sell all by hand, then short the coin: a rug pull sells what he HOLDS, so a short position is not touched.
    expect((await trade(r, alice, { side: 'sell', qty: 2500 })).status).toBe(201);
    expect((await trade(r, alice, { side: 'sell', qty: 5, short: true })).status).toBe(201);
    const shorted = await rug(r, alice);
    expect(shorted.status).toBe(400);
    expect(shorted.json.error.code).toBe('nothing_to_dump');
    expect(shorted.json.error.message).toMatch(/short/);
    expect((await account(r, alice)).positions[0]).toMatchObject({ short: true, shares: 5 });
  }, LONG);

  it('LAUNCH-19: a stock rug pull is the same single order, with no fee; the story says "founder" and "shares"', async () => {
    const { r, alice } = await twoPlayers({ flowGain: 1 });
    expect((await launchStock(r, alice)).status).toBe(200);
    advance(r, 45);
    const out = (await rug(r, alice, 'ACMR')).json;
    expect(out).toMatchObject({ ok: true, ticker: 'ACMR', requested: ACME_SHARES, filled: ACME_SHARES, partial: false, remaining: 0, feeCents: 0 });
    // A calm stock: selling the whole stake costs only a few percent.
    expect(out.receivedCents).toBeGreaterThan(ACME_SPENT * 0.9);
    expect(out.receivedCents).toBeLessThan(ACME_SPENT * 1.1);
    const news = rowsOf(r, "SELECT headline, body FROM news_items WHERE key LIKE 'rug:%'") as { headline: string; body: string }[];
    expect(news).toHaveLength(1);
    expect(news[0]!.headline).toBe(`The founder of Acme Robotics dumps ${ACME_SHARES} shares`);
    expect(news[0]!.body).toMatch(new RegExp(`founder of Acme Robotics sold ${ACME_SHARES} shares of ACMR`));
  }, LONG);

  it('LAUNCH-20: more than the order book can take: the part that fits is sold, the rest stays his, and pressing again later sells more', async () => {
    const { r, boss, alice } = await twoPlayers();
    expect((await fund(r, boss, 'alice', 3_000_000)).status).toBe(200);
    expect((await launchCoin(r, alice)).status).toBe(200);
    noPool(r);
    advance(r, 45);
    // Buy a lot more (own cash, no leverage, so nothing can liquidate it) so he holds more than the whole book.
    const bought1 = await trade(r, alice, { qty: 4000 });
    expect(bought1.status).toBe(201);
    advance(r, 600);
    const bought2 = await trade(r, alice, { qty: 4000 });
    expect(bought2.status).toBe(201);
    const held = (await account(r, alice)).positions[0].shares as number;
    expect(held).toBeGreaterThan(8000);
    const depth = previewCoin(500_000).bookDepthShares;
    expect(held).toBeGreaterThan(depth * 1.2);

    const first = (await rug(r, alice)).json;
    expect(first.requested).toBe(held);
    expect(first.partial).toBe(true);
    expect(first.filled).toBeGreaterThan(0);
    expect(first.filled).toBeLessThan(held);
    expect(first.remaining).toBe(held - first.filled);
    expect((await account(r, alice)).positions[0].shares).toBe(first.remaining);
    const state = await launchState(r, alice);
    expect(state.mine[0]).toMatchObject({ sharesNow: first.remaining, rugs: 1, ruggedShares: first.filled, canRug: true });
    expect(rowsOf(r, "SELECT * FROM news_items WHERE key LIKE 'rug:%'")).toHaveLength(1);

    // Right away the used-up depth has not come back; after a while it has, and the rest goes.
    advance(r, 1800);
    const secondRes = await rug(r, alice);
    if (secondRes.status !== 200) throw new Error(`second rug pull failed: ${secondRes.text}`);
    const second = secondRes.json;
    expect(second.filled).toBeGreaterThan(0);
    expect(second.requested).toBe(first.remaining);
    let left = second.remaining as number;
    for (let i = 0; i < 4 && left > 0; i += 1) {
      advance(r, 1800);
      left = (await rug(r, alice)).json.remaining as number;
    }
    expect(left).toBe(0);
    expect((await account(r, alice)).positions).toEqual([]);
    const sum = (rowsOf(r, 'SELECT SUM(shares) AS s FROM launch_rugs')[0] as { s: number }).s;
    expect(sum).toBe(held);
  }, LONG * 3);
});

// ---- the launched company is a real company -----------------------------------------------------------------------------------------

describe('the launched company is a real company', () => {
  it('LAUNCH-21: more money, a bigger and calmer coin in the running market: cap, depth, spread and volatility all follow the money', async () => {
    const { r, boss, alice } = await twoPlayers();
    expect((await fund(r, boss, 'alice', 99_900_000_000)).status).toBe(200);
    const small = await launchCoin(r, alice, { name: 'Small Coin', ticker: 'SMAL', seedCents: 500_000 });
    const mid = await launchCoin(r, alice, { name: 'Mid Coin', ticker: 'MIDC', seedCents: 50_000_000 });
    const blue = await launchCoin(r, alice, { name: 'Blue Coin', ticker: 'BLUE', seedCents: 1_000_000_000 });
    expect([small.status, mid.status, blue.status]).toEqual([200, 200, 200]);
    expect([small.json.size, mid.json.size, blue.json.size]).toEqual(['micro', 'mid', 'blue']);
    advance(r, 90);
    const w = r.app.services.world;
    const [a, b, c] = ['SMAL', 'MIDC', 'BLUE'].map((t) => w.companyByTicker(t)) as [Company, Company, Company];
    // The same number of coins, whatever the money: more money is a higher price, not more coins.
    expect([a.sharesOutstanding, b.sharesOutstanding, c.sharesOutstanding]).toEqual([COIN_SUPPLY, COIN_SUPPLY, COIN_SUPPLY]);
    expect([small.json.priceCents, mid.json.priceCents, blue.json.priceCents]).toEqual([priceFor(500_000), priceFor(50_000_000), priceFor(1_000_000_000)]);
    expect(small.json.priceCents).toBeLessThan(mid.json.priceCents);
    expect(mid.json.priceCents).toBeLessThan(blue.json.priceCents);
    expect(a.liquidity).toBeLessThan(b.liquidity);
    expect(b.liquidity).toBeLessThan(c.liquidity);
    expect(a.spreadBps).toBeGreaterThan(b.spreadBps);
    expect(b.spreadBps).toBeGreaterThan(c.spreadBps);
    expect(a.sigmaD).toBeGreaterThan(b.sigmaD);
    expect(b.sigmaD).toBeGreaterThan(c.sigmaD);
    expect(a.newsSensitivity).toBeGreaterThan(c.newsSensitivity);
    expect(a.sector).toBe('meme');
    const rows = await market(r);
    const capOf = (t: string): number => rows.find((x) => x.ticker === t).marketCapCents;
    expect(capOf('SMAL')).toBeLessThan(capOf('MIDC'));
    expect(capOf('MIDC')).toBeLessThan(capOf('BLUE'));
    expect(capOf('SMAL')).toBeLessThan(1_000_000_00); // under $1M
    expect(capOf('BLUE')).toBeGreaterThan(100_000_000_00); // over $100M
  }, LONG);

  it('LAUNCH-28: the dearest coin ($10 million makes $5,500 a coin) trades in whole coins like any other, and its whole stake can still be dumped in one order', async () => {
    const { r, boss, alice } = await twoPlayers();
    expect((await fund(r, boss, 'alice', 1_000_000_000)).status).toBe(200);
    const bob = await signUp(r, 'bob');
    expect((await fund(r, boss, 'bob', 5_000_000)).status).toBe(200);
    const made = await launchCoin(r, alice, { seedCents: 1_000_000_000 });
    expect(made.status).toBe(200);
    expect(made.json).toMatchObject({ priceCents: 550_000, stakeShares: 1818, spentCents: 1818 * 550_000, size: 'blue' });
    noPool(r);
    advance(r, 45);
    const live = await priceOf(r, 'MPEP');
    expect(live).toBeGreaterThan(450_000);
    expect(live).toBeLessThan(650_000);
    // Another player buys two whole coins (about $11,000) and sells one back.
    const bought = await trade(r, bob, { qty: 2 });
    expect(bought.status).toBe(201);
    expect(bought.json.trade).toMatchObject({ side: 'buy', requested: 2, filled: 2 });
    const sold = await trade(r, bob, { side: 'sell', qty: 1 });
    expect(sold.status).toBe(201);
    expect((await account(r, bob)).positions[0].shares).toBe(1);
    // The creator dumps the whole stake in one order and gets most of the money back.
    const out = (await rug(r, alice)).json;
    expect(out).toMatchObject({ ok: true, requested: 1818, filled: 1818, partial: false, remaining: 0 });
    expect(out.receivedCents).toBeGreaterThan(1818 * 550_000 * 0.7);
    expect(out.receivedCents).toBeLessThan(1818 * 550_000);
    expect((await account(r, alice)).positions).toEqual([]);
  }, LONG);

  it('LAUNCH-29: a launch can start from $2: below $5,000 the coin keeps the $2.00 minimum price and has fewer coins; from $5,000 up it has 80,000', () => {
    expect(MIN_COIN_PRICE_CENTS).toBe(200);
    // $2 is the least: one whole coin at the cheapest price. The market cap is 32 times the money (a straight line down from the $5,000 coin).
    expect(previewCoin(200)).toMatchObject({ priceCents: 200, stakeShares: 1, spentCents: 200, supply: 32, marketCapCents: 6400, size: 'micro', dumpFilledPct: 100 });
    // $3.99 still buys one coin; the change stays in the player's cash.
    expect(previewCoin(399)).toMatchObject({ priceCents: 200, stakeShares: 1, spentCents: 200 });
    expect(previewCoin(10_000)).toMatchObject({ priceCents: 200, stakeShares: 50, spentCents: 10_000, supply: 1600, marketCapCents: 320_000 }); // $100 → 50 of 1,600 coins
    expect(previewCoin(100_000)).toMatchObject({ priceCents: 200, stakeShares: 500, supply: 16_000 }); // $1,000
    expect(previewCoin(300_000)).toMatchObject({ priceCents: 200, stakeShares: 1500, supply: 48_000 }); // $3,000
    expect(previewCoin(500_000)).toMatchObject({ priceCents: 200, stakeShares: 2500, supply: 80_000 }); // $5,000: everything as before
    expect(supplyFor(200)).toBe(32);
    expect(supplyFor(500_000)).toBe(COIN_SUPPLY);
    expect(supplyFor(MAX_SEED_CENTS)).toBe(COIN_SUPPLY);
    // Walking up from $2 to $10 million: the price never falls, the number of coins never shrinks, and nothing is ever under $2.00 or free.
    let lastPrice = 0;
    let lastSupply = 0;
    for (let i = 0; i <= 240; i += 1) {
      const seed = Math.round(MIN_SEED_CENTS * Math.pow(MAX_SEED_CENTS / MIN_SEED_CENTS, i / 240));
      const v = previewCoin(seed);
      expect(v.priceCents).toBe(priceFor(seed));
      expect(v.supply).toBe(supplyFor(seed));
      expect(v.priceCents).toBeGreaterThanOrEqual(Math.max(lastPrice, 200));
      expect(v.supply).toBeGreaterThanOrEqual(lastSupply);
      expect(v.supply).toBeLessThanOrEqual(COIN_SUPPLY);
      expect(v.stakeShares).toBeGreaterThanOrEqual(1);
      expect(v.spentCents).toBeLessThanOrEqual(seed);
      expect(v.spentCents).toBe(v.stakeShares * v.priceCents);
      expect(v.dumpFilledPct).toBe(100); // a stake is always small enough for one sale
      expect(v.dumpReceiveCents).toBeLessThan(v.spentCents);
      lastPrice = v.priceCents;
      lastSupply = v.supply;
    }
    // A small coin is as thin and wild as the $5,000 one (it keeps that coin's character) and costs little to dump, because its stake is a small part of the book.
    const taken = { names: new Set<string>(), tickers: new Set<string>() };
    const tiny = makeCoinEntry({ ...MOON, seedCents: 10_000 }, taken).entry;
    const five = makeCoinEntry({ ...MOON, name: 'Five Pepe', ticker: 'FPEP' }, taken).entry;
    expect(tiny.price).toBe(200);
    expect(tiny.meme?.supply).toBe(1600);
    expect(tiny.meme?.vol3m).toBe(five.meme?.vol3m);
    expect(tiny.meme?.liquidity).toBe(five.meme?.liquidity);
    expect(previewCoin(10_000).dumpCostPct).toBeLessThan(previewCoin(500_000).dumpCostPct);
  });

  it('LAUNCH-30: a new player with only the $1,000 he started with can launch a small coin and a small stock, others trade them, and he can dump them', async () => {
    const { r, alice } = await twoPlayers();
    const bob = await signUp(r, 'bob');
    expect((await account(r, bob)).cashCents).toBe(100_000);
    // $100 for a coin: 50 coins at $2.00 (a coin of 1,600). $100 for a stock (the least): 20 shares at $5.00, and the $10.00 stock launch fee on top.
    const coin = await launchCoin(r, bob, { seedCents: 10_000 });
    expect(coin.status).toBe(200);
    expect(coin.json).toMatchObject({ ok: true, kind: 'coin', ticker: 'MPEP', priceCents: 200, stakeShares: 50, spentCents: 10_000 });
    const stock = await launchStock(r, bob, { seedCents: 10_000 });
    expect(stock.status).toBe(200);
    expect(stock.json).toMatchObject({ ok: true, kind: 'stock', ticker: 'ACMR', priceCents: 500, stakeShares: 20, spentCents: 10_000, feeCents: 1_000 });
    let acc = await account(r, bob);
    expect(acc.cashCents).toBe(100_000 - 10_200 - 11_000); // $100 and the $2.00 fee for the coin, $100 and the $10.00 fee for the stock
    expect(acc.netWorthCents).toBe(100_000 - 200 - 1_000); // the money put in turns into holdings; only the fees are gone
    expect(acc.positions.map((x: any) => `${x.ticker}:${x.shares}`).sort()).toEqual(['ACMR:20', 'MPEP:50']);
    // The smallest launches the form allows: $2 for a one-coin coin, and $100 for a 20-share stock at $5.00.
    const dust = await launchCoin(r, bob, { name: 'Dust Coin', ticker: 'DUST', seedCents: 200 });
    expect(dust.json).toMatchObject({ ok: true, priceCents: 200, stakeShares: 1, spentCents: 200, feeCents: 200 });
    const dustStock = await launchStock(r, bob, { name: 'Dust Corp', ticker: 'DSTC', seedCents: 10_000 });
    expect(dustStock.json).toMatchObject({ ok: true, priceCents: 500, stakeShares: 20, spentCents: 10_000, feeCents: 1_000 });
    noPool(r, 'MPEP', 'DUST');
    // Less than $2 for a coin, or less than $100 for a stock, is refused and takes nothing.
    expect((await launchCoin(r, bob, { name: 'Too Cheap', ticker: 'CHEP', seedCents: 199 })).status).toBe(400);
    expect((await launchStock(r, bob, { name: 'Too Few', ticker: 'FEWW', seedCents: 9_999 })).status).toBe(400);
    expect((await account(r, bob)).cashCents).toBe(100_000 - 10_200 - 11_000 - 400 - 11_000); // the dust coin (fee and one coin) and the dust stock (shares and fee)

    advance(r, 45);
    // Another player trades the little coin and the little stock like any other company, and the creator can dump his own stake.
    const bought = await trade(r, alice, { ticker: 'MPEP', qty: 10 });
    expect(bought.status).toBe(201);
    expect(bought.json.trade).toMatchObject({ side: 'buy', filled: 10 });
    expect((await trade(r, alice, { ticker: 'ACMR', qty: 1 })).status).toBe(201);
    const outCoin = (await rug(r, bob)).json;
    expect(outCoin).toMatchObject({ ok: true, requested: 50, filled: 50, partial: false, remaining: 0 });
    expect(outCoin.receivedCents).toBeGreaterThan(0);
    const outStock = (await rug(r, bob, 'ACMR')).json;
    expect(outStock).toMatchObject({ ok: true, requested: 20, filled: 20, partial: false });
    acc = await account(r, bob);
    expect(acc.positions.map((x: any) => x.ticker).sort()).toEqual(['DSTC', 'DUST']);
    const state = await launchState(r, bob);
    expect(state.counts).toMatchObject({ coinActive: 1, coinEver: 2, stockActive: 1, stockEver: 2 });
  }, LONG);

  it('LAUNCH-31: making a coin is free but for the launch fee: a first buy of $0 is allowed, anything between $0 and $2 is not, and the coin is then the smallest one', () => {
    expect(LAUNCH_FEE_CENTS).toBe(200);
    const free = previewCoin(0);
    expect(free).toMatchObject({ seedCents: 0, priceCents: 200, stakeShares: 0, spentCents: 0, feeCents: 200, totalCents: 200, supply: 32, marketCapCents: 6400, size: 'micro', stakePct: 0, stakeOfBookPct: 0 });
    // Nothing held, so nothing to sell: the preview of the dump is empty, not a division by zero.
    expect(free).toMatchObject({ dumpFilledPct: 0, dumpReceiveCents: 0, dumpCostPct: 0, dumpPriceDropPct: 0, breakEvenRisePct: 0 });
    // It is the same coin a $2.00 first buy makes (the smallest and wildest), only the player holds none of it.
    const two = previewCoin(200);
    expect({ ...free, seedCents: 0, stakeShares: 0, spentCents: 0, totalCents: 200, stakePct: 0 }).toMatchObject({ priceCents: two.priceCents, supply: two.supply, liquidityPct: two.liquidityPct, spreadBps: two.spreadBps, typicalMovePct: two.typicalMovePct, marketCapCents: two.marketCapCents });
    // The fee comes on top of the first buy.
    expect(previewCoin(500_000)).toMatchObject({ feeCents: 200, spentCents: 500_000, totalCents: 500_200 });
    expect(previewCoin(777_777).totalCents).toBe(previewCoin(777_777).spentCents + 200);
    // Between $0 and $2 buys nothing and is refused with the rule in the sentence.
    for (const bad of [1, 50, 199]) expect(() => previewCoin(bad)).toThrow(/\$0 \(no first buy\) or .* \$2 to \$10,000,000/);
    expect(() => previewCoin(-1)).toThrow(/money you put in/);
    // The first row of the form's table is "no first buy".
    const form = coinOptions(30);
    expect(form.ladder[0]).toMatchObject({ seedCents: 0, priceCents: 200, supply: 32 });
    // A coin made with no first buy is a real catalogue entry with the same numbers as the $2.00 one.
    const taken = { names: new Set<string>(), tickers: new Set<string>() };
    const none = makeCoinEntry({ ...MOON, seedCents: 0 }, taken);
    expect(none.entry.price).toBe(200);
    expect(none.entry.meme?.supply).toBe(32);
    expect(none.preview.stakeShares).toBe(0);
    const tiny = makeCoinEntry({ ...MOON, name: 'Tiny Pepe', ticker: 'TPEP', seedCents: 200 }, taken).entry;
    expect(none.entry.meme?.vol3m).toBe(tiny.meme?.vol3m);
    expect(none.entry.meme?.liquidity).toBe(tiny.meme?.liquidity);
    // A coin made by a script with no money field at all is refused (the page always sends one).
    expect(() => makeCoinEntry({ name: 'No Money', ticker: 'NOMN' }, taken)).toThrow(/money you put in/);
    // A stock has no free launch: it needs a real stake of at least $100.
    expect(() => previewStock(0)).toThrow(/money you put in/);
  });

  it('LAUNCH-32: a free launch: only the fee leaves the cash, nothing is held, the coin lists and trades, the maker buys it on the market like anyone, and can rug pull what he bought', async () => {
    const { r, boss, alice } = await twoPlayers();
    const bob = await signUp(r, 'bob');
    // The preview route: no first buy is fine and says what it costs.
    const pv = (await call(r, '/api/launch/coin-preview?seedCents=0', { cookie: alice })).json;
    expect(pv.ok).toBe(true);
    expect(pv.preview).toMatchObject({ seedCents: 0, stakeShares: 0, spentCents: 0, feeCents: 200, totalCents: 200, cashCents: 1_100_000, enough: true });
    expect(rowsOf(r, 'SELECT * FROM launches')).toHaveLength(0);

    const made = await launchCoin(r, alice, { seedCents: 0 });
    expect(made.status).toBe(200);
    expect(made.json).toMatchObject({ ok: true, kind: 'coin', ticker: 'MPEP', priceCents: 200, stakeShares: 0, spentCents: 0, feeCents: 200, size: 'micro' });
    noPool(r);
    let acc = await account(r, alice);
    expect(acc.cashCents).toBe(1_099_800);
    expect(acc.positions).toEqual([]); // he holds none of it
    expect(acc.profitCents).toBe(-200);
    expect(rowsOf(r, 'SELECT seed_cents, spent_cents, stake_shares, price_cents, fee_cents FROM launches')).toEqual([{ seed_cents: 0, spent_cents: 0, stake_shares: 0, price_cents: 200, fee_cents: 200 }]);
    let state = await launchState(r, alice);
    expect(state.counts).toMatchObject({ coinActive: 0, coinEver: 1 }); // holding none, so it does not use one of his three places
    expect(state.mine[0]).toMatchObject({ ticker: 'MPEP', stakeShares: 0, spentCents: 0, feeCents: 200, sharesNow: 0, canRug: false, profitCents: -200, rugs: 0 });
    expect(state.mine[0].blocked).toMatch(/not trading yet/);
    expect((await market(r)).find((c) => c.ticker === 'MPEP')).toMatchObject({ trading: false });

    // It lists, with 32 coins at $2.00, and the owner sees it with nothing held.
    advance(r, 45);
    expect((await market(r)).find((c) => c.ticker === 'MPEP')).toMatchObject({ trading: true });
    expect(r.app.services.world.companyByTicker('MPEP')?.sharesOutstanding).toBe(32);
    state = await launchState(r, alice);
    expect(state.mine[0]).toMatchObject({ listed: true, sharesNow: 0, canRug: false });
    expect(state.mine[0].blocked).toMatch(/hold none/);
    const nothing = await rug(r, alice);
    expect(nothing.status).toBe(400);
    expect(nothing.json.error.code).toBe('nothing_to_dump');
    const admin = (await call(r, '/api/admin/state', { cookie: boss })).json;
    expect(admin.launches[0]).toMatchObject({ ticker: 'MPEP', username: 'alice', spentCents: 0, stakeShares: 0, sharesNow: 0, trading: true });

    // The maker buys 5 of his own coin on the market like anybody: he pays the gap and the 0.5 % fee, and it is an ordinary holding now.
    const bought = await trade(r, alice, { qty: 5 });
    expect(bought.status).toBe(201);
    expect(bought.json.trade.filled).toBe(5);
    expect(bought.json.trade.feeCents).toBeGreaterThan(0);
    expect((await trade(r, bob, { qty: 3 })).status).toBe(201); // and others can too
    state = await launchState(r, alice);
    expect(state.counts).toMatchObject({ coinActive: 1, coinEver: 1 }); // now he holds some
    expect(state.mine[0]).toMatchObject({ sharesNow: 5, canRug: true, blocked: null, stakeShares: 0 });

    // A restart keeps the launch and the company.
    const r2 = await restart(r);
    advance(r2, 5);
    const again = await launchState(r2, alice);
    expect(again.mine[0]).toMatchObject({ ticker: 'MPEP', stakeShares: 0, feeCents: 200, sharesNow: 5, listed: true });
    expect(rowsOf(r2, 'SELECT fee_cents FROM launches')).toEqual([{ fee_cents: 200 }]);

    // Rug pull = sell everything he holds, an ordinary order; the launch's result counts the fee and what the buy and the sale cost.
    const out = (await rug(r2, alice)).json;
    expect(out).toMatchObject({ ok: true, requested: 5, filled: 5, partial: false, remaining: 0 });
    acc = await account(r2, alice);
    expect(acc.positions).toEqual([]);
    const after = await launchState(r2, alice);
    expect(after.mine[0]).toMatchObject({ sharesNow: 0, rugs: 1, ruggedShares: 5, ruggedCents: out.receivedCents });
    const spentOnBuy = bought.json.trade.totalCents + bought.json.trade.feeCents;
    expect(after.mine[0].profitCents).toBe(out.receivedCents - spentOnBuy - 200);
    expect(acc.cashCents).toBe(1_100_000 - 200 - spentOnBuy + out.receivedCents);
  }, LONG);

  it('LAUNCH-33: the cash has to cover the fee and the first buy together; a refusal makes nothing and takes nothing', async () => {
    const { r, alice } = await twoPlayers();
    const bob = await signUp(r, 'bob'); // $1,000 and nothing else
    // $1,000 as the first buy fits the money but not the fee on top.
    const poor = await launchCoin(r, bob, { seedCents: 100_000 });
    expect(poor.status).toBe(400);
    expect(poor.json.error.code).toBe('not_enough_cash');
    expect(poor.json.error.message).toMatch(/\$2\.00 launch fee plus \$1,000\.00/);
    expect(poor.json.error.message).toMatch(/\$1,002\.00 in all, and you have \$1,000\.00\./); // (one comma: an earlier version printed two)
    const pv = (await call(r, '/api/launch/coin-preview?seedCents=100000', { cookie: bob })).json.preview;
    expect(pv).toMatchObject({ spentCents: 100_000, feeCents: 200, totalCents: 100_200, cashCents: 100_000, enough: false });
    expect(rowsOf(r, 'SELECT * FROM launches')).toHaveLength(0);
    expect((await account(r, bob)).cashCents).toBe(100_000);
    // $999 buys 499 coins ($998) and with the fee takes every cent he has.
    const all = await launchCoin(r, bob, { seedCents: 99_900 });
    expect(all.status).toBe(200);
    expect(all.json).toMatchObject({ stakeShares: 499, spentCents: 99_800, feeCents: 200 });
    expect((await account(r, bob)).cashCents).toBe(0);
    // With nothing left, even a free launch (the fee alone) is refused.
    const broke = await launchCoin(r, bob, { name: 'Broke Coin', ticker: 'BRKE', seedCents: 0 });
    expect(broke.status).toBe(400);
    expect(broke.json.error.code).toBe('not_enough_cash');
    expect(broke.json.error.message).toMatch(/costs the \$2\.00 launch fee, and you have \$0\.00/);
    expect(rowsOf(r, 'SELECT * FROM launches')).toHaveLength(1);
    expect(await market(r)).toHaveLength(BASE + 1);
    // A stock launch pays its own $10.00 fee: the same cash buys exactly what it says, and the fee comes on top.
    const rich = await launchStock(r, alice, { seedCents: 500_000 });
    expect(rich.json).toMatchObject({ stakeShares: ACME_SHARES, spentCents: ACME_SPENT, feeCents: 1_000 });
    expect((await account(r, alice)).cashCents).toBe(1_100_000 - ACME_SPENT - 1_000);
    // The stock's cash check counts the fee too: $1,000 buys 83 shares for $996.00, and the $10.00 fee on top is $6 more than he has.
    const carol = await signUp(r, 'carol'); // $1,000 and nothing else
    const short = await launchStock(r, carol, { name: 'Carol Corp', ticker: 'CARL', seedCents: 100_000 });
    expect(short.status).toBe(400);
    expect(short.json.error.code).toBe('not_enough_cash');
    expect(short.json.error.message).toMatch(/Making a stock costs the \$10\.00 launch fee plus \$996\.00 for the shares, \$1,006\.00 in all, and you have \$1,000\.00/);
    const sp = (await call(r, '/api/launch/stock-preview?seedCents=100000', { cookie: carol })).json.preview;
    expect(sp).toMatchObject({ spentCents: 99_600, feeCents: 1_000, totalCents: 100_600, cashCents: 100_000, enough: false });
    expect((await account(r, carol)).cashCents).toBe(100_000);
    expect(rowsOf(r, 'SELECT * FROM launches WHERE user_id = (SELECT id FROM users WHERE username = ?)', 'carol')).toHaveLength(0);
    // $990 fits: 82 shares at $11.95 cost $979.90, and with the $10.00 fee $989.90 leaves the cash.
    const fit = previewStock(99_000);
    expect(fit).toMatchObject({ stakeShares: 82, spentCents: 97_990, totalCents: 98_990 });
    const ok = await launchStock(r, carol, { name: 'Carol Corp', ticker: 'CARL', seedCents: 99_000 });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ stakeShares: 82, spentCents: 97_990, feeCents: 1_000 });
    expect((await account(r, carol)).cashCents).toBe(100_000 - 98_990);
  }, LONG);

  it('LAUNCH-34: free coins are no loophole: the fee is paid every time, only coins he still holds count as active, and 20 coins ever is still the cap', async () => {
    const { r, boss, alice } = await twoPlayers();
    expect((await fund(r, boss, 'alice', 1_000_000)).status).toBe(200);
    const cash0 = (await account(r, alice)).cashCents;
    const tickers: string[] = [];
    for (let i = 0; i < MAX_EVER_PER_KIND; i += 1) {
      const t = `Z${String.fromCharCode(65 + i)}${String.fromCharCode(65 + ((i * 7) % 26))}`;
      tickers.push(t);
      // (letters only in the name: the name may not be digits)
      const made = await launchCoin(r, alice, { name: `Free Coin ${String.fromCharCode(65 + i)}${String.fromCharCode(97 + i)}`, ticker: t, seedCents: 0 });
      expect(made.status).toBe(200);
    }
    expect((await account(r, alice)).cashCents).toBe(cash0 - MAX_EVER_PER_KIND * 200); // $2.00 each, every time
    const state = await launchState(r, alice);
    expect(state.counts).toMatchObject({ coinActive: 0, coinEver: MAX_EVER_PER_KIND });
    const over = await launchCoin(r, alice, { name: 'One Too Many', ticker: 'ONTM', seedCents: 0 });
    expect(over.status).toBe(400);
    expect(over.json.error.code).toBe('too_many');
    expect((await account(r, alice)).cashCents).toBe(cash0 - MAX_EVER_PER_KIND * 200);
    expect(rowsOf(r, 'SELECT * FROM launches WHERE fee_cents = 200')).toHaveLength(MAX_EVER_PER_KIND);
    // A coin launched WITH a first buy still counts as held, so the three-at-once rule still stops a player who holds three.
    const { r: r2, boss: boss2, alice: alice2 } = await twoPlayers();
    expect((await fund(r2, boss2, 'alice', 3_000_000)).status).toBe(200);
    for (const [name, ticker] of [['Held Alpha', 'HLDA'], ['Held Beta', 'HLDB'], ['Held Gamma', 'HLDC']]) expect((await launchCoin(r2, alice2, { name, ticker, seedCents: 10_000 })).status).toBe(200);
    expect((await launchCoin(r2, alice2, { name: 'Held Delta', ticker: 'HLDD', seedCents: 10_000 })).json.error.code).toBe('too_many_active');
  }, LONG * 2);

  it('LAUNCH-22: the owner\'s other tools work on a launched coin (price move, halt), and it has news of its own', async () => {
    const { r, boss, alice } = await twoPlayers({ withCoins: true });
    const id = BASE + COINS;
    const made = await launchCoin(r, alice);
    expect(made.json.companyId).toBe(id); // after the thirty built-in coins
    advance(r, 60);
    expect((await post(r, '/api/admin/shock', boss, { ticker: 'MPEP', percent: 100, style: 'pump', speed: 'instant' })).status).toBe(200);
    const p0 = await priceOf(r, 'MPEP');
    advance(r, 60);
    expect(await priceOf(r, 'MPEP')).toBeGreaterThan(p0 * 1.3);
    advance(r, 6 * 3600);
    const news = rowsOf(r, 'SELECT headline FROM news_items WHERE company_id = ?', id) as { headline: string }[];
    expect(news.length).toBeGreaterThanOrEqual(3);
    expect(news.some((n) => n.headline.includes('Moon Pepe'))).toBe(true);
  }, LONG * 2);

  it('LAUNCH-23: a restart keeps everything: companies, prices, positions, launches, rug pulls and their news; the next launch gets the next id', async () => {
    let { r, boss, alice } = await twoPlayers({ withCoins: true, flowGain: 1 });
    const bob = await signUp(r, 'bob');
    expect((await launchCoin(r, alice)).status).toBe(200);
    expect((await launchStock(r, alice)).status).toBe(200);
    advance(r, 60);
    expect((await trade(r, bob, { qty: 40 })).status).toBe(201);
    const out = (await rug(r, alice)).json;
    expect(out).toMatchObject({ kind: 'drain', ownCoins: 2500, otherCoins: 40 }); // (the coin has a money pool: the rug pull took it)
    advance(r, 2 * 3600);
    const companies = JSON.stringify(r.app.services.world.companies);
    const poolBefore = rowsOf(r, 'SELECT * FROM coin_pools ORDER BY company_id');
    expect(poolBefore).toHaveLength(1);
    const prices = Array.from(r.app.services.world.sim.P);
    const rugsBefore = rowsOf(r, 'SELECT * FROM launch_rugs ORDER BY trade_id');
    const newsBefore = rowsOf(r, 'SELECT key, headline, realized, publish_tick, start_tick, end_tick FROM news_items ORDER BY key');

    r = await restart(r);
    alice = await logIn(r, 'alice');
    boss = await logIn(r, 'boss');
    expect(await market(r)).toHaveLength(BASE + COINS + 2);
    expect(JSON.stringify(r.app.services.world.companies)).toBe(companies);
    expect(Array.from(r.app.services.world.sim.P)).toEqual(prices);
    expect(rowsOf(r, 'SELECT * FROM launch_rugs ORDER BY trade_id')).toEqual(rugsBefore);
    expect(rowsOf(r, 'SELECT * FROM coin_pools ORDER BY company_id')).toEqual(poolBefore);
    expect(rowsOf(r, 'SELECT key, headline, realized, publish_tick, start_tick, end_tick FROM news_items ORDER BY key')).toEqual(newsBefore);
    const state = await launchState(r, alice);
    expect(state.mine.map((m: any) => [m.ticker, m.sharesNow, m.rugs])).toEqual([['ACMR', ACME_SHARES, 0], ['MPEP', 2500, 1]]); // (his own coins are still there, worth nothing)
    expect(state.counts).toMatchObject({ coinEver: 1, coinActive: 0, stockEver: 1, stockActive: 1 });
    // The next launch after the restart gets the next id.
    expect((await launchCoin(r, alice, { name: 'Second Pepe', ticker: 'SPEP' })).json.companyId).toBe(BASE + COINS + 2);
    void boss;
  }, LONG * 2);

  it('LAUNCH-24: a launch made while the server runs, or saved and loaded at a restart: identical prices, candles and news for hours', async () => {
    // One history, copied. World A launches the coin live; world B only saves it and then restarts. Both then run on.
    const clock = new Clock();
    let a = await boot({ clock });
    const bossA = await signUp(a, 'boss');
    await signUp(a, 'alice');
    expect((await fund(a, bossA, 'alice', 1_000_000)).status).toBe(200);
    advance(a, 2 * 3600);
    await stop(a);
    running.splice(running.indexOf(a), 1);
    const dirB = mkdtempSync(join(tmpdir(), 'tq-launch-b-'));
    dirs.push(dirB);
    cpSync(a.dir, dirB, { recursive: true });

    a = await boot({ dir: a.dir, clock: new Clock(clock.ms) });
    let b = await boot({ dir: dirB, clock: new Clock(clock.ms) });
    const cookieA = await logIn(a, 'alice');
    const made = await launchCoin(a, cookieA);
    expect(made.status).toBe(200);
    expect(made.json.loaded).toBe(true);

    // B: the same coin saved with the same listing tick and the same stake, but not loaded into the running world.
    const wb: WorldRuntime = b.app.services.world;
    const entry = makeCoinEntry(MOON, { names: new Set(), tickers: new Set() }).entry;
    const aliceB = (b.app.services.db.get('SELECT id FROM users WHERE username = ?', 'alice') as { id: number }).id;
    b.app.services.db.tx(() => {
      const acc = b.app.services.trading.careerAccountOf(aliceB);
      const id = wb.recordOwnCoin(entry, made.json.listingTick);
      b.app.services.db.run('UPDATE accounts SET cash_cents = cash_cents - ? WHERE id = ?', 500_000, acc.id);
      b.app.services.db.run('INSERT INTO positions(account_id, company_id, shares, cost_cents) VALUES (?, ?, ?, ?)', acc.id, id, 2500, 500_000);
    });
    b = await restart(b);

    const sameNow = (): void => {
      const wa = a.app.services.world;
      const wb2 = b.app.services.world;
      expect(wa.sim.tick).toBe(wb2.sim.tick);
      expect(Array.from(wa.sim.P)).toEqual(Array.from(wb2.sim.P));
      expect(Array.from(wa.sim.F)).toEqual(Array.from(wb2.sim.F));
      expect(JSON.stringify(wa.companies)).toBe(JSON.stringify(wb2.companies));
      for (const id of [0, 5, BASE]) {
        for (const res of ['c10', 'h1'] as const) expect(wa.candles(id, res, 400)).toEqual(wb2.candles(id, res, 400));
      }
    };
    sameNow();
    for (const hours of [1, 2, 3]) {
      advance(a, hours * 3600);
      advance(b, hours * 3600);
      sameNow();
    }
    const newsRows = (r: Running) => rowsOf(r, 'SELECT key, company_id, partner_id, sector, scope, kind, publish_tick, start_tick, end_tick, realized, headline FROM news_items ORDER BY key');
    expect(newsRows(a)).toEqual(newsRows(b));
    a = await restart(a);
    advance(a, 1800);
    advance(b, 1800);
    sameNow();
  }, LONG * 2);

  it('LAUNCH-25: a rug pull and its news change nothing about how a restart replays the world (one history with a restart in the middle, one without)', async () => {
    const scenario = async (restartAfterRug: boolean): Promise<{ prices: number[]; news: unknown[]; trades: unknown[] }> => {
      let { r, alice } = await twoPlayers({ flowGain: 1 });
      const bob = await signUp(r, 'bob');
      expect((await launchCoin(r, alice)).status).toBe(200);
      advance(r, 45);
      expect((await trade(r, bob, { qty: 60 })).status).toBe(201);
      advance(r, 30);
      expect((await rug(r, alice, 'MPEP', { requestId: 'req-rug-det-000001' })).status).toBe(200);
      advance(r, 20);
      if (restartAfterRug) r = await restart(r);
      advance(r, 3 * 3600);
      const out = {
        prices: Array.from(r.app.services.world.sim.P),
        news: rowsOf(r, "SELECT key, headline, realized, publish_tick, start_tick, end_tick FROM news_items WHERE source = 'admin' OR key LIKE 'rug:%' ORDER BY key"),
        trades: rowsOf(r, 'SELECT side, requested, filled, total_cents, fee_cents, tick FROM trades ORDER BY id'),
      };
      await stop(r);
      running.splice(running.indexOf(r), 1);
      return out;
    };
    const straight = await scenario(false);
    const restarted = await scenario(true);
    expect(restarted.trades).toEqual(straight.trades);
    expect(restarted.news).toEqual(straight.news);
    expect(restarted.prices).toEqual(straight.prices);
    expect(straight.news.length).toBe(1);
  }, LONG * 3);
});

