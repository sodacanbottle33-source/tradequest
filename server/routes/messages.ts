// Private chats: reading, writing, groups, blocking and reporting for every signed-in player; the reports for the owner only. Every rule (who may
// write to whom, how fast, what a message may be) is decided in server/messages.ts; the owner's role is checked here for every owner request.

import type { User } from '../auth';
import { HttpError, intParam } from '../http';
import { MessageError, PM_PAGE } from '../messages';
import type { Ctx, Router } from '../router';
import type { Services } from '../services';

export function registerMessageRoutes(router: Router, s: Services): void {
  const { messages } = s;
  const recent = new Map<string, number[]>();

  /** Every request counts, so nobody can hammer the server with requests that fail. */
  function limited(userId: number, bucket: 'write' | 'other', max: number): void {
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
      if (error instanceof MessageError) throw new HttpError(error.status, error.code, error.message);
      throw error;
    }
  }

  function owner(ctx: Ctx): User {
    const user = ctx.requireUser();
    if (user.role !== 'owner') throw new HttpError(403, 'owner_only', 'Only the owner can do that.');
    return user;
  }

  router.get('/api/messages', (ctx) => messages.view(ctx.requireUser()));

  router.get('/api/messages/thread/:id', (ctx) => {
    const user = ctx.requireUser();
    const id = Number(ctx.params.id);
    if (!Number.isSafeInteger(id) || id < 1) throw new HttpError(400, 'bad_request', 'That is not a conversation number.');
    const before = ctx.url.searchParams.get('before');
    return guard(() => messages.thread(user, id, before === null ? undefined : intParam(ctx.url, 'before', 1, 1, Number.MAX_SAFE_INTEGER), intParam(ctx.url, 'limit', PM_PAGE, 1, 100)));
  });

  router.post('/api/messages/send', async (ctx) => {
    const user = ctx.requireUser();
    limited(user.id, 'write', 12);
    const b = await ctx.body();
    return guard(() => messages.send(user, { conversationId: b.conversationId, username: b.username, text: b.text }));
  });

  router.post('/api/messages/read', async (ctx) => {
    const user = ctx.requireUser();
    limited(user.id, 'other', 40);
    const b = await ctx.body();
    return guard(() => messages.read(user, b.conversationId, b.upToId));
  });

  router.post('/api/messages/respond', async (ctx) => {
    const user = ctx.requireUser();
    limited(user.id, 'other', 30);
    const b = await ctx.body();
    return guard(() => messages.respond(user, b.conversationId, b.answer));
  });

  router.post('/api/messages/group/create', async (ctx) => {
    const user = ctx.requireUser();
    limited(user.id, 'other', 30);
    const b = await ctx.body();
    return guard(() => messages.createGroup(user, { title: b.title, usernames: b.usernames }));
  });

  router.post('/api/messages/group/invite', async (ctx) => {
    const user = ctx.requireUser();
    limited(user.id, 'other', 30);
    const b = await ctx.body();
    return guard(() => messages.invite(user, b.conversationId, b.username));
  });

  router.post('/api/messages/group/remove', async (ctx) => {
    const user = ctx.requireUser();
    limited(user.id, 'other', 30);
    const b = await ctx.body();
    return guard(() => messages.removeMember(user, b.conversationId, b.username));
  });

  router.post('/api/messages/group/leave', async (ctx) => {
    const user = ctx.requireUser();
    limited(user.id, 'other', 30);
    const b = await ctx.body();
    return guard(() => messages.leave(user, b.conversationId));
  });

  router.post('/api/messages/group/rename', async (ctx) => {
    const user = ctx.requireUser();
    limited(user.id, 'other', 30);
    const b = await ctx.body();
    return guard(() => messages.rename(user, b.conversationId, b.title));
  });

  router.post('/api/messages/report', async (ctx) => {
    const user = ctx.requireUser();
    limited(user.id, 'other', 10);
    const b = await ctx.body();
    guard(() => messages.report(user, b.messageId));
    return { ok: true };
  });

  router.post('/api/messages/delete', async (ctx) => {
    const user = ctx.requireUser();
    limited(user.id, 'other', 30);
    const b = await ctx.body();
    return guard(() => messages.deleteOwn(user, b.messageId));
  });

  router.post('/api/messages/block', async (ctx) => {
    const user = ctx.requireUser();
    limited(user.id, 'other', 30);
    const b = await ctx.body();
    return guard(() => messages.block(user, b.username));
  });

  router.post('/api/messages/unblock', async (ctx) => {
    const user = ctx.requireUser();
    limited(user.id, 'other', 30);
    const b = await ctx.body();
    return guard(() => messages.unblock(user, b.username));
  });

  // ---- the owner: only what players reported ------------------------------------------------------------------------------

  router.get('/api/admin/private-reports', (ctx) => {
    owner(ctx);
    return messages.adminView();
  });

  router.post('/api/admin/private-reports/dismiss', async (ctx) => {
    const user = owner(ctx);
    const b = await ctx.body();
    return guard(() => messages.dismiss(user, { requestId: b.requestId, messageId: b.messageId }));
  });
}
