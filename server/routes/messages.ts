// Private chats: reading, writing, groups, blocking and reporting for every signed-in player; the reports for the owner only. Every rule (who may
// write to whom, how fast, what a message may be) is decided in server/messages.ts; the owner's role is checked here for every owner request.

import type { User } from '../auth';
import { PIC_REQUEST_LIMIT, PictureProblem } from '../chatPictures';
import { HttpError, intParam, readJson } from '../http';
import { MessageError, PM_PAGE } from '../messages';
import { HANDLED, type Ctx, type Router } from '../router';
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
      if (error instanceof MessageError || error instanceof PictureProblem) throw new HttpError(error.status, error.code, error.message);
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
    // A message with a picture is bigger than one without (the picture comes as text inside the JSON).
    const b = await readJson(ctx.req, PIC_REQUEST_LIMIT);
    return guard(() => messages.send(user, { conversationId: b.conversationId, username: b.username, text: b.text, picture: b.picture }));
  });

  /** The picture of a private message, for a player who may read it. The address is the message's number, which never changes. */
  router.get('/api/messages/picture/:id', (ctx) => {
    const user = ctx.requireUser();
    limited(user.id, 'other', 120);
    const picture = guard(() => messages.pictureOf(user, Number(ctx.params.id)));
    ctx.res.writeHead(200, {
      'Content-Type': picture.mime,
      'Content-Length': picture.data.length,
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    });
    ctx.res.end(Buffer.from(picture.data));
    return HANDLED;
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
    return guard(() => messages.createGroup(user, { title: b.title, usernames: b.usernames, visibility: b.visibility }));
  });

  /** The public groups anybody can join (newest activity and busiest first), optionally only those whose name has `q` in it. */
  router.get('/api/messages/groups/public', (ctx) => {
    const user = ctx.requireUser();
    limited(user.id, 'other', 40);
    return guard(() => messages.publicGroups(user, ctx.url.searchParams.get('q') ?? undefined));
  });

  router.post('/api/messages/group/join', async (ctx) => {
    const user = ctx.requireUser();
    limited(user.id, 'other', 30);
    const b = await ctx.body();
    return guard(() => messages.join(user, b.conversationId));
  });

  router.post('/api/messages/group/visibility', async (ctx) => {
    const user = ctx.requireUser();
    limited(user.id, 'other', 30);
    const b = await ctx.body();
    return guard(() => messages.setVisibility(user, b.conversationId, b.visibility));
  });

  router.post('/api/messages/group/invite', async (ctx) => {
    const user = ctx.requireUser();
    limited(user.id, 'other', 30);
    const b = await ctx.body();
    return guard(() => messages.invite(user, b.conversationId, b.usernames !== undefined ? b.usernames : b.username));
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

  /** The owner looks at the copy of a reported picture (only while a report about it is open). */
  router.get('/api/admin/private-reports/picture/:id', (ctx) => {
    owner(ctx);
    const picture = guard(() => messages.reportPicture(Number(ctx.params.id)));
    ctx.res.writeHead(200, {
      'Content-Type': picture.mime,
      'Content-Length': picture.data.length,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    });
    ctx.res.end(Buffer.from(picture.data));
    return HANDLED;
  });

  router.post('/api/admin/private-reports/dismiss', async (ctx) => {
    const user = owner(ctx);
    const b = await ctx.body();
    return guard(() => messages.dismiss(user, { requestId: b.requestId, messageId: b.messageId }));
  });
}
