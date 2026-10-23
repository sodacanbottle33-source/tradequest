// Small pure helpers for the Players screen: the words it shows. The numbers (ranks, net worths, who is a friend) all come from the server.
import type { BoardScope, Leaderboard, Relation } from './types';

/** What the action button of a player's line says. */
export function relationLabel(relation: Relation): string {
  switch (relation) {
    case 'you':
      return 'You';
    case 'friend':
      return 'Friends';
    case 'outgoing':
      return 'Request sent';
    case 'incoming':
      return 'Wants to be friends';
    default:
      return 'Add friend';
  }
}

/** 1234 → "1,234". */
function count(n: number): string {
  return n.toLocaleString('en-US');
}

/** The sentence above the leaderboard that says where you stand. */
export function standingText(me: Leaderboard['me'], total: number, scope: BoardScope, size: number, isOwner: boolean): string {
  if (!me) {
    return isOwner
      ? 'You are the owner, so you are not ranked. Players see the others, never you.'
      : total === 0
        ? 'Nobody is ranked yet.'
        : 'You are not ranked right now.';
  }
  if (scope === 'friends') {
    if (total === 1) return 'You are the only one here. Add friends to compare.';
    return me.rank === 1 ? `You are first among you and your friends (${count(total)} in all).` : `You are #${count(me.rank)} of ${count(total)} (you and your friends).`;
  }
  return me.inTop ? `You are #${count(me.rank)} of ${count(total)} players.` : `You are #${count(me.rank)} of ${count(total)} players, outside the top ${count(size)}.`;
}

/** The note under the board: how many are shown. */
export function shownText(shown: number, total: number): string {
  return shown < total ? `Top ${count(shown)} of ${count(total)}` : `${count(total)} ${total === 1 ? 'player' : 'players'}`;
}

/** The message of a failed request. */
export function problemText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
