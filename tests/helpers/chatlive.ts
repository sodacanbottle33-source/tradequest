// A real server on a temporary database for the tests of the chat-related updates (public groups, pictures, changing the username): a clock the
// test controls, sign-up and requests with cookies, a stream listener, and hand-made picture bytes (the server only looks at the first bytes).
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect } from 'vitest';
import { createApp, type App } from '../../server/app';
import { NEW_ACCOUNT_WAIT_MS } from '../../server/chat';
import { loadConfig } from '../../server/config';
import { Logger } from '../../server/log';
import { Clock } from './server';

export const LONG = 240_000;
export const PASSWORD = 'a-good-password';

export interface Running {
  app: App;
  server: Server;
  base: string;
  dir: string;
  clock: Clock;
}

export interface Reply {
  status: number;
  json: any;
  headers: Headers;
  bytes: Uint8Array;
}

/** Call once at the top of a test file: it closes every server the test started after each test. */
export function liveRig(prefix: string, owner = 'boss', companies = '12') {
  const running: Running[] = [];
  const dirs: string[] = [];
  const streams: AbortController[] = [];
  afterEach(async () => {
    while (streams.length > 0) streams.pop()?.abort();
    while (running.length > 0) {
      const r = running.pop() as Running;
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
    while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
  });

  async function boot(): Promise<Running> {
    const dir = mkdtempSync(join(tmpdir(), `tq-${prefix}-`));
    dirs.push(dir);
    const clock = new Clock();
    const config = loadConfig({ TQ_DATA_DIR: dir, TQ_COMPANIES: companies, TQ_WARMUP_DAYS: '1', TQ_PORT: '8787', TQ_OWNER: owner });
    const app = createApp({ config, log: new Logger({ sink: null, now: clock.now }), worldSeed: 777, now: clock.now, flowGain: 0 });
    const server = createServer(app.handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const r = { app, server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, dir, clock };
    running.push(r);
    return r;
  }

  async function call(r: Running, path: string, init: { method?: string; body?: unknown; cookie?: string; raw?: string } = {}): Promise<Reply> {
    const headers: Record<string, string> = {};
    const hasBody = init.body !== undefined || init.raw !== undefined;
    if (hasBody) headers['Content-Type'] = 'application/json';
    if (init.cookie) headers.Cookie = init.cookie;
    const res = await fetch(r.base + path, { method: init.method ?? 'GET', headers, body: init.raw !== undefined ? init.raw : init.body === undefined ? undefined : JSON.stringify(init.body) });
    const bytes = new Uint8Array(await res.arrayBuffer());
    let json: any = null;
    try {
      json = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      json = null;
    }
    return { status: res.status, json, headers: res.headers, bytes };
  }

  async function signUp(r: Running, name: string): Promise<string> {
    const res = await fetch(r.base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: name, password: PASSWORD }) });
    expect(res.status).toBe(201);
    return (res.headers.get('set-cookie') ?? '').split(';')[0] as string;
  }

  async function login(r: Running, name: string) {
    const res = await fetch(r.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: name, password: PASSWORD }) });
    return { status: res.status, json: (await res.json()) as any };
  }

  async function listen(r: Running, cookie?: string): Promise<{ text(): string }> {
    const controller = new AbortController();
    streams.push(controller);
    const res = await fetch(r.base + '/api/stream', { headers: cookie ? { Cookie: cookie } : {}, signal: controller.signal });
    expect(res.status).toBe(200);
    let text = '';
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          text += decoder.decode(value);
        }
      } catch {
        // aborted by the test
      }
    })();
    return { text: () => text };
  }

  return { boot, call, signUp, login, listen };
}

export const until = async (check: () => boolean, ms = 3000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((done) => setTimeout(done, 20));
  }
  return check();
};

export const db = (r: Running) => r.app.services.db;
export const idOf = (r: Running, name: string): number => (db(r).get<{ id: number }>('SELECT id FROM users WHERE username = ?', name) as { id: number }).id;
/** Lets the five minutes a new account waits before writing pass. */
export const ageAccounts = (r: Running): void => r.clock.advanceSeconds(NEW_ACCOUNT_WAIT_MS / 1000 + 1);

let nextRequest = 0;
export const requestId = (): string => `live-test-${(nextRequest += 1)}-abcdef`;

// ---- pictures made by hand: only the bytes the server looks at ---------------------------------------------------------------

export function png(width: number, height: number, extra = 0): Uint8Array {
  const b = new Uint8Array(33 + extra);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 0);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}

export function jpeg(width: number, height: number, extra = 0): Uint8Array {
  const head = [0xff, 0xd8, 0xff, 0xfe, 0x00, 0x04, 0x68, 0x69, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9];
  const out = new Uint8Array(head.length + extra);
  out.set(head, 0);
  return out;
}

export const dataUrl = (mime: string, bytes: Uint8Array): string => `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
