// Source-level and small-logic checks for the badge screens: a Badges section in the Players tab that shows every badge (earned ones lit, the rest locked with
// how to get them, and how rare each is), the best three next to a name in the Players list, and a pop-up when the server says you earned one.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BADGES, BADGES_SHOWN, BADGE_GROUPS } from '../src/shared/badgeCatalog';
import { earnedText, haveText, rarityText } from '../src/shared/badgeUtil';
import { SharedStore } from '../src/shared/store';

const src = (...parts: string[]): string => resolve(process.cwd(), 'src', ...parts);

function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('Badge screens', () => {
  it('BADGEUI-1: the Players tab has a Badges section; the page asks the server (never decides), shows every badge by group, and asks again when one is earned', () => {
    const players = code(src('shared', 'PlayersScreen.tsx'));
    expect(players).toMatch(/\['badges', 'Badges'\]/);
    expect(players).toMatch(/view === 'badges' && <BadgesScreen \/>/);
    const screen = code(src('shared', 'BadgesScreen.tsx'));
    expect(screen).toMatch(/api\s*\.badges\(\)/);
    expect(screen).toMatch(/\[userId, badgesVersion\]/);
    expect(screen).toContain('BADGE_GROUPS.map');
    expect(screen).toMatch(/BADGES\.filter\(\(b\) => b\.group === g\.id\)/);
    expect(screen).toMatch(/data-testid=\{`badge-\$\{b\.id\}`\}/);
    expect(screen).toMatch(/Not earned yet/);
    expect(screen).not.toMatch(/localStorage|sessionStorage|Math\.random/);
    expect(BADGE_GROUPS.length).toBe(5);
  });

  it('BADGEUI-2: the Players list shows at most three badge icons next to a name, from the server\'s answer; a locked medal is grey and every medal says what it is', () => {
    const players = code(src('shared', 'PlayersScreen.tsx'));
    expect(players).toMatch(/<BadgeRow ids=\{badges\} \/>/);
    expect(players).toMatch(/badges=\{p\.badges\}/);
    const icon = code(src('shared', 'BadgeIcon.tsx'));
    expect(icon).toMatch(/slice\(0, BADGES_SHOWN\)/);
    expect(BADGES_SHOWN).toBe(3);
    expect(icon).toMatch(/locked \? ' locked' : ''/);
    expect(icon).toContain('`${def.name} (${TIER_NAMES[def.tier]}): ${def.how}`');
    expect(icon).toMatch(/title=\{title\}/);
    // A secret badge that is not earned yet never shows its name or how to get it, only the hint.
    expect(icon).toMatch(/const hidden = locked && def\.secret === true/);
    expect(icon).toContain('`Secret badge (${TIER_NAMES[def.tier]}): ${def.hint');
    expect(icon).toMatch(/if \(!def\) return null/); // a badge this page does not know is skipped, not drawn broken
    const css = readFileSync(src('styles.css'), 'utf8');
    for (const cls of ['.badge-icon.tier-1', '.badge-icon.tier-4', '.badge-icon.locked', '.badge-grid', '.badge-card.got', '.badge-mod']) expect(css).toContain(cls);
  });

  it('BADGEUI-3: the words: how rare a badge is, the day it was earned, and how many you have', () => {
    expect(rarityText(0, 40)).toBe('Nobody has it yet');
    expect(rarityText(5, 0)).toBe('Nobody has it yet');
    expect(rarityText(1, 1000)).toBe('Less than 1% of players');
    expect(rarityText(10, 40)).toBe('25% of players');
    expect(rarityText(40, 40)).toBe('100% of players');
    expect(rarityText(50, 40)).toBe('100% of players'); // never more than everybody
    expect(earnedText(Date.UTC(2026, 9, 26, 12, 0))).toMatch(/2026/);
    expect(haveText(7, BADGES.length)).toBe(`You have 7 of ${BADGES.length} badges.`);
  });

  it('BADGEUI-4: when the server says a player earned badges, a pop-up names them and an open Badges page is told to ask again; unknown ids are ignored', () => {
    const store = code(src('shared', 'store.ts'));
    expect(store).toMatch(/badgesVersion: this\.state\.badgesVersion \+ 1/);
    const s = new SharedStore() as unknown as { onBadges(d: { earned: string[] }): void; getSnapshot(): { badgesVersion: number; toasts: { title: string; text: string; tone: string }[] } };
    expect(s.getSnapshot().badgesVersion).toBe(0);
    s.onBadges({ earned: ['first_trade'] });
    s.onBadges({ earned: ['welcome', 'week_one'] });
    s.onBadges({ earned: ['made_up_badge'] });
    const snap = s.getSnapshot();
    expect(snap.badgesVersion).toBe(3);
    expect(snap.toasts.map((t) => t.title)).toEqual(['New badge', '2 new badges']);
    expect(snap.toasts[0]?.text).toContain('First Trade');
    expect(snap.toasts[1]?.text).toContain('Welcome!');
    expect(snap.toasts[1]?.text).toContain('One Week In');
    expect(snap.toasts.every((t) => t.tone === 'good')).toBe(true);
  });
});
