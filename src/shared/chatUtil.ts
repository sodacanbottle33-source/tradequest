// Small pure helpers for the chat screens: the words and numbers it shows. The rules (who may write, how fast, how long a message can be,
// what is removed) are the server's; the page only shows what the server answered.

/** How long a wait still is, in words ("less than a minute", "3 minutes", "2 hours", "3 days"). */
export function waitWords(ms: number): string {
  if (ms < 60_000) return 'less than a minute';
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 120) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) return `${hours} hours`;
  return `${Math.ceil(hours / 24)} days`;
}

/** The time a message was written, in the reader's own clock: "14:05". */
export function timeLabel(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** How many characters a typed message has, counted as people count them (an emoji is one). */
export function lengthOf(text: string): number {
  return Array.from(text).length;
}

/** The mute times the owner can pick in the chat and in the admin panel. */
export const MUTE_CHOICES: readonly { label: string; minutes: number }[] = [
  { label: '5 min', minutes: 5 },
  { label: '1 hour', minutes: 60 },
  { label: '1 day', minutes: 24 * 60 },
];
