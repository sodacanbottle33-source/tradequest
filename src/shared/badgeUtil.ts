// Small pure helpers for the Badges page: the words it shows about how rare a badge is and when it was earned.

/** "12% of players", "Less than 1% of players", or "Nobody has it yet". */
export function rarityText(owners: number, players: number): string {
  if (owners <= 0 || players <= 0) return 'Nobody has it yet';
  const pct = (Math.min(owners, players) / players) * 100;
  if (pct < 1) return 'Less than 1% of players';
  return `${Math.round(pct)}% of players`;
}

/** The day a badge was earned: "Oct 26, 2026". */
export function earnedText(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** "You have 7 of 29 badges." */
export function haveText(earned: number, total: number): string {
  return `You have ${earned} of ${total} badges.`;
}
