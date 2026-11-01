// Comments on companies: anybody can read; a signed-in player writes, answers, likes and reports; the owner and the moderators close reports and delete comments
// (muting or banning the writer goes through the chat tools, which stop comments too). The role is checked here, on the server, for every staff request; what a comment may
// contain and how fast a player may write are decided in server/comments.ts.

import { isStaff, type User } from '../auth';
import { COMMENT_PAGE, CommentError, RECENT_DEFAULT } from '../comments';
import { HttpError, intParam } from '../http';
import type { Ctx, Router } from '../router';
import type { Services } from '../services';

export function registerCommentRoutes(router: Router, s: Services): void {
  const { comments } = s;
  const recent = new Map<number, number[]>();

  /** Every comment request counts, so nobody can hammer the server with writes that fail. */
  function limited(userId: number, max: number, what: string): void {
    const now = s.now();
    const list = (recent.get(userId) ?? []).filter((t) => t > now - 10_000);
    if (list.length >= max) throw new HttpError(429, 'rate_limited', `Too many ${what} too quickly. Wait a moment.`);
    list.push(now);
    recent.set(userId, list);
  }

  function guard<T>(fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      if (error instanceof CommentError) throw new HttpError(error.status, error.code, error.message);
      throw error;
    }
  }

  /** The owner or a moderator. */
  function staff(ctx: Ctx): User {
    const user = ctx.requireUser();
    if (!isStaff(user.role)) throw new HttpError(403, 'staff_only', 'Only the owner or a moderator can do that.');
    return user;
  }

  // The market-wide list is registered first: '/api/comments/recent' has the same number of parts as '/api/comments/:ticker'.
  router.get('/api/comments/recent', (ctx) => ({ comments: comments.recent(intParam(ctx.url, 'limit', RECENT_DEFAULT, 1, 50)) }));

  /** The comments of one company. Open to signed-out visitors (they cannot write). */
  router.get('/api/comments/:ticker', (ctx) => {
    const before = ctx.url.searchParams.get('before');
    return guard(() => comments.list(ctx.user, ctx.params.ticker, before === null ? undefined : intParam(ctx.url, 'before', 1, 1, Number.MAX_SAFE_INTEGER), intParam(ctx.url, 'limit', COMMENT_PAGE, 1, 40)));
  });

  router.post('/api/comments/post', async (ctx) => {
    const user = ctx.requireUser();
    limited(user.id, 8, 'comments');
    const b = await ctx.body();
    const comment = guard(() => comments.post(user, b.ticker, b.text, b.parentId));
    return { comment, you: comments.you(user) };
  });

  router.post('/api/comments/like', async (ctx) => {
    const user = ctx.requireUser();
    limited(user.id, 20, 'likes');
    const b = await ctx.body();
    return guard(() => comments.like(user, b.commentId));
  });

  router.post('/api/comments/report', async (ctx) => {
    const user = ctx.requireUser();
    limited(user.id, 10, 'reports');
    const b = await ctx.body();
    guard(() => comments.report(user, b.commentId));
    return { ok: true };
  });

  router.post('/api/comments/delete', async (ctx) => {
    const user = ctx.requireUser();
    limited(user.id, 10, 'deletes');
    const b = await ctx.body();
    return guard(() => comments.removeOwn(user, b.commentId));
  });

  // ---- the owner and the moderators ---------------------------------------------------------------------------------------------------------

  router.get('/api/admin/comments', (ctx) => comments.adminView(staff(ctx)));

  router.post('/api/admin/comments/delete', async (ctx) => {
    const user = staff(ctx);
    const b = await ctx.body();
    return guard(() => comments.remove(user, { requestId: b.requestId, commentId: b.commentId }));
  });

  router.post('/api/admin/comments/dismiss', async (ctx) => {
    const user = staff(ctx);
    const b = await ctx.body();
    return guard(() => comments.dismiss(user, { requestId: b.requestId, commentId: b.commentId }));
  });
}
