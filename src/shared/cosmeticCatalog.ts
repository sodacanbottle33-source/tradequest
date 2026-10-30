// The Shop's things to wear (docs/world.md §29) and the things for your own screen (§30): what each one is called, which kind it is, how rare it is and so what
// it costs. This file is only data: the server decides who may buy and wear what (server/cosmetics.ts), and the screens only show what the server says. A cosmetic
// is for looks. It gives no money, no advantage in trading and changes no price; the money spent is gone (like the cost of a new username), so spending lowers a
// player's net worth and rank.
//
// There are three groups. The four "things to wear" (name colour, glow, picture frame, title) are seen by everybody. The two "things for your profile" (a banner behind
// the name on the profile card and a pet that grows with the daily-goal streak, docs/world.md §34) are seen by everybody too. The five "things for your screen" (candle
// colours, candle shapes, chart backgrounds, chart effects and win styles) are seen by the player who owns them and by nobody else.
//
// A few things are not for sale: they are EARNED, by finishing high in ranked 1v1 or by winning the weekly team race (`earn` on the entry). The server gives them; the Shop
// only shows them, with what it takes to earn them.

import { cleanStage } from './petCatalog';

/** The four places on a player: the colour of his name, a glow around the name, a ring around his picture and a title under his name. A player wears at most one thing in each place. */
export type Slot = 'color' | 'glow' | 'frame' | 'title';

export const SLOTS: readonly { readonly id: Slot; readonly label: string; readonly hint: string }[] = [
  { id: 'color', label: 'Name colours', hint: 'The colour of your name everywhere it is shown.' },
  { id: 'glow', label: 'Name glows', hint: 'A glow around your name. It works with any colour.' },
  { id: 'frame', label: 'Picture frames', hint: 'A ring around your profile picture.' },
  { id: 'title', label: 'Titles', hint: 'A short title shown under your name.' },
];

/** The two places on a player's profile that everybody sees: a banner behind his name on the profile card, and a pet that stands next to his name. */
export type ProfileSlot = 'banner' | 'pet';

export const PROFILE_SLOTS: readonly { readonly id: ProfileSlot; readonly label: string; readonly hint: string }[] = [
  { id: 'banner', label: 'Profile banners', hint: 'A banner behind your name on your profile card.' },
  { id: 'pet', label: 'Pets', hint: 'A pet that stands next to your name. It starts as an egg and grows as your best daily-goal streak grows.' },
];

/** Any place that is part of how other players see a player. */
export type LookSlot = Slot | ProfileSlot;

/**
 * The five places on a player's OWN screen: how the candles of the price chart are coloured, their shape, what is behind the chart, an extra effect on the chart
 * and the style of the party after a win. Only the player himself sees these. A player has at most one thing in each place.
 */
export type GearSlot = 'candles' | 'shape' | 'backdrop' | 'effect' | 'win';

export const GEAR_SLOTS: readonly { readonly id: GearSlot; readonly label: string; readonly hint: string }[] = [
  { id: 'candles', label: 'Candle colours', hint: 'The colours of the rising and falling candles on your charts.' },
  { id: 'shape', label: 'Candle shapes', hint: 'How the candles are drawn.' },
  { id: 'backdrop', label: 'Chart backgrounds', hint: 'What is behind the candles.' },
  { id: 'effect', label: 'Chart effects', hint: 'An extra touch on your chart. Works with any colour.' },
  { id: 'win', label: 'Win styles', hint: 'The look of the party when you close a trade with a profit or launch a company.' },
];

/** Any place a thing can be worn in. */
export type AnySlot = Slot | ProfileSlot | GearSlot;

/** 1 = Common, 2 = Rare, 3 = Epic, 4 = Legendary. A higher rarity costs more. */
export type Rarity = 1 | 2 | 3 | 4;
export const RARITY_NAMES: readonly string[] = ['', 'Common', 'Rare', 'Epic', 'Legendary'];
/** What each rarity costs, in cents: $2,000, $10,000, $50,000 and $250,000. */
export const RARITY_PRICE_CENTS: readonly number[] = [0, 200_000, 1_000_000, 5_000_000, 25_000_000];

/** How a thing that is not for sale is earned: in ranked 1v1, or in the weekly team race. */
export type EarnKind = 'ranked' | 'team';

export interface CosmeticDef {
  readonly id: string;
  readonly slot: AnySlot;
  readonly rarity: Rarity;
  readonly name: string;
  /** Present on a thing that can NOT be bought: the server gives it to a player who earned it. */
  readonly earn?: EarnKind;
  /** For an earned thing: one plain sentence on how to get it (shown in the Shop). */
  readonly how?: string;
  /**
   * A badge id (src/shared/badgeCatalog.ts) the player must already have before he may buy this. Only a few Legendary things need one, so the best looks
   * stay a sign of something done and not only of money.
   */
  readonly requiresBadge?: string;
}

export const COSMETICS: readonly CosmeticDef[] = [
  // ---- name colours
  { id: 'c_sky', slot: 'color', rarity: 1, name: 'Sky Blue' },
  { id: 'c_mint', slot: 'color', rarity: 1, name: 'Mint' },
  { id: 'c_coral', slot: 'color', rarity: 1, name: 'Coral' },
  { id: 'c_gold', slot: 'color', rarity: 2, name: 'Gold' },
  { id: 'c_violet', slot: 'color', rarity: 2, name: 'Violet' },
  { id: 'c_rose', slot: 'color', rarity: 2, name: 'Rose' },
  { id: 'c_aurora', slot: 'color', rarity: 3, name: 'Aurora' },
  { id: 'c_rainbow', slot: 'color', rarity: 3, name: 'Rainbow' },
  // ---- name glows
  { id: 'g_soft', slot: 'glow', rarity: 2, name: 'Soft Glow' },
  { id: 'g_neon', slot: 'glow', rarity: 3, name: 'Neon Glow' },
  { id: 'g_ember', slot: 'glow', rarity: 3, name: 'Ember Glow' },
  { id: 'g_ice', slot: 'glow', rarity: 3, name: 'Ice Glow' },
  { id: 'g_diamond', slot: 'glow', rarity: 4, name: 'Diamond Shine', requiresBadge: 'profit_100k' },
  // ---- picture frames
  { id: 'f_bronze', slot: 'frame', rarity: 1, name: 'Bronze Ring' },
  { id: 'f_silver', slot: 'frame', rarity: 2, name: 'Silver Ring' },
  { id: 'f_gold', slot: 'frame', rarity: 2, name: 'Gold Ring' },
  { id: 'f_emerald', slot: 'frame', rarity: 3, name: 'Emerald Ring' },
  { id: 'f_ruby', slot: 'frame', rarity: 3, name: 'Ruby Ring' },
  { id: 'f_sapphire', slot: 'frame', rarity: 3, name: 'Sapphire Ring' },
  { id: 'f_diamond', slot: 'frame', rarity: 4, name: 'Diamond Ring', requiresBadge: 'profit_100k' },
  { id: 'f_crown', slot: 'frame', rarity: 4, name: 'Royal Crown', requiresBadge: 'profit_1m' },
  { id: 'f_champion', slot: 'frame', rarity: 4, name: 'Champion Laurel', requiresBadge: 'wins_25' },
  { id: 'f_wizard', slot: 'frame', rarity: 4, name: 'Wizard Aura', requiresBadge: 'lessons_100' },
  // ---- titles (a fixed list: nobody types his own, so there is nothing to moderate)
  { id: 't_watcher', slot: 'title', rarity: 1, name: 'Chart Watcher' },
  { id: 't_dip', slot: 'title', rarity: 1, name: 'Dip Buyer' },
  { id: 't_coffee', slot: 'title', rarity: 1, name: 'Coffee Trader' },
  { id: 't_bull', slot: 'title', rarity: 2, name: 'Bull Runner' },
  { id: 't_steady', slot: 'title', rarity: 2, name: 'Steady Hands' },
  { id: 't_risk', slot: 'title', rarity: 2, name: 'Risk Manager' },
  { id: 't_wizard', slot: 'title', rarity: 3, name: 'Market Wizard' },
  { id: 't_trend', slot: 'title', rarity: 3, name: 'Trend Rider' },
  { id: 't_dealer', slot: 'title', rarity: 3, name: 'Deal Maker' },
  { id: 't_oracle', slot: 'title', rarity: 4, name: 'The Oracle', requiresBadge: 'profit_100k' },
  { id: 't_hof', slot: 'title', rarity: 4, name: 'Hall of Famer', requiresBadge: 'profit_1m' },
  { id: 't_undefeated', slot: 'title', rarity: 4, name: 'Undefeated', requiresBadge: 'wins_25' },
  { id: 't_scholar', slot: 'title', rarity: 4, name: 'Grand Scholar', requiresBadge: 'lessons_100' },
  // ---- profile banners (a strip behind the name on the profile card; drawn with CSS only, so there are no picture files)
  { id: 'bn_dawn', slot: 'banner', rarity: 1, name: 'Dawn' },
  { id: 'bn_ocean', slot: 'banner', rarity: 1, name: 'Ocean Waves' },
  { id: 'bn_pine', slot: 'banner', rarity: 1, name: 'Pine Forest' },
  { id: 'bn_sunset', slot: 'banner', rarity: 2, name: 'Sunset Sky' },
  { id: 'bn_circuit', slot: 'banner', rarity: 2, name: 'Circuit Board' },
  { id: 'bn_stripes', slot: 'banner', rarity: 2, name: 'Candle Stripes' },
  { id: 'bn_aurora', slot: 'banner', rarity: 3, name: 'Aurora Sky' },
  { id: 'bn_galaxy', slot: 'banner', rarity: 3, name: 'Starfield' },
  { id: 'bn_lava', slot: 'banner', rarity: 3, name: 'Lava Flow' },
  { id: 'bn_vault', slot: 'banner', rarity: 4, name: 'Gold Vault', requiresBadge: 'profit_1m' },
  { id: 'bn_champion', slot: 'banner', rarity: 4, name: 'Champion Stripes', requiresBadge: 'wins_25' },
  { id: 'bn_library', slot: 'banner', rarity: 4, name: 'Grand Library', requiresBadge: 'lessons_100' },
  // ---- pets (src/shared/petCatalog.ts has the pictures of each growth stage)
  { id: 'p_chick', slot: 'pet', rarity: 1, name: 'Chick' },
  { id: 'p_pup', slot: 'pet', rarity: 1, name: 'Pup' },
  { id: 'p_kitten', slot: 'pet', rarity: 1, name: 'Kitten' },
  { id: 'p_bunny', slot: 'pet', rarity: 2, name: 'Bunny' },
  { id: 'p_fox', slot: 'pet', rarity: 2, name: 'Fox' },
  { id: 'p_panda', slot: 'pet', rarity: 2, name: 'Panda' },
  { id: 'p_dragon', slot: 'pet', rarity: 3, name: 'Dragon' },
  { id: 'p_shark', slot: 'pet', rarity: 3, name: 'Shark' },
  { id: 'p_phoenix', slot: 'pet', rarity: 4, name: 'Phoenix', requiresBadge: 'streak_7' },
  { id: 'p_bull', slot: 'pet', rarity: 4, name: 'Golden Bull', requiresBadge: 'profit_1m' },
  // ---- for your own screen: candle colours (the rising colour first, then the falling one)
  { id: 'cc_ocean', slot: 'candles', rarity: 1, name: 'Ocean' },
  { id: 'cc_mono', slot: 'candles', rarity: 1, name: 'Black and White' },
  { id: 'cc_pastel', slot: 'candles', rarity: 1, name: 'Pastel' },
  { id: 'cc_neon', slot: 'candles', rarity: 2, name: 'Neon' },
  { id: 'cc_goldsilver', slot: 'candles', rarity: 2, name: 'Gold and Silver' },
  { id: 'cc_sunset', slot: 'candles', rarity: 2, name: 'Sunset' },
  { id: 'cc_aurora', slot: 'candles', rarity: 3, name: 'Aurora' },
  { id: 'cc_rainbow', slot: 'candles', rarity: 3, name: 'Rainbow' },
  { id: 'cc_diamond', slot: 'candles', rarity: 4, name: 'Diamond', requiresBadge: 'profit_100k' },
  { id: 'cc_royal', slot: 'candles', rarity: 4, name: 'Royal', requiresBadge: 'profit_1m' },
  // ---- candle shapes
  { id: 'sh_hollow', slot: 'shape', rarity: 1, name: 'Hollow' },
  { id: 'sh_slim', slot: 'shape', rarity: 1, name: 'Slim' },
  { id: 'sh_rounded', slot: 'shape', rarity: 2, name: 'Rounded' },
  { id: 'sh_boldwick', slot: 'shape', rarity: 2, name: 'Bold Wicks' },
  { id: 'sh_ghost', slot: 'shape', rarity: 3, name: 'Ghost' },
  { id: 'sh_crystal', slot: 'shape', rarity: 4, name: 'Crystal', requiresBadge: 'lessons_100' },
  // ---- chart backgrounds
  { id: 'bg_midnight', slot: 'backdrop', rarity: 1, name: 'Midnight Blue' },
  { id: 'bg_paper', slot: 'backdrop', rarity: 1, name: 'Graph Paper' },
  { id: 'bg_matrix', slot: 'backdrop', rarity: 2, name: 'Green Code' },
  { id: 'bg_dusk', slot: 'backdrop', rarity: 2, name: 'Dusk' },
  { id: 'bg_galaxy', slot: 'backdrop', rarity: 3, name: 'Galaxy' },
  { id: 'bg_lights', slot: 'backdrop', rarity: 3, name: 'Northern Lights' },
  { id: 'bg_vault', slot: 'backdrop', rarity: 4, name: 'Gold Vault', requiresBadge: 'profit_1m' },
  // ---- chart effects
  { id: 'fx_glow', slot: 'effect', rarity: 2, name: 'Candle Glow' },
  { id: 'fx_pulse', slot: 'effect', rarity: 2, name: 'Heartbeat' },
  { id: 'fx_neon', slot: 'effect', rarity: 3, name: 'Neon Price Line' },
  { id: 'fx_flame', slot: 'effect', rarity: 3, name: 'Fire Candle' },
  { id: 'fx_sparkle', slot: 'effect', rarity: 4, name: 'Diamond Sparkle', requiresBadge: 'wins_25' },
  // ---- win styles
  { id: 'ws_gold', slot: 'win', rarity: 1, name: 'Gold Rain' },
  { id: 'ws_candy', slot: 'win', rarity: 1, name: 'Candy Pop' },
  { id: 'ws_coins', slot: 'win', rarity: 2, name: 'Coin Shower' },
  { id: 'ws_stars', slot: 'win', rarity: 2, name: 'Star Burst' },
  { id: 'ws_fireworks', slot: 'win', rarity: 3, name: 'Fireworks' },
  { id: 'ws_neon', slot: 'win', rarity: 3, name: 'Neon Night' },
  { id: 'ws_diamond', slot: 'win', rarity: 4, name: 'Diamond Rain', requiresBadge: 'profit_100k' },
  { id: 'ws_royal', slot: 'win', rarity: 4, name: 'Royal Crown', requiresBadge: 'profit_1m' },
  // ---- earned, not sold (docs/world.md §34). The league looks are given at the end of a ranked season to a player who reached the tier that season (with at least 5 ranked
  // matches); the season looks to the top places of the season; the team looks to the members of the team that won the week. They cost nothing and cannot be bought.
  { id: 'f_lg_gold', slot: 'frame', rarity: 3, name: 'Gold League Ring', earn: 'ranked', how: 'Reach Gold in a ranked season (at least 5 ranked matches).' },
  { id: 'f_lg_plat', slot: 'frame', rarity: 3, name: 'Platinum League Ring', earn: 'ranked', how: 'Reach Platinum in a ranked season (at least 5 ranked matches).' },
  { id: 'f_lg_diamond', slot: 'frame', rarity: 4, name: 'Diamond League Ring', earn: 'ranked', how: 'Reach Diamond in a ranked season (at least 5 ranked matches).' },
  { id: 'f_season', slot: 'frame', rarity: 4, name: 'Season Champion Ring', earn: 'ranked', how: 'Finish a ranked season in 1st place.' },
  { id: 't_lg_gold', slot: 'title', rarity: 3, name: 'Gold League', earn: 'ranked', how: 'Reach Gold in a ranked season (at least 5 ranked matches).' },
  { id: 't_lg_plat', slot: 'title', rarity: 3, name: 'Platinum League', earn: 'ranked', how: 'Reach Platinum in a ranked season (at least 5 ranked matches).' },
  { id: 't_lg_diamond', slot: 'title', rarity: 4, name: 'Diamond League', earn: 'ranked', how: 'Reach Diamond in a ranked season (at least 5 ranked matches).' },
  { id: 't_podium', slot: 'title', rarity: 3, name: 'Season Podium', earn: 'ranked', how: 'Finish a ranked season in the top 3.' },
  { id: 't_season', slot: 'title', rarity: 4, name: 'Season Champion', earn: 'ranked', how: 'Finish a ranked season in 1st place.' },
  { id: 'bn_lg_gold', slot: 'banner', rarity: 3, name: 'Gold League', earn: 'ranked', how: 'Reach Gold in a ranked season (at least 5 ranked matches).' },
  { id: 'bn_lg_plat', slot: 'banner', rarity: 3, name: 'Platinum League', earn: 'ranked', how: 'Reach Platinum in a ranked season (at least 5 ranked matches).' },
  { id: 'bn_lg_diamond', slot: 'banner', rarity: 4, name: 'Diamond League', earn: 'ranked', how: 'Reach Diamond in a ranked season (at least 5 ranked matches).' },
  { id: 'bn_season', slot: 'banner', rarity: 4, name: 'Season Champion', earn: 'ranked', how: 'Finish a ranked season in 1st place.' },
  { id: 't_team', slot: 'title', rarity: 4, name: 'Team Champion', earn: 'team', how: 'Be in the team that wins the weekly team race.' },
  { id: 'bn_team', slot: 'banner', rarity: 4, name: 'Team Champion', earn: 'team', how: 'Be in the team that wins the weekly team race.' },
];

/** The things that can be bought (everything except the earned ones). */
export const FOR_SALE: readonly CosmeticDef[] = COSMETICS.filter((c) => c.earn === undefined);

/** The looks a player earns by reaching a ranked tier: the tier id and the ids he is given. */
export const LEAGUE_LOOKS: readonly { readonly tier: 'gold' | 'platinum' | 'diamond'; readonly items: readonly string[] }[] = [
  { tier: 'gold', items: ['f_lg_gold', 't_lg_gold', 'bn_lg_gold'] },
  { tier: 'platinum', items: ['f_lg_plat', 't_lg_plat', 'bn_lg_plat'] },
  { tier: 'diamond', items: ['f_lg_diamond', 't_lg_diamond', 'bn_lg_diamond'] },
];
/** What the 1st place of a ranked season is given, what any of the top three is given, and what each member of the winning team of a week is given. */
export const SEASON_CHAMPION_LOOKS: readonly string[] = ['f_season', 't_season', 'bn_season'];
export const SEASON_PODIUM_LOOKS: readonly string[] = ['t_podium'];
export const TEAM_CHAMPION_LOOKS: readonly string[] = ['t_team', 'bn_team'];

const BY_ID: ReadonlyMap<string, CosmeticDef> = new Map(COSMETICS.map((c) => [c.id, c]));

export function cosmeticById(id: string): CosmeticDef | undefined {
  return BY_ID.get(id);
}

/** What a cosmetic costs, in cents. */
export function priceOf(def: CosmeticDef): number {
  return RARITY_PRICE_CENTS[def.rarity] as number;
}

export function isSlot(value: unknown): value is Slot {
  return value === 'color' || value === 'glow' || value === 'frame' || value === 'title';
}

export function isProfileSlot(value: unknown): value is ProfileSlot {
  return value === 'banner' || value === 'pet';
}

/** The places that are part of how others see a player: the four of the name and the two of the profile. */
export function isLookSlot(value: unknown): value is LookSlot {
  return isSlot(value) || isProfileSlot(value);
}

export function isGearSlot(value: unknown): value is GearSlot {
  return value === 'candles' || value === 'shape' || value === 'backdrop' || value === 'effect' || value === 'win';
}

/** The words of every place, for messages ("color, glow, frame, title, candles, shape, backdrop, effect or win"). */
export const ALL_SLOT_IDS: readonly AnySlot[] = ['color', 'glow', 'frame', 'title', 'banner', 'pet', 'candles', 'shape', 'backdrop', 'effect', 'win'];

/** What a player wears now: the id of the thing in each place, or nothing. */
export interface Look {
  readonly color?: string;
  readonly glow?: string;
  readonly frame?: string;
  readonly title?: string;
  readonly banner?: string;
  readonly pet?: string;
  /** How far the pet has grown (0 = egg … 4 = legend). The server works it out from the best streak; it is there only when a pet is worn. */
  readonly petStage?: number;
}

export const EMPTY_LOOK: Look = Object.freeze({});

/** True when nothing is worn. */
export function lookIsEmpty(look: Look | null | undefined): boolean {
  return !look || (look.color === undefined && look.glow === undefined && look.frame === undefined && look.title === undefined && look.banner === undefined && look.pet === undefined);
}

const LOOK_KEYS = ['color', 'glow', 'frame', 'title', 'banner', 'pet'] as const;

/** The ids in a look that are really in the catalog for their place (anything else is ignored, so an old or made-up id draws nothing and breaks nothing). */
export function cleanLook(raw: unknown): Look {
  if (!raw || typeof raw !== 'object') return EMPTY_LOOK;
  const out: { color?: string; glow?: string; frame?: string; title?: string; banner?: string; pet?: string; petStage?: number } = {};
  for (const slot of LOOK_KEYS) {
    const id = (raw as Record<string, unknown>)[slot];
    if (typeof id !== 'string') continue;
    const def = cosmeticById(id);
    if (def && def.slot === slot) out[slot] = id;
  }
  if (out.pet !== undefined) out.petStage = cleanStage((raw as Record<string, unknown>).petStage);
  return out;
}

/** The title text of a look, or null. */
export function titleOf(look: Look | null | undefined): string | null {
  const id = look?.title;
  const def = id ? cosmeticById(id) : undefined;
  return def && def.slot === 'title' ? def.name : null;
}

/** The CSS classes of a name: its colour and its glow (src/styles.css, ".cos-..."). */
export function nameClasses(look: Look | null | undefined): string {
  const c = cleanLook(look);
  return [c.color ? `cos-${c.color}` : '', c.glow ? `cos-${c.glow}` : ''].filter(Boolean).join(' ');
}

/** The CSS class of a picture frame, or ''. */
export function frameClass(look: Look | null | undefined): string {
  const c = cleanLook(look);
  return c.frame ? `cos-${c.frame}` : '';
}

/** The CSS class of a profile banner, or ''. */
export function bannerClass(look: Look | null | undefined): string {
  const c = cleanLook(look);
  return c.banner ? `cos-${c.banner}` : '';
}

/** "$2,000" for 200000 cents. */
export function priceText(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString('en-US')}`;
}

// ---- the things for your own screen ---------------------------------------------------------------------------------------------

/** What a player has on his own screen now: the id of the thing in each place, or nothing. */
export interface Gear {
  readonly candles?: string;
  readonly shape?: string;
  readonly backdrop?: string;
  readonly effect?: string;
  readonly win?: string;
}

export const EMPTY_GEAR: Gear = Object.freeze({});

const GEAR_KEYS = ['candles', 'shape', 'backdrop', 'effect', 'win'] as const;

/** True when nothing is on. */
export function gearIsEmpty(gear: Gear | null | undefined): boolean {
  return !gear || GEAR_KEYS.every((k) => gear[k] === undefined);
}

/** The ids in a gear object that are really in the catalog for their place (anything else is ignored, so an old or made-up id draws nothing and breaks nothing). */
export function cleanGear(raw: unknown): Gear {
  if (!raw || typeof raw !== 'object') return EMPTY_GEAR;
  const out: { candles?: string; shape?: string; backdrop?: string; effect?: string; win?: string } = {};
  for (const slot of GEAR_KEYS) {
    const id = (raw as Record<string, unknown>)[slot];
    if (typeof id !== 'string') continue;
    const def = cosmeticById(id);
    if (def && def.slot === slot) out[slot] = id;
  }
  return out;
}

/** The CSS classes a price chart gets from the gear: colours, shape, background and effect (src/styles.css, ".cos-..."). A win style is not a chart class. */
export function chartClasses(gear: Gear | null | undefined): string {
  const g = cleanGear(gear);
  return [g.candles, g.shape, g.backdrop, g.effect]
    .filter((id): id is string => id !== undefined)
    .map((id) => `cos-${id}`)
    .join(' ');
}
