// Small pure helpers for the comment screens: the words and the small decisions they show. The rules (who may write, how fast, how long a comment can be, what is
// removed, who may delete what) are the server's; the page only shows what the server answered and hides the buttons the server would refuse.
import type { CommentItem, CommentLine, Role } from './types';

/** How often an open comment list asks the server for new comments. */
export const COMMENT_REFRESH_MS = 30_000;

/** How long ago something was written, in words: "just now", "5 min ago", "3 h ago", "2 days ago". */
export function agoText(nowMs: number, thenMs: number): string {
  const seconds = Math.max(0, Math.floor((nowMs - thenMs) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${Math.max(1, minutes)} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** "1 answer", "3 answers". */
export function answersText(count: number): string {
  return `${count} ${count === 1 ? 'answer' : 'answers'}`;
}

/** "1 comment", "12 comments". */
export function commentsText(count: number): string {
  return `${count} ${count === 1 ? 'comment' : 'comments'}`;
}

export interface Viewer {
  readonly signedIn: boolean;
  readonly role: Role;
}

/** Whether the Report button is shown: not on your own comment, not on the owner's, and not for staff (who act on ordinary players) except a moderator on another moderator's. */
export function canReportComment(line: Pick<CommentLine, 'mine' | 'role'>, viewer: Viewer): boolean {
  if (!viewer.signedIn || line.mine || line.role === 'owner') return false;
  const staff = viewer.role === 'owner' || viewer.role === 'moderator';
  return !staff || (viewer.role !== 'owner' && line.role === 'moderator');
}

/** Whether the Moderate button is shown: staff only, never on yourself; a moderator works on ordinary players only, the owner on everybody. */
export function canModerateComment(line: Pick<CommentLine, 'mine' | 'role'>, viewer: Viewer): boolean {
  if (!viewer.signedIn || line.mine) return false;
  if (viewer.role === 'owner') return true;
  return viewer.role === 'moderator' && line.role === 'player';
}

/** Whether the like button can be pressed (nobody likes his own comment; a signed-out visitor cannot like). */
export function canLikeComment(line: Pick<CommentLine, 'mine'>, viewer: Viewer): boolean {
  return viewer.signedIn && !line.mine;
}

/** The comment list as the page shows it: the newest page from the server, then the older pages the reader asked for (nothing twice, newest first). */
export function joinPages(first: readonly CommentItem[], older: readonly CommentItem[]): CommentItem[] {
  const seen = new Set(first.map((c) => c.id));
  const smallest = first.length === 0 ? Number.MAX_SAFE_INTEGER : Math.min(...first.map((c) => c.id));
  const rest = older.filter((c) => {
    if (seen.has(c.id) || c.id >= smallest) return false;
    seen.add(c.id);
    return true;
  });
  return [...first, ...rest];
}

/** The same comment after the reader pressed like: the server's count, his own mark. */
export function withLike<T extends CommentLine>(line: T, liked: boolean, likes: number): T {
  return { ...line, liked, likes };
}
