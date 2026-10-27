// The chat room: reading, writing and reporting for every signed-in player; moderation for the owner and the moderators. The role is checked here,
// on the server, for every staff request; what a moderator may do to whom is decided in server/chat.ts. What a message may contain, who may write and how fast are decided in server/chat.ts.

import { isStaff, type User } from '../auth';
import { ChatError, CHAT_PAGE } from '../chat';
import { PIC_REQUEST_LIMIT, PictureProblem } from '../chatPictures';
import { HttpError, intParam, readJson } from '../http';
import { HANDLED, type Ctx, type Router } from '../router';
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
      if (error instanceof ChatError || error instanceof PictureProblem) throw new HttpError(error.status, error.code, error.message);
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
    // A message with a picture is bigger than one without (the picture comes as text inside the JSON).
    const b = await readJson(ctx.req, PIC_REQUEST_LIMIT);
    const message = guard(() => chat.send(user, b.text, b.picture));
    return { message, you: chat.you(user) };
  });

  /** The picture of a chat message. The address is the message's number, which never changes, so a browser may keep it. */
  router.get('/api/chat/picture/:id', (ctx) => {
    const user = ctx.requireUser();
    const picture = guard(() => chat.pictureOf(user, Number(ctx.params.id)));
    ctx.res.writeHead(200, {
      'Content-Type': picture.mime,
      'Content-Length': picture.data.length,
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      // Even if somebody got a page to open this address on its own, nothing in it can run.
      'Content-Security-Policy': "default-src 'none'; sandbox",
    });
    ctx.res.end(Buffer.from(picture.data));
    return HANDLED;
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
    return { ...chat.adminView(user), picturesOn: s.chatPictures.enabled() };
  });

  /** The owner switches pictures in all chats off or on (text keeps working). It is written to the admin log once per requestId. */
  router.post('/api/admin/chat/pictures', async (ctx) => {
    const user = ctx.requireUser();
    if (user.role !== 'owner') throw new HttpError(403, 'owner_only', 'Only the owner can do that.');
    const b = await ctx.body();
    if (typeof b.on !== 'boolean') throw new HttpError(400, 'bad_request', 'on must be true or false.');
    const first = s.admin.logOnce(user, b.requestId, 'chat_pictures', b.on ? 'on' : 'off', { on: b.on });
    if (first) s.chatPictures.setEnabled(b.on);
    return { ok: true, duplicate: !first, picturesOn: s.chatPictures.enabled() };
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
