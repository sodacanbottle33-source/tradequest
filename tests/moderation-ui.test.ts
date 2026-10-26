// Source-level and small-logic checks for the moderator screens (like admin-ui.test.ts): the Moderation page is reachable only through the profile menu and only
// for a moderator the owner chose; it only sends requests (the server decides and checks everything again); it offers only what the server accepts; the owner's
// panel gets the "Make moderator" button; chat tools are narrower for a moderator; the page learns at once when the owner makes or removes a moderator.
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KICK_MINUTES, MOD_BANS_PER_HOUR, MOD_MAX_BAN_HOURS } from '../server/admin';
import { SharedStore } from '../src/shared/store';
import { KICK_CHOICES, MOD_BAN_CHOICES, banLine, cannotActOn } from '../src/shared/modUtil';

const src = (...parts: string[]): string => resolve(process.cwd(), 'src', ...parts);

function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('Moderator screens', () => {
  it('MODUI-1: "Moderation" is in the profile menu only for a moderator; the page opens only for a moderator and is left when the job is gone; no top button', () => {
    const menu = code(src('shared', 'ProfileMenu.tsx'));
    const at = menu.indexOf('Moderation');
    expect(at).toBeGreaterThan(0);
    expect(menu.slice(Math.max(0, at - 400), at)).toMatch(/isMod &&/);
    expect(menu).toMatch(/const isMod = user\?\.role === 'moderator'/);
    expect(menu).toMatch(/data-testid="menu-mod"/);
    const shell = code(src('shared', 'SharedApp.tsx'));
    expect(shell).toMatch(/mode === 'mod' && isMod && <ModScreen/);
    expect(shell).toMatch(/mode === 'mod' && s\.authChecked && !isMod/);
    expect(shell).toMatch(/mode === 'admin' && isOwner && <AdminScreen/); // the owner's panel is still the owner's only
    const header = code(src('ui', 'Header.tsx'));
    expect(header).toMatch(/Exclude<Mode, 'admin' \| 'mod'>/);
    expect(header).not.toMatch(/Moderation/);
  });

  it('MODUI-2: the Moderation page only sends requests the moderator is allowed to make; each carries its own request id; nothing is kept in the browser', () => {
    const screen = code(src('shared', 'ModScreen.tsx'));
    for (const call of ['api.modPlayers', 'api.adminBan', 'api.adminKick', 'api.adminUnban', 'api.adminAvatarRemove']) expect(screen).toContain(call);
    // Nothing that belongs to the owner alone.
    for (const call of ['adminCash', 'adminCoins', 'adminShares', 'adminReset', 'adminModerator', 'adminShock', 'adminHalt', 'adminStock', 'adminPrivateReports', 'adminChatBan', 'adminState', 'adminAnnounce', 'adminPause']) {
      expect(screen).not.toContain(call);
    }
    expect(screen).not.toMatch(/localStorage|sessionStorage|Math\.random/);
    expect(screen).toMatch(/AdminChat staff/);
    expect((screen.match(/newRequestId\(\)/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(screen).toMatch(/cannotActOn\(player\.role\)/); // a moderator cannot even start on the owner or another moderator
    // A ban is asked for with explicit hours (never "forever"), and every ban or kick asks "Yes" first.
    expect(screen).toMatch(/hours: confirm\.hours/);
    expect(screen).not.toMatch(/forever|until I lift/i);
    expect(screen).toMatch(/Yes, ban/);
    expect(screen).toMatch(/Yes, kick/);
  });

  it('MODUI-3: the choices match the server\'s limits: bans of 1 hour to 7 days, kicks of 10 minutes, 1 hour or 1 day, about 20 an hour', () => {
    expect(MOD_BAN_CHOICES.map((b) => b.hours)).toEqual([1, 24, 168]);
    expect(Math.max(...MOD_BAN_CHOICES.map((b) => b.hours))).toBe(MOD_MAX_BAN_HOURS);
    expect(KICK_CHOICES.map((k) => k.minutes)).toEqual([...KICK_MINUTES]);
    expect(MOD_BANS_PER_HOUR).toBe(20);
    expect(code(src('shared', 'ModScreen.tsx'))).toMatch(/about 20 kicks and bans an hour/);
    expect(cannotActOn('player')).toBeNull();
    expect(cannotActOn('owner')).toMatch(/owner/i);
    expect(cannotActOn('moderator')).toMatch(/moderator/i);
    expect(banLine({ untilMs: null, reason: '', kind: 'ban' })).toBe('Banned until the owner lifts it.');
    expect(banLine({ untilMs: null, reason: 'spam', kind: 'ban' })).toBe('Banned until the owner lifts it: spam');
    expect(banLine({ untilMs: Date.UTC(2026, 9, 26, 12, 0), reason: 'x', kind: 'kick' })).toMatch(/^Kicked until .+: x$/);
  });

  it('MODUI-4: the Chat section for a moderator never asks for private reports, has no "Ban from chat", and cannot lift what the owner decided', () => {
    const chat = code(src('shared', 'AdminChat.tsx'));
    expect(chat).toMatch(/export function AdminChat\(\{ staff = false \}/);
    expect(chat).toMatch(/staff \? Promise\.resolve\(null\) : api\.adminPrivateReports\(\)/);
    expect(chat).toMatch(/\{!staff && \(\s*<button[\s\S]{0,300}?adminChatBan/);
    expect(chat).toMatch(/\{!staff && \(\s*<section[\s\S]{0,200}?admin-private/);
    expect(chat).toMatch(/staff && x\.byOwner/);
    expect(chat).toMatch(/The owner decided this/);
  });

  it('MODUI-5: in the Chat screen a moderator can moderate ordinary players only (no ban from the chat), and can report another moderator but not the owner', () => {
    const screen = code(src('shared', 'ChatScreen.tsx'));
    expect(screen).toMatch(/const canModerate = isStaff && !mine && \(isOwner \|\| message\.role === 'player'\)/);
    expect(screen).toMatch(/const canReport = !mine && message\.role !== 'owner' && \(!isStaff \|\| \(!isOwner && message\.role === 'moderator'\)\)/);
    expect(screen).toMatch(/\{isOwner && \(\s*<button[\s\S]{0,300}?adminChatBan/);
    expect(screen).toMatch(/const isStaff = isOwner \|\| user\.role === 'moderator'/);
    expect(screen).toMatch(/isOwner = user\.role === 'owner'/);
    // The owner's own messages are deleted with his tool; a moderator deletes his own like any player.
    expect(screen).toMatch(/\{isOwner && mine && \(/);
    expect(screen).toMatch(/\{!isOwner && mine && !deleting && \(/);
  });

  it('MODUI-6: the owner\'s Players tab has "Make a moderator" (asks first) and "Take the moderator job"; the log has words for kicks and the job changes', () => {
    const players = code(src('shared', 'AdminPlayers.tsx'));
    expect(players).toMatch(/api\.adminModerator\(/);
    expect(players).toMatch(/data-testid="admin-mod-add"/);
    expect(players).toMatch(/data-testid="admin-mod-confirm"/);
    expect(players).toMatch(/data-testid="admin-mod-remove"/);
    expect(players).toMatch(/isOwnerRow && <p className="hint">The owner is above a moderator/);
    expect(players).toMatch(/<RoleBadge role=\{p\.role\} \/>/);
    const log = code(src('shared', 'AdminLog.tsx'));
    for (const a of ["case 'kick'", "case 'mod_appoint'", "case 'mod_remove'"]) expect(log).toContain(a);
    // The log tab and the owner-only tabs stay in the owner's panel only.
    expect(code(src('shared', 'AdminScreen.tsx'))).toMatch(/\['log', 'Log'\]/);
    expect(code(src('shared', 'ModScreen.tsx'))).not.toMatch(/AdminLog|AdminMarket|AdminStocks|AdminCoins|AdminLaunches|AdminBroadcast/);
  });

  it('MODUI-7: the page listens for role changes, and a role change or a badge makes a pop-up; the kicked notice says "kicked"', () => {
    const store = code(src('shared', 'store.ts'));
    expect(store).toMatch(/addEventListener\('role_changed'/);
    expect(store).toMatch(/addEventListener\('badges'/);
    const s = new SharedStore() as unknown as { onRoleChanged(d: { role: string }): void; recheckMe(): Promise<void>; getSnapshot(): { toasts: { title: string; tone: string; ticker: string }[] } };
    s.recheckMe = async () => {}; // (no server here)
    s.onRoleChanged({ role: 'moderator' });
    s.onRoleChanged({ role: 'player' });
    const toasts = s.getSnapshot().toasts;
    expect(toasts.map((t) => t.title)).toEqual(['You are a moderator now', 'You are not a moderator any more']);
    expect(toasts.map((t) => t.tone)).toEqual(['good', 'neutral']);
    expect(toasts.every((t) => t.ticker === '')).toBe(true);
    const toast = code(src('shared', 'Toasts.tsx'));
    expect(toast).toMatch(/t\.ticker \? `\$\{t\.title\}: \$\{t\.ticker\}` : t\.title/);
    const notices = code(src('shared', 'Notices.tsx'));
    expect(notices).toMatch(/s\.banned\.kind === 'kick'/);
    expect(notices).toMatch(/You were kicked out for a short time/);
  });

  it('MODUI-8: every place that shows a role knows about moderators: one RoleBadge, and no screen still limits roles to player or owner', () => {
    const files = readdirSync(src('shared')).filter((f) => f.endsWith('.tsx') || f.endsWith('.ts'));
    for (const f of files) {
      const text = code(src('shared', f));
      expect(text, f).not.toMatch(/'player' \| 'owner'/);
      if (f !== 'RoleBadge.tsx') expect(text, f).not.toMatch(/className="badge-owner"/); // only RoleBadge draws the tag
    }
    expect(code(src('shared', 'types.ts'))).toMatch(/export type Role = 'player' \| 'moderator' \| 'owner'/);
    const badge = code(src('shared', 'RoleBadge.tsx'));
    expect(badge).toMatch(/Mod/);
    expect(badge).toMatch(/badge-mod/);
    for (const f of ['ChatScreen.tsx', 'PmThreadView.tsx', 'PlayersScreen.tsx', 'AdminPlayers.tsx', 'AdminScreen.tsx', 'ProfileMenu.tsx']) expect(code(src('shared', f)), f).toContain('<RoleBadge');
  });
});
