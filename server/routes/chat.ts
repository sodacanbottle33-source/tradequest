// The chat room: reading, writing and reporting for every signed-in player; moderation for the owner and the moderators. The role is checked here,
// on the server, for every staff request; what a moderator may do to whom is decided in server/chat.ts. What a message may contain, who may write and how fast are decided in server/chat.ts.

import { isStaff, type User } from '../auth';
import { ChatError, CHAT_PAGE } from '../chat';
import { HttpError, intParam } from '../http';
import type { Ctx, Router } from '../router';
import type { Services } from '../services';

export function registerChatRoutes(router: Router, s: Services): void {
  const { chat } = s;
  const recent = new Map<number, number[]>();

  /** Every chat request counts, so nobody can hammer the room with sends that fail. */
  function limited(userId: number, max: number, what: string): void {
    const now = s.now();
    const key = userId;
    const list = (recent.get(key) ?? []).filter((t) => t > now - 10_000);
    if (list.length >= max) throw new HttpError(429, 'rate_limited', `Too many ${what} too quickly. Wait a moment.`);
    list.push(now);
    recent.set(key, list);
  }

  function guard<T>(fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      if (error instanceof ChatError) throw new HttpError(error.status, error.code, error.message);
      throw error;
    }
  }

  /** The owner or a moderator. */
  function staff(ctx: Ctx): User {
    const user = ctx.requireUser();
    if (!isStaff(user.role)) throw new HttpError(403, 'staff_only', 'Only the owner or a moderator can do that.');
    return user;
  }

  router.get('/api/chat', (ctx) => {
    const user = ctx.requireUser();
    const before = ctx.url.searchParams.get('before');
    return chat.recent(user, before === null ? undefined : intParam(ctx.url, 'before', 1, 1, Number.MAX_SAFE_INTEGER), intParam(ctx.url, 'limit', CHAT_PAGE, 1, 100));
  });

  router.post('/api/chat/send', async (ctx) => {
    const user = ctx.requireUser();
    limited(user.id, 12, 'chat messages');
    const b = await ctx.body();
    const message = guard(() => chat.send(user, b.text));
    return { message, you: chat.you(user) };
  });

  router.post('/api/chat/report', async (ctx) => {
    const user = ctx.requireUser();
    limited(user.id, 10, 'reports');
    const b = await ctx.body();
    guard(() => chat.report(user, b.messageId));
    return { ok: true };
  });

  router.post('/api/chat/delete', async (ctx) => {
    const user = ctx.requireUser();
    limited(user.id, 10, 'deletes');
    const b = await ctx.body();
    return guard(() => chat.removeOwn(user, b.messageId));
  });

  // ---- the owner and the moderators ---------------------------------------------------------------------------------------------------------

  router.get('/api/admin/chat', (ctx) => {
    const user = staff(ctx);
    return chat.adminView(user);
  });

  router.post('/api/admin/chat/delete', async (ctx) => {
    const user = staff(ctx);
    const b = await ctx.body();
    return guard(() => chat.remove(user, { requestId: b.requestId, messageId: b.messageId }));
  });

  router.post('/api/admin/chat/dismiss', async (ctx) => {
    const user = staff(ctx);
    const b = await ctx.body();
    return guard(() => chat.dismiss(user, { requestId: b.requestId, messageId: b.messageId }));
  });

  router.post('/api/admin/chat/mute', async (ctx) => {
    const user = staff(ctx);
    const b = await ctx.body();
    return guard(() => chat.mute(user, { requestId: b.requestId, username: b.username, minutes: b.minutes, reason: b.reason }));
  });

  router.post('/api/admin/chat/ban', async (ctx) => {
    const user = staff(ctx);
    const b = await ctx.body();
    return guard(() => chat.ban(user, { requestId: b.requestId, username: b.username, reason: b.reason }));
  });

  router.post('/api/admin/chat/lift', async (ctx) => {
    const user = staff(ctx);
    const b = await ctx.body();
    return guard(() => chat.lift(user, { requestId: b.requestId, username: b.username }));
  });
}
