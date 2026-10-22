// The browser's only way to talk to the server. Every function returns what the server said, or throws an ApiError whose
// message is the server's own explanation (shown to the player as it is).

import type {
  Account,
  Announcement,
  BanNotice,
  AdminSpeed,
  AdminState,
  AdminStyle,
  Book,
  CoinPreview,
  CompanyDetail,
  CompanyEarnings,
  EarningsCalendar,
  Estimate,
  Health,
  GoodFor,
  HistoryEntry,
  LaunchResult,
  LaunchState,
  LimitEstimate,
  LimitOrder,
  LimitResult,
  Match,
  NewsItem,
  NewsPage,
  OrderResult,
  Overview,
  Resolution,
  DrainResult,
  RugResult,
  ServerCandle,
  StockLaunchPreview,
  Trade,
  User,
} from './types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** True for "the server is not there at all" (as opposed to the server saying no). */
export function isOffline(error: unknown): boolean {
  return error instanceof ApiError && error.status === 0;
}

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'offline', 'Cannot reach the TradeQuest server.');
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text === '' ? null : JSON.parse(text);
  } catch {
    json = null;
  }
  if (!res.ok) {
    const e = (json as { error?: { code?: string; message?: string; details?: Record<string, unknown> } } | null)?.error;
    // A web page answered instead of the API (for example the dev server without the proxy): treat it as "no server".
    if (e === undefined && res.status >= 500) throw new ApiError(0, 'offline', 'Cannot reach the TradeQuest server.');
    throw new ApiError(res.status, e?.code ?? 'error', e?.message ?? `The server answered ${res.status}.`, e?.details ?? {});
  }
  if (json === null && text !== '') throw new ApiError(0, 'offline', 'The address did not answer like a TradeQuest server. Is "npm run server" running?');
  return json as T;
}

const enc = encodeURIComponent;

export interface NewsQuery {
  readonly limit?: number;
  readonly before?: string | null;
  readonly category?: string;
  readonly breaking?: boolean;
}

function newsQs(q: NewsQuery): string {
  const p = new URLSearchParams();
  if (q.limit) p.set('limit', String(q.limit));
  if (q.before) p.set('before', q.before);
  if (q.category) p.set('category', q.category);
  if (q.breaking) p.set('breaking', '1');
  const s = p.toString();
  return s ? `?${s}` : '';
}

export const api = {
  health: () => request<Health>('GET', '/api/health'),
  me: () => request<{ user: User | null; banned?: BanNotice }>('GET', '/api/me'),
  register: (username: string, password: string) => request<{ user: User }>('POST', '/api/auth/register', { username, password }),
  login: (username: string, password: string) => request<{ user: User }>('POST', '/api/auth/login', { username, password }),
  logout: () => request<{ ok: boolean }>('POST', '/api/auth/logout', {}),

  market: () => request<Overview>('GET', '/api/market'),
  company: (ticker: string) => request<CompanyDetail>('GET', `/api/market/${enc(ticker)}`),
  candles: (ticker: string, res: Resolution, limit: number) => request<{ ticker: string; res: Resolution; tick: number; candles: ServerCandle[] }>('GET', `/api/market/${enc(ticker)}/candles?res=${res}&limit=${limit}`),
  book: (ticker: string) => request<Book>('GET', `/api/market/${enc(ticker)}/book`),
  estimate: (ticker: string, side: 'buy' | 'sell', qty: number, account: 'career' | 'match', leverage = 1, short = false) =>
    request<Estimate>('GET', `/api/market/${enc(ticker)}/estimate?side=${side}&qty=${qty}&account=${account}${leverage > 1 ? `&leverage=${leverage}` : ''}${short ? '&short=1' : ''}`),

  account: (account: 'career' | 'match') => request<Account>('GET', `/api/account?account=${account}`),
  trades: (account: 'career' | 'match', limit = 50) => request<{ trades: Trade[] }>('GET', `/api/account/trades?account=${account}&limit=${limit}`),
  order: (body: { account: 'career' | 'match'; ticker: string; side: 'buy' | 'sell'; qty: number; clientOrderId: string; leverage?: number; short?: boolean; stopPrice?: number; takePrice?: number }) =>
    request<OrderResult>('POST', '/api/orders', body),
  /** Sets, changes or removes (null) the stop-loss and take-profit of a position that is open. A price you leave out stays as it is. */
  exits: (body: { account: 'career' | 'match'; ticker: string; stopPrice?: number | null; takePrice?: number | null }) => request<{ account: Account }>('POST', '/api/positions/exits', body),

  /** Limit orders (Career only): the open ones, or the latest of all with how they ended. */
  limitOrders: (state: 'open' | 'all' = 'open', limit = 50) => request<{ tick: number; orders: LimitOrder[] }>('GET', `/api/limit-orders?state=${state}&limit=${limit}`),
  /** What a limit order would set aside, how many shares fit, and whether it would fill at once. `limit` is in cents. */
  limitEstimate: (ticker: string, side: 'buy' | 'sell', qty: number, limit: number, leverage = 1, short = false) =>
    request<LimitEstimate>('GET', `/api/limit-orders/estimate?ticker=${enc(ticker)}&side=${side}&qty=${qty}&limit=${limit}${leverage > 1 ? `&leverage=${leverage}` : ''}${short ? '&short=1' : ''}`),
  placeLimit: (body: { ticker: string; side: 'buy' | 'sell'; qty: number; limitPrice: number; clientOrderId: string; goodFor: GoodFor; leverage?: number; short?: boolean; stopPrice?: number; takePrice?: number }) =>
    request<LimitResult>('POST', '/api/limit-orders', body),
  cancelLimit: (id: number) => request<{ order: LimitOrder; account: Account }>('POST', '/api/limit-orders/cancel', { id }),

  news: (q: NewsQuery = {}) => request<NewsPage>('GET', `/api/news${newsQs(q)}`),
  companyNews: (ticker: string, q: NewsQuery = {}) => request<NewsPage & { ticker: string }>('GET', `/api/market/${enc(ticker)}/news${newsQs(q)}`),
  newsItem: (id: number) => request<NewsItem>('GET', `/api/news/${id}`),

  /** A company's profit per share, price/earnings ratio, next report and last reports. */
  companyEarnings: (ticker: string, limit = 8) => request<CompanyEarnings>('GET', `/api/market/${enc(ticker)}/earnings?limit=${limit}`),
  /** Reports coming out in the next `hours` hours and those that came out in the last `hours`, across the market. */
  earnings: (hours = 24) => request<EarningsCalendar>('GET', `/api/earnings?hours=${hours}`),

  lobby: () => request<{ match: Match | null; searching: number; wallet: number; bots: boolean }>('GET', '/api/lobby'),
  join: () => request<{ match: Match }>('POST', '/api/lobby/join', {}),
  /** "Play a bot now": like join, and a bot takes the other seat at once if nobody else is waiting. */
  playBot: () => request<{ match: Match }>('POST', '/api/lobby/bot', {}),
  ready: (ready: boolean) => request<{ match: Match }>('POST', '/api/lobby/ready', { ready }),
  leave: () => request<{ match: Match | null }>('POST', '/api/lobby/leave', {}),
  dismiss: () => request<{ ok: boolean }>('POST', '/api/lobby/dismiss', {}),
  matches: () => request<{ matches: HistoryEntry[] }>('GET', '/api/matches?limit=20'),
  wallet: () => request<{ balanceCents: number }>('GET', '/api/wallet'),

  // Owner only: the server answers 403 to anybody else.
  adminState: (q = '') => request<AdminState>('GET', `/api/admin/state${q.trim() === '' ? '' : `?q=${enc(q.trim())}`}`),
  adminShock: (body: { requestId: string; ticker: string; percent: number; style: AdminStyle; speed: AdminSpeed; headline?: string; body?: string; breaking?: boolean }) =>
    request<{ ok: boolean; duplicate: boolean; ticker: string; startsAtTick: number; priceBeforeCents: number }>('POST', '/api/admin/shock', body),
  adminHalt: (body: { requestId: string; ticker: string; halted: boolean; reason?: string }) => request<{ ok: boolean; ticker: string; halted: boolean }>('POST', '/api/admin/halt', body),
  adminBan: (body: { requestId: string; username: string; reason?: string; hours?: number | null }) => request<{ ok: boolean; duplicate: boolean; username: string; untilMs: number | null }>('POST', '/api/admin/ban', body),
  adminUnban: (body: { requestId: string; username: string }) => request<{ ok: boolean; duplicate: boolean; username: string }>('POST', '/api/admin/unban', body),
  adminShares: (body: { requestId: string; username: string; ticker: string; qty: number; note?: string }) =>
    request<{ ok: boolean; duplicate: boolean; username: string; ticker: string; shares: number }>('POST', '/api/admin/shares', body),
  adminReset: (body: { requestId: string; username: string; note?: string }) => request<{ ok: boolean; duplicate: boolean; username: string; cashCents: number }>('POST', '/api/admin/reset', body),
  adminAnnounce: (body: { requestId: string; text: string }) => request<{ ok: boolean; duplicate: boolean; announcement: Announcement | null }>('POST', '/api/admin/announce', body),
  adminPause: (body: { requestId: string; paused: boolean; reason?: string }) => request<{ ok: boolean; duplicate: boolean; paused: boolean }>('POST', '/api/admin/pause', body),
  adminStock: (body: { requestId: string; name: string; ticker: string; sector: string; tier: string; personality: string; priceCents: number; industry?: string; description?: string }) =>
    request<{ ok: boolean; duplicate: boolean; ticker: string; name?: string; companyId?: number; listingTick?: number; startsInSeconds?: number; loaded?: boolean }>('POST', '/api/admin/stock', body),
  adminCash: (body: { requestId: string; username: string; amountCents: number; note?: string }) => request<{ ok: boolean; username: string; cashCents: number }>('POST', '/api/admin/cash', body),
  adminCoins: (body: { requestId: string; username: string; amountCents: number; note?: string }) => request<{ ok: boolean; username: string; coinsCents: number }>('POST', '/api/admin/coins', body),

  // Any signed-in player: launch a stock or a memecoin with his own Career cash, and rug pull (sell everything he holds of) his own launches.
  launchState: () => request<LaunchState>('GET', '/api/launch'),
  launchCoinPreview: (seedCents: number) => request<{ ok: true; preview: CoinPreview } | { ok: false; problem: string }>('GET', `/api/launch/coin-preview?seedCents=${seedCents}`),
  launchStockPreview: (seedCents: number) => request<{ ok: true; preview: StockLaunchPreview } | { ok: false; problem: string }>('GET', `/api/launch/stock-preview?seedCents=${seedCents}`),
  launchCoin: (body: { requestId: string; name: string; ticker: string; seedCents: number; description?: string; dev?: string }) => request<LaunchResult>('POST', '/api/launch/coin', body),
  launchStock: (body: { requestId: string; name: string; ticker: string; sector: string; seedCents: number; industry?: string; description?: string }) =>
    request<LaunchResult>('POST', '/api/launch/stock', body),
  rugPull: (body: { requestId: string; ticker: string }) => request<RugResult | DrainResult>('POST', '/api/launch/rug', body),
};
