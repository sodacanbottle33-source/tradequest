// Daily goals and the streak (docs/world.md §32): the list of goals, what each pays, the streak's milestones and the arithmetic of a "day". This file is only data and
// pure functions: the server decides what a player has done and pays once (server/daily.ts), and the screens only show what the server says.
// A goal gives a little experience (Learn XP), a little Career cash, a few 1v1 coins and the streak; it never gives an advantage in a trade or a match.

export type GoalGroup = 'market' | 'learn' | 'play';

export interface GoalDef {
  readonly id: string;
  readonly group: GoalGroup;
  readonly icon: string;
  readonly title: string;
  /** One line that says exactly what counts. */
  readonly hint: string;
  /** How many times it has to be done in one day. */
  readonly target: number;
}

export const GOALS: readonly GoalDef[] = [
  { id: 'trade_3', group: 'market', icon: '🛒', title: 'Make 3 trades', hint: 'Buy or sell 3 times in your Career account.', target: 3 },
  { id: 'buy_2', group: 'market', icon: '🧺', title: 'Buy 2 different companies', hint: 'Buy shares or coins of 2 different companies in your Career account.', target: 2 },
  { id: 'profit_1', group: 'market', icon: '💵', title: 'Close a trade with a profit', hint: 'Sell something for more than you paid for it.', target: 1 },
  { id: 'limit_1', group: 'market', icon: '⏱️', title: 'Set a limit order', hint: 'Place an order that waits for the price you choose.', target: 1 },
  { id: 'lesson_1', group: 'learn', icon: '📚', title: 'Finish a lesson', hint: 'Answer one lesson in Learn.', target: 1 },
  { id: 'lesson_3', group: 'learn', icon: '🎓', title: 'Finish 3 lessons', hint: 'Answer 3 lessons in Learn.', target: 3 },
  { id: 'match_1', group: 'play', icon: '⚔️', title: 'Play a 1v1 match', hint: 'Play a 1v1 match to the end (a bot match counts).', target: 1 },
  { id: 'win_1', group: 'play', icon: '🏅', title: 'Win a 1v1 match', hint: 'Win a 1v1 match (a bot match counts).', target: 1 },
];

const BY_ID: ReadonlyMap<string, GoalDef> = new Map(GOALS.map((g) => [g.id, g]));

export function goalById(id: string): GoalDef | undefined {
  return BY_ID.get(id);
}

/** How many goals a day has: one from each group. */
export const GOAL_GROUPS: readonly GoalGroup[] = ['market', 'learn', 'play'];
export const GOALS_PER_DAY = GOAL_GROUPS.length;

/** What a finished goal pays, and the bonus for finishing all of a day's goals. Cash is in cents of Career cash, coins in cents of 1v1 virtual currency. */
export interface Reward {
  readonly xp: number;
  readonly cashCents: number;
  readonly coinCents: number;
}
export const GOAL_REWARD: Reward = { xp: 10, cashCents: 1_000, coinCents: 500 };
export const BONUS_REWARD: Reward = { xp: 10, cashCents: 1_000, coinCents: 500 };

/** A freeze covers one missed day. One is earned every FREEZE_EVERY days of a streak and at most MAX_FREEZES are kept. */
export const FREEZE_EVERY = 7;
export const MAX_FREEZES = 2;

/** A free look for reaching this many days in a row (once, ever). `rarity` is 1 Common, 2 Rare, 3 Epic: the player picks any such thing he does not own (not one that needs a badge). */
export interface Milestone {
  readonly days: number;
  readonly rarity: 1 | 2 | 3;
}
export const STREAK_MILESTONES: readonly Milestone[] = [
  { days: 3, rarity: 1 },
  { days: 7, rarity: 2 },
  { days: 14, rarity: 3 },
  { days: 30, rarity: 3 },
];

export function milestoneOf(days: number): Milestone | undefined {
  return STREAK_MILESTONES.find((m) => m.days === days);
}

// ---- the day --------------------------------------------------------------------------------------------------------------------

export const DAY_MS = 86_400_000;
/** A day starts at 00:00 Tokyo time, like the weekly board. */
const TOKYO_OFFSET_MS = 9 * 3_600_000;

/** The day number (days since 1970-01-01 in Tokyo time) that `ms` falls in. */
export function dayOf(ms: number): number {
  return Math.floor((ms + TOKYO_OFFSET_MS) / DAY_MS);
}

/** The moment a day starts. */
export function dayStartMs(day: number): number {
  return day * DAY_MS - TOKYO_OFFSET_MS;
}

function mix(a: number, b: number): number {
  let x = (Math.imul(a + 1, 0x9e3779b1) ^ Math.imul(b + 7, 0x85ebca6b)) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 0x2c1b3c6d) >>> 0;
  x ^= x >>> 12;
  x = Math.imul(x, 0x297a2d39) >>> 0;
  x ^= x >>> 15;
  return x >>> 0;
}

/** The goals of a day: one from each group, the same for every player, and different from day to day. */
export function goalsOfDay(day: number): string[] {
  return GOAL_GROUPS.map((group, g) => {
    const pool = GOALS.filter((x) => x.group === group);
    return (pool[mix(day, g) % pool.length] as GoalDef).id;
  });
}

/** "+$10 · 10 XP · 5 coins" for the screens. */
export function rewardText(r: Reward): string {
  const parts: string[] = [];
  if (r.cashCents > 0) parts.push(`+$${(r.cashCents / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`);
  if (r.xp > 0) parts.push(`${r.xp} XP`);
  if (r.coinCents > 0) parts.push(`$${(r.coinCents / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} 1v1 coins`);
  return parts.join(' · ');
}
