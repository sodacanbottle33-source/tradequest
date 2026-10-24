// The screens for friend challenges and the chat: the words and numbers they show, the store that holds them, and source-level checks (like
// players-ui.test.ts) that the pages only ask the server and never decide who may challenge whom, who may write, or what a message may be.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { leftText, msLeftNow } from '../src/shared/challengeUtil';
import { lengthOf, timeLabel, waitWords } from '../src/shared/chatUtil';
import { MAX_CHAT_MESSAGES, SharedStore } from '../src/shared/store';
import type { ChallengesState, ChatMessage, ChatYou, Match, User } from '../src/shared/types';

const src = (...parts: string[]): string => resolve(process.cwd(), 'src', ...parts);

function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const me: User = { id: 1, username: 'alice', displayName: 'alice', role: 'player' };
const can: ChatYou = { canWrite: true, reason: null, untilMs: null, message: null };
const msg = (id: number, username = 'bob', text = `message ${id}`): ChatMessage => ({ id, username, displayName: username, role: 'player', text, createdMs: id * 1000 });

/** A store that is signed in as Alice with an empty chat, without going to a server. */
function signedIn(): SharedStore {
  const store = new SharedStore();
  (store as unknown as { set(patch: object): void }).set({ user: me, chat: { messages: [], more: false, you: can, limits: { maxLength: 300, minGapMs: 1500 }, unread: 0 }, tick: 100 });
  return store;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
function answerWith(body: unknown): void {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
}

describe('the words and numbers', () => {
  it('CCUI-1: the time left on a challenge is minutes and seconds, counted down from the market ticks since the list was received', () => {
    expect(leftText(120_000)).toBe('2:00');
    expect(leftText(101_000)).toBe('1:41');
    expect(leftText(59_001)).toBe('1:00');
    expect(leftText(9_000)).toBe('0:09');
    expect(leftText(0)).toBe('0:00');
    expect(leftText(-5_000)).toBe('0:00');
    const entry = { username: 'bob', displayName: 'bob', sinceMs: 0, msLeft: 120_000 };
    expect(msLeftNow(entry, 100, 100)).toBe(120_000);
    expect(msLeftNow(entry, 100, 130)).toBe(90_000);
    expect(msLeftNow(entry, 100, 400)).toBe(0);
    expect(msLeftNow(entry, 100, 50)).toBe(120_000); // a tick count that went backwards never adds time
  });

  it('CCUI-2: a wait in words, a message length as people count it, a time of day', () => {
    expect(waitWords(30_000)).toBe('less than a minute');
    expect(waitWords(60_000)).toBe('1 minute');
    expect(waitWords(4 * 60_000 + 1)).toBe('5 minutes');
    expect(waitWords(5 * 3_600_000)).toBe('5 hours');
    expect(waitWords(4 * 86_400_000)).toBe('4 days');
    expect(lengthOf('hello')).toBe(5);
    expect(lengthOf('\u{1F600}\u{1F600}')).toBe(2);
    expect(timeLabel(Date.UTC(2026, 9, 1, 12, 5))).toMatch(/\d{1,2}:\d{2}/);
  });
});

describe('the store', () => {
  it('CCUI-3: chat messages arrive once each, in order; only other players\' messages count as unread, and only while the chat is not on screen', () => {
    const store = signedIn();
    store.addChatMessage(msg(2));
    store.addChatMessage(msg(1));
    store.addChatMessage(msg(2)); // the same message twice: once
    expect(store.getSnapshot().chat?.messages.map((m) => m.id)).toEqual([1, 2]);
    expect(store.getSnapshot().chat?.unread).toBe(2);
    store.addChatMessage(msg(3, 'alice')); // my own message is not new to me
    expect(store.getSnapshot().chat?.unread).toBe(2);
    store.setChatViewing(true);
    expect(store.getSnapshot().chat?.unread).toBe(0);
    store.addChatMessage(msg(4));
    expect(store.getSnapshot().chat?.unread).toBe(0);
    store.setChatViewing(false);
    store.addChatMessage(msg(5));
    expect(store.getSnapshot().chat?.unread).toBe(1);
  });

  it('CCUI-4: the page keeps only the newest messages, a removed message disappears, and nothing is kept for a signed-out visitor', () => {
    const store = signedIn();
    for (let i = 1; i <= MAX_CHAT_MESSAGES + 10; i += 1) store.addChatMessage(msg(i));
    const chat = store.getSnapshot().chat;
    expect(chat?.messages).toHaveLength(MAX_CHAT_MESSAGES);
    expect(chat?.messages[0]?.id).toBe(11);
    expect(chat?.more).toBe(true);
    store.removeChatMessage(50);
    expect(store.getSnapshot().chat?.messages.some((m) => m.id === 50)).toBe(false);
    store.removeChatMessage(999999); // unknown: nothing happens
    expect(store.getSnapshot().chat?.messages).toHaveLength(MAX_CHAT_MESSAGES - 1);
    const stranger = new SharedStore();
    stranger.addChatMessage(msg(1));
    expect(stranger.getSnapshot().chat).toBeNull();
  });

  it('CCUI-5: after sending, the message shows at once and the "may I write" answer is the server\'s new one', () => {
    const store = signedIn();
    const blocked: ChatYou = { canWrite: false, reason: 'muted', untilMs: 5, message: 'You are muted.' };
    store.noteSent(msg(7, 'alice', 'hi all'), blocked);
    expect(store.getSnapshot().chat?.messages.map((m) => m.text)).toEqual(['hi all']);
    expect(store.getSnapshot().chat?.you).toEqual(blocked);
  });

  it('CCUI-6: a challenge that vanishes without a match gets a short line; one that became a match does not; a new one is silent', async () => {
    const store = signedIn();
    const sent: ChallengesState = { incoming: [], outgoing: [{ username: 'bob', displayName: 'bob', sinceMs: 0, msLeft: 120_000 }], limits: { validMs: 120_000 } };
    store.setChallenges(sent, null);
    expect(store.getSnapshot().challenges?.outgoing).toHaveLength(1);
    expect(store.getSnapshot().challengesTick).toBe(100);
    // Bob did not answer: the server's list is empty.
    answerWith({ incoming: [], outgoing: [], limits: { validMs: 120_000 }, match: null });
    await store.refreshChallenges(true);
    expect(store.getSnapshot().challenges?.outgoing).toEqual([]);
    expect(store.getSnapshot().challengeNote).toBe('bob did not accept your challenge.');
    store.closeChallengeNote();
    expect(store.getSnapshot().challengeNote).toBeNull();
    // Bob said yes: his lobby is already here when the list is refreshed.
    store.setChallenges(sent, null);
    const lobby = { id: 9, phase: 'ready_check', friendMatch: true, players: [{ name: 'alice', you: true }, { name: 'bob', you: false }] } as unknown as Match;
    store.setMatch(lobby);
    answerWith({ incoming: [], outgoing: [], limits: { validMs: 120_000 }, match: null });
    await store.refreshChallenges(true);
    expect(store.getSnapshot().challengeNote).toBeNull();
    // A refresh that is not explained (the safety-net poll) is silent too, and an incoming challenge is never "not accepted".
    store.setChallenges(sent, null);
    answerWith({ incoming: [{ username: 'carol', displayName: 'carol', sinceMs: 0, msLeft: 90_000 }], outgoing: [], limits: { validMs: 120_000 }, match: null });
    await store.refreshChallenges(false);
    expect(store.getSnapshot().challengeNote).toBeNull();
    expect(store.getSnapshot().challenges?.incoming.map((e) => e.username)).toEqual(['carol']);
  });

  it('CCUI-7: an answer that opens the lobby (a yes) puts the match in the store; an answer without one never clears a match you are in', () => {
    const store = signedIn();
    const lobby = { id: 9, phase: 'ready_check', friendMatch: true, players: [] } as unknown as Match;
    const empty: ChallengesState = { incoming: [], outgoing: [], limits: { validMs: 120_000 } };
    store.setChallenges(empty, lobby);
    expect(store.getSnapshot().match?.id).toBe(9);
    store.setChallenges(empty, null);
    expect(store.getSnapshot().match?.id).toBe(9);
  });

  it('CCUI-14: the line "did not accept" about an old challenge goes away when a new challenge is sent or a friend match opens', async () => {
    const empty: ChallengesState = { incoming: [], outgoing: [], limits: { validMs: 120_000 } };
    const sent: ChallengesState = { incoming: [], outgoing: [{ username: 'bob', displayName: 'bob', sinceMs: 0, msLeft: 120_000 }], limits: { validMs: 120_000 } };
    const declined = async (store: SharedStore): Promise<void> => {
      store.setChallenges(sent, null);
      answerWith({ ...empty, match: null });
      await store.refreshChallenges(true);
      expect(store.getSnapshot().challengeNote).toBe('bob did not accept your challenge.');
    };
    // Bob said no, and Alice challenges him again straight away: the old line must not stay next to the new challenge.
    const again = signedIn();
    await declined(again);
    again.setChallenges(sent, null);
    expect(again.getSnapshot().challengeNote).toBeNull();
    // Bob said no, then yes to the next one: when the lobby arrives (over the live stream) the old line is gone.
    const yes = signedIn();
    await declined(yes);
    const lobby = { id: 9, phase: 'ready_check', friendMatch: true, players: [{ name: 'alice', you: true }, { name: 'bob', you: false }] } as unknown as Match;
    (yes as unknown as { onMatch(m: Match | null): void }).onMatch(lobby);
    expect(yes.getSnapshot().challengeNote).toBeNull();
    expect(yes.getSnapshot().match?.id).toBe(9);
    // The same when the answer to her own request carries the lobby.
    const direct = signedIn();
    await declined(direct);
    direct.setChallenges(empty, lobby);
    expect(direct.getSnapshot().challengeNote).toBeNull();
    // A random-lobby match says nothing about challenges: the line stays.
    const random = signedIn();
    await declined(random);
    (random as unknown as { onMatch(m: Match | null): void }).onMatch({ id: 10, phase: 'waiting', friendMatch: false, players: [] } as unknown as Match);
    expect(random.getSnapshot().challengeNote).toBe('bob did not accept your challenge.');
    random.closeChallengeNote(); // (also stops its ten-second timer)
  });

  it('CCUI-8: a signed-out visitor has no challenges and no chat', async () => {
    const store = new SharedStore();
    await store.refreshChallenges();
    await store.refreshChat();
    expect(store.getSnapshot().challenges).toBeNull();
    expect(store.getSnapshot().chat).toBeNull();
    store.setChallenges({ incoming: [], outgoing: [], limits: { validMs: 1 } }, null);
    expect(store.getSnapshot().challenges).toBeNull();
  });
});

describe('the screens only ask the server', () => {
  it('CCUI-9: challenges: the page asks the server for every action and never decides who may challenge, who is online or when a challenge ends', () => {
    const screen = code(src('shared', 'Challenges.tsx'));
    expect(screen).toMatch(/api\.challengeAction\(/);
    expect(screen).not.toMatch(/localStorage|sessionStorage|Math\.random|Date\.now|setInterval|setTimeout/); // time left comes from the tick stream
    expect(screen).not.toMatch(/\.sort\(|expiresMs|isOnline|online\b/i);
    const store = code(src('shared', 'store.ts'));
    expect(store).toMatch(/addEventListener\('challenges'/);
    expect(store).toMatch(/challenges: null/);
  });

  it('CCUI-10: the challenge banner is on every screen; Challenge buttons are on the Friends tab and the 1v1 screen; a yes opens the lobby once', () => {
    const shell = code(src('shared', 'SharedApp.tsx'));
    expect(shell).toMatch(/<ChallengeBanner \/>/);
    expect(shell).toMatch(/friendMatch && s\.match\.phase === 'ready_check'/);
    expect(shell).toMatch(/openedLobby\.current !== friendLobbyId/);
    expect(code(src('shared', 'PlayersScreen.tsx'))).toMatch(/<ChallengeButton username=\{e\.username\}/);
    expect(code(src('shared', 'LobbyScreen.tsx'))).toMatch(/<PlayFriendCard \/>/);
    expect(code(src('ui', 'Header.tsx'))).not.toMatch(/Chat|Challenge/);
  });

  it('CCUI-11: chat: messages are shown as plain text; the page never turns text into markup or links, and the length limit comes from the server', () => {
    const screen = code(src('shared', 'ChatScreen.tsx'));
    expect(screen).not.toMatch(/dangerouslySetInnerHTML|innerHTML|insertAdjacentHTML|href=|linkify|<a\b/);
    expect(screen).not.toMatch(/localStorage|sessionStorage|Math\.random/);
    expect(screen).toMatch(/\{message\.text\}/);
    expect(screen).toMatch(/api\.chatSend\(/);
    expect(screen).toMatch(/chat\.limits\.maxLength/);
    expect(screen).not.toMatch(/\b300\b/);
    expect(screen).toMatch(/if \(!user\) return <AuthPanel/);
  });

  it('CCUI-12: chat: the owner\'s buttons only appear for the owner, each action carries its own request id, and a player\'s Report asks first', () => {
    const screen = code(src('shared', 'ChatScreen.tsx'));
    expect(screen).toMatch(/isOwner = user\.role === 'owner'/);
    expect((screen.match(/api\.adminChat\w+\(\{ requestId: newRequestId\(\)/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(screen).toMatch(/Report this message\?/);
    expect(screen).toMatch(/data-testid=\{`report-yes-/);
    const admin = code(src('shared', 'AdminChat.tsx'));
    expect((admin.match(/requestId: newRequestId\(\)/g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect(code(src('shared', 'AdminScreen.tsx'))).toMatch(/\['chat', 'Chat'\]/);
    expect(code(src('shared', 'AdminLog.tsx'))).toMatch(/case 'chat_mute'/);
  });

  it('CCUI-13: chat: it is a Career tab with a badge for new messages; the store listens for new, removed and status events and forgets everything at sign-out', () => {
    const shell = code(src('shared', 'SharedApp.tsx'));
    expect(shell).toMatch(/\['chat', 'Chat'\]/);
    expect(shell).toMatch(/careerTab === 'chat' && <ChatScreen/);
    expect(shell).toMatch(/data-testid="chat-badge"/);
    const store = code(src('shared', 'store.ts'));
    for (const event of ['chat', 'chat_removed', 'chat_status']) expect(store).toContain(`addEventListener('${event}'`);
    expect(store).toMatch(/challenges: null, challengeNote: null, chat: null/);
    const api = code(src('shared', 'api.ts'));
    for (const path of ['/api/challenges', '/api/challenges/${what}', '/api/chat/send', '/api/chat/report', '/api/admin/chat/mute']) expect(api).toContain(path);
  });
});
