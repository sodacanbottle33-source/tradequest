// Profile pictures and who is online. A picture is shown to every signed-in player; the rules for what is accepted are in server/profile.ts.
// The role of the owner and of the moderators is checked here for the removal tool.

import { isStaff, type User } from '../auth';
import { HANDLED } from '../router';
import { HttpError, readJson } from '../http';
import { AVATAR_MAX_BYTES, ProfileError } from '../profile';
import { RenameError } from '../rename';
import type { Ctx, Router } from '../router';
import type { Services } from '../services';

/** A picture comes as text (base64 is a third bigger than the bytes), plus the JSON around it. */
const AVATAR_BODY_LIMIT = Math.ceil((AVATAR_MAX_BYTES * 4) / 3) + 1024;

export function registerProfileRoutes(router: Router, s: Services): void {
  const { profiles } = s;

  function guard<T>(fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      if (error instanceof ProfileError) throw new HttpError(error.status, error.code, error.message);
      if (error instanceof RenameError) throw new HttpError(error.status, error.code, error.message, error.extra);
      throw error;
    }
  }

  function staff(ctx: Ctx): User {
    const user = ctx.requireUser();
    if (!isStaff(user.role)) throw new HttpError(403, 'staff_only', 'Only the owner or a moderator can do that.');
    return user;
  }

  /** Every picture there is, as username -> version. The page keeps this list and shows a picture only for the names on it. */
  router.get('/api/avatars', (ctx) => {
    ctx.requireUser();
    return { avatars: profiles.versions() };
  });

  /** The picture itself. The address carries the version (?v=...), so a browser can keep it for good as long as the number does not change. */
  router.get('/api/avatar/:username', (ctx) => {
    ctx.requireUser();
    const picture = profiles.image(ctx.params.username ?? '');
    if (!picture) throw new HttpError(404, 'no_picture', 'That player has no picture.');
    const tag = `"${picture.updatedMs}"`;
    const asked = ctx.url.searchParams.get('v');
    const headers: Record<string, string> = {
      'Content-Type': picture.mime,
      'Cache-Control': asked === String(picture.updatedMs) ? 'private, max-age=31536000, immutable' : 'private, no-cache',
      ETag: tag,
      'X-Content-Type-Options': 'nosniff',
      // Even if somebody got a page to open this address on its own, nothing in it can run.
      'Content-Security-Policy': "default-src 'none'; sandbox",
    };
    if (ctx.req.headers['if-none-match'] === tag) {
      ctx.res.writeHead(304, headers);
      ctx.res.end();
      return HANDLED;
    }
    ctx.res.writeHead(200, { ...headers, 'Content-Length': picture.data.length });
    ctx.res.end(Buffer.from(picture.data));
    return HANDLED;
  });

  router.post('/api/profile/avatar', async (ctx) => {
    const user = ctx.requireUser();
    const body = await readJson(ctx.req, AVATAR_BODY_LIMIT);
    return guard(() => profiles.set(user, body.image));
  });

  router.post('/api/profile/avatar/remove', (ctx) => {
    const user = ctx.requireUser();
    return guard(() => profiles.clear(user));
  });

  // ---- changing the username ---------------------------------------------------------------------------------------------------------------

  const asked = new Map<number, number[]>();
  function slow(userId: number): void {
    const now = s.now();
    const list = (asked.get(userId) ?? []).filter((t) => t > now - 60_000);
    if (list.length >= 6) throw new HttpError(429, 'rate_limited', 'Too many tries. Wait a moment.');
    list.push(now);
    asked.set(userId, list);
  }

  /** What the Account page shows: the price, whether he can change his username now, and if not why and when. */
  router.get('/api/account/username', (ctx) => {
    const user = ctx.requireUser();
    return guard(() => s.renames.status(user));
  });

  router.post('/api/account/username', async (ctx) => {
    const user = ctx.requireUser();
    slow(user.id);
    const b = await ctx.body();
    const out = guard(() => s.renames.change(user, b.username));
    const fresh = s.auth.userById(user.id);
    return { ...out, user: fresh ? { id: fresh.id, username: fresh.username, displayName: fresh.displayName, role: fresh.role } : null };
  });

  router.get('/api/online', (ctx) => {
    ctx.requireUser();
    return { online: profiles.online() };
  });

  router.post('/api/admin/avatar/remove', async (ctx) => {
    const user = staff(ctx);
    const b = await ctx.body();
    return guard(() => profiles.removeBy(user, { requestId: b.requestId, username: b.username }));
  });
}
