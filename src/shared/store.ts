// One place that holds what the browser knows about the shared market and keeps it fresh: the live tick stream, the company
// list, the news, the player's account and their 1v1 lobby. Components read it with useShared(); nothing here decides
// anything the server decides.
import { useSyncExternalStore } from 'react';
import { ApiError, api, isOffline } from './api';
import { describeLimitEvent } from './limitText';
import { describeNotice, type ToastText } from './positionNotice';
import type { Account, Announcement, BanNotice, ChallengesState, ChatMessage, ChatView, ChatYou, FriendsState, Health, LimitNotice, LimitOrder, Match, NewsItem, OverviewRow, PositionNotice, TradingPause, User } from './types';

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
  /** The player's open limit orders (Career), newest first. */
  readonly limits: readonly LimitOrder[];
  readonly match: Match | null;
  readonly searching: number;
  /** True when the server has 1v1 bots turned on (the page then offers "Play a bot now"). */
  readonly bots: boolean;
  readonly walletCents: number;
  /** Pop-ups about positions closed by liquidation, stop-loss or take-profit, newest last. */
  readonly toasts: readonly Toast[];
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
  limits: [],
  match: null,
  searching: 0,
  bots: true,
  walletCents: 0,
  toasts: [],
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
    await Promise.all([this.refreshCompanies(), this.refreshNews(), this.refreshPrivate(), this.refreshFriends(), this.refreshChallenges(), this.refreshChat()]);
    this.openStream();
    for (const t of this.timers) clearInterval(t);
    this.timers = [
      setInterval(() => void this.refreshCompanies(), 20_000),
      setInterval(() => void this.refreshPrivate(false), 6_000),
      // New requests also arrive over the live stream at once; this is the safety net.
      setInterval(() => {
        void this.refreshFriends();
        void this.refreshChallenges();
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
      this.set({ user: null, career: null, friends: null, challenges: null, chat: null, limits: [], match: null });
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
  }

  async signOut(): Promise<void> {
    try {
      await api.logout();
    } finally {
      this.set({ user: null, banned: null, career: null, friends: null, challenges: null, challengeNote: null, chat: null, limits: [], match: null, walletCents: 0, toasts: [] });
      for (const t of this.toastTimers.values()) clearTimeout(t);
      this.toastTimers.clear();
      if (this.started) this.openStream();
    }
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
