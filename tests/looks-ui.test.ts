// LOOKUI-1 … LOOKUI-8 — banners, pets and the looks that are earned (docs/world.md §34). The rules are the server's (tests/server-looks.test.ts). Here the page only has to draw every look
// the catalog has, show the earned ones as "how to earn" (never a Buy button), and keep every animation in the no-preference block.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BADGES } from '../src/shared/badgeCatalog';
import { ALL_SLOT_IDS, COSMETICS, PROFILE_SLOTS, SLOTS, bannerClass, cleanLook, isProfileSlot, priceOf } from '../src/shared/cosmeticCatalog';
import { PETS, PET_EGG, PET_MAX_STAGE, PET_STAGE_DAYS, cleanStage, petById, petGlyph, petLabel, petNextText, petStageOf } from '../src/shared/petCatalog';

const src = (...parts: string[]): string => resolve(process.cwd(), 'src', ...parts);

function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const css = readFileSync(src('styles.css'), 'utf8');
const MARK_START = 'Update 4: banners, pets, earned looks';
const MARK_END = 'Trade moments, loading shimmer, smooth screens and market marks';
/** The part of the styles that belongs to this update, comments taken out. */
const ownCss = css.slice(css.indexOf(MARK_START), css.indexOf(MARK_END)).replace(/\/\*[\s\S]*?\*\//g, '');

const banners = COSMETICS.filter((c) => c.slot === 'banner');
const pets = COSMETICS.filter((c) => c.slot === 'pet');
const earnedFrames = COSMETICS.filter((c) => c.slot === 'frame' && c.earn !== undefined);

describe('Banners and pets', () => {
  it('LOOKUI-1: the catalog has 17 banners (12 for sale, 5 earned) and 10 pets, each with a price in the Shop or a way to earn it', () => {
    expect(banners.length).toBe(17);
    expect(banners.filter((b) => b.earn === undefined).length).toBe(12);
    expect(banners.filter((b) => b.earn !== undefined).length).toBe(5);
    expect(pets.length).toBe(10);
    expect(pets.filter((p) => p.earn !== undefined)).toEqual([]);
    for (const c of [...banners, ...pets, ...earnedFrames]) {
      if (c.earn === undefined) expect(priceOf(c), c.id).toBeGreaterThan(0);
      else expect(c.how, c.id).toBeTruthy();
    }
    expect(PROFILE_SLOTS.map((s) => s.id)).toEqual(['banner', 'pet']);
    expect(isProfileSlot('banner')).toBe(true);
    expect(isProfileSlot('pet')).toBe(true);
    expect(isProfileSlot('frame')).toBe(false);
    // The four old slots stay exactly as they were, and the new ones are in the list of all slots.
    expect(SLOTS.map((s) => s.id)).toEqual(['color', 'glow', 'frame', 'title']);
    for (const id of ['banner', 'pet']) expect(ALL_SLOT_IDS).toContain(id);
  });

  it('LOOKUI-2: every banner has its own CSS rule, every earned ring has one, and the picture shows nothing but CSS (no picture files)', () => {
    for (const b of banners) expect(ownCss, b.id).toContain(`.pbanner.cos-${b.id}`);
    for (const f of earnedFrames) expect(ownCss, f.id).toContain(`.pfp-frame.cos-${f.id}`);
    for (const cls of ['.pbanner', '.profile-banner', '.profile-top.has-banner', '.pbanner.shop-banner', '.pname-pet', '.ppet', '.pet-sample', '.pet-form', '.pet-now', '.team-chip', '.trophy-room', '.trophy-list', '.trophy-icon', '.trophy-facts']) {
      expect(ownCss, cls).toContain(cls);
    }
    for (let i = 0; i <= PET_MAX_STAGE; i += 1) expect(ownCss, `stage ${i}`).toContain(`.pet-stage-${i}`);
    // No picture files, no fetching of anything: a banner is gradients.
    expect(ownCss).not.toMatch(/url\(/);
    for (const b of banners) expect(ownCss).toMatch(new RegExp(`\\.pbanner\\.cos-${b.id}\\s*\\{[^}]*gradient`));
  });

  it('LOOKUI-3: every animation of this part is in the no-preference block (so reduced motion gets still looks); no text-shadow; a phone gets its own rules', () => {
    const at = ownCss.indexOf('@media (prefers-reduced-motion: no-preference)');
    expect(at).toBeGreaterThan(0);
    const before = ownCss.slice(0, at);
    const motion = ownCss.slice(at);
    expect(before).not.toMatch(/animation\s*:|transition\s*:|@keyframes/);
    for (const name of ['look-drift', 'pet-hop', 'rematch-nudge', 'event-glow']) {
      expect(motion, name).toContain(`@keyframes ${name}`);
      expect(motion, name).toMatch(new RegExp(`animation:\\s*${name} `));
    }
    expect(ownCss).not.toMatch(/text-shadow/);
    expect(ownCss).toMatch(/@media \(max-width: 600px\)[\s\S]*\.profile-banner/);
    expect(ownCss).toMatch(/@media \(max-width: 600px\)[\s\S]*\.team-row-act/);
    // The marker the fx tests cut the styles at is still after this part, and the one reduced-motion block they read is still before the Shop.
    expect(css.indexOf(MARK_END)).toBeGreaterThan(css.indexOf(MARK_START));
    expect(css.lastIndexOf('@media (prefers-reduced-motion: reduce)')).toBeLessThan(css.indexOf('The Shop: things to wear'));
  });
});

describe('Pets grow with the streak', () => {
  it('LOOKUI-4: every pet has four distinct forms after the egg, and the stage comes from the best streak (3, 7, 14, 30 days) and never goes down', () => {
    expect(PET_STAGE_DAYS).toEqual([0, 3, 7, 14, 30]);
    expect(PET_MAX_STAGE).toBe(4);
    const ids = new Set(pets.map((p) => p.id));
    expect(PETS.length).toBe(ids.size);
    for (const p of PETS) {
      expect(ids.has(p.id), p.id).toBe(true);
      expect(new Set(p.forms).size, p.id).toBe(4);
      expect(p.forms).not.toContain(PET_EGG);
    }
    expect([0, 2, 3, 6, 7, 13, 14, 29, 30, 400].map(petStageOf)).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4]);
    // Best streak only goes up, so the stage only goes up.
    let last = 0;
    for (let d = 0; d < 60; d += 1) {
      const s = petStageOf(d);
      expect(s).toBeGreaterThanOrEqual(last);
      last = s;
    }
  });

  it('LOOKUI-5: a pet is an egg before it hatches; the label and the "what is next" sentence are plain; nonsense from outside counts as an egg', () => {
    expect(petGlyph('p_fox', 0)).toBe(PET_EGG);
    expect(petGlyph('p_fox', 1)).toBe(petById('p_fox')?.forms[0]);
    expect(petGlyph('p_fox', 4)).toBe(petById('p_fox')?.forms[3]);
    expect(petGlyph('p_fox', 9)).toBe(PET_EGG);
    expect(petGlyph('p_fox', 'x')).toBe(PET_EGG);
    expect(petGlyph('nope', 3)).toBe('');
    expect(petGlyph(undefined, 3)).toBe('');
    expect(petLabel('p_fox', 2)).toBe('Fox (Young)');
    expect(petLabel('p_fox', 0)).toBe('Fox (Egg)');
    expect(petLabel('nope', 1)).toBe('');
    expect(cleanStage(2.5)).toBe(0);
    expect(cleanStage(-1)).toBe(0);
    expect(cleanStage(3)).toBe(3);
    expect(petNextText(0)).toBe('Hatches when your best streak reaches 3 days');
    expect(petNextText(2)).toBe('Grows when your best streak reaches 14 days');
    expect(petNextText(4)).toBeNull();
  });

  it('LOOKUI-6: a worn look keeps a pet stage only with a valid pet, and a banner gives its CSS class', () => {
    expect(cleanLook({ pet: 'p_fox', petStage: 2 })).toEqual({ pet: 'p_fox', petStage: 2 });
    expect(cleanLook({ petStage: 3 })).toEqual({});
    expect(cleanLook({ pet: 'bogus', petStage: 3 })).toEqual({});
    expect(bannerClass({ banner: 'bn_aurora' })).toBe('cos-bn_aurora');
    expect(bannerClass({})).toBe('');
    expect(bannerClass(null)).toBe('');
    expect(bannerClass({ banner: 'bogus' })).toBe('');
  });
});

describe('The screens', () => {
  it('LOOKUI-7: the Shop draws banners and pets, shows the earned looks as "how to earn" with no Buy button, and keeps the lines other tests pin', () => {
    const shop = code(src('shared', 'ShopScreen.tsx'));
    expect(shop).toContain('PROFILE_SLOTS.map');
    expect(shop).toContain('pbanner shop-banner cos-');
    expect(shop).toContain('pet-sample');
    expect(shop).toContain("c.earn === undefined");
    expect(shop).toMatch(/earnedOnly \? \(/);
    expect(shop).toContain('data-testid={`shop-earn-${def.id}`}');
    expect(shop).toContain('shop-earned-${g.key}');
    // The "Buy" button is only in the branch for things that are for sale.
    const earnedAt = shop.indexOf('earnedOnly ? (');
    const buyAt = shop.indexOf('data-testid={`shop-buy-${def.id}`}');
    expect(earnedAt).toBeGreaterThan(0);
    expect(buyAt).toBeGreaterThan(earnedAt);
    // The money is never worked out by the page.
    expect(shop).not.toMatch(/cashCents\s*[-+]=|cashCents\s*-\s*price/);
  });

  it('LOOKUI-8: names show the pet next to them, and the profile card shows the banner, the team chip and the trophy room (all of it from the server)', () => {
    const name = code(src('shared', 'PlayerName.tsx'));
    expect(name).toContain('pname-pet');
    expect(name).toContain('className="ppet"');
    expect(name).toContain('petGlyph(look.pet');
    expect(name).toContain('sharedStore.openProfile(username)'); // the old pinned line is still there
    const card = code(src('shared', 'ProfileCard.tsx'));
    expect(card).toContain('profile-banner pbanner');
    expect(card).toContain('profile-top has-banner');
    expect(card).toMatch(/api\s*\.trophies\(username\)/);
    expect(card).toContain('className="team-chip"');
    expect(card).toContain('className="trophy-room"');
    expect(card).toContain('data-testid="trophy-list"');
    // 64 badges, five groups: the new ones did not change what the badge tests pin.
    expect(BADGES.length).toBe(64);
  });
});
