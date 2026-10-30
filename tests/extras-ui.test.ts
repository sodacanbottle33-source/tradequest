// XUI-1 … XUI-12 — the rematch button, the trophy room, Teams, the daily prediction and market events (docs/world.md §35 to §39). The rules are the server's (tests/server-rematch.test.ts,
// server-teams, server-predict, server-events, server-looks). Here the page only has to say what the server says in plain words, keep its numbers in step, and style everything it draws.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { extrasStore, predictOpen } from '../src/shared/extrasStore';
import { earnedNotice, eventClock, lastGuessText, marketEventNotice, movesText, offerClock, pickName, placeText, predictedNotice, recordText, rematchState, rematchText, shortDay, teamScoreText, trophyFacts, trophyLines } from '../src/shared/extrasUtil';
import type { MarketEventLine, PredictView, TrophyRoom } from '../src/shared/types';

const src = (...parts: string[]): string => resolve(process.cwd(), 'src', ...parts);
const server = (...parts: string[]): string => resolve(process.cwd(), 'server', ...parts);

function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const css = readFileSync(src('styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

const reward = { xp: 10, cashCents: 1000, coinCents: 500 };

const predictView = (patch: Partial<PredictView> = {}): PredictView => ({
  day: 20_000,
  endMs: 2_000_000,
  serverMs: 1_000_000,
  company: { id: 3, ticker: 'ACME', name: 'Acme Corp', priceCents: 12_345 },
  mine: null,
  last: null,
  stats: { made: 0, correct: 0, run: 0, bestRun: 0 },
  reward,
  ...patch,
});

const trophyRoom = (patch: Partial<TrophyRoom> = {}): TrophyRoom => ({
  username: 'alice',
  displayName: 'Alice',
  ranked: { bestTier: null, seasons: [] },
  weekly: { podiums: [], firsts: 0 },
  goals: { finished: 0, perfectDays: 0, bestStreak: 0 },
  matches: { played: 0, wins: 0 },
  predictions: { made: 0, correct: 0, bestRun: 0 },
  lessons: 0,
  badges: { earned: 0, total: 64 },
  team: null,
  teamWins: [],
  count: 0,
  ...patch,
});

const line = (patch: Partial<MarketEventLine> = {}): MarketEventLine => ({
  day: 20_000,
  atMs: 0,
  kind: 'rally',
  name: 'Bull Rally',
  icon: '🐂',
  blurb: 'Stocks are going up.',
  status: 'done',
  moves: [
    { ticker: 'AAA', name: 'Aaa', pct: 2.5 },
    { ticker: 'BBB', name: 'Bbb', pct: -8.2 },
    { ticker: 'CCC', name: 'Ccc', pct: 5.1 },
  ],
  ...patch,
});

afterEach(() => extrasStore.clear());

describe('Rematch', () => {
  it('XUI-1: the button is only there for two minutes after a finished match; it says ask, waiting, or "they asked"', () => {
    const offer = (youAsked: boolean, theyAsked: boolean) => ({ phase: 'finished' as const, rematch: { youAsked, theyAsked, msLeft: 90_000 } });
    expect(rematchState(offer(false, false), 90_000)).toBe('ask');
    expect(rematchState(offer(true, false), 90_000)).toBe('waiting');
    expect(rematchState(offer(false, true), 90_000)).toBe('asked');
    expect(rematchState(offer(false, false), 0)).toBe('none');
    expect(rematchState(offer(false, false), -5)).toBe('none');
    expect(rematchState({ phase: 'live', rematch: { youAsked: false, theyAsked: false, msLeft: 90_000 } }, 90_000)).toBe('none');
    expect(rematchState({ phase: 'finished', rematch: null }, 90_000)).toBe('none');
  });

  it('XUI-2: the clock reads minutes and seconds and never goes below zero; the sentence says whether it is ranked', () => {
    expect(offerClock(120_000)).toBe('2:00');
    expect(offerClock(65_001)).toBe('1:06');
    expect(offerClock(9_000)).toBe('0:09');
    expect(offerClock(-500)).toBe('0:00');
    expect(rematchText('ask', 'Bob', true)).toMatch(/Bob.*ranked points/);
    expect(rematchText('ask', 'Bob', false)).toMatch(/Nothing changes your ranked points/);
    expect(rematchText('waiting', 'Bob', true)).toMatch(/Waiting for Bob/);
    expect(rematchText('asked', 'Bob', true)).toMatch(/Bob wants a rematch/);
    expect(rematchText('none', 'Bob', true)).toBe('');
  });
});

describe('Pop-ups', () => {
  it('XUI-3: a pop-up names the looks that were earned, and the result of a guess in plain words', () => {
    const one = earnedNotice({ reason: 'Diamond in the ranked season', items: [{ id: 'f_lg_diamond', name: 'x' }] });
    expect(one?.tone).toBe('good');
    expect(one?.title).toBe('New look earned');
    expect(one?.text).toContain('Diamond League Ring');
    expect(one?.text).toContain('Put it on in the Shop');
    const three = earnedNotice({ reason: 'Season champion', items: [{ id: 'f_season', name: 'a' }, { id: 't_season', name: 'b' }, { id: 'bn_season', name: 'c' }] });
    expect(three?.title).toBe('3 new looks earned');
    expect(three?.text).toContain('Put them on');
    expect(earnedNotice({ reason: 'x', items: [] })).toBeNull();

    const win = predictedNotice({ day: 1, ticker: 'ACME', pick: 'up', result: 'win', reward });
    expect(win.tone).toBe('good');
    expect(win.text).toContain('ACME ended higher');
    expect(win.text).toContain('+$10');
    const loss = predictedNotice({ day: 1, ticker: 'ACME', pick: 'down', result: 'loss', reward: null });
    expect(loss.tone).toBe('neutral');
    expect(loss.text).toContain('costs nothing');
    const draw = predictedNotice({ day: 1, ticker: 'ACME', pick: 'up', result: 'draw', reward: null });
    expect(draw.title).toBe('A draw');

    const ev = marketEventNotice({ kind: 'storm', name: 'Storm', icon: '⛈️', blurb: 'Wild day.', day: 1, count: 6 });
    expect(ev.title).toContain('Storm');
    expect(ev.text).toContain('Wild day.');
  });
});

describe('The daily prediction', () => {
  it('XUI-4: the words of the card: Higher or Lower, how yesterday went, and the record', () => {
    expect(pickName('up')).toBe('Higher');
    expect(pickName('down')).toBe('Lower');
    const last = { day: 1, ticker: 'ACME', name: 'Acme', pick: 'up' as const, result: 'win' as const, priceFromCents: 10_000, priceToCents: 10_500 };
    expect(lastGuessText(last)).toBe('You said ACME would end higher. It went from $100.00 to $105.00. Right!');
    expect(lastGuessText({ ...last, pick: 'down', result: 'loss' })).toContain('Not this time.');
    expect(lastGuessText({ ...last, result: 'draw', priceToCents: null })).toBe('You said ACME would end higher. A draw: nothing was paid.');
    expect(recordText({ made: 0, correct: 0, run: 0, bestRun: 0 })).toBe('No judged guesses yet.');
    expect(recordText({ made: 8, correct: 5, run: 2, bestRun: 3 })).toBe('5 right out of 8 (63%) · best run 3');
  });

  it('XUI-5: the Goals tab counts the prediction as one more thing to do only while the stock is there, no guess is made and the day is not over', () => {
    expect(predictOpen(predictView(), 1_500_000)).toBe(true);
    expect(predictOpen(null, 1_500_000)).toBe(false);
    expect(predictOpen(predictView({ company: null }), 1_500_000)).toBe(false);
    expect(predictOpen(predictView({ company: { id: 3, ticker: 'ACME', name: 'Acme', priceCents: null } }), 1_500_000)).toBe(false);
    expect(predictOpen(predictView({ mine: { pick: 'up', priceFromCents: 12_345, pickedMs: 1 } }), 1_500_000)).toBe(false);
    expect(predictOpen(predictView(), 2_000_000)).toBe(false);
  });

  it('XUI-6: the page keeps the difference between the server\'s clock and its own, and forgets everything when the player signs out', () => {
    const view = predictView({ serverMs: Date.now() + 5 * 60_000 });
    extrasStore.setPredict(view);
    const s = extrasStore.getSnapshot();
    expect(s.predict).toBe(view);
    expect(Math.abs(s.predictSkewMs - 5 * 60_000)).toBeLessThan(2000);
    const before = s.teamsVersion;
    extrasStore.onTeams();
    expect(extrasStore.getSnapshot().teamsVersion).toBe(before + 1);
    extrasStore.clear();
    expect(extrasStore.getSnapshot().predict).toBeNull();
    expect(extrasStore.getSnapshot().teamsVersion).toBe(0);
  });
});

describe('Market events and the trophy room', () => {
  it('XUI-7: an event time is shown in Tokyo time; the biggest moves come first and the list is cut', () => {
    expect(eventClock(Date.UTC(2026, 9, 1, 12, 0, 0))).toBe('21:00');
    expect(eventClock(Date.UTC(2026, 9, 1, 15, 5, 0))).toBe('00:05');
    expect(movesText(line())).toBe('−8.20% BBB · +5.10% CCC · +2.50% AAA');
    expect(movesText(line(), 2)).toBe('−8.20% BBB · +5.10% CCC');
    expect(movesText(line({ moves: [] }))).toBe('');
  });

  it('XUI-8: places read 1st 2nd 3rd 11th 22nd; the trophy room lists only what the player has, best things first; the facts are always the same six', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(placeText)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '101st', '111th']);
    expect(shortDay(Date.UTC(2026, 9, 5))).toBe('5 Oct');
    expect(trophyLines(trophyRoom())).toEqual([]);
    expect(trophyLines(trophyRoom({ ranked: { bestTier: { id: 'bronze', name: 'Bronze', icon: '🥉' }, seasons: [] } }))).toEqual([]);
    const full = trophyLines(
      trophyRoom({
        ranked: { bestTier: { id: 'gold', name: 'Gold', icon: '🥇' }, seasons: [{ seasonMs: Date.UTC(2026, 9, 5), place: 1, points: 900 }, { seasonMs: Date.UTC(2026, 8, 5), place: 7, points: 300 }] },
        weekly: { podiums: [{ weekStartMs: Date.UTC(2026, 9, 12), place: 2, gainPct: 12.5 }], firsts: 0 },
        teamWins: [{ weekStartMs: Date.UTC(2026, 9, 12), place: 1, teamName: 'Bulls', teamTag: 'BUL' }],
      }),
    );
    expect(full.map((l) => l.key)).toEqual(['tier', `season-${Date.UTC(2026, 9, 5)}`, `week-${Date.UTC(2026, 9, 12)}`, `team-${Date.UTC(2026, 9, 12)}`]);
    expect(full[0]?.text).toBe('Reached Gold in ranked 1v1');
    expect(full[1]?.text).toBe('1st in the ranked season of 5 Oct');
    expect(full[2]?.text).toContain('2nd on the weekly board');
    expect(full[3]?.text).toContain('Bulls [BUL]');
    const facts = trophyFacts(trophyRoom({ matches: { played: 4, wins: 3 }, goals: { finished: 20, perfectDays: 2, bestStreak: 1 }, predictions: { made: 5, correct: 4, bestRun: 3 }, badges: { earned: 7, total: 64 } }));
    expect(facts.map((f) => f.key)).toEqual(['matches', 'goals', 'streak', 'predict', 'lessons', 'badges']);
    expect(facts[0]?.value).toBe('3 of 4 (75%)');
    expect(facts[2]?.value).toBe('1 day');
    expect(facts[3]?.value).toBe('4 of 5 right · best run 3');
    expect(facts[5]?.value).toBe('7 of 64');
    expect(trophyFacts(trophyRoom())[0]?.value).toBe('0 of 0 (—)');
  });

  it('XUI-9: a team without a score says how many players it still needs on the weekly board', () => {
    expect(teamScoreText(4.2, 3, 3)).toBe('+4.20%');
    expect(teamScoreText(-1.5, 3, 3)).toBe('−1.50%');
    expect(teamScoreText(null, 1, 3)).toBe('needs 2 more players on the weekly board');
    expect(teamScoreText(null, 2, 3)).toBe('needs 1 more player on the weekly board');
    expect(teamScoreText(null, 3, 3)).toBe('—');
  });
});

describe('The screens', () => {
  it('XUI-10: every address the page asks is an address the server has, and the live stream events the page listens to are the ones the server sends', () => {
    const api = code(src('shared', 'api.ts'));
    const routes = ['teams', 'predict', 'trophies', 'lobby'].map((n) => code(server('routes', `${n}.ts`))).join('\n');
    const asked = [...api.matchAll(/request<[^>]*(?:<[^>]*>)?[^>]*>\('(GET|POST)', [`'](\/api\/(?:teams|predict|events|trophies|lobby\/rematch)[^`'?]*)/g)].map((m) => ({ verb: (m[1] as string).toLowerCase(), path: (m[2] as string).replace(/\$\{[^}]*\}/g, ':username') }));
    expect(asked.length).toBeGreaterThanOrEqual(14);
    for (const a of asked) expect(routes, `${a.verb} ${a.path}`).toContain(`router.${a.verb}('${a.path}'`);
    const store = code(src('shared', 'store.ts'));
    for (const ev of ['earned', 'predicted', 'marketevent', 'teams']) expect(store, ev).toContain(`addEventListener('${ev}'`);
    const sent = ['predict.ts', 'events.ts', 'ranked.ts', 'teams.ts'].map((f) => code(server(f))).join('\n');
    for (const ev of ['earned', 'predicted', 'marketevent', 'teams']) expect(sent, ev).toContain(`'${ev}'`);
  });

  it('XUI-11: Teams is a tab right after Players; leaving, ending and removing ask twice; the page never works out a score or a place itself; the Goals page and Market page show their new cards', () => {
    const app = code(src('shared', 'SharedApp.tsx'));
    expect(app).toMatch(/\['players', 'Players'\],\s*\['teams', 'Teams'\]/);
    expect(app).toContain("careerTab === 'teams' && <TeamsScreen />");
    expect(app).toContain('<EventsStrip onOpen={openCompany} />');
    expect(app).toContain('predictOpen(predictView, predictNow)');
    expect(code(src('shared', 'GoalsScreen.tsx'))).toContain('<PredictCard />');
    const teams = code(src('shared', 'TeamsScreen.tsx'));
    for (const id of ['team-leave-confirm', 'team-disband-confirm', 'team-kick-confirm-']) expect(teams, id).toContain(id);
    expect(teams).toContain("setConfirming('leave')");
    expect(teams).toContain("setConfirming('disband')");
    expect(teams).not.toMatch(/Math\.random|localStorage|sessionStorage|\.sort\(|\.reduce\(/);
    const predict = code(src('shared', 'PredictCard.tsx'));
    expect(predict).toMatch(/api\.predictPick\(pick\)/);
    expect(predict).not.toMatch(/Math\.random|localStorage|sessionStorage|Date\.now\(\)\s*[<>]/);
    // Every guess carries only the word up or down: the stock, the price and the day come from the server.
    expect(predict).not.toMatch(/ticker:|priceCents:/);
    const events = code(src('shared', 'EventsStrip.tsx'));
    expect(events).not.toMatch(/Math\.random|localStorage|sessionStorage/);
    const match = code(src('shared', 'MatchScreen.tsx'));
    expect(match).toMatch(/api\.rematch\(match\.id\)/);
    expect(match).toMatch(/<RankedResult match=\{match\} \/>\}\s*\{match\.phase === 'finished' && <RematchOffer/);
  });

  it('XUI-12: every class the new screens use has a CSS rule, the lists and the cards fold on a phone, and the sign-out clears everything', () => {
    const used = new Set<string>();
    for (const file of ['TeamsScreen.tsx', 'EventsStrip.tsx', 'PredictCard.tsx']) {
      const text = code(src('shared', file));
      for (const m of text.matchAll(/className=(?:"([^"]+)"|'([^']+)')/g)) for (const c of ((m[1] ?? m[2]) as string).split(/\s+/)) used.add(c);
      for (const m of text.matchAll(/className=\{`([^`]+)`\}/g)) for (const c of (m[1] as string).replace(/\$\{[^}]*\}/g, ' ').split(/\s+/)) if (c) used.add(c);
    }
    const match = code(src('shared', 'MatchScreen.tsx'));
    const rematchPart = match.slice(match.indexOf('function RematchOffer'), match.indexOf('function RankedResult'));
    for (const m of rematchPart.matchAll(/className="([^"]+)"/g)) for (const c of (m[1] as string).split(/\s+/)) used.add(c);
    const mine = [...used].filter((c) => /^(team|teams|predict|event|events|rematch)/.test(c));
    expect(mine.length).toBeGreaterThan(30);
    for (const c of mine) expect(css, c).toContain(`.${c}`);
    for (const c of ['is-win', 'is-loss', 'is-draw', 'is-live', 'is-mine']) expect(css, c).toContain(`.${c}`);
    expect(css).toMatch(/@media \(max-width: 600px\)[\s\S]*\.team-form input/);
    const store = code(src('shared', 'store.ts'));
    expect((store.match(/extrasStore\.clear\(\)/g) ?? []).length).toBe(2);
  });
});
