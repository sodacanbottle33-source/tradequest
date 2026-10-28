// The Shop's things to wear (docs/world.md §29): what each one is called, which kind it is, how rare it is and so what it costs. This file is only data: the
// server decides who may buy and wear what (server/cosmetics.ts), and the screens only show what the server says. A cosmetic is for looks. It gives no money,
// no advantage in trading and changes no price; the money spent is gone (like the cost of a new username), so spending lowers a player's net worth and rank.

/** The four places on a player: the colour of his name, a glow around the name, a ring around his picture and a title under his name. A player wears at most one thing in each place. */
export type Slot = 'color' | 'glow' | 'frame' | 'title';

export const SLOTS: readonly { readonly id: Slot; readonly label: string; readonly hint: string }[] = [
  { id: 'color', label: 'Name colours', hint: 'The colour of your name everywhere it is shown.' },
  { id: 'glow', label: 'Name glows', hint: 'A glow around your name. It works with any colour.' },
  { id: 'frame', label: 'Picture frames', hint: 'A ring around your profile picture.' },
  { id: 'title', label: 'Titles', hint: 'A short title shown under your name.' },
];

/** 1 = Common, 2 = Rare, 3 = Epic, 4 = Legendary. A higher rarity costs more. */
export type Rarity = 1 | 2 | 3 | 4;
export const RARITY_NAMES: readonly string[] = ['', 'Common', 'Rare', 'Epic', 'Legendary'];
/** What each rarity costs, in cents: $2,000, $10,000, $50,000 and $250,000. */
export const RARITY_PRICE_CENTS: readonly number[] = [0, 200_000, 1_000_000, 5_000_000, 25_000_000];

export interface CosmeticDef {
  readonly id: string;
  readonly slot: Slot;
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
