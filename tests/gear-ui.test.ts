// GEARUI-1 … GEARUI-12 — the things for your own screen and the billboard, as the PAGE shows them (docs/world.md §30). The rules are the server's (tests/server-gear.test.ts,
// tests/server-billboard.test.ts); here the page only has to know the catalog, keep its own gear, draw every look, play a party in the player's style, and show the billboard.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BADGES } from '../src/shared/badgeCatalog';
import { billboardStore, liveSlots } from '../src/shared/billboardStore';
import { COSMETICS, GEAR_SLOTS, RARITY_PRICE_CENTS, SLOTS, chartClasses, cleanGear, cosmeticById, gearIsEmpty, isGearSlot, priceOf, type Gear } from '../src/shared/cosmeticCatalog';
import { profileStore } from '../src/shared/profileStore';
import { lockReason } from '../src/shared/shopUtil';
import { milestoneOfWin, type Win } from '../src/shared/winCelebration';
import { WIN_STYLES, styledPieces, winStyleOf } from '../src/shared/winStyles';
import { piecesFor } from '../src/ui/hype';
import type { BillboardSlotView, BillboardView } from '../src/shared/types';

const src = (...parts: string[]): string => resolve(process.cwd(), 'src', ...parts);

function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const css = readFileSync(src('styles.css'), 'utf8');
const MARK_START = 'The Shop, part 2: things for your own screen, and the billboard';
const MARK_END = 'Trade moments, loading shimmer, smooth screens and market marks';
/** The part of the styles that belongs to this update, comments taken out. */
const gearCss = css.slice(css.indexOf(MARK_START), css.indexOf(MARK_END)).replace(/\/\*[\s\S]*?\*\//g, '');

const inSlot = (slot: string) => COSMETICS.filter((c) => c.slot === slot);

describe('The catalog of things for your own screen', () => {
  it('GEARUI-1: five places, 36 things, the same four prices as the rest of the Shop, and every Legendary thing needs a real badge', () => {
    expect(GEAR_SLOTS.map((s) => s.id)).toEqual(['candles', 'shape', 'backdrop', 'effect', 'win']);
    expect(SLOTS.map((s) => s.id)).toEqual(['color', 'glow', 'frame', 'title']); // the four things everybody sees are unchanged
    expect(inSlot('candles')).toHaveLength(10);
    expect(inSlot('shape')).toHaveLength(6);
    expect(inSlot('backdrop')).toHaveLength(7);
    expect(inSlot('effect')).toHaveLength(5);
    expect(inSlot('win')).toHaveLength(8);
    expect(RARITY_PRICE_CENTS).toEqual([0, 200_000, 1_000_000, 5_000_000, 25_000_000]);
    const ids = COSMETICS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of COSMETICS.filter((x) => isGearSlot(x.slot))) {
      expect(c.id.startsWith({ candles: 'cc_', shape: 'sh_', backdrop: 'bg_', effect: 'fx_', win: 'ws_' }[c.slot as 'candles'])).toBe(true);
      expect(priceOf(c)).toBe(RARITY_PRICE_CENTS[c.rarity]);
      if (c.rarity === 4) {
        expect(c.requiresBadge, c.id).toBeDefined();
        expect(BADGES.some((b) => b.id === c.requiresBadge), c.id).toBe(true);
      } else {
        expect(c.requiresBadge, c.id).toBeUndefined();
      }
    }
    // The words that say why a Buy cannot work are the same for these things.
    const crystal = cosmeticById('sh_crystal');
    expect(crystal).toBeDefined();
    expect(lockReason(crystal as NonNullable<typeof crystal>, { cashCents: 99_999_999, badges: [] })).toMatch(/^Needs the ".+" badge$/);
    expect(lockReason(crystal as NonNullable<typeof crystal>, { cashCents: 99_999_999, badges: ['lessons_100'] })).toBeNull();
  });

  it('GEARUI-2: only real things in the right place are kept, and only candle colours, shapes, backgrounds and effects become classes of the chart (never a win style)', () => {
    expect(gearIsEmpty(undefined)).toBe(true);
    expect(gearIsEmpty(null)).toBe(true);
    expect(gearIsEmpty({})).toBe(true);
    expect(gearIsEmpty({ win: 'ws_gold' })).toBe(false);
    expect(cleanGear(null)).toEqual({});
    expect(cleanGear('x')).toEqual({});
    expect(cleanGear({ candles: 'made_up', shape: 'cc_neon', backdrop: 7, effect: 'fx_glow', win: 'ws_gold', extra: 'x' })).toEqual({ effect: 'fx_glow', win: 'ws_gold' });
    const all: Gear = { candles: 'cc_neon', shape: 'sh_slim', backdrop: 'bg_galaxy', effect: 'fx_flame', win: 'ws_royal' };
    expect(chartClasses(all)).toBe('cos-cc_neon cos-sh_slim cos-bg_galaxy cos-fx_flame');
    expect(chartClasses({ win: 'ws_royal' })).toBe('');
    expect(chartClasses(undefined)).toBe('');
    expect(chartClasses({ candles: 'nope' } as unknown as Gear)).toBe('');
  });
});

describe('What the page keeps of his own gear', () => {
  afterEach(() => profileStore.stop());

  it('GEARUI-3: his gear is asked for once after signing in, changed by the Shop and by the live stream (his own pages only), ignored when signed out and gone after signing out', async () => {
    const realFetch = globalThis.fetch;
    let asked = 0;
    globalThis.fetch = (async (input: unknown) => {
      const url = new URL(String(input), 'http://x');
      if (url.pathname === '/api/gear') asked += 1;
      const body = url.pathname === '/api/gear' ? { gear: { candles: 'cc_aurora', shape: 'made_up', win: 'ws_neon' } } : url.pathname === '/api/avatars' ? { avatars: {} } : url.pathname === '/api/looks' ? { looks: {} } : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    try {
      profileStore.setGear({ candles: 'cc_neon' }); // signed out: nothing is kept
      expect(profileStore.getSnapshot().gear).toEqual({});
      await profileStore.start();
      expect(asked).toBe(1);
      expect(profileStore.getSnapshot().gear).toEqual({ candles: 'cc_aurora', win: 'ws_neon' }); // the made-up one is dropped
      let heard = 0;
      const off = profileStore.subscribe(() => (heard += 1));
      profileStore.setGear({ backdrop: 'bg_galaxy', win: 'ws_gold' });
      expect(profileStore.getSnapshot().gear).toEqual({ backdrop: 'bg_galaxy', win: 'ws_gold' });
      profileStore.onGear({ gear: { effect: 'fx_glow' } });
      expect(profileStore.getSnapshot().gear).toEqual({ effect: 'fx_glow' });
      profileStore.onGear({ gear: null });
      expect(profileStore.getSnapshot().gear).toEqual({});
      expect(heard).toBe(3);
      off();
      profileStore.stop();
      expect(profileStore.getSnapshot().gear).toEqual({});
      profileStore.onGear({ gear: { candles: 'cc_neon' } });
      expect(profileStore.getSnapshot().gear).toEqual({});
    } finally {
      globalThis.fetch = realFetch;
      profileStore.stop();
    }
    const store = code(src('shared', 'store.ts'));
    expect(store).toMatch(/addEventListener\('gear'/);
    expect(store).toMatch(/addEventListener\('billboard'/);
    // The gear is its own piece of the store: it never comes from the list of what everybody wears.
    const ps = code(src('shared', 'profileStore.ts'));
    expect(ps).toMatch(/api\.gear\(\)/);
    expect(ps).not.toMatch(/localStorage|sessionStorage|Math\.random/);
  });
});

describe('Every look is drawn', () => {
  const chartIds = [...inSlot('candles'), ...inSlot('shape'), ...inSlot('backdrop'), ...inSlot('effect')].map((c) => c.id);

  it('GEARUI-4: every candle colour, shape, background and effect has its rule; the colours are variables with the normal green and red as the fallback', () => {
    for (const id of chartIds) expect(gearCss, id).toContain(`.cos-${id}`);
    for (const c of inSlot('candles')) {
      const rule = gearCss.match(new RegExp(`\\.cos-${c.id}\\s*\\{[^}]*\\}`));
      expect(rule, c.id).not.toBeNull();
      expect((rule as RegExpMatchArray)[0], c.id).toMatch(/--candle-up:/);
      expect((rule as RegExpMatchArray)[0], c.id).toMatch(/--candle-down:/);
    }
    // The candles read the variables, and without one they are exactly as before.
    expect(css).toMatch(/\.live-svg \.candle\.up \.wick,\s*\.live-svg \.candle\.up \.body\s*\{\s*fill:\s*var\(--candle-up, var\(--up\)\)/);
    expect(css).toMatch(/\.live-svg \.candle\.down \.wick,\s*\.live-svg \.candle\.down \.body\s*\{\s*fill:\s*var\(--candle-down, var\(--down\)\)/);
    expect(css).toMatch(/stroke:\s*var\(--candle-up, var\(--up\)\)/);
    expect(css).toMatch(/background:\s*var\(--candle-up, var\(--up\)\)/); // the legend dot
    // The rainbow moves through two registered colours, so the browser can fade between them.
    expect(css).toMatch(/@property --rb-up\s*\{\s*syntax:\s*'<color>'/);
    expect(css).toMatch(/@property --rb-down\s*\{\s*syntax:\s*'<color>'/);
  });

  it('GEARUI-5: every animation of a look is in the no-preference block (so reduced motion gets still looks), before the later parts the other style tests read; no text-shadow; sparkle never blurs the candles', () => {
    const at = gearCss.indexOf('@media (prefers-reduced-motion: no-preference)');
    expect(at).toBeGreaterThan(0);
    const before = gearCss.slice(0, at);
    const motion = gearCss.slice(at);
    expect(before).not.toMatch(/animation\s*:/);
    for (const name of ['gear-aurora', 'gear-rainbow', 'gear-lights', 'gear-twinkle', 'gear-beat', 'gear-flame', 'gear-sparkle']) {
      expect(motion, name).toContain(`@keyframes ${name}`);
      expect(motion, name).toMatch(new RegExp(`animation:\\s*${name} `));
      expect(before, name).not.toContain(`@keyframes ${name}`);
    }
    expect(motion.length).toBeGreaterThan(500);
    expect(gearCss).not.toMatch(/text-shadow/); // a glow is a filter, so it also works on the gradient numbers
    // The sparkle is a crisp white edge that twinkles: a filter on thousands of small shapes turned them into blurry columns.
    const sparkleRules = gearCss.match(/[^{}]*cos-fx_sparkle[^{}]*\{[^}]*\}/g) ?? [];
    expect(sparkleRules.length).toBeGreaterThanOrEqual(2);
    for (const r of sparkleRules) expect(r).not.toMatch(/filter/);
    expect(motion).toMatch(/@keyframes gear-sparkle\s*\{[^@]*stroke-width/);
    // The marker the fx tests cut the styles at is still after this part, and the one reduced-motion block they read is still before the Shop.
    expect(css.indexOf(MARK_END)).toBeGreaterThan(css.indexOf(MARK_START));
    expect(css.lastIndexOf('@media (prefers-reduced-motion: reduce)')).toBeLessThan(css.indexOf('The Shop: things to wear'));
  });

  it('GEARUI-6: the small chart pictures in the Shop use the same shapes and classes as the real chart, and a win style has a picture with a "Try it" button that plays the real party', () => {
    const sample = code(src('shared', 'GearSamples.tsx'));
    for (const cls of ['company-chart gear-sample', 'chart-frame', 'live-svg', 'className={`candle ', 'className="wick"', 'className="body"', 'className="price-line"', 'className="mark-line"', 'className="live-core up"']) {
      expect(sample, cls).toContain(cls);
    }
    expect(sample).toMatch(/cos-\$\{id\}/);
    expect(sample).toMatch(/onClick=\{\(\) => celebrate\(demo\)\}/);
    expect(sample).toMatch(/style: id/);
    expect(sample).not.toMatch(/api\.|fetch\(|localStorage|sessionStorage|Math\.random/); // only for looking: nothing is bought, worn or sent
    const screen = code(src('shared', 'ShopScreen.tsx'));
    expect(screen).toMatch(/def\.slot === 'win' \? <WinSample id=\{def\.id\} \/> : <ChartSample id=\{def\.id\} \/>/);
    expect(screen).toMatch(/GEAR_SLOTS\.map\(\(slot\) => renderSlot\(slot\.id, slot\.label, slot\.hint, view\)\)/);
    expect(screen).toMatch(/data-testid="shop-gear-head"/);
    expect(screen).toMatch(/Other players cannot see them/);
    expect(screen).toMatch(/profileStore\.setGear\(out\.gear\)/); // after buying and after wearing the chart changes at once
    expect(screen.match(/profileStore\.setGear\(out\.gear\)/g)).toHaveLength(2);
    // One row of pictures for a win style stays on one line (it is only a sample), and the pieces never block a click.
    expect(gearCss).toMatch(/\.win-dots\s*\{[^}]*flex-wrap:\s*nowrap/);
  });
});

describe('Win styles', () => {
  const win: Win = { kind: 'trade', ticker: 'DEMO', label: '+$123.45', tag: 'Nice trade!', icon: '💰', sub: 'Just trying it on', level: 2, seed: 4242 };
  const plain = piecesFor(win.seed, milestoneOfWin(win));

  it('GEARUI-7: eight styles, each with colours; the picture styles have pictures; only Fireworks bursts from three places; unknown ids give the plain party', () => {
    const ids = inSlot('win').map((c) => c.id);
    expect(Object.keys(WIN_STYLES).sort()).toEqual([...ids].sort());
    for (const id of ids) {
      const spec = winStyleOf(id);
      expect(spec, id).not.toBeNull();
      expect((spec as NonNullable<typeof spec>).palette.length, id).toBeGreaterThanOrEqual(2);
    }
    expect(ids.filter((id) => winStyleOf(id)?.glyphs).sort()).toEqual(['ws_coins', 'ws_diamond', 'ws_royal', 'ws_stars']);
    expect(ids.filter((id) => winStyleOf(id)?.origins === 3)).toEqual(['ws_fireworks']);
    expect(winStyleOf(undefined)).toBeNull();
    expect(winStyleOf(null)).toBeNull();
    expect(winStyleOf('made_up')).toBeNull();
    expect(winStyleOf('toString')).toBeNull();
    expect(winStyleOf('__proto__')).toBeNull();
  });

  it('GEARUI-8: a style changes only colours, pictures and the place a piece starts from: the flight (where, how far, how long, how big) is exactly the plain party\'s', () => {
    const none = styledPieces(plain, null);
    expect(none).toHaveLength(plain.length);
    none.forEach((p, i) => expect(p).toEqual({ ...(plain[i] as object), origin: 0 }));
    for (const id of Object.keys(WIN_STYLES)) {
      const spec = winStyleOf(id);
      const out = styledPieces(plain, spec);
      expect(out, id).toHaveLength(plain.length);
      out.forEach((p, i) => {
        const base = plain[i] as (typeof plain)[number];
        expect([p.dx, p.dy, p.rot, p.time, p.size, p.shape], id).toEqual([base.dx, base.dy, base.rot, base.time, base.size, base.shape]);
        expect(spec?.palette, id).toContain(p.color);
        expect(p.delay, id).toBe(base.delay + p.origin * 260);
        if (spec?.glyphs) expect(spec.glyphs, id).toContain(p.glyph);
        else expect(p.glyph, id).toBeUndefined();
      });
      const origins = new Set(out.map((p) => p.origin));
      expect([...origins].sort(), id).toEqual(spec?.origins === 3 ? [0, 1, 2] : [0]);
    }
    // The same party twice looks the same (the seed decides, never the clock).
    expect(styledPieces(plain, winStyleOf('ws_fireworks'))).toEqual(styledPieces(plain, winStyleOf('ws_fireworks')));
  });

  it('GEARUI-9: the party layer plays the style he wears (or the one the Shop asks to try), never talks to the server, and the big number takes the style\'s gradient', () => {
    const layer = code(src('shared', 'WinBurst.tsx'));
    expect(layer).toMatch(/winStyleOf\(playing\?\.win\.style \?\? gear\.win\)/);
    expect(layer).toMatch(/styledPieces\(piecesFor\(playing\.win\.seed, milestoneOfWin\(playing\.win\)\), spec\)/);
    expect(layer).toMatch(/data-style=/);
    expect(layer).toMatch(/spec\?\.banner/);
    expect(layer).toMatch(/piece shape-\$\{p\.shape\}\$\{p\.glyph \? ' glyph' : ''\}/);
    expect(layer).not.toMatch(/api\.|fetch\(|localStorage|sessionStorage|Math\.random/);
    // The number is gradient text, so each style sets the gradient (not "color" alone) and a glow made with a filter.
    for (const spec of Object.values(WIN_STYLES)) {
      if (!spec.banner) continue;
      const rule = gearCss.match(new RegExp(`\\.win-burst\\.${spec.banner} \\.win-x\\s*\\{[^}]*\\}`));
      expect(rule, spec.banner).not.toBeNull();
      expect((rule as RegExpMatchArray)[0], spec.banner).toMatch(/background-image:\s*linear-gradient/);
      expect((rule as RegExpMatchArray)[0], spec.banner).toMatch(/filter:\s*drop-shadow/);
    }
    // Pictures are drawn as text, not as the coloured bits.
    expect(gearCss).toMatch(/\.piece\.glyph\s*\{[^}]*background:\s*none/);
    expect(gearCss).toMatch(/\.burst-origin\.origin-1\s*\{/);
    expect(gearCss).toMatch(/\.burst-origin\.origin-2\s*\{/);
  });
});

describe('The billboard', () => {
  const HOUR = 3_600_000;
  const rental = (slot: number, endsMs: number): BillboardSlotView => ({ slot, rental: { ticker: `T${slot}`, name: `Co ${slot}`, byUsername: 'alice', byName: 'alice', startsMs: endsMs - HOUR, endsMs } });
  const view = (slots: BillboardSlotView[], over: Partial<BillboardView> = {}): BillboardView => ({ slots, serverMs: 1_000_000, centsPerHour: 500_000, hours: [1, 3, 6, 12, 24], maxHoursAhead: 24, mine: null, ...over });

  it('GEARUI-10: a booking that is over is taken out by the server\'s clock, the live stream keeps his own cash and companies, and a failed load changes nothing', async () => {
    const slots = [rental(1, 5_000), rental(2, 10_000), { slot: 3, rental: null }];
    const live = liveSlots(slots, 5_000);
    expect(live[0]).toEqual({ slot: 1, rental: null }); // ends exactly now: over
    expect(live[1]).toBe(slots[1]);
    expect(live[2]).toEqual(slots[2]);
    expect(slots[0]?.rental).not.toBeNull(); // the list it was given is not changed
    expect(liveSlots(slots, 0).map((s) => s.rental?.ticker ?? null)).toEqual(['T1', 'T2', null]);

    const realFetch = globalThis.fetch;
    let fail = false;
    const answer = view([rental(1, 9_000_000)], { mine: { cashCents: 123, launched: [{ ticker: 'ALCO', name: 'Alco', kind: 'coin' }] } });
    globalThis.fetch = (async () => {
      if (fail) throw new Error('offline');
      return new Response(JSON.stringify(answer), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    try {
      await billboardStore.load();
      expect(billboardStore.getSnapshot().view).toEqual(answer);
      expect(Math.abs(billboardStore.getSnapshot().skewMs - (answer.serverMs - Date.now()))).toBeLessThan(2_000);
      // The live stream sends the places only; what is his stays.
      billboardStore.onEvent({ slots: [{ slot: 1, rental: null }, rental(2, 9_500_000), { slot: 3, rental: null }] });
      const now = billboardStore.getSnapshot().view as BillboardView;
      expect(now.slots.map((s) => s.rental?.ticker ?? null)).toEqual([null, 'T2', null]);
      expect(now.mine).toEqual(answer.mine);
      // Signing out forgets his things but keeps the three places (everybody sees those).
      billboardStore.clearMine();
      const out = billboardStore.getSnapshot().view as BillboardView;
      expect(out.mine).toBeNull();
      expect(out.slots).toEqual(now.slots);
      // A failed load keeps what was there.
      fail = true;
      const before = billboardStore.getSnapshot().view;
      await billboardStore.load();
      expect(billboardStore.getSnapshot().view).toBe(before);
      // A booking answer is the whole new picture.
      billboardStore.setView(answer);
      expect(billboardStore.getSnapshot().view).toBe(answer);
    } finally {
      globalThis.fetch = realFetch;
    }
    const store = code(src('shared', 'billboardStore.ts'));
    expect(store).not.toMatch(/localStorage|sessionStorage|Math\.random/);
  });

  it('GEARUI-11: the strip only shows (a click opens the company, a free place leads to the booking card); the booking card asks twice, never does the sum itself and shows the server\'s answer', () => {
    const strip = code(src('shared', 'BillboardStrip.tsx'));
    expect(strip).toMatch(/onClick=\{\(\) => onOpen\(rental\.ticker\)\}/);
    expect(strip).toMatch(/onClick=\{onBook\}/);
    expect(strip).toMatch(/if \(view === null\) return null/);
    for (const id of ['billboard', 'bb-slot-${s.slot}', 'bb-open-${rental.ticker}', 'bb-book-${s.slot}', 'bb-left-${rental.ticker}']) expect(strip, id).toContain(id);
    expect(strip).not.toMatch(/api\.(buy|sell|placeOrder|order|trade)|localStorage|sessionStorage|Math\.random/); // the strip places no order and changes no price
    const card = code(src('shared', 'BillboardBooking.tsx'));
    expect(card).toMatch(/onClick=\{\(\) => setAsking\(true\)\}/);
    expect(card).toMatch(/onClick=\{\(\) => void book\(\)\}/);
    expect(card).toMatch(/if \(busy \|\| wantedSlot === 0 \|\| chosen === ''\) return;/);
    expect(card).toMatch(/api\.bookBillboard\(wantedSlot, chosen, hours\)/);
    expect(card).toMatch(/billboardStore\.setView\(out\)/);
    expect(card).toContain('void sharedStore.refreshAccount()'); // the money in the header and the rank move at once
    expect(card).toMatch(/problemText\(e\)/);
    for (const id of ['billboard-booking', 'bb-company', 'bb-pick-${s.slot}', 'bb-hours-${h}', 'bb-book', 'bb-confirm', 'bb-cancel', 'bb-note', 'bb-cash', 'bb-yours', 'bb-nolaunch', 'bb-full']) expect(card, id).toContain(id);
    expect(card).not.toMatch(/cashCents\s*[-+]=|localStorage|sessionStorage|Math\.random/);
    // Only the companies HE launched are offered (the server's list), and the card is in the Launch tab, the strip above the Market and Memecoins lists.
    expect(card).toMatch(/view\?\.mine\?\.launched/);
    expect(code(src('shared', 'LaunchScreen.tsx'))).toMatch(/<BillboardBooking onOpen=\{onOpen\} refreshKey=\{mine\.length\} \/>/);
    const app = code(src('shared', 'SharedApp.tsx'));
    expect(app).toMatch(/\(careerTab === 'market' \|\| careerTab === 'coins'\)/);
    expect(app).toMatch(/<BillboardStrip onOpen=\{openCompany\} onBook=\{\(\) => setCareerTab\('launch'\)\} \/>/);
  });

  it('GEARUI-12: on a phone the three places stack, nothing can push the page sideways, and the real chart wears the player\'s own gear', () => {
    expect(css).toMatch(/@media \(max-width: \d+px\)\s*\{[^@]*\.bb-slots\s*\{[^}]*grid-template-columns:\s*1fr/);
    expect(gearCss).toMatch(/\.bb-slots\s*\{[^}]*repeat\(3, minmax\(0, 1fr\)\)/);
    const chart = code(src('shared', 'CompanyChart.tsx'));
    expect(chart).toMatch(/const \{ gear \} = useProfiles\(\)/);
    expect(chart).toMatch(/className=\{\['company-chart', chartClasses\(gear\)\]\.filter\(Boolean\)\.join\(' '\)\}/);
    // Nobody else's gear is ever drawn: the profile card and the lists only read what everybody wears (the looks).
    for (const f of ['ProfileCard.tsx', 'PlayerName.tsx', 'Avatar.tsx']) expect(code(src('shared', f)), f).not.toMatch(/\.gear\b|chartClasses|winStyleOf/);
  });
});
