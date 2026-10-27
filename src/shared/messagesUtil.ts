// Small pure helpers for the private-chat screens: the words and numbers they show. The rules (who may write to whom, how fast, what is hidden)
// are the server's; the page only shows what the server answered.
import type { FriendEntry, MessagesView, PictureState, PmConversation, PmRequest } from './types';

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
  return `${who}${pictureWords(last)}`;
}

/** What a list shows for a message: its words, and "(picture)" when it carries one. */
export function pictureWords(message: { text: string; picture: PictureState | null }): string {
  if (message.picture === null) return previewOf(message.text);
  return message.text === '' ? '(picture)' : `(picture) ${previewOf(message.text, 60)}`;
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

/** The friends whose name has the typed words in it (an empty search shows all of them). */
export function filterFriends(friends: readonly FriendEntry[], search: string): FriendEntry[] {
  const q = search.trim().toLowerCase();
  return q === '' ? [...friends] : friends.filter((f) => f.displayName.toLowerCase().includes(q) || f.username.toLowerCase().includes(q));
}

/** Ticks or unticks one friend in the invite list; the list never grows past the room left in the group. */
export function togglePicked(picked: readonly string[], username: string, roomLeft: number): string[] {
  if (picked.includes(username)) return picked.filter((u) => u !== username);
  return picked.length >= roomLeft ? [...picked] : [...picked, username];
}

/** "Pick everybody": the shown friends, as many as the group has room for. */
export function pickEverybody(shown: readonly FriendEntry[], roomLeft: number): string[] {
  return shown.slice(0, Math.max(0, roomLeft)).map((f) => f.username);
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
