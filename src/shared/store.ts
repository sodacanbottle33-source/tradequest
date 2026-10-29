// One place that holds what the browser knows about the shared market and keeps it fresh: the live tick stream, the company
// list, the news, the player's account and their 1v1 lobby. Components read it with useShared(); nothing here decides
// anything the server decides.
import { useSyncExternalStore } from 'react';
import { ApiError, api, isOffline } from './api';
import { CallController, type ControllerDeps } from './callController';
import { describeLimitEvent } from './limitText';
import { describeNotice, type ToastText } from './positionNotice';
import { browserVoiceDeps, VoiceSession } from './voice';
import { badgeById } from './badgeCatalog';
import { playBadgeShow } from './badgeShow';
import type { Gear, Look } from './cosmeticCatalog';
import { awayStore } from './awayStore';
import { billboardStore } from './billboardStore';
import { goalNotice } from './goalUtil';
import { goalsStore } from './goalsStore';
import { logoStore } from './logoStore';
import { profileStore } from './profileStore';
import type { Account, Announcement, BanNotice, BillboardSlotView, CallEnded, CallSignal, CallState, CallView, ChallengesState, ChatMessage, ChatView, ChatYou, FriendsState, GoalsEvent, Health, LimitNotice, LimitOrder, Match, NewsItem, MessagesView, OverviewRow, PmConversation, PmMessage, PmSendResult, PositionNotice, TradingPause, User } from './types';

/** A pop-up about a position the market closed by itself. */
export interface Toast extends ToastText {
  readonly id: number;
  readonly ticker: string;
}

/** How long a pop-up stays, in milliseconds; the player can close it earlier. */
export const TOAST_MS = 12_000;
const MAX_TOASTS = 5;

/** The chat room as the page holds it: the newest messages (oldest first), whether older ones exist, and whether the player can write. */
export interface ChatState {
  readonly messages: readonly ChatMessage[];
  readonly more: boolean;
  readonly you: ChatYou;
  readonly limits: ChatView['limits'];
  /** Messages from other players that arrived while the chat was not on screen. */
  readonly unread: number;
}

/** The most messages the page keeps in memory; older ones are dropped (and can be asked for again). */
export const MAX_CHAT_MESSAGES = 150;

/** The private conversation on screen: its header as the server last described it and its newest messages (oldest first). */
export interface PmThread {
  readonly id: number;
  readonly conversation: PmConversation;
  readonly messages: readonly PmMessage[];
  /** Whether older messages exist than the first one held. */
  readonly more: boolean;
}

/** The most messages of one private conversation the page keeps in memory. */
export const MAX_PM_MESSAGES = 300;

export interface SharedState {
  readonly conn: 'connecting' | 'online' | 'offline';
  readonly problem: string | null;
  readonly authChecked: boolean;
  readonly user: User | null;
  /** Set when the player's session was ended because the owner banned the account (the page then says why). */
  readonly banned: BanNotice | null;
  readonly health: Health | null;
  /** The market's newest tick and the server time of that tick. All countdowns are counted in these ticks. */
  readonly tick: number;
  readonly tickMs: number;
  readonly prices: readonly number[];
  readonly halves: readonly number[];
  readonly companies: readonly OverviewRow[];
  readonly news: readonly NewsItem[];
  /** The newest breaking story, until the player closes it. */
  readonly breaking: NewsItem | null;
  readonly career: Account | null;
  /** The player's friends, the requests waiting for his answer and the ones he sent (null until loaded, and when signed out). */
  readonly friends: FriendsState | null;
  /** Friend 1v1 challenges: the ones waiting for your answer and the one you sent (null until loaded, and when signed out). */
  readonly challenges: ChallengesState | null;
  /** The market tick at which `challenges` was received. The time left on a challenge counts down from the tick stream. */
  readonly challengesTick: number;
  /** A short line about a challenge that ended without a match ("Bob did not accept..."), until it is closed. */
  readonly challengeNote: string | null;
  /** The chat room (null until loaded, and when signed out). */
  readonly chat: ChatState | null;
  /** The private chats: conversations, message requests, blocked players (null until loaded, and when signed out). */
  readonly messages: MessagesView | null;
  /** The number of the private conversation the player opened (its messages follow once they are loaded). */
  readonly pmOpen: number | null;
  /** The private conversation on screen. */
  readonly pmThread: PmThread | null;
  /** A player another screen asked the Messages screen to write to ("Message" next to a name). */
  readonly pmCompose: string | null;
  /** The player whose profile card is open (a click on a name), or null. */
  readonly profileFor: string | null;
  /** The voice call this page shows, if there is one (null when there is none, and when signed out). */
  readonly call: CallState | null;
  /** A short line about a call that just ended or could not start ("Bob did not answer."), until it is closed. */
  readonly callNote: string | null;
  /** The other player's voice, to play, while the connection is up (a MediaStream; null otherwise). */
  readonly callStream: unknown | null;
  /** The player's open limit orders (Career), newest first. */
  readonly limits: readonly LimitOrder[];
  readonly match: Match | null;
  readonly searching: number;
  /** True when the server has 1v1 bots turned on (the page then offers "Play a bot now"). */
  readonly bots: boolean;
  readonly walletCents: number;
  /** Pop-ups about positions closed by liquidation, stop-loss or take-profit (and new badges), newest last. */
  readonly toasts: readonly Toast[];
  /** Counts up each time the server says this player earned a badge, so an open Badges page asks again. */
  readonly badgesVersion: number;
}

const INITIAL: SharedState = {
  conn: 'connecting',
  problem: null,
  authChecked: false,
  user: null,
  banned: null,
  health: null,
  tick: 0,
  tickMs: 0,
  prices: [],
  halves: [],
  companies: [],
  news: [],
  breaking: null,
  career: null,
  friends: null,
  challenges: null,
  challengesTick: 0,
  challengeNote: null,
  chat: null,
  messages: null,
  pmOpen: null,
  pmThread: null,
  pmCompose: null,
  profileFor: null,
  call: null,
  callNote: null,
  callStream: null,
  limits: [],
  match: null,
  searching: 0,
  bots: true,
  walletCents: 0,
  toasts: [],
  badgesVersion: 0,
};

const MAX_NEWS = 400;

interface TickPayload {
  t: number;
  ms: number;
  p: number[];
  h: number[];
}

export class SharedStore {
  private state: SharedState = INITIAL;
  private readonly listeners = new Set<() => void>();
  private source: EventSource | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private retry: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private nextToast = 1;
  private toastTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private noteTimer: ReturnType<typeof setTimeout> | null = null;
  /** True while the Chat tab is on screen: new messages are then read at once. */
  private chatViewing = false;
  /** Set while a refresh of the private chats is waiting, so a burst of nudges asks the server once. */
  private pmTimer: ReturnType<typeof setTimeout> | null = null;

  /** The voice call this page makes and takes (src/shared/callController.ts). */
  private readonly calls: CallController;

  constructor(options: { makeSession?: ControllerDeps['makeSession'] } = {}) {
    this.calls = new CallController({
      api: {
        view: () => api.callsView(),
        invite: (username) => api.callsInvite(username),
        accept: (callId) => api.callsAccept(callId),
        hangup: (callId, failed) => api.callsHangup(callId, failed),
        signal: (callId, signal) => api.callsSignal(callId, signal),
      },
      state: () => this.state.call,
      setCall: (call) => this.set({ call }),
      setNote: (callNote) => this.set({ callNote }),
      setStream: (callStream) => this.set({ callStream }),
      makeSession: options.makeSession ?? ((role, hooks) => new VoiceSession(role, browserVoiceDeps(hooks))),
      now: () => Date.now(),
      later: (fn, ms) => setTimeout(fn, ms),
      cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    });
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): SharedState => this.state;

  private set(patch: Partial<SharedState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  // ---- connecting --------------------------------------------------------------------------------------------------

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.connect();
  }

  stop(): void {
    this.started = false;
    this.source?.close();
    this.source = null;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
  }

  private async connect(): Promise<void> {
    try {
      const health = await api.health();
      const me = await api.me();
      this.set({ conn: 'online', problem: null, health, user: me.user, banned: me.banned ?? null, authChecked: true });
    } catch (error) {
      this.set({ conn: 'offline', problem: error instanceof Error ? error.message : String(error), authChecked: true });
      if (this.started) this.retry = setTimeout(() => void this.connect(), 3000);
      return;
    }
    await Promise.all([this.refreshCompanies(), this.refreshNews(), this.refreshPrivate(), this.refreshFriends(), this.refreshChallenges(), this.refreshChat(), this.refreshMessages()]);
    this.openStream();
    for (const t of this.timers) clearInterval(t);
    this.timers = [
      setInterval(() => void this.refreshCompanies(), 20_000),
      setInterval(() => void this.refreshPrivate(false), 6_000),
      // New requests also arrive over the live stream at once; this is the safety net.
      setInterval(() => {
        void this.refreshFriends();
        void this.refreshChallenges();
        void this.refreshMessages();
      }, 30_000),
      // While in a lobby the server must keep hearing from us (it removes players who have gone away). During a live match this
      // also makes sure the final result reaches the page even if the live push was missed.
      setInterval(() => {
        const phase = this.state.match?.phase;
        if (this.state.user && (phase === 'waiting' || phase === 'ready_check' || phase === 'countdown' || phase === 'live' || phase === 'settling')) {
          void this.refreshLobby();
        }
      }, 2_000),
      setInterval(() => void this.checkHealth(), 10_000),
    ];
  }

  private openStream(): void {
    this.source?.close();
    const es = new EventSource('/api/stream');
    this.source = es;
    es.addEventListener('hello', (e) => {
      this.onTick(JSON.parse((e as MessageEvent<string>).data) as TickPayload);
      void this.refreshCompanies();
      void this.refreshPrivate(false);
      void this.refreshFriends();
      void this.refreshChallenges();
      void this.refreshChat();
      void this.refreshMessages();
      // The pictures of stocks and memecoins are for everybody, also a visitor who is not signed in.
      void logoStore.load();
      // So is the billboard (a signed-in player's answer also has his cash and his launched companies).
      void billboardStore.load();
      if (this.state.user) {
        void this.calls.reconcile();
        void profileStore.start();
        // Today's goals (asking also pays any goal finished while the page was closed) and the "while you were away" card.
        void goalsStore.load();
        void awayStore.load();
      }
    });
    es.addEventListener('tick', (e) => this.onTick(JSON.parse((e as MessageEvent<string>).data) as TickPayload));
    es.addEventListener('news', (e) => this.onNews(JSON.parse((e as MessageEvent<string>).data) as NewsItem));
    es.addEventListener('notice', (e) => this.onNotice(JSON.parse((e as MessageEvent<string>).data) as { announcement: Announcement | null; paused: TradingPause | null }));
    es.addEventListener('match', (e) => {
      const d = JSON.parse((e as MessageEvent<string>).data) as { match: Match | null };
      this.onMatch(d.match);
    });
    es.addEventListener('position', (e) => this.onPosition(JSON.parse((e as MessageEvent<string>).data) as PositionNotice));
    es.addEventListener('limit', (e) => this.noteLimit(JSON.parse((e as MessageEvent<string>).data) as LimitNotice));
    // A friend request arrived, was accepted, or a friend left: bring the lists up to date.
    es.addEventListener('friends', () => void this.refreshFriends());
    // A friend challenged you, took the challenge back, or answered yours.
    es.addEventListener('challenges', () => void this.refreshChallenges(true));
    // The chat room: a new message, a message the owner removed, or a change in whether you may write (muted, banned, lifted).
    es.addEventListener('chat', (e) => this.addChatMessage((JSON.parse((e as MessageEvent<string>).data) as { message: ChatMessage }).message));
    es.addEventListener('chat_removed', (e) => this.removeChatMessage((JSON.parse((e as MessageEvent<string>).data) as { id: number }).id));
    es.addEventListener('chat_status', () => void this.refreshChat());
    // The owner made this player a moderator, or took the job away: bring the role up to date (the menu and pages follow it) and say so.
    es.addEventListener('role_changed', (e) => this.onRoleChanged(JSON.parse((e as MessageEvent<string>).data) as { role: string }));
    // A daily goal (or the bonus for all three, or a streak look) was paid.
    es.addEventListener('goals', (e) => this.onGoals(JSON.parse((e as MessageEvent<string>).data) as GoalsEvent));
    // This player earned one or more achievement badges.
    es.addEventListener('badges', (e) => this.onBadges(JSON.parse((e as MessageEvent<string>).data) as { earned: string[] }));
    // A player paid for a new username: every list that shows the old name is brought up to date.
    es.addEventListener('user_renamed', (e) => this.onUserRenamed(JSON.parse((e as MessageEvent<string>).data) as { from: string; to: string }));
    // A player set or removed his profile picture.
    es.addEventListener('avatar', (e) => profileStore.onAvatar(JSON.parse((e as MessageEvent<string>).data) as { username: string; v: number | null }));
    // A player put on, changed or took off something from the Shop (his name colour, glow, picture frame or title).
    es.addEventListener('looks', (e) => profileStore.onLooks(JSON.parse((e as MessageEvent<string>).data) as { username: string; look: Look | null }));
    // A player put on, changed or took off something for his own screen on another page of his (candle colours, chart, win style). Only his own pages hear this.
    es.addEventListener('gear', (e) => profileStore.onGear(JSON.parse((e as MessageEvent<string>).data) as { gear: Gear | null }));
    // Somebody booked a place on the billboard (or added hours): the three places, for everybody.
    es.addEventListener('billboard', (e) => billboardStore.onEvent(JSON.parse((e as MessageEvent<string>).data) as { slots: BillboardSlotView[] }));
    // A launcher or the owner set or removed the picture of a stock or memecoin.
    es.addEventListener('company_picture', (e) => logoStore.onPicture(JSON.parse((e as MessageEvent<string>).data) as { ticker: string; v: number | null }));
    // Private chats: a new message in one of your conversations, or something about them changed (a request, an invitation, a read mark...).
    es.addEventListener('pm', (e) => {
      const d = JSON.parse((e as MessageEvent<string>).data) as { conversationId: number; message: PmMessage };
      this.addPrivateMessage(d.conversationId, d.message);
    });
    es.addEventListener('pm_changed', () => this.onPmChanged());
    // A player deleted a message he wrote: it leaves the conversation on screen.
    es.addEventListener('pm_deleted', (e) => {
      const d = JSON.parse((e as MessageEvent<string>).data) as { conversationId: number; id: number };
      this.removePrivateMessage(d.conversationId, d.id);
    });
    // Voice calls: a ring, an answer, the end of a call, and the small connection messages between the two browsers.
    es.addEventListener('call', (e) => this.calls.onCall(JSON.parse((e as MessageEvent<string>).data) as { call: CallView | null; ended?: CallEnded }));
    es.addEventListener('call_signal', (e) => this.calls.onSignal(JSON.parse((e as MessageEvent<string>).data) as { callId: string; signal: CallSignal }));
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED && this.started) {
        this.set({ conn: 'offline', problem: 'The connection to the server was lost.' });
        this.retry = setTimeout(() => void this.connect(), 3000);
      }
    };
  }

  private onTick(d: TickPayload): void {
    this.set({ tick: d.t, tickMs: d.ms, prices: d.p, halves: d.h, conn: 'online' });
  }

  private onNews(item: NewsItem): void {
    if (this.state.news.some((n) => n.id === item.id)) return;
    const news = [item, ...this.state.news].slice(0, MAX_NEWS);
    this.set({ news, breaking: item.breaking ? item : this.state.breaking });
  }

  /** The owner posted or took down an announcement, or paused or reopened all trading: show it at once, not at the next health check. */
  private onNotice(d: { announcement: Announcement | null; paused: TradingPause | null }): void {
    if (this.state.health) this.set({ health: { ...this.state.health, announcement: d.announcement, paused: d.paused } });
    void this.refreshCompanies();
  }

  /** The market closed one of this player's positions: say so at once and bring the account up to date. */
  private onPosition(n: PositionNotice): void {
    this.addToast(n);
    void this.refreshPrivate(true);
  }

  /** A limit order filled (all or part of it) or ended: say so at once and bring the account and the order list up to date. */
  noteLimit(n: LimitNotice): void {
    this.showToast(n.order.ticker, describeLimitEvent(n.what, n.order), TOAST_MS);
    void this.refreshPrivate(false);
  }

  /** A daily goal was paid: say so, and bring the Goals page and the Career cash up to date. */
  private onGoals(d: GoalsEvent): void {
    const text = goalNotice(d);
    if (text) this.showToast('', text, TOAST_MS);
    void goalsStore.load();
    void this.refreshPrivate(false);
  }

  /** The server gave this player one or more badges: say which, and make an open Badges page ask again. */
  private onBadges(d: { earned: string[] }): void {
    const named = d.earned.map((id) => badgeById(id)).filter((b) => b !== undefined);
    this.set({ badgesVersion: this.state.badgesVersion + 1 });
    if (named.length === 0) return;
    const text = named.map((b) => `${b.icon} ${b.name}`).join(' · ');
    this.showToast('', { tone: 'good', title: named.length === 1 ? 'New badge' : `${named.length} new badges`, text: `${text}. See them in Players → Badges.` }, TOAST_MS);
    // The medal pop and sparkles (src/shared/BadgeUnlock.tsx). Looks only: the pop-up above is the record of what was earned.
    playBadgeShow(named.map((b) => b.id));
  }

  /** The owner made this player a moderator (or took it away). */
  private onRoleChanged(d: { role: string }): void {
    void this.recheckMe();
    if (d.role === 'moderator') this.showToast('', { tone: 'good', title: 'You are a moderator now', text: 'The owner chose you. Open Moderation in your profile menu (top right).' }, TOAST_MS);
    else this.showToast('', { tone: 'neutral', title: 'You are not a moderator any more', text: 'The owner took the moderator job away.' }, TOAST_MS);
  }

  /**
   * A player changed his username. The pictures and the online dots follow the name; the friends, the chat room and the private chats are
   * asked for again (they show names). If it was THIS player (on another page of his), his own name is asked for again too.
   */
  private onUserRenamed(d: { from: string; to: string }): void {
    profileStore.onRenamed(d.from, d.to);
    const me = this.state.user;
    if (me && me.username.toLowerCase() === d.from.toLowerCase()) void this.recheckMe();
    void this.refreshFriends();
    void this.refreshChat();
    this.onPmChanged();
  }

  /** This page changed the player's username (the server's answer carries the new user): take it and bring the money and the lists up to date. */
  noteRenamed(user: User, previous: string): void {
    if (this.state.user) this.set({ user });
    profileStore.onRenamed(previous, user.username);
    void this.refreshAccount();
    void this.refreshFriends();
    void this.refreshChat();
    this.onPmChanged();
  }

  /** Shows a pop-up for a position the market closed; it goes away by itself after `ms` milliseconds. */
  addToast(n: PositionNotice, ms = TOAST_MS): void {
    this.showToast(n.ticker, describeNotice(n), ms);
  }

  private showToast(ticker: string, text: ToastText, ms: number): void {
    const id = this.nextToast++;
    const toast: Toast = { ...text, id, ticker };
    this.set({ toasts: [...this.state.toasts, toast].slice(-MAX_TOASTS) });
    this.toastTimers.set(
      id,
      setTimeout(() => this.dismissToast(id), ms),
    );
  }

  dismissToast(id: number): void {
    const timer = this.toastTimers.get(id);
    if (timer) clearTimeout(timer);
    this.toastTimers.delete(id);
    if (this.state.toasts.some((t) => t.id === id)) this.set({ toasts: this.state.toasts.filter((t) => t.id !== id) });
  }

  private onMatch(match: Match | null): void {
    if (match?.friendMatch === true) this.closeChallengeNote();
    this.set({ match });
    const phase = match?.phase;
    // When a match is over the Career account has not changed, but the wallet has; show it.
    if (phase === 'finished' || phase === 'cancelled') void this.refreshLobby();
  }

  // ---- loading -----------------------------------------------------------------------------------------------------

  async refreshCompanies(): Promise<void> {
    try {
      const o = await api.market();
      this.set({ companies: o.companies });
    } catch (error) {
      this.noteFailure(error);
    }
  }

  async refreshNews(): Promise<void> {
    try {
      const page = await api.news({ limit: 60 });
      // Keep anything newer that arrived over the stream while we were loading.
      const ids = new Set(page.items.map((n) => n.id));
      const extra = this.state.news.filter((n) => !ids.has(n.id) && n.publishTick > (page.items[0]?.publishTick ?? 0));
      this.set({ news: [...extra, ...page.items].slice(0, MAX_NEWS) });
    } catch (error) {
      this.noteFailure(error);
    }
  }

  async refreshPrivate(includeLobby = true): Promise<void> {
    if (!this.state.user) {
      this.set({ career: null, limits: [], match: null, walletCents: 0 });
      return;
    }
    try {
      // The order list is a nicety: if only it fails (an older server), the account still shows.
      const [career, limits] = await Promise.all([api.account('career'), api.limitOrders('open', 50).catch(() => null)]);
      this.set(limits ? { career, limits: limits.orders } : { career });
    } catch (error) {
      this.noteFailure(error);
    }
    if (includeLobby) await this.refreshLobby();
  }

  async refreshFriends(): Promise<void> {
    if (!this.state.user) {
      if (this.state.friends) this.set({ friends: null });
      return;
    }
    try {
      this.set({ friends: await api.friends() });
    } catch (error) {
      this.noteFailure(error);
    }
  }

  /** The lists a friend action answered with (so the screen is up to date without another request). */
  setFriends(friends: FriendsState): void {
    if (this.state.user) this.set({ friends });
  }

  // ---- friend challenges -------------------------------------------------------------------------------------------

  /**
   * Asks the server for the challenges. When `explain` is set (the server told us something changed) and the challenge we sent has
   * vanished without a match starting, a short line says so.
   */
  async refreshChallenges(explain = false): Promise<void> {
    if (!this.state.user) {
      if (this.state.challenges) this.set({ challenges: null });
      return;
    }
    try {
      const answer = await api.challenges();
      const before = this.state.challenges?.outgoing ?? [];
      this.applyChallenges(answer);
      if (explain) {
        const now = new Set(answer.outgoing.map((e) => e.username));
        const m = this.state.match;
        for (const gone of before.filter((e) => !now.has(e.username))) {
          // If the friend said yes, the match is already here (its push arrives before this one).
          const started = m?.friendMatch === true && m.players.some((p) => !p.you && p.name === gone.displayName);
          if (!started) this.noteChallenge(`${gone.displayName} did not accept your challenge.`);
        }
      }
    } catch (error) {
      this.noteFailure(error);
    }
  }

  private applyChallenges(c: ChallengesState): void {
    // A note about an earlier challenge that was not accepted must not stay on screen next to a new one.
    const known = new Set((this.state.challenges?.outgoing ?? []).map((e) => e.username));
    if (c.outgoing.some((e) => !known.has(e.username))) this.closeChallengeNote();
    this.set({ challenges: { incoming: c.incoming, outgoing: c.outgoing, limits: c.limits }, challengesTick: this.state.tick });
  }

  /** What a challenge action answered with: your challenges as they are now, and the lobby when a yes opened one. */
  setChallenges(c: ChallengesState, match: Match | null): void {
    if (!this.state.user) return;
    this.applyChallenges(c);
    if (match) {
      this.closeChallengeNote();
      this.set({ match });
    }
  }

  private noteChallenge(text: string): void {
    if (this.noteTimer) clearTimeout(this.noteTimer);
    this.set({ challengeNote: text });
    this.noteTimer = setTimeout(() => this.closeChallengeNote(), 10_000);
  }

  closeChallengeNote(): void {
    if (this.noteTimer) clearTimeout(this.noteTimer);
    this.noteTimer = null;
    if (this.state.challengeNote !== null) this.set({ challengeNote: null });
  }

  // ---- the chat room -----------------------------------------------------------------------------------------------

  async refreshChat(): Promise<void> {
    if (!this.state.user) {
      if (this.state.chat) this.set({ chat: null });
      return;
    }
    try {
      const view = await api.chat();
      // Keep messages that arrived over the stream while we were loading.
      const have = new Set(view.messages.map((m) => m.id));
      const newest = view.messages.at(-1)?.id ?? 0;
      const extra = (this.state.chat?.messages ?? []).filter((m) => !have.has(m.id) && m.id > newest);
      this.set({ chat: { messages: [...view.messages, ...extra].slice(-MAX_CHAT_MESSAGES), more: view.more, you: view.you, limits: view.limits, unread: this.chatViewing ? 0 : (this.state.chat?.unread ?? 0) } });
    } catch (error) {
      this.noteFailure(error);
    }
  }

  /** A message arrived (over the stream, or as the answer to our own send). */
  addChatMessage(message: ChatMessage): void {
    const chat = this.state.chat;
    if (!chat || chat.messages.some((m) => m.id === message.id)) return;
    const mine = message.username === this.state.user?.username;
    const all = [...chat.messages, message].sort((a, b) => a.id - b.id);
    this.set({ chat: { ...chat, messages: all.slice(-MAX_CHAT_MESSAGES), more: chat.more || all.length > MAX_CHAT_MESSAGES, unread: this.chatViewing || mine ? chat.unread : chat.unread + 1 } });
  }

  /** The owner removed a message: it disappears from every page. */
  removeChatMessage(id: number): void {
    const chat = this.state.chat;
    if (chat && chat.messages.some((m) => m.id === id)) this.set({ chat: { ...chat, messages: chat.messages.filter((m) => m.id !== id) } });
  }

  /** Our own send was accepted: show it at once and take the new "may I write" answer. */
  noteSent(message: ChatMessage, you: ChatYou): void {
    this.addChatMessage(message);
    const chat = this.state.chat;
    if (chat) this.set({ chat: { ...chat, you } });
  }

  /** Older messages, asked for with "Show earlier messages". */
  async loadEarlierChat(): Promise<void> {
    const chat = this.state.chat;
    const first = chat?.messages[0];
    if (!chat || !first) return;
    const view = await api.chat(first.id, 50);
    const latest = this.state.chat;
    if (!latest) return;
    const have = new Set(latest.messages.map((m) => m.id));
    this.set({ chat: { ...latest, messages: [...view.messages.filter((m) => !have.has(m.id)), ...latest.messages], more: view.more } });
  }

  /** Called by the Chat tab: true while it is on screen (messages are then read at once), false when it goes away. */
  setChatViewing(viewing: boolean): void {
    this.chatViewing = viewing;
    const chat = this.state.chat;
    if (viewing && chat && chat.unread > 0) this.set({ chat: { ...chat, unread: 0 } });
  }

  // ---- private chats -----------------------------------------------------------------------------------------------

  async refreshMessages(): Promise<void> {
    if (!this.state.user) {
      if (this.state.messages || this.state.pmThread || this.state.pmOpen !== null) this.set({ messages: null, pmThread: null, pmOpen: null });
      return;
    }
    try {
      this.set({ messages: await api.messages() });
    } catch (error) {
      this.noteFailure(error);
    }
  }

  /** Asks for the lists soon; several nudges in a row make one request. */
  private scheduleMessages(): void {
    if (this.pmTimer) return;
    this.pmTimer = setTimeout(() => {
      this.pmTimer = null;
      void this.refreshMessages();
    }, 250);
  }

  /** The lists a private-chat action answered with (so the screen is up to date without another request). */
  setMessages(view: MessagesView): void {
    if (this.state.user) this.set({ messages: view });
  }

  /** Opens a conversation on screen (null closes it). Its messages are loaded, and read once they are on screen. */
  async openConversation(id: number | null): Promise<void> {
    if (id === null) {
      if (this.state.pmOpen !== null || this.state.pmThread) this.set({ pmOpen: null, pmThread: null });
      return;
    }
    this.set({ pmOpen: id, pmThread: this.state.pmThread?.id === id ? this.state.pmThread : null });
    await this.loadThread(id, true);
  }

  /** (Re)loads the newest page of the open conversation, keeping the older messages already held. */
  private async loadThread(id: number, markRead: boolean): Promise<void> {
    try {
      const page = await api.messagesThread(id);
      if (this.state.pmOpen !== id) return;
      const held = this.state.pmThread?.id === id ? this.state.pmThread : null;
      const first = page.messages[0]?.id ?? Number.MAX_SAFE_INTEGER;
      const older = (held?.messages ?? []).filter((m) => m.id < first);
      this.set({ pmThread: { id, conversation: page.conversation, messages: [...older, ...page.messages].slice(-MAX_PM_MESSAGES), more: older.length > 0 ? (held?.more ?? page.more) : page.more } });
      if (markRead && page.conversation.unread > 0) void api.messagesRead(id).catch(() => undefined);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        // The conversation is not there any more (left, removed, closed): leave the screen empty and bring the lists up to date.
        if (this.state.pmOpen === id) this.set({ pmOpen: null, pmThread: null });
        this.scheduleMessages();
      } else {
        this.noteFailure(error);
      }
    }
  }

  /** Older messages of the open conversation, asked for with "Show earlier messages". */
  async loadEarlierThread(): Promise<void> {
    const held = this.state.pmThread;
    const first = held?.messages[0];
    if (!held || !first) return;
    const page = await api.messagesThread(held.id, first.id, 50);
    const latest = this.state.pmThread;
    if (!latest || latest.id !== held.id) return;
    const have = new Set(latest.messages.map((m) => m.id));
    this.set({ pmThread: { ...latest, messages: [...page.messages.filter((m) => !have.has(m.id)), ...latest.messages], more: page.more } });
  }

  /** A message arrived (over the stream). Shown at once when its conversation is on screen, and then read. */
  addPrivateMessage(conversationId: number, message: PmMessage): void {
    const me = this.state.user;
    if (!me) return;
    const thread = this.state.pmThread;
    if (thread && thread.id === conversationId && !thread.messages.some((m) => m.id === message.id)) {
      const all = [...thread.messages, message].sort((a, b) => a.id - b.id);
      this.set({ pmThread: { ...thread, messages: all.slice(-MAX_PM_MESSAGES), more: thread.more || all.length > MAX_PM_MESSAGES } });
      // It is on screen: it counts as read at once.
      if (message.username !== me.username) void api.messagesRead(conversationId, message.id).catch(() => undefined);
    }
    this.scheduleMessages();
  }

  /** A message was deleted by its writer: take it off the conversation on screen. */
  removePrivateMessage(conversationId: number, id: number): void {
    const thread = this.state.pmThread;
    if (thread && thread.id === conversationId && thread.messages.some((m) => m.id === id)) {
      this.set({ pmThread: { ...thread, messages: thread.messages.filter((m) => m.id !== id) } });
    }
    this.scheduleMessages();
  }

  /** The server said something about the private chats changed: bring the lists, and the conversation on screen, up to date. */
  onPmChanged(): void {
    if (!this.state.user) return;
    this.scheduleMessages();
    const open = this.state.pmOpen;
    if (open !== null) void this.loadThread(open, false);
  }

  /** Our own send was accepted: show it at once. A message that opened a conversation opens it on screen. */
  noteSentPrivate(out: PmSendResult): void {
    if (!this.state.user) return;
    const held = this.state.pmThread?.id === out.conversationId ? this.state.pmThread : null;
    const base = held?.messages ?? [];
    const messages = base.some((m) => m.id === out.message.id) ? base : [...base, out.message].sort((a, b) => a.id - b.id).slice(-MAX_PM_MESSAGES);
    this.set({
      pmOpen: out.conversationId,
      pmThread: { id: out.conversationId, conversation: out.conversation, messages, more: held?.more ?? false },
      messages: this.state.messages ? { ...this.state.messages, you: out.you } : this.state.messages,
    });
    this.scheduleMessages();
    // Writing to somebody by name may have opened an old conversation: bring its earlier messages in.
    if (held === null) void this.loadThread(out.conversationId, false);
  }

  /** "Message" next to a player's name elsewhere: the Messages screen opens with that player ready to be written to. */
  startCompose(username: string): void {
    this.set({ pmCompose: username });
  }

  clearCompose(): void {
    if (this.state.pmCompose !== null) this.set({ pmCompose: null });
  }

  /** A click on a player's name (Players, Chat, Messages...): his profile card opens. */
  openProfile(username: string): void {
    if (this.state.user) this.set({ profileFor: username });
  }

  closeProfile(): void {
    if (this.state.profileFor !== null) this.set({ profileFor: null });
  }

  async refreshAccount(): Promise<void> {
    await this.refreshPrivate(false);
  }

  async refreshLobby(): Promise<void> {
    if (!this.state.user) return;
    try {
      const l = await api.lobby();
      this.set({ match: l.match, searching: l.searching, bots: l.bots !== false, walletCents: l.wallet });
    } catch (error) {
      this.noteFailure(error);
    }
  }

  private async checkHealth(): Promise<void> {
    try {
      this.set({ health: await api.health() });
    } catch (error) {
      this.noteFailure(error);
    }
  }

  private noteFailure(error: unknown): void {
    if (isOffline(error)) this.set({ conn: 'offline', problem: (error as ApiError).message });
    else if (error instanceof ApiError && error.status === 401 && this.state.user) {
      // The session ended. If the owner banned this account, say so instead of just showing a login form.
      this.set({ user: null, career: null, friends: null, challenges: null, chat: null, messages: null, pmOpen: null, pmThread: null, pmCompose: null, profileFor: null, limits: [], match: null });
      this.calls.reset();
      profileStore.stop();
      billboardStore.clearMine();
      goalsStore.clear();
      awayStore.clear();
      void this.recheckMe();
    }
  }

  private async recheckMe(): Promise<void> {
    try {
      const me = await api.me();
      this.set({ user: me.user, banned: me.banned ?? null });
    } catch {
      // the next health check shows a server that is away
    }
  }

  // ---- actions the screens call ------------------------------------------------------------------------------------

  async signIn(mode: 'login' | 'register', username: string, password: string): Promise<void> {
    const res = mode === 'login' ? await api.login(username, password) : await api.register(username, password);
    this.set({ user: res.user, banned: null });
    // The server decides who a live stream belongs to when it opens. A stream opened before sign-in is anonymous and would
    // never get this player's match updates, so open a new one now.
    if (this.started) this.openStream();
    await this.refreshPrivate();
    void this.refreshFriends();
    void this.refreshChallenges();
    void this.refreshChat();
    void this.refreshMessages();
    void profileStore.start();
    void goalsStore.load();
    void awayStore.load();
  }

  async signOut(): Promise<void> {
    try {
      await api.logout();
    } finally {
      this.calls.reset();
      profileStore.stop();
      billboardStore.clearMine();
      goalsStore.clear();
      awayStore.clear();
      this.set({ user: null, banned: null, career: null, friends: null, challenges: null, challengeNote: null, chat: null, messages: null, pmOpen: null, pmThread: null, pmCompose: null, profileFor: null, limits: [], match: null, walletCents: 0, toasts: [] });
      for (const t of this.toastTimers.values()) clearTimeout(t);
      this.toastTimers.clear();
      if (this.started) this.openStream();
    }
  }

  // ---- voice calls ----------------------------------------------------------------------------------------------------

  /** "Call" next to a friend. */
  callStart(username: string): Promise<void> {
    return this.calls.start(username);
  }

  callAnswer(): Promise<void> {
    return this.calls.answer();
  }

  /** Cancel, Decline or Hang up. */
  callHangup(): Promise<void> {
    return this.calls.hangup();
  }

  callMute(): void {
    this.calls.toggleMute();
  }

  callDismissNote(): void {
    this.calls.dismissNote();
  }

  setMatch(match: Match | null): void {
    this.set({ match });
  }

  closeBreaking(): void {
    this.set({ breaking: null });
  }
}

export const sharedStore = new SharedStore();

export function useShared(): SharedState {
  return useSyncExternalStore(sharedStore.subscribe, sharedStore.getSnapshot);
}
