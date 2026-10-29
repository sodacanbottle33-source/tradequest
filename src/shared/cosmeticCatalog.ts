// The Shop's things to wear (docs/world.md §29) and the things for your own screen (§30): what each one is called, which kind it is, how rare it is and so what
// it costs. This file is only data: the server decides who may buy and wear what (server/cosmetics.ts), and the screens only show what the server says. A cosmetic
// is for looks. It gives no money, no advantage in trading and changes no price; the money spent is gone (like the cost of a new username), so spending lowers a
// player's net worth and rank.
//
// There are two groups. The four "things to wear" (name colour, glow, picture frame, title) are seen by everybody. The five "things for your screen" (candle colours,
// candle shapes, chart backgrounds, chart effects and win styles) are seen by the player who owns them and by nobody else.

/** The four places on a player: the colour of his name, a glow around the name, a ring around his picture and a title under his name. A player wears at most one thing in each place. */
export type Slot = 'color' | 'glow' | 'frame' | 'title';

export const SLOTS: readonly { readonly id: Slot; readonly label: string; readonly hint: string }[] = [
  { id: 'color', label: 'Name colours', hint: 'The colour of your name everywhere it is shown.' },
  { id: 'glow', label: 'Name glows', hint: 'A glow around your name. It works with any colour.' },
  { id: 'frame', label: 'Picture frames', hint: 'A ring around your profile picture.' },
  { id: 'title', label: 'Titles', hint: 'A short title shown under your name.' },
];

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
export type AnySlot = Slot | GearSlot;

/** 1 = Common, 2 = Rare, 3 = Epic, 4 = Legendary. A higher rarity costs more. */
export type Rarity = 1 | 2 | 3 | 4;
export const RARITY_NAMES: readonly string[] = ['', 'Common', 'Rare', 'Epic', 'Legendary'];
/** What each rarity costs, in cents: $2,000, $10,000, $50,000 and $250,000. */
export const RARITY_PRICE_CENTS: readonly number[] = [0, 200_000, 1_000_000, 5_000_000, 25_000_000];

export interface CosmeticDef {
  readonly id: string;
  readonly slot: AnySlot;
  readonly rarity: Rarity;
  readonly name: string;
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
];

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

export function isGearSlot(value: unknown): value is GearSlot {
  return value === 'candles' || value === 'shape' || value === 'backdrop' || value === 'effect' || value === 'win';
}

/** The words of every place, for messages ("color, glow, frame, title, candles, shape, backdrop, effect or win"). */
export const ALL_SLOT_IDS: readonly AnySlot[] = ['color', 'glow', 'frame', 'title', 'candles', 'shape', 'backdrop', 'effect', 'win'];

/** What a player wears now: the id of the thing in each place, or nothing. */
export interface Look {
  readonly color?: string;
  readonly glow?: string;
  readonly frame?: string;
  readonly title?: string;
}

export const EMPTY_LOOK: Look = Object.freeze({});

/** True when nothing is worn. */
export function lookIsEmpty(look: Look | null | undefined): boolean {
  return !look || (look.color === undefined && look.glow === undefined && look.frame === undefined && look.title === undefined);
}

/** The ids in a look that are really in the catalog for their place (anything else is ignored, so an old or made-up id draws nothing and breaks nothing). */
export function cleanLook(raw: unknown): Look {
  if (!raw || typeof raw !== 'object') return EMPTY_LOOK;
  const out: { color?: string; glow?: string; frame?: string; title?: string } = {};
  for (const slot of ['color', 'glow', 'frame', 'title'] as const) {
    const id = (raw as Record<string, unknown>)[slot];
    if (typeof id !== 'string') continue;
    const def = cosmeticById(id);
    if (def && def.slot === slot) out[slot] = id;
  }
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
