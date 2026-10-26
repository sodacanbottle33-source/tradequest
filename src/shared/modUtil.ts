// Small pure helpers for the moderators' page: the choices a moderator has and the words it shows. The rules themselves (who may be acted on, how long
// a ban can be, how many an hour) are the server's (docs/world.md §21); the page only offers what the server accepts and shows its answers.
import { whenText } from './adminUtil';

/** A moderator bans for 1 hour, 1 day or 7 days. Only the owner bans for good, so there is no "forever" here. */
export const MOD_BAN_CHOICES: readonly { label: string; hours: number }[] = [
  { label: '1 hour', hours: 1 },
  { label: '1 day', hours: 24 },
  { label: '7 days', hours: 168 },
];

/** A kick is a short ban: the player is signed out and can sign in again after 10 minutes, 1 hour or 1 day. */
export const KICK_CHOICES: readonly { label: string; minutes: number }[] = [
  { label: '10 minutes', minutes: 10 },
  { label: '1 hour', minutes: 60 },
  { label: '1 day', minutes: 24 * 60 },
];

/** What a player's ban or kick is, in a sentence ("Kicked until Oct 26, 19:30: spamming."). */
export function banLine(ban: { untilMs: number | null; reason: string; kind?: 'ban' | 'kick' }): string {
  const what = ban.kind === 'kick' ? 'Kicked' : 'Banned';
  const until = ban.untilMs === null ? ' until the owner lifts it' : ` until ${whenText(ban.untilMs)}`;
  return `${what}${until}${ban.reason ? `: ${ban.reason}` : '.'}`;
}

/** Why a moderator cannot act on this person, or null when he can (an ordinary player). */
export function cannotActOn(role: 'player' | 'moderator' | 'owner'): string | null {
  if (role === 'owner') return 'This is the owner. Moderators cannot kick, ban or mute the owner.';
  if (role === 'moderator') return 'This is a moderator. Moderators cannot kick or ban each other; if one breaks the rules, tell the owner.';
  return null;
}
