// The private-chat screens' own logic: the words they show and what the store does with what the server sends (a message over the live stream,
// our own send, a conversation that went away). The rules are the server's (tests/server-messages.test.ts); here the page must only show them
// right, never invent a message, and never show anything as markup.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { friendsToInvite, lastLine, membersLine, pmBadge, previewOf, requestTitle, whenLabel } from '../src/shared/messagesUtil';
import { MAX_PM_MESSAGES, SharedStore } from '../src/shared/store';
import type { FriendEntry, MessagesView, PmConversation, PmMessage, PmPerson, PmRequest, User } from '../src/shared/types';

const me: User = { id: 1, username: 'alice', displayName: 'alice', role: 'player' };
const person = (username: string, role: 'player' | 'owner' = 'player'): PmPerson => ({ username, displayName: username, role });
const msg = (id: number, username = 'bob', text = `message ${id}`, conversationId = 5): PmMessage => ({ id, conversationId, username, displayName: username, role: 'player', text, createdMs: id * 1000 });
const conv = (patch: Partial<PmConversation> = {}): PmConversation => ({
  id: 5,
  kind: 'direct',
  title: 'bob',
  other: person('bob'),
  members: [person('alice'), person('bob')],
  invited: [],
  creator: null,
  last: null,
  lastMs: 0,
  unread: 0,
  canWrite: true,
  note: null,
  requestState: null,
  friends: true,
  ...patch,
});
const view = (patch: Partial<MessagesView> = {}): MessagesView => ({
  conversations: [],
  requests: [],
  blocked: [],
  unread: 0,
  you: { canWrite: true, reason: null, untilMs: null, message: null },
  limits: { maxLength: 300, minGapMs: 1500, maxGroupMembers: 8, maxGroups: 20, maxGroupTitle: 40 },
  ...patch,
});
const friend = (username: string): FriendEntry => ({ username, displayName: username, role: 'player', netWorthCents: null, rank: null, sinceMs: 0 });

/** A store that is signed in as Alice, without going to a server. */
function signedIn(patch: object = {}): SharedStore {
  const store = new SharedStore();
  (store as unknown as { set(patch: object): void }).set({ user: me, messages: view(), tick: 100, ...patch });
  return store;
}

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}
const realFetch = globalThis.fetch;
afterEach(async () => {
  await new Promise((done) => setTimeout(done, 320)); // a refresh the store scheduled still runs against the stand-in below
  globalThis.fetch = realFetch;
});
/** Answers every request from `answers` (by "METHOD /path"), and records what was asked. */
function server(answers: Record<string, unknown | ((call: Call) => { status: number; body: unknown })>): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = new URL(String(input), 'http://x');
    const call: Call = { method: init?.method ?? 'GET', path: url.pathname, body: init?.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const answer = answers[`${call.method} ${call.path}`];
    const out = typeof answer === 'function' ? (answer as (c: Call) => { status: number; body: unknown })(call) : { status: 200, body: answer ?? view() };
    return new Response(JSON.stringify(out.body), { status: out.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return calls;
}

describe('the words and numbers', () => {
  it('MSGUI-1: the number on the Messages tab is unread messages plus requests and invitations waiting', () => {
    expect(pmBadge(null)).toBe(0);
    expect(pmBadge(view())).toBe(0);
    const request: PmRequest = { kind: 'message', conversationId: 9, from: person('carol'), text: 'hi', sinceMs: 1 };
    const invite: PmRequest = { kind: 'invite', conversationId: 10, title: 'club', from: person('dave'), memberCount: 2, sinceMs: 2 };
    expect(pmBadge(view({ unread: 3, requests: [request, invite] }))).toBe(5);
  });

  it('MSGUI-2: a long message is cut for a list at the character, not in the middle of an emoji; names and previews say who spoke', () => {
    expect(previewOf('short')).toBe('short');
    expect(previewOf('x'.repeat(70))).toBe('x'.repeat(70));
    expect(previewOf('x'.repeat(71))).toBe(`${'x'.repeat(69)}…`);
    expect(previewOf('\u{1F600}'.repeat(80), 10)).toBe(`${'\u{1F600}'.repeat(9)}…`);
    const group = conv({ kind: 'group', title: 'club', other: null, members: [person('bob'), person('alice'), person('carol')], creator: 'alice' });
    expect(membersLine(group, 'alice')).toBe('You, bob, carol');
    expect(lastLine(conv(), 'alice')).toBe('No messages yet');
    expect(lastLine(conv({ last: msg(1, 'alice', 'hello') }), 'alice')).toBe('You: hello');
    expect(lastLine(conv({ last: msg(1, 'bob', 'hello') }), 'alice')).toBe('hello');
    expect(lastLine({ ...group, last: msg(1, 'bob', 'hello') }, 'alice')).toBe('bob: hello');
    expect(requestTitle({ kind: 'message', conversationId: 1, from: person('carol'), text: '', sinceMs: 0 })).toBe('carol wants to message you');
    expect(requestTitle({ kind: 'invite', conversationId: 1, title: 'club', from: person('dave'), memberCount: 2, sinceMs: 0 })).toBe('dave invited you to the group "club"');
  });

  it('MSGUI-3: only friends who are not in the group yet (and not invited) can be invited', () => {
    const group = conv({ kind: 'group', other: null, members: [person('alice'), person('bob')], invited: [person('carol')] });
    expect(friendsToInvite([friend('bob'), friend('carol'), friend('dave'), friend('erin')], group).map((f) => f.username)).toEqual(['dave', 'erin']);
  });

  it('MSGUI-4: a time is the hour for today and the day for older messages', () => {
    const now = Date.UTC(2026, 9, 24, 12, 0);
    expect(whenLabel(Date.UTC(2026, 9, 24, 10, 5), now)).toMatch(/\d{1,2}:\d{2}/);
    expect(whenLabel(Date.UTC(2026, 9, 20, 10, 5), now)).toMatch(/Oct/);
    expect(whenLabel(Date.UTC(2026, 9, 20, 10, 5), now)).not.toMatch(/\d:\d\d/);
  });
});

describe('the store', () => {
  it('MSGUI-5: a message for the conversation on screen shows once, in order, and is read at once; one of my own is not "read" again', async () => {
    const calls = server({});
    const store = signedIn({ pmOpen: 5, pmThread: { id: 5, conversation: conv(), messages: [], more: false } });
    store.addPrivateMessage(5, msg(2));
    store.addPrivateMessage(5, msg(1));
    store.addPrivateMessage(5, msg(2)); // the same message twice: once
    expect(store.getSnapshot().pmThread?.messages.map((m) => m.id)).toEqual([1, 2]);
    store.addPrivateMessage(5, msg(3, 'alice')); // my own, sent from another page
    await new Promise((done) => setTimeout(done, 20));
    const reads = calls.filter((c) => c.path === '/api/messages/read');
    expect(reads.map((c) => c.body)).toEqual([{ conversationId: 5, upToId: 2 }, { conversationId: 5, upToId: 1 }]); // once per new message of somebody else
    expect(store.getSnapshot().pmThread?.messages.map((m) => m.id)).toEqual([1, 2, 3]);
  });

  it('MSGUI-6: a message for another conversation is not shown, not read, and only makes the page ask for the lists (once for a burst)', async () => {
    const calls = server({ 'GET /api/messages': view({ unread: 2, conversations: [conv({ unread: 2 })] }) });
    const store = signedIn({ pmOpen: 5, pmThread: { id: 5, conversation: conv(), messages: [msg(1)], more: false } });
    store.addPrivateMessage(7, msg(10, 'carol', 'hello', 7));
    store.addPrivateMessage(7, msg(11, 'carol', 'hello again', 7));
    store.addPrivateMessage(8, msg(12, 'dave', 'psst', 8));
    expect(store.getSnapshot().pmThread?.messages.map((m) => m.id)).toEqual([1]);
    await new Promise((done) => setTimeout(done, 320));
    expect(calls.filter((c) => c.path === '/api/messages/read')).toEqual([]);
    expect(calls.filter((c) => c.method === 'GET' && c.path === '/api/messages')).toHaveLength(1);
    expect(store.getSnapshot().messages?.unread).toBe(2);
  });

  it('MSGUI-7: nothing is kept for a signed-out visitor, and the page keeps only the newest messages of a conversation', () => {
    const stranger = new SharedStore();
    stranger.addPrivateMessage(5, msg(1));
    stranger.noteSentPrivate({ conversationId: 5, message: msg(1, 'alice'), conversation: conv(), you: view().you });
    expect(stranger.getSnapshot().pmThread).toBeNull();
    expect(stranger.getSnapshot().messages).toBeNull();
    const store = signedIn({ pmOpen: 5, pmThread: { id: 5, conversation: conv(), messages: [], more: false } });
    for (let i = 1; i <= MAX_PM_MESSAGES + 10; i += 1) store.addPrivateMessage(5, msg(i, 'alice'));
    const thread = store.getSnapshot().pmThread;
    expect(thread?.messages).toHaveLength(MAX_PM_MESSAGES);
    expect(thread?.messages[0]?.id).toBe(11);
    expect(thread?.more).toBe(true);
  });

  it('MSGUI-8: after sending, the message shows at once, the conversation opens on screen (also a new one) and the "may I write" answer is the server\'s', async () => {
    server({ 'GET /api/messages/thread/9': { conversation: conv({ id: 9, title: 'carol' }), messages: [msg(1, 'carol', 'old one', 9), msg(2, 'alice', 'hello carol', 9)], more: false } });
    const store = signedIn();
    const waiting = conv({ id: 9, title: 'carol', other: person('carol'), friends: false, canWrite: false, requestState: 'waiting', note: 'carol has not accepted your message yet.' });
    store.noteSentPrivate({ conversationId: 9, message: msg(2, 'alice', 'hello carol', 9), conversation: waiting, you: { canWrite: false, reason: 'new_account', untilMs: 5, message: 'wait' } });
    const now = store.getSnapshot();
    expect(now.pmOpen).toBe(9);
    expect(now.pmThread?.messages.map((m) => m.text)).toEqual(['hello carol']);
    expect(now.pmThread?.conversation.requestState).toBe('waiting');
    expect(now.messages?.you.canWrite).toBe(false);
    // The older messages of a conversation that already existed arrive a moment later, with no duplicate.
    await new Promise((done) => setTimeout(done, 60));
    expect(store.getSnapshot().pmThread?.messages.map((m) => m.text)).toEqual(['old one', 'hello carol']);
  });

  it('MSGUI-9: when the server says something changed, the open conversation is reloaded: new lines come, hidden ones go, older ones already loaded stay', async () => {
    const newest = [msg(60, 'bob'), msg(62, 'alice')];
    server({ 'GET /api/messages/thread/5': { conversation: conv({ unread: 0, note: 'fresh header' }), messages: newest, more: true } });
    const held = [msg(10), msg(11), msg(60, 'bob'), msg(61, 'carol')];
    const store = signedIn({ pmOpen: 5, pmThread: { id: 5, conversation: conv(), messages: held, more: true } });
    store.onPmChanged();
    await new Promise((done) => setTimeout(done, 80));
    const thread = store.getSnapshot().pmThread;
    // 61 is inside the range the server just sent and it no longer lists it (its author was blocked): gone. 62 is new. 10 and 11 are older: kept.
    expect(thread?.messages.map((m) => m.id)).toEqual([10, 11, 60, 62]);
    expect(thread?.conversation.note).toBe('fresh header');
    expect(thread?.more).toBe(true);
  });

  it('MSGUI-10: a conversation that is not there any more (left, removed, closed) leaves the screen empty and the lists are asked again', async () => {
    const calls = server({ 'GET /api/messages/thread/5': () => ({ status: 404, body: { error: { code: 'no_such_conversation', message: 'That conversation is not there.' } } }) });
    const store = signedIn();
    await store.openConversation(5);
    expect(store.getSnapshot().pmOpen).toBeNull();
    expect(store.getSnapshot().pmThread).toBeNull();
    await new Promise((done) => setTimeout(done, 320));
    expect(calls.some((c) => c.method === 'GET' && c.path === '/api/messages')).toBe(true);
    // Opening reads what is unread; closing forgets the conversation.
    const reads = server({ 'GET /api/messages/thread/6': { conversation: conv({ id: 6, unread: 2 }), messages: [msg(1, 'bob', 'a', 6), msg(2, 'bob', 'b', 6)], more: false } });
    await store.openConversation(6);
    expect(store.getSnapshot().pmThread?.messages).toHaveLength(2);
    expect(reads.filter((c) => c.path === '/api/messages/read').map((c) => c.body)).toEqual([{ conversationId: 6 }]);
    await store.openConversation(null);
    expect(store.getSnapshot().pmOpen).toBeNull();
    expect(store.getSnapshot().pmThread).toBeNull();
  });

  it('MSGUI-11: earlier messages are added in front without duplicates, and an answer from the server replaces the lists', async () => {
    server({ 'GET /api/messages/thread/5': { conversation: conv(), messages: [msg(3), msg(4), msg(5)], more: false } });
    const store = signedIn({ pmOpen: 5, pmThread: { id: 5, conversation: conv(), messages: [msg(5), msg(6)], more: true } });
    await store.loadEarlierThread();
    expect(store.getSnapshot().pmThread?.messages.map((m) => m.id)).toEqual([3, 4, 5, 6]);
    expect(store.getSnapshot().pmThread?.more).toBe(false);
    const answer = view({ blocked: [{ username: 'carol', displayName: 'carol', sinceMs: 1 }] });
    store.setMessages(answer);
    expect(store.getSnapshot().messages?.blocked).toHaveLength(1);
    new SharedStore().setMessages(answer); // signed out: ignored
  });

  it('MSGUI-12: "Message" next to a player\'s name asks the Messages screen to open with that player, until it has taken it', () => {
    const store = signedIn();
    store.startCompose('carol');
    expect(store.getSnapshot().pmCompose).toBe('carol');
    store.clearCompose();
    expect(store.getSnapshot().pmCompose).toBeNull();
  });
});

describe('the screens', () => {
  const src = (...parts: string[]): string => readFileSync(resolve(process.cwd(), 'src', ...parts), 'utf8');
  const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('MSGUI-13: messages are shown as text, never as markup, and the screens read nothing of other players\' conversations', () => {
    for (const file of ['MessagesScreen.tsx', 'PmThreadView.tsx', 'messagesUtil.ts', 'AdminChat.tsx']) {
      const text = code(src('shared', file));
      expect([file, text.includes('dangerouslySetInnerHTML')]).toEqual([file, false]);
      expect([file, /\.innerHTML\s*=/.test(text)]).toEqual([file, false]);
    }
    const api = code(src('shared', 'api.ts'));
    // The only private-chat reads are the player's own lists and conversations, and (for the owner) the reports.
    const gets = api.split('\n').filter((l) => l.includes("'GET'") && (l.includes('/api/messages') || l.includes('private-reports')));
    expect(gets.map((l) => /\/api\/(admin\/private-reports|messages(\/thread)?)/.exec(l)?.[0]).sort()).toEqual(['/api/admin/private-reports', '/api/messages', '/api/messages/thread']);
  });

  it('MSGUI-14: the Messages tab, its badge, the "Message" buttons and the live events are all wired in', () => {
    const app = code(src('shared', 'SharedApp.tsx'));
    expect(app).toContain("['messages', 'Messages']");
    expect(app).toContain('<MessagesScreen />');
    expect(app).toContain('data-testid="messages-badge"');
    expect(app).toContain('s.pmCompose');
    const store = code(src('shared', 'store.ts'));
    expect(store).toContain("addEventListener('pm'");
    expect(store).toContain("addEventListener('pm_changed'");
    expect(code(src('shared', 'PlayersScreen.tsx'))).toContain('startCompose');
    expect(code(src('shared', 'ChatScreen.tsx'))).toContain('startCompose');
    const log = code(src('shared', 'AdminLog.tsx'));
    expect(log).toContain("case 'pm_dismiss'");
    expect(code(src('shared', 'AdminChat.tsx'))).toContain('adminPrivateReports');
  });

  it('MSGUI-15: every member of a group gets the invite box (with his own friends); renaming and removing people stay with the creator', () => {
    const view = code(src('shared', 'PmThreadView.tsx'));
    // The list of friends to pick from does not depend on being the creator ...
    const choices = /const inviteChoices = ([^;]*);/.exec(view)?.[1] ?? '';
    expect(choices).toContain("conv.kind === 'group'");
    expect(choices).toContain('friendsToInvite(friends.friends, conv)');
    expect(choices).not.toContain('isCreator');
    // ... the tools box is there for every group member, and the two creator-only tools are each behind the creator check.
    expect(view).toMatch(/\{conv\.kind === 'group' && \(\s*<div className="pm-admin"/);
    expect(view).toMatch(/\{isCreator && \(renaming === null/);
    expect(view).toMatch(/\{isCreator &&\s*\[\.\.\.conv\.members\.filter/);
    expect(view).toContain('data-testid="pm-invite-select"');
    expect(view).toContain('data-testid="pm-member-hint"');
    // The server decides: the member's own friends only.
    const server = code(readFileSync(resolve(process.cwd(), 'server', 'messages.ts'), 'utf8'));
    const invite = /invite\(me: User, conversationId: unknown, username: unknown\)[\s\S]*?\n  }\n/.exec(server)?.[0] ?? '';
    expect(invite).toContain('this.memberGroup(me, conversationId)');
    expect(invite).not.toContain('ownGroup');
    expect(invite).toContain('this.checkCanInvite(me, friend, row.id)');
  });
});
