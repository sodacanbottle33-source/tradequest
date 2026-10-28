// More badges and more animations (docs/world.md §28). The badge show, the marks in the market list and the other small effects only LOOK: they never
// place an order, give a badge or change a number. So these checks are about the rules of what plays (which show for which badge, which mark for which
// company), that the same input always looks the same, and that every effect is wired in, stays out of the way (never blocks a click) and switches off
// for a person who asked their device for reduced motion.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BADGES } from '../src/shared/badgeCatalog';
import { MAX_PER_BATCH, MAX_WAITING, onBadgeShow, playBadgeShow, showOf, showsOf, sparklesFor, type BadgeShow } from '../src/shared/badgeShow';
import { CROWN_MIN_BPS, HOT_BPS_COIN, HOT_BPS_STOCK, MOOD_ICON, MOOD_TEXT, moodOf, type MoodInput } from '../src/shared/marketMood';
import { SharedStore } from '../src/shared/store';

const src = (...parts: string[]): string => resolve(process.cwd(), 'src', ...parts);
const read = (...parts: string[]): string => readFileSync(src(...parts), 'utf8');
function code(file: string): string {
  return read(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}
const css = read('styles.css');

/** The text of the CSS block that starts at `marker` (its first line) up to the closing brace that ends it at the left edge. */
function block(from: string, marker: string): string {
  const start = from.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const end = from.indexOf('\n}\n', start);
  return from.slice(start, end + 3);
}

describe('the badge show', () => {
  it('FXM-1: bronze and silver are a small show, gold and diamond a big one; more sparkles and more time for a higher tier; a secret badge gets a few more sparkles', () => {
    const by = (tier: number, secret = false) => BADGES.find((b) => b.tier === tier && (b.secret === true) === secret) as (typeof BADGES)[number];
    const shows = [1, 2, 3, 4].map((t) => showOf(by(t).id) as BadgeShow);
    expect(shows.map((s) => s.big)).toEqual([false, false, true, true]);
    expect(shows.map((s) => s.sparkles)).toEqual([6, 10, 26, 48]);
    expect(shows.map((s) => s.ms)).toEqual([2800, 3200, 5000, 6000]);
    expect(shows.every((s) => s.secret === false)).toBe(true);
    const secrets = BADGES.filter((b) => b.secret === true);
    for (const b of secrets) {
      const s = showOf(b.id) as BadgeShow;
      expect(s.secret).toBe(true);
      expect(s.sparkles).toBe((showOf(by(b.tier).id) as BadgeShow).sparkles + 8);
      expect(s.name).toBe(b.name);
    }
    expect(showOf('made_up_badge')).toBeNull();
    // Every badge of the catalog has a show.
    for (const b of BADGES) expect(showOf(b.id)).not.toBeNull();
  });

  it('FXM-2: a batch plays the best badge first (by tier, then the catalog order), skips unknown ids, and the same badge always scatters the same way', () => {
    const batch = showsOf(['welcome', 'profit_100k', 'made_up', 'first_trade', 'home_run']);
    // Only the best two get a show (the pop-up lists them all); the best one in full, the second one as a quick small card.
    expect(MAX_PER_BATCH).toBe(2);
    expect(batch.map((s) => s.id)).toEqual(['profit_100k', 'home_run']);
    expect(batch[0]).toMatchObject({ big: true, sparkles: 48, ms: 6000 });
    expect(batch[1]).toMatchObject({ big: false, sparkles: 10, ms: 2800, tier: 3 });
    expect(showsOf(['welcome', 'first_trade']).map((s) => [s.id, s.big, s.ms])).toEqual([['first_trade', false, 2800], ['welcome', false, 2800]]);
    expect(showsOf(['first_trade'])).toHaveLength(1);
    expect(showsOf(['nothing', 'else'])).toEqual([]);
    expect(MAX_WAITING).toBe(3);
    const a = sparklesFor(1234, 26, true);
    expect(sparklesFor(1234, 26, true)).toEqual(a);
    expect(sparklesFor(1235, 26, true)).not.toEqual(a);
    expect(a).toHaveLength(26);
    expect(sparklesFor(1, 0, false)).toEqual([]);
    for (const [big, count] of [[true, 48], [false, 6]] as const) {
      for (const p of sparklesFor(99, count, big)) {
        const reach = Math.hypot(p.dx, p.dy + (big ? 20 : 8));
        expect(reach).toBeLessThanOrEqual(big ? 192 : 76);
        expect(reach).toBeGreaterThanOrEqual(big ? 68 : 32);
        expect(p.size).toBeGreaterThanOrEqual(big ? 7 : 4);
        expect(p.size).toBeLessThanOrEqual(big ? 16 : 8);
        expect(p.delay).toBeLessThanOrEqual(big ? 700 : 350);
        expect(p.time).toBeGreaterThanOrEqual(700);
        expect(p.time).toBeLessThanOrEqual(1400);
        expect([0, 1, 2]).toContain(p.shape);
        expect([0, 1, 2]).toContain(p.tone);
      }
    }
    // A show for the same badge on a later day (another counter) still has the same look when asked with the same counter.
    expect(showOf('home_run', 5)?.seed).toBe(showOf('home_run', 5)?.seed);
    expect(showOf('home_run', 5)?.seed).not.toBe(showOf('home_run', 6)?.seed);
  });

  it('FXM-3: the server telling the page about new badges plays the show once for the known ones; nobody listening is fine; unknown ids play nothing', () => {
    const heard: (readonly BadgeShow[])[] = [];
    const stop = onBadgeShow((shows) => heard.push(shows));
    playBadgeShow(['first_trade', 'profit_100k', 'nope']);
    expect(heard).toHaveLength(1);
    expect(heard[0]?.map((s) => s.id)).toEqual(['profit_100k', 'first_trade']);
    playBadgeShow(['nope']);
    expect(heard).toHaveLength(1);
    // Through the store: the same ids the pop-up names.
    const store = new SharedStore() as unknown as { onBadges(d: { earned: string[] }): void };
    store.onBadges({ earned: ['week_one', 'made_up'] });
    expect(heard).toHaveLength(2);
    expect(heard[1]?.map((s) => s.id)).toEqual(['week_one']);
    stop();
    playBadgeShow(['first_trade']);
    expect(heard).toHaveLength(2);
    // With no listener at all, nothing breaks.
    expect(() => playBadgeShow(['first_trade'])).not.toThrow();
  });

  it('FXM-4: the layer is mounted once, plays one show at a time with a short line behind it, never changes state inside a state updater, and the page never decides anything', () => {
    const app = code('shared/SharedApp.tsx');
    expect(app.match(/<BadgeUnlockLayer \/>/g)).toHaveLength(1);
    expect(app).toMatch(/import \{ BadgeUnlockLayer \} from '\.\/BadgeUnlock'/);
    const layer = code('shared/BadgeUnlock.tsx');
    expect(layer).toContain('onBadgeShow(');
    expect(layer).toContain('MAX_WAITING');
    expect(layer).toContain('createPortal');
    expect(layer).toContain('role="status"');
    expect(layer).not.toMatch(/Math\.random|localStorage|sessionStorage|fetch\(|api\./);
    // The queue is changed in the listener and the timer, never inside setPlaying((cur) => ...), which a page may run twice.
    expect(layer).not.toMatch(/setPlaying\(\s*\(/);
    const store = code('shared/store.ts');
    expect(store).toMatch(/playBadgeShow\(named\.map\(\(b\) => b\.id\)\)/);
  });
});

describe('the marks in the market list', () => {
  const base: MoodInput = { live: true, coins: false, halted: false, bankrupt: false, changeBps: 0, price: 10_000, high24h: 12_000 };
  it('FXM-5: a flame from +10 % for a stock and +50 % for a coin, an ice cube from -10 % / -50 %, to the basis point', () => {
    expect(HOT_BPS_STOCK).toBe(1000);
    expect(HOT_BPS_COIN).toBe(5000);
    expect(moodOf({ ...base, changeBps: 999 })).toBeNull();
    expect(moodOf({ ...base, changeBps: 1000 })).toBe('hot');
    expect(moodOf({ ...base, changeBps: -999 })).toBeNull();
    expect(moodOf({ ...base, changeBps: -1000 })).toBe('cold');
    expect(moodOf({ ...base, coins: true, changeBps: 4999 })).toBeNull();
    expect(moodOf({ ...base, coins: true, changeBps: 5000 })).toBe('hot');
    expect(moodOf({ ...base, coins: true, changeBps: -4999 })).toBeNull();
    expect(moodOf({ ...base, coins: true, changeBps: -5000 })).toBe('cold');
    expect(moodOf({ ...base, changeBps: 30_000 })).toBe('hot');
  });

  it('FXM-6: a crown needs the price at its 24-hour high and at least +1 % on the day; it beats the flame; a company that has just listed is not crowned', () => {
    expect(CROWN_MIN_BPS).toBe(100);
    expect(moodOf({ ...base, changeBps: 100, price: 12_000 })).toBe('high');
    expect(moodOf({ ...base, changeBps: 100, price: 12_500 })).toBe('high'); // above the list's high: a fresh high
    expect(moodOf({ ...base, changeBps: 100, price: 11_999 })).toBeNull();
    expect(moodOf({ ...base, changeBps: 99, price: 12_000 })).toBeNull();
    expect(moodOf({ ...base, changeBps: 0, price: 10_000, high24h: 10_000 })).toBeNull(); // just listed: flat, price = high
    expect(moodOf({ ...base, changeBps: 2500, price: 12_000 })).toBe('high'); // crown beats the flame
    expect(moodOf({ ...base, changeBps: 2500, price: 11_000 })).toBe('hot');
    expect(moodOf({ ...base, changeBps: 500, price: 12_000, high24h: 0 })).toBeNull(); // no high known
  });

  it('FXM-7: no mark for a company that is halted, bankrupt, not live or without a price; every mark has an icon and words', () => {
    for (const bad of [{ halted: true }, { bankrupt: true }, { live: false }, { price: 0 }]) expect(moodOf({ ...base, changeBps: 3000, ...bad })).toBeNull();
    for (const m of ['high', 'hot', 'cold'] as const) {
      expect(Array.from(MOOD_ICON[m]).length).toBeGreaterThan(0);
      expect(MOOD_TEXT[m].length).toBeGreaterThan(5);
    }
    expect(new Set(Object.values(MOOD_ICON)).size).toBe(3);
  });

  it('FXM-8: the Market list draws the mark from the live price and the row (as a labelled picture), and gives the row a class for its soft glow', () => {
    const screen = code('shared/MarketScreen.tsx');
    expect(screen).toMatch(/moodOf\(\{ live, coins, halted: row\.halted, bankrupt: row\.bankrupt, changeBps, price, high24h: row\.high24h \}\)/);
    expect(screen).toMatch(/role="img" aria-label=\{MOOD_TEXT\[mood\]\}/);
    expect(screen).toMatch(/`row-\$\{mood\}`/);
    expect(screen).not.toMatch(/Math\.random/);
    for (const cls of ['.mood', 'tr.row-hot', 'tr.row-cold', 'tr.row-high']) expect(css).toContain(cls);
  });
});

describe('the other small effects', () => {
  it('FXM-9: the check mark is in the order answer (replayed for each new answer), the Buy / Sell button knows when it is busy, and cash counts to its new value like net worth', () => {
    const panel = code('shared/TradePanel.tsx');
    expect(panel).toMatch(/<p className="notice ok fill-ok" role="status" data-testid="order-result" key=\{result\}>\s*<FillCheck \/>\s*\{result\}/);
    expect(panel).toContain("${busy ? ' is-busy' : ''}");
    const check = code('shared/FillCheck.tsx');
    expect(check).toContain('aria-hidden="true"');
    const account = code('shared/AccountScreen.tsx');
    expect(account).toMatch(/const cashShown = useTween\(career\?\.cashCents \?\? 0, 450, user\?\.id \?\? ''\)/);
    expect(account).toContain('formatCents(Math.round(cashShown))');
    // The number the page shows when the animation ends is the server's number.
    expect(account).toContain('formatCents(Math.round(netShown))');
  });

  it('FXM-10: the shimmer shows under the "Loading" line (the line stays for screen readers) on the Market, Account, Badges, Leaderboard, Chat and Company screens', () => {
    const wired: [string, RegExp][] = [
      ['shared/MarketScreen.tsx', /Loading the \$\{coins \? 'coins' : 'companies'\}…[\s\S]{0,200}<Skeleton rows=\{5\} \/>/],
      ['shared/AccountScreen.tsx', /Loading your account…<\/p>\s*<Skeleton rows=\{3\} \/>/],
      ['shared/BadgesScreen.tsx', /Loading your badges…<\/p>\s*<Skeleton rows=\{4\} \/>/],
      ['shared/PlayersScreen.tsx', /Loading the leaderboard…<\/p>\s*<Skeleton rows=\{5\} \/>/],
      ['shared/ChatScreen.tsx', /Loading the chat…<\/p>\s*<Skeleton rows=\{4\} \/>/],
      ['shared/CompanyView.tsx', /Loading \{ticker\}…<\/p>\s*<Skeleton rows=\{4\} \/>/],
    ];
    for (const [file, re] of wired) {
      const text = code(file);
      expect(text).toMatch(re);
      expect(text).toMatch(/import \{ Skeleton \} from '\.\/Skeleton'/);
    }
    expect(code('shared/Skeleton.tsx')).toContain('aria-hidden="true"');
  });
});

describe('the styles of the effects', () => {
  const used = [
    'bs-card-in', 'bs-card-out', 'bs-big-in', 'bs-big-out', 'bs-pop', 'bs-ring', 'bs-spin', 'bs-q', 'bs-spark',
    'fc-draw', 'fill-glow', 'btn-spin', 'skeleton-shimmer', 'screen-in', 'mood-in', 'mood-flicker', 'row-breathe-up', 'row-breathe-down', 'row-breathe-gold',
  ];

  it('FXM-11: every animation the new styles use has its keyframes, and each keyframe is used', () => {
    for (const name of used) {
      expect(css).toMatch(new RegExp(`@keyframes ${name}\\b`));
      expect(css.replace(new RegExp(`@keyframes ${name}\\b`, 'g'), '')).toMatch(new RegExp(`animation:[^;]*\\b${name}\\b`));
    }
    expect(css).toMatch(/@keyframes vignette/); // the diamond tint reuses it
  });

  it('FXM-12: the badge show never blocks a click and sits above the page but not above the celebration; the big one is in the middle, the small one at the bottom', () => {
    const rule = css.slice(css.indexOf('.badge-show {'), css.indexOf('}', css.indexOf('.badge-show {')));
    expect(rule).toContain('position: fixed');
    expect(rule).toContain('pointer-events: none');
    expect(rule).toMatch(/z-index: 88/);
    expect(css).toMatch(/\.burst \{[^}]*z-index: 90/);
    expect(css).toMatch(/\.badge-show\.small \{\s*bottom: 18px/);
    expect(css).toMatch(/\.badge-show\.big \{[^}]*align-items: center/);
  });

  it('FXM-13: with reduced motion the badge show has no animation, rings, shine, tint, flip or sparkles; the other effects only exist for people who did not ask for less motion', () => {
    // The badge show's switches are in the same reduced-motion block as the price celebration's (the last one in the file; FX-12 reads it too).
    const marker = '@media (prefers-reduced-motion: reduce)';
    const reduce = block(css.slice(css.lastIndexOf(marker)), marker);
    expect(reduce).toContain('.burst-banner');
    for (const sel of ['.badge-show .bs-card', '.bs-pop', '.bs-ring', '.bs-shine', '.bs-glow', '.bs-qmark', '.bs-spark']) expect(reduce).toContain(sel);
    expect(reduce).toContain('animation: none !important');
    for (const sel of ['.bs-origin', '.bs-ring', '.bs-shine', '.bs-glow', '.bs-qmark']) expect(reduce.slice(reduce.indexOf('display: none') - 200, reduce.indexOf('display: none'))).toContain(sel);
    // Everything else lives in one block that is only for people who did not ask for reduced motion.
    const calm = css.slice(css.indexOf('Trade moments, loading shimmer, smooth screens and market marks'));
    const gentle = block(calm, '@media (prefers-reduced-motion: no-preference)');
    for (const name of ['fc-draw', 'fill-glow', 'btn-spin', 'skeleton-shimmer', 'screen-in', 'mood-in', 'row-breathe-up']) expect(gentle).toContain(`@keyframes ${name}`);
    // Outside that block the check mark, the spinner and the shimmer have no animation, and the ring of the check is fully drawn.
    const outside = calm.replace(gentle, '');
    expect(outside).not.toMatch(/animation:/);
    expect(outside).not.toMatch(/stroke-dashoffset/);
  });

  it('FXM-14: the screen fade skips the Account and Launch screens (they already rise in card by card) and the reduced-motion rule keeps text readable', () => {
    expect(css).toContain('.shared-main > :not(.account-layout):not(.launch-layout) { animation: screen-in');
    // The fade starts a little transparent but never hides a screen for good: the end state is fully visible.
    expect(css).toMatch(/@keyframes screen-in \{ from \{ opacity: 0; transform: translateY\(10px\); \} to \{ opacity: 1; transform: none; \} \}/);
  });
});
