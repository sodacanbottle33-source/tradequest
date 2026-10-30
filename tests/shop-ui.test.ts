// SHOPUI-1 … SHOPUI-12 — the Shop screen, the profile card, names, titles and picture frames (docs/world.md §29).
// The rules are the server's (tests/server-shop.test.ts). Here the page only has to ask, show what the server says, keep its lists in step and draw every look.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BADGES } from '../src/shared/badgeCatalog';
import { COSMETICS, SLOTS, cleanLook, frameClass, isGearSlot, nameClasses, priceOf, priceText, titleOf } from '../src/shared/cosmeticCatalog';
import { profileStore } from '../src/shared/profileStore';
import { boughtText, joinedText, lockReason, rankText } from '../src/shared/shopUtil';
import { SharedStore } from '../src/shared/store';
import type { User } from '../src/shared/types';

const src = (...parts: string[]): string => resolve(process.cwd(), 'src', ...parts);

function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const def = (id: string) => {
  const d = COSMETICS.find((c) => c.id === id);
  if (!d) throw new Error(`no ${id}`);
  return d;
};

describe('The Shop screen', () => {
  it('SHOPUI-1: the Shop is a Career tab before My account; the page asks the server for the player\'s view and never decides who owns or wears what', () => {
    const app = code(src('shared', 'SharedApp.tsx'));
    expect(app).toMatch(/\['messages', 'Messages'\],\s*\['shop', 'Shop'\],\s*\['account', 'My account'\]/);
    expect(app).toMatch(/careerTab === 'shop' && <ShopScreen \/>/);
    const screen = code(src('shared', 'ShopScreen.tsx'));
    expect(screen).toMatch(/api\s*\.shop\(\)/);
    expect(screen).toMatch(/api\.buyItem\(def\.id\)/);
    expect(screen).toMatch(/api\.equipItem\(slot, item\)/);
    expect(screen).toMatch(/\[userId, badgesVersion\]/); // a badge earned while the Shop is open unlocks its things
    expect(screen).toContain('SLOTS.map');
    expect(screen).toContain('GEAR_SLOTS.map'); // the things for your own screen (candles, chart, win styles) are sections of the same page
    expect(screen).toMatch(/COSMETICS\.filter\(\(c\) => c\.slot === slotId\)/);
    expect(screen).toMatch(/if \(!user\) return <AuthPanel \/>/);
    expect(screen).not.toMatch(/localStorage|sessionStorage|Math\.random/);
    // The cash and what is owned come from the server's answer, never from a sum made on the page.
    expect(screen).not.toMatch(/cashCents\s*[-+]=|cashCents\s*-\s*priceOf/);
  });

  it('SHOPUI-2: buying asks twice (Buy, then Confirm with the price), a second click while one is running does nothing, and the money shown is the server\'s', () => {
    const screen = code(src('shared', 'ShopScreen.tsx'));
    expect(screen).toMatch(/onClick=\{\(\) => setConfirming\(def\.id\)\}/);
    expect(screen).toMatch(/Confirm \{priceText\(priceOf\(def\)\)\}/);
    expect(screen).toMatch(/if \(busy\) return;/);
    expect(screen).toMatch(/setView\(\{ cashCents: out\.cashCents, owned: out\.owned, equipped: out\.equipped, gear: out\.gear, badges: out\.badges \}\)/);
    expect(screen).toContain('void sharedStore.refreshAccount()'); // the money in the header and the rank move at once
    expect(screen).toMatch(/problemText\(e\)/); // the server's refusal is shown in words
    expect(screen).toMatch(/data-testid=\{`shop-buy-\$\{def\.id\}`\}/);
    expect(screen).toMatch(/data-testid=\{`shop-confirm-\$\{def\.id\}`\}/);
    expect(screen).toMatch(/data-testid=\{`shop-wear-\$\{def\.id\}`\}/);
    expect(screen).toMatch(/data-testid=\{`shop-off-\$\{def\.id\}`\}/);
  });

  it('SHOPUI-3: the words that say why a Buy cannot work: the badge a Legendary thing needs, or how much more cash is missing', () => {
    const cash = (cashCents: number, badges: string[] = []) => ({ cashCents, badges });
    // A Common colour costs $2,000.
    expect(lockReason(def('c_sky'), cash(200_000))).toBeNull();
    expect(lockReason(def('c_sky'), cash(150_000))).toBe('You need $500 more');
    expect(lockReason(def('c_sky'), cash(0))).toBe('You need $2,000 more');
    // A Legendary thing needing a badge: the badge is asked about first, by its name.
    const need = def('f_diamond');
    expect(need.requiresBadge).toBe('profit_100k');
    expect(lockReason(need, cash(99_999_999))).toMatch(/^Needs the ".+" badge$/);
    expect(lockReason(need, cash(1_000, ['profit_100k']))).toBe(`You need ${priceText(priceOf(need) - 1_000)} more`);
    expect(lockReason(need, cash(priceOf(need), ['profit_100k']))).toBeNull();
    expect(lockReason(need, cash(priceOf(need), ['welcome']))).toMatch(/^Needs the/);
    expect(boughtText('Sky Blue', 200_000)).toBe('You bought Sky Blue for $2,000, and it is on now. The money is gone, so your net worth went down by that much.');
  });

  it('SHOPUI-4: every kind has a section, every thing a card with its rarity and price, and the words say that it is looks only and that the money is gone', () => {
    expect(SLOTS.map((s) => s.id)).toEqual(['color', 'glow', 'frame', 'title']);
    const screen = code(src('shared', 'ShopScreen.tsx'));
    expect(screen).toMatch(/RARITY_NAMES\[def\.rarity\]/);
    expect(screen).toMatch(/Buy \{priceText\(priceOf\(def\)\)\}/);
    expect(screen).toMatch(/only for looks: they give no money and no help in trading/);
    expect(screen).toMatch(/gone for good/);
    expect(screen).toMatch(/<Skeleton rows=\{4\} \/>/); // while the server answers
  });
});

describe('Names, titles and picture frames', () => {
  it('SHOPUI-5: a name gets the classes of its colour and its glow, a frame its own class, a title its words; anything unknown draws nothing', () => {
    expect(nameClasses({ color: 'c_gold', glow: 'g_neon' })).toBe('cos-c_gold cos-g_neon');
    expect(nameClasses({ color: 'c_gold' })).toBe('cos-c_gold');
    expect(nameClasses(undefined)).toBe('');
    expect(nameClasses({ color: 'c_made_up', glow: 'f_gold' })).toBe(''); // unknown, or in the wrong place
    expect(frameClass({ frame: 'f_crown' })).toBe('cos-f_crown');
    expect(frameClass({ frame: 'c_gold' })).toBe('');
    expect(titleOf({ title: 't_oracle' })).toBe('The Oracle');
    expect(titleOf({ title: 'c_gold' })).toBeNull();
    expect(titleOf(null)).toBeNull();
    expect(cleanLook({ color: 'c_sky', frame: 'nope', title: 42 })).toEqual({ color: 'c_sky' });
  });

  it('SHOPUI-6: a click on a name opens his profile card; a player who wears nothing gets a plain bold name; the names in the lists all use it', () => {
    const name = code(src('shared', 'PlayerName.tsx'));
    expect(name).toMatch(/sharedStore\.openProfile\(username\)/);
    expect(name).toMatch(/<strong className=\{\['pname', classes, className\]\.filter\(Boolean\)\.join\(' '\)\}>\{name\}<\/strong>/);
    expect(name).toMatch(/if \(title === null\) return body;/);
    expect(name).toMatch(/data-testid=\{`title-\$\{username\}`\}/);
    for (const f of ['PlayersScreen.tsx', 'ChatScreen.tsx', 'PmThreadView.tsx', 'MessagesScreen.tsx']) {
      const text = code(src('shared', f));
      expect(text, f).toContain('<PlayerName');
      expect(text, f).toContain("from './PlayerName'");
    }
    // A conversation row is a button already: its name is not a second button inside it.
    expect(code(src('shared', 'MessagesScreen.tsx'))).toMatch(/<PlayerName[^>]*link=\{false\}/);
  });

  it('SHOPUI-7: a picture gets a frame only when its player wears one; with none it is exactly the picture, as before the Shop', () => {
    const avatar = code(src('shared', 'Avatar.tsx'));
    expect(avatar).toMatch(/const frame = frameClass\(looks\[username\]\)/);
    expect(avatar).toMatch(/if \(frame === ''\) return picture;/);
    expect(avatar).toMatch(/'--s': `\$\{size\}px`/);
    expect(avatar).toMatch(/data-testid=\{`frame-\$\{username\}`\}/);
  });

  it('SHOPUI-8: the page keeps one list of what everybody wears: loaded after signing in, changed by the live stream, moved on a rename, and empty after signing out', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      const url = new URL(String(input), 'http://x');
      const body =
        url.pathname === '/api/looks' ? { looks: { bob: { color: 'c_gold', frame: 'f_ruby' }, carol: { title: 't_made_up' }, dave: {} } } : url.pathname === '/api/avatars' ? { avatars: {} } : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    try {
      await profileStore.start();
      // Unknown things and empty looks are dropped when the list arrives.
      expect(profileStore.getSnapshot().looks).toEqual({ bob: { color: 'c_gold', frame: 'f_ruby' } });
      let heard = 0;
      const off = profileStore.subscribe(() => (heard += 1));
      profileStore.onLooks({ username: 'carol', look: { title: 't_bull', glow: 'g_ice' } });
      expect(profileStore.getSnapshot().looks.carol).toEqual({ glow: 'g_ice', title: 't_bull' });
      profileStore.onLooks({ username: 'carol', look: null });
      expect(profileStore.getSnapshot().looks.carol).toBeUndefined();
      profileStore.onLooks({ username: 'bob', look: { color: 'made_up' } as never }); // nothing the page knows: he wears nothing now
      expect(profileStore.getSnapshot().looks.bob).toBeUndefined();
      expect(heard).toBe(3);
      profileStore.onLooks({ username: 'erin', look: { frame: 'f_gold' } });
      profileStore.onRenamed('ERIN', 'erin2');
      expect(profileStore.getSnapshot().looks).toEqual({ erin2: { frame: 'f_gold' } });
      off();
      profileStore.stop();
      expect(profileStore.getSnapshot().looks).toEqual({});
      profileStore.onLooks({ username: 'bob', look: { color: 'c_gold' } }); // signed out: nothing is kept
      expect(profileStore.getSnapshot().looks).toEqual({});
    } finally {
      globalThis.fetch = realFetch;
      profileStore.stop();
    }
    const store = code(src('shared', 'store.ts'));
    expect(store).toMatch(/addEventListener\('looks'/);
  });
});

describe('The profile card', () => {
  const me: User = { id: 1, username: 'alice', displayName: 'alice', role: 'player' };
  type Internal = { set(p: object): void };
  afterEach(() => profileStore.stop());

  it('SHOPUI-9: a name opens the card only for a signed-in player; the card closes; signing out closes it', () => {
    const s = new SharedStore();
    s.openProfile('bob');
    expect(s.getSnapshot().profileFor).toBeNull();
    (s as unknown as Internal).set({ user: me });
    s.openProfile('bob');
    expect(s.getSnapshot().profileFor).toBe('bob');
    s.closeProfile();
    expect(s.getSnapshot().profileFor).toBeNull();
    let heard = 0;
    s.subscribe(() => (heard += 1));
    s.closeProfile(); // already closed: nobody is told
    expect(heard).toBe(0);
    const store = code(src('shared', 'store.ts'));
    expect(store.match(/profileFor: null/g)?.length).toBeGreaterThanOrEqual(3); // the start, and both sign-outs
  });

  it('SHOPUI-10: the card asks the server (a banned, unknown or computer player has none), shows rank, net worth, the day he joined, every badge and his looks, and has Message or Open the Shop', () => {
    const card = code(src('shared', 'ProfileCard.tsx'));
    expect(card).toMatch(/api\s*\.playerProfile\(username\)/);
    expect(card).toMatch(/role="dialog" aria-modal="true"/);
    expect(card).toMatch(/e\.key === 'Escape'/);
    expect(card).toContain('profile.badges.map');
    expect(card).toMatch(/\{profile\.badges\.length\} of \{BADGES\.length\}/);
    expect(card).toMatch(/sharedStore\.startCompose\(profile\.username\)/);
    expect(card).toMatch(/Open the Shop/);
    expect(card).not.toMatch(/localStorage|sessionStorage|Math\.random/);
    const app = code(src('shared', 'SharedApp.tsx'));
    expect(app).toMatch(/<ProfileCard onShop=\{goShop\} \/>/);
    const menu = code(src('shared', 'ProfileMenu.tsx'));
    expect(menu).toMatch(/sharedStore\.openProfile\(user\.username\)/);
    expect(menu).toMatch(/data-testid="menu-profile"/);
    expect(menu).toMatch(/data-testid="menu-shop"/);
    expect(BADGES.length).toBeGreaterThan(40);
  });

  it('SHOPUI-11: the words of the card: the day he joined, and the rank or why there is none', () => {
    expect(joinedText(Date.UTC(2026, 2, 5, 23, 59))).toBe('5 March 2026');
    expect(rankText({ rank: 3, rankedCount: 120 })).toBe('Rank #3 of 120');
    expect(rankText({ rank: null, rankedCount: 120 })).toBe('Not on the leaderboard');
  });
});

describe('The styles', () => {
  it('SHOPUI-12: every thing in the Shop has its look in the styles, every animation of a look is in a no-preference block, and reduced motion gets none of them', () => {
    const css = readFileSync(src('styles.css'), 'utf8');
    for (const c of COSMETICS) {
      if (c.slot === 'frame') expect(css, c.id).toContain(`.pfp-frame.cos-${c.id}`);
      else if (c.slot === 'title') continue; // a title is only words under the name
      else if (isGearSlot(c.slot)) continue; // things for your own screen are checked in tests/gear-ui.test.ts (GEARUI-n)
      else if (c.slot === 'banner' || c.slot === 'pet') continue; // banners and pets are checked in tests/looks-ui.test.ts (LOOKUI-n)
      else expect(css, c.id).toContain(`.pname.cos-${c.id}`);
    }
    for (const cls of ['.pfp-frame', '.pname-wrap', '.ptitle', '.shop-grid', '.shop-item', '.rar-chip', '.profile-card', '.profile-top', '.profile-facts']) expect(css, cls).toContain(cls);
    // The animations of the looks live after the Shop heading and inside a no-preference block, so a player who asked for less motion sees still looks.
    const shop = css.slice(css.indexOf('The Shop: things to wear'));
    expect(shop).toBeTruthy();
    const motion = shop.slice(shop.indexOf('@media (prefers-reduced-motion: no-preference)'));
    for (const name of ['cos-shift', 'cos-neon', 'cos-ember', 'cos-diamond', 'cos-spin', 'cos-twinkle', 'cos-bob', 'card-pop']) {
      expect(shop.indexOf(`@keyframes ${name}`), name).toBeGreaterThan(shop.indexOf('@media (prefers-reduced-motion: no-preference)'));
      expect(shop.slice(0, shop.indexOf('@media (prefers-reduced-motion: no-preference)')), name).not.toContain(`animation: ${name}`);
    }
    expect(motion.length).toBeGreaterThan(200);
    // The one reduced-motion block (the price animations test reads the last one) is before the Shop part.
    expect(css.lastIndexOf('@media (prefers-reduced-motion: reduce)')).toBeLessThan(css.indexOf('The Shop: things to wear'));
    // A glow is a filter (so it also works on the gradient names), never a text-shadow that would paint over them.
    expect(shop.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/text-shadow/);
    // A frame is drawn outside the picture and never changes the size of a row.
    expect(shop).toMatch(/\.pfp-frame::before\s*\{[^}]*inset:\s*calc\(var\(--w\) \* -1\.5\)/);
    expect(shop).toMatch(/\.pfp-frame::after\s*\{[^}]*pointer-events:\s*none/);
  });
});
