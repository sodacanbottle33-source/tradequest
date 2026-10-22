// The HTTP API end to end on a real local port: sign-up, market data, orders, the live stream and the safety checks.
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../server/app';
import { loadConfig } from '../server/config';
import { Logger } from '../server/log';

const LONG = 120_000;

interface Running {
  app: App;
  server: Server;
  base: string;
  dir: string;
}
const running: Running[] = [];
afterEach(async () => {
  while (running.length > 0) {
    const r = running.pop() as Running;
    await new Promise<void>((done) => {
      r.server.closeAllConnections?.();
      r.server.close(() => done());
    });
    r.app.close();
    rmSync(r.dir, { recursive: true, force: true });
  }
});

async function boot(env: Record<string, string> = {}): Promise<Running> {
  const dir = mkdtempSync(join(tmpdir(), 'tq-api-'));
  const config = loadConfig({ TQ_DATA_DIR: dir, TQ_COMPANIES: '12', TQ_WARMUP_DAYS: '1', TQ_PORT: '8787', ...env });
  const app = createApp({ config, log: new Logger({ sink: null }), worldSeed: 777 });
  const server = createServer(app.handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  app.start();
  const r = { app, server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, dir };
  running.push(r);
  return r;
}

async function call(r: Running, path: string, init: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string>; raw?: string } = {}) {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.body !== undefined || init.raw !== undefined) headers['Content-Type'] = 'application/json';
  if (init.cookie) headers.Cookie = init.cookie;
  const res = await fetch(r.base + path, { method: init.method ?? 'GET', headers, body: init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body)) });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, headers: res.headers, text };
}

async function signUp(r: Running, name = 'alice'): Promise<string> {
  const res = await call(r, '/api/auth/register', { method: 'POST', body: { username: name, password: 'a-good-password' } });
  expect(res.status).toBe(201);
  const cookie = res.headers.get('set-cookie') ?? '';
  expect(cookie).toContain('HttpOnly');
  expect(cookie).toContain('SameSite=Lax');
  return cookie.split(';')[0] as string;
}

describe('public market data', () => {
  it('health, overview and a company page', async () => {
    const r = await boot();
    const h = await call(r, '/api/health');
    expect(h.status).toBe(200);
    expect(h.json.ok).toBe(true);
    expect(h.json.listed).toBe(12);
    const m = await call(r, '/api/market');
    expect(m.json.companies).toHaveLength(12);
    const q = m.json.companies[0];
    expect(q.ticker).toBe('QLRX');
    expect(q.bid).toBeLessThan(q.price);
    expect(q.ask).toBeGreaterThan(q.price);
    expect(q.marketCapCents).toBeGreaterThan(0);
    const d = await call(r, '/api/market/qlrx');
    expect(d.status).toBe(200);
    expect(d.json.sharesOutstanding).toBeGreaterThan(0);
    expect(d.json.marketCapCents).toBe(d.json.price * d.json.sharesOutstanding);
    expect(typeof d.json.description).toBe('string');
    expect(d.json.basePriceCents).toBeGreaterThan(0); // the page counts "2x, 10x since the start" from it
    expect((await call(r, '/api/market/NOPE')).status).toBe(404);
  }, LONG);

  it('candles come in three resolutions and each candle is exactly 10 ticks of OHLC', async () => {
    const r = await boot();
    const c10 = await call(r, '/api/market/QLRX/candles?res=c10&limit=50');
    expect(c10.json.candles.length).toBeGreaterThan(40);
    for (const c of c10.json.candles.filter((x: any) => x.complete)) {
      expect(c.ticks).toBe(10);
      expect(c.low).toBeLessThanOrEqual(Math.min(c.open, c.close));
      expect(c.high).toBeGreaterThanOrEqual(Math.max(c.open, c.close));
    }
    const h1 = await call(r, '/api/market/QLRX/candles?res=h1&limit=10');
    expect(h1.json.candles.length).toBeGreaterThan(0);
    expect((await call(r, '/api/market/QLRX/candles?res=bad')).status).toBe(400);
    expect((await call(r, '/api/market/QLRX/candles?limit=999999')).status).toBe(400);
    const older = await call(r, `/api/market/QLRX/candles?res=c10&limit=5&before=${c10.json.candles[0].index}`);
    expect(older.json.candles).toHaveLength(5);
    expect(older.json.candles[4].index).toBe(c10.json.candles[0].index - 1);
  }, LONG);

  it('the order book shows 20 levels per side with bid below ask', async () => {
    const r = await boot();
    const b = await call(r, '/api/market/QLRX/book');
    expect(b.json.asks.levels).toHaveLength(20);
    expect(b.json.bids.levels).toHaveLength(20);
    expect(b.json.bids.levels[0].price).toBeLessThan(b.json.asks.levels[0].price);
    expect(b.json.asks.levels[19].cumulative).toBe(b.json.asks.total);
  }, LONG);

  it('the estimate shows spread, impact and slippage before you trade', async () => {
    const r = await boot();
    const small = await call(r, '/api/market/QLRX/estimate?side=buy&qty=1');
    const big = await call(r, '/api/market/QLRX/estimate?side=buy&qty=50000');
    expect(small.status).toBe(200);
    expect(big.json.slippageBps).toBeGreaterThan(small.json.slippageBps);
    expect(big.json.totalCents).toBeGreaterThan(small.json.totalCents);
    expect((await call(r, '/api/market/QLRX/estimate?side=hold&qty=1')).status).toBe(400);
  }, LONG);
});

describe('signing in and trading', () => {
  it('a new player starts with $1,000, buys, and sees the position; the browser never supplies a price', async () => {
    const r = await boot();
    const cookie = await signUp(r);
    const me = await call(r, '/api/me', { cookie });
    expect(me.json.user.username).toBe('alice');
    const acc0 = await call(r, '/api/account', { cookie });
    expect(acc0.json.cashCents).toBe(100_000);
    const order = await call(r, '/api/orders', { method: 'POST', cookie, body: { clientOrderId: 'abc-12345678', ticker: 'QLRX', side: 'buy', qty: 3, price: 1, cashCents: 99999999 } });
    expect(order.status).toBe(201);
    expect(order.json.trade.filled).toBe(3);
    expect(order.json.trade.totalCents).toBeGreaterThan(3);
    const acc1 = await call(r, '/api/account', { cookie });
    expect(acc1.json.cashCents).toBe(100_000 - order.json.trade.totalCents);
    expect(acc1.json.positions[0].ticker).toBe('QLRX');
    // Repeating the request does not trade again.
    const again = await call(r, '/api/orders', { method: 'POST', cookie, body: { clientOrderId: 'abc-12345678', ticker: 'QLRX', side: 'buy', qty: 3 } });
    expect(again.status).toBe(200);
    expect(again.json.duplicate).toBe(true);
    expect((await call(r, '/api/account', { cookie })).json.cashCents).toBe(acc1.json.cashCents);
    const trades = await call(r, '/api/account/trades', { cookie });
    expect(trades.json.trades).toHaveLength(1);
  }, LONG);

  it('spending more than you have returns a clear error and changes nothing', async () => {
    const r = await boot();
    const cookie = await signUp(r);
    const res = await call(r, '/api/orders', { method: 'POST', cookie, body: { clientOrderId: 'big-order-0001', ticker: 'QLRX', side: 'buy', qty: 5_000_000 } });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe('insufficient_cash');
    expect(res.json.error.details.maxQty).toBeGreaterThanOrEqual(0);
    expect((await call(r, '/api/account', { cookie })).json.cashCents).toBe(100_000);
  }, LONG);

  it('orders and accounts need a sign-in; every player only ever sees their own account', async () => {
    const r = await boot();
    expect((await call(r, '/api/account')).status).toBe(401);
    expect((await call(r, '/api/orders', { method: 'POST', body: { clientOrderId: 'abc-12345678', ticker: 'QLRX', side: 'buy', qty: 1 } })).status).toBe(401);
    const a = await signUp(r, 'alice');
    const b = await signUp(r, 'bobby');
    await call(r, '/api/orders', { method: 'POST', cookie: a, body: { clientOrderId: 'alice-order-1', ticker: 'NVRA', side: 'buy', qty: 1 } });
    expect((await call(r, '/api/account', { cookie: b })).json.positions).toEqual([]);
    expect((await call(r, '/api/account', { cookie: a })).json.positions).toHaveLength(1);
    // Asking for another kind of account that does not exist is refused.
    expect((await call(r, '/api/account?account=match', { cookie: a })).status).toBe(404);
  }, LONG);

  it('wrong passwords, logout, and a forged cookie', async () => {
    const r = await boot();
    const cookie = await signUp(r);
    expect((await call(r, '/api/auth/login', { method: 'POST', body: { username: 'alice', password: 'wrong-password' } })).status).toBe(401);
    expect((await call(r, '/api/auth/login', { method: 'POST', body: { username: 'alice', password: 'a-good-password' } })).status).toBe(200);
    expect((await call(r, '/api/me', { cookie: 'tq_session=forged' })).json.user).toBeNull();
    await call(r, '/api/auth/logout', { method: 'POST', cookie });
    expect((await call(r, '/api/account', { cookie })).status).toBe(401);
  }, LONG);
});

describe('request safety', () => {
  it('rejects bad JSON, wrong content type, oversize bodies, other websites and wrong methods', async () => {
    const r = await boot();
    expect((await call(r, '/api/auth/login', { method: 'POST', raw: '{nope' })).status).toBe(400);
    expect((await call(r, '/api/auth/login', { method: 'POST', raw: '[1,2]' })).status).toBe(400);
    const text = await fetch(`${r.base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' });
    expect(text.status).toBe(415);
    expect((await call(r, '/api/auth/login', { method: 'POST', raw: JSON.stringify({ username: 'x'.repeat(40000) }) })).status).toBe(413);
    const evil = await call(r, '/api/auth/login', { method: 'POST', body: { username: 'a', password: 'b' }, headers: { Origin: 'http://evil.example' } });
    expect(evil.status).toBe(403);
    const dev = await call(r, '/api/auth/login', { method: 'POST', body: { username: 'a', password: 'b' }, headers: { Origin: 'http://localhost:5173' } });
    expect(dev.status).toBe(401); // allowed through to the real check (no such user)
    expect((await call(r, '/api/market', { method: 'POST', body: {} })).status).toBe(405);
    expect((await call(r, '/api/nothing')).status).toBe(404);
    expect((await fetch(`${r.base}/api/market`, { method: 'DELETE' })).status).toBe(405);
  }, LONG);

  it('an unexpected crash inside a route returns a clean 500 and is logged', async () => {
    const r = await boot();
    r.app.router.get('/api/test-crash', () => {
      throw new Error('boom');
    });
    const res = await call(r, '/api/test-crash');
    expect(res.status).toBe(500);
    expect(res.json.error.code).toBe('server_error');
    expect(res.text).not.toContain('boom');
    expect(r.app.services.log.problems().some((p) => p.message.includes('boom'))).toBe(true);
  }, LONG);
});

describe('live stream', () => {
  it('pushes a hello and then a price message every second', async () => {
    const r = await boot();
    const res = await fetch(`${r.base}/api/stream`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const ticks: number[] = [];
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline && ticks.length < 3) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value);
      for (const m of buffer.matchAll(/event: tick\ndata: (.*)\n\n/g)) {
        const t = (JSON.parse(m[1] as string) as { t: number; p: number[] }).t;
        if (!ticks.includes(t)) ticks.push(t);
      }
    }
    await reader.cancel();
    expect(buffer).toContain('event: hello');
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    expect(ticks[1]).toBe((ticks[0] as number) + 1);
  }, LONG);

  it('two browsers see the same tick and the same prices', async () => {
    const r = await boot();
    const seen: Map<number, number[]>[] = [new Map(), new Map()];
    const readers = await Promise.all(
      [0, 1].map(async (k) => {
        const res = await fetch(`${r.base}/api/stream`);
        const reader = (res.body as ReadableStream<Uint8Array>).getReader();
        void (async () => {
          const decoder = new TextDecoder();
          let buf = '';
          for (;;) {
            const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
            if (done || !value) return;
            buf += decoder.decode(value);
            for (const m of buf.matchAll(/event: tick\ndata: (.*)\n\n/g)) {
              const d = JSON.parse(m[1] as string) as { t: number; p: number[] };
              (seen[k] as Map<number, number[]>).set(d.t, d.p);
            }
            buf = buf.slice(buf.lastIndexOf('\n\n') + 2);
          }
        })();
        return reader;
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 3500));
    for (const rd of readers) await rd.cancel();
    const a = seen[0] as Map<number, number[]>;
    const b = seen[1] as Map<number, number[]>;
    const common = [...a.keys()].filter((t) => b.has(t));
    expect(common.length).toBeGreaterThanOrEqual(2);
    for (const t of common) expect(a.get(t)).toEqual(b.get(t));
  }, LONG);
});
