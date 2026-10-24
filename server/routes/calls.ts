// Voice calls: ring a friend, answer, hang up, and pass the connection messages between the two browsers. Every rule (who may call whom, how
// often, what a signal may hold) is decided in server/calls.ts. Nothing here reads or stores anything about the sound: it goes browser to browser.

import { CallError } from '../calls';
import { HttpError } from '../http';
import type { Router } from '../router';
import type { Services } from '../services';

export function registerCallRoutes(router: Router, s: Services): void {
  const { calls } = s;
  const recent = new Map<string, number[]>();

  /** Every request counts, so nobody can hammer the server with requests that fail. */
  function limited(userId: number, bucket: 'signal' | 'other', max: number): void {
    const now = s.now();
    const key = `${bucket}:${userId}`;
    const list = (recent.get(key) ?? []).filter((t) => t > now - 10_000);
    if (list.length >= max) throw new HttpError(429, 'rate_limited', 'Too many requests too quickly. Wait a moment.');
    list.push(now);
    recent.set(key, list);
  }

  function guard<T>(fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      if (error instanceof CallError) throw new HttpError(error.status, error.code, error.message);
      throw error;
    }
  }

  router.get('/api/calls', (ctx) => calls.view(ctx.requireUser()));

  router.post('/api/calls/invite', async (ctx) => {
    const user = ctx.requireUser();
    limited(user.id, 'other', 20);
    const b = await ctx.body();
    return guard(() => calls.invite(user, b.username));
  });

  router.post('/api/calls/accept', async (ctx) => {
    const user = ctx.requireUser();
    limited(user.id, 'other', 20);
    const b = await ctx.body();
    return guard(() => calls.accept(user, b.callId));
  });

  router.post('/api/calls/hangup', async (ctx) => {
    const user = ctx.requireUser();
    limited(user.id, 'other', 20);
    const b = await ctx.body();
    return guard(() => calls.hangup(user, b.callId, b.failed === true));
  });

  router.post('/api/calls/signal', async (ctx) => {
    const user = ctx.requireUser();
    limited(user.id, 'signal', 120);
    const b = await ctx.body();
    return guard(() => calls.signal(user, b.callId, b.signal));
  });
}
