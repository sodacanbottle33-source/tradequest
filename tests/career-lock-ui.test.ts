// The 1v1 screen while Career is closed (docs/world.md §9.12): when the page hides Career, which sections the match screen has, and source-level checks (like
// players-ui.test.ts) that the page only follows the server's match and never decides the rule itself. The rule is the server's (server-career-lock.test.ts).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CAREER_CLOSED_NOTE, careerLocked, MATCH_TABS, modeShown, tabAfterOpen } from '../src/shared/careerLock';
import type { Match, MatchPlayer } from '../src/shared/types';

const src = (...parts: string[]): string => resolve(process.cwd(), 'src', ...parts);
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const player = (over: Partial<MatchPlayer> = {}): MatchPlayer => ({ userId: 1, name: 'alice', bot: false, ready: true, you: true, forfeited: false, finalValueCents: null, profitCents: null, result: null, rewardCents: null, rank: null, ...over });
const match = (phase: Match['phase'], players: MatchPlayer[] = [player(), player({ userId: 2, name: 'bob', you: false })]): Match => ({
  id: 1,
  phase,
  playerCount: players.length,
  capacity: 2,
  players,
  message: '',
  startCashCents: 100_000,
  durationTicks: 180,
  startTick: 100,
  endTick: 280,
  startMs: null,
  endMs: null,
  tick: 100,
  ticksToStart: null,
  ticksLeft: null,
  outcome: null,
  winnerUserId: null,
  cancelReason: null,
  canTrade: phase === 'live',
  friendMatch: false,
  ranked: false,
  isRematch: false,
  rematch: null,
});

describe('when Career is closed', () => {
  it('CLUI-1: only while the match is in its countdown or live; not in the lobby, not after, and not for a player who forfeited', () => {
    expect(careerLocked(null)).toBe(false);
    expect(careerLocked(undefined)).toBe(false);
    for (const phase of ['waiting', 'ready_check', 'settling', 'finished', 'cancelled'] as const) expect(careerLocked(match(phase))).toBe(false);
    expect(careerLocked(match('countdown'))).toBe(true);
    expect(careerLocked(match('live'))).toBe(true);
    // He forfeited a match against a person: it runs on for the other player, but Career is his again (the server uses the same moment).
    const forfeited = match('live', [player({ forfeited: true }), player({ userId: 2, name: 'bob', you: false })]);
    expect(careerLocked(forfeited)).toBe(false);
    // The OTHER player forfeiting changes nothing for me.
    const otherForfeited = match('live', [player(), player({ userId: 2, name: 'bob', you: false, forfeited: true })]);
    expect(careerLocked(otherForfeited)).toBe(true);
    // A view without "you" in it (cannot happen from the server) stays closed: the page never guesses that Career is open.
    expect(careerLocked(match('live', [player({ you: false }), player({ userId: 2, you: false })]))).toBe(true);
  });

  it('CLUI-2: a request for Career shows the 1v1 screen while it is closed; the other places are never changed', () => {
    expect(modeShown('career', true)).toBe('battle');
    expect(modeShown('career', false)).toBe('career');
    for (const mode of ['battle', 'news', 'admin'] as const) {
      expect(modeShown(mode, true)).toBe(mode);
      expect(modeShown(mode, false)).toBe(mode);
    }
  });

  it('CLUI-3: the match has the lists Career has, except Launch: Market, Memecoins, Earnings, News, in that order', () => {
    expect(MATCH_TABS.map(([id, label]) => `${id}:${label}`)).toEqual(['market:Market', 'coins:Memecoins', 'earnings:Earnings', 'news:News']);
    expect(MATCH_TABS.map(([id]) => id)).not.toContain('launch');
  });

  it('CLUI-4: a company page sits under the right section: a coin under Memecoins, a stock under Market, and one opened from Earnings or News keeps that section', () => {
    expect(tabAfterOpen('market', true)).toBe('coins');
    expect(tabAfterOpen('coins', false)).toBe('market');
    expect(tabAfterOpen('market', false)).toBe('market');
    expect(tabAfterOpen('coins', true)).toBe('coins');
    for (const isCoin of [true, false]) {
      expect(tabAfterOpen('earnings', isCoin)).toBe('earnings');
      expect(tabAfterOpen('news', isCoin)).toBe('news');
    }
  });

  it('CLUI-5: the words say why Career is gone, and do not promise anything the server does not do', () => {
    expect(CAREER_CLOSED_NOTE).toMatch(/Career is closed until the match is over/);
    expect(CAREER_CLOSED_NOTE).toMatch(/prices this match is scored on/);
  });
});

describe('the pages follow the server', () => {
  const shared = code(src('shared', 'SharedApp.tsx'));
  const header = code(src('ui', 'Header.tsx'));
  const matchScreen = code(src('shared', 'MatchScreen.tsx'));
  const lobby = code(src('shared', 'LobbyScreen.tsx'));
  const lock = code(src('shared', 'careerLock.ts'));

  it('CLUI-6: the Career button is left out of the header exactly while Career is closed, and everything on screen follows the mode that is shown', () => {
    expect(header).toMatch(/MODES\.filter\(\(m\) => !hidden\.includes\(m\.id\)\)/);
    expect(shared).toMatch(/const locked = careerLocked\(s\.match\);/);
    expect(shared).toMatch(/const shown = modeShown\(mode, locked\);/);
    expect(shared).toMatch(/<Header mode=\{shown\} onMode=\{onMode\} subtitle=\{subtitle\} hidden=\{locked \? \['career'\] : \[\]\}>/);
    // Nothing of Career is drawn from the raw mode: every screen is chosen with `shown`.
    expect(shared).not.toMatch(/\{mode === '(career|battle|news)'/);
    expect(shared).toMatch(/\{shown === 'career' && \(\s*<nav className="tabs"/);
    for (const tab of ['earnings', 'launch', 'players', 'chat', 'messages', 'account']) expect(shared).toContain(`{shown === 'career' && careerTab === '${tab}'`);
    expect(shared).toMatch(/\{shown === 'career' && \(careerTab === 'market' \|\| careerTab === 'coins'\)/);
    // A page that asks for Career while it is closed is sent to the match, and nothing opens the Messages tab then.
    expect(shared).toMatch(/if \(mode === 'career' && locked\) onMode\('battle'\);/);
    expect(shared).toMatch(/if \(s\.pmCompose !== null && !locked\)/);
  });

  it('CLUI-7: a company asked for from the news or the breaking banner while Career is closed opens inside the match, once, and is forgotten when the match is over', () => {
    expect(shared).toMatch(/if \(locked\) \{\s*setMatchJump\(\{ ticker: t \}\);\s*onMode\('battle'\);/);
    expect(shared).toMatch(/if \(!inBattle\) setMatchJump\(null\);/);
    expect(shared).toContain('jump={matchJump} onJumpDone={() => setMatchJump(null)}');
    expect(lobby).toMatch(/jump=\{jump\}/);
    expect(lobby).toMatch(/onJumpDone=\{onJumpDone\}/);
    expect(matchScreen).toMatch(/open\(jump\.ticker\);\s*onJumpDone\?\.\(\);/);
  });

  it('CLUI-8: the match screen has the four sections, each with its own list, and none of them can trade a company a player launched', () => {
    expect(matchScreen).toMatch(/data-testid=\{`mtab-\$\{id\}`\}/);
    expect(matchScreen).toMatch(/MATCH_TABS\.map\(\(\[id, label\]\)/);
    expect(matchScreen).toContain("tab === 'earnings' ? (");
    expect(matchScreen).toContain('<EarningsScreen onOpen={open} />');
    expect(matchScreen).toContain('<NewsScreen onTicker={open} />');
    expect(matchScreen).toContain("<MarketScreen key={tab} kind={tab === 'coins' ? 'coins' : 'stocks'} onOpen={open} selected={null} hideLaunched />");
    // A tab click closes any open company page; a company page trades with the match account only.
    expect(matchScreen).toMatch(/setTab\(id\);\s*setTicker\(null\);/);
    expect(matchScreen).toContain("kind: 'match',");
    expect(matchScreen).not.toMatch(/api\.account\('career'\)/);
    expect(matchScreen).not.toContain("kind: 'career'");
  });

  it('CLUI-9: the page does not decide the rule: it asks the server about the match, and the lock helpers read only the match the server sent', () => {
    expect(lock).toMatch(/match\.phase !== 'countdown' && match\.phase !== 'live'/);
    expect(lock).toMatch(/\?\.forfeited !== true/);
    expect(lock).not.toMatch(/fetch\(|api\./);
  });
});
