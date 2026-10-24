// Small pure helpers for the private-chat screens: the words and numbers they show. The rules (who may write to whom, how fast, what is hidden)
// are the server's; the page only shows what the server answered.
import type { FriendEntry, MessagesView, PmConversation, PmRequest } from './types';

/** The number shown on the Messages tab: unread messages in your conversations plus requests and invitations waiting for an answer. */
export function pmBadge(view: MessagesView | null): number {
  return view ? view.unread + view.requests.length : 0;
}

/** The start of a message, on one line, for a list. */
export function previewOf(text: string, max = 70): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

/** "You, bob, carol" — the players in a group, you first. */
export function membersLine(conversation: PmConversation, me: string): string {
  const names = conversation.members.map((m) => (m.username === me ? 'You' : m.displayName));
  names.sort((a, b) => (a === 'You' ? -1 : b === 'You' ? 1 : 0));
  return names.join(', ');
}

/** What a line of the conversation list says about the newest message. */
export function lastLine(conversation: PmConversation, me: string): string {
  const last = conversation.last;
  if (!last) return 'No messages yet';
  const who = last.username === me ? 'You: ' : conversation.kind === 'group' ? `${last.displayName}: ` : '';
  return `${who}${previewOf(last.text)}`;
}

/** The sentence above a message request or a group invitation. */
export function requestTitle(request: PmRequest): string {
  return request.kind === 'message' ? `${request.from.displayName} wants to message you` : `${request.from.displayName} invited you to the group "${request.title}"`;
}

/** The friends who can still be invited to a group (not in it and not invited yet). */
export function friendsToInvite(friends: readonly FriendEntry[], conversation: PmConversation): FriendEntry[] {
  const taken = new Set([...conversation.members, ...conversation.invited].map((p) => p.username));
  return friends.filter((f) => !taken.has(f.username));
}

/** The time of a message: the hour for today, the day for older ones. */
export function whenLabel(ms: number, nowMs: number): string {
  const d = new Date(ms);
  const n = new Date(nowMs);
  if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
