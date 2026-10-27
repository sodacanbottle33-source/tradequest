// Small pure helpers for the "change your username" panel: the words it shows. The rules (what a name may be, the price, the wait) are the
// server's (server/rename.ts); the page only checks the obvious things before it asks, and shows what the server answered.

/** The letters a username may have: 3 to 20 letters, numbers or underscores (the same rule as at sign-up). */
export const USERNAME_PATTERN = /^[A-Za-z0-9_]{3,20}$/;

/** What is wrong with a typed name, in words for the player, or null when it looks fine (the server decides in the end). */
export function usernameProblem(raw: string, current: string): string | null {
  const name = raw.trim();
  if (name === '') return null; // nothing typed yet: no complaint
  if (name.length < 3) return 'Use at least 3 characters.';
  if (name.length > 20) return 'Use at most 20 characters.';
  if (!USERNAME_PATTERN.test(name)) return 'Use only letters, numbers and underscores (no spaces).';
  if (name === current) return 'That is your username already.';
  return null;
}

/** "1 day 4 hours", "3 hours 5 minutes", "12 minutes": how long until `ms` from `nowMs`, in two parts at most. */
export function waitLabel(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  const unit = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`;
  if (days > 0) return hours > 0 ? `${unit(days, 'day')} ${unit(hours, 'hour')}` : unit(days, 'day');
  if (hours > 0) return mins > 0 ? `${unit(hours, 'hour')} ${unit(mins, 'minute')}` : unit(hours, 'hour');
  return unit(mins, 'minute');
}
