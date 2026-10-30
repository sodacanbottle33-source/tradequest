// Pets (docs/world.md §34). A pet is a look like a name colour: bought in the Shop, worn next to the player's name and shown on his profile card. A pet starts as an egg and
// GROWS with the best streak of daily goals the player has ever had (docs/world.md §32): it hatches at 3 days in a row and grows again at 7, 14 and 30. The growth is
// worked out from the best streak (not the current one), so a pet never shrinks when a streak ends. This file is only data and two small functions; the server tells
// every page the stage, and the screens only draw what they are told. A pet gives no money and no advantage of any kind.

/** The best streak (in days) a pet needs for stage 0 (egg), 1 (baby), 2 (young), 3 (grown) and 4 (legend). */
export const PET_STAGE_DAYS: readonly number[] = [0, 3, 7, 14, 30];
export const PET_STAGE_NAMES: readonly string[] = ['Egg', 'Baby', 'Young', 'Grown', 'Legend'];
export const PET_MAX_STAGE = PET_STAGE_DAYS.length - 1;
/** What every pet looks like before it hatches. */
export const PET_EGG = '🥚';

export interface PetDef {
  readonly id: string;
  readonly name: string;
  /** What the pet looks like at stages 1, 2, 3 and 4 (one picture each). */
  readonly forms: readonly [string, string, string, string];
}

/** The pets, keyed by the id of their Shop entry (src/shared/cosmeticCatalog.ts). */
export const PETS: readonly PetDef[] = [
  { id: 'p_chick', name: 'Chick', forms: ['🐣', '🐥', '🐤', '🐔'] },
  { id: 'p_pup', name: 'Pup', forms: ['🐶', '🐕', '🦮', '🐺'] },
  { id: 'p_kitten', name: 'Kitten', forms: ['🐱', '🐈', '🐆', '🦁'] },
  { id: 'p_bunny', name: 'Bunny', forms: ['🐰', '🐇', '🦌', '🦄'] },
  { id: 'p_fox', name: 'Fox', forms: ['🦊', '🦝', '🐻', '🐲'] },
  { id: 'p_panda', name: 'Panda', forms: ['🐼', '🐨', '🦥', '🦬'] },
  { id: 'p_dragon', name: 'Dragon', forms: ['🦎', '🐊', '🐲', '🐉'] },
  { id: 'p_shark', name: 'Shark', forms: ['🐟', '🐠', '🐬', '🦈'] },
  { id: 'p_phoenix', name: 'Phoenix', forms: ['🐦', '🦅', '🦚', '🔥'] },
  { id: 'p_bull', name: 'Golden Bull', forms: ['🐮', '🐂', '🦬', '👑'] },
];

const BY_ID: ReadonlyMap<string, PetDef> = new Map(PETS.map((p) => [p.id, p]));

export function petById(id: string | undefined | null): PetDef | undefined {
  return id ? BY_ID.get(id) : undefined;
}

/** The growth stage (0 … 4) of a pet whose owner's best streak is `bestStreak` days. */
export function petStageOf(bestStreak: number): number {
  let stage = 0;
  for (let i = 0; i < PET_STAGE_DAYS.length; i += 1) if (bestStreak >= (PET_STAGE_DAYS[i] as number)) stage = i;
  return stage;
}

/** Whole numbers 0 … 4 only: anything else (a made-up value from outside) counts as an egg. */
export function cleanStage(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= PET_MAX_STAGE ? value : 0;
}

/** The picture of a pet at a stage: the egg before it hatches. */
export function petGlyph(id: string | undefined | null, stage: unknown): string {
  const pet = petById(id);
  if (!pet) return '';
  const s = cleanStage(stage);
  return s === 0 ? PET_EGG : (pet.forms[s - 1] as string);
}

/** "Fox (Young)" for a title or a tooltip. */
export function petLabel(id: string | undefined | null, stage: unknown): string {
  const pet = petById(id);
  if (!pet) return '';
  return `${pet.name} (${PET_STAGE_NAMES[cleanStage(stage)]})`;
}

/** What is next for a pet: "Hatches at a 3-day streak", "Grows at a 14-day streak", or null for a Legend. */
export function petNextText(stage: unknown): string | null {
  const s = cleanStage(stage);
  if (s >= PET_MAX_STAGE) return null;
  const days = PET_STAGE_DAYS[s + 1] as number;
  return s === 0 ? `Hatches when your best streak reaches ${days} days` : `Grows when your best streak reaches ${days} days`;
}
