// Owner-only routes (state, price moves, halts, the price-impact dial, cash/coins/shares, resets, announcement, pause-all, new companies, the launches
// overview, choosing moderators) and the few routes a moderator may use too (ban, kick, unban, finding a player). The role is checked here, on the
// server, for every request: a browser cannot make itself the owner or a moderator.

import { Admin, type ShockInput } from '../admin';
import { isStaff, type User } from '../auth';
import { HttpError } from '../http';
import type { Ctx, Router } from '../router';
import type { Services } from '../services';

export function registerAdminRoutes(router: Router, s: Services, admin: Admin): void {
  function owner(ctx: Ctx): User {
    const user = ctx.requireUser();
    if (user.role !== 'owner') throw new HttpError(403, 'owner_only', 'Only the owner can do that.');
    return user;
  }

  /** The owner or a moderator (what a moderator may do to whom is decided in server/admin.ts). */
  function staff(ctx: Ctx): User {
    const user = ctx.requireUser();
    if (!isStaff(user.role)) throw new HttpError(403, 'staff_only', 'Only the owner or a moderator can do that.');
    return user;
  }

  router.get('/api/admin/state', (ctx) => {
    owner(ctx);
    return { tick: s.world.sim.tick, ...admin.state(ctx.url.searchParams.get('q') ?? '') };
  });

  router.post('/api/admin/shock', async (ctx) => {
    const user = owner(ctx);
    const b = await ctx.body();
    const input: ShockInput = {
      requestId: b.requestId as string,
      ticker: b.ticker as string,
      percent: b.percent as number,
      style: b.style as ShockInput['style'],
      speed: b.speed as ShockInput['speed'],
      headline: b.headline as string | undefined,
      body: b.body as string | undefined,
      breaking: typeof b.breaking === 'boolean' ? b.breaking : undefined,
    };
    return admin.shock(user, input);
  });

  router.post('/api/admin/halt', async (ctx) => {
    const user = owner(ctx);
    const b = await ctx.body();
    return admin.setHalt(user, { requestId: b.requestId as string, ticker: b.ticker as string, halted: b.halted as boolean, reason: b.reason as string | undefined });
  });

  router.post('/api/admin/stock', async (ctx) => {
    const user = owner(ctx);
    const b = await ctx.body();
    return admin.createStock(user, {
      requestId: b.requestId as string,
      name: b.name,
      ticker: b.ticker,
      sector: b.sector,
      tier: b.tier,
      personality: b.personality,
      priceCents: b.priceCents,
      industry: b.industry,
      description: b.description,
    });
  });

  router.post('/api/admin/cash', async (ctx) => {
    const user = owner(ctx);
    const b = await ctx.body();
    return admin.adjustCash(user, { requestId: b.requestId as string, username: b.username as string, amountCents: b.amountCents as number, note: b.note as string | undefined });
  });

  router.post('/api/admin/ban', async (ctx) => {
    const user = staff(ctx);
    const b = await ctx.body();
    return admin.banPlayer(user, { requestId: b.requestId as string, username: b.username as string, reason: b.reason as string | undefined, hours: b.hours as number | null | undefined });
  });

  router.post('/api/admin/unban', async (ctx) => {
    const user = staff(ctx);
    const b = await ctx.body();
    return admin.unbanPlayer(user, { requestId: b.requestId as string, username: b.username as string });
  });

  router.post('/api/admin/kick', async (ctx) => {
    const user = staff(ctx);
    const b = await ctx.body();
    return admin.kickPlayer(user, { requestId: b.requestId as string, username: b.username as string, minutes: b.minutes as number, reason: b.reason as string | undefined });
  });

  /** The owner chooses a moderator, or takes the job away again. */
  router.post('/api/admin/moderator', async (ctx) => {
    const user = owner(ctx);
    const b = await ctx.body();
    return admin.setModerator(user, { requestId: b.requestId as string, username: b.username as string, on: b.on as boolean });
  });

  /** The moderators' way to find a player: names and whether he is banned, no money. */
  router.get('/api/mod/players', (ctx) => {
    staff(ctx);
    return admin.staffPlayers(ctx.url.searchParams.get('q') ?? '');
  });

  router.post('/api/admin/shares', async (ctx) => {
    const user = owner(ctx);
    const b = await ctx.body();
    return admin.adjustShares(user, { requestId: b.requestId as string, username: b.username as string, ticker: b.ticker as string, qty: b.qty as number, note: b.note as string | undefined });
  });

  router.post('/api/admin/reset', async (ctx) => {
    const user = owner(ctx);
    const b = await ctx.body();
    return admin.resetPlayer(user, { requestId: b.requestId as string, username: b.username as string, note: b.note as string | undefined });
  });

  router.post('/api/admin/announce', async (ctx) => {
    const user = owner(ctx);
    const b = await ctx.body();
    return admin.setAnnouncement(user, { requestId: b.requestId as string, text: b.text as string | undefined });
  });

  router.post('/api/admin/pause', async (ctx) => {
    const user = owner(ctx);
    const b = await ctx.body();
    return admin.setTradingPaused(user, { requestId: b.requestId as string, paused: b.paused as boolean, reason: b.reason as string | undefined });
  });

  router.post('/api/admin/coins', async (ctx) => {
    const user = owner(ctx);
    const b = await ctx.body();
    return admin.adjustCoins(user, { requestId: b.requestId as string, username: b.username as string, amountCents: b.amountCents as number, note: b.note as string | undefined });
  });
}
