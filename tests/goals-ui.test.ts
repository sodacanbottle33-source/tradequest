// GOALUI-1 … GOALUI-12 — daily goals, the streak, "while you were away" and ranked 1v1, as the PAGE shows them (docs/world.md §31, §32, §33). The rules are the server's
// (tests/server-daily.test.ts, tests/server-away.test.ts, tests/server-ranked.test.ts); here the page only turns the server's answer into words, keeps what it was told, and asks.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GEAR_SLOTS, SLOTS } from '../src/shared/cosmeticCatalog';
import { GOAL_REWARD } from '../src/shared/goalCatalog';
import { awayCompanyLines, awayLines, awayText, barPercent, goalNotice, goalsWaiting, kindName, longUntil, lookName, signedCents, signedPercent, streakNote } from '../src/shared/goalUtil';
import { nextTierText, notRankedReason, pointsChangeText, rankedTag, tierLabel, tierReached } from '../src/shared/rankedUtil';
import type { AwayReport, GoalsView, StreakView } from '../src/shared/types';

const src = (...parts: string[]): string => resolve(process.cwd(), 'src', ...parts);
const read = (...parts: string[]): string => readFileSync(src(...parts), 'utf8');

function code(file: string): string {
  return read(...file.split('/'))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const css = read('styles.css');
const MARK_START = 'Daily goals, the streak, "while you were away" and ranked 1v1';
const MARK_END = 'Trade moments, loading shimmer, smooth screens and market marks';
const ownCss = css.slice(css.indexOf(MARK_START), css.indexOf(MARK_END)).replace(/\/\*[\s\S]*?\*\//g, '');

const streak = (patch: Partial<StreakView> = {}): StreakView => ({ current: 0, best: 0, freezes: 0, atRisk: false, covers: 0, lost: false, todayDone: false, toFreeze: 7, ...patch });

const goalsView = (patch: Partial<GoalsView> = {}): GoalsView => ({
  day: 20_000,
  startMs: 0,
  endMs: 86_400_000,
  serverMs: 1000,
  goals: [
    { id: 'trade_3', icon: '🛒', title: 'Make 3 trades', hint: 'h', target: 3, progress: 1, done: false, reward: GOAL_REWARD },
    { id: 'lesson_1', icon: '📚', title: 'Finish a lesson', hint: 'h', target: 1, progress: 1, done: true, reward: GOAL_REWARD },
    { id: 'win_1', icon: '🏅', title: 'Win a 1v1 match', hint: 'h', target: 1, progress: 0, done: false, reward: GOAL_REWARD },
  ],
  bonus: { reward: GOAL_REWARD, paid: false },
  streak: streak(),
  milestones: [
    { days: 3, rarity: 1, rarityName: 'Common', state: 'ready', item: null, choices: ['c_sky'] },
    { days: 7, rarity: 2, rarityName: 'Rare', state: 'locked', item: null, choices: [] },
  ],
  ...patch,
});

describe('the words of the Goals page', () => {
  it('GOALUI-1: money, percent and time read the same everywhere', () => {
    expect(signedCents(1250)).toBe('+$12.50');
    expect(signedCents(-350)).toBe('−$3.50');
    expect(signedCents(0)).toBe('$0.00');
    expect(signedPercent(4.5)).toBe('+4.50%');
    expect(signedPercent(-12.3)).toBe('−12.30%');
    expect(signedPercent(0)).toBe('0.00%');
    expect(awayText(35 * 60_000)).toBe('35 minutes');
    expect(awayText(60_000)).toBe('1 minute');
    expect(awayText(200 * 60_000)).toBe('3 h 20 min');
    expect(awayText(28 * 3_600_000)).toBe('1 day 4 h');
    expect(awayText(76 * 3_600_000)).toBe('3 days 4 h');
    expect(longUntil(5 * 3_600_000, 0)).toBe('in 5 h 00 min');
    expect(longUntil(40 * 60_000, 0)).toBe('in 40 min');
    expect(longUntil(3 * 86_400_000 + 4 * 3_600_000, 0)).toBe('in 3 days 4 h');
    expect(barPercent(1, 3)).toBe(33);
    expect(barPercent(5, 3)).toBe(100);
    expect(barPercent(-1, 3)).toBe(0);
    expect(barPercent(1, 0)).toBe(0);
  });

  it('GOALUI-2: the number on the Goals tab counts goals still open plus free looks waiting; nothing before the answer arrives', () => {
    expect(goalsWaiting(null)).toBe(0);
    expect(goalsWaiting(goalsView())).toBe(2 + 1); // trade_3 and win_1 are open; the 3-day look is ready
    const finished = goalsView({ goals: goalsView().goals.map((g) => ({ ...g, done: true, progress: g.target })), milestones: [] });
    expect(goalsWaiting(finished)).toBe(0);
  });

  it('GOALUI-3: the streak sentence says what to do in every state', () => {
    expect(streakNote(streak())).toBe('Finish one goal today to start a streak.');
    expect(streakNote(streak({ best: 5, lost: true }))).toContain('Your 5-day streak ended');
    expect(streakNote(streak({ current: 1, todayDone: true }))).toContain('Streak started');
    expect(streakNote(streak({ current: 4, todayDone: true }))).toBe('4 days in a row. Come back tomorrow to make it 5.');
    expect(streakNote(streak({ current: 4, atRisk: true }))).toBe('Finish one goal today to keep your 4-day streak.');
    expect(streakNote(streak({ current: 8, atRisk: true, covers: 1, freezes: 1 }))).toContain('A freeze will cover it');
    expect(streakNote(streak({ current: 8, atRisk: true, covers: 2, freezes: 2 }))).toContain('You missed 2 days');
  });

  it('GOALUI-4: the pop-up for a paid goal names the goals, what was paid, the streak, and a waiting free look', () => {
    expect(goalNotice({ finished: [], bonus: false, reward: GOAL_REWARD, milestones: [], streak: 1 })).toBeNull();
    const one = goalNotice({ finished: ['lesson_1'], bonus: false, reward: GOAL_REWARD, milestones: [], streak: 1 });
    expect(one).toMatchObject({ tone: 'good', title: 'Goal done' });
    expect(one?.text).toContain('Finish a lesson');
    expect(one?.text).toContain('+$10 · 10 XP · $5 1v1 coins');
    expect(one?.text).toContain('Streak: 1 day.');
    const all = goalNotice({ finished: ['trade_3', 'lesson_1', 'win_1'], bonus: true, reward: { xp: 40, cashCents: 4000, coinCents: 2000 }, milestones: [3], streak: 3 });
    expect(all?.title).toBe('All 3 goals done!');
    expect(all?.text).toContain('A free look is waiting for you in Goals.');
    expect(goalNotice({ finished: ['lesson_1', 'win_1'], bonus: false, reward: GOAL_REWARD, milestones: [], streak: 2 })?.title).toBe('2 goals done');
  });

  it('GOALUI-5: every kind of look has a name, and a look is named by the catalog', () => {
    for (const s of [...SLOTS, ...GEAR_SLOTS]) expect(kindName(s.id).length).toBeGreaterThan(3);
    expect(lookName('c_sky')).toBe('Sky Blue');
    expect(lookName(null)).toBe('a look');
    expect(lookName('nothing')).toBe('a look');
  });
});

describe('the words of the "while you were away" card', () => {
  const report = (patch: Partial<AwayReport> = {}): AwayReport => ({ seenMs: 0, nowMs: 3_600_000, awayMs: 3_600_000, netWorth: null, rank: null, mover: null, companies: [], ...patch });

  it('GOALUI-6: it says how the net worth moved, how the place moved and which holding moved most; a short position is told as a short', () => {
    const lines = awayLines(
      report({
        netWorth: { beforeCents: 100_000, nowCents: 105_000, changeCents: 5_000, changePct: 5 },
        rank: { before: 5, now: 2 },
        mover: { ticker: 'QLRX', name: 'Qualrex', changePct: -12.3, changeCents: -4_500, short: false },
      }),
    );
    expect(lines.map((l) => [l.key, l.tone])).toEqual([
      ['worth', 'pos'],
      ['rank', 'pos'],
      ['mover', 'neg'],
    ]);
    expect(lines[0]?.text).toBe('Your net worth went up $50.00 (+5.00%), to $1,050.00.');
    expect(lines[1]?.text).toBe('You climbed 3 places on the leaderboard: number 5 → number 2.');
    expect(lines[2]?.text).toContain('QLRX moved your account the most: lost $45.00 (the price went down 12.30%).');
    const short = awayLines(report({ mover: { ticker: 'QLRX', name: 'Qualrex', changePct: 30, changeCents: 6_000, short: true } }));
    expect(short[0]?.text).toContain('your short gained $60.00 (the price went down 30.00%)');
    const same = awayLines(report({ netWorth: { beforeCents: 100_000, nowCents: 100_000, changeCents: 0, changePct: 0 }, rank: { before: 3, now: 3 } }));
    expect(same.map((l) => l.text)).toEqual(['Your net worth stayed at $1,000.00.', 'You are still number 3 on the leaderboard.']);
    const dropped = awayLines(report({ rank: { before: 1, now: 2 } }));
    expect(dropped[0]?.text).toBe('You dropped 1 place on the leaderboard: number 1 → number 2.');
    expect(awayLines(report())).toEqual([]);
  });

  it('GOALUI-7: his own companies are told with the price move and the new investors', () => {
    const lines = awayCompanyLines(
      report({
        companies: [
          { ticker: 'AAA', name: 'Alpha', changePct: 5.5, newInvestors: 2 },
          { ticker: 'BBB', name: 'Beta', changePct: -1.25, newInvestors: 0 },
          { ticker: 'CCC', name: 'Gamma', changePct: null, newInvestors: 1 },
        ],
      }),
    );
    expect(lines.map((l) => l.text)).toEqual(['AAA (Alpha): price +5.50%, 2 new investors', 'BBB (Beta): price −1.25%', 'CCC (Gamma): 1 new investor']);
    expect(lines.map((l) => l.tone)).toEqual(['pos', 'neg', '']);
  });
});

describe('the words of the ranked screens', () => {
  it('GOALUI-8: points moved, the tier, the tier reached, why a match is not ranked, and what the lobby says', () => {
    expect(pointsChangeText(100, 125)).toBe('+25 points');
    expect(pointsChangeText(125, 105)).toBe('−20 points');
    expect(pointsChangeText(100, 101)).toBe('+1 point');
    expect(pointsChangeText(100, 100)).toBe('No points moved');
    expect(tierLabel(100)).toBe('🥉 Bronze');
    expect(tierLabel(650)).toBe('💠 Platinum');
    expect(tierReached(190, 215)).toBe('Silver');
    expect(tierReached(215, 190)).toBeNull(); // a fall inside a season is stopped by the floor, and a fall is never "reached"
    expect(tierReached(100, 125)).toBeNull();
    const base = { ranked: true, friendMatch: false, playerCount: 2, players: [{ bot: false, you: true }, { bot: false, you: false }] };
    expect(notRankedReason(base as never)).toBeNull();
    expect(notRankedReason({ ...base, ranked: false, friendMatch: true } as never)).toBe('a match against a friend');
    expect(notRankedReason({ ...base, ranked: false, players: [{ bot: false, you: true }, { bot: true, you: false }] } as never)).toBe('a match against a computer player');
    expect(rankedTag({ ...base, playerCount: 1 } as never)).toContain('if a real player joins you');
    expect(rankedTag(base as never)).toBe('Ranked: points are at stake');
    expect(rankedTag({ ...base, ranked: false, friendMatch: true } as never)).toBe('Not ranked: a match against a friend never moves points');
    expect(nextTierText({ points: 125, next: { name: 'Silver', floor: 200 } })).toBe('75 more points for Silver');
    expect(nextTierText({ points: 199, next: { name: 'Silver', floor: 200 } })).toBe('1 more point for Silver');
    expect(nextTierText({ points: 950, next: null })).toBe('You are in the top tier.');
  });
});

describe('the screens only ask and show', () => {
  it('GOALUI-9: the Goals page asks the server (never decides), takes a look only after a second press, and has no clock or random of its own', () => {
    const screen = code('shared/GoalsScreen.tsx');
    expect(screen).toMatch(/api\.claimGoal\(milestone\.days, id\)/);
    expect(screen).toContain('useGoals()');
    expect(screen).toMatch(/Confirm/);
    expect(screen).toMatch(/data-testid=\{`goal-confirm-\$\{def\.id\}`\}/);
    expect(screen).not.toMatch(/localStorage|sessionStorage|Math\.random|Date\.now/);
    const store = code('shared/goalsStore.ts');
    expect(store).toMatch(/api\.goals\(\)/);
    expect(store).toMatch(/view\.serverMs - Date\.now\(\)/); // the server's clock decides when the day changes
    expect(store).not.toMatch(/localStorage|sessionStorage|Math\.random/);
    const away = code('shared/awayStore.ts');
    expect(away).toMatch(/api\.away\(\)/);
    expect(away).toMatch(/api\.dismissAway\(\)/);
    expect(away).not.toMatch(/localStorage|sessionStorage|Math\.random/);
    const ranked = code('shared/RankedCard.tsx');
    expect(ranked).toMatch(/api\s*\.ranked\(\)/);
    expect(ranked).not.toMatch(/localStorage|sessionStorage|Math\.random/);
  });

  it('GOALUI-10: the live stream, sign-in and sign-out keep the goals and the away card up to date', () => {
    const store = code('shared/store.ts');
    expect(store).toMatch(/addEventListener\('goals'/);
    expect(store).toMatch(/private onGoals\(d: GoalsEvent\)/);
    expect(store).toMatch(/goalNotice\(d\)/);
    expect((store.match(/goalsStore\.load\(\)/g) ?? []).length).toBeGreaterThanOrEqual(3); // hello, sign-in, a paid goal
    expect((store.match(/awayStore\.load\(\)/g) ?? []).length).toBeGreaterThanOrEqual(2); // hello, sign-in
    expect((store.match(/goalsStore\.clear\(\)/g) ?? []).length).toBe(2); // sign-out and a session that ended
    expect((store.match(/awayStore\.clear\(\)/g) ?? []).length).toBe(2);
    const api = code('shared/api.ts');
    for (const path of ['/api/ranked', '/api/goals', '/api/goals/claim', '/api/away', '/api/away/dismiss']) expect(api).toContain(`'${path}'`);
  });

  it('GOALUI-11: the app shows a Goals tab with a number, the away card, and 1v1 shows the tier and the points of each match', () => {
    const app = code('shared/SharedApp.tsx');
    expect(app).toMatch(/\['goals', 'Goals'\]/);
    expect(app).toMatch(/careerTab === 'goals' && <GoalsScreen \/>/);
    expect(app).toMatch(/<AwayCard onGoals=\{goGoals\} \/>/);
    expect(app).toMatch(/data-testid="goals-badge"/);
    const lobby = code('shared/LobbyScreen.tsx');
    expect(lobby).toMatch(/<RankedCard version=\{finishedId\} \/>/);
    expect((lobby.match(/rankedTag\(match\)/g) ?? []).length).toBe(3); // waiting, opponent found, countdown
    expect(lobby).toMatch(/pointsChangeText\(h\.you\.rankBefore, h\.you\.rankAfter\)/);
    const match = code('shared/MatchScreen.tsx');
    expect(match).toMatch(/<RankedResult match=\{match\} \/>/);
    expect(match).toMatch(/me\.rank\.note === 'limit'/);
  });

  it('GOALUI-12: every class the new screens use is styled, and every animation sits in a block for people who did not ask for less motion', () => {
    const used = new Set<string>();
    for (const file of ['GoalsScreen.tsx', 'AwayCard.tsx', 'RankedCard.tsx']) {
      const text = read('shared', file);
      for (const m of text.matchAll(/className=(?:"([^"]+)"|'([^']+)')/g)) for (const c of ((m[1] ?? m[2]) as string).split(/\s+/)) used.add(c);
      for (const m of text.matchAll(/className=\{`([^`]+)`\}/g)) for (const c of (m[1] as string).replace(/\$\{[^}]*\}/g, ' ').split(/\s+/)) if (c) used.add(c);
    }
    const mine = [...used].filter((c) => /^(goal|streak|freeze|milestone|away|rank|ladder|tier)/.test(c));
    expect(mine.length).toBeGreaterThan(15);
    for (const c of mine) expect(ownCss.includes(`.${c}`) || css.includes(`.${c}`), c).toBe(true);
    // Animations are only in the no-preference block of this part.
    const outside = ownCss.slice(0, ownCss.indexOf('@media (prefers-reduced-motion: no-preference)'));
    expect(outside).not.toMatch(/animation\s*:|transition\s*:|@keyframes/);
    expect(ownCss).not.toMatch(/text-shadow/);
    // Phone widths: the rows fold.
    expect(ownCss).toMatch(/@media \(max-width: 600px\)[\s\S]*\.goal-row/);
  });
});
