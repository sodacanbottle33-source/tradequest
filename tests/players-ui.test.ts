// The Players screen (leaderboard, friends, find players): the words it shows, and source-level checks (like admin-ui.test.ts) that it
// only asks the server, never ranks or filters players itself, and shows nothing about another player but a name and a net worth.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { problemText, relationLabel, shownText, standingText } from '../src/shared/playersUtil';

const src = (...parts: string[]): string => resolve(process.cwd(), 'src', ...parts);

function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('Players screen', () => {
  it('PLUI-1: the button of a player says what can be done: add, wait, accept, or that you are friends already', () => {
    expect(relationLabel('none')).toBe('Add friend');
    expect(relationLabel('outgoing')).toBe('Request sent');
    expect(relationLabel('incoming')).toBe('Wants to be friends');
    expect(relationLabel('friend')).toBe('Friends');
    expect(relationLabel('you')).toBe('You');
  });

  it('PLUI-2: the line above the board says where you stand: in the top, outside it, the owner, and among friends', () => {
    expect(standingText({ rank: 2, netWorthCents: 5, inTop: true }, 412, 'all', 100, false)).toBe('You are #2 of 412 players.');
    expect(standingText({ rank: 1234, netWorthCents: 5, inTop: false }, 2000, 'all', 100, false)).toBe('You are #1,234 of 2,000 players, outside the top 100.');
    expect(standingText(null, 50, 'all', 100, true)).toMatch(/owner.*not ranked/);
    expect(standingText(null, 0, 'all', 100, false)).toBe('Nobody is ranked yet.');
    expect(standingText({ rank: 3, netWorthCents: 5, inTop: true }, 4, 'friends', 100, false)).toBe('You are #3 of 4 (you and your friends).');
    expect(standingText({ rank: 1, netWorthCents: 5, inTop: true }, 1, 'friends', 100, false)).toMatch(/only one here/);
    expect(standingText({ rank: 1, netWorthCents: 5, inTop: true }, 3, 'friends', 100, false)).toBe('You are first among you and your friends (3 in all).');
  });

  it('PLUI-3: how many are shown, and what a failed request says', () => {
    expect(shownText(100, 412)).toBe('Top 100 of 412');
    expect(shownText(3, 3)).toBe('3 players');
    expect(shownText(1, 1)).toBe('1 player');
    expect(problemText(new Error('Too many friend requests too quickly. Wait a moment.'))).toBe('Too many friend requests too quickly. Wait a moment.');
    expect(problemText('plain')).toBe('plain');
  });

  it('PLUI-4: Players is a Career tab (the top menu stays Career, 1v1 and News), with the number of waiting requests on it', () => {
    const shell = code(src('shared', 'SharedApp.tsx'));
    expect(shell).toMatch(/\['players', 'Players'\]/);
    expect(shell).toMatch(/careerTab === 'players' && <PlayersScreen/);
    expect(shell).toMatch(/s\.friends\?\.incoming\.length/);
    expect(shell).toMatch(/data-testid="players-badge"/);
    expect(code(src('ui', 'Header.tsx'))).not.toMatch(/Players|Friends|Leaderboard/);
  });

  it('PLUI-5: the screen only asks the server: it never ranks, sorts or filters players, and a signed-out visitor is shown the sign-in form', () => {
    const screen = code(src('shared', 'PlayersScreen.tsx'));
    expect(screen).toMatch(/api\.leaderboard\(scope\)/);
    expect(screen).toMatch(/api\.players\(/);
    expect(screen).toMatch(/api\.friendAction\(/);
    expect(screen).not.toMatch(/\.sort\(|\.toSorted\(|\.reverse\(|\.slice\(|Math\.random|localStorage|sessionStorage/);
    expect(screen).not.toMatch(/netWorthCents\s*[<>]|rank\s*[:=]\s*\d/); // no comparing or numbering of its own
    expect(screen).toMatch(/if \(!user\) return <AuthPanel/);
  });

  it('PLUI-6: a player is shown only as a name and a net worth: nothing about cash, holdings, trades or orders', () => {
    const screen = code(src('shared', 'PlayersScreen.tsx'));
    expect(screen).not.toMatch(/cashCents|positions|holdings?\b|walletCents|api\.account|api\.trades|api\.limitOrders/);
    const types = code(src('shared', 'types.ts'));
    // The players' own types: from Relation to the end of the friends types (what follows is challenges, chats, usernames and so on).
    const start = types.indexOf('export type Relation');
    const end = types.indexOf('export interface ChallengeEntry');
    expect(end).toBeGreaterThan(start);
    const block = types.slice(start, end);
    expect(block).toContain('export interface FriendsState');
    expect(block).not.toMatch(/cash|position|holding|trade/i);
  });

  it('PLUI-7: removing a friend asks first, and the live stream and the store keep the lists current', () => {
    const screen = code(src('shared', 'PlayersScreen.tsx'));
    expect(screen).toMatch(/Remove\?/);
    expect(screen).toMatch(/data-testid=\{`remove-yes-/);
    const store = code(src('shared', 'store.ts'));
    expect(store).toMatch(/addEventListener\('friends'/);
    expect(store).toMatch(/friends: null/);
    expect(store).toMatch(/setInterval\(\(\) => \{\s*void this\.refreshFriends\(\);[\s\S]*?\}, 30_000\)/);
    const api = code(src('shared', 'api.ts'));
    for (const path of ['/api/players', '/api/leaderboard', '/api/friends', '/api/friends/${what}']) expect(api).toContain(path);
  });
});
