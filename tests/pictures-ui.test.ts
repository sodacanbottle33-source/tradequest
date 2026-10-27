// The screens' own logic for the "little update": pictures in chats (shrinking a photo, the words, the addresses), the quick invite (who can be picked),
// the username page (what a name may be, how long to wait) and what the page does when the live stream says a player changed his name.
// The rules are the server's (tests/server-chat-pictures.test.ts, server-public-groups.test.ts, server-rename.test.ts); here the page only has to show
// them right and keep its lists in step.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CHAT_PICK_MAX_BYTES, CHAT_PIC_SIDE, CHAT_SEND_MAX_BYTES, SHRINK_QUALITIES, SHRINK_SIDES, chatPickProblem, dataUrlBytes, fitSize, shrinkChatPicture } from '../src/shared/chatPictureUtil';
import { pictureUrl } from '../src/shared/ChatPicture';
import { filterFriends, lastLine, pictureWords, pickEverybody, togglePicked } from '../src/shared/messagesUtil';
import { profileStore } from '../src/shared/profileStore';
import { USERNAME_PATTERN, usernameProblem, waitLabel } from '../src/shared/renameUtil';
import { SharedStore } from '../src/shared/store';
import type { FriendEntry, PmConversation, PmMessage, User } from '../src/shared/types';

const friend = (username: string): FriendEntry => ({ username, displayName: username, role: 'player', netWorthCents: null, rank: null, sinceMs: 0 });
const msg = (text: string, picture: PmMessage['picture']): PmMessage => ({ id: 1, conversationId: 5, username: 'bob', displayName: 'bob', role: 'player', text, createdMs: 1000, picture });
const conv = (last: PmMessage | null): PmConversation => ({
  id: 5,
  kind: 'direct',
  title: 'bob',
  other: { username: 'bob', displayName: 'bob', role: 'player' },
  members: [],
  invited: [],
  creator: null,
  visibility: 'private',
  last,
  lastMs: 0,
  unread: 0,
  canWrite: true,
  note: null,
  requestState: null,
  friends: true,
});

describe('shrinking a picture before it is sent', () => {
  it('PICUI-1: a big photo is scaled so its longest side fits, keeping its shape; a small one keeps its size; nothing is ever 0 pixels', () => {
    expect(fitSize(4000, 3000, 800)).toEqual({ width: 800, height: 600 });
    expect(fitSize(3000, 4000, 800)).toEqual({ width: 600, height: 800 });
    expect(fitSize(800, 800, 800)).toEqual({ width: 800, height: 800 });
    expect(fitSize(300, 200, 800)).toEqual({ width: 300, height: 200 });
    expect(fitSize(20000, 10, 800)).toEqual({ width: 800, height: 1 });
    expect(fitSize(0, 0, 800)).toEqual({ width: 1, height: 1 });
    expect(fitSize(640.9, 480.2, 800)).toEqual({ width: 640, height: 480 });
  });

  it('PICUI-2: the size of a picture in a data address is counted from its letters, with the padding taken off', () => {
    expect(dataUrlBytes('data:text/plain;base64,aGVsbG8=')).toBe(5); // "hello"
    expect(dataUrlBytes('data:text/plain;base64,aGVsbA==')).toBe(4); // "hell"
    expect(dataUrlBytes('data:text/plain;base64,aGVsbG8h')).toBe(6); // "hello!"
    expect(dataUrlBytes('data:text/plain;base64,')).toBe(0);
    expect(dataUrlBytes('not an address')).toBe(0);
    const bytes = Buffer.alloc(1000, 7);
    expect(dataUrlBytes(`data:image/jpeg;base64,${bytes.toString('base64')}`)).toBe(1000);
  });

  it('PICUI-3: what the page sends stays under what the server takes (90 KB, 800 px), and the tries go from nice to small', () => {
    expect(CHAT_PIC_SIDE).toBe(800);
    expect(CHAT_SEND_MAX_BYTES).toBeLessThan(90 * 1024);
    expect(SHRINK_SIDES[0]).toBe(CHAT_PIC_SIDE);
    expect([...SHRINK_SIDES].sort((a, b) => b - a)).toEqual([...SHRINK_SIDES]);
    expect([...SHRINK_QUALITIES].sort((a, b) => b - a)).toEqual([...SHRINK_QUALITIES]);
    for (const side of SHRINK_SIDES) expect(side).toBeLessThanOrEqual(800);
    // the same numbers the server uses (server/chatPictures.ts), read from its source so the two cannot drift apart
    const server = readFileSync(resolve(process.cwd(), 'server', 'chatPictures.ts'), 'utf8');
    expect(server).toMatch(/CHAT_PIC_MAX_SIDE\s*=\s*800/);
    expect(server).toMatch(/CHAT_PIC_MAX_BYTES\s*=\s*90\s*\*\s*1024/);
  });

  it('PICUI-4: a file that is not a picture, or is far too big, is refused with words before anything is drawn', async () => {
    expect(chatPickProblem({ type: 'image/png', size: 2_000_000 })).toBeNull();
    expect(chatPickProblem({ type: 'image/jpeg', size: CHAT_PICK_MAX_BYTES })).toBeNull();
    expect(chatPickProblem({ type: 'application/pdf', size: 100 })).toMatch(/picture file/i);
    expect(chatPickProblem({ type: '', size: 100 })).toMatch(/picture file/i);
    expect(chatPickProblem({ type: 'image/png', size: CHAT_PICK_MAX_BYTES + 1 })).toMatch(/too big/i);
    await expect(shrinkChatPicture(new Blob(['hello'], { type: 'text/plain' }))).rejects.toThrow(/picture file/i);
    // a file called an image that the browser cannot open (here: this test has no picture decoder at all) is refused with words too
    await expect(shrinkChatPicture(new Blob(['not really a picture'], { type: 'image/png' }))).rejects.toThrow(/could not be opened/i);
  });
});

describe('where a picture lives and what a list says about it', () => {
  it('PICUI-5: the three kinds of picture have three addresses, all by the message number', () => {
    expect(pictureUrl('chat', 12)).toBe('/api/chat/picture/12');
    expect(pictureUrl('pm', 12)).toBe('/api/messages/picture/12');
    expect(pictureUrl('report', 12)).toBe('/api/admin/private-reports/picture/12');
  });

  it('PICUI-6: a list says "(picture)" for a message with one, and shows the words next to it; an expired picture still says so', () => {
    expect(pictureWords({ text: 'hello', picture: null })).toBe('hello');
    expect(pictureWords({ text: '', picture: 'ok' })).toBe('(picture)');
    expect(pictureWords({ text: 'look at this', picture: 'ok' })).toBe('(picture) look at this');
    expect(pictureWords({ text: '', picture: 'expired' })).toBe('(picture)');
    expect(pictureWords({ text: 'x'.repeat(100), picture: 'ok' })).toBe(`(picture) ${'x'.repeat(59)}…`);
    expect(lastLine(conv(msg('', 'ok')), 'alice')).toBe('(picture)');
    expect(lastLine(conv(msg('hi', 'ok')), 'alice')).toBe('(picture) hi');
    expect(lastLine(conv(msg('hi', null)), 'alice')).toBe('hi');
    expect(lastLine(conv({ ...msg('', 'ok'), username: 'alice' }), 'alice')).toBe('You: (picture)');
  });
});

describe('the quick invite', () => {
  const people = ['ann', 'bob', 'cy', 'dora', 'ed'].map(friend);

  it('PICUI-7: the search finds friends by any part of the name, in any letter case; no words shows everybody', () => {
    expect(filterFriends(people, '').map((f) => f.username)).toEqual(['ann', 'bob', 'cy', 'dora', 'ed']);
    expect(filterFriends(people, '   ').length).toBe(5);
    expect(filterFriends(people, 'O').map((f) => f.username)).toEqual(['bob', 'dora']);
    expect(filterFriends(people, ' ED ').map((f) => f.username)).toEqual(['ed']);
    expect(filterFriends(people, 'zzz')).toEqual([]);
  });

  it('PICUI-8: ticking a friend adds him, ticking again takes him away, and the list never grows past the room the group has', () => {
    let picked: string[] = [];
    picked = togglePicked(picked, 'ann', 2);
    picked = togglePicked(picked, 'bob', 2);
    expect(picked).toEqual(['ann', 'bob']);
    expect(togglePicked(picked, 'cy', 2)).toEqual(['ann', 'bob']); // no room left
    expect(togglePicked(picked, 'ann', 2)).toEqual(['bob']); // taking one away is always possible
    expect(togglePicked([], 'ann', 0)).toEqual([]);
    expect(picked).toEqual(['ann', 'bob']); // the old list is not changed
  });

  it('PICUI-9: "Pick everybody" takes the friends on screen, as many as fit; with no room it takes nobody', () => {
    expect(pickEverybody(people, 10)).toEqual(['ann', 'bob', 'cy', 'dora', 'ed']);
    expect(pickEverybody(people, 3)).toEqual(['ann', 'bob', 'cy']);
    expect(pickEverybody(people, 0)).toEqual([]);
    expect(pickEverybody(people, -4)).toEqual([]);
    expect(pickEverybody([], 5)).toEqual([]);
    expect(pickEverybody(filterFriends(people, 'o'), 5)).toEqual(['bob', 'dora']);
  });
});

describe('the username page', () => {
  it('PICUI-10: a typed name is checked the same way as at sign-up, with words for each mistake; nothing typed is not a complaint', () => {
    expect(usernameProblem('', 'alice')).toBeNull();
    expect(usernameProblem('   ', 'alice')).toBeNull();
    expect(usernameProblem('ab', 'alice')).toMatch(/at least 3/);
    expect(usernameProblem('a'.repeat(21), 'alice')).toMatch(/at most 20/);
    expect(usernameProblem('has space', 'alice')).toMatch(/letters, numbers and underscores/);
    expect(usernameProblem('bad-name', 'alice')).toMatch(/letters, numbers and underscores/);
    expect(usernameProblem('émile', 'alice')).toMatch(/letters, numbers and underscores/);
    expect(usernameProblem('alice', 'alice')).toMatch(/already/);
    expect(usernameProblem('new_name_9', 'alice')).toBeNull();
    expect(usernameProblem('  new_name_9  ', 'alice')).toBeNull(); // the spaces at the ends are cut, as the server does
    expect(USERNAME_PATTERN.test('a'.repeat(20))).toBe(true);
    expect(USERNAME_PATTERN.test('a'.repeat(21))).toBe(false);
    // the same rule as the server's sign-up (server/auth.ts)
    const server = readFileSync(resolve(process.cwd(), 'server', 'auth.ts'), 'utf8');
    expect(server).toContain(String(USERNAME_PATTERN));
  });

  it('PICUI-11: a wait is told in days and hours, hours and minutes, or minutes, never "0", and rounds up', () => {
    expect(waitLabel(7 * 24 * 3_600_000)).toBe('7 days');
    expect(waitLabel(26 * 3_600_000)).toBe('1 day 2 hours');
    expect(waitLabel(25 * 3_600_000 + 5 * 60_000)).toBe('1 day 1 hour'); // two parts at most
    expect(waitLabel(3 * 3_600_000 + 5 * 60_000)).toBe('3 hours 5 minutes');
    expect(waitLabel(2 * 3_600_000)).toBe('2 hours');
    expect(waitLabel(12 * 60_000)).toBe('12 minutes');
    expect(waitLabel(60_000)).toBe('1 minute');
    expect(waitLabel(1)).toBe('1 minute');
    expect(waitLabel(0)).toBe('1 minute');
    expect(waitLabel(-5000)).toBe('1 minute');
    expect(waitLabel(59_001)).toBe('1 minute');
    expect(waitLabel(60_001)).toBe('2 minutes');
  });
});

describe('when a player changes his name', () => {
  interface Call {
    readonly method: string;
    readonly path: string;
  }
  const realFetch = globalThis.fetch;
  afterEach(async () => {
    await new Promise((done) => setTimeout(done, 320)); // refreshes the store scheduled still run against the stand-in
    globalThis.fetch = realFetch;
    profileStore.stop();
  });
  /** Answers by path, and records what was asked. */
  function server(answers: Record<string, unknown>): Call[] {
    const calls: Call[] = [];
    globalThis.fetch = (async (input: unknown, init?: { method?: string }) => {
      const url = new URL(String(input), 'http://x');
      calls.push({ method: init?.method ?? 'GET', path: url.pathname });
      const body = answers[url.pathname] ?? {};
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    return calls;
  }
  const me: User = { id: 1, username: 'alice', displayName: 'alice', role: 'player' };

  it('PICUI-12: his picture and his online dot move to the new name, whatever letter case the old name was kept in; others are left alone', async () => {
    server({ '/api/avatars': { avatars: { Bob: 7, carol: 9 } } });
    await profileStore.start();
    expect(profileStore.getSnapshot().avatars).toEqual({ Bob: 7, carol: 9 });
    (profileStore as unknown as { set(p: object): void }).set({ online: new Set(['bob', 'carol']) });
    let heard = 0;
    const off = profileStore.subscribe(() => (heard += 1));
    profileStore.onRenamed('bob', 'robert');
    expect(profileStore.getSnapshot().avatars).toEqual({ carol: 9, robert: 7 });
    expect([...profileStore.getSnapshot().online].sort()).toEqual(['carol', 'robert']);
    expect(heard).toBe(1);
    profileStore.onRenamed('nobody', 'someone'); // a player with no picture and not online: nothing to move, nobody is told
    expect(heard).toBe(1);
    off();
  });

  it('PICUI-13: when the page is signed out, a rename changes nothing (there is nothing to move)', () => {
    profileStore.stop();
    profileStore.onRenamed('bob', 'robert');
    expect(profileStore.getSnapshot().avatars).toEqual({});
  });

  it('PICUI-14: the stream tells everybody; a page that is not his only refreshes its lists, his own page also asks who he is now', async () => {
    const calls = server({ '/api/me': { user: { ...me, username: 'alicia', displayName: 'alicia' } } });
    const store = new SharedStore();
    (store as unknown as { set(p: object): void }).set({ user: me, tick: 100 });
    (store as unknown as { onUserRenamed(d: { from: string; to: string }): void }).onUserRenamed({ from: 'bob', to: 'robert' });
    await new Promise((done) => setTimeout(done, 30));
    expect(calls.map((c) => c.path)).not.toContain('/api/me');
    expect(calls.map((c) => c.path)).toContain('/api/friends');
    expect(calls.map((c) => c.path)).toContain('/api/chat');
    expect(store.getSnapshot().user?.username).toBe('alice');
    calls.length = 0;
    (store as unknown as { onUserRenamed(d: { from: string; to: string }): void }).onUserRenamed({ from: 'ALICE', to: 'alicia' }); // any letter case
    await new Promise((done) => setTimeout(done, 30));
    expect(calls.map((c) => c.path)).toContain('/api/me');
    expect(store.getSnapshot().user?.username).toBe('alicia');
  });

  it('PICUI-15: when this page changed the name, the answer\'s user is taken at once and the money and lists are fetched again', async () => {
    const calls = server({});
    const store = new SharedStore();
    (store as unknown as { set(p: object): void }).set({ user: me, tick: 100 });
    store.noteRenamed({ id: 1, username: 'alicia', displayName: 'alicia', role: 'player' }, 'alice');
    expect(store.getSnapshot().user?.username).toBe('alicia'); // no waiting for the network
    await new Promise((done) => setTimeout(done, 30));
    const paths = calls.map((c) => c.path);
    expect(paths).toContain('/api/account');
    expect(paths).toContain('/api/friends');
    expect(paths).toContain('/api/chat');
  });
});

describe('the screens are wired', () => {
  const src = (...parts: string[]): string => readFileSync(resolve(process.cwd(), 'src', ...parts), 'utf8');

  it('PICUI-16: the picture button shows only while pictures are on, in all four places a player can chat; a picture is shown from the server, never built into the page', () => {
    for (const file of ['ChatScreen.tsx', 'PmThreadView.tsx']) {
      const code = src('shared', file);
      expect(code).toContain('PictureButton');
      expect(code).toContain('picturesOn');
      expect(code).toContain('MessagePicture');
    }
    const picture = src('shared', 'ChatPicture.tsx');
    expect(picture).toContain('pictureUrl(kind, messageId)');
    expect(picture).not.toMatch(/dangerouslySetInnerHTML/);
    expect(picture).not.toMatch(/innerHTML/);
    // the one thing a page sends is a picture it has shrunk itself, as a data address; the server decides in the end
    expect(src('shared', 'api.ts')).toContain('picture');
  });

  it('PICUI-17: the Invite button is for any member (checked in the browser run); only the maker sees the Public/Private switch; the public groups list has its own button', () => {
    const thread = src('shared', 'PmThreadView.tsx');
    expect(thread).toContain('pm-invite-button');
    expect(thread).toContain('pm-make-public');
    expect(thread).toContain('pm-make-private');
    expect(thread).toMatch(/isCreator = conv\.kind === 'group' && conv\.creator === me/);
    expect(thread).toMatch(/\{isCreator && \(\s*<span className="people-actions pm-visibility"/); // the switch sits behind the "I made this group" check
    const list = src('shared', 'MessagesScreen.tsx');
    expect(list).toContain('pm-public-button');
    expect(list).toContain('pm-group-public');
    expect(list).toContain('pm-group-private');
  });

  it('PICUI-18: the username card is on the account page; the owner and moderators see the "was called" names and the owner has the pictures switch', () => {
    expect(src('shared', 'AccountScreen.tsx')).toContain('<UsernamePanel');
    expect(src('shared', 'AdminPlayers.tsx')).toContain('formerNames');
    expect(src('shared', 'ModScreen.tsx')).toContain('formerNames');
    const chat = src('shared', 'AdminChat.tsx');
    expect(chat).toContain('admin-pictures-toggle');
    expect(chat).toMatch(/!staff && view !== null/); // a moderator never sees the owner's switch
    expect(src('shared', 'AdminLog.tsx')).toContain("case 'chat_pictures'");
  });
});
