// The menu of the game: Career, 1v1 and News — nothing else. These are source-level checks (like static.test.ts), so a later
// change cannot quietly bring back the old Practice / Classic menu, a speed button, or a short stock list in a 1v1 match.
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = (...parts: string[]): string => resolve(process.cwd(), 'src', ...parts);

function code(file: string): string {
  // Comments may mention old names; only real code and screen text count.
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

describe('Menu', () => {
  it('MENU-1: the header offers exactly Career, 1v1 and News, in that order (News is next to 1v1)', () => {
    const header = code(src('ui', 'Header.tsx'));
    const labels = [...header.matchAll(/label: '([^']+)'/g)].map((m) => m[1]);
    expect(labels).toEqual(['Career', '1v1', 'News']);
    expect(header).not.toMatch(/Practice|Classic|Shared market/);
  });

  it('MENU-2: the app opens on Career and does not load the old Practice or Classic modes', () => {
    const app = code(src('App.tsx'));
    expect(app).toMatch(/useState<Mode>\('career'\)/);
    expect(app).not.toMatch(/LiveApp|ClassicApp|useLiveMarket|useMarket/);
  });

  it('MENU-3: no screen of the game offers a playback speed or a way back to Practice / Classic rounds', () => {
    const dir = src('shared');
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))
      .filter((f) => /Practice|Classic rounds|Shared market|SPEEDS|playback/i.test(code(join(dir, f))));
    expect(offenders).toEqual([]);
  });

  it('MENU-4: News is its own place, and a 1v1 match shows every company through the same list and company page as Career', () => {
    const shell = code(src('shared', 'SharedApp.tsx'));
    expect(shell).toMatch(/mode === 'news' && <NewsScreen/);
    expect(shell).toMatch(/mode === 'battle' && <LobbyScreen/);
    const match = code(src('shared', 'MatchScreen.tsx'));
    expect(match).toMatch(/<MarketScreen/);
    expect(match).toMatch(/<CompanyView/);
    expect(match).not.toMatch(/\.slice\(0, *\d+\)/); // no "first 30 only" list
  });
});
